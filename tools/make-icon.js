// Generates build/icon.png (256) and build/icon.ico (16..256) - a dark rounded tile with the widget's gauge.
// Usage: node tools/make-icon.js
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const SS = 4; // supersampling per axis

function shade(u, v) {
  // returns [r,g,b,a] (0..255, a 0..1) for a point in the unit square, or null for transparent
  const R = 0.22, dx = Math.max(R - u, u - (1 - R), 0), dy = Math.max(R - v, v - (1 - R), 0);
  if (dx * dx + dy * dy > R * R) return null;
  const cx = 0.5, cy = 0.64;
  // hub
  if ((u - cx) ** 2 + (v - cy) ** 2 < 0.05 ** 2) return [232, 234, 240, 1];
  // needle at t = 0.70 of the sweep (left = 0, right = 1)
  const ang = Math.PI * (1 - 0.70), nx = cx + 0.27 * Math.cos(ang), ny = cy - 0.27 * Math.sin(ang);
  const px = u - cx, py = v - cy, ex = nx - cx, ey = ny - cy, t = Math.max(0, Math.min(1, (px * ex + py * ey) / (ex * ex + ey * ey)));
  if (Math.hypot(px - ex * t, py - ey * t) < 0.026 * (1 - 0.35 * t)) return [232, 234, 240, 1];
  // arc
  const r = Math.hypot(px, py), a = Math.atan2(-py, px); // 0..PI on the upper half
  if (r > 0.30 - 0.045 && r < 0.30 + 0.045 && a > -0.05 && a < Math.PI + 0.05) {
    const f = 1 - Math.max(0, Math.min(Math.PI, a)) / Math.PI;
    return f < 0.6 ? [34, 197, 94, 1] : f < 0.85 ? [250, 204, 21, 1] : [239, 68, 68, 1];
  }
  // tile background: subtle vertical gradient
  const g = 36 - 14 * v;
  return [g, g + 2, g + 8, 1];
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const c = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
    }
    const i = (y * size + x) * 4, n = SS * SS;
    if (a) { buf[i] = Math.round(r / a); buf[i + 1] = Math.round(g / a); buf[i + 2] = Math.round(b / a); buf[i + 3] = Math.round(255 * a / n); }
  }
  return buf;
}

const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = b => { let c = -1; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const rgba = render(size), raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256], pngs = sizes.map(png);
const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16); e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12); offset += pngs[i].length; return e;
});
const out = path.join(__dirname, '..', 'build');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([head, ...entries, ...pngs]));
fs.writeFileSync(path.join(out, 'icon.png'), pngs[sizes.indexOf(256)]);
console.log('written', path.join(out, 'icon.ico'), Buffer.concat(pngs).length, 'bytes of png data');
