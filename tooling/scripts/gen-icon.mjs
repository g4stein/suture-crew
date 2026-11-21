#!/usr/bin/env node
// Generates assets/icon.png: an opaque 512×512 truecolor PNG (colour type 2, no alpha channel), drawn from Suture's
// palette: an obsidian tile, a crimson incision, and cyan surgical stitches closing it, with an emerald "verified" pip.
// Node standard library only. The output is deterministic, so CI can regenerate it and compare bytes.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

export const SIZE = 512;
const SS = 4; // supersampling per axis, for anti-aliased edges

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const PALETTE = {
  obsidian: hex('#090B10'),
  panel: hex('#10141D'),
  rim: hex('#171C28'),
  cyan: hex('#06B6D4'),
  emerald: hex('#10B981'),
  crimson: hex('#F43F5E'),
};

/** Signed distance to a rounded rectangle centred at (cx, cy). */
function roundedRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance from (x, y) to the segment a-b. */
function segment(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

// The incision runs corner to corner; stitches cross it at right angles.
const A = [138, 374];
const B = [374, 138];
const ux = (B[0] - A[0]) / Math.hypot(B[0] - A[0], B[1] - A[1]);
const uy = (B[1] - A[1]) / Math.hypot(B[0] - A[0], B[1] - A[1]);
const nx = -uy;
const ny = ux;
const STITCHES = [0.14, 0.32, 0.5, 0.68, 0.86].map((t) => {
  const cx = A[0] + t * (B[0] - A[0]);
  const cy = A[1] + t * (B[1] - A[1]);
  return [cx - 46 * nx, cy - 46 * ny, cx + 46 * nx, cy + 46 * ny];
});

/** The colour of one sample point. */
function shade(x, y) {
  let c = PALETTE.obsidian;
  const tile = roundedRect(x, y, 256, 256, 212, 212, 72);
  if (tile < 0) c = PALETTE.rim;
  if (tile < -10) c = PALETTE.panel;
  if (segment(x, y, A[0], A[1], B[0], B[1]) < 13) c = PALETTE.crimson;
  for (const [ax, ay, bx, by] of STITCHES) if (segment(x, y, ax, ay, bx, by) < 9) c = PALETTE.cyan;
  for (const [ax, ay, bx, by] of STITCHES) {
    if (Math.hypot(x - ax, y - ay) < 12 || Math.hypot(x - bx, y - by) < 12) c = PALETTE.cyan;
  }
  if (Math.hypot(x - 392, y - 392) < 30) c = PALETTE.emerald;
  return c;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Renders the icon and returns the PNG bytes. */
export function renderIcon() {
  const row = 1 + SIZE * 3;
  const raw = Buffer.alloc(row * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * row] = 0; // filter type: none
    for (let x = 0; x < SIZE; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const n = SS * SS;
      const o = y * row + 1 + x * 3;
      raw[o] = Math.round(r / n);
      raw[o + 1] = Math.round(g / n);
      raw[o + 2] = Math.round(b / n);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2: truecolor, no alpha
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'icon.png');
  writeFileSync(out, renderIcon());
  console.log(`wrote ${out}`);
}
