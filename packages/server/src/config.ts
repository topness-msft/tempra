import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));

const bool = (v: string | undefined, fallback: boolean): boolean =>
  v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v);

/**
 * The web build lives outside this package, so resolve it rather than assume.
 * Checked in order: explicit env, monorepo layout, colocated (Docker) layout.
 */
const resolveWebDist = (): string | null => {
  const candidates = [
    process.env.WEB_DIST,
    path.resolve(here, '../../web/dist'),
    path.resolve(here, '../web'),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return null;
};

export const config = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  /** Fly mounts the persistent volume here; locally it falls back to ./data. */
  dataDir: process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data'),
  dbFile: process.env.DB_FILE ?? 'tempra.db',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  prettyLogs: bool(process.env.PRETTY_LOGS, process.env.NODE_ENV !== 'production'),
  webDist: resolveWebDist(),
  commit: process.env.FLY_MACHINE_VERSION ?? process.env.GIT_COMMIT ?? 'dev',

  /**
   * When no passphrase is configured the app refuses to pretend it is
   * protected: auth is off, the log says so, and the UI is told so it can warn.
   */
  passphrase: process.env.TEMPRA_PASSPHRASE ?? null,
  sessionSecret: process.env.SESSION_SECRET ?? 'insecure-dev-session-secret-change-me',
  /** Bearer credential for iOS Shortcuts and Siri. */
  apiToken: process.env.TEMPRA_API_TOKEN ?? null,
  /**
   * Hubitat's Rule Machine cannot set custom HTTP headers, so the bedside
   * button's credential has to live in the URL path. It is treated as a bearer
   * secret: constant-time compared, rate limited, and never logged in full.
   */
  bedsideSecret: process.env.BEDSIDE_SECRET ?? null,
  /** Hours of silence after which a heartbeat-enabled device is called stale. */
  bedsideHeartbeatHours: Number(process.env.BEDSIDE_HEARTBEAT_HOURS ?? 3),

  /**
   * Exposes a destructive `/api/test/reset` route for end-to-end tests. It is
   * opt-in, refuses to switch on in production, and refuses to coexist with a
   * configured passphrase — a real deployment can never accidentally ship a
   * button that erases the user's history.
   */
  allowTestReset:
    bool(process.env.ALLOW_TEST_RESET, false) &&
    process.env.NODE_ENV !== 'production' &&
    !process.env.TEMPRA_PASSPHRASE,
} as const;

export const dbPath = (): string => path.join(config.dataDir, config.dbFile);
