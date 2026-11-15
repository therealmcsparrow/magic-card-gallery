// Test helpers: read WebP structure without any decoder, so the tests do not trust the code under test.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(FIXTURES, '..', '..');
export const preview = (name) => fs.readFileSync(path.join(FIXTURES, 'previews', name));

/** Chunks of a RIFF/WEBP file: [{ fourcc, size, data }]. Throws on a structure error. */
export function chunksOf(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') throw new Error('not RIFF/WEBP');
  if (buf.readUInt32LE(4) + 8 !== buf.length) throw new Error('RIFF size does not match the file');
  const out = [];
  for (let o = 12; o < buf.length; ) {
    const size = buf.readUInt32LE(o + 4);
    out.push({ fourcc: buf.toString('latin1', o, o + 4), size, data: buf.subarray(o + 8, o + 8 + size) });
    o += 8 + size + (size % 2);
  }
  return out;
}

/** Pixel size from the first image or VP8X chunk. */
export function sizeOf(buf) {
  const [first] = chunksOf(buf);
  if (first.fourcc === 'VP8X') return { width: first.data.readUIntLE(4, 3) + 1, height: first.data.readUIntLE(7, 3) + 1 };
  if (first.fourcc === 'VP8 ') return { width: first.data.readUInt16LE(6) & 0x3fff, height: first.data.readUInt16LE(8) & 0x3fff };
  if (first.fourcc === 'VP8L') {
    const bits = first.data.readUInt32LE(1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  throw new Error('no size chunk: ' + first.fourcc);
}

/** A well-formed WebP with an extra chunk after the image data, used to build oversize inputs. */
export function withExtraChunk(buf, fourcc, bytes) {
  const hd = Buffer.alloc(8);
  hd.write(fourcc, 0, 'latin1');
  hd.writeUInt32LE(bytes.length, 4);
  const pad = bytes.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  const out = Buffer.concat([buf, hd, Buffer.from(bytes), pad]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}
