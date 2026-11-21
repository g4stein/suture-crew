// assets/icon.png: a valid, opaque 512×512 PNG, byte-for-byte what tooling/scripts/gen-icon.mjs draws (pixels compared,
// so a different zlib build cannot fail the test).
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, PALETTE, renderIcon, SIZE } from '../scripts/gen-icon.mjs';
import { at } from './helpers.ts';

interface Png {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly interlace: number;
  readonly chunks: ReadonlyArray<string>;
  readonly pixels: Buffer; // filtered scanlines, as stored
}

function parsePng(buf: Buffer): Png {
  expect([...buf.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let off = 8;
  const chunks: string[] = [];
  const idat: Buffer[] = [];
  let ihdr: Buffer | null = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const crc = buf.readUInt32BE(off + 8 + len);
    expect(crc32(buf.subarray(off + 4, off + 8 + len)), `${type} CRC`).toBe(crc);
    chunks.push(type);
    if (type === 'IHDR') ihdr = Buffer.from(data);
    if (type === 'IDAT') idat.push(Buffer.from(data));
    off += 12 + len;
  }
  if (ihdr === null) throw new Error('no IHDR');
  return {
    width: ihdr.readUInt32BE(0),
    height: ihdr.readUInt32BE(4),
    bitDepth: ihdr[8] ?? -1,
    colorType: ihdr[9] ?? -1,
    interlace: ihdr[12] ?? -1,
    chunks,
    pixels: inflateSync(Buffer.concat(idat)),
  };
}

describe('assets/icon.png', () => {
  const file = readFileSync(at('assets', 'icon.png'));
  const png = parsePng(file);

  it('is a well-formed PNG with IHDR first and IEND last', () => {
    expect(png.chunks[0]).toBe('IHDR');
    expect(png.chunks[png.chunks.length - 1]).toBe('IEND');
    expect(png.chunks).toContain('IDAT');
  });

  it('is exactly 512×512, 8-bit, non-interlaced', () => {
    expect([png.width, png.height, SIZE]).toEqual([512, 512, 512]);
    expect(png.bitDepth).toBe(8);
    expect(png.interlace).toBe(0);
  });

  it('is opaque: truecolor with no alpha channel and no transparency chunk', () => {
    expect(png.colorType).toBe(2);
    expect(png.chunks).not.toContain('tRNS');
    expect(png.pixels.length).toBe(SIZE * (1 + SIZE * 3));
  });

  it('matches the generator pixel for pixel', () => {
    expect(parsePng(renderIcon()).pixels.equals(png.pixels)).toBe(true);
  });

  it('uses the Suture palette: obsidian corners, crimson incision, cyan stitches, emerald pip', () => {
    const px = (x: number, y: number): number[] => {
      const o = y * (1 + SIZE * 3) + 1 + x * 3;
      return [png.pixels[o] ?? -1, png.pixels[o + 1] ?? -1, png.pixels[o + 2] ?? -1];
    };
    expect(px(2, 2)).toEqual(PALETTE.obsidian);
    expect(px(392, 392)).toEqual(PALETTE.emerald);
    expect(px(256, 256)).toEqual(PALETTE.cyan); // the middle stitch crosses the centre
    expect(px(277, 235)).toEqual(PALETTE.crimson); // on the incision, between two stitches
  });
});
