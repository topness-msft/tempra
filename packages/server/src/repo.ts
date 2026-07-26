import { randomUUID } from 'node:crypto';
import {
  DAY_SYMPTOMS,
  durationMinutes,
  isEmptyDayLog,
  type CreateFlashInput,
  type DayLog,
  type DaySymptom,
  type DaySymptomEntry,
  type PatchDaySymptomEntry,
  type Flash,
  type FlashSource,
  type Sketch,
  type Symptom,
} from '@tempra/shared';
import type { Db } from './db.js';
import { offsetMinutesOf, toLocalIso, toUtcIso } from './time.js';

interface FlashRow {
  id: string;
  started_at: string;
  tz_offset_min: number;
  ended_at: string | null;
  duration_min: number | null;
  intensity: number | null;
  note: string | null;
  status: Flash['status'];
  source: FlashSource;
  created_at: string;
  updated_at: string;
}

export interface ListOptions {
  limit?: number;
  /** Return flashes started strictly before this instant, for paging. */
  before?: string;
  from?: string;
  to?: string;
}

export class FlashRepo {
  constructor(private readonly db: Db) {}

  private hydrate(row: FlashRow): Flash {
    const symptoms = this.db
      .prepare('SELECT symptom FROM flash_symptoms WHERE flash_id = ? ORDER BY symptom')
      .all(row.id) as { symptom: Symptom }[];

    const sketchRow = this.db
      .prepare('SELECT width, height, strokes FROM sketches WHERE flash_id = ?')
      .get(row.id) as { width: number; height: number; strokes: string } | undefined;

    return {
      id: row.id,
      startedAt: toLocalIso(row.started_at, row.tz_offset_min),
      endedAt: row.ended_at ? toLocalIso(row.ended_at, row.tz_offset_min) : null,
      durationMin: row.duration_min,
      intensity: row.intensity,
      symptoms: symptoms.map((s) => s.symptom),
      note: row.note,
      sketch: sketchRow
        ? {
            width: sketchRow.width,
            height: sketchRow.height,
            strokes: JSON.parse(sketchRow.strokes) as Sketch['strokes'],
          }
        : null,
      status: row.status,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private setSymptoms(flashId: string, symptoms: readonly Symptom[]): void {
    this.db.prepare('DELETE FROM flash_symptoms WHERE flash_id = ?').run(flashId);
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO flash_symptoms (flash_id, symptom) VALUES (?, ?)',
    );
    for (const s of symptoms) insert.run(flashId, s);
  }

  private setSketch(flashId: string, sketch: Sketch | null): void {
    this.db.prepare('DELETE FROM sketches WHERE flash_id = ?').run(flashId);
    if (!sketch) return;
    this.db
      .prepare('INSERT INTO sketches (flash_id, width, height, strokes) VALUES (?, ?, ?, ?)')
      .run(flashId, sketch.width, sketch.height, JSON.stringify(sketch.strokes));
  }

  active(): Flash | null {
    const row = this.db.prepare("SELECT * FROM flashes WHERE status = 'active'").get() as
      | FlashRow
      | undefined;
    return row ? this.hydrate(row) : null;
  }

  get(id: string): Flash | null {
    const row = this.db.prepare('SELECT * FROM flashes WHERE id = ?').get(id) as
      | FlashRow
      | undefined;
    return row ? this.hydrate(row) : null;
  }

  byClientId(clientId: string): Flash | null {
    const row = this.db.prepare('SELECT * FROM flashes WHERE client_id = ?').get(clientId) as
      | FlashRow
      | undefined;
    return row ? this.hydrate(row) : null;
  }

  /**
   * Starting a flash closes any flash already running. The old one becomes
   * `superseded` with no end time and no duration: the app observed that it
   * stopped mattering, not when it stopped.
   */
  start(input: CreateFlashInput): Flash {
    const run = this.db.transaction((): string => {
      if (input.clientId) {
        const existing = this.db
          .prepare('SELECT id FROM flashes WHERE client_id = ?')
          .get(input.clientId) as { id: string } | undefined;
        if (existing) return existing.id;
      }

      const nowUtc = new Date().toISOString();
      const startedRaw = input.startedAt ?? nowUtc;
      const id = randomUUID();

      this.db
        .prepare("UPDATE flashes SET status = 'superseded', updated_at = ? WHERE status = 'active'")
        .run(nowUtc);

      this.db
        .prepare(
          `INSERT INTO flashes
             (id, started_at, tz_offset_min, status, source, intensity, note, client_id,
              created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          toUtcIso(startedRaw),
          offsetMinutesOf(startedRaw),
          input.source ?? 'app',
          input.intensity ?? null,
          input.note ?? null,
          input.clientId ?? null,
          nowUtc,
          nowUtc,
        );

      if (input.symptoms?.length) this.setSymptoms(id, input.symptoms);
      if (input.sketch) this.setSketch(id, input.sketch);
      return id;
    });

    const id = run();
    const flash = this.get(id);
    if (!flash) throw new Error('flash vanished immediately after insert');
    return flash;
  }

  /**
   * Closes a flash. Passing `endedAtRaw: null` closes it *without* an end time:
   * a flash slept through is over, but when it stopped is unknowable and will
   * not be invented. Duration and end time always travel together.
   */
  end(id: string | null, endedAtRaw?: string | null): Flash | null {
    const target = id ? this.get(id) : this.active();
    if (!target || target.status !== 'active') return null;

    const row = this.db.prepare('SELECT * FROM flashes WHERE id = ?').get(target.id) as FlashRow;
    const endedUtc = endedAtRaw === null ? null : toUtcIso(endedAtRaw ?? new Date().toISOString());
    const duration = endedUtc === null ? null : durationMinutes(row.started_at, endedUtc);

    this.db
      .prepare(
        `UPDATE flashes SET status = 'ended', ended_at = ?, duration_min = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(endedUtc, duration, new Date().toISOString(), target.id);

    return this.get(target.id);
  }

  update(
    id: string,
    patch: {
      intensity?: number | null;
      symptoms?: readonly Symptom[];
      note?: string | null;
      sketch?: Sketch | null;
    },
  ): Flash | null {
    const existing = this.get(id);
    if (!existing) return null;

    const run = this.db.transaction(() => {
      const sets: string[] = [];
      const args: (string | number | null)[] = [];
      if (patch.intensity !== undefined) {
        sets.push('intensity = ?');
        args.push(patch.intensity);
      }
      if (patch.note !== undefined) {
        sets.push('note = ?');
        args.push(patch.note);
      }
      sets.push('updated_at = ?');
      args.push(new Date().toISOString());
      args.push(id);
      this.db.prepare(`UPDATE flashes SET ${sets.join(', ')} WHERE id = ?`).run(...args);

      if (patch.symptoms !== undefined) this.setSymptoms(id, patch.symptoms);
      if (patch.sketch !== undefined) this.setSketch(id, patch.sketch);
    });

    run();
    return this.get(id);
  }

  list(opts: ListOptions = {}): Flash[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (opts.before) {
      clauses.push('started_at < ?');
      args.push(toUtcIso(opts.before));
    }
    if (opts.from) {
      clauses.push('started_at >= ?');
      args.push(toUtcIso(opts.from));
    }
    if (opts.to) {
      clauses.push('started_at <= ?');
      args.push(toUtcIso(opts.to));
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM flashes ${where} ORDER BY started_at DESC LIMIT ?`)
      .all(...args, limit) as FlashRow[];
    return rows.map((r) => this.hydrate(r));
  }

  /** Every flash, oldest first. Used by export, which must not paginate. */
  all(): Flash[] {
    const rows = this.db
      .prepare('SELECT * FROM flashes ORDER BY started_at ASC')
      .all() as FlashRow[];
    return rows.map((r) => this.hydrate(r));
  }

  remove(id: string): boolean {
    const res = this.db.prepare('DELETE FROM flashes WHERE id = ?').run(id);
    return res.changes > 0;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM flashes').get() as { n: number };
    return row.n;
  }
}

interface DayLogRow {
  date: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface DayListOptions {
  limit?: number;
  from?: string;
  to?: string;
}

/**
 * Day check-ins. Everything here is keyed on a local calendar date, so writing
 * one is an upsert rather than a create — replaying the same queued check-in
 * twice is a no-op instead of a duplicate.
 */
export class DayLogRepo {
  constructor(private readonly db: Db) {}

  private hydrate(row: DayLogRow): DayLog {
    const symptoms = this.db
      .prepare(
        'SELECT symptom, severity FROM day_log_symptoms WHERE date = ? ORDER BY symptom',
      )
      .all(row.date) as DaySymptomEntry[];

    return {
      date: row.date,
      // Vocabulary order, not alphabetical: the export and the UI should read in
      // the order she was asked, so the columns line up with the screen.
      symptoms: [...symptoms].sort(
        (a, b) => DAY_SYMPTOMS.indexOf(a.symptom) - DAY_SYMPTOMS.indexOf(b.symptom),
      ),
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  get(date: string): DayLog | null {
    const row = this.db.prepare('SELECT * FROM day_logs WHERE date = ?').get(date) as
      | DayLogRow
      | undefined;
    return row ? this.hydrate(row) : null;
  }

  /**
   * Replace the whole state of a day. A check-in with no symptoms and no note is
   * not an empty check-in, it is the absence of one, so it removes the row —
   * history can then say "no check-in for this day" instead of showing a blank
   * band that reads as "nothing was wrong".
   */
  put(date: string, input: { symptoms: readonly DaySymptomEntry[]; note?: string | null }): DayLog | null {
    const note = input.note?.trim() ? input.note.trim() : null;

    const run = this.db.transaction(() => {
      if (isEmptyDayLog({ symptoms: input.symptoms, note })) {
        this.db.prepare('DELETE FROM day_logs WHERE date = ?').run(date);
        return;
      }

      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO day_logs (date, note, created_at, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(date) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
        )
        .run(date, note, now, now);

      this.db.prepare('DELETE FROM day_log_symptoms WHERE date = ?').run(date);
      const insert = this.db.prepare(
        'INSERT OR REPLACE INTO day_log_symptoms (date, symptom, severity) VALUES (?, ?, ?)',
      );
      for (const s of input.symptoms) insert.run(date, s.symptom, s.severity);
    });

    run();
    return this.get(date);
  }

  /**
   * Fold a few symptoms into a day, leaving the rest alone. The Siri path knows
   * one thing — "log tinnitus" — and must not wipe what the app recorded this
   * morning just because it did not mention it.
   */
  patch(
    date: string,
    input: { symptoms?: readonly PatchDaySymptomEntry[]; note?: string | null },
  ): DayLog | null {
    const existing = this.get(date);
    const merged = new Map<DaySymptom, number>(
      (existing?.symptoms ?? []).map((s) => [s.symptom, s.severity]),
    );
    // A null severity is the only way to unsay something over PATCH: the
    // absence of a key means "don't touch it", so it cannot also mean "clear
    // it". Without this the Siri path could add but never correct.
    for (const s of input.symptoms ?? []) {
      if (s.severity === null) merged.delete(s.symptom);
      else merged.set(s.symptom, s.severity);
    }

    return this.put(date, {
      symptoms: [...merged].map(([symptom, severity]) => ({ symptom, severity })),
      note: input.note === undefined ? existing?.note ?? null : input.note,
    });
  }

  list(opts: DayListOptions = {}): DayLog[] {
    const limit = Math.min(Math.max(opts.limit ?? 60, 1), 1000);
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (opts.from) {
      clauses.push('date >= ?');
      args.push(opts.from);
    }
    if (opts.to) {
      clauses.push('date <= ?');
      args.push(opts.to);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM day_logs ${where} ORDER BY date DESC LIMIT ?`)
      .all(...args, limit) as DayLogRow[];
    return rows.map((r) => this.hydrate(r));
  }

  /** Every check-in, oldest first. Used by export, which must not paginate. */
  all(): DayLog[] {
    const rows = this.db
      .prepare('SELECT * FROM day_logs ORDER BY date ASC')
      .all() as DayLogRow[];
    return rows.map((r) => this.hydrate(r));
  }

  remove(date: string): boolean {
    return this.db.prepare('DELETE FROM day_logs WHERE date = ?').run(date).changes > 0;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM day_logs').get() as { n: number };
    return row.n;
  }
}
