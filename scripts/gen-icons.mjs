// Rasterize public/icon.svg into the PNG sizes the PWA manifest needs.
// Run once after install (and whenever the SVG changes): node scripts/gen-icons.mjs
import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const svg = readFileSync('public/icon.svg');

for (const size of [192, 512]) {
  await sharp(svg, { density: 384 })
    .resize(size, size)
    .png()
    .toFile(`public/icon-${size}.png`);
  console.log(`Wrote public/icon-${size}.png`);
}
