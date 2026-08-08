import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let db: Db;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildApp({ logger: false, serveStatic: false, db });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
});

const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload });

describe('POST /api/flashes', () => {
  it('starts a flash from an empty body', async () => {
    const res = await post('/api/flashes', {});
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('active');
  });

  it('rejects an invalid intensity with 400', async () => {
    const res = await post('/api/flashes', { intensity: 99 });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown symptom', async () => {
    const res = await post('/api/flashes', { symptoms: ['vibes'] });
    expect(res.statusCode).toBe(400);
  });

  it('is idempotent for a repeated clientId', async () => {
    const a = await post('/api/flashes', { clientId: 'abc' });
    const b = await post('/api/flashes', { clientId: 'abc' });
    expect(b.json().id).toBe(a.json().id);
  });

  /*
   * Siri fires blind: she says it, nothing confirms it, and she says it again.
   * The bedside button has always debounced this; the shortcut path did not.
   */
  it('treats a shortcut run twice in a row as one flash', async () => {
    const a = await post('/api/flashes', { source: 'shortcut' });
    const b = await post('/api/flashes', { source: 'shortcut' });
    expect(a.statusCode).toBe(201);
    // 200, because nothing was created — but a whole flash still comes back so
    // the shortcut can say when it started rather than reporting an error.
    expect(b.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);

    const list = await app.inject({ method: 'GET', url: '/api/flashes' });
    expect(list.json().flashes).toHaveLength(1);
  });

  /*
   * The clientId trick the shortcut docs describe buckets by minute, so two
   * taps either side of a minute boundary get different ids. The time window
   * has to catch that, or the documented guard has a hole in it.
   */
  it('catches a repeat that straddles a clientId minute boundary', async () => {
    const a = await post('/api/flashes', { source: 'shortcut', clientId: 'shortcut-03-14' });
    const b = await post('/api/flashes', { source: 'shortcut', clientId: 'shortcut-03-15' });
    expect(b.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
  });

  /*
   * She can see the flash she just started in the app, so a second one there is
   * deliberate and has to be honoured.
   */
  it('still lets the app start a second flash straight away', async () => {
    const a = await post('/api/flashes', {});
    const b = await post('/api/flashes', {});
    expect(b.statusCode).toBe(201);
    expect(b.json().id).not.toBe(a.json().id);
  });

  /*
   * Naming a moment is deliberate in a way that saying "now" is not, so a
   * backfill of two close flashes must not be collapsed into one.
   */
  it('does not debounce a shortcut that names its own start time', async () => {
    await post('/api/flashes', { source: 'shortcut', startedAt: '2026-01-01T03:00:00Z' });
    const b = await post('/api/flashes', {
      source: 'shortcut',
      startedAt: '2026-01-01T03:00:30Z',
    });
    expect(b.statusCode).toBe(201);
  });

  it('lets a later shortcut run start a genuinely new flash', async () => {
    const a = await post('/api/flashes', { source: 'shortcut' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 5 * 60_000));
    const b = await post('/api/flashes', { source: 'shortcut' });
    vi.useRealTimers();
    expect(b.statusCode).toBe(201);
    expect(b.json().id).not.toBe(a.json().id);
  });
});

describe('ending a flash', () => {
  it('ends the active flash', async () => {
    await post('/api/flashes', { startedAt: '2026-01-01T03:00:00Z' });
    const res = await post('/api/flashes/end', { endedAt: '2026-01-01T03:30:00Z' });
    expect(res.statusCode).toBe(200);
    expect(res.json().durationMin).toBe(30);
  });

  it('accepts a null end time and records no duration', async () => {
    await post('/api/flashes', { startedAt: '2026-01-01T03:00:00Z' });
    const res = await post('/api/flashes/end', { endedAt: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ended');
    expect(res.json().endedAt).toBeNull();
    expect(res.json().durationMin).toBeNull();
  });

  it('returns 409 when nothing is running', async () => {
    const res = await post('/api/flashes/end', {});
    expect(res.statusCode).toBe(409);
  });
});

describe('GET /api/state', () => {
  it('reports the active flash and recent history', async () => {
    await post('/api/flashes', {});
    const res = await app.inject({ method: 'GET', url: '/api/state' });
    const body = res.json();
    expect(body.active).not.toBeNull();
    expect(body.recent).toHaveLength(1);
  });

  it('reports bedside health as unknown before any heartbeat', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/state' });
    expect(res.json().bedside.health).toBe('unknown');
    expect(res.json().bedside.lastPressAt).toBeNull();
  });

  it('admits when the deployment is unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/state' });
    expect(res.json().insecure).toBe(true);
  });
});

describe('PATCH and DELETE', () => {
  it('updates and then deletes a flash', async () => {
    const created = await post('/api/flashes', {});
    const id = created.json().id;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/flashes/${id}`,
      payload: { note: 'woke up soaked', symptoms: ['sweating'] },
    });
    expect(patched.json().note).toBe('woke up soaked');

    const removed = await app.inject({ method: 'DELETE', url: `/api/flashes/${id}` });
    expect(removed.statusCode).toBe(204);
    const gone = await app.inject({ method: 'GET', url: `/api/flashes/${id}` });
    expect(gone.statusCode).toBe(404);
  });
});

describe('export', () => {
  it('serves CSV with a header row and an attachment name', async () => {
    await post('/api/flashes', { startedAt: '2026-01-01T03:00:00Z', intensity: 6 });
    const res = await app.inject({ method: 'GET', url: '/api/export.csv' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="tempra-.*\.csv"/);
    expect(res.body.split('\r\n')[0]).toContain('started_local');
  });

  it('neutralises a note that a spreadsheet would treat as a formula', async () => {
    const created = await post('/api/flashes', {});
    await app.inject({
      method: 'PATCH',
      url: `/api/flashes/${created.json().id}`,
      payload: { note: '=cmd|calc' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/export.csv' });
    expect(res.body).toContain(`"'=cmd|calc"`);
  });

  it('serves self-describing JSON', async () => {
    await post('/api/flashes', {});
    const res = await app.inject({ method: 'GET', url: '/api/export.json' });
    const body = JSON.parse(res.body);
    expect(body.app).toBe('tempra');
    expect(body.symptomVocabulary).toContain('sweating');
    expect(body.count).toBe(1);
  });
});

describe('day check-ins', () => {
  const put = (date: string, payload: unknown) =>
    app.inject({ method: 'PUT', url: `/api/days/${date}`, payload });

  it('creates a check-in and reads it back', async () => {
    const res = await put('2026-07-26', {
      symptoms: [{ symptom: 'tinnitus', severity: 2 }],
      note: 'worse in the quiet',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().date).toBe('2026-07-26');

    const got = await app.inject({ method: 'GET', url: '/api/days/2026-07-26' });
    expect(got.json().symptoms).toEqual([{ symptom: 'tinnitus', severity: 2 }]);
  });

  it('is idempotent, because the date is the identity', async () => {
    // The offline outbox replays a queued check-in until it lands. Doing that
    // twice must not produce two check-ins for one day.
    const body = { symptoms: [{ symptom: 'sleep', severity: 3 }] };
    await put('2026-07-26', body);
    await put('2026-07-26', body);
    const list = await app.inject({ method: 'GET', url: '/api/days' });
    expect(list.json().days).toHaveLength(1);
  });

  it('rejects an instant where a calendar date belongs', async () => {
    const res = await put('2026-07-26T03:14:00Z', { symptoms: [] });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown symptom and an impossible severity', async () => {
    expect((await put('2026-07-26', { symptoms: [{ symptom: 'vibes', severity: 1 }] })).statusCode)
      .toBe(400);
    expect(
      (await put('2026-07-26', { symptoms: [{ symptom: 'tinnitus', severity: 7 }] })).statusCode,
    ).toBe(400);
  });

  it('answers 204 when the check-in is emptied out', async () => {
    await put('2026-07-26', { symptoms: [{ symptom: 'tinnitus', severity: 2 }] });
    const res = await put('2026-07-26', { symptoms: [], note: null });
    expect(res.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/days/2026-07-26' })).statusCode).toBe(404);
  });

  it('merges through PATCH without wiping what is already there', async () => {
    // This is the Siri path: "log tinnitus" knows one thing.
    await put('2026-07-26', { symptoms: [{ symptom: 'sleep', severity: 3 }] });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/days/2026-07-26',
      payload: { symptoms: [{ symptom: 'tinnitus', severity: 1 }] },
    });
    expect(res.json().symptoms).toHaveLength(2);
  });

  it('accepts the plain object shape an iOS Shortcut can actually build', async () => {
    await put('2026-07-26', { symptoms: [{ symptom: 'sleep', severity: 3 }] });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/days/2026-07-26',
      payload: { symptoms: { tinnitus: 2 } },
    });
    expect(res.json().symptoms).toEqual([
      { symptom: 'sleep', severity: 3 },
      { symptom: 'tinnitus', severity: 2 },
    ]);
  });

  it('unsays a symptom when a PATCH gives it a null severity', async () => {
    await put('2026-07-26', {
      symptoms: [
        { symptom: 'sleep', severity: 3 },
        { symptom: 'tinnitus', severity: 2 },
      ],
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/days/2026-07-26',
      payload: { symptoms: { tinnitus: null } },
    });
    expect(res.json().symptoms).toEqual([{ symptom: 'sleep', severity: 3 }]);
  });

  it('rides along with the app state so history can draw the bands', async () => {
    await put('2026-07-26', { symptoms: [{ symptom: 'tinnitus', severity: 2 }] });
    const res = await app.inject({ method: 'GET', url: '/api/state' });
    expect(res.json().days).toHaveLength(1);
  });

  it('exports as its own spreadsheet, one row per day', async () => {
    await put('2026-07-26', { symptoms: [{ symptom: 'tinnitus', severity: 2 }] });
    const res = await app.inject({ method: 'GET', url: '/api/export-days.csv' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/tempra-days-.*\.csv/);
    expect(res.body.split('\r\n')[0]).toContain('tinnitus');
    expect(res.body).toContain('"Moderate"');
  });
});

describe('POST /api/flashes/missed', () => {
  it('creates backfilled un-timed flashes for counts in windows', async () => {
    const res = await post('/api/flashes/missed', {
      date: '2026-07-26',
      counts: { night: 2, morning: 1, afternoon: 0, evening: 0 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.flashes).toHaveLength(3);
    for (const f of body.flashes) {
      expect(f.status).toBe('superseded');
      expect(f.durationMin).toBeNull();
      expect(f.endedAt).toBeNull();
    }
  });

  it('does not disturb an active running flash when backfilling missed flashes', async () => {
    const active = await post('/api/flashes', {});
    expect(active.json().status).toBe('active');

    const missed = await post('/api/flashes/missed', {
      date: '2026-07-26',
      counts: { night: 1 },
    });
    expect(missed.statusCode).toBe(201);

    const state = await app.inject({ method: 'GET', url: '/api/state' });
    expect(state.json().active.id).toBe(active.json().id);
  });

  it('rejects an invalid date or negative counts with 400', async () => {
    const invalidDate = await post('/api/flashes/missed', {
      date: 'invalid-date',
      counts: { night: 1 },
    });
    expect(invalidDate.statusCode).toBe(400);

    const invalidCount = await post('/api/flashes/missed', {
      date: '2026-07-26',
      counts: { night: -1 },
    });
    expect(invalidCount.statusCode).toBe(400);
  });
});

describe('bedside webhook', () => {
  it('rejects a wrong secret as 404, revealing nothing', async () => {
    const res = await post('/hooks/bedside/not-the-secret', {});
    expect(res.statusCode).toBe(404);
  });

  it('rejects everything when no secret is configured', async () => {
    const res = await post('/hooks/bedside/anything', {});
    expect(res.statusCode).toBe(404);
  });
});
