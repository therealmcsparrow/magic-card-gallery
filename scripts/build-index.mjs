// Builds the signed gallery site: node scripts/build-index.mjs build|live ...  (see main at the bottom).
// buildIndex never throws on a bad tree or sequence; it writes nothing unless every check passed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkLooks } from './check-looks.mjs';

export const MAX_SEQ = 2_147_483_647;
const SIGN_PREFIX = 'magic-card-look-index-v1\n';
const EXPIRY_DAYS = 180;
const PREVIEW_MAX_BYTES = 96 * 1024;
const LIVE_TIMEOUT_MS = 10_000;
const LIVE_MAX_BYTES = 64 * 1024 + 1024;

const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });
const seconds = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const isSeq = (n) => Number.isSafeInteger(n) && n >= 0;

/** Reads a regular file (no links) up to max bytes; null when it is missing, a link or too big. */
function readRegular(file, max) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/**
 * @param {{ root: string, previewsDir: string, outDir: string, privateKey: string, liveSeq: number, newestRelease: number, now: Date }} o
 *   liveSeq is L (0 when nothing is live), newestRelease is N (0 when there is no index-<seq> release).
 */
export async function buildIndex(o) {
  try {
    const { liveSeq: L, newestRelease: N } = o;
    if (!isSeq(L) || !isSeq(N)) return fail('sequence', 'The live sequence and the newest release number must be whole numbers from 0.');
    if (L !== N && L !== N + 1) {
      return fail('sequence', `The live index has seq ${L} but the newest index release is ${N}; a deploy needs the two to match or the release to lag by one.`);
    }
    const seq = L + 1;
    if (seq > MAX_SEQ) return fail('seq_max', `The next seq ${seq} is above ${MAX_SEQ}.`);

    const checked = await checkLooks(o.root, { reencode: false });
    if (!checked.ok) return fail('check_looks', 'The looks did not pass the checks.', { failures: checked.failures });
    const kit = await import(pathToFileURL(path.join(o.root, 'vendor', 'look-kit.mjs')).href);

    const decoder = new TextDecoder('utf-8', { fatal: true });
    const looksDir = path.join(o.root, 'looks');
    const ids = fs.readdirSync(looksDir).sort();
    const entries = [];
    const files = new Map();
    const problems = [];
    for (const id of ids) {
      const lookBytes = readRegular(path.join(looksDir, id, 'look.json'), 16 * 1024);
      const metaBytes = readRegular(path.join(looksDir, id, 'meta.json'), 4 * 1024);
      const previewBytes = readRegular(path.join(o.previewsDir, id + '.webp'), PREVIEW_MAX_BYTES);
      if (!lookBytes || !metaBytes) {
        problems.push({ code: 'meta', path: `looks/${id}`, message: 'look.json or meta.json could not be read.' });
        continue;
      }
      if (!previewBytes || previewBytes.length < 12 || previewBytes.toString('latin1', 0, 4) !== 'RIFF' || previewBytes.toString('latin1', 8, 12) !== 'WEBP') {
        problems.push({ code: 'preview', path: `looks/${id}`, message: 'There is no re-encoded preview for this look, or it is not a WebP within the size cap.' });
        continue;
      }
      const lookText = decoder.decode(lookBytes);
      const meta = JSON.parse(decoder.decode(metaBytes));
      const parsed = kit.parseLook(lookText);
      if (!parsed.ok) {
        problems.push({ code: 'parse', path: `looks/${id}/look.json`, message: 'The look is refused by the parser.' });
        continue;
      }
      const traits = kit.lookTraits(parsed.look);
      const sha512 = kit.sha512Hex(lookBytes);
      const preview = kit.sha512Hex(previewBytes);
      entries.push({
        id: meta.id,
        name: meta.name.normalize('NFC'),
        author: meta.author,
        licence: meta.licence,
        grammar: JSON.parse(lookText).grammar,
        sha512,
        bytes: lookBytes.length,
        preview,
        animated: traits.animated,
        fonts: traits.fonts,
      });
      files.set(`looks/${sha512}.json`, lookBytes);
      files.set(`previews/${preview}.webp`, previewBytes);
    }
    if (problems.length) return fail('check_looks', 'The looks did not pass the checks.', { failures: problems });

    const issued = seconds(o.now);
    const expires = seconds(new Date(o.now.getTime() + EXPIRY_DAYS * 86_400_000));
    const payloadBytes = Buffer.from(JSON.stringify({ format: 1, seq, issued, expires, looks: entries }), 'utf8');

    let key;
    try {
      key = crypto.createPrivateKey(o.privateKey);
    } catch {
      return fail('key', 'The signing key could not be read as a PKCS#8 PEM key.');
    }
    const sig = crypto.sign(null, Buffer.concat([Buffer.from(SIGN_PREFIX, 'utf8'), payloadBytes]), key);
    const envelope = JSON.stringify({ payload: payloadBytes.toString('base64'), sig: sig.toString('base64') });

    // Verify before anything is written: the vendored verify under the public half of the key that just signed.
    const pub = Buffer.from(crypto.createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('base64');
    const verified = kit.verifyIndex(envelope, [pub, pub]);
    if (!verified.ok) return fail('verify', `The signed index did not verify (${verified.code}).`);

    const out = new Map([['index.json', Buffer.from(envelope, 'utf8')], ...files]);
    for (const [rel, bytes] of out) {
      const target = path.join(o.outDir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    }
    return { ok: true, seq, envelope, files: [...out.keys()], actions: L === N + 1 ? [{ type: 'create_release', seq: L }] : [] };
  } catch (e) {
    return fail('check_looks', `The build stopped: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

/**
 * Reads L from the live site: 404 on index.json means no index yet (L = 0). Anything else that is not a verified index is an error.
 * @returns {Promise<{ ok: true, seq: number, text: string | null } | { ok: false, message: string }>}
 */
export async function readLiveIndex(baseUrl, verify) {
  let res;
  try {
    res = await fetch(baseUrl + 'index.json', { redirect: 'error', signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
  } catch {
    return { ok: false, message: 'The live index could not be fetched.' };
  }
  if (res.status === 404) return { ok: true, seq: 0, text: null };
  if (res.status !== 200) return { ok: false, message: `The live index answered ${res.status}.` };
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > LIVE_MAX_BYTES) return { ok: false, message: 'The live index is too big.' };
  const text = bytes.toString('utf8');
  const v = verify(text);
  if (!v.ok) return { ok: false, message: `The live index did not verify (${v.code}).` };
  return { ok: true, seq: v.payload.seq, text };
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const f = flags(rest);
  const root = path.resolve(f.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  if (cmd === 'live') {
    // live --base <url ending in /> --out <file>: verifies the live index with the shipped keys, saves it and prints its seq.
    const checked = await checkLooks(root, { reencode: false });
    if (!checked.ok) throw new Error('The vendored look kit or the looks did not pass the checks.');
    const kit = await import(pathToFileURL(path.join(root, 'vendor', 'look-kit.mjs')).href);
    const r = await readLiveIndex(f.base, (t) => kit.verifyIndex(t));
    if (!r.ok) throw new Error(r.message);
    if (r.text !== null && f.out) fs.writeFileSync(f.out, r.text);
    setOutput('live_seq', r.seq);
    setOutput('has_live', r.text !== null);
    console.log(`live seq ${r.seq}`);
    return;
  }
  if (cmd === 'build') {
    const privateKey = process.env.LOOK_INDEX_SIGNING_KEY ?? '';
    const r = await buildIndex({
      root,
      previewsDir: path.resolve(f.previews),
      outDir: path.resolve(f.out),
      privateKey,
      liveSeq: Number(f['live-seq']),
      newestRelease: Number(f['newest-seq']),
      now: new Date(),
    });
    if (!r.ok) {
      for (const x of r.failures ?? []) console.error(`${x.code}  ${x.path}  ${x.message}`);
      throw new Error(`${r.code}: ${r.message}`);
    }
    // The shipped keys, as the card sees them.
    const kit = await import(pathToFileURL(path.join(root, 'vendor', 'look-kit.mjs')).href);
    const v = kit.verifyIndex(r.envelope);
    if (!v.ok) throw new Error(`The signed index does not verify under the shipped public keys (${v.code}).`);
    setOutput('seq', r.seq);
    setOutput('missing_release', r.actions[0]?.seq ?? '');
    console.log(`signed index seq ${r.seq}, ${r.files.length} files`);
    return;
  }
  throw new Error('usage: build-index.mjs build --previews <dir> --out <dir> --live-seq <L> --newest-seq <N> | live --base <url> --out <file>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
}
