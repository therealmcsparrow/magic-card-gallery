// look-index "Previews": scripts/reencode-preview.mjs#reencodePreview(bytes)
// resolves { ok: true, bytes, width, height } or { ok: false, code, message } and never throws.
// Failure codes: not_webp, input_too_big, too_large_side, animated, malformed, decode_warning, output_too_big.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { reencodePreview } from '../scripts/reencode-preview.mjs';
import { REPO, preview, chunksOf, sizeOf, withExtraChunk } from './fixtures/webp-tools.mjs';

const MAX = 96 * 1024;
const FORBIDDEN = ['EXIF', 'XMP ', 'ICCP', 'ANIM', 'ANMF'];

function assertCleanStill(out, input) {
  const chunks = chunksOf(out);
  for (const c of chunks) assert.ok(!FORBIDDEN.includes(c.fourcc), `output has a ${c.fourcc} chunk`);
  if (chunks[0].fourcc === 'VP8X') {
    const flags = chunks[0].data[0];
    assert.equal(flags & (0x20 | 0x08 | 0x04 | 0x02), 0, 'VP8X flags announce ICC, EXIF, XMP or animation');
  }
  assert.ok(chunks.some((c) => ['VP8 ', 'VP8L'].includes(c.fourcc)), 'one still image chunk');
  assert.ok(out.length <= MAX, 'output at most 96 KiB');
  assert.deepEqual(sizeOf(out), sizeOf(input), 'same width and height as the input');
  assert.notDeepEqual(Buffer.from(out), Buffer.from(input), 'bytes differ from the input (it was re-encoded)');
}

const fail = async (bytes, code) => {
  const r = await reencodePreview(bytes);
  assert.equal(r.ok, false, `expected failure ${code}, got ok`);
  assert.equal(r.code, code);
  assert.equal(typeof r.message, 'string');
  return r;
};

test('a clean still WebP comes back re-encoded, same size, no metadata', async () => {
  const input = preview('good.webp');
  const r = await reencodePreview(input);
  assert.equal(r.ok, true);
  assert.deepEqual([r.width, r.height], [64, 48]);
  assertCleanStill(Buffer.from(r.bytes), input);
});

test('EXIF, XMP and ICC chunks in the input never reach the output', async () => {
  const input = preview('with-metadata.webp');
  const names = chunksOf(input).map((c) => c.fourcc);
  for (const n of ['EXIF', 'XMP ', 'ICCP']) assert.ok(names.includes(n), `fixture has ${n}`);
  const r = await reencodePreview(input);
  assert.equal(r.ok, true);
  assertCleanStill(Buffer.from(r.bytes), input);
  const text = Buffer.from(r.bytes).toString('latin1');
  assert.ok(!text.includes('secret-exif') && !text.includes('secret-xmp'));
});

test('re-encoding twice gives a clean still both times', async () => {
  const first = await reencodePreview(preview('good.webp'));
  assert.equal(first.ok, true);
  const second = await reencodePreview(Buffer.from(first.bytes));
  assert.equal(second.ok, true);
  const out = Buffer.from(second.bytes);
  for (const c of chunksOf(out)) assert.ok(!FORBIDDEN.includes(c.fourcc));
  assert.deepEqual(sizeOf(out), { width: 64, height: 48 });
});

test('the 1024 x 1024 boundary passes', async () => {
  const input = preview('side-1024.webp');
  const r = await reencodePreview(input);
  assert.equal(r.ok, true);
  assert.deepEqual([r.width, r.height], [1024, 1024]);
  assertCleanStill(Buffer.from(r.bytes), input);
});

test('a side over 1024 px is refused from the header', async () => {
  await fail(preview('side-1025.webp'), 'too_large_side');
});

test('a huge canvas in the header is refused before any pixel decode', async () => {
  // The pixel data is truncated: a decoder would report a malformed file, so too_large_side proves the header was read first.
  await fail(preview('header-huge-truncated.webp'), 'too_large_side');
});

test('an animated WebP is refused', async () => {
  await fail(preview('animated.webp'), 'animated');
});

test('a malformed WebP is refused (bad chunk size, truncated VP8 data)', async () => {
  await fail(preview('bad-chunk-size.webp'), 'malformed');
  await fail(preview('truncated-data.webp'), 'malformed');
});

test('not a WebP is refused (PNG, empty, wrong RIFF form, short)', async () => {
  await fail(preview('not-webp.png'), 'not_webp');
  await fail(Buffer.alloc(0), 'not_webp');
  await fail(Buffer.from('RIFF\x04\x00\x00\x00WAVE'), 'not_webp');
  await fail(Buffer.from('RIFF'), 'not_webp');
});

test('an input over 96 KiB is refused before decoding', async () => {
  const big = withExtraChunk(preview('good.webp'), 'JUNK', Buffer.alloc(MAX));
  assert.ok(big.length > MAX);
  await fail(big, 'input_too_big');
  const exact = withExtraChunk(preview('good.webp'), 'JUNK', Buffer.alloc(MAX - preview('good.webp').length - 8));
  assert.equal(exact.length, MAX);
  const r = await reencodePreview(exact);
  assert.equal(r.ok, true, 'exactly 96 KiB is allowed');
});

test('an output over 96 KiB fails the look', async () => {
  const input = preview('output-too-big.webp');
  assert.ok(input.length <= MAX, 'fixture input is within the limit');
  await fail(input, 'output_too_big');
});

test('it never throws on hostile bytes', async () => {
  const good = preview('good.webp');
  for (let i = 0; i < good.length; i += 7) {
    const b = Buffer.from(good);
    b[i] ^= 0xff;
    const r = await reencodePreview(b);
    assert.equal(typeof r.ok, 'boolean');
    if (r.ok) assert.ok(Buffer.from(r.bytes).length <= MAX);
  }
});

// A header-valid file that decodes with a warning cannot be built as a fixture (every variant tried either decodes cleanly or
// errors), so the decoder settings are pinned from the source instead (look-index "Previews").
test('sharp is run with the pinned safety options', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'reencode-preview.mjs'), 'utf8');
  assert.match(src, /failOn:\s*['"]warning['"]/, 'decoder warnings are failures');
  assert.match(src, /limitInputPixels:\s*(1024\s*\*\s*1024|1048576|LIMIT\w*|\w*MAX\w*)/, 'pixel limit set from the 1024 side');
  assert.match(src, /animated:\s*false/);
  assert.doesNotMatch(src, /withMetadata|withExif|withIccProfile|withXmp|keepMetadata|keepExif|keepIcc|keepXmp/, 'no metadata is carried over');
});
