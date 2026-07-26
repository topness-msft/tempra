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
