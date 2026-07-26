import type { Sketch, Stroke } from '@tempra/shared';

const FINGER_WIDTH = 3.6;

/**
 * Render stroke geometry into a canvas, letterboxed to preserve aspect ratio.
 * Geometry is the stored form, so a sketch drawn on any device re-renders
 * crisply at any size instead of being a fixed raster.
 */
export const renderSketch = (canvas: HTMLCanvasElement, sketch: Sketch, pad = 2): void => {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.offsetWidth || sketch.width;
  const cssH = canvas.offsetHeight || sketch.height;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const scale = Math.min((cssW - pad * 2) / sketch.width, (cssH - pad * 2) / sketch.height);
  const dx = (cssW - sketch.width * scale) / 2;
  const dy = (cssH - sketch.height * scale) / 2;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const stroke of sketch.strokes) {
    ctx.strokeStyle = stroke.color;
    const pts = stroke.points;
    const first = pts[0];
    if (!first) continue;

    if (pts.length === 1) {
      // A single tap should still leave a mark.
      ctx.lineWidth = Math.max(first.w * scale, 0.6);
      ctx.beginPath();
      ctx.moveTo(dx + first.x * scale, dy + first.y * scale);
      ctx.lineTo(dx + first.x * scale + 0.1, dy + first.y * scale + 0.1);
      ctx.stroke();
      continue;
    }

    // Segment-by-segment so pressure variation survives the round trip.
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1];
      const b = pts[i];
      if (!a || !b) continue;
      ctx.lineWidth = Math.max(((a.w + b.w) / 2) * scale, 0.6);
      ctx.beginPath();
      ctx.moveTo(dx + a.x * scale, dy + a.y * scale);
      ctx.lineTo(dx + b.x * scale, dy + b.y * scale);
      ctx.stroke();
    }
  }
};

export class SketchPad {
  private strokes: Stroke[] = [];
  private saved: Stroke[] = [];
  private current: Stroke | null = null;
  private ink = '#B33F66';
  private ctx: CanvasRenderingContext2D | null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onChange: (hasInk: boolean) => void,
  ) {
    this.ctx = canvas.getContext('2d');
    canvas.addEventListener('pointerdown', this.down);
    canvas.addEventListener('pointermove', this.move);
    for (const t of ['pointerup', 'pointercancel', 'pointerleave']) {
      canvas.addEventListener(t, this.stop);
    }
  }

  setInk(color: string): void {
    this.ink = color;
  }

  /**
   * Size the backing store from offsetWidth/Height rather than
   * getBoundingClientRect: while the overlay animates open it carries a
   * transform: scale(), and the rect reports the in-flight size.
   */
  fit(): void {
    const w = this.canvas.offsetWidth;
    const h = this.canvas.offsetHeight;
    if (!w || !h || !this.ctx) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw();
  }

  private at(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const sx = r.width ? this.canvas.offsetWidth / r.width : 1;
    const sy = r.height ? this.canvas.offsetHeight / r.height : 1;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  }

  private width(e: PointerEvent): number {
    // Pressure-capable input varies the stroke; a finger reports 0.5 and gets
    // a steady width instead of a misleadingly uniform "pressure".
    return e.pressure > 0 && e.pressure !== 0.5 ? 2 + e.pressure * 4.5 : FINGER_WIDTH;
  }

  private down = (e: PointerEvent): void => {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.at(e);
    this.current = { color: this.ink, points: [{ ...p, w: this.width(e) }] };
    this.strokes.push(this.current);
    this.redraw();
  };

  private move = (e: PointerEvent): void => {
    if (!this.current) return;
    const p = this.at(e);
    this.current.points.push({ ...p, w: this.width(e) });
    this.redraw();
  };

  private stop = (): void => {
    this.current = null;
  };

  redraw(): void {
    if (!this.ctx) return;
    const w = this.canvas.offsetWidth;
    const h = this.canvas.offsetHeight;
    renderSketch(this.canvas, { width: w, height: h, strokes: this.strokes }, 0);
    this.onChange(this.strokes.length > 0);
  }

  undo(): void {
    this.strokes.pop();
    this.redraw();
  }

  clear(): void {
    this.strokes = [];
    this.redraw();
  }

  /** Snapshot so that Cancel can restore exactly what was there before. */
  snapshot(): void {
    this.saved = this.strokes.map((s) => ({ ...s, points: [...s.points] }));
  }

  restore(): void {
    this.strokes = this.saved;
    this.redraw();
  }

  load(sketch: Sketch | null): void {
    this.strokes = sketch ? sketch.strokes.map((s) => ({ ...s, points: [...s.points] })) : [];
    this.redraw();
  }

  value(): Sketch | null {
    if (!this.strokes.length) return null;
    return {
      width: this.canvas.offsetWidth || 300,
      height: this.canvas.offsetHeight || 400,
      strokes: this.strokes,
    };
  }
}
