// Preview re-encode (look-index "Previews"): header checks first, then one pinned decode and a clean still WebP out.
// It reads bytes and returns bytes; it never writes a file and never throws. Run it only in jobs that hold no secret.

const MAX_BYTES = 96 * 1024;
const MAX_SIDE = 1024;
const MAX_PIXELS = MAX_SIDE * MAX_SIDE;
const QUALITY = 80;

const refuse = (code, message) => ({ ok: false, code, message });

/** Width, height and animation flag from the first chunk, or null when the first chunk is not an image chunk. */
function readHeader(b) {
  if (b.length < 20) return null;
  const fourcc = b.toString('latin1', 12, 16);
  const size = b.readUInt32LE(16);
  const d = 20;
  if (fourcc === 'VP8X' && size >= 10 && b.length >= d + 10) {
    return { width: b.readUIntLE(d + 4, 3) + 1, height: b.readUIntLE(d + 7, 3) + 1, animated: (b[d] & 0x02) !== 0 };
  }
  if (fourcc === 'VP8 ' && b.length >= d + 10) {
    return { width: b.readUInt16LE(d + 6) & 0x3fff, height: b.readUInt16LE(d + 8) & 0x3fff, animated: false };
  }
  if (fourcc === 'VP8L' && b.length >= d + 5 && b[d] === 0x2f) {
    const bits = b.readUInt32LE(d + 1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, animated: false };
  }
  return null;
}

/** Chunk names when every chunk fits the file and the sizes add up to the RIFF size, else null. */
function walk(b) {
  if (b.readUInt32LE(4) + 8 !== b.length) return null;
  const names = [];
  for (let o = 12; o < b.length; ) {
    if (o + 8 > b.length) return null;
    const size = b.readUInt32LE(o + 4);
    const end = o + 8 + size + (size % 2);
    if (end > b.length) return null;
    names.push(b.toString('latin1', o, o + 4));
    o = end;
  }
  return names;
}

/** @param {Uint8Array} input */
export async function reencodePreview(input) {
  try {
    const bytes = Buffer.from(input ?? []);
    if (bytes.length > MAX_BYTES) return refuse('input_too_big', 'The preview is over 96 KiB.');
    if (bytes.length < 12 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') {
      return refuse('not_webp', 'The preview is not a WebP file.');
    }
    const head = readHeader(bytes);
    if (!head) return refuse('malformed', 'The first WebP chunk is not an image header.');
    if (head.animated) return refuse('animated', 'The preview is animated; use a still image.');
    if (head.width < 1 || head.height < 1 || head.width > MAX_SIDE || head.height > MAX_SIDE) {
      return refuse('too_large_side', 'The preview is wider or taller than 1024 px.');
    }
    const names = walk(bytes);
    if (!names) return refuse('malformed', 'The WebP chunk sizes do not match the file.');
    if (names.includes('ANIM') || names.includes('ANMF')) return refuse('animated', 'The preview is animated; use a still image.');

    // Loaded only here so the index and check jobs never load the native decoder.
    const { default: sharp } = await import('sharp');
    let out;
    try {
      out = await sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'warning', animated: false })
        .flatten({ background: '#ffffff' })
        .webp({ quality: QUALITY })
        .toBuffer({ resolveWithObject: true });
    } catch (e) {
      const text = String(e?.message ?? e);
      return /warning/i.test(text)
        ? refuse('decode_warning', 'The decoder reported a warning for this preview.')
        : refuse('malformed', 'The preview could not be decoded as a WebP image.');
    }
    if (out.data.length > MAX_BYTES) return refuse('output_too_big', 'The re-encoded preview is over 96 KiB.');
    if (out.info.width !== head.width || out.info.height !== head.height) {
      return refuse('malformed', 'The re-encoded preview changed size.');
    }
    return { ok: true, bytes: out.data, width: out.info.width, height: out.info.height };
  } catch {
    return refuse('malformed', 'The preview could not be checked.');
  }
}
