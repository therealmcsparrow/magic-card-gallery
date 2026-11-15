// Post-deploy smoke test: node scripts/smoke.mjs <baseUrl ending in /> [--previous <file>] [--expect-seq <n>] [--root <dir>]
// Fetches the live site and checks it the way the card does: signature (vendored verify, shipped public keys), look and preview
// hashes, parse, traits, and that the live index refuses the index that was live before. smoke() never throws.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 1024 * 1024;
const SHA512_RE = /^[0-9a-f]{128}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
// The edge may serve the old index for up to ten minutes. 30 s for the first two minutes, then 60 s, 15 minutes in all.
const DEFAULT_DELAYS = [...Array(4).fill(30_000), ...Array(13).fill(60_000)];

const failure = (code, message) => ({ code, message });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Imports the vendored look kit only after its sha256 matches look-kit.lock.json. */
async function loadKit(root) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'look-kit.lock.json'), 'utf8'));
  const want = lock?.files?.['vendor/look-kit.mjs']?.sha256;
  const file = path.join(root, 'vendor', 'look-kit.mjs');
  if (typeof want !== 'string' || !SHA256_RE.test(want)) throw new Error('look-kit.lock.json has no sha256 for vendor/look-kit.mjs');
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new Error('vendor/look-kit.mjs is not a regular file');
  if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== want) throw new Error('vendor/look-kit.mjs does not match look-kit.lock.json');
  return import(pathToFileURL(file).href);
}

/** @returns {Promise<{ status: number, bytes: Buffer } | null>} null when the request failed or the body was too big. */
async function get(url) {
  try {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status !== 200) return { status: res.status, bytes: Buffer.alloc(0) };
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length > MAX_BYTES ? null : { status: 200, bytes };
  } catch {
    return null;
  }
}

async function once(o, kit, verify) {
  const failures = [];
  const base = o.baseUrl;
  const index = await get(base + 'index.json');
  if (!index || index.status !== 200) return [failure('fetch', 'index.json could not be fetched from the live site.')];
  const live = verify(index.bytes.toString('utf8'));
  if (!live.ok) return [failure('index_verify', `The live index does not verify (${live.code}).`)];

  if (Number.isSafeInteger(o.expectSeq)) {
    if (live.payload.seq < o.expectSeq) return [failure('stale_index', `The live index has seq ${live.payload.seq}, expected ${o.expectSeq}.`)];
    if (live.payload.seq > o.expectSeq) return [failure('seq_unexpected', `The live index has seq ${live.payload.seq}, higher than the deployed ${o.expectSeq}.`)];
  }

  for (const e of live.payload.looks) {
    if (!SHA512_RE.test(e.sha512) || !SHA512_RE.test(e.preview)) {
      failures.push(failure('look_hash', `Look "${e.id}" has an entry hash that is not 128 hex characters.`));
      continue;
    }
    const look = await get(`${base}looks/${e.sha512}.json`);
    if (!look || look.status !== 200) failures.push(failure('fetch', `looks/${e.sha512}.json could not be fetched (look "${e.id}").`));
    else if (look.bytes.length !== e.bytes || kit.sha512Hex(look.bytes) !== e.sha512) {
      failures.push(failure('look_hash', `The served bytes of look "${e.id}" differ from the index entry.`));
    } else {
      let text = null;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(look.bytes);
      } catch {
        failures.push(failure('look_parse', `Look "${e.id}" is not valid UTF-8.`));
      }
      if (text !== null) {
        const parsed = kit.parseLook(text);
        if (!parsed.ok) failures.push(failure('look_parse', `The parser refuses look "${e.id}" (${parsed.code}).`));
        else {
          const t = kit.lookTraits(parsed.look);
          if (t.animated !== e.animated || t.fonts.length !== e.fonts.length || t.fonts.some((f, n) => f !== e.fonts[n])) {
            failures.push(failure('look_traits', `The animated or fonts entry of look "${e.id}" differs from the look itself.`));
          }
        }
      }
    }
    const prev = await get(`${base}previews/${e.preview}.webp`);
    if (!prev || prev.status !== 200) failures.push(failure('fetch', `previews/${e.preview}.webp could not be fetched (look "${e.id}").`));
    else if (kit.sha512Hex(prev.bytes) !== e.preview) failures.push(failure('preview_hash', `The served preview of look "${e.id}" differs from the index entry.`));
  }

  if (o.previousIndex) {
    const before = verify(o.previousIndex);
    // A previous index under the seq floor is refused by the verify itself, which is the refusal we want.
    if (!before.ok && before.code !== 'index_rollback') failures.push(failure('index_verify', `The previous index does not verify (${before.code}).`));
    else if (before.ok) {
      const r = kit.acceptIndex({ seq: live.payload.seq, payloadBytes: live.payloadBytes }, { seq: before.payload.seq, payloadBytes: before.payloadBytes });
      if (r.ok) failures.push(failure('rollback_not_refused', `The live index (seq ${live.payload.seq}) would accept the previous index (seq ${before.payload.seq}).`));
    }
  }
  return failures;
}

/**
 * @param {{ baseUrl: string, previousIndex: string | null, verify?: (text: string) => any, retries?: { attempts: number, delayMs: number },
 *           expectSeq?: number, root?: string }} o
 * @returns {Promise<{ ok: boolean, failures: { code: string, message: string }[] }>}
 */
export async function smoke(o) {
  try {
    const kit = await loadKit(o.root ?? path.join(here, '..'));
    const verify = o.verify ?? ((text) => kit.verifyIndex(text));
    const delays = o.retries ? Array(Math.max(0, o.retries.attempts - 1)).fill(o.retries.delayMs) : DEFAULT_DELAYS;
    let failures = [];
    for (let n = 0; n <= delays.length; n++) {
      failures = await once(o, kit, verify);
      // Only a missing file or a stale edge copy is worth another try; a bad signature or hash will not heal.
      if (failures.length === 0 || !failures.every((f) => f.code === 'fetch' || f.code === 'stale_index')) break;
      if (n < delays.length) await sleep(delays[n]);
    }
    return { ok: failures.length === 0, failures };
  } catch (e) {
    return { ok: false, failures: [failure('fetch', `The smoke test stopped: ${String(e?.message ?? e).slice(0, 200)}`)] };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [baseUrl, ...rest] = process.argv.slice(2);
  const f = {};
  for (let i = 0; i < rest.length; i += 2) f[rest[i].replace(/^--/, '')] = rest[i + 1];
  const result = await smoke({
    baseUrl,
    previousIndex: f.previous ? fs.readFileSync(f.previous, 'utf8') : null,
    expectSeq: f['expect-seq'] ? Number(f['expect-seq']) : undefined,
    root: f.root ? path.resolve(f.root) : undefined,
  });
  for (const x of result.failures) console.error(`${x.code}  ${x.message}`);
  console.log(result.ok ? 'smoke: live site verified' : `smoke: ${result.failures.length} failure(s)`);
  process.exit(result.ok ? 0 : 1);
}
