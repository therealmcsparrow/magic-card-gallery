// Gallery PR check: node scripts/check-looks.mjs [root]. Walks <root>/looks/<id>/{look.json,meta.json,preview.webp} and verifies
// the vendored look kit first (sha256 against look-kit.lock.json), only then imports it. It reports every failure and publishes nothing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reencodePreview } from './reencode-preview.mjs';

export const MAX_LOOKS = 50;
const LOOK_MAX_BYTES = 16 * 1024;
const META_MAX_BYTES = 4 * 1024;
const PREVIEW_MAX_BYTES = 96 * 1024;
const VENDOR_MAX_BYTES = 1024 * 1024;
const LOCK_MAX_BYTES = 16 * 1024;
const NAME_MAX_POINTS = 40;
const AUTHOR_MAX_POINTS = 80;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const LICENCES = new Set(['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'MIT']);
const VENDORED = ['look-kit.mjs', 'look-fixtures.json'];

const fail = (code, p, message) => ({ code, path: p, message });
const here = path.dirname(fileURLToPath(import.meta.url));
const kits = new Map();

/** lstat without following links: the file's size, or a failure message when it is missing, a link or not a regular file. */
function regularSize(file, max) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return { error: 'is missing' };
  }
  if (!st.isFile()) return { error: 'is not a regular file (links and folders are refused)' };
  if (st.size > max) return { error: `is over ${max} bytes`, tooBig: true };
  return { size: st.size };
}

/** True when any JSON object in the (already valid) text repeats a member name. */
function repeatsMember(text) {
  let i = 0;
  const skip = () => {
    while (' \t\n\r'.includes(text[i])) i++;
  };
  const str = () => {
    const start = i++;
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i));
  };
  const value = () => {
    skip();
    const c = text[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      const seen = new Set();
      i++;
      skip();
      if (text[i] === close) return i++, false;
      for (;;) {
        if (c === '{') {
          skip();
          const key = str();
          if (seen.has(key)) return true;
          seen.add(key);
          skip();
          i++;
        }
        if (value()) return true;
        skip();
        if (text[i++] === close) return false;
      }
    }
    if (c === '"') return str(), false;
    while (i < text.length && !',]} \t\n\r'.includes(text[i])) i++;
    return false;
  };
  try {
    return value();
  } catch {
    return true;
  }
}

function readJsonText(file, max) {
  const s = regularSize(file, max);
  if (s.error) return { error: s.error, tooBig: s.tooBig };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)) };
  } catch {
    return { error: 'is not valid UTF-8' };
  }
}

/** Hash check of the vendored files against the lock. Returns { failures, kit } where kit is the verified module or null. */
async function loadVendor(root) {
  const failures = [];
  const lockPath = path.join(root, 'look-kit.lock.json');
  const lockText = readJsonText(lockPath, LOCK_MAX_BYTES);
  let lock = null;
  if (lockText.error) failures.push(fail('vendor_hash', 'look-kit.lock.json', `look-kit.lock.json ${lockText.error}.`));
  else {
    try {
      lock = JSON.parse(lockText.text);
    } catch {
      failures.push(fail('vendor_hash', 'look-kit.lock.json', 'look-kit.lock.json is not valid JSON.'));
    }
  }
  const sums = {};
  for (const name of VENDORED) {
    const rel = `vendor/${name}`;
    const want = lock?.files?.[rel]?.sha256;
    const s = regularSize(path.join(root, rel), VENDOR_MAX_BYTES);
    if (s.error) {
      failures.push(fail('vendor_hash', rel, `${rel} ${s.error}.`));
      continue;
    }
    if (typeof want !== 'string' || !SHA256_RE.test(want)) {
      failures.push(fail('vendor_hash', rel, `look-kit.lock.json has no sha256 for ${rel}.`));
      continue;
    }
    sums[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
    if (sums[name] !== want) failures.push(fail('vendor_hash', rel, `${rel} does not match the sha256 in look-kit.lock.json.`));
  }
  if (failures.length) return { failures, kit: null, fixtures: null };
  const key = sums['look-kit.mjs'];
  if (!kits.has(key)) kits.set(key, import(pathToFileURL(path.join(root, 'vendor', 'look-kit.mjs')).href));
  const kit = await kits.get(key);
  let fixtures = null;
  try {
    fixtures = JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'look-fixtures.json'), 'utf8'));
  } catch {
    failures.push(fail('corpus', 'vendor/look-fixtures.json', 'look-fixtures.json is not valid JSON.'));
  }
  return { failures, kit, fixtures };
}

const sameList = (a, b) => a.length === b.length && a.every((v, n) => v === b[n]);

/** Runs every vendored corpus entry through the vendored parser; the result must agree entry by entry. */
function runCorpus(kit, corpus) {
  const failures = [];
  if (!Array.isArray(corpus)) return [fail('corpus', 'vendor/look-fixtures.json', 'The corpus is not a list.')];
  for (const entry of corpus) {
    const want = entry?.expect ?? {};
    let problem = '';
    try {
      const r = kit.parseLook(entry.text);
      if (r.ok !== want.ok) problem = `expected ok=${want.ok}`;
      else if (!r.ok) problem = r.code === want.code ? '' : `expected code ${want.code}, got ${r.code}`;
      else {
        const dropped = r.dropped.map((d) => d.path).sort();
        const traits = kit.lookTraits(r.look);
        if (!sameList(dropped, [...(want.dropped ?? [])].sort())) problem = 'dropped paths differ';
        else if (traits.animated !== want.animated || !sameList(traits.fonts, want.fonts ?? [])) problem = 'traits differ';
      }
    } catch {
      problem = 'the parser threw';
    }
    if (problem) failures.push(fail('corpus', 'vendor/look-fixtures.json', `Corpus entry "${entry?.name}": ${problem}.`));
  }
  return failures;
}

async function checkOne(kit, dir, id, reencode) {
  const failures = [];
  const rel = `looks/${id}`;
  const add = (code, file, message) => failures.push(fail(code, `${rel}/${file}`, message));

  // meta.json
  let meta = null;
  const metaText = readJsonText(path.join(dir, 'meta.json'), META_MAX_BYTES);
  if (metaText.error) add('meta', 'meta.json', `meta.json ${metaText.error}.`);
  else {
    try {
      meta = JSON.parse(metaText.text);
      if (repeatsMember(metaText.text)) throw new Error('repeat');
    } catch {
      meta = null;
      add('meta', 'meta.json', 'meta.json is not valid JSON or repeats a member name.');
    }
  }
  if (meta !== null && (typeof meta !== 'object' || meta === null || Array.isArray(meta))) {
    meta = null;
    add('meta', 'meta.json', 'meta.json must be an object.');
  }
  if (meta) {
    if (typeof meta.id !== 'string' || !ID_RE.test(meta.id)) add('meta', 'meta.json', 'id must be lower-case letters, digits and hyphens (1 to 48 characters).');
    else if (meta.id !== id) add('meta', 'meta.json', `id "${meta.id}" must match the folder name "${id}".`);
    const name = typeof meta.name === 'string' ? meta.name.normalize('NFC') : null;
    if (name === null || [...name].length < 1 || [...name].length > NAME_MAX_POINTS) {
      add('name_length', 'meta.json', `name must be 1 to ${NAME_MAX_POINTS} characters after NFC normalisation.`);
    }
    if (typeof meta.author !== 'string' || [...meta.author].length < 1 || [...meta.author].length > AUTHOR_MAX_POINTS) {
      add('meta', 'meta.json', `author must be 1 to ${AUTHOR_MAX_POINTS} characters.`);
    }
    if (typeof meta.licence !== 'string' || !LICENCES.has(meta.licence)) {
      add('licence', 'meta.json', 'licence must be one of CC0-1.0, CC-BY-4.0, CC-BY-SA-4.0 or MIT (SPDX id, exact case).');
    }
  }

  // look.json
  const lookText = readJsonText(path.join(dir, 'look.json'), LOOK_MAX_BYTES);
  if (lookText.error) add(lookText.tooBig ? 'look_size' : 'parse', 'look.json', `look.json ${lookText.error}.`);
  else {
    let repeated = false;
    try {
      JSON.parse(lookText.text);
      repeated = repeatsMember(lookText.text);
    } catch {
      // the parser reports the JSON error below
    }
    if (repeated) add('parse', 'look.json', 'look.json repeats a member name.');
    else {
      const r = kit.parseLook(lookText.text);
      if (!r.ok && r.code === 'empty') add('dropped_key', 'look.json', 'Nothing is left of the look after the parser drops its keys (actions, entities, templates and similar).');
      else if (!r.ok) add('parse', 'look.json', `The look is refused: ${r.code} at ${r.path || '/'}.`);
      else if (r.dropped.length) {
        add('dropped_key', 'look.json', `The look holds keys the card would drop: ${r.dropped.slice(0, 5).map((d) => d.path).join(', ')}.`);
      }
    }
  }

  // preview.webp
  const prev = regularSize(path.join(dir, 'preview.webp'), PREVIEW_MAX_BYTES);
  if (prev.error) add('preview', 'preview.webp', `preview.webp ${prev.error}.`);
  else if (reencode) {
    const out = await reencodePreview(fs.readFileSync(path.join(dir, 'preview.webp')));
    if (!out.ok) add('preview', 'preview.webp', `${out.message} (${out.code})`);
  }
  return { failures, id: meta && typeof meta.id === 'string' ? meta.id : null };
}

/** @returns {Promise<{ ok: boolean, failures: { code: string, path: string, message: string }[] }>} */
export async function checkLooks(root, { reencode = true } = {}) {
  try {
    const { failures, kit, fixtures } = await loadVendor(root);
    if (!kit) return { ok: false, failures };
    failures.push(...runCorpus(kit, fixtures));

    const looksDir = path.join(root, 'looks');
    let names = [];
    try {
      names = fs.readdirSync(looksDir).sort();
    } catch {
      // a repository with no looks folder has no looks
    }
    if (names.length > MAX_LOOKS) {
      failures.push(fail('too_many_looks', 'looks', `The gallery holds at most ${MAX_LOOKS} looks; found ${names.length}.`));
      return { ok: false, failures };
    }
    const seen = new Map();
    for (const name of names) {
      const dir = path.join(looksDir, name);
      let st;
      try {
        st = fs.lstatSync(dir);
      } catch {
        continue;
      }
      if (!ID_RE.test(name) || !st.isDirectory()) {
        failures.push(fail('meta', `looks/${name}`, 'Every entry in looks/ must be a folder named with lower-case letters, digits and hyphens.'));
        continue;
      }
      const one = await checkOne(kit, dir, name, reencode);
      failures.push(...one.failures);
      if (one.id) {
        if (seen.has(one.id)) failures.push(fail('duplicate_id', `looks/${name}/meta.json`, `id "${one.id}" is already used by looks/${seen.get(one.id)}.`));
        else seen.set(one.id, name);
      }
    }
    return { ok: failures.length === 0, failures };
  } catch (e) {
    return { ok: false, failures: [fail('parse', '.', `The check stopped: ${String(e?.message ?? e).slice(0, 200)}`)] };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? path.join(here, '..'));
  const result = await checkLooks(root);
  for (const f of result.failures) console.error(`${f.code}  ${f.path}  ${f.message}`);
  console.log(result.ok ? 'look-ci: all checks passed' : `look-ci: ${result.failures.length} failure(s)`);
  process.exit(result.ok ? 0 : 1);
}
