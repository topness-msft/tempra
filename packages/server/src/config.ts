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
} as const;

export const dbPath = (): string => path.join(config.dataDir, config.dbFile);
