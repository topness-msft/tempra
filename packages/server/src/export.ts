import { SYMPTOMS, type Flash } from '@tempra/shared';

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
  version: 1;
  exportedAt: string;
  symptomVocabulary: readonly string[];
  count: number;
  flashes: readonly Flash[];
}

export const toJsonExport = (flashes: readonly Flash[]): JsonExport => ({
  app: 'tempra',
  version: 1,
  exportedAt: new Date().toISOString(),
  // Shipping the vocabulary makes the export self-describing years from now.
  symptomVocabulary: SYMPTOMS,
  count: flashes.length,
  flashes,
});
