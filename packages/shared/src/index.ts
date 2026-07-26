import { z } from 'zod';

/**
 * Canonical symptom vocabulary. Order is the display order in the tile grid;
 * the first six are shown by default and the rest live behind "more".
 */
export const SYMPTOMS = [
  'sweating',
  'chills',
  'palpitations',
  'anxiety',
  'flushing',
  'mood',
  'nausea',
  'dizziness',
  'headache',
] as const;

export type Symptom = (typeof SYMPTOMS)[number];

export const SYMPTOM_LABELS: Record<Symptom, string> = {
  sweating: 'Sweating',
  chills: 'Chills',
  palpitations: 'Palpitations',
  anxiety: 'Anxiety',
  flushing: 'Flushing',
  mood: 'Mood change',
  nausea: 'Nausea',
  dizziness: 'Dizziness',
  headache: 'Headache',
};

/**
 * `active`     — running now. At most one flash may hold this status.
 * `ended`      — the user deliberately closed it; ended_at and duration are set.
 * `superseded` — auto-closed because a newer flash started. ended_at and
 *                duration stay NULL: auto-closing never fabricates a duration.
 */
export const FLASH_STATUS = ['active', 'ended', 'superseded'] as const;
export type FlashStatus = (typeof FLASH_STATUS)[number];

export const FLASH_SOURCE = ['app', 'shortcut', 'homekit'] as const;
export type FlashSource = (typeof FLASH_SOURCE)[number];

export const symptomSchema = z.enum(SYMPTOMS);
export const intensitySchema = z.number().int().min(1).max(10);
export const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .describe('ISO-8601 with offset or Z');

export const strokePointSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
});

export const strokeSchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  points: z.array(strokePointSchema).min(1),
});

/**
 * Stroke geometry is the source of truth for a sketch, not a raster. It
 * re-renders crisply at any size; PNG is derived only at export time.
 */
export const sketchSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  strokes: z.array(strokeSchema).min(1),
});

export type Sketch = z.infer<typeof sketchSchema>;
export type Stroke = z.infer<typeof strokeSchema>;

export const flashSchema = z.object({
  id: z.string().uuid(),
  startedAt: isoDateTimeSchema,
  endedAt: isoDateTimeSchema.nullable(),
  durationMin: z.number().int().nonnegative().nullable(),
  intensity: intensitySchema.nullable(),
  symptoms: z.array(symptomSchema),
  note: z.string().max(2000).nullable(),
  sketch: sketchSchema.nullable(),
  status: z.enum(FLASH_STATUS),
  source: z.enum(FLASH_SOURCE),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type Flash = z.infer<typeof flashSchema>;

export const createFlashSchema = z.object({
  startedAt: isoDateTimeSchema.optional(),
  intensity: intensitySchema.nullish(),
  symptoms: z.array(symptomSchema).max(SYMPTOMS.length).optional(),
  note: z.string().max(2000).nullish(),
  sketch: sketchSchema.nullish(),
  source: z.enum(FLASH_SOURCE).optional(),
  clientId: z.string().min(1).max(128).optional(),
});

export type CreateFlashInput = z.infer<typeof createFlashSchema>;

/**
 * `endedAt: null` closes a flash without an end time — she slept through it and
 * when it stopped is unknowable. Omitting the field means "ended just now".
 */
export const endFlashSchema = z.object({
  endedAt: isoDateTimeSchema.nullish(),
});

export const updateFlashSchema = z.object({
  intensity: intensitySchema.nullish(),
  symptoms: z.array(symptomSchema).optional(),
  note: z.string().max(2000).nullish(),
  sketch: sketchSchema.nullish(),
});

/**
 * The other half of menopause: symptoms that are not episodes.
 *
 * A flash starts at a knowable moment. Tinnitus does not — it was there on
 * waking and it is still there now. Asking when it began produces an invented
 * answer, so these are recorded as the state of a *day* rather than as events
 * with a fabricated start, end and duration.
 *
 * Order is display order; the first six are shown by default and the rest live
 * behind "more". The vocabulary is deliberately separate from the flash one:
 * `headache` during a flash and `headache` all Tuesday are different
 * observations and must not be averaged together.
 */
export const DAY_SYMPTOMS = [
  'sleep',
  'fatigue',
  'brain_fog',
  'low_mood',
  'tinnitus',
  'joint_pain',
  'anxiety',
  'headache',
  'dryness',
  'skin',
] as const;

export type DaySymptom = (typeof DAY_SYMPTOMS)[number];

export const DAY_SYMPTOM_LABELS: Record<DaySymptom, string> = {
  // "Broken sleep", not "Sleep": with a none-to-severe scale, "Sleep: severe"
  // has to mean severely disrupted, and the label is what makes that obvious.
  sleep: 'Broken sleep',
  fatigue: 'Fatigue',
  brain_fog: 'Brain fog',
  low_mood: 'Low mood',
  tinnitus: 'Tinnitus',
  joint_pain: 'Joint pain',
  anxiety: 'Anxiety',
  headache: 'Headache',
  dryness: 'Dryness',
  skin: 'Skin crawling',
};

/**
 * Four steps, not ten. She is estimating either way, and a ten-point scale
 * invites a precision that is not there — as well as making each target too
 * small to hit. `0` is "None", which is a real observation she tapped; a
 * symptom she never touched is simply absent, and absent is not zero.
 */
export const SEVERITY_LABELS = ['None', 'Mild', 'Moderate', 'Severe'] as const;
export type Severity = 0 | 1 | 2 | 3;

export const severityWord = (severity: number): string =>
  SEVERITY_LABELS[severity] ?? String(severity);

export const daySymptomSchema = z.enum(DAY_SYMPTOMS);
export const severitySchema = z.number().int().min(0).max(3);

/**
 * A local calendar date, YYYY-MM-DD. Deliberately not an instant: a day
 * check-in belongs to the day she lived, not to a moment inside it, and
 * converting it through UTC would slide it across midnight for half the world.
 */
export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('local calendar date, YYYY-MM-DD');

export const daySymptomEntrySchema = z.object({
  symptom: daySymptomSchema,
  severity: severitySchema,
});

export type DaySymptomEntry = z.infer<typeof daySymptomEntrySchema>;

export const dayLogSchema = z.object({
  date: localDateSchema,
  symptoms: z.array(daySymptomEntrySchema),
  note: z.string().max(2000).nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type DayLog = z.infer<typeof dayLogSchema>;

/**
 * The whole state of a day. `symptoms` replaces the set outright, which is what
 * makes the write an upsert keyed on the date — and therefore safe to replay
 * from the offline outbox as many times as it takes, with no client id and no
 * risk of a duplicate check-in.
 */
export const putDayLogSchema = z.object({
  symptoms: z.array(daySymptomEntrySchema).max(DAY_SYMPTOMS.length),
  note: z.string().max(2000).nullish(),
});

export type PutDayLogInput = z.infer<typeof putDayLogSchema>;

/**
 * Merge a few symptoms into a day without touching the rest. This is the Siri
 * path: "log tinnitus" knows one thing and must not wipe what the app recorded
 * this morning.
 *
 * `symptoms` is accepted in two shapes. The app sends the same array it sends
 * to PUT; a shortcut sends a plain `{ "tinnitus": 2 }` object, because that is
 * the only shape the iOS Shortcuts body editor can build without contortions.
 * The object form also allows `null`, meaning "take this back to unrecorded",
 * which the array form has no way to say.
 */
const patchEntrySchema = z.object({
  symptom: daySymptomSchema,
  severity: severitySchema.nullable(),
});

export const patchDayLogSchema = z.object({
  symptoms: z
    .union([
      z.array(patchEntrySchema).max(DAY_SYMPTOMS.length),
      z
        .record(daySymptomSchema, severitySchema.nullable())
        .transform((map) =>
          Object.entries(map).map(([symptom, severity]) => ({
            symptom: symptom as DaySymptom,
            severity: (severity ?? null) as Severity | null,
          })),
        ),
    ])
    .optional(),
  note: z.string().max(2000).nullish(),
});

export type PatchDayLogInput = z.infer<typeof patchDayLogSchema>;
export type PatchDaySymptomEntry = z.infer<typeof patchEntrySchema>;

/** The local calendar date an instant falls on, as seen from this device. */
export const localDateOf = (date: Date = new Date()): string => {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** Midnight local time on a YYYY-MM-DD, for formatting. Never parse it as UTC. */
export const fromLocalDate = (date: string): Date => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
};

/** Shift a local date by whole days without tripping over DST or month ends. */
export const shiftLocalDate = (date: string, days: number): string => {
  const d = fromLocalDate(date);
  d.setDate(d.getDate() + days);
  return localDateOf(d);
};

/**
 * A check-in with nothing in it is not a check-in. Reporting no symptoms and
 * writing no note leaves no record, so history can say "no check-in for this
 * day" rather than showing a blank one that reads as "nothing was wrong".
 */
export const isEmptyDayLog = (input: { symptoms: readonly unknown[]; note?: string | null }): boolean =>
  input.symptoms.length === 0 && !input.note?.trim();

/**
 * Mean of the severities she actually gave. Symptoms she never mentioned are
 * absent from the average rather than counted as zero — silence is not a score.
 * A tapped "none" *is* counted, because it is an answer: a week of quiet days
 * should pull this number down, and it is the one place the zeroes are visible.
 */
export const averageSeverity = (logs: readonly DayLog[]): number | null => {
  const all = logs.flatMap((d) => d.symptoms.map((s) => s.severity));
  if (all.length === 0) return null;
  return all.reduce((a, b) => a + b, 0) / all.length;
};

/**
 * The day symptom troubling her on the most days, ties broken by vocabulary
 * order. A severity of none does not count: answering "no joint pain" every
 * morning is diligence, and it should not make joint pain look like the thing
 * she suffers from most. Same rule the history bands follow.
 */
export const mostReported = (logs: readonly DayLog[]): DaySymptom | null => {
  const counts = new Map<DaySymptom, number>();
  for (const log of logs) {
    for (const s of log.symptoms) {
      if (s.severity > 0) counts.set(s.symptom, (counts.get(s.symptom) ?? 0) + 1);
    }
  }
  let best: DaySymptom | null = null;
  let bestCount = 0;
  for (const symptom of DAY_SYMPTOMS) {
    const n = counts.get(symptom) ?? 0;
    if (n > bestCount) {
      best = symptom;
      bestCount = n;
    }
  }
  return best;
};

export const intensityWord = (intensity: number): string => {
  if (intensity <= 2) return 'Barely there';
  if (intensity <= 5) return 'Rising';
  if (intensity <= 8) return 'Severe';
  return 'Overwhelming';
};

/** Whole minutes between two instants, floored, never negative. */
export const durationMinutes = (startedAt: string, endedAt: string): number => {
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  return Math.max(0, Math.floor(ms / 60000));
};
