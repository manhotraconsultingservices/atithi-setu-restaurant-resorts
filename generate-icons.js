/**
 * PWA icon generator — pure Node.js (no deps required)
 * Generates solid-color PNG icons for the Atithi Setu PWA.
 * Brand saffron: #cc5a16 = rgb(204, 90, 22)
 */
import { deflateSync } from 'zlib';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));

// CRC32 (PNG requires this on every chunk)
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const tb = Buffer.from(type, 'ascii');
  const lb = Buffer.alloc(4); lb.writeUInt32BE(data.length, 0);
  const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([lb, tb, data, cb]);
}

function solidPng(w, h, r, g, b) {
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

  // Raw image: filter-byte(0) + RGB per pixel, per row
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const rs = y * (1 + w * 3);
    raw[rs] = 0; // no filter
    for (let x = 0; x < w; x++) {
      const i = rs + 1 + x * 3;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
    }
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Brand saffron #cc5a16
const R = 0xcc, G = 0x5a, B = 0x16;

const publicDir = join(__dirname, 'public');

const icons = [
  { name: 'icon-192x192.png',    w: 192, h: 192 },
  { name: 'icon-512x512.png',    w: 512, h: 512 },
  { name: 'apple-touch-icon.png', w: 180, h: 180 },
  { name: 'maskable-icon.png',   w: 512, h: 512 },
];

for (const { name, w, h } of icons) {
  const dest = join(publicDir, name);
  writeFileSync(dest, solidPng(w, h, R, G, B));
  console.log(`Generated: ${name} (${w}×${h})`);
}
console.log('Done.');
