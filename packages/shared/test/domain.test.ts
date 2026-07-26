import { describe, expect, it } from 'vitest';
import {
  createFlashSchema,
  durationMinutes,
  intensityWord,
  sketchSchema,
  SYMPTOMS,
  SYMPTOM_LABELS,
} from '../src/index.js';

describe('symptom vocabulary', () => {
  it('labels every symptom', () => {
    for (const s of SYMPTOMS) {
      expect(SYMPTOM_LABELS[s]).toBeTruthy();
    }
  });

  it('has no duplicates', () => {
    expect(new Set(SYMPTOMS).size).toBe(SYMPTOMS.length);
  });
});

describe('durationMinutes', () => {
  it('floors to whole minutes', () => {
    expect(durationMinutes('2026-01-01T00:00:00Z', '2026-01-01T00:14:59Z')).toBe(14);
  });

  it('never returns a negative duration', () => {
    expect(durationMinutes('2026-01-01T01:00:00Z', '2026-01-01T00:00:00Z')).toBe(0);
  });

  it('handles offsets, not just Z', () => {
    expect(durationMinutes('2026-01-01T00:00:00-05:00', '2026-01-01T00:30:00-05:00')).toBe(30);
  });
});

describe('intensityWord', () => {
  it('escalates across the scale', () => {
    expect(intensityWord(1)).toBe('Barely there');
    expect(intensityWord(4)).toBe('Rising');
    expect(intensityWord(7)).toBe('Severe');
    expect(intensityWord(10)).toBe('Overwhelming');
  });
});

describe('createFlashSchema', () => {
  it('accepts an empty body — one tap must be enough to log', () => {
    expect(createFlashSchema.safeParse({}).success).toBe(true);
  });

  it('rejects an out-of-range intensity', () => {
    expect(createFlashSchema.safeParse({ intensity: 11 }).success).toBe(false);
    expect(createFlashSchema.safeParse({ intensity: 0 }).success).toBe(false);
  });

  it('rejects an unknown symptom', () => {
    expect(createFlashSchema.safeParse({ symptoms: ['telepathy'] }).success).toBe(false);
  });

  it('requires a timezone offset on startedAt', () => {
    expect(createFlashSchema.safeParse({ startedAt: '2026-01-01T00:00:00' }).success).toBe(false);
    expect(createFlashSchema.safeParse({ startedAt: '2026-01-01T00:00:00Z' }).success).toBe(true);
  });
});

describe('sketchSchema', () => {
  const stroke = { color: '#b33f66', points: [{ x: 1, y: 2, w: 3 }] };

  it('accepts stroke geometry', () => {
    expect(sketchSchema.safeParse({ width: 300, height: 200, strokes: [stroke] }).success).toBe(
      true,
    );
  });

  it('rejects a sketch with no strokes', () => {
    expect(sketchSchema.safeParse({ width: 300, height: 200, strokes: [] }).success).toBe(false);
  });

  it('rejects a non-hex colour', () => {
    const bad = { ...stroke, color: 'red' };
    expect(sketchSchema.safeParse({ width: 300, height: 200, strokes: [bad] }).success).toBe(false);
  });
});
