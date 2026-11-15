// AC18, AC19, AC20 (T18 red tests): scripts/build-index.mjs#buildIndex(options) resolves
//   { ok: true, seq, envelope, files: string[] (paths relative to outDir), actions: [{ type: 'create_release', seq }] }
//   or { ok: false, code: 'sequence' | 'seq_max' | 'check_looks', message, failures? }. It never throws on a bad tree or bad sequence.
// options: { root, previewsDir, outDir, privateKey (PKCS#8 PEM text), liveSeq (L, 0 when none), newestRelease (N, 0 when none), now: Date }
//  - root holds looks/<id>/{look.json,meta.json,preview.webp} (+ vendor/, look-kit.lock.json); previewsDir holds the re-encoded <id>.webp.
//  - outDir receives index.json (the signed text), looks/<sha512>.json and previews/<sha512>.webp, nothing else.
// The tests generate their own Ed25519 keys, verify with the vendored verifyIndex(text, [pubA, pubB]) and, independently, with node:crypto.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../scripts/build-index.mjs';
import { REPO, preview } from './fixtures/webp-tools.mjs';

const { verifyIndex } = await import('../vendor/look-kit.mjs');
const MAX_SEQ = 2 ** 31 - 1;
const PREFIX = 'magic-card-look-index-v1\n';
const rawPub = (kp) => Buffer.from(kp.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
const MAIN = crypto.generateKeyPairSync('ed25519');
const SPARE = crypto.generateKeyPairSync('ed25519');
const PEM = MAIN.privateKey.export({ type: 'pkcs8', format: 'pem' });
const KEYS = [rawPub(MAIN), rawPub(SPARE)];

const sha512 = (b) => crypto.createHash('sha512').update(b).digest('hex');
const SUBMITTED = preview('good.webp');
const REENCODED = preview('side-1024.webp');
const PLAIN = '{"grammar":1,"modules":{"icon":{"design":{"color":"#ffffff"}}}}';
const FONT = '{"grammar":1,"modules":{"text":{"design":{"font_family":"Roboto"}}}}';
const ANIM = '{"grammar":1,"modules":{"*":{"design":{"color":"#ffffff","animations":[{"preset":"pulse","trigger":"always"}]}}}}';
const NOW = new Date('2026-12-01T10:20:30.000Z');
const dirs = [];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'build-index-'));
  dirs.push(d);
  return d;
};

/** looks: [{ id, look?, name? }]; returns { root, previewsDir, outDir }. */
function setup(looks = [{ id: 'calm-slate' }]) {
  const root = tmp();
  fs.cpSync(path.join(REPO, 'vendor'), path.join(root, 'vendor'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'look-kit.lock.json'), path.join(root, 'look-kit.lock.json'));
  const previewsDir = tmp();
  for (const l of looks) {
    const d = path.join(root, 'looks', l.id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'look.json'), l.look ?? PLAIN);
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id: l.id, name: l.name ?? 'Calm slate', author: 'therealmcsparrow', licence: 'CC0-1.0' }));
    fs.writeFileSync(path.join(d, 'preview.webp'), SUBMITTED);
    fs.writeFileSync(path.join(previewsDir, l.id + '.webp'), REENCODED);
  }
  return { root, previewsDir, outDir: path.join(tmp(), 'out') };
}

const opts = (s, over = {}) => ({ ...s, privateKey: PEM, liveSeq: 0, newestRelease: 0, now: NOW, ...over });
const run = async (looks, over = {}) => {
  const s = setup(looks);
  return { r: await buildIndex(opts(s, over)), s };
};
const payloadOf = (signed) => JSON.parse(Buffer.from(JSON.parse(signed).payload, 'base64').toString('utf8'));
const walk = (d, base = d) =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), base) : [path.relative(base, path.join(d, e.name)).split(path.sep).join('/')]));
const nothingWritten = (s) => !fs.existsSync(s.outDir) || walk(s.outDir).length === 0;

test('AC18: a signed index verifies, with seq L + 1, issued and expires = issued + 180 days', async () => {
  const { r, s } = await run([{ id: 'calm-slate' }], { liveSeq: 4, newestRelease: 4 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.seq, 5);
  assert.deepEqual(r.actions, []);
  assert.equal(fs.readFileSync(path.join(s.outDir, 'index.json'), 'utf8'), r.envelope);
  const v = verifyIndex(r.envelope, KEYS);
  assert.equal(v.ok, true, JSON.stringify(v));
  const p = payloadOf(r.envelope);
  assert.deepEqual(Object.keys(p).sort(), ['expires', 'format', 'issued', 'looks', 'seq']);
  assert.equal(p.format, 1);
  assert.equal(p.seq, 5);
  assert.equal(p.issued, '2026-12-01T10:20:30Z');
  assert.equal(p.expires, '2027-05-30T10:20:30Z');
  assert.equal(new Date(p.expires) - new Date(p.issued), 180 * 86400000);
});

test('AC18: the signature is a plain Ed25519 signature over the sign prefix + payload bytes (node:crypto)', async () => {
  const { r } = await run();
  const env = JSON.parse(r.envelope);
  assert.deepEqual(Object.keys(env).sort(), ['payload', 'sig']);
  const msg = Buffer.concat([Buffer.from(PREFIX, 'utf8'), Buffer.from(env.payload, 'base64')]);
  assert.equal(Buffer.from(env.sig, 'base64').length, 64);
  assert.equal(crypto.verify(null, msg, MAIN.publicKey, Buffer.from(env.sig, 'base64')), true);
});

test('AC18: an index signed by another key does not verify under a different pair', async () => {
  const { r } = await run();
  const other = [rawPub(crypto.generateKeyPairSync('ed25519')), rawPub(crypto.generateKeyPairSync('ed25519'))];
  const v = verifyIndex(r.envelope, other);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'index_signature');
});

test('AC18: entries carry the look hash, bytes and metadata; files are looks/<sha512>.json byte for byte', async () => {
  const { r, s } = await run([{ id: 'calm-slate' }]);
  const [e] = payloadOf(r.envelope).looks;
  assert.deepEqual(Object.keys(e).sort(), ['animated', 'author', 'bytes', 'fonts', 'grammar', 'id', 'licence', 'name', 'preview', 'sha512']);
  assert.equal(e.id, 'calm-slate');
  assert.equal(e.name, 'Calm slate');
  assert.equal(e.author, 'therealmcsparrow');
  assert.equal(e.licence, 'CC0-1.0');
  assert.equal(e.grammar, 1);
  assert.equal(e.bytes, Buffer.byteLength(PLAIN));
  assert.equal(e.sha512, sha512(Buffer.from(PLAIN)));
  assert.equal(fs.readFileSync(path.join(s.outDir, 'looks', e.sha512 + '.json'), 'utf8'), PLAIN);
});

test('AC19: the preview hash and file are the re-encoded bytes; no submitted preview.webp is in the output', async () => {
  const { r, s } = await run([{ id: 'calm-slate' }]);
  const [e] = payloadOf(r.envelope).looks;
  assert.equal(e.preview, sha512(REENCODED));
  assert.notEqual(e.preview, sha512(SUBMITTED));
  assert.deepEqual(fs.readFileSync(path.join(s.outDir, 'previews', e.preview + '.webp')), REENCODED);
  const files = walk(s.outDir);
  assert.ok(!files.some((f) => f.endsWith('preview.webp')), files.join(','));
  for (const f of files.filter((f) => f.startsWith('previews/'))) {
    assert.notDeepEqual(fs.readFileSync(path.join(s.outDir, f)), SUBMITTED);
  }
});

test('AC19: the output holds index.json, looks/ and previews/ only, and `files` lists exactly those', async () => {
  const { r, s } = await run([{ id: 'calm-slate' }, { id: 'warm-dusk', look: FONT, name: 'Warm dusk' }]);
  const files = walk(s.outDir).sort();
  assert.deepEqual([...r.files].sort(), files);
  assert.equal(files.length, 5);
  for (const f of files) assert.match(f, /^(index\.json|looks\/[0-9a-f]{128}\.json|previews\/[0-9a-f]{128}\.webp)$/);
});

test('AC18: animated and fonts come from the look traits', async () => {
  const { r } = await run([
    { id: 'plain-one', look: PLAIN, name: 'Plain' },
    { id: 'font-one', look: FONT, name: 'Font' },
    { id: 'anim-one', look: ANIM, name: 'Anim' },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const by = Object.fromEntries(payloadOf(r.envelope).looks.map((e) => [e.id, e]));
  assert.deepEqual([by['plain-one'].animated, by['plain-one'].fonts], [false, []]);
  assert.deepEqual([by['font-one'].animated, by['font-one'].fonts], [false, ['Roboto']]);
  assert.deepEqual([by['anim-one'].animated, by['anim-one'].fonts], [true, []]);
});

test('AC18: two looks give two entries that pass every verifyIndex limit', async () => {
  const { r } = await run([{ id: 'a-look' }, { id: 'b-look', look: FONT, name: 'B' }]);
  assert.equal(verifyIndex(r.envelope, KEYS).ok, true);
  assert.equal(payloadOf(r.envelope).looks.length, 2);
});

test('AC20: L = N gives seq L + 1 and no extra action', async () => {
  const { r } = await run(undefined, { liveSeq: 7, newestRelease: 7 });
  assert.equal(r.ok, true);
  assert.equal(r.seq, 8);
  assert.deepEqual(r.actions, []);
});

test('AC20: no live index and no release gives seq 1', async () => {
  const { r } = await run(undefined, { liveSeq: 0, newestRelease: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.seq, 1);
});

test('AC20: L = N + 1 gives seq L + 1 and a missing-release action for L', async () => {
  const { r } = await run(undefined, { liveSeq: 8, newestRelease: 7 });
  assert.equal(r.ok, true);
  assert.equal(r.seq, 9);
  assert.deepEqual(r.actions, [{ type: 'create_release', seq: 8 }]);
});

for (const [L, N] of [[9, 7], [20, 3], [3, 4], [0, 1], [5, 40]]) {
  test(`AC20: L = ${L}, N = ${N} is refused and writes nothing`, async () => {
    const { r, s } = await run(undefined, { liveSeq: L, newestRelease: N });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'sequence');
    assert.ok(typeof r.message === 'string' && r.message.length > 0);
    assert.ok(nothingWritten(s));
  });
}

test('AC20: the highest seq 2^31 - 1 is allowed', async () => {
  const { r } = await run(undefined, { liveSeq: MAX_SEQ - 1, newestRelease: MAX_SEQ - 1 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.seq, MAX_SEQ);
  assert.equal(verifyIndex(r.envelope, KEYS).ok, true);
});

test('AC20: a seq above 2^31 - 1 is refused', async () => {
  for (const [L, N] of [[MAX_SEQ, MAX_SEQ], [MAX_SEQ, MAX_SEQ - 1]]) {
    const { r, s } = await run(undefined, { liveSeq: L, newestRelease: N });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'seq_max');
    assert.ok(nothingWritten(s));
  }
});

test('AC18: buildIndex re-runs checkLooks and refuses on any failure (unsafe value, bad licence, tampered vendor)', async () => {
  const bad = '{"grammar":1,"modules":{"icon":{"design":{"color":"url(https://x.test/a)"}}}}';
  let { r, s } = await run([{ id: 'calm-slate' }, { id: 'bad-one', look: bad, name: 'Bad' }]);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'check_looks');
  assert.ok(Array.isArray(r.failures) && r.failures.length > 0);
  assert.ok(nothingWritten(s));

  s = setup();
  fs.writeFileSync(path.join(s.root, 'looks', 'calm-slate', 'meta.json'), JSON.stringify({ id: 'calm-slate', name: 'Calm', author: 'therealmcsparrow', licence: 'GPL-3.0' }));
  r = await buildIndex(opts(s));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'check_looks');

  s = setup();
  fs.appendFileSync(path.join(s.root, 'vendor', 'look-kit.mjs'), '\n// tampered\n');
  r = await buildIndex(opts(s));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'check_looks');
});

test('AC18: a result never contains the private key', async () => {
  const bad = await run(undefined, { liveSeq: 9, newestRelease: 2 });
  const good = await run();
  for (const x of [bad.r, good.r]) assert.ok(!JSON.stringify(x).includes('PRIVATE KEY'));
});

test('AC18: the same input signs the same payload bytes (no random member)', async () => {
  const a = await run();
  const b = await run();
  assert.equal(JSON.parse(a.r.envelope).payload, JSON.parse(b.r.envelope).payload);
});
