// scripts/smoke.mjs#smoke(options) fetches the live site and resolves { ok, failures: [{ code, message }] }; never throws.
// options: { baseUrl (ends with "/"), previousIndex (signed text of the index that was live before, or null), verify (text => VerifiedIndex),
//            retries?: { attempts, delayMs } }. `verify` defaults to the vendored verifyIndex called with ONE argument; the tests inject
//            their own key pair through `verify`, because scripts/smoke.mjs never passes a key list itself (grep below).
// Codes: fetch (index or a file not served 200), index_verify (verify refused the index), look_hash (look bytes differ from the entry
// sha512 or bytes), look_parse (parseLook refused the look), look_traits (entry animated/fonts differ from lookTraits), preview_hash
// (preview bytes differ from the entry's preview hash), rollback_not_refused (acceptIndex(live, previous) did not refuse the previous index).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { smoke } from '../scripts/smoke.mjs';
import { buildIndex } from '../scripts/build-index.mjs';
import { REPO, preview } from './fixtures/webp-tools.mjs';

const { verifyIndex } = await import('../vendor/look-kit.mjs');
const PREFIX = 'magic-card-look-index-v1\n';
const rawPub = (kp) => Buffer.from(kp.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
const MAIN = crypto.generateKeyPairSync('ed25519');
const SPARE = crypto.generateKeyPairSync('ed25519');
const PEM = MAIN.privateKey.export({ type: 'pkcs8', format: 'pem' });
const KEYS = [rawPub(MAIN), rawPub(SPARE)];
const verify = (text) => verifyIndex(text, KEYS);
const RETRY = { attempts: 1, delayMs: 0 };

const sha512 = (b) => crypto.createHash('sha512').update(b).digest('hex');
const PLAIN = '{"grammar":1,"modules":{"icon":{"design":{"color":"#ffffff"}}}}';
const FONT = '{"grammar":1,"modules":{"text":{"design":{"font_family":"Roboto"}}}}';
const NOW = new Date('2026-12-01T10:20:30.000Z');
const dirs = [];
const servers = [];
test.after(() => {
  servers.forEach((s) => s.close());
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
  dirs.push(d);
  return d;
};

/** Builds a real signed site with buildIndex; returns { outDir, text, payload }. */
async function site(liveSeq = 0, newestRelease = 0) {
  const root = tmp();
  fs.cpSync(path.join(REPO, 'vendor'), path.join(root, 'vendor'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'look-kit.lock.json'), path.join(root, 'look-kit.lock.json'));
  const previewsDir = tmp();
  for (const [id, look] of [['calm-slate', PLAIN], ['warm-dusk', FONT]]) {
    const d = path.join(root, 'looks', id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'look.json'), look);
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id, name: id, author: 'therealmcsparrow', licence: 'CC0-1.0' }));
    fs.writeFileSync(path.join(d, 'preview.webp'), preview('good.webp'));
    fs.writeFileSync(path.join(previewsDir, id + '.webp'), preview('side-1024.webp'));
  }
  const outDir = path.join(tmp(), 'out');
  const r = await buildIndex({ root, previewsDir, outDir, privateKey: PEM, liveSeq, newestRelease, now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r));
  return { outDir, text: r.envelope, payload: JSON.parse(Buffer.from(JSON.parse(r.envelope).payload, 'base64').toString('utf8')) };
}

/** Same signing as the deploy: the test's own, so a doctored payload carries a valid signature. */
function sign(payload) {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = crypto.sign(null, Buffer.concat([Buffer.from(PREFIX), bytes]), MAIN.privateKey);
  return JSON.stringify({ payload: bytes.toString('base64'), sig: sig.toString('base64') });
}

/** Serves outDir at "/"; `over` maps a URL path to Buffer | null (null = 404). Resolves the base URL. */
async function serve(outDir, over = {}) {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.json';
    if (p in over) {
      if (over[p] === null) return res.writeHead(404).end();
      return res.writeHead(200).end(over[p]);
    }
    const f = path.join(outDir, p);
    if (!f.startsWith(outDir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200).end(fs.readFileSync(f));
  });
  servers.push(server);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return `http://127.0.0.1:${server.address().port}/`;
}

const codes = (r) => r.failures.map((f) => f.code);
async function check(s, { over = {}, previousIndex = null, verifyFn = verify } = {}) {
  const baseUrl = await serve(s.outDir, over);
  return smoke({ baseUrl, previousIndex, verify: verifyFn, retries: RETRY });
}
function assertFailed(r, code) {
  assert.equal(r.ok, false, 'expected a failure');
  assert.ok(codes(r).includes(code), `expected ${code} in ${JSON.stringify(r.failures)}`);
  for (const f of r.failures) assert.ok(typeof f.message === 'string' && f.message.length > 0);
}

test('a good live site passes', async () => {
  const s = await site();
  const r = await check(s);
  assert.deepEqual(r.failures, []);
  assert.equal(r.ok, true);
});

test('a previous index with a lower seq is refused by the live one, so the smoke passes', async () => {
  const prev = await site(3, 3);
  const live = await site(4, 4);
  const r = await check(live, { previousIndex: prev.text });
  assert.deepEqual(r.failures, []);
  assert.equal(r.ok, true);
});

test('a previous index that the live one would not refuse fails (same envelope)', async () => {
  const live = await site(4, 4);
  assertFailed(await check(live, { previousIndex: live.text }), 'rollback_not_refused');
});

test('a previous index with a higher seq is not refused either, so it fails', async () => {
  const prev = await site(8, 8);
  const live = await site(4, 4);
  assertFailed(await check(live, { previousIndex: prev.text }), 'rollback_not_refused');
});

test('tampered look bytes fail with look_hash', async () => {
  const s = await site();
  const e = s.payload.looks[0];
  const r = await check(s, { over: { [`looks/${e.sha512}.json`]: Buffer.from(PLAIN.replace('ffffff', '000000')) } });
  assertFailed(r, 'look_hash');
});

test('hash drift (the entry names a hash the served bytes do not have) fails with look_hash', async () => {
  const s = await site();
  const looks = s.payload.looks.map((e, i) => (i === 0 ? { ...e, sha512: sha512(Buffer.from('other')) } : e));
  const doctored = sign({ ...s.payload, looks });
  const e0 = s.payload.looks[0];
  const over = { 'index.json': Buffer.from(doctored), [`looks/${looks[0].sha512}.json`]: fs.readFileSync(path.join(s.outDir, 'looks', e0.sha512 + '.json')) };
  assertFailed(await check(s, { over }), 'look_hash');
});

test('a bytes member that differs from the served look fails with look_hash', async () => {
  const s = await site();
  const looks = s.payload.looks.map((e, i) => (i === 0 ? { ...e, bytes: e.bytes + 1 } : e));
  assertFailed(await check(s, { over: { 'index.json': Buffer.from(sign({ ...s.payload, looks })) } }), 'look_hash');
});

test('a traits mismatch (animated or fonts) fails with look_traits', async () => {
  const s = await site();
  for (const patch of [{ animated: true }, { fonts: ['Lato'] }]) {
    const looks = s.payload.looks.map((e, i) => (i === 0 ? { ...e, ...patch } : e));
    assertFailed(await check(s, { over: { 'index.json': Buffer.from(sign({ ...s.payload, looks })) } }), 'look_traits');
  }
});

test('a preview whose bytes differ from the entry hash fails with preview_hash', async () => {
  const s = await site();
  const e = s.payload.looks[0];
  assertFailed(await check(s, { over: { [`previews/${e.preview}.webp`]: preview('good.webp') } }), 'preview_hash');
});

test('an entry preview hash that differs from the served file fails with preview_hash', async () => {
  const s = await site();
  const e0 = s.payload.looks[0];
  const drift = sha512(Buffer.from('drift'));
  const looks = s.payload.looks.map((e, i) => (i === 0 ? { ...e, preview: drift } : e));
  const over = { 'index.json': Buffer.from(sign({ ...s.payload, looks })), [`previews/${drift}.webp`]: fs.readFileSync(path.join(s.outDir, 'previews', e0.preview + '.webp')) };
  assertFailed(await check(s, { over }), 'preview_hash');
});

test('an index signed by an unknown key fails with index_verify', async () => {
  const s = await site();
  const other = [rawPub(crypto.generateKeyPairSync('ed25519')), rawPub(crypto.generateKeyPairSync('ed25519'))];
  assertFailed(await check(s, { verifyFn: (t) => verifyIndex(t, other) }), 'index_verify');
});

test('a tampered signed payload fails with index_verify', async () => {
  const s = await site();
  const env = JSON.parse(s.text);
  const bytes = Buffer.from(env.payload, 'base64');
  bytes[bytes.length - 3] ^= 1;
  const over = { 'index.json': Buffer.from(JSON.stringify({ ...env, payload: bytes.toString('base64') })) };
  assertFailed(await check(s, { over }), 'index_verify');
});

test('a missing index, look or preview fails with fetch', async () => {
  const s = await site();
  const e = s.payload.looks[0];
  assertFailed(await check(s, { over: { 'index.json': null } }), 'fetch');
  assertFailed(await check(s, { over: { [`looks/${e.sha512}.json`]: null } }), 'fetch');
  assertFailed(await check(s, { over: { [`previews/${e.preview}.webp`]: null } }), 'fetch');
});

test('an unreachable site fails with fetch and does not throw', async () => {
  const r = await smoke({ baseUrl: 'http://127.0.0.1:9/', previousIndex: null, verify, retries: RETRY });
  assertFailed(r, 'fetch');
});

test('scripts/smoke.mjs never calls verifyIndex with a second argument (grep)', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'smoke.mjs'), 'utf8');
  assert.ok(/verifyIndex/.test(src), 'smoke.mjs must use the vendored verifyIndex');
  const calls = [...src.matchAll(/verifyIndex\s*\(/g)];
  for (const m of calls) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      if (src[i] === '(' || src[i] === '[' || src[i] === '{') depth++;
      else if (src[i] === ')' || src[i] === ']' || src[i] === '}') {
        depth--;
        if (depth === 0) break;
      } else if (src[i] === ',' && depth === 1) assert.fail('verifyIndex called with a second argument at offset ' + m.index);
    }
  }
  assert.ok(!/LOOK_INDEX_PUBLIC_KEYS|publicKeys|keys\s*:/.test(src), 'smoke.mjs must not carry its own key list');
});
