import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  createFlashSchema,
  endFlashSchema,
  localDateSchema,
  patchDayLogSchema,
  putDayLogSchema,
  updateFlashSchema,
  type Flash,
} from '@tempra/shared';
import type { Db } from './db.js';
import { DayLogRepo, FlashRepo } from './repo.js';
import { config } from './config.js';
import { safeEqual, verifyPassphrase } from './crypto.js';
import { hashPassphrase } from './crypto.js';
import { toCsv, toDaysCsv, toJsonExport } from './export.js';

const SESSION_COOKIE = 'tempra_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 365; // a year: re-auth at 3am is hostile

/**
 * Two starts closer together than this, from a source that cannot show her
 * whether the first one worked, are treated as one. A physical button pressed
 * in the dark gets double-tapped and Hubitat retries failed posts; a Siri
 * shortcut gets run twice because nothing confirmed the first. None of those
 * should become two flashes seconds apart.
 */
const DEBOUNCE_MS = 60_000;

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  before: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const dayListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  from: localDateSchema.optional(),
  to: localDateSchema.optional(),
});

/**
 * How many days of check-ins ride along with the app state. History renders the
 * bands from this, so it has to cover at least the window the flash list does.
 */
const STATE_DAYS = 60;

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
  const days = new DayLogRepo(opts.db);
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
      days: days.list({ limit: STATE_DAYS }),
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

    /*
     * Siri fires blind. She says it, hears nothing useful back, is not sure it
     * worked, and says it again — and two flashes appear a few seconds apart
     * where there was one.
     *
     * Only the blind sources are debounced. The app shows her the flash it just
     * started, so a repeat there is deliberate: starting a second flash while
     * one is still running is a real thing she can do, and swallowing it would
     * lose the record. The app also sends a clientId, which already makes a
     * replayed outbox write idempotent.
     *
     * A request that names its own startedAt is exempt too. That is someone
     * being deliberate about a particular moment rather than saying "now", and
     * a backfill of two close flashes must not be quietly collapsed into one.
     */
    const blind = (parsed.data.source ?? 'app') !== 'app';
    if (blind && !parsed.data.startedAt) {
      const last = repo.lastCreated();
      if (last && Date.now() - Date.parse(last.createdAt) < DEBOUNCE_MS) {
        // 200 rather than 201: nothing was created. Returning the whole flash
        // lets the shortcut still answer "started at 3:14" instead of an error,
        // which is true, and is what she asked to know.
        return reply.code(200).send(last);
      }
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

  // ------------------------------------------------------------- day check-ins

  app.get('/api/days', { preHandler: guard }, async (req, reply) => {
    const parsed = dayListQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    return { days: days.list(parsed.data) };
  });

  app.get<{ Params: { date: string } }>(
    '/api/days/:date',
    { preHandler: guard },
    async (req, reply) => {
      if (!localDateSchema.safeParse(req.params.date).success) {
        return reply.code(400).send({ error: 'invalid_date' });
      }
      const day = days.get(req.params.date);
      if (!day) return reply.code(404).send({ error: 'not_found' });
      return day;
    },
  );

  /*
   * PUT replaces the whole day; PATCH folds a few symptoms into it.
   *
   * The app holds the entire state of the day on screen, so it sends PUT — and
   * because the record is keyed on the date, that write is an upsert. Replaying
   * it from the offline outbox any number of times cannot produce a second
   * check-in, which is why this needs no client id.
   *
   * Siri knows one thing at a time and uses PATCH, so "log tinnitus" cannot
   * wipe what was recorded this morning simply by not mentioning it.
   */
  app.put<{ Params: { date: string } }>(
    '/api/days/:date',
    { preHandler: guard },
    async (req, reply) => {
      if (!localDateSchema.safeParse(req.params.date).success) {
        return reply.code(400).send({ error: 'invalid_date' });
      }
      const parsed = putDayLogSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues });
      }
      const saved = days.put(req.params.date, parsed.data);
      // An emptied check-in is the absence of one, not an empty one.
      return saved ?? reply.code(204).send();
    },
  );

  app.patch<{ Params: { date: string } }>(
    '/api/days/:date',
    { preHandler: guard },
    async (req, reply) => {
      if (!localDateSchema.safeParse(req.params.date).success) {
        return reply.code(400).send({ error: 'invalid_date' });
      }
      const parsed = patchDayLogSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.issues });
      }
      const saved = days.patch(req.params.date, parsed.data);
      return saved ?? reply.code(204).send();
    },
  );

  app.delete<{ Params: { date: string } }>(
    '/api/days/:date',
    { preHandler: guard },
    async (req, reply) => {
      if (!days.remove(req.params.date)) return reply.code(404).send({ error: 'not_found' });
      return reply.code(204).send();
    },
  );

  // ------------------------------------------------------------------ export

  app.get('/api/export.json', { preHandler: guard }, async (_req, reply) =>
    reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="${exportName('json')}"`)
      .send(JSON.stringify(toJsonExport(repo.all(), days.all()), null, 2)),
  );

  app.get('/api/export.csv', { preHandler: guard }, async (_req, reply) =>
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${exportName('csv')}"`)
      .send(toCsv(repo.all())),
  );

  app.get('/api/export-days.csv', { preHandler: guard }, async (_req, reply) =>
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${exportName('csv', 'days')}"`)
      .send(toDaysCsv(days.all())),
  );

  // ----------------------------------------------------------------- bedside

  /*
   * The webhook lives in its own plugin scope so the forgiving body parsing
   * below reaches this route and nothing else. The rest of the API is only ever
   * called by our own code and should keep rejecting a malformed body loudly.
   * This route is called by a hand-typed field in a Rule Machine action at 3am,
   * where a rejection is invisible: the bed still cools, so from the bedroom
   * the button looks like it worked while nothing is logged.
   */
  await app.register(async (hooks) => {
    /*
     * Hubitat decides the encoding and we do not get a vote. Older Rule Machine
     * builds post form-encoded with no setting to change it, and a rule can be
     * configured with a JSON content type and no body at all. Fastify's stock
     * parsers answer 400 to the empty body and 415 to the form encoding, and
     * the setup guide has always promised the empty POST works.
     *
     * A non-empty body we cannot read is a different matter and still fails.
     * Recovering from it would mean guessing between a press and a heartbeat,
     * and guessing "press" fabricates a flash out of noise — the one thing this
     * app must never do. A loud failure is better than an invented row.
     */
    const parseBedsideBody = (
      _req: FastifyRequest,
      payload: string,
      done: (err: Error | null, body?: unknown) => void,
    ): void => {
      const raw = typeof payload === 'string' ? payload.trim() : '';
      if (raw === '') return done(null, {});
      try {
        return done(null, JSON.parse(raw));
      } catch {
        // Not JSON. Fall through and try the form encoding before giving up.
      }
      if (raw.includes('=')) return done(null, Object.fromEntries(new URLSearchParams(raw)));
      const err = new Error('bedside body is neither JSON nor form encoded') as Error & {
        statusCode?: number;
      };
      err.statusCode = 400;
      return done(err);
    };

    hooks.addContentTypeParser('application/json', { parseAs: 'string' }, parseBedsideBody);
    hooks.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      parseBedsideBody,
    );
    /*
     * text/plain has to be named explicitly. Fastify ships a parser for it that
     * hands the body through as a raw string, and a catch-all does not displace
     * a type that is already registered. Left alone, a JSON heartbeat labelled
     * text/plain failed the schema and fell back to the "press" default —
     * quietly turning a health check into a hot flash that never happened.
     */
    hooks.addContentTypeParser('text/plain', { parseAs: 'string' }, parseBedsideBody);
    // A rule can also be left with no content type at all. Take whatever turns
    // up rather than answering 415 to a real press.
    hooks.addContentTypeParser('*', { parseAs: 'string' }, parseBedsideBody);

    /*
     * The first thing anyone does with a webhook that looks broken is paste its
     * URL into a browser. That is a GET, and it used to fall through to the
     * catch-all 404 — byte-identical to the answer for a wrong secret. So the
     * one diagnostic everybody reaches for could not tell a healthy hook from a
     * mistyped one, and reported failure either way.
     *
     * Answering honestly costs nothing: this URL *is* the credential, so anyone
     * who can make this request could already POST and start a flash. A wrong
     * secret still gets the flat 404 and learns nothing.
     */
    hooks.get<{ Params: { secret: string } }>('/hooks/bedside/:secret', async (req, reply) => {
      if (!bedsideLimiter.allow(req.ip)) return reply.code(429).send({ error: 'rate_limited' });
      if (!config.bedsideSecret || !safeEqual(req.params.secret, config.bedsideSecret)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(405).header('allow', 'POST').send({
        ok: false,
        error: 'method_not_allowed',
        hint: 'This secret is correct. POST to this URL to log a press.',
      });
    });

    /**
     * Hubitat posts here. The secret is the last path segment because Rule
     * Machine cannot attach headers. Both presses and heartbeats land here so
     * that silence can be distinguished from a broken integration.
     */
    hooks.post<{ Params: { secret: string; kind?: string } }>(
      '/hooks/bedside/:secret',
      async (req, reply) => {
        if (!bedsideLimiter.allow(req.ip)) return reply.code(429).send({ error: 'rate_limited' });
        if (!config.bedsideSecret || !safeEqual(req.params.secret, config.bedsideSecret)) {
          req.log.warn({ ip: req.ip }, 'bedside webhook rejected');
          return reply.code(404).send({ error: 'not_found' });
        }

        /*
         * The default belongs to a body that isn't there — not to one that is
         * there and doesn't validate. Falling back to 'press' on any parse
         * failure meant a capitalised value or a typo'd key in a hand-edited
         * Rule Machine field turned the *hourly heartbeat* into an hourly hot
         * flash that never happened: silent, repeating, and reading back later
         * as a genuinely terrible night. Strict, so an unknown key is an error
         * rather than an invented flash. A webhook answering 400 gets noticed
         * and fixed; a fabricated row does not.
         *
         * Case and stray whitespace are still forgiven. Reading "Heartbeat " as
         * a heartbeat is not guessing between two meanings — it is reading the
         * one that was plainly written.
         */
        const body = z
          .object({
            kind: z
              .preprocess(
                (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
                z.enum(['press', 'heartbeat']),
              )
              .default('press'),
          })
          .strict()
          .safeParse(req.body ?? {});
        if (!body.success) {
          req.log.warn({ ip: req.ip }, 'bedside webhook body rejected');
          return reply.code(400).send({
            error: 'invalid_body',
            hint: 'Send an empty body, {"kind":"press"} or {"kind":"heartbeat"}.',
          });
        }
        const kind = body.data.kind;
        const now = new Date().toISOString();

        if (kind === 'heartbeat') {
          opts.db
            .prepare(
              "INSERT INTO device_events (device, kind, at) VALUES ('bedside', 'heartbeat', ?)",
            )
            .run(now);
          return { ok: true, kind };
        }

        /*
         * A press always starts a flash. It is never a toggle.
         *
         * The button exists so that one tap in the dark starts the bed cooling and
         * records that a flash began. The hope is that she falls back to sleep, so
         * a second press to "stop the recording" is not something that will ever
         * happen. Treating a press as an end would mean the most likely second
         * press of the night — another flash — silently closed the first one
         * instead of recording a new one.
         *
         * If a flash is already running it becomes superseded, with no ended_at
         * and no duration: we know a new flash started, we do not know when the
         * old one stopped, and we will not invent it.
         */
        const last = opts.db
          .prepare(
            "SELECT at FROM device_events WHERE device = 'bedside' AND kind = 'press' ORDER BY at DESC LIMIT 1",
          )
          .get() as { at: string } | undefined;

        /*
         * A physical button pressed in the dark gets double-tapped, and Hubitat
         * retries. Neither should show up as two flashes a few seconds apart.
         *
         * The press log alone is not enough, because the two blind paths reach
         * for the same flash by different routes: she says it to Siri, cannot
         * tell whether it worked, and reaches for the button as well. That is
         * one flash and one intention, so any flash recorded in the window
         * counts here — not just a previous press. The press log is still
         * consulted because it outlives a deleted flash.
         *
         * Debouncing costs her nothing physical: the bed cools from a separate
         * hub action that never sees this response.
         */
        const recent = repo.lastCreated();
        const lastAt = Math.max(
          last ? Date.parse(last.at) : -Infinity,
          recent ? Date.parse(recent.createdAt) : -Infinity,
        );
        if (Date.now() - lastAt < DEBOUNCE_MS) {
          return { ok: true, kind, action: 'debounced', flash: repo.active() ?? recent };
        }

        const flash = repo.start({ source: 'homekit' });
        opts.db
          .prepare(
            "INSERT INTO device_events (device, kind, at, flash_id) VALUES ('bedside', 'press', ?, ?)",
          )
          .run(now, flash.id);

        return { ok: true, kind, action: 'started', flash };
      },
    );
  });

  // -------------------------------------------------------------- test hatch

  if (config.allowTestReset) {
    // Only reachable when ALLOW_TEST_RESET is on, NODE_ENV is not production,
    // and no passphrase is configured. See config.allowTestReset.
    app.log.warn('ALLOW_TEST_RESET is on: /api/test/reset will erase all data');
    app.post('/api/test/reset', async () => {
      opts.db.exec(
        'DELETE FROM sketches; DELETE FROM device_events; DELETE FROM flashes; DELETE FROM day_log_symptoms; DELETE FROM day_logs;',
      );
      return { ok: true };
    });
  }
};

const exportName = (ext: string, kind = 'export'): string => {
  const d = new Date().toISOString().slice(0, 10);
  return `tempra-${kind}-${d}.${ext}`;
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
