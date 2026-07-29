import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Config is read once at module load, so this suite sets the environment and
 * then imports the app fresh. Without this, every other suite exercises the
 * unauthenticated path and the guard is never actually tested.
 */
const PASSPHRASE = 'correct horse battery staple';
const API_TOKEN = 'shortcut-token-value';
const BEDSIDE = 'bedside-secret-value';

let app: FastifyInstance;
let db: { close(): void };

beforeEach(async () => {
  vi.resetModules();
  process.env.TEMPRA_PASSPHRASE = PASSPHRASE;
  process.env.TEMPRA_API_TOKEN = API_TOKEN;
  process.env.BEDSIDE_SECRET = BEDSIDE;
  process.env.SESSION_SECRET = 'a-test-session-secret-of-sufficient-length';

  const { openDb } = await import('../src/db.js');
  const { buildApp } = await import('../src/app.js');
  db = openDb(':memory:') as never;
  app = await buildApp({ logger: false, serveStatic: false, db: db as never });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  delete process.env.TEMPRA_PASSPHRASE;
  delete process.env.TEMPRA_API_TOKEN;
  delete process.env.BEDSIDE_SECRET;
});

describe('when a passphrase is configured', () => {
  it('refuses to read state without credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/state' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses to start a flash without credentials', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/flashes', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('refuses to export data without credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/export.csv' });
    expect(res.statusCode).toBe(401);
  });

  it('no longer reports itself as insecure', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { passphrase: PASSPHRASE },
    });
    const cookie = login.cookies[0];
    const res = await app.inject({
      method: 'GET',
      url: '/api/state',
      cookies: { [String(cookie?.name)]: String(cookie?.value) },
    });
    expect(res.json().insecure).toBe(false);
  });
});

describe('passphrase login', () => {
  it('rejects the wrong passphrase', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { passphrase: 'nope' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('issues an httpOnly, secure cookie on success', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { passphrase: PASSPHRASE },
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies[0];
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.secure).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
  });

  it('grants access with the issued cookie', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { passphrase: PASSPHRASE },
    });
    const cookie = login.cookies[0];
    const res = await app.inject({
      method: 'POST',
      url: '/api/flashes',
      payload: {},
      cookies: { [String(cookie?.name)]: String(cookie?.value) },
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects a forged cookie that was never signed by the server', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/state',
      cookies: { tempra_session: 'ok' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('bearer token for Shortcuts', () => {
  it('accepts the configured token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/flashes',
      payload: { source: 'shortcut' },
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects a wrong token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/flashes',
      payload: {},
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('bedside webhook with a secret configured', () => {
  it('starts a flash on the first press', async () => {
    const res = await app.inject({ method: 'POST', url: `/hooks/bedside/${BEDSIDE}`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().action).toBe('started');
  });

  it('ignores a double-tap within the debounce window', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/hooks/bedside/${BEDSIDE}`,
      payload: {},
    });
    const second = await app.inject({
      method: 'POST',
      url: `/hooks/bedside/${BEDSIDE}`,
      payload: {},
    });
    expect(second.json().action).toBe('debounced');
    expect(second.json().flash.id).toBe(first.json().flash.id);
  });

  /*
   * The button starts the bed cooling; it is never a stop button. The likeliest
   * second press of the night is another flash, and if that ended the first one
   * instead of recording a new one the night's worst hours would vanish.
   */
  it('starts another flash on a later press, superseding the first', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/hooks/bedside/${BEDSIDE}`,
      payload: {},
    });
    const firstId = first.json().flash.id;

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 5 * 60_000));
    const second = await app.inject({
      method: 'POST',
      url: `/hooks/bedside/${BEDSIDE}`,
      payload: {},
    });
    vi.useRealTimers();

    expect(second.json().action).toBe('started');
    expect(second.json().flash.id).not.toBe(firstId);

    const list = await app.inject({
      method: 'GET',
      url: '/api/flashes',
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    const superseded = list.json().flashes.find((f: { id: string }) => f.id === firstId);
    expect(superseded.status).toBe('superseded');
    // Auto-closing must never invent an end time or a duration.
    expect(superseded.endedAt).toBeNull();
    expect(superseded.durationMin).toBeNull();
  });

  it('records a heartbeat without touching the flash log', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/hooks/bedside/${BEDSIDE}`,
      payload: { kind: 'heartbeat' },
    });
    expect(res.json().kind).toBe('heartbeat');

    const login = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { passphrase: PASSPHRASE },
    });
    const cookie = login.cookies[0];
    const state = await app.inject({
      method: 'GET',
      url: '/api/state',
      cookies: { [String(cookie?.name)]: String(cookie?.value) },
    });
    expect(state.json().recent).toHaveLength(0);
    expect(state.json().bedside.health).toBe('ok');
  });

  it('still rejects a near-miss secret', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/hooks/bedside/${BEDSIDE}x`,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('does not require app credentials, since Hubitat cannot send headers', async () => {
    const res = await app.inject({ method: 'POST', url: `/hooks/bedside/${BEDSIDE}`, payload: {} });
    expect(res.statusCode).toBe(200);
  });
});

/*
 * Hubitat picks the encoding and we do not get a vote. These are the shapes a
 * hand-configured Rule Machine action has actually been seen to send, and a
 * rejection is invisible from the bedroom: the bed still cools, so the button
 * looks like it worked while nothing is logged.
 */
describe('bedside webhook body shapes', () => {
  it('treats an empty JSON body as a press, which the setup guide promises', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/hooks/bedside/${BEDSIDE}`,
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().action).toBe('started');
  });

  it('accepts the form encoding that older Rule Machine builds send', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/hooks/bedside/${BEDSIDE}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'kind=heartbeat',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe('heartbeat');
  });

  it('accepts a JSON body mislabelled with another content type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/hooks/bedside/${BEDSIDE}`,
      headers: { 'content-type': 'text/plain' },
      payload: '{"kind":"heartbeat"}',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe('heartbeat');
  });

  /*
   * Being forgiving stops at the point where forgiveness means guessing.
   * Recovering from an unreadable body would mean choosing between a press and
   * a heartbeat, and choosing "press" invents a flash out of noise.
   */
  it('refuses an unreadable body rather than guessing it was a press', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/hooks/bedside/${BEDSIDE}`,
      headers: { 'content-type': 'application/json' },
      payload: 'not json at all',
    });
    expect(res.statusCode).toBe(400);

    const list = await app.inject({
      method: 'GET',
      url: '/api/flashes',
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(list.json().flashes).toHaveLength(0);
  });

  /*
   * The same reasoning one layer up. A body that parses but does not validate
   * used to fall through to the "press" default, so a capitalised value or a
   * typo'd key in a hand-edited rule field turned the hourly heartbeat into an
   * hourly hot flash that never happened — silently, and forever.
   */
  it.each([
    ['a typo in the key', '{"knid":"heartbeat"}'],
    ['an unknown kind', '{"kind":"tap"}'],
    ['a body that is not an object', '["heartbeat"]'],
    ['a bare number', '5'],
  ])('refuses %s rather than recording a press that never happened', async (_label, payload) => {
    const res = await app.inject({
      method: 'POST',
      url: `/hooks/bedside/${BEDSIDE}`,
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(res.statusCode).toBe(400);

    const list = await app.inject({
      method: 'GET',
      url: '/api/flashes',
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(list.json().flashes).toHaveLength(0);
  });

  /*
   * Forgiving case and whitespace is not guessing between two meanings — it is
   * reading the one that was plainly written. Worth doing, because these values
   * get typed by hand into a hub form.
   */
  it.each(['Heartbeat', 'heartbeat ', ' HEARTBEAT'])(
    'reads %j as the heartbeat it obviously is',
    async (kind) => {
      const res = await app.inject({
        method: 'POST',
        url: `/hooks/bedside/${BEDSIDE}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ kind }),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().kind).toBe('heartbeat');
    },
  );
});

/*
 * The first thing anyone does with a webhook that looks broken is paste its URL
 * into a browser. That is a GET, and answering it with the same 404 a wrong
 * secret gets made the obvious diagnostic report failure even when the hook was
 * healthy — which is exactly how this integration was misdiagnosed once.
 */
describe('bedside webhook opened in a browser', () => {
  it('admits the secret is right, since the URL is itself the credential', async () => {
    const res = await app.inject({ method: 'GET', url: `/hooks/bedside/${BEDSIDE}` });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe('POST');
    expect(res.json().hint).toContain('POST');
  });

  it('still tells a wrong secret nothing at all', async () => {
    const res = await app.inject({ method: 'GET', url: `/hooks/bedside/${BEDSIDE}x` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('does not start a flash just because the URL was opened', async () => {
    await app.inject({ method: 'GET', url: `/hooks/bedside/${BEDSIDE}` });
    const list = await app.inject({
      method: 'GET',
      url: '/api/flashes',
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(list.json().flashes).toHaveLength(0);
  });
});
