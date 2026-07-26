import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
