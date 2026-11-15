// scripts/check-looks.mjs#checkLooks(root, { reencode = true }) walks `<root>/looks/<id>/{look.json,meta.json,preview.webp}`
// and resolves { ok, failures: [{ code, path, message }] }. It never throws on a bad tree.
// Codes: vendor_hash, parse, dropped_key, licence, look_size, duplicate_id, name_length, preview, too_many_looks.
// Each fixture tree gets the repo's own vendor/ and look-kit.lock.json, so the vendor check passes unless a test tampers with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkLooks } from '../scripts/check-looks.mjs';
import { REPO, preview } from './fixtures/webp-tools.mjs';

const GOOD_LOOK = '{"grammar":1,"modules":{"icon":{"design":{"color":"#ffffff"}}}}';
const roots = [];
test.after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

function meta(id, over = {}) {
  return { id, name: 'Calm slate', author: 'therealmcsparrow', licence: 'CC0-1.0', ...over };
}

/** Builds a tree with the given looks: { id, look?, meta?, preview? (Buffer | null for none), dir? }. */
function tree(looks, { tamper } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-looks-'));
  roots.push(root);
  fs.cpSync(path.join(REPO, 'vendor'), path.join(root, 'vendor'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'look-kit.lock.json'), path.join(root, 'look-kit.lock.json'));
  for (const l of looks) {
    const dir = path.join(root, 'looks', l.dir ?? l.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dir + '/look.json', l.look ?? GOOD_LOOK);
    fs.writeFileSync(dir + '/meta.json', JSON.stringify(l.meta ?? meta(l.id)));
    if (l.preview !== null) fs.writeFileSync(dir + '/preview.webp', l.preview ?? preview('good.webp'));
  }
  tamper?.(root);
  return root;
}

const codes = (r) => r.failures.map((f) => f.code);
async function assertFails(looks, code, opts) {
  const r = await checkLooks(tree(looks, opts));
  assert.equal(r.ok, false, `expected ${code}`);
  assert.ok(codes(r).includes(code), `expected ${code} in ${JSON.stringify(r.failures)}`);
  for (const f of r.failures) assert.ok(typeof f.path === 'string' && typeof f.message === 'string');
  return r;
}
const pad = (to) => GOOD_LOOK.slice(0, -1) + ' '.repeat(to - GOOD_LOOK.length) + '}';

test('a good look passes', async () => {
  const r = await checkLooks(tree([{ id: 'calm-slate' }]));
  assert.deepEqual(r.failures, []);
  assert.equal(r.ok, true);
});

test('an empty looks folder and several good looks pass', async () => {
  assert.equal((await checkLooks(tree([]))).ok, true);
  const r = await checkLooks(tree([{ id: 'calm-slate' }, { id: 'warm-paper' }, { id: 'night-owl' }]));
  assert.equal(r.ok, true);
});

test('reencode off skips the image decode but still needs a file', async () => {
  const r = await checkLooks(tree([{ id: 'calm-slate', preview: Buffer.from('RIFF....WEBP-not-decodable') }]), { reencode: false });
  assert.equal(r.ok, true);
});

test('a look that does not parse fails', async () => {
  await assertFails([{ id: 'bad-json', look: '{' }], 'parse');
  await assertFails([{ id: 'bad-grammar', look: '{"grammar":99}' }], 'parse');
});

test('an unsafe value refuses the look', async () => {
  const bad = (v) => `{"grammar":1,"card":{"background":${JSON.stringify(v)}}}`;
  for (const v of ['url(https://example.com/x.png)', '@import "x"', 'expression(alert(1))', 'red\\\\61', '<b>x</b>', '{{ states("a.b") }}']) {
    await assertFails([{ id: 'unsafe-value', look: bad(v) }], 'parse');
  }
});

test('a key the parser drops fails the look (actions, entities, templates)', async () => {
  await assertFails([{ id: 'has-action', look: '{"grammar":1,"card":{"tap_action":{"action":"toggle"}}}' }], 'dropped_key');
  await assertFails([{ id: 'has-entity', look: '{"grammar":1,"modules":{"icon":{"entity":"light.kitchen"}}}' }], 'dropped_key');
  await assertFails([{ id: 'has-deep', look: '{"grammar":1,"modules":{"icon":{"design":{"conditional":[]}}}}' }], 'dropped_key');
});

test('a licence outside the allow-list fails, each allowed one passes', async () => {
  for (const licence of ['GPL-3.0-only', 'Apache-2.0', 'mit', 'cc0-1.0', 'Proprietary', '', 'MIT OR GPL-3.0']) {
    await assertFails([{ id: 'bad-licence', meta: meta('bad-licence', { licence }) }], 'licence');
  }
  for (const licence of ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'MIT']) {
    const r = await checkLooks(tree([{ id: 'good-licence', meta: meta('good-licence', { licence }) }]));
    assert.equal(r.ok, true, licence);
  }
});

test('a look over 16 KiB fails, exactly 16 KiB passes', async () => {
  const exact = pad(16 * 1024);
  assert.equal(Buffer.byteLength(exact), 16 * 1024);
  assert.equal((await checkLooks(tree([{ id: 'exact-size', look: exact }]))).ok, true);
  const over = pad(16 * 1024 + 1);
  await assertFails([{ id: 'over-size', look: over }], 'look_size');
});

test('a duplicate id fails', async () => {
  await assertFails([{ id: 'one-look' }, { id: 'two-look', meta: meta('one-look') }], 'duplicate_id');
});

test('a name over 40 code points after NFC fails', async () => {
  const name = (n) => ({ meta: meta('name-look', { name: n }) });
  await assertFails([{ id: 'name-look', ...name('a'.repeat(41)) }], 'name_length');
  await assertFails([{ id: 'name-look', ...name('é'.repeat(41)) }], 'name_length');
  // decomposed: 41 x (e + U+0301) is 82 code points raw and 41 after NFC
  await assertFails([{ id: 'name-look', ...name('é'.repeat(41)) }], 'name_length');
  await assertFails([{ id: 'name-look', ...name('') }], 'name_length');
});

test('a name of 40 code points passes, counted as code points and after NFC', async () => {
  const ok = async (n) => assert.equal((await checkLooks(tree([{ id: 'name-look', meta: meta('name-look', { name: n }) }]))).ok, true, n);
  await ok('a'.repeat(40));
  await ok('\u{1F600}'.repeat(40)); // 80 UTF-16 units, 40 code points
  await ok('é'.repeat(40)); // 80 code points raw, 40 after NFC
});

test('a missing preview fails', async () => {
  await assertFails([{ id: 'no-preview', preview: null }], 'preview');
});

test('a preview that is not a WebP, or not a clean still, fails', async () => {
  await assertFails([{ id: 'png-preview', preview: preview('not-webp.png') }], 'preview');
  await assertFails([{ id: 'text-preview', preview: Buffer.from('hello') }], 'preview');
  await assertFails([{ id: 'anim-preview', preview: preview('animated.webp') }], 'preview');
  await assertFails([{ id: 'wide-preview', preview: preview('side-1025.webp') }], 'preview');
  await assertFails([{ id: 'big-preview', preview: preview('output-too-big.webp') }], 'preview');
  await assertFails([{ id: 'cut-preview', preview: preview('truncated-data.webp') }], 'preview');
});

test('50 looks pass, 51 fail', async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ id: `look-${String(i).padStart(3, '0')}` }));
  assert.equal((await checkLooks(tree(many(50)))).ok, true);
  await assertFails(many(51), 'too_many_looks');
});

test('a vendored file that differs from look-kit.lock.json fails', async () => {
  await assertFails([{ id: 'calm-slate' }], 'vendor_hash', {
    tamper: (root) => fs.appendFileSync(path.join(root, 'vendor', 'look-kit.mjs'), '\n// tampered\n'),
  });
  await assertFails([{ id: 'calm-slate' }], 'vendor_hash', {
    tamper: (root) => fs.appendFileSync(path.join(root, 'vendor', 'look-fixtures.json'), '\n'),
  });
});

test('a missing vendored file fails', async () => {
  await assertFails([{ id: 'calm-slate' }], 'vendor_hash', {
    tamper: (root) => fs.rmSync(path.join(root, 'vendor', 'look-kit.mjs')),
  });
});

test('every failing look is reported, not only the first', async () => {
  const r = await assertFails(
    [{ id: 'bad-one', look: '{' }, { id: 'bad-two', meta: meta('bad-two', { licence: 'GPL-3.0-only' }) }, { id: 'bad-three', preview: null }],
    'parse',
  );
  for (const c of ['licence', 'preview']) assert.ok(codes(r).includes(c), c);
});

// Repository settings the PR check relies on (look-ci runs the PR's own scripts, so these paths need a named owner).
test('CODEOWNERS names each protected path explicitly', () => {
  const lines = fs
    .readFileSync(path.join(REPO, '.github', 'CODEOWNERS'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const owned = (p) =>
    lines.some((l) => {
      const [pattern, ...owners] = l.split(/\s+/);
      return pattern.replace(/^\//, '') === p && owners.some((o) => /^@\S+/.test(o));
    });
  for (const p of ['looks/', '.github/', 'scripts/', 'vendor/', 'look-kit.lock.json', 'package.json', 'package-lock.json']) {
    assert.ok(owned(p), `CODEOWNERS has no owner line for ${p}`);
  }
});

test('sharp is pinned to an exact version in package.json and the lock', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const spec = pkg.dependencies?.sharp ?? pkg.devDependencies?.sharp;
  assert.match(spec ?? '', /^\d+\.\d+\.\d+$/, 'sharp must be an exact x.y.z, no ^ or ~');
  assert.ok(!pkg.dependencies?.sharp || !pkg.devDependencies?.sharp, 'sharp listed once');
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages?.['node_modules/sharp']?.version, spec, 'lock agrees with package.json');
});

test('look-ci is a workflow with install without scripts and a secret scan', () => {
  const yml = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'look-ci.yml'), 'utf8');
  assert.match(yml, /^\s*look-ci:/m, 'job named look-ci (the required check)');
  assert.match(yml, /npm ci --ignore-scripts/);
  assert.match(yml, /gitleaks/i);
  assert.ok(fs.existsSync(path.join(REPO, '.gitleaks.toml')));
});

// The card's rules for an entry's id, author and name (src/contracts/look-index.ts and src/look-kit/verify-index.ts).
const metaFails = async (over) => {
  const r = await checkLooks(tree([{ id: 'calm-slate', meta: meta('calm-slate', over) }]), { reencode: false });
  return !r.ok;
};

test('an author must be a GitHub login: letters, digits and inner hyphens, up to 39 characters', async () => {
  for (const a of ['therealmcsparrow', 'a', 'A1', 'a-b', 'x'.repeat(39)]) assert.equal(await metaFails({ author: a }), false, a);
  for (const a of ['Magic Card', '-abc', '', 'x'.repeat(40), 'a_b', 'é', 'ab\n', 'a b']) assert.equal(await metaFails({ author: a }), true, JSON.stringify(a));
});

test('an id needs 3 to 40 characters and may not end with a hyphen', async () => {
  const idFails = async (id) => !(await checkLooks(tree([{ id, meta: meta(id) }]), { reencode: false })).ok;
  assert.equal(await idFails('abc'), false);
  assert.equal(await idFails('a'.repeat(40)), false);
  for (const id of ['a', 'ab', 'a'.repeat(41), 'a'.repeat(48), 'abc-']) assert.equal(await idFails(id), true, id);
});

test('a name with a control, line separator or bidirectional character is refused', async () => {
  for (const c of ['\u0000', '\u001f', '\u007f', '\u0085', '\u061c', '\u200e', '\u200f', '\u2028', '\u2029', '\u202e', '\u2066', '\u2069']) {
    assert.equal(await metaFails({ name: `Calm${c}slate` }), true, `U+${c.codePointAt(0).toString(16)}`);
  }
  assert.equal(await metaFails({ name: 'Calm slate' }), false);
});

// The vendored kit exposes no regexes, so the values are compared with the card's source when a sibling checkout exists;
// the tables above pin the behaviour either way.
const cardIndex = path.join(REPO, '..', 'magic-card', 'src', 'contracts', 'look-index.ts');
test('check-looks uses the card contract values for id, author and name', { skip: !fs.existsSync(cardIndex) && 'no card checkout' }, async () => {
  const src = fs.readFileSync(cardIndex, 'utf8');
  const take = (name) => new RegExp(`export const ${name} = (/.*/);`).exec(src)[1];
  const mine = await import('../scripts/check-looks.mjs');
  assert.equal(String(mine.ID_RE), take('LOOK_ID_RE'));
  assert.equal(String(mine.AUTHOR_RE), take('LOOK_AUTHOR_RE'));
  assert.equal(mine.NAME_MAX_POINTS, Number(/LOOK_NAME_MAX_CHARS = (\d+)/.exec(src)[1]));
});
