import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { DayLogRepo } from '../src/repo.js';
import { toDaysCsv, toJsonExport } from '../src/export.js';

let db: Db;
let repo: DayLogRepo;

beforeEach(() => {
  db = openDb(':memory:');
  repo = new DayLogRepo(db);
});

describe('writing a day check-in', () => {
  it('creates a check-in keyed on the local date', () => {
    const saved = repo.put('2026-07-26', {
      symptoms: [{ symptom: 'tinnitus', severity: 2 }],
      note: 'worse in the quiet',
    });
    expect(saved?.date).toBe('2026-07-26');
    expect(saved?.symptoms).toEqual([{ symptom: 'tinnitus', severity: 2 }]);
    expect(saved?.note).toBe('worse in the quiet');
  });

  it('is an upsert, so replaying the same write never makes a second check-in', () => {
    // This is what lets the offline outbox retry a queued check-in without a
    // client id: the date is the identity.
    const body = { symptoms: [{ symptom: 'sleep' as const, severity: 3 }], note: null };
    repo.put('2026-07-26', body);
    repo.put('2026-07-26', body);
    expect(repo.count()).toBe(1);
  });

  it('replaces the symptom set outright rather than merging', () => {
    repo.put('2026-07-26', {
      symptoms: [
        { symptom: 'tinnitus', severity: 2 },
        { symptom: 'sleep', severity: 3 },
      ],
    });
    const saved = repo.put('2026-07-26', { symptoms: [{ symptom: 'tinnitus', severity: 1 }] });
    expect(saved?.symptoms).toEqual([{ symptom: 'tinnitus', severity: 1 }]);
  });

  it('keeps a check-in whose only report is None', () => {
    // Severity 0 is something she tapped. It is not the same as saying nothing.
    const saved = repo.put('2026-07-26', { symptoms: [{ symptom: 'joint_pain', severity: 0 }] });
    expect(saved?.symptoms).toEqual([{ symptom: 'joint_pain', severity: 0 }]);
  });

  it('removes the record when nothing is left in it', () => {
    repo.put('2026-07-26', { symptoms: [{ symptom: 'tinnitus', severity: 2 }] });
    expect(repo.put('2026-07-26', { symptoms: [], note: null })).toBeNull();
    expect(repo.get('2026-07-26')).toBeNull();
    // The symptoms must go with it rather than dangling on a deleted date.
    const left = db.prepare('SELECT COUNT(*) AS n FROM day_log_symptoms').get() as { n: number };
    expect(left.n).toBe(0);
  });

  it('orders symptoms by the vocabulary, not alphabetically', () => {
    const saved = repo.put('2026-07-26', {
      symptoms: [
        { symptom: 'tinnitus', severity: 1 },
        { symptom: 'sleep', severity: 2 },
      ],
    });
    expect(saved?.symptoms.map((s) => s.symptom)).toEqual(['sleep', 'tinnitus']);
  });
});

describe('patching a day check-in', () => {
  it('folds a symptom in without touching the rest', () => {
    // The Siri path knows one thing and must not wipe the morning's answers.
    repo.put('2026-07-26', {
      symptoms: [{ symptom: 'sleep', severity: 3 }],
      note: 'rough night',
    });
    const saved = repo.patch('2026-07-26', {
      symptoms: [{ symptom: 'tinnitus', severity: 2 }],
    });
    expect(saved?.symptoms).toEqual([
      { symptom: 'sleep', severity: 3 },
      { symptom: 'tinnitus', severity: 2 },
    ]);
    expect(saved?.note).toBe('rough night');
  });

  it('creates the day when there is not one yet', () => {
    const saved = repo.patch('2026-07-26', { symptoms: [{ symptom: 'tinnitus', severity: 1 }] });
    expect(saved?.date).toBe('2026-07-26');
  });

  it('takes a symptom back to unrecorded when the severity is null', () => {
    // Absence of a key means "leave it alone", so it cannot also mean "clear
    // it". Null is the only way PATCH can unsay something.
    repo.put('2026-07-26', {
      symptoms: [
        { symptom: 'sleep', severity: 3 },
        { symptom: 'tinnitus', severity: 2 },
      ],
    });
    const saved = repo.patch('2026-07-26', { symptoms: [{ symptom: 'tinnitus', severity: null }] });
    expect(saved?.symptoms).toEqual([{ symptom: 'sleep', severity: 3 }]);
  });

  it('stops existing once the last symptom is unsaid', () => {
    repo.put('2026-07-26', { symptoms: [{ symptom: 'tinnitus', severity: 2 }] });
    expect(repo.patch('2026-07-26', { symptoms: [{ symptom: 'tinnitus', severity: null }] })).toBe(
      null,
    );
    expect(repo.get('2026-07-26')).toBe(null);
  });
});

describe('listing day check-ins', () => {
  beforeEach(() => {
    for (const date of ['2026-07-24', '2026-07-25', '2026-07-26']) {
      repo.put(date, { symptoms: [{ symptom: 'tinnitus', severity: 1 }] });
    }
  });

  it('returns newest first', () => {
    expect(repo.list().map((d) => d.date)).toEqual(['2026-07-26', '2026-07-25', '2026-07-24']);
  });

  it('filters by date range', () => {
    expect(repo.list({ from: '2026-07-25', to: '2026-07-25' }).map((d) => d.date)).toEqual([
      '2026-07-25',
    ]);
  });

  it('returns everything oldest first for export', () => {
    expect(repo.all().map((d) => d.date)).toEqual(['2026-07-24', '2026-07-25', '2026-07-26']);
  });
});

describe('exporting day check-ins', () => {
  it('writes one row per day with a column per symptom', () => {
    repo.put('2026-07-26', {
      symptoms: [
        { symptom: 'sleep', severity: 3 },
        { symptom: 'tinnitus', severity: 1 },
      ],
      note: 'ringing all day',
    });
    const csv = toDaysCsv(repo.all());
    const [header, row] = csv.trim().split('\r\n');
    expect(header?.startsWith('date,sleep,fatigue')).toBe(true);
    expect(row).toContain('"Severe"');
    expect(row).toContain('"Mild"');
    expect(row).toContain('"ringing all day"');
  });

  it('leaves an unreported symptom blank rather than calling it none', () => {
    repo.put('2026-07-26', { symptoms: [{ symptom: 'joint_pain', severity: 0 }] });
    const row = toDaysCsv(repo.all()).trim().split('\r\n')[1] ?? '';
    // joint_pain says None; nothing else says anything at all.
    expect(row).toContain('"None"');
    expect(row.split(',').filter((c) => c === '').length).toBeGreaterThan(0);
  });

  it('carries both records and both vocabularies in the JSON', () => {
    repo.put('2026-07-26', { symptoms: [{ symptom: 'tinnitus', severity: 2 }] });
    const json = toJsonExport([], repo.all());
    expect(json.days).toHaveLength(1);
    expect(json.dayCount).toBe(1);
    expect(json.daySymptomVocabulary).toContain('tinnitus');
    expect(json.severityScale).toContain('Moderate');
  });
});

describe('the schema', () => {
  it('refuses an instant where a calendar date belongs', () => {
    expect(() =>
      db
        .prepare("INSERT INTO day_logs (date, created_at, updated_at) VALUES (?, 'a', 'b')")
        .run('2026-07-26T03:14:00Z'),
    ).toThrow();
  });

  it('refuses a severity outside the four steps', () => {
    repo.put('2026-07-26', { symptoms: [{ symptom: 'tinnitus', severity: 1 }] });
    expect(() =>
      db
        .prepare('INSERT INTO day_log_symptoms (date, symptom, severity) VALUES (?, ?, ?)')
        .run('2026-07-26', 'sleep', 9),
    ).toThrow();
  });
});
