import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, migrate, type Db } from '../src/db.js';
import { FlashRepo, DayLogRepo } from '../src/repo.js';

let db: Db;
let repo: FlashRepo;

beforeEach(() => {
  db = openDb(':memory:');
  repo = new FlashRepo(db);
});

describe('starting a flash', () => {
  it('creates an active flash from an empty body', () => {
    const f = repo.start({});
    expect(f.status).toBe('active');
    expect(f.endedAt).toBeNull();
    expect(f.durationMin).toBeNull();
    expect(f.source).toBe('app');
  });

  it('keeps at most one active flash', () => {
    repo.start({});
    repo.start({});
    const actives = db
      .prepare("SELECT COUNT(*) AS n FROM flashes WHERE status = 'active'")
      .get() as { n: number };
    expect(actives.n).toBe(1);
  });

  it('supersedes the previous flash without inventing a duration', () => {
    const first = repo.start({});
    repo.start({});
    const reloaded = repo.get(first.id);
    expect(reloaded?.status).toBe('superseded');
    expect(reloaded?.endedAt).toBeNull();
    expect(reloaded?.durationMin).toBeNull();
  });

  it('stores symptoms and a sketch', () => {
    const f = repo.start({
      symptoms: ['sweating', 'anxiety'],
      sketch: { width: 300, height: 200, strokes: [{ color: '#b33f66', points: [{ x: 1, y: 2, w: 3 }] }] },
    });
    expect(f.symptoms).toEqual(['anxiety', 'sweating']);
    expect(f.sketch?.strokes).toHaveLength(1);
  });
});

/*
 * Making duration optional meant rebuilding `flashes`, which means dropping a
 * table that symptoms and sketches reference. With foreign keys enforced that
 * DROP silently cascades them away, so the rebuild is exercised directly.
 */
describe('migrations', () => {
  it('preserves symptoms and sketches when the flashes table is rebuilt', () => {
    const f = repo.start({
      symptoms: ['sweating', 'anxiety'],
      sketch: { width: 300, height: 200, strokes: [{ color: '#b33f66', points: [{ x: 1, y: 2, w: 3 }] }] },
    });

    db.pragma('user_version = 1');
    migrate(db);

    const after = repo.get(f.id);
    expect(after?.symptoms).toEqual(['anxiety', 'sweating']);
    expect(after?.sketch?.strokes).toHaveLength(1);
  });

  it('restores foreign key enforcement afterwards', () => {
    db.pragma('user_version = 1');
    migrate(db);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('keeps the one-active index after the rebuild', () => {
    repo.start({});
    db.pragma('user_version = 1');
    migrate(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO flashes (id, started_at, tz_offset_min, status, source, created_at, updated_at)
           VALUES ('x', '2026-01-01T03:00:00Z', 0, 'active', 'app', '2026-01-01T03:00:00Z', '2026-01-01T03:00:00Z')`,
        )
        .run(),
    ).toThrow();
  });

  /*
   * Day check-ins arrived as migration 3. The production database holds real
   * health data, so the only acceptable upgrade is one that adds two empty
   * tables and leaves every flash exactly where it was.
   */
  it('adds the day check-in tables to an existing database without touching the flashes', () => {
    const f = repo.start({ symptoms: ['sweating'], note: 'still here afterwards' });

    // Rewind to what a machine running the previous release actually has on disk.
    db.exec('DROP TABLE day_log_symptoms; DROP TABLE day_logs;');
    db.pragma('user_version = 2');
    migrate(db);

    expect(db.pragma('user_version', { simple: true })).toBe(3);
    const after = repo.get(f.id);
    expect(after?.symptoms).toEqual(['sweating']);
    expect(after?.note).toBe('still here afterwards');
    expect(new DayLogRepo(db).count()).toBe(0);
  });
});

describe('idempotency', () => {
  it('returns the same flash for a repeated clientId instead of duplicating', () => {
    const a = repo.start({ clientId: 'shortcut-abc', source: 'shortcut' });
    const b = repo.start({ clientId: 'shortcut-abc', source: 'shortcut' });
    expect(b.id).toBe(a.id);
    expect(repo.count()).toBe(1);
  });

  it('does not supersede the original when a retry arrives', () => {
    repo.start({ clientId: 'retry-1' });
    repo.start({ clientId: 'retry-1' });
    expect(repo.active()?.status).toBe('active');
    expect(repo.count()).toBe(1);
  });
});

describe('ending a flash', () => {
  it('computes a whole-minute duration', () => {
    repo.start({ startedAt: '2026-01-01T03:00:00Z' });
    const ended = repo.end(null, '2026-01-01T03:22:30Z');
    expect(ended?.status).toBe('ended');
    expect(ended?.durationMin).toBe(22);
  });

  it('ends the active flash when no id is given', () => {
    const f = repo.start({});
    expect(repo.end(null)?.id).toBe(f.id);
    expect(repo.active()).toBeNull();
  });

  it('returns null when nothing is running', () => {
    expect(repo.end(null)).toBeNull();
  });

  /*
   * The commonest flash of all is the one she sleeps through: the bed cools,
   * she settles, and nobody is awake to close it. Requiring an end time would
   * make the normal case the one the app cannot record.
   */
  it('closes without an end time when the duration is unknowable', () => {
    const f = repo.start({ startedAt: '2026-01-01T03:00:00Z' });
    const closed = repo.end(f.id, null);
    expect(closed?.status).toBe('ended');
    expect(closed?.endedAt).toBeNull();
    expect(closed?.durationMin).toBeNull();
  });

  it('leaves nothing running after closing without an end time', () => {
    const f = repo.start({ startedAt: '2026-01-01T03:00:00Z' });
    repo.end(f.id, null);
    expect(repo.active()).toBeNull();
  });

  it('refuses to end an already-ended flash twice', () => {
    const f = repo.start({ startedAt: '2026-01-01T03:00:00Z' });
    repo.end(f.id, '2026-01-01T03:10:00Z');
    expect(repo.end(f.id, '2026-01-01T04:00:00Z')).toBeNull();
    expect(repo.get(f.id)?.durationMin).toBe(10);
  });

  it('never records a negative duration when the clock disagrees', () => {
    repo.start({ startedAt: '2026-01-01T03:00:00Z' });
    const ended = repo.end(null, '2026-01-01T02:00:00Z');
    expect(ended?.durationMin).toBe(0);
  });
});

describe('timezone handling', () => {
  it('preserves the wall-clock time and offset it was logged with', () => {
    const f = repo.start({ startedAt: '2026-01-01T03:15:00-05:00' });
    expect(f.startedAt).toBe('2026-01-01T03:15:00.000-05:00');
  });

  it('sorts by true instant, not by local wall clock', () => {
    repo.start({ startedAt: '2026-01-01T01:00:00-05:00' }); // 06:00Z
    repo.start({ startedAt: '2026-01-01T03:00:00+05:00' }); // 22:00Z previous day
    const [newest] = repo.list();
    expect(newest?.startedAt).toBe('2026-01-01T01:00:00.000-05:00');
  });
});

describe('database-level invariants', () => {
  it('rejects a superseded row carrying a duration', () => {
    const f = repo.start({});
    expect(() =>
      db
        .prepare("UPDATE flashes SET status = 'superseded', duration_min = 20 WHERE id = ?")
        .run(f.id),
    ).toThrow();
  });

  /*
   * Duration became optional, but the two fields still travel together. Either
   * one alone would be a number nobody observed.
   */
  it('rejects an ended row holding a duration with no end time', () => {
    const f = repo.start({});
    expect(() =>
      db
        .prepare("UPDATE flashes SET status = 'ended', duration_min = 20 WHERE id = ?")
        .run(f.id),
    ).toThrow();
  });

  it('rejects an ended row holding an end time with no duration', () => {
    const f = repo.start({});
    expect(() =>
      db
        .prepare("UPDATE flashes SET status = 'ended', ended_at = '2026-01-01T04:00:00Z' WHERE id = ?")
        .run(f.id),
    ).toThrow();
  });

  it('rejects an out-of-range intensity written directly', () => {
    const f = repo.start({});
    expect(() => db.prepare('UPDATE flashes SET intensity = 42 WHERE id = ?').run(f.id)).toThrow();
  });

  it('rejects a second active row inserted behind the repository', () => {
    repo.start({});
    expect(() =>
      db
        .prepare(
          `INSERT INTO flashes (id, started_at, status, source, created_at, updated_at)
           VALUES ('x', '2026-01-01T00:00:00.000Z', 'active', 'app', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow();
  });

  it('cascades deletes to symptoms and sketches', () => {
    const f = repo.start({
      symptoms: ['chills'],
      sketch: { width: 10, height: 10, strokes: [{ color: '#000000', points: [{ x: 0, y: 0, w: 1 }] }] },
    });
    repo.remove(f.id);
    const s = db.prepare('SELECT COUNT(*) AS n FROM flash_symptoms').get() as { n: number };
    const k = db.prepare('SELECT COUNT(*) AS n FROM sketches').get() as { n: number };
    expect(s.n).toBe(0);
    expect(k.n).toBe(0);
  });
});

describe('updating a flash', () => {
  it('replaces symptoms rather than appending', () => {
    const f = repo.start({ symptoms: ['chills', 'nausea'] });
    const updated = repo.update(f.id, { symptoms: ['sweating'] });
    expect(updated?.symptoms).toEqual(['sweating']);
  });

  it('clears a sketch when passed null', () => {
    const f = repo.start({
      sketch: { width: 10, height: 10, strokes: [{ color: '#000000', points: [{ x: 0, y: 0, w: 1 }] }] },
    });
    expect(repo.update(f.id, { sketch: null })?.sketch).toBeNull();
  });

  it('leaves untouched fields alone', () => {
    const f = repo.start({ intensity: 7, note: 'drenched' });
    const updated = repo.update(f.id, { intensity: 8 });
    expect(updated?.note).toBe('drenched');
  });
});

/*
 * Correcting a flash after the fact is deliberately PATCH and not the end
 * endpoint: `end()` closes a *running* flash and must keep refusing anything
 * else, or a second bedside press in the night would silently rewrite the end
 * time of the flash that just closed.
 */
describe('correcting the duration of a finished flash', () => {
  const started = '2026-02-01T03:00:00Z';

  it('derives the duration from the end time rather than trusting a client', () => {
    const f = repo.start({ startedAt: started });
    repo.end(f.id, '2026-02-01T03:12:00Z');
    const fixed = repo.update(f.id, { endedAt: '2026-02-01T03:25:00Z' });
    expect(fixed?.durationMin).toBe(25);
    expect(fixed?.status).toBe('ended');
  });

  it('gives a length to a flash that was closed without one', () => {
    const f = repo.start({ startedAt: started });
    repo.end(f.id, null);
    expect(repo.get(f.id)?.durationMin).toBeNull();
    expect(repo.update(f.id, { endedAt: '2026-02-01T03:40:00Z' })?.durationMin).toBe(40);
  });

  it('promotes a superseded flash to ended once its length is known', () => {
    const first = repo.start({ startedAt: started });
    repo.start({ startedAt: '2026-02-01T04:00:00Z' });
    expect(repo.get(first.id)?.status).toBe('superseded');
    const fixed = repo.update(first.id, { endedAt: '2026-02-01T03:20:00Z' });
    expect(fixed?.status).toBe('ended');
    expect(fixed?.durationMin).toBe(20);
  });

  // Withdrawing a guess is not a claim about how the flash closed, so a
  // superseded record must not be rewritten as a deliberate end.
  it('clears a duration without changing how the flash closed', () => {
    const first = repo.start({ startedAt: started });
    repo.start({ startedAt: '2026-02-01T04:00:00Z' });
    const cleared = repo.update(first.id, { endedAt: null });
    expect(cleared?.status).toBe('superseded');
    expect(cleared?.endedAt).toBeNull();
    expect(cleared?.durationMin).toBeNull();
  });

  it('keeps end time and duration travelling together when cleared', () => {
    const f = repo.start({ startedAt: started });
    repo.end(f.id, '2026-02-01T03:12:00Z');
    const cleared = repo.update(f.id, { endedAt: null });
    expect(cleared?.status).toBe('ended');
    expect(cleared?.endedAt).toBeNull();
    expect(cleared?.durationMin).toBeNull();
  });

  it('corrects the duration and the note as one write', () => {
    const f = repo.start({ startedAt: started, note: 'wrote this at 3am' });
    repo.end(f.id, null);
    const fixed = repo.update(f.id, { endedAt: '2026-02-01T03:18:00Z', note: 'clearer now' });
    expect(fixed?.durationMin).toBe(18);
    expect(fixed?.note).toBe('clearer now');
  });
});

describe('listing', () => {
  it('returns newest first and honours a limit', () => {
    for (let i = 1; i <= 5; i += 1) {
      repo.start({ startedAt: `2026-01-0${i}T03:00:00Z` });
    }
    const rows = repo.list({ limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.startedAt.startsWith('2026-01-05')).toBe(true);
  });

  it('filters by range', () => {
    repo.start({ startedAt: '2026-01-01T03:00:00Z' });
    repo.start({ startedAt: '2026-02-01T03:00:00Z' });
    const rows = repo.list({ from: '2026-01-15T00:00:00Z' });
    expect(rows).toHaveLength(1);
  });

  it('exports oldest first so a spreadsheet reads forwards in time', () => {
    repo.start({ startedAt: '2026-01-02T03:00:00Z' });
    repo.start({ startedAt: '2026-01-01T03:00:00Z' });
    const rows = repo.all();
    expect(rows[0]?.startedAt.startsWith('2026-01-01')).toBe(true);
  });
});
