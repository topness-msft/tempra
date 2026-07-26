/**
 * Generates every Tempra icon from a single vector source.
 *
 * The mark is "Struck": a berry disc with the flame knocked out in cream and a
 * gold ring around it. Two shapes, not three, which is the only reason it still
 * reads at 16px where the earlier flame-inside-a-ring versions turned to fuzz.
 *
 * At 16px the gold ring is thinner than a device pixel and renders as a muddy
 * halo, so the favicon's smallest frame drops it. That is the sole difference
 * between the two variants below.
 *
 * Run: node ops/make-icons.mjs   (needs @playwright/test's chromium for raster)
 */
import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'web', 'public');
mkdirSync(OUT, { recursive: true });

const CREAM = '#FFF9F5';
const GOLD = '#C79A3E';

// Leaning flame: tall inner tongue, a shorter one folded in at the left, and an
// asymmetric tip. The asymmetry is load-bearing — a symmetric version of this
// silhouette reads as a water droplet, which is the opposite of the point.
const FLAME =
  'M17.4 3.2 C 18.4 8.4, 23.4 10.8, 23.4 17.0 A 7.4 7.4 0 0 1 8.6 17.0 ' +
  'C 8.6 12.6, 12.0 10.6, 13.2 6.4 C 14.4 8.8, 15.6 8.2, 17.4 3.2 Z';

const flame = (scale, fill = CREAM) =>
  `<g transform="translate(16,16) scale(${scale}) translate(-16,-16)">` +
  `<path d="${FLAME}" fill="${fill}"/></g>`;

/**
 * @param {object} o
 * @param {boolean} o.ring  draw the gold ring (dropped at 16px)
 * @param {number}  o.mark  overall scale of the mark, 1 = fills the tile.
 *                          Maskable icons need everything inside a centred
 *                          circle of 80% diameter, so they pass a smaller value.
 */
const svg = ({ ring = true, mark = 1 } = {}) => {
  const r = 13.6 * mark;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <defs>
    <radialGradient id="disc" cx="38%" cy="30%" r="78%">
      <stop offset="0%" stop-color="#C74F76"/>
      <stop offset="100%" stop-color="#9E3159"/>
    </radialGradient>
  </defs>
  <rect width="32" height="32" fill="${CREAM}"/>
  <circle cx="16" cy="16" r="${r.toFixed(2)}" fill="url(#disc)"/>
  ${ring ? `<circle cx="16" cy="16" r="${r.toFixed(2)}" fill="none" stroke="${GOLD}" stroke-width="${(1.5 * mark).toFixed(2)}"/>` : ''}
  ${flame(0.8 * mark)}
</svg>`;
};

const FULL = svg();
const NO_RING = svg({ ring: false });
const MASKABLE = svg({ mark: 0.84 });

writeFileSync(join(OUT, 'favicon.svg'), FULL);
console.log('wrote favicon.svg');

const browser = await chromium.launch();

/** Rasterise an SVG string at an exact pixel size. */
async function png(source, size) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:${CREAM}}svg{display:block;width:${size}px;height:${size}px}</style>${source}`,
  );
  const buf = await page.screenshot({ omitBackground: false });
  await page.close();
  return buf;
}

for (const [name, source, size] of [
  ['icon-180.png', FULL, 180],
  ['icon-192.png', FULL, 192],
  ['icon-512.png', FULL, 512],
  ['icon-512-maskable.png', MASKABLE, 512],
]) {
  writeFileSync(join(OUT, name), await png(source, size));
  console.log('wrote', name);
}

// --- favicon.ico -----------------------------------------------------------
// An ICO is a tiny directory of images. Modern browsers accept PNG payloads
// inside it, so we skip BMP encoding entirely and just pack the PNGs.
const frames = [
  { size: 16, buf: await png(NO_RING, 16) }, // ring dropped: see note at top
  { size: 32, buf: await png(FULL, 32) },
  { size: 48, buf: await png(FULL, 48) },
];

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type 1 = icon
header.writeUInt16LE(frames.length, 4);

let offset = 6 + frames.length * 16;
const entries = [];
for (const f of frames) {
  const e = Buffer.alloc(16);
  e.writeUInt8(f.size === 256 ? 0 : f.size, 0); // width  (0 means 256)
  e.writeUInt8(f.size === 256 ? 0 : f.size, 1); // height
  e.writeUInt8(0, 2); // palette count
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // colour planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(f.buf.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += f.buf.length;
  entries.push(e);
}

writeFileSync(
  join(OUT, 'favicon.ico'),
  Buffer.concat([header, ...entries, ...frames.map((f) => f.buf)]),
);
console.log('wrote favicon.ico', frames.map((f) => f.size).join('/'));

await browser.close();
