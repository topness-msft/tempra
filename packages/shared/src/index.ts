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
