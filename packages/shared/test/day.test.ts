import { describe, expect, it } from 'vitest';
import {
  averageSeverity,
  DAY_SYMPTOMS,
  DAY_SYMPTOM_LABELS,
  fromLocalDate,
  isEmptyDayLog,
  localDateOf,
  localDateSchema,
  mostReported,
  patchDayLogSchema,
  putDayLogSchema,
  SEVERITY_LABELS,
  severityWord,
  shiftLocalDate,
  type DayLog,
} from '../src/index.js';

const day = (date: string, symptoms: DayLog['symptoms'], note: string | null = null): DayLog => ({
  date,
  symptoms,
  note,
  createdAt: '2026-07-26T08:00:00.000Z',
  updatedAt: '2026-07-26T08:00:00.000Z',
});

describe('day symptom vocabulary', () => {
  it('labels every symptom', () => {
    for (const s of DAY_SYMPTOMS) expect(DAY_SYMPTOM_LABELS[s]).toBeTruthy();
  });

  it('has no duplicates', () => {
    expect(new Set(DAY_SYMPTOMS).size).toBe(DAY_SYMPTOMS.length);
  });

  it('names every severity, with zero meaning a deliberate "Clear"', () => {
    expect(SEVERITY_LABELS).toHaveLength(4);
    expect(severityWord(0)).toBe('Clear');
    expect(severityWord(3)).toBe('Severe');
  });
});

describe('local dates', () => {
  it('accepts a calendar date and rejects an instant', () => {
    expect(localDateSchema.safeParse('2026-07-26').success).toBe(true);
    expect(localDateSchema.safeParse('2026-07-26T03:14:00Z').success).toBe(false);
    expect(localDateSchema.safeParse('26/07/2026').success).toBe(false);
  });

  it('round-trips through local midnight rather than UTC midnight', () => {
    // Parsing "2026-07-26" as a Date makes it UTC midnight, which is the 25th
    // anywhere west of Greenwich. The whole day band would render on the wrong
    // row for half the world.
    expect(localDateOf(fromLocalDate('2026-07-26'))).toBe('2026-07-26');
  });

  it('steps across month ends', () => {
    expect(shiftLocalDate('2026-08-01', -1)).toBe('2026-07-31');
    expect(shiftLocalDate('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('isEmptyDayLog', () => {
  it('treats a check-in with nothing in it as no check-in at all', () => {
    expect(isEmptyDayLog({ symptoms: [], note: null })).toBe(true);
    expect(isEmptyDayLog({ symptoms: [], note: '   ' })).toBe(true);
  });

  it('keeps a check-in that reports something', () => {
    expect(isEmptyDayLog({ symptoms: [{}], note: null })).toBe(false);
    expect(isEmptyDayLog({ symptoms: [], note: 'ears ringing' })).toBe(false);
  });

  it('keeps a check-in whose only report is Clear', () => {
    // Severity 0 is an observation she made, not an empty answer.
    expect(isEmptyDayLog({ symptoms: [{ symptom: 'tinnitus', severity: 0 }] })).toBe(false);
  });
});

describe('putDayLogSchema', () => {
  it('accepts the whole state of a day', () => {
    const parsed = putDayLogSchema.safeParse({
      symptoms: [{ symptom: 'tinnitus', severity: 2 }],
      note: 'worse in the quiet',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown symptom and an out-of-range severity', () => {
    expect(putDayLogSchema.safeParse({ symptoms: [{ symptom: 'vibes', severity: 1 }] }).success)
      .toBe(false);
    expect(putDayLogSchema.safeParse({ symptoms: [{ symptom: 'tinnitus', severity: 4 }] }).success)
      .toBe(false);
  });
});

describe('patchDayLogSchema', () => {
  it('takes the array the app sends', () => {
    const parsed = patchDayLogSchema.safeParse({
      symptoms: [{ symptom: 'tinnitus', severity: 2 }],
    });
    expect(parsed.success && parsed.data.symptoms).toEqual([{ symptom: 'tinnitus', severity: 2 }]);
  });

  it('takes the plain object a Shortcut can build, and normalises it', () => {
    const parsed = patchDayLogSchema.safeParse({ symptoms: { tinnitus: 2, sleep: 0 } });
    expect(parsed.success && parsed.data.symptoms).toEqual([
      { symptom: 'tinnitus', severity: 2 },
      { symptom: 'sleep', severity: 0 },
    ]);
  });

  it('carries a null through as "unsay this"', () => {
    const parsed = patchDayLogSchema.safeParse({ symptoms: { tinnitus: null } });
    expect(parsed.success && parsed.data.symptoms).toEqual([
      { symptom: 'tinnitus', severity: null },
    ]);
  });

  it('still rejects an unknown symptom in either shape', () => {
    expect(patchDayLogSchema.safeParse({ symptoms: { vibes: 1 } }).success).toBe(false);
    expect(
      patchDayLogSchema.safeParse({ symptoms: [{ symptom: 'vibes', severity: 1 }] }).success,
    ).toBe(false);
  });
});

describe('averageSeverity', () => {
  it('averages only the severities she actually gave', () => {
    // Fatigue is unreported on the second day. Counting it as zero would let
    // silence drag the number down, which is exactly the invention this app
    // refuses elsewhere.
    const avg = averageSeverity([
      day('2026-07-26', [
        { symptom: 'tinnitus', severity: 2 },
        { symptom: 'fatigue', severity: 2 },
      ]),
      day('2026-07-25', [{ symptom: 'tinnitus', severity: 2 }]),
    ]);
    expect(avg).toBe(2);
  });

  it('is null when nothing has been reported', () => {
    expect(averageSeverity([])).toBeNull();
    expect(averageSeverity([day('2026-07-26', [])])).toBeNull();
  });
});

describe('mostReported', () => {
  it('counts days, not severity', () => {
    const commonest = mostReported([
      day('2026-07-26', [
        { symptom: 'tinnitus', severity: 1 },
        { symptom: 'sleep', severity: 3 },
      ]),
      day('2026-07-25', [{ symptom: 'tinnitus', severity: 1 }]),
    ]);
    expect(commonest).toBe('tinnitus');
  });

  it('breaks ties by vocabulary order so the answer is stable', () => {
    const commonest = mostReported([
      day('2026-07-26', [
        { symptom: 'joint_pain', severity: 1 },
        { symptom: 'sleep', severity: 1 },
      ]),
    ]);
    expect(commonest).toBe('sleep');
  });

  it('is null with nothing to count', () => {
    expect(mostReported([])).toBeNull();
  });
});
