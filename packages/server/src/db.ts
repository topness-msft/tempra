import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type Db = Database.Database;

/**
 * Instants are stored as UTC ISO strings so they sort lexically, alongside the
 * offset that was in force when the entry was made. A flash logged at 3am
 * should still read as 3am next year, even if it was logged in another
 * timezone, and that is only recoverable if the offset is kept.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE flashes (
    id            TEXT PRIMARY KEY,
    started_at    TEXT NOT NULL,
    tz_offset_min INTEGER NOT NULL DEFAULT 0,
    ended_at      TEXT,
    duration_min  INTEGER,
    intensity     INTEGER CHECK (intensity IS NULL OR (intensity BETWEEN 1 AND 10)),
    note          TEXT,
    status        TEXT NOT NULL CHECK (status IN ('active','ended','superseded')),
    source        TEXT NOT NULL CHECK (source IN ('app','shortcut','homekit')),
    client_id     TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,

    -- An auto-closed flash must never claim a duration it did not observe.
    CHECK (status <> 'superseded' OR (ended_at IS NULL AND duration_min IS NULL)),
    CHECK (status <> 'ended'      OR (ended_at IS NOT NULL AND duration_min IS NOT NULL)),
    CHECK (status <> 'active'     OR (ended_at IS NULL AND duration_min IS NULL))
  );

  -- At most one flash may be running. Enforced by the database, not by hope.
  CREATE UNIQUE INDEX one_active ON flashes (status) WHERE status = 'active';
  CREATE INDEX flashes_started_at ON flashes (started_at DESC);

  -- Retried Shortcut and webhook calls must not create duplicate flashes.
  CREATE UNIQUE INDEX flashes_client_id ON flashes (client_id) WHERE client_id IS NOT NULL;

  CREATE TABLE flash_symptoms (
    flash_id TEXT NOT NULL REFERENCES flashes(id) ON DELETE CASCADE,
    symptom  TEXT NOT NULL,
    PRIMARY KEY (flash_id, symptom)
  );

  CREATE TABLE sketches (
    flash_id TEXT PRIMARY KEY REFERENCES flashes(id) ON DELETE CASCADE,
    width    REAL NOT NULL,
    height   REAL NOT NULL,
    strokes  TEXT NOT NULL
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Bedside button observations. Presses and heartbeats are recorded the same
  -- way so that silence can be told apart from a broken integration.
  CREATE TABLE device_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    device     TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('press','heartbeat')),
    at         TEXT NOT NULL,
    flash_id   TEXT REFERENCES flashes(id) ON DELETE SET NULL
  );
  CREATE INDEX device_events_at ON device_events (device, kind, at DESC);
  `,

  /*
   * An end time used to be mandatory for a closed flash. That was a design
   * error: the most likely flash of all — one that starts at 3am, cools the
   * bed, and is slept through — has no knowable end, and the schema forbade
   * exactly that. Recording *that a flash happened* is the point; how long it
   * lasted is a detail she may never be awake to supply.
   *
   * Duration is now optional. The only rule kept is that the two fields travel
   * together: an end time without a duration, or a duration without an end
   * time, would each be a value we made up.
   */
  `
  CREATE TABLE flashes_new (
    id            TEXT PRIMARY KEY,
    started_at    TEXT NOT NULL,
    tz_offset_min INTEGER NOT NULL DEFAULT 0,
    ended_at      TEXT,
    duration_min  INTEGER,
    intensity     INTEGER CHECK (intensity IS NULL OR (intensity BETWEEN 1 AND 10)),
    note          TEXT,
    status        TEXT NOT NULL CHECK (status IN ('active','ended','superseded')),
    source        TEXT NOT NULL CHECK (source IN ('app','shortcut','homekit')),
    client_id     TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,

    -- An auto-closed flash must never claim a duration it did not observe.
    CHECK (status <> 'superseded' OR (ended_at IS NULL AND duration_min IS NULL)),
    CHECK (status <> 'active'     OR (ended_at IS NULL AND duration_min IS NULL)),
    CHECK (status <> 'ended'      OR ((ended_at IS NULL) = (duration_min IS NULL)))
  );

  INSERT INTO flashes_new
    SELECT id, started_at, tz_offset_min, ended_at, duration_min, intensity, note,
           status, source, client_id, created_at, updated_at
      FROM flashes;

  DROP TABLE flashes;
  ALTER TABLE flashes_new RENAME TO flashes;

  CREATE UNIQUE INDEX one_active ON flashes (status) WHERE status = 'active';
  CREATE INDEX flashes_started_at ON flashes (started_at DESC);
  CREATE UNIQUE INDEX flashes_client_id ON flashes (client_id) WHERE client_id IS NOT NULL;
  `,
];

export const migrate = (db: Db): number => {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current >= MIGRATIONS.length) return MIGRATIONS.length;

  // Rebuilding a table means dropping one that other tables reference. With
  // foreign keys enforced, that DROP would cascade-delete the very symptoms and
  // sketches the rebuild exists to preserve. They are checked explicitly inside
  // the transaction instead, so a broken migration still cannot commit.
  const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
  if (fkWasOn) db.pragma('foreign_keys = OFF');

  try {
    for (let v = current; v < MIGRATIONS.length; v += 1) {
      const sql = MIGRATIONS[v];
      if (!sql) continue;
      db.exec('BEGIN');
      try {
        db.exec(sql);
        const violations = db.pragma('foreign_key_check') as unknown[];
        if (violations.length > 0) {
          throw new Error(`migration ${v + 1} left ${violations.length} dangling reference(s)`);
        }
        db.pragma(`user_version = ${v + 1}`);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }

  return MIGRATIONS.length;
};

export const openDb = (file: string): Db => {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  // WAL is what makes Litestream replication possible, and it keeps a read
  // during export from blocking a 3am write.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
};
