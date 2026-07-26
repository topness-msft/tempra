import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  createFlashSchema,
  endFlashSchema,
  updateFlashSchema,
  type Flash,
} from '@tempra/shared';
import type { Db } from './db.js';
import { FlashRepo } from './repo.js';
import { config } from './config.js';
import { safeEqual, verifyPassphrase } from './crypto.js';
import { hashPassphrase } from './crypto.js';
import { toCsv, toJsonExport } from './export.js';

const SESSION_COOKIE = 'tempra_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 365; // a year: re-auth at 3am is hostile

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  before: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export interface ApiOptions {
  db: Db;
}

/** Simple fixed-window limiter, enough for a single-user app's webhook. */
class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now > entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

export const registerApi = async (app: FastifyInstance, opts: ApiOptions): Promise<void> => {
  const repo = new FlashRepo(opts.db);
  const bedsideLimiter = new RateLimiter(60, 60_000);
  const loginLimiter = new RateLimiter(10, 60_000);

  const passphraseHash = config.passphrase ? hashPassphrase(config.passphrase) : null;
  const authRequired = passphraseHash !== null;

  if (!authRequired) {
    app.log.warn(
      'TEMPRA_PASSPHRASE is not set: the API is unauthenticated. Set it before exposing this app.',
    );
  }

  const isAuthed = (req: FastifyRequest): boolean => {
    if (!authRequired) return true;
    const cookie = req.cookies[SESSION_COOKIE];
    if (cookie) {
      const unsigned = req.unsignCookie(cookie);
      if (unsigned.valid && unsigned.value === 'ok') return true;
    }
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ') && config.apiToken) {
      return safeEqual(auth.slice(7).trim(), config.apiToken);
    }
    return false;
  };

  const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!isAuthed(req)) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  };

  // ---------------------------------------------------------------- session

  app.post('/api/session', async (req, reply) => {
    if (!loginLimiter.allow(req.ip)) {
      return reply.code(429).send({ error: 'too_many_attempts' });
    }
    const body = z.object({ passphrase: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    if (!passphraseHash || !verifyPassphrase(body.data.passphrase, passphraseHash)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return reply
      .setCookie(SESSION_COOKIE, 'ok', {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
        signed: true,
        maxAge: SESSION_MAX_AGE,
      })
      .send({ ok: true });
  });

  app.delete('/api/session', async (_req, reply) =>
    reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ ok: true }),
  );

  // ------------------------------------------------------------------ state

  app.get('/api/state', async (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: 'unauthorized' });
    return {
      active: repo.active(),
      recent: repo.list({ limit: 20 }),
      bedside: bedsideStatus(opts.db),
      insecure: !authRequired,
      commit: config.commit,
    };
  });

  // --------------------------------------------------------------- flashes

  app.post('/api/flashes', { preHandler: guard }, async (req, reply) => {
    const parsed = createFlashSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues });
    }
    const flash = repo.start(parsed.data);
    return reply.code(201).send(flash);
  });

  app.get('/api/flashes', { preHandler: guard }, async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    return { flashes: repo.list(parsed.data) };
  });

  app.get<{ Params: { id: string } }>(
    '/api/flashes/:id',
    { preHandler: guard },
    async (req, reply) => {
      const flash = repo.get(req.params.id);
      if (!flash) return reply.code(404).send({ error: 'not_found' });
      return flash;
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/api/flashes/:id',
    { preHandler: guard },
    async (req, reply) => {
      const parsed = updateFlashSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues });
      }
      const updated = repo.update(req.params.id, parsed.data);
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/flashes/:id',
    { preHandler: guard },
    async (req, reply) => {
      if (!repo.remove(req.params.id)) return reply.code(404).send({ error: 'not_found' });
      return reply.code(204).send();
    },
  );

  const endFlash = async (
    id: string | null,
    body: unknown,
    reply: FastifyReply,
  ): Promise<unknown> => {
    const parsed = endFlashSchema.safeParse(body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const ended = repo.end(id, parsed.data.endedAt);
    if (!ended) return reply.code(409).send({ error: 'no_active_flash' });
    return ended;
  };

  app.post('/api/flashes/end', { preHandler: guard }, async (req, reply) =>
    endFlash(null, req.body, reply),
  );

  app.post<{ Params: { id: string } }>(
    '/api/flashes/:id/end',
    { preHandler: guard },
    async (req, reply) => endFlash(req.params.id, req.body, reply),
  );

  // ------------------------------------------------------------------ export

  app.get('/api/export.json', { preHandler: guard }, async (_req, reply) =>
    reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="${exportName('json')}"`)
      .send(JSON.stringify(toJsonExport(repo.all()), null, 2)),
  );

  app.get('/api/export.csv', { preHandler: guard }, async (_req, reply) =>
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${exportName('csv')}"`)
      .send(toCsv(repo.all())),
  );

  // ----------------------------------------------------------------- bedside

  /**
   * Hubitat posts here. The secret is the last path segment because Rule
   * Machine cannot attach headers. Both presses and heartbeats land here so
   * that silence can be distinguished from a broken integration.
   */
  app.post<{ Params: { secret: string; kind?: string } }>(
    '/hooks/bedside/:secret',
    async (req, reply) => {
      if (!bedsideLimiter.allow(req.ip)) return reply.code(429).send({ error: 'rate_limited' });
      if (!config.bedsideSecret || !safeEqual(req.params.secret, config.bedsideSecret)) {
        req.log.warn({ ip: req.ip }, 'bedside webhook rejected');
        return reply.code(404).send({ error: 'not_found' });
      }

      const body = z
        .object({ kind: z.enum(['press', 'heartbeat']).default('press') })
        .safeParse(req.body ?? {});
      const kind = body.success ? body.data.kind : 'press';
      const now = new Date().toISOString();

      if (kind === 'heartbeat') {
        opts.db
          .prepare("INSERT INTO device_events (device, kind, at) VALUES ('bedside', 'heartbeat', ?)")
          .run(now);
        return { ok: true, kind };
      }

      // A press toggles: it ends a running flash, otherwise it starts one.
      const running = repo.active();
      const result: Flash | null = running ? repo.end(running.id) : repo.start({ source: 'homekit' });
      opts.db
        .prepare(
          "INSERT INTO device_events (device, kind, at, flash_id) VALUES ('bedside', 'press', ?, ?)",
        )
        .run(now, result?.id ?? null);

      return { ok: true, kind, action: running ? 'ended' : 'started', flash: result };
    },
  );
};

const exportName = (ext: string): string => {
  const d = new Date().toISOString().slice(0, 10);
  return `tempra-${d}.${ext}`;
};

export interface BedsideStatus {
  lastPressAt: string | null;
  lastHeartbeatAt: string | null;
  /**
   * `unknown` is the honest default: without heartbeats, silence from a device
   * behind home NAT is indistinguishable from a device that is simply unused.
   */
  health: 'unknown' | 'ok' | 'stale';
}

export const bedsideStatus = (db: Db): BedsideStatus => {
  const last = (kind: string): string | null => {
    const row = db
      .prepare("SELECT at FROM device_events WHERE device = 'bedside' AND kind = ? ORDER BY at DESC LIMIT 1")
      .get(kind) as { at: string } | undefined;
    return row?.at ?? null;
  };

  const lastHeartbeatAt = last('heartbeat');
  let health: BedsideStatus['health'] = 'unknown';
  if (lastHeartbeatAt) {
    const ageHours = (Date.now() - Date.parse(lastHeartbeatAt)) / 3_600_000;
    health = ageHours <= config.bedsideHeartbeatHours ? 'ok' : 'stale';
  }

  return { lastPressAt: last('press'), lastHeartbeatAt, health };
};
