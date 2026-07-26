import {
  DAY_SYMPTOMS,
  SEVERITY_LABELS,
  SYMPTOMS,
  severityWord,
  type DayLog,
  type Flash,
} from '@tempra/shared';

/**
 * Excel turns a leading =, +, - or @ into a formula. Exported notes are free
 * text written at 3am, so neutralise the cell rather than trusting it.
 */
const escapeCell = (value: string): string => {
  const risky = /^[=+\-@\t\r]/.test(value);
  const body = risky ? `'${value}` : value;
  return `"${body.replace(/"/g, '""')}"`;
};

const cell = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return '';
  return escapeCell(String(value));
};

export const CSV_COLUMNS = [
  'id',
  'started_local',
  'started_utc',
  'ended_local',
  'ended_utc',
  'duration_min',
  'intensity',
  'symptoms',
  'note',
  'has_sketch',
  'status',
  'source',
] as const;

export const toCsv = (flashes: readonly Flash[]): string => {
  const lines = [CSV_COLUMNS.join(',')];
  for (const f of flashes) {
    lines.push(
      [
        cell(f.id),
        cell(f.startedAt),
        cell(new Date(f.startedAt).toISOString()),
        cell(f.endedAt),
        cell(f.endedAt ? new Date(f.endedAt).toISOString() : null),
        cell(f.durationMin),
        cell(f.intensity),
        cell(f.symptoms.join('; ')),
        cell(f.note),
        cell(f.sketch ? 'yes' : 'no'),
        cell(f.status),
        cell(f.source),
      ].join(','),
    );
  }
  // A trailing newline keeps the file POSIX-clean and stops spreadsheets from
  // dropping the last row on some importers.
  return `${lines.join('\r\n')}\r\n`;
};

export interface JsonExport {
  app: 'tempra';
  version: 2;
  exportedAt: string;
  symptomVocabulary: readonly string[];
  daySymptomVocabulary: readonly string[];
  severityScale: readonly string[];
  count: number;
  dayCount: number;
  flashes: readonly Flash[];
  days: readonly DayLog[];
}

export const toJsonExport = (
  flashes: readonly Flash[],
  days: readonly DayLog[],
): JsonExport => ({
  app: 'tempra',
  version: 2,
  exportedAt: new Date().toISOString(),
  // Shipping the vocabularies makes the export self-describing years from now:
  // a file opened in 2031 still explains what `brain_fog` meant and what the
  // four severities were.
  symptomVocabulary: SYMPTOMS,
  daySymptomVocabulary: DAY_SYMPTOMS,
  severityScale: SEVERITY_LABELS,
  count: flashes.length,
  dayCount: days.length,
  flashes,
  days,
});

/**
 * Day check-ins get their own file rather than extra columns on the flash CSV.
 * The two records share almost nothing — a day has no start, end, duration or
 * sketch, and a flash has no severity per symptom — so a merged table would be
 * half empty on every row and unreadable in Numbers.
 */
export const DAY_CSV_COLUMNS = ['date', ...DAY_SYMPTOMS, 'note'] as const;

export const toDaysCsv = (days: readonly DayLog[]): string => {
  const lines = [DAY_CSV_COLUMNS.join(',')];
  for (const day of days) {
    const byName = new Map(day.symptoms.map((s) => [s.symptom, s.severity]));
    lines.push(
      [
        cell(day.date),
        // The word, not the number. This file is what gets handed to a doctor,
        // and "moderate" needs no legend where "2" does. The JSON export keeps
        // the numbers for anything that wants to compute with them.
        //
        // An empty cell means she never reported that symptom, which is not the
        // same as reporting there was none — that is the word "None".
        ...DAY_SYMPTOMS.map((s) => {
          const severity = byName.get(s);
          return severity === undefined ? '' : cell(severityWord(severity));
        }),
        cell(day.note),
      ].join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
};
