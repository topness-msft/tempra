import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false, serveStatic: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('reports ok with a commit and a timestamp', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; commit: string; time: string }>();
    expect(body.ok).toBe(true);
    expect(body.commit).toBeTruthy();
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
  });
});

describe('unknown routes', () => {
  it('returns JSON 404 for API paths rather than an HTML shell', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
  });
});
