// generate-icons.js
// Generates icon-192.png and icon-512.png using only Node.js built-ins.
// Run once with: node generate-icons.js
// Produces a green (#16a34a) icon with a white grass/leaf icon.

const fs   = require('fs');
const zlib = require('zlib');

function generateIcon(size) {
  const bg = { r: 0x16, g: 0xa3, b: 0x4a }; // #16a34a green
  const fg = { r: 0xff, g: 0xff, b: 0xff }; // white

  const pixels = new Uint8Array(size * size * 4);

  function setPixel(x, y, color, alpha = 255) {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const i = (y * size + x) * 4;
    pixels[i]     = color.r;
    pixels[i + 1] = color.g;
    pixels[i + 2] = color.b;
    pixels[i + 3] = alpha;
  }

  // Fill background
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      setPixel(x, y, bg);

  const cx = size / 2;
  const cy = size / 2;
  const thick = Math.max(2, Math.round(size * 0.055));

  function drawThickLine(ax, ay, bx, by, t, color) {
    const len = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
    if (len === 0) return;
    const nx = -(by - ay) / len;
    const ny =  (bx - ax) / len;
    const steps = Math.ceil(len * 2);
    for (let s = 0; s <= steps; s++) {
      const frac = s / steps;
      const px = ax + (bx - ax) * frac;
      const py = ay + (by - ay) * frac;
      for (let o = -t; o <= t; o++)
        setPixel(Math.round(px + nx * o), Math.round(py + ny * o), color);
    }
  }

  // Draw a simple leaf/grass shape: three blades radiating up from center-bottom
  const base  = cy + size * 0.25;
  const tipH  = size * 0.30;
  const spread = size * 0.18;

  // Center blade (straight up)
  drawThickLine(cx, base, cx, cy - tipH, thick, fg);

  // Left blade (angled)
  drawThickLine(cx, base, cx - spread, cy - tipH * 0.7, thick, fg);

  // Right blade (angled)
  drawThickLine(cx, base, cx + spread, cy - tipH * 0.7, thick, fg);

  // Ground line
  const groundY = base + thick * 1.5;
  const groundW = size * 0.35;
  drawThickLine(cx - groundW, groundY, cx + groundW, groundY, thick, fg);

  return pixels;
}

// ── PNG encoding (pure Node.js, no npm) ──────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u32(n) {
  return Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function chunk(type, data) {
  const t   = Buffer.from(type, 'ascii');
  const d   = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const crc = crc32(Buffer.concat([t, d]));
  return Buffer.concat([u32(d.length), t, d, u32(crc)]);
}

function encodePNG(pixels, size) {
  const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = chunk('IHDR', Buffer.concat([u32(size), u32(size), Buffer.from([8, 6, 0, 0, 0])]));

  const raw = [];
  for (let y = 0; y < size; y++) {
    raw.push(0); // filter type None
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      raw.push(pixels[i], pixels[i+1], pixels[i+2], pixels[i+3]);
    }
  }

  const idat = chunk('IDAT', zlib.deflateSync(Buffer.from(raw), { level: 6 }));
  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

// ── Write icons ───────────────────────────────────────────────────────────────

for (const size of [192, 512]) {
  const filename = `icon-${size}.png`;
  fs.writeFileSync(filename, encodePNG(generateIcon(size), size));
  console.log(`Created ${filename}`);
}

console.log('Done. Open the PNG files to verify before deploying.');
