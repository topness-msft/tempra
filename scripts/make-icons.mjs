/**
 * Generates the app icons from the Apothecary palette so the repository never
 * has to carry binary art. Run with: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const CREAM = [255, 249, 245];
const BERRY = [179, 63, 102];
const ROSE = [228, 137, 155];
const GOLD = [200, 147, 52];

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.max(0, Math.min(1, t))));

const crc32 = (buf) => {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const png = (size) => {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let p = 0;
  for (let y = 0; y < size; y += 1) {
    raw[p] = 0; // filter: none
    p += 1;
    for (let x = 0; x < size; x += 1) {
      const nx = x / size;
      const ny = y / size;

      // A warmth that rises: berry at the core, gold lifting toward the top.
      const dx = nx - 0.5;
      const dy = ny - 0.54;
      const r = Math.sqrt(dx * dx + dy * dy) / 0.34;

      let colour = CREAM;
      if (r < 1) {
        const t = 1 - r;
        const warm = mix(ROSE, BERRY, Math.pow(t, 0.75));
        const lifted = mix(warm, GOLD, Math.max(0, 0.5 - ny) * 1.5);
        // A crisp shoulder keeps the orb legible at 60px on a home screen;
        // feathering it too softly turned it into a smudge.
        colour = mix(CREAM, lifted, Math.min(1, t * 9));
      }

      // A hairline of gold, the apothecary rule, holding the shape together.
      const ring = Math.abs(r - 1.14);
      if (ring < 0.035) {
        colour = mix(colour, GOLD, (1 - ring / 0.035) * 0.55);
      }

      raw[p] = colour[0];
      raw[p + 1] = colour[1];
      raw[p + 2] = colour[2];
      p += 3;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const outDir = path.resolve(import.meta.dirname, '../packages/web/public');
mkdirSync(outDir, { recursive: true });
for (const size of [180, 192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  writeFileSync(file, png(size));
  console.log(`wrote ${file}`);
}
