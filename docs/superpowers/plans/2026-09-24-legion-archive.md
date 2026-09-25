# Legion Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the Accolades and Rank Requirements Discord forum exports as
site pages (`/accolades…`, `/ranks…`) that only signed-in holders of the
XVIIIth Legion role can read. Plaintext never reaches git, the deployed site,
or any unauthorized HTTP response.

**Architecture:** A local seal script encrypts the untouched exports
(AES-256-GCM, opaque filenames) and publishes the ciphertext as a GitHub
Release. The deploy downloads and verifies it into `public/archive/`. The
builds API gains `GET /archive/key`, which hands the key only to live
role-holders. The browser decrypts in memory, then parses Discord markdown
into an AST and renders it with Vue render functions. All links resolve
in-site through a pure resolver plus a sealed fix overlay.

**Tech Stack:** Vue 3 + Pinia + vue-router 5, Vite 8, WebCrypto (browser and
Node 20), Bun server, Vitest 3 + fast-check + Stryker, Playwright e2e via
docker compose.

**Spec:** `docs/superpowers/specs/2026-09-24-legion-archive-design.md`

## Global Constraints

- **Public repo: nothing committed may contain archive content.** That
  includes plan updates, commit messages, test fixtures, and PR text. Only
  the synthetic fixture generator (Task 7) produces content-shaped data, and
  only into temp dirs.
- Input exports are never mutated. Transformations happen at render time or
  in `archive-export/link-fixes.json`.
- No rendered `href` may point at `discord.com`, `discordapp.com`, or
  `discord.gg`.
- Role gate: `ARCHIVE_ROLE_ID=1377787723976409211`. Guild:
  `1322056087792521269`.
- Cipher: AES-256-GCM, 96-bit random nonce, 128-bit tag, AAD
  `"1|<logical-path>"`, file layout `"LAR\x01" ‖ nonce ‖ ciphertext‖tag`.
  Keys are derived from one 32-byte `ARCHIVE_KEY` via HKDF-SHA256 (salt
  `legion-archive`, info `enc` / `name`). `kid` = first 16 hex chars of
  SHA-256(raw key).
- Opaque names = HMAC-SHA256(nameKey, logical path) truncated to 32 hex,
  plus `.bin`. Logical paths are `index` and `<collectionKey>/assets/<file>`.
- The key lives only in memory in the browser, never in localStorage or
  sessionStorage. Server responses carry `Cache-Control: no-store`.
- Fail closed: any uncertainty gives 401, 403, or 503, never the key.
- Message anchors are `id="m-<messageId>"`. The thread's starter message
  (id == thread id) is the top of the page and gets no hash.
- Document-style rendering: only `type` 0 and 19 messages, ordered by
  `position` then snowflake. No author or timestamp.
- This host has no global bun. Use `node_modules/.bin/bun` (repo-local
  1.4.2) or `export PATH="$PWD/node_modules/.bin:$PATH"`. All shell steps
  below assume that PATH export.
- Test bar: 100% coverage and 100% Stryker mutation score on
  `src/lib/archive/{crypto,links,markdown,audit}.js` and
  `server/src/archiveKey.js`. Any equivalent mutant must carry an inline
  `// Stryker disable next-line <mutator>: <reason>` comment. Assert
  behavior, never logs or mock-call counts.
- Test files, the leak guard, and the fixture generator must never contain
  the literal JSON-key signatures they scan for. Build them by concatenation
  (`'"guild' + '_id":'`) so the pre-commit guard doesn't block its own
  tests.

## Review Focus

1. **A member follows a link to a specific message but isn't signed in.**
   After the Discord round-trip they should land on that message, not the
   top of the thread. `discordAuth` intentionally drops hashes (a test pins
   this), so the archive stashes a validated `#m-…` anchor itself. The test
   is in Task 10.
2. **A deep link loaded cold** (`/ranks/<id>#m-<id>` through the Pages 404
   redirect) must scroll to the anchor *after* the async decrypt finishes,
   not before. The test is in Task 10.
3. **Discord rate-limits the role check (429)** when several members open
   the page at once. They should see a retryable "couldn't be reached", not
   "restricted". Tests are in Task 5 (server maps 429 to 503) and Task 9
   (the client maps 503 to the `unavailable` state with Retry).
4. **One huge or corrupt attachment** (the export has a 27 MB one) must not
   blank the page or block text. Images load lazily and fail individually
   to their alt text. The test is in Task 10.
5. **Signing out while viewing** must remove the content and revoke every
   blob URL immediately, not on the next navigation. Tests are in Task 9
   (store) and Task 11 (e2e).

---

## File map

| File | Responsibility |
|---|---|
| `archive-export/` (gitignored) | plaintext exports + `collections.json` + `link-fixes.json` + `.env` |
| `src/lib/archive/crypto.js` | seal/open/opaqueName/deriveKeys (browser + Node) |
| `src/lib/archive/links.js` | parse Discord refs, link index, resolve, validate fixes |
| `src/lib/archive/markdown.js` | Discord markdown → AST, `plainText` |
| `src/lib/archive/model.js` | decrypted index → collections/threads, asset lookups |
| `src/lib/archive/audit.js` | whole-archive validation (links, mentions, assets) |
| `src/lib/archive/registry.js` | committed collection registry (no content) |
| `src/lib/archive/client.js` | key fetch, index fetch/decrypt, asset → blob URL |
| `src/lib/archive/buildConfig.js` | build-time `ARCHIVE_KID` / `ARCHIVE_BASE` |
| `src/stores/archive.js` | Pinia store: status, archive, blob cache, reset |
| `src/components/archive/*` | gate, thread, markdown renderer, image |
| `src/views/ArchiveView.vue` | route view for both collections |
| `server/src/archiveKey.js` | pure key-endpoint handler |
| `scripts/lib/archive-seal.mjs` | seal/unseal/fetch/verify library |
| `scripts/seal-archive.mjs` | CLI: keygen, audit, seal, fetch, unseal |
| `scripts/archive-leak-guard.mjs` | staged/tracked plaintext guard |
| `scripts/scan-dist.mjs` | post-build plaintext scan |
| `scripts/archive-fixture.mjs` | synthetic fixture generator (tests + e2e) |

---

### Task 1: Quarantine the plaintext and install the leak guard

**Files:**
- Create: `scripts/archive-leak-guard.mjs`, `scripts/archive-leak-guard.test.mjs`
- Modify: `.gitignore`, `.husky/pre-commit`, `vitest.config.js`

**Interfaces:**
- Produces: `checkPath(path: string) → string|null` (reason, or null if
  allowed). `checkContent(path: string, text: string) → string|null`.
  `checkHash(path: string, sha256: string, known: Set<string>) → string|null`
  catches an export image copied anywhere under any name. CLI
  `node scripts/archive-leak-guard.mjs --staged | --tracked` exits 1 with
  reasons on stdout. When `archive-export/` exists, it loads every
  `assets.json` sha256 as `known`.

- [ ] **Step 1: Snapshot hashes under their future paths, then move the
  exports.** Run from the repo root:

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
{ for c in accolades rank-requirements; do
    (cd src/data/$c && find . -type f -print0 | xargs -0 sha256sum | sed "s#  \./#  $c/data/#")
    (cd public/$c   && find . -type f -print0 | xargs -0 sha256sum | sed "s#  \./#  $c/assets/#")
  done; } | sort -k2 > /tmp/archive-before.sha
mkdir -p archive-export/accolades archive-export/rank-requirements
mv src/data/accolades         archive-export/accolades/data
mv public/accolades           archive-export/accolades/assets
mv src/data/rank-requirements archive-export/rank-requirements/data
mv public/rank-requirements   archive-export/rank-requirements/assets
(cd archive-export && find accolades rank-requirements -type f -print0 | xargs -0 sha256sum) | sort -k2 > /tmp/archive-after.sha
```

- [ ] **Step 2: Verify the move changed nothing** (same path, same hash,
  every file):

```bash
diff /tmp/archive-before.sha /tmp/archive-after.sha && echo "IDENTICAL: $(wc -l < /tmp/archive-after.sha) files"
```

Expected: `IDENTICAL: 306 files`. Also verify images against the exporter's
own hashes:

```bash
node -e '
const fs=require("fs"),c=require("crypto");let n=0;
for(const k of ["accolades","rank-requirements"]){const A=JSON.parse(fs.readFileSync(`archive-export/${k}/data/assets.json`));
for(const v of Object.values(A)){const b=fs.readFileSync(`archive-export/${k}/assets/${v.file}`);
if(c.createHash("sha256").update(b).digest("hex")!==v.sha256)throw new Error("MISMATCH "+v.file);n++}}console.log("assets.json verified",n)'
```

Expected: `assets.json verified 256`. (The accolades `assets.json` lists 204
entries for 204 files, and ranks lists 52 for 52.)

- [ ] **Step 3: Write `archive-export/collections.json`** (local only). The
  ToC thread ids come from each export's `index.json`: it's the thread whose
  name starts with the collection's table-of-contents title. Pick them by
  reading `archive-export/*/data/index.json`, and don't paste the names
  anywhere committed.

```bash
node -e '
const fs=require("fs");const pick=(dir,re)=>JSON.parse(fs.readFileSync(`archive-export/${dir}/data/index.json`)).find(t=>re.test(t.name)).id;
fs.writeFileSync("archive-export/collections.json",JSON.stringify({
  accolades:{tocThreadId:pick("accolades",/table of contents/i)},
  ranks:{tocThreadId:pick("rank-requirements",/table of contents/i)}},null,2)+"\n");
console.log(fs.readFileSync("archive-export/collections.json","utf8"))'
```

Expected: two 18–19 digit ids.

- [ ] **Step 4: Tighten `.gitignore`.** Replace the Legion Archive block
  added earlier with:

```gitignore
# Legion Archive: plaintext Discord exports are internal-only and must never
# be committed (public repo). Only sealed ciphertext ships — see
# docs/superpowers/specs/2026-09-24-legion-archive-design.md
archive-export/
public/archive/
public/archive-e2e/
e2e/.archive/
public/accolades/
public/rank-requirements/
src/data/accolades/
src/data/rank-requirements/
```

- [ ] **Step 5: Extend vitest's include** so scripts and server tests run.
  In `vitest.config.js`:

```js
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.js', 'scripts/**/*.test.mjs', 'server/**/*.test.js'],
  },
})
```

- [ ] **Step 6: Write the failing guard tests.** Create
  `scripts/archive-leak-guard.test.mjs`:

```js
import { describe, it, expect } from 'vitest'
import { checkPath, checkContent } from './archive-leak-guard.mjs'

// Signatures are assembled at runtime so this file never contains them
// literally (the guard would otherwise block committing its own tests).
const K = (name) => '"' + name + '":'
const GUILD = K('guild' + '_id')
const MENTION_ROLES = K('mention' + '_roles')
const TAGS = K('available' + '_tags')

describe('checkPath', () => {
  it.each([
    'archive-export/accolades/data/forum.json',
    'archive-export/.env',
    'public/archive/0123abcd.bin',
    'public/archive-e2e/x.bin',
    'e2e/.archive/lock.json',
    'public/accolades/emoji-1.png',
    'public/rank-requirements/att-1.png',
    'src/data/accolades/index.json',
    'src/data/rank-requirements/threads/1.json',
    'nested/archive-export/x',
    'ARCHIVE-EXPORT/x', // case-insensitive filesystems (Windows host)
  ])('blocks %s', (p) => expect(checkPath(p)).toMatch(/archive/i))

  it.each([
    'src/lib/archive/crypto.js',
    'scripts/archive-leak-guard.mjs',
    'archive.lock.json',
    'docs/superpowers/specs/2026-09-24-legion-archive-design.md',
    'public/favicon.svg',
    'src/data/discord-members.json',
    'src/components/archive/ArchiveGate.vue',
  ])('allows %s', (p) => expect(checkPath(p)).toBeNull())

  it('rejects non-string input rather than allowing it', () => {
    expect(checkPath(undefined)).toMatch(/invalid/i)
    expect(checkPath('')).toMatch(/invalid/i)
  })
})

describe('checkContent', () => {
  it('blocks text carrying two or more Discord export JSON signatures', () => {
    expect(checkContent('x.json', `{${GUILD}"1",${MENTION_ROLES}[]}`)).toMatch(/export/i)
    expect(checkContent('x.js', `a ${TAGS} b ${GUILD}`)).toMatch(/export/i)
  })
  it('allows a single signature (e.g. docs mentioning one field)', () => {
    expect(checkContent('x.md', `the ${GUILD} field`)).toBeNull()
  })
  it('allows ordinary code that uses the fields by property access', () => {
    expect(checkContent('m.js', 'forum.available_tags.map(t => t.guild_id)')).toBeNull()
  })
  it('blocks stray sealed files anywhere; ordinary images pass', () => {
    expect(checkContent('public/x.bin', 'LAR\u0001rest')).toMatch(/sealed/i)
    expect(checkContent('src/assets/hero.png', '\u0089PNG')).toBeNull()
  })
})

describe('checkHash', () => {
  const known = new Set(['a'.repeat(64)])
  it('blocks a file whose bytes equal an export asset, whatever its name', () => {
    expect(checkHash('src/assets/renamed.png', 'a'.repeat(64), known)).toMatch(/export asset/i)
  })
  it('allows unknown hashes and works with an empty known set (CI)', () => {
    expect(checkHash('x.png', 'b'.repeat(64), known)).toBeNull()
    expect(checkHash('x.png', 'a'.repeat(64), new Set())).toBeNull()
  })
})
```

Update the import line at the top of that test file to
`import { checkPath, checkContent, checkHash } from './archive-leak-guard.mjs'`.

- [ ] **Step 7: Run and confirm it fails.** Run
  `bun run test scripts/archive-leak-guard.test.mjs`. Expected: FAIL with
  "Failed to load … archive-leak-guard.mjs".

- [ ] **Step 8: Implement `scripts/archive-leak-guard.mjs`.**

```js
/**
 * Refuses to let plaintext Legion Archive exports (or stray sealed files)
 * into git. The repo is public: anything committed is published for good.
 *   node scripts/archive-leak-guard.mjs --staged   (pre-commit)
 *   node scripts/archive-leak-guard.mjs --tracked  (CI)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const BLOCKED = [
  /(^|\/)archive-export(\/|$)/i,
  /(^|\/)public\/archive(-e2e)?\//i,
  /(^|\/)e2e\/\.archive\//i,
  /(^|\/)public\/(accolades|rank-requirements)\//i,
  /(^|\/)src\/data\/(accolades|rank-requirements)\//i,
]
// JSON-key signatures of a raw Discord export, assembled so this file never
// contains them literally.
const SIGNATURES = ['guild' + '_id', 'mention' + '_roles', 'available' + '_tags', 'applied' + '_tags', 'permission' + '_overwrites'].map(
  (k) => '"' + k + '":',
)
const SEALED_MAGIC = 'LAR\u0001'

export function checkPath(p) {
  if (typeof p !== 'string' || p === '') return 'invalid path'
  const norm = p.replace(/\\/g, '/')
  return BLOCKED.some((re) => re.test(norm)) ? `archive path must never be committed: ${p}` : null
}

export function checkContent(p, text) {
  const hits = SIGNATURES.filter((s) => text.includes(s)).length
  if (hits >= 2) return `looks like a raw Discord export (${hits} signatures): ${p}`
  if (text.startsWith(SEALED_MAGIC)) return `sealed archive file outside the release flow: ${p}`
  return null
}

export function checkHash(p, sha256, known) {
  return known.has(sha256) ? `bytes identical to a Discord export asset: ${p}` : null
}

function knownAssetHashes() {
  const known = new Set()
  for (const dir of ['accolades', 'rank-requirements']) {
    const f = `archive-export/${dir}/data/assets.json`
    if (!existsSync(f)) continue
    for (const a of Object.values(JSON.parse(readFileSync(f, 'utf8')))) known.add(a.sha256)
  }
  return known
}

function git(args) {
  return execFileSync('git', args, { encoding: 'buffer', maxBuffer: 1 << 30 })
}

function run(mode) {
  const list =
    mode === '--staged'
      ? git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'])
      : git(['ls-files', '-z'])
  const paths = list.toString('utf8').split('\0').filter(Boolean)
  const known = knownAssetHashes()
  const problems = []
  for (const p of paths) {
    const byPath = checkPath(p)
    if (byPath) {
      problems.push(byPath)
      continue
    }
    const blob = mode === '--staged' ? git(['show', `:${p}`]) : git(['show', `HEAD:${p}`])
    const byContent = checkContent(p, blob.subarray(0, 4 << 20).toString('latin1'))
    if (byContent) problems.push(byContent)
    const byHash = checkHash(p, createHash('sha256').update(blob).digest('hex'), known)
    if (byHash) problems.push(byHash)
  }
  if (problems.length) {
    console.log(problems.join('\n'))
    process.exit(1)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2]
  if (mode !== '--staged' && mode !== '--tracked') {
    console.log('usage: archive-leak-guard.mjs --staged|--tracked')
    process.exit(2)
  }
  run(mode)
}
```

- [ ] **Step 9: Run the tests; expect PASS.** Then run it against the real
  repo: `node scripts/archive-leak-guard.mjs --tracked; echo $?`. Expected:
  `0`.

- [ ] **Step 10: Wire it into pre-commit.** Replace `.husky/pre-commit` with:

```sh
node scripts/archive-leak-guard.mjs --staged || exit 1
if command -v bun >/dev/null 2>&1; then
  bun run test
else
  npx vitest run
fi
```

- [ ] **Step 11: Prove the hook blocks a leak.** Run
  `git add -f archive-export/collections.json && git commit -m test`.
  Expected: the commit is refused with "archive path must never be
  committed". Then `git reset -q archive-export/collections.json`.

- [ ] **Step 12: Commit.**

```bash
git add .gitignore .husky/pre-commit vitest.config.js scripts/archive-leak-guard.mjs scripts/archive-leak-guard.test.mjs
git commit -m "archive: quarantine plaintext exports and guard commits against leaks"
```

---

### Task 2: Crypto core

**Files:**
- Create: `src/lib/archive/crypto.js`, `src/lib/archive/crypto.test.js`, `stryker.config.mjs`
- Modify: `package.json` (dev deps + scripts), `vitest.config.js` (coverage)

**Interfaces:**
- Produces (all async unless noted):
  - `deriveKeys(raw: Uint8Array(32)) → {encKey, nameKey, kid: string}`
  - `seal(keys, logicalPath: string, data: Uint8Array) → Uint8Array`
  - `open(keys, logicalPath: string, sealed: Uint8Array) → Uint8Array`
  - `opaqueName(keys, logicalPath) → string` (32 hex)
  - sync: `keyFromBase64(s) → Uint8Array(32)`, `keyToBase64(bytes) → string`, `toHex(bytes) → string`
  - `class ArchiveCryptoError extends Error { code: 'KEY'|'PATH'|'INPUT'|'FORMAT'|'AUTH' }`

- [ ] **Step 1: Add dev tooling.**

```bash
bun add -d fast-check @stryker-mutator/core @stryker-mutator/vitest-runner @vitest/coverage-v8@3 @vue/test-utils
```

Add these scripts to `package.json`:

```json
"test:coverage": "vitest run --coverage",
"test:mutation": "stryker run"
```

- [ ] **Step 2: Coverage thresholds.** Extend `vitest.config.js`:

```js
import { defineConfig } from 'vitest/config'

const FULL = { lines: 100, branches: 100, functions: 100, statements: 100 }
const GATED = [
  'src/lib/archive/crypto.js',
  'src/lib/archive/links.js',
  'src/lib/archive/markdown.js',
  'src/lib/archive/audit.js',
  'server/src/archiveKey.js',
]

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.js', 'scripts/**/*.test.mjs', 'server/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: GATED,
      thresholds: Object.fromEntries(GATED.map((f) => [f, FULL])),
    },
  },
})
```

- [ ] **Step 3: Stryker config.** Create `stryker.config.mjs`:

```js
/** Mutation gate for the Legion Archive's security- and fidelity-critical units. */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.config.js' },
  mutate: [
    'src/lib/archive/crypto.js',
    'src/lib/archive/links.js',
    'src/lib/archive/markdown.js',
    'src/lib/archive/audit.js',
    'server/src/archiveKey.js',
  ],
  coverageAnalysis: 'perTest',
  thresholds: { high: 100, low: 100, break: 100 },
  reporters: ['clear-text', 'progress'],
  ignoreStatic: true,
}
```

Files that don't exist yet are skipped. The gate tightens as each task
lands its module.

- [ ] **Step 4: Write the failing tests.** Create
  `src/lib/archive/crypto.test.js`:

```js
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { createHash, randomBytes } from 'node:crypto'
import {
  deriveKeys, seal, open, opaqueName, keyFromBase64, keyToBase64, toHex, ArchiveCryptoError,
} from './crypto'

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i)
const OTHER = Uint8Array.from({ length: 32 }, (_, i) => 255 - i)
const enc = (s) => new TextEncoder().encode(s)

async function code(promise) {
  try {
    await promise
  } catch (e) {
    expect(e).toBeInstanceOf(ArchiveCryptoError)
    return e.code
  }
  throw new Error('expected rejection')
}
function syncCode(fn) {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ArchiveCryptoError)
    return e.code
  }
  throw new Error('expected throw')
}

describe('deriveKeys', () => {
  it('kid is the first 16 hex chars of sha256(raw key), computed independently', async () => {
    const { kid } = await deriveKeys(KEY)
    expect(kid).toBe(createHash('sha256').update(KEY).digest('hex').slice(0, 16))
  })
  it('different keys give different kids', async () => {
    expect((await deriveKeys(KEY)).kid).not.toBe((await deriveKeys(OTHER)).kid)
  })
  it.each([
    ['empty', new Uint8Array(0)],
    ['31 bytes', new Uint8Array(31)],
    ['33 bytes', new Uint8Array(33)],
    ['string', 'x'.repeat(32)],
    ['number array', Array(32).fill(1)],
    ['null', null],
    ['Uint16Array', new Uint16Array(16)],
  ])('rejects %s with code KEY', async (_, bad) => {
    expect(await code(deriveKeys(bad))).toBe('KEY')
  })
  it('accepts a Node Buffer (seal script path)', async () => {
    await expect(deriveKeys(Buffer.from(KEY))).resolves.toHaveProperty('kid')
  })
})

describe('seal/open', () => {
  it('round-trips arbitrary bytes under arbitrary logical paths', async () => {
    const keys = await deriveKeys(KEY)
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 2048 }), fc.string({ minLength: 1, maxLength: 80 }), async (data, p) => {
        expect(await open(keys, p, await seal(keys, p, data))).toEqual(data)
      }),
      { numRuns: 150 },
    )
  })
  it('round-trips empty plaintext', async () => {
    const keys = await deriveKeys(KEY)
    expect(await open(keys, 'p', await seal(keys, 'p', new Uint8Array(0)))).toEqual(new Uint8Array(0))
  })
  it('layout is magic ‖ 12-byte nonce ‖ ciphertext ‖ 16-byte tag', async () => {
    const keys = await deriveKeys(KEY)
    const out = await seal(keys, 'p', enc('abc'))
    expect(Array.from(out.subarray(0, 4))).toEqual([0x4c, 0x41, 0x52, 0x01])
    expect(out.length).toBe(4 + 12 + 3 + 16)
  })
  it('never reuses a nonce (and never produces identical output) for identical input', async () => {
    const keys = await deriveKeys(KEY)
    const nonces = new Set()
    for (let i = 0; i < 500; i++) nonces.add(toHex((await seal(keys, 'p', enc('same'))).subarray(4, 16)))
    expect(nonces.size).toBe(500)
  })
  it('every single-bit flip is rejected (FORMAT in the magic, AUTH elsewhere)', async () => {
    const keys = await deriveKeys(KEY)
    const sealed = await seal(keys, 'a/b.png', enc('flip me'))
    for (let byte = 0; byte < sealed.length; byte++) {
      for (let bit = 0; bit < 8; bit++) {
        const t = sealed.slice()
        t[byte] ^= 1 << bit
        expect(await code(open(keys, 'a/b.png', t))).toBe(byte < 4 ? 'FORMAT' : 'AUTH')
      }
    }
  })
  it('wrong key → AUTH', async () => {
    const sealed = await seal(await deriveKeys(KEY), 'p', enc('x'))
    expect(await code(open(await deriveKeys(OTHER), 'p', sealed))).toBe('AUTH')
  })
  it('wrong logical path (swapped file) → AUTH', async () => {
    const keys = await deriveKeys(KEY)
    const sealed = await seal(keys, 'accolades/assets/a.png', enc('x'))
    expect(await code(open(keys, 'accolades/assets/b.png', sealed))).toBe('AUTH')
  })
  it.each([0, 1, 4, 15, 16, 31])('truncation to %i bytes → FORMAT', async (n) => {
    const keys = await deriveKeys(KEY)
    const sealed = await seal(keys, 'p', enc('hello world'))
    expect(await code(open(keys, 'p', sealed.subarray(0, n)))).toBe('FORMAT')
  })
  it('truncation that keeps the header but cuts the tag → AUTH', async () => {
    const keys = await deriveKeys(KEY)
    const sealed = await seal(keys, 'p', enc('hello world'))
    expect(await code(open(keys, 'p', sealed.subarray(0, sealed.length - 1)))).toBe('AUTH')
  })
  it('a future format version byte → FORMAT', async () => {
    const keys = await deriveKeys(KEY)
    const sealed = await seal(keys, 'p', enc('x'))
    sealed[3] = 0x02
    expect(await code(open(keys, 'p', sealed))).toBe('FORMAT')
  })
  it.each([['', 'PATH'], ['x'.repeat(513), 'PATH'], [null, 'PATH'], [42, 'PATH']])(
    'path %j → %s on seal and open',
    async (p, c) => {
      const keys = await deriveKeys(KEY)
      expect(await code(seal(keys, p, enc('x')))).toBe(c)
      expect(await code(open(keys, p, new Uint8Array(40)))).toBe(c)
    },
  )
  it('accepts a 512-char path (boundary)', async () => {
    const keys = await deriveKeys(KEY)
    const p = 'x'.repeat(512)
    expect(await open(keys, p, await seal(keys, p, enc('ok')))).toEqual(enc('ok'))
  })
  it.each([['string', 'abc'], ['array', [1, 2]], ['null', null]])('non-bytes data (%s) → INPUT', async (_, d) => {
    const keys = await deriveKeys(KEY)
    expect(await code(seal(keys, 'p', d))).toBe('INPUT')
    expect(await code(open(keys, 'p', d))).toBe('INPUT')
  })
})

describe('opaqueName', () => {
  it('is 32 lowercase hex, deterministic, and path- and key-sensitive', async () => {
    const a = await deriveKeys(KEY)
    const b = await deriveKeys(OTHER)
    const n = await opaqueName(a, 'accolades/assets/emoji-1.png')
    expect(n).toMatch(/^[0-9a-f]{32}$/)
    expect(await opaqueName(a, 'accolades/assets/emoji-1.png')).toBe(n)
    expect(await opaqueName(a, 'accolades/assets/emoji-2.png')).not.toBe(n)
    expect(await opaqueName(b, 'accolades/assets/emoji-1.png')).not.toBe(n)
  })
  it('rejects bad paths', async () => {
    expect(await code(opaqueName(await deriveKeys(KEY), ''))).toBe('PATH')
  })
})

describe('base64 key codec', () => {
  it('round-trips random 32-byte keys', () => {
    for (let i = 0; i < 50; i++) {
      const k = new Uint8Array(randomBytes(32))
      expect(keyFromBase64(keyToBase64(k))).toEqual(k)
    }
  })
  it.each([
    '', 'AAAA', 'A'.repeat(43), 'A'.repeat(44), `${'A'.repeat(43)}= `, `${'A'.repeat(42)}!=`, null, 7,
    Buffer.alloc(33).toString('base64'),
  ])('rejects %j with code KEY', (s) => {
    expect(syncCode(() => keyFromBase64(s))).toBe('KEY')
  })
  it('keyToBase64 rejects non-32-byte input', () => {
    expect(syncCode(() => keyToBase64(new Uint8Array(31)))).toBe('KEY')
  })
  it('toHex pads single-digit bytes', () => {
    expect(toHex(Uint8Array.of(0, 15, 255))).toBe('000fff')
  })
})
```

- [ ] **Step 5: Run and confirm it fails.** Run
  `bun run test src/lib/archive/crypto.test.js`. Expected: FAIL (module not
  found).

- [ ] **Step 6: Implement `src/lib/archive/crypto.js`.**

```js
/**
 * Legion Archive sealing. Runs unchanged in the browser (decrypt) and in
 * Node/Bun (seal script, tests) via WebCrypto. Layout of a sealed file:
 *   "LAR" 0x01 ‖ 12-byte nonce ‖ AES-256-GCM ciphertext ‖ 16-byte tag
 * AAD binds each file to "<format>|<logical path>" so ciphertexts can't be
 * swapped between names. See docs/superpowers/specs/2026-09-24-legion-archive-design.md.
 */
export const FORMAT_VERSION = 1
const MAGIC = Uint8Array.of(0x4c, 0x41, 0x52, FORMAT_VERSION)
const NONCE_BYTES = 12
const TAG_BYTES = 16
const MAX_PATH = 512
const KEY_B64 = /^[A-Za-z0-9+/]{43}=$/
const enc = new TextEncoder()
const subtle = () => globalThis.crypto.subtle

export class ArchiveCryptoError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ArchiveCryptoError'
    this.code = code
  }
}

function isBytes(v) {
  return v instanceof Uint8Array
}
function assertPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH) {
    throw new ArchiveCryptoError('PATH', `logical path must be a string of 1-${MAX_PATH} chars`)
  }
}
function assertBytes(v) {
  if (!isBytes(v)) throw new ArchiveCryptoError('INPUT', 'expected a Uint8Array')
}
const aad = (p) => enc.encode(`${FORMAT_VERSION}|${p}`)

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function deriveKeys(raw) {
  if (!isBytes(raw) || raw.length !== 32) throw new ArchiveCryptoError('KEY', 'archive key must be exactly 32 bytes')
  const base = await subtle().importKey('raw', raw, 'HKDF', false, ['deriveKey'])
  const hkdf = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('legion-archive'), info: enc.encode(info) })
  const encKey = await subtle().deriveKey(hkdf('enc'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const nameKey = await subtle().deriveKey(hkdf('name'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
  const kid = toHex(new Uint8Array(await subtle().digest('SHA-256', raw))).slice(0, 16)
  return { encKey, nameKey, kid }
}

export async function seal(keys, path, data) {
  assertPath(path)
  assertBytes(data)
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const ct = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(path), tagLength: 128 }, keys.encKey, data),
  )
  const out = new Uint8Array(MAGIC.length + NONCE_BYTES + ct.length)
  out.set(MAGIC, 0)
  out.set(nonce, MAGIC.length)
  out.set(ct, MAGIC.length + NONCE_BYTES)
  return out
}

export async function open(keys, path, sealed) {
  assertPath(path)
  assertBytes(sealed)
  if (sealed.length < MAGIC.length + NONCE_BYTES + TAG_BYTES) throw new ArchiveCryptoError('FORMAT', 'sealed data too short')
  for (let i = 0; i < MAGIC.length; i++) {
    if (sealed[i] !== MAGIC[i]) throw new ArchiveCryptoError('FORMAT', 'not a v1 Legion Archive file')
  }
  const nonce = sealed.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES)
  try {
    return new Uint8Array(
      await subtle().decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aad(path), tagLength: 128 },
        keys.encKey,
        sealed.subarray(MAGIC.length + NONCE_BYTES),
      ),
    )
  } catch {
    throw new ArchiveCryptoError('AUTH', 'archive file failed authentication (wrong key, wrong name, or tampered)')
  }
}

export async function opaqueName(keys, path) {
  assertPath(path)
  return toHex(new Uint8Array(await subtle().sign('HMAC', keys.nameKey, enc.encode(path)))).slice(0, 32)
}

export function keyFromBase64(s) {
  if (typeof s !== 'string' || !KEY_B64.test(s)) throw new ArchiveCryptoError('KEY', 'ARCHIVE_KEY must be 32 bytes of base64')
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

export function keyToBase64(bytes) {
  if (!isBytes(bytes) || bytes.length !== 32) throw new ArchiveCryptoError('KEY', 'archive key must be exactly 32 bytes')
  return btoa(String.fromCharCode(...bytes))
}
```

Note: `Buffer.alloc(33).toString('base64')` is 44 chars ending in `A=`,
which doesn't match the 43+`=` shape. The regex alone enforces 32 bytes.

- [ ] **Step 7: Run the tests; expect PASS.** Then run
  `bun run test:coverage`. Expected: `crypto.js` at 100/100/100/100.

- [ ] **Step 8: Run mutation.** Run `bun run test:mutation`. Expected: a
  mutation score of 100% for `crypto.js`. Kill each survivor with a new
  test. Only a truly equivalent mutant may get a
  `// Stryker disable next-line …: reason` comment. One likely equivalent:
  `tagLength: 128` removed (128 is WebCrypto's default).

- [ ] **Step 9: Commit.**

```bash
git add package.json bun.lock vitest.config.js stryker.config.mjs src/lib/archive/crypto.js src/lib/archive/crypto.test.js
git commit -m "archive: AES-256-GCM seal/open with HKDF subkeys and opaque names"
```

---

### Task 3: Link resolver

**Files:**
- Create: `src/lib/archive/links.js`, `src/lib/archive/links.test.js`, `src/lib/archive/registry.js`

**Interfaces:**
- Produces:
  - `registry.js`: `COLLECTIONS: {key, prefix, exportDir, label}[]`, `GUILD_ID`
  - `parseDiscordRef(s) → {guildId, channelId, messageId|null} | null`
  - `isDiscordHost(href) → boolean`
  - `buildLinkIndex(collections: {prefix, threads: Map<id, {messages: {id}[]}>}[]) → Map<threadId, {prefix, messageIds: Set}>`
  - `resolveRef(ref, linkIndex, fixes) → {kind:'route', to:{path, hash}} | {kind:'text'} | {kind:'unaccounted', reason}`
  - `validateFixes(fixes, linkIndex) → string[]`

- [ ] **Step 1: Registry.** Create `src/lib/archive/registry.js`:

```js
/** Collections served by the Legion Archive. No content here — ids live in the sealed index. */
export const GUILD_ID = '1322056087792521269'

export const COLLECTIONS = [
  { key: 'accolades', prefix: '/accolades', exportDir: 'accolades', label: 'Accolades' },
  { key: 'ranks', prefix: '/ranks', exportDir: 'rank-requirements', label: 'Ranks' },
]
```

- [ ] **Step 2: Write the failing tests.** Create
  `src/lib/archive/links.test.js`:

```js
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { parseDiscordRef, isDiscordHost, buildLinkIndex, resolveRef, validateFixes } from './links'
import { GUILD_ID } from './registry'

const G = GUILD_ID
const T1 = '100000000000000001' // accolades thread
const M1 = '100000000000000011' // message in T1
const T2 = '200000000000000001' // ranks thread
const EXT = '500000000000000001' // channel outside both collections
const DEAD = '100000000000000099' // message id not in T1

const index = buildLinkIndex([
  { prefix: '/accolades', threads: new Map([[T1, { messages: [{ id: T1 }, { id: M1 }] }]]) },
  { prefix: '/ranks', threads: new Map([[T2, { messages: [{ id: T2 }] }]]) },
])
const snowflake = fc.bigInt({ min: 10n ** 16n, max: 10n ** 19n - 1n }).map(String)

describe('parseDiscordRef', () => {
  it.each([
    [`https://discord.com/channels/${G}/${T1}`, { guildId: G, channelId: T1, messageId: null }],
    [`https://discord.com/channels/${G}/${T1}/${M1}`, { guildId: G, channelId: T1, messageId: M1 }],
    [`https://discordapp.com/channels/${G}/${T1}/${M1}`, { guildId: G, channelId: T1, messageId: M1 }],
    [`https://ptb.discord.com/channels/${G}/${T1}`, { guildId: G, channelId: T1, messageId: null }],
    [`https://canary.discord.com/channels/${G}/${T1}/`, { guildId: G, channelId: T1, messageId: null }],
    [`http://discord.com/channels/${G}/${T1}`, { guildId: G, channelId: T1, messageId: null }],
    [`<https://discord.com/channels/${G}/${T1}>`, { guildId: G, channelId: T1, messageId: null }],
    [`  https://discord.com/channels/${G}/${T1}  `, { guildId: G, channelId: T1, messageId: null }],
    [`<#${EXT}>`, { guildId: G, channelId: EXT, messageId: null }],
  ])('parses %s', (s, want) => expect(parseDiscordRef(s)).toEqual(want))

  it.each([
    'https://example.com/channels/1/2',
    `https://discord.com.evil.io/channels/${G}/${T1}`,
    `https://evildiscord.com/channels/${G}/${T1}`,
    `https://discord.com/channels/${G}`,
    `https://discord.com/channels/${G}/${T1}/${M1}/extra`,
    `https://discord.com/channels/${G}/12/`,
    `https://discord.com/invite/abc`,
    `<#12>`,
    `<#${EXT}`,
    '',
    null,
    42,
    'javascript:alert(1)',
  ])('rejects %j', (s) => expect(parseDiscordRef(s)).toBeNull())

  it('round-trips any snowflake triple over every host/scheme variant', () => {
    fc.assert(
      fc.property(
        snowflake, snowflake, fc.option(snowflake, { nil: null }),
        fc.constantFrom('discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'),
        fc.constantFrom('https', 'http'), fc.boolean(), fc.boolean(),
        (g, c, m, host, scheme, slash, angle) => {
          let url = `${scheme}://${host}/channels/${g}/${c}${m ? `/${m}` : ''}${slash ? '/' : ''}`
          if (angle) url = `<${url}>`
          expect(parseDiscordRef(url)).toEqual({ guildId: g, channelId: c, messageId: m })
        },
      ),
    )
  })

  it('treats @me (DM) links as foreign, not as our guild', () => {
    expect(parseDiscordRef(`https://discord.com/channels/@me/${T1}`)).toEqual({ guildId: '@me', channelId: T1, messageId: null })
  })
})

describe('isDiscordHost', () => {
  it.each([
    ['https://discord.com/x', true], ['https://discordapp.com/x', true], ['https://ptb.discord.com/x', true],
    ['https://discord.gg/abc', true], ['https://cdn.discordapp.com/emojis/1.png', true],
    ['<https://discord.com/x>', true],
    ['https://warhammer40k.fandom.com/wiki/X', false], ['https://notdiscord.com/x', false],
    ['https://discord.com.evil.io/x', false], ['not a url', false], ['', false], [null, false],
  ])('%j → %s', (h, want) => expect(isDiscordHost(h)).toBe(want))
})

describe('resolveRef', () => {
  const ref = (channelId, messageId = null, guildId = G) => ({ guildId, channelId, messageId })

  it('thread link → route with no hash', () => {
    expect(resolveRef(ref(T1), index, {})).toEqual({ kind: 'route', to: { path: `/accolades/${T1}`, hash: '' } })
  })
  it('message link → route with #m-<id>', () => {
    expect(resolveRef(ref(T1, M1), index, {})).toEqual({ kind: 'route', to: { path: `/accolades/${T1}`, hash: `#m-${M1}` } })
  })
  it('starter-message link (message id == thread id) → top of thread, no hash', () => {
    expect(resolveRef(ref(T1, T1), index, {})).toEqual({ kind: 'route', to: { path: `/accolades/${T1}`, hash: '' } })
  })
  it('cross-collection link resolves to the other prefix', () => {
    expect(resolveRef(ref(T2), index, {}).to.path).toBe(`/ranks/${T2}`)
  })
  it('deleted target message is unaccounted without a fix — never silently degraded', () => {
    expect(resolveRef(ref(T1, DEAD), index, {})).toMatchObject({ kind: 'unaccounted' })
  })
  it('exact fix redirects a dead message link', () => {
    const fixes = { [`${T1}/${DEAD}`]: { to: `${T1}/${M1}`, why: 'replacement post' } }
    expect(resolveRef(ref(T1, DEAD), index, fixes)).toEqual({ kind: 'route', to: { path: `/accolades/${T1}`, hash: `#m-${M1}` } })
  })
  it('channel-level fix covers message links into that external channel', () => {
    const fixes = { [EXT]: { text: true, why: 'outside archive' } }
    expect(resolveRef(ref(EXT), index, fixes)).toEqual({ kind: 'text' })
    expect(resolveRef(ref(EXT, M1), index, fixes)).toEqual({ kind: 'text' })
  })
  it('a channel-level fix never overrides a healthy direct link into an in-site thread', () => {
    const fixes = { [T1]: { text: true, why: 'x' } }
    expect(resolveRef(ref(T1, M1), index, fixes).kind).toBe('route')
  })
  it('exact fix beats direct resolution (explicit override)', () => {
    const fixes = { [`${T1}/${M1}`]: { to: T2, why: 'moved' } }
    expect(resolveRef(ref(T1, M1), index, fixes).to.path).toBe(`/ranks/${T2}`)
  })
  it('a fix pointing at a nonexistent target is unaccounted, not a broken route', () => {
    const fixes = { [EXT]: { to: '900000000000000009', why: 'x' } }
    expect(resolveRef(ref(EXT), index, fixes)).toMatchObject({ kind: 'unaccounted' })
  })
  it('foreign guild and DM links are unaccounted even when the ids collide', () => {
    expect(resolveRef(ref(T1, null, '999999999999999999'), index, {})).toMatchObject({ kind: 'unaccounted' })
    expect(resolveRef(ref(T1, null, '@me'), index, {})).toMatchObject({ kind: 'unaccounted' })
  })
  it('null ref is unaccounted', () => {
    expect(resolveRef(null, index, {})).toMatchObject({ kind: 'unaccounted' })
  })
  it('unknown external channel with no fix is unaccounted', () => {
    expect(resolveRef(ref(EXT), index, {})).toMatchObject({ kind: 'unaccounted' })
  })
  it('ignores inherited properties on the fixes object', () => {
    const fixes = Object.create({ [EXT]: { text: true, why: 'proto' } })
    expect(resolveRef(ref(EXT), index, fixes)).toMatchObject({ kind: 'unaccounted' })
  })
})

describe('validateFixes', () => {
  it('accepts well-formed fixes', () => {
    expect(validateFixes({ [EXT]: { text: true, why: 'a' }, [`${T1}/${DEAD}`]: { to: `${T1}/${M1}`, why: 'b' } }, index)).toEqual([])
  })
  it.each([
    [{ 'not-an-id': { text: true, why: 'a' } }, /key/],
    [{ [EXT]: { text: true } }, /why/],
    [{ [EXT]: { text: true, why: '   ' } }, /why/],
    [{ [EXT]: { why: 'a' } }, /exactly one/],
    [{ [EXT]: { text: true, to: T1, why: 'a' } }, /exactly one/],
    [{ [EXT]: { text: false, why: 'a' } }, /exactly one/],
    [{ [EXT]: { to: 'garbage', why: 'a' } }, /target/],
    [{ [EXT]: { to: '900000000000000009', why: 'a' } }, /does not exist/],
    [{ [EXT]: { to: `${T1}/${DEAD}`, why: 'a' } }, /does not exist/],
    [{ [EXT]: null }, /object/],
    [{ [EXT]: { text: true, why: 'a', extra: 1 } }, /unknown field/],
  ])('rejects %j', (fixes, re) => {
    const errs = validateFixes(fixes, index)
    expect(errs.length).toBeGreaterThan(0)
    expect(errs.join('\n')).toMatch(re)
  })
  it('rejects a non-object fixes file', () => {
    expect(validateFixes(null, index)).toEqual(['link-fixes must be a JSON object'])
    expect(validateFixes([], index)).toEqual(['link-fixes must be a JSON object'])
  })
})

describe('buildLinkIndex', () => {
  it('throws on a thread id present in two collections', () => {
    const t = new Map([[T1, { messages: [] }]])
    expect(() => buildLinkIndex([{ prefix: '/a', threads: t }, { prefix: '/b', threads: t }])).toThrow(/duplicate thread/)
  })
})
```

- [ ] **Step 3: Run and confirm it fails.** Run
  `bun run test src/lib/archive/links.test.js`. Expected: FAIL (module not
  found).

- [ ] **Step 4: Implement `src/lib/archive/links.js`.**

```js
/**
 * Every Discord reference in the archive resolves in-site or renders as
 * plain text — never as a link back to Discord. Order: exact fix → direct
 * (thread in any collection, message present) → channel-level fix →
 * unaccounted (which the seal step refuses).
 */
import { GUILD_ID } from './registry'

const SNOW = '\\d{17,20}'
const URL_RE = new RegExp(
  `^<?https?://(?:(?:ptb|canary)\\.)?discord(?:app)?\\.com/channels/(${SNOW}|@me)/(${SNOW})(?:/(${SNOW}))?/?>?$`,
)
const MENTION_RE = new RegExp(`^<#(${SNOW})>$`)
const KEY_RE = new RegExp(`^${SNOW}(?:/${SNOW})?$`)
const DISCORD_HOST = /(^|\.)(discord(app)?\.com|discord\.gg)$/i
const FIX_FIELDS = new Set(['to', 'text', 'why'])

export function parseDiscordRef(s) {
  if (typeof s !== 'string') return null
  const t = s.trim()
  const mention = MENTION_RE.exec(t)
  if (mention) return { guildId: GUILD_ID, channelId: mention[1], messageId: null }
  const m = URL_RE.exec(t)
  if (!m) return null
  return { guildId: m[1], channelId: m[2], messageId: m[3] ?? null }
}

export function isDiscordHost(href) {
  if (typeof href !== 'string') return false
  try {
    return DISCORD_HOST.test(new URL(href.trim().replace(/^<|>$/g, '')).hostname)
  } catch {
    return false
  }
}

export function buildLinkIndex(collections) {
  const index = new Map()
  for (const c of collections) {
    for (const [threadId, entry] of c.threads) {
      if (index.has(threadId)) throw new Error(`duplicate thread ${threadId} across collections`)
      index.set(threadId, { prefix: c.prefix, messageIds: new Set(entry.messages.map((m) => m.id)) })
    }
  }
  return index
}

function direct(channelId, messageId, index) {
  const t = index.get(channelId)
  if (!t) return null
  if (messageId && messageId !== channelId && !t.messageIds.has(messageId)) return null
  const hash = messageId && messageId !== channelId ? `#m-${messageId}` : ''
  return { kind: 'route', to: { path: `${t.prefix}/${channelId}`, hash } }
}

function applyFix(fix, index) {
  if (fix.text === true) return { kind: 'text' }
  const [channelId, messageId = null] = fix.to.split('/')
  return direct(channelId, messageId, index) ?? { kind: 'unaccounted', reason: `fix target ${fix.to} does not exist` }
}

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

export function resolveRef(ref, index, fixes) {
  if (!ref) return { kind: 'unaccounted', reason: 'not a Discord reference' }
  if (ref.guildId !== GUILD_ID) return { kind: 'unaccounted', reason: `foreign guild ${ref.guildId}` }
  const exactKey = ref.messageId ? `${ref.channelId}/${ref.messageId}` : ref.channelId
  if (own(fixes, exactKey)) return applyFix(fixes[exactKey], index)
  const hit = direct(ref.channelId, ref.messageId, index)
  if (hit) return hit
  if (!index.has(ref.channelId) && own(fixes, ref.channelId)) return applyFix(fixes[ref.channelId], index)
  const why = index.has(ref.channelId) ? `message ${ref.messageId} no longer exists` : `channel ${ref.channelId} is outside the archive`
  return { kind: 'unaccounted', reason: why }
}

export function validateFixes(fixes, index) {
  if (!fixes || typeof fixes !== 'object' || Array.isArray(fixes)) return ['link-fixes must be a JSON object']
  const errors = []
  for (const [key, fix] of Object.entries(fixes)) {
    if (!KEY_RE.test(key)) errors.push(`${key}: key must be <channelId> or <channelId>/<messageId>`)
    if (!fix || typeof fix !== 'object') {
      errors.push(`${key}: fix must be an object`)
      continue
    }
    for (const f of Object.keys(fix)) if (!FIX_FIELDS.has(f)) errors.push(`${key}: unknown field "${f}"`)
    if (typeof fix.why !== 'string' || fix.why.trim() === '') errors.push(`${key}: every fix needs a non-empty "why"`)
    const hasTo = own(fix, 'to')
    const hasText = fix.text === true
    if (hasTo === hasText || (own(fix, 'text') && fix.text !== true)) {
      errors.push(`${key}: needs exactly one of "to" or "text": true`)
      continue
    }
    if (hasTo) {
      if (typeof fix.to !== 'string' || !KEY_RE.test(fix.to)) errors.push(`${key}: "to" target must be <threadId>[/<messageId>]`)
      else if (applyFix(fix, index).kind !== 'route') errors.push(`${key}: "to" target ${fix.to} does not exist in the archive`)
    }
  }
  return errors
}
```

- [ ] **Step 5: Run the tests; expect PASS.** Then run
  `bun run test:coverage` (expected: `links.js` at 100%) and
  `bun run test:mutation` (expected: 100% on `links.js`). Kill survivors with
  tests.

- [ ] **Step 6: Commit.**

```bash
git add src/lib/archive/registry.js src/lib/archive/links.js src/lib/archive/links.test.js
git commit -m "archive: in-site link resolver with fix overlay and strict validation"
```

---

### Task 4: Discord markdown parser

**Files:**
- Create: `src/lib/archive/markdown.js`, `src/lib/archive/markdown.test.js`

**Interfaces:**
- Produces: `parse(src: string) → Block[]`, `parseInline(s: string, depth?: number) → Inline[]`, `plainText(nodes, {raw?: boolean}) → string`, `walk(nodes, visit(node))`.
- AST node types:
  - Block: `{type:'heading', level:1|2|3, children}`, `{type:'subtext', children}`,
    `{type:'quote', children: Block[]}`,
    `{type:'list', ordered:boolean, items:{marker, children: Block[]}[]}`,
    `{type:'line', children}`, `{type:'blank'}`, `{type:'codeblock', lang, text}`.
  - Inline: `{type:'text', value}`,
    `{type:'strong'|'em'|'underline'|'strike'|'spoiler', children}`,
    `{type:'code', text}`, `{type:'link', href, children}`,
    `{type:'url', href}`, `{type:'emoji', name, id, animated, raw}`,
    `{type:'mention', kind:'user'|'role'|'channel', id, raw}`.

- [ ] **Step 1: Write the failing tests.** Create
  `src/lib/archive/markdown.test.js`:

```js
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { parse, parseInline, plainText, walk } from './markdown'

const alnum = (s) => s.replace(/[^\p{L}\p{N}]/gu, '')
const E = '123456789012345678'

describe('blocks', () => {
  it('headings 1-3, bold inside', () => {
    expect(parse('# **A**\n## B\n### C')).toEqual([
      { type: 'heading', level: 1, children: [{ type: 'strong', children: [{ type: 'text', value: 'A' }] }] },
      { type: 'heading', level: 2, children: [{ type: 'text', value: 'B' }] },
      { type: 'heading', level: 3, children: [{ type: 'text', value: 'C' }] },
    ])
  })
  it.each(['#### four', '#nospace', '# ', ' # indented'])('%j is a plain line, not a heading', (s) => {
    expect(parse(s)[0].type).not.toBe('heading')
  })
  it('-# subtext', () => {
    expect(parse('-# small')).toEqual([{ type: 'subtext', children: [{ type: 'text', value: 'small' }] }])
  })
  it('> quotes group consecutive lines and may contain headings and nested lists', () => {
    const [q] = parse('> ### H\n> * a\n>   * b\n>\n> tail')
    expect(q.type).toBe('quote')
    expect(q.children.map((n) => n.type)).toEqual(['heading', 'list', 'blank', 'line'])
    expect(q.children[1].items[0].children[1]).toMatchObject({ type: 'list', items: [{ marker: '*' }] })
  })
  it('>>> quotes the rest of the message', () => {
    const [q] = parse('>>> a\nb\nc')
    expect(q.type).toBe('quote')
    expect(plainText(q.children)).toBe('a\nb\nc\n')
  })
  it('quotes do not nest (Discord renders an inner > literally)', () => {
    const [q] = parse('> > x')
    expect(plainText(q.children)).toBe('> x\n')
  })
  it('lists: -, *, ordered with marker kept, nesting by indent, dedent returns to parent', () => {
    const [l] = parse('- a\n  - b\n    - c\n- d')
    expect(l.ordered).toBe(false)
    expect(l.items.map((i) => plainText(i.children.slice(0, 1)))).toEqual(['a\n', 'd\n'])
    expect(l.items[0].children[1].items[0].children[1].items[0].marker).toBe('-')
    const [o] = parse('1. x\n2. y')
    expect(o).toMatchObject({ ordered: true, items: [{ marker: '1.' }, { marker: '2.' }] })
  })
  it('extra spaces after a list marker are not content', () => {
    const [l] = parse('*  **x**')
    expect(l.items[0].children[0].children[0]).toMatchObject({ type: 'strong' })
  })
  it('a list that starts deeper than a later item splits into sibling lists', () => {
    expect(parse('  - a\n- b').map((n) => n.type)).toEqual(['list', 'list'])
  })
  it('blank lines are preserved, CRLF normalised', () => {
    expect(parse('a\r\n\r\nb').map((n) => n.type)).toEqual(['line', 'blank', 'line'])
  })
  it('fenced code block with language', () => {
    expect(parse('```js\nconst a = 1 **no**\n```')).toEqual([{ type: 'codeblock', lang: 'js', text: 'const a = 1 **no**' }])
  })
  it('unterminated fence is ordinary text', () => {
    expect(parse('```js\nx').map((n) => n.type)).toEqual(['line', 'line'])
  })
  it('throws on non-string input', () => {
    expect(() => parse(null)).toThrow(TypeError)
  })
})

describe('inline', () => {
  const one = (s) => parseInline(s)
  it.each([
    ['**b**', 'strong'], ['*i*', 'em'], ['_i_', 'em'], ['__u__', 'underline'], ['~~s~~', 'strike'], ['||sp||', 'spoiler'],
  ])('%s → %s', (s, type) => expect(one(s)).toEqual([{ type, children: [{ type: 'text', value: s.replace(/[*_~|]/g, '') }] }]))
  it('***x*** is strong(em)', () => {
    expect(one('***x***')).toEqual([{ type: 'strong', children: [{ type: 'em', children: [{ type: 'text', value: 'x' }] }] }])
  })
  it('snake_case_words are not italic', () => {
    expect(one('snake_case_word')).toEqual([{ type: 'text', value: 'snake_case_word' }])
  })
  it('a lone * with a space after it is literal', () => {
    expect(one('a * b * c')).toEqual([{ type: 'text', value: 'a * b * c' }])
  })
  it('unclosed delimiters are literal text', () => {
    expect(plainText(one('**a __b ||c ~~d `e'))).toBe('**a __b ||c ~~d `e')
  })
  it('empty pairs stay literal', () => {
    expect(plainText(one('****'))).toBe('****')
  })
  it('backslash escapes', () => {
    expect(one('\\*not\\*')).toEqual([{ type: 'text', value: '*not*' }])
  })
  it('inline code is verbatim', () => {
    expect(one('`**x**`')).toEqual([{ type: 'code', text: '**x**' }])
    expect(one('``a`b``')).toEqual([{ type: 'code', text: 'a`b' }])
  })
  it('masked links, with angle-bracketed and bold text', () => {
    expect(one('[**T**](<https://discord.com/channels/1/2>)')).toEqual([
      { type: 'link', href: 'https://discord.com/channels/1/2', children: [{ type: 'strong', children: [{ type: 'text', value: 'T' }] }] },
    ])
  })
  it('bare and suppressed urls; trailing punctuation excluded', () => {
    expect(one('see https://x.io/a. and <https://y.io/b>')).toEqual([
      { type: 'text', value: 'see ' }, { type: 'url', href: 'https://x.io/a' }, { type: 'text', value: '. and ' },
      { type: 'url', href: 'https://y.io/b' },
    ])
  })
  it('custom emoji, animated emoji, mentions', () => {
    expect(one(`<:Leg_1:${E}><a:Fire:${E}><@${E}><@!${E}><@&${E}><#${E}>`)).toEqual([
      { type: 'emoji', name: 'Leg_1', id: E, animated: false, raw: `<:Leg_1:${E}>` },
      { type: 'emoji', name: 'Fire', id: E, animated: true, raw: `<a:Fire:${E}>` },
      { type: 'mention', kind: 'user', id: E, raw: `<@${E}>` },
      { type: 'mention', kind: 'user', id: E, raw: `<@!${E}>` },
      { type: 'mention', kind: 'role', id: E, raw: `<@&${E}>` },
      { type: 'mention', kind: 'channel', id: E, raw: `<#${E}>` },
    ])
  })
  it('an unresolved :shortcode: stays literal', () => {
    expect(one(':FixtureShortcode:')).toEqual([{ type: 'text', value: ':FixtureShortcode:' }])
  })
  it('javascript: and data: are never links', () => {
    const nodes = one('[x](javascript:alert(1)) <javascript:alert(1)> data:text/html,hi')
    const hrefs = []
    walk(nodes, (n) => n.href && hrefs.push(n.href))
    expect(hrefs).toEqual([])
  })
})

describe('fidelity properties', () => {
  it('parse never drops or invents a letter or digit (raw plain text) — arbitrary strings', () => {
    fc.assert(fc.property(fc.string({ maxLength: 300 }), (s) => {
      expect(alnum(plainText(parse(s), { raw: true }))).toBe(alnum(s))
    }), { numRuns: 2000 })
  })
  it('same property over markdown-shaped strings', () => {
    const tok = fc.constantFrom('**', '*', '_', '__', '~~', '||', '`', '```', '\n', '> ', '>>> ', '# ', '## ', '-# ', '- ', '* ',
      '  ', '1. ', '[', '](', ')', '<', '>', '\\', `<:e:${E}>`, `<a:e:${E}>`, `<@&${E}>`, `<#${E}>`, 'https://a.io/x', 'word', '9', 'é')
    fc.assert(fc.property(fc.array(tok, { maxLength: 60 }), (parts) => {
      const s = parts.join('')
      expect(alnum(plainText(parse(s), { raw: true }))).toBe(alnum(s))
    }), { numRuns: 3000 })
  })
})

describe('hostile input', () => {
  it.each([
    ['1 MB of unclosed spoilers', '||a'.repeat(350_000)],
    ['1 MB of asterisks', '*'.repeat(1_000_000)],
    ['1 MB of open brackets', '[a'.repeat(500_000)],
    ['deep nesting', '**__~~||'.repeat(5_000) + 'x' + '||~~__**'.repeat(5_000)],
    ['2k nested list levels', Array.from({ length: 2_000 }, (_, i) => ' '.repeat(i) + '- x').join('\n')],
    ['zero-width and RTL', '\u200b**\u202ex\u200d**'],
  ])('%s parses in < 2s without throwing', (_, s) => {
    const t = performance.now()
    expect(() => parse(s)).not.toThrow()
    expect(performance.now() - t).toBeLessThan(2000)
  })
})

describe('plainText', () => {
  it('display form: emoji as :name:, mentions empty, link text only', () => {
    expect(plainText(parseInline(`[t](https://a.io) <:x:${E}> <@&${E}>`))).toBe('t :x: ')
  })
})
```

- [ ] **Step 2: Run and confirm it fails.** Run
  `bun run test src/lib/archive/markdown.test.js`. Expected: FAIL (module
  not found).

- [ ] **Step 3: Implement `src/lib/archive/markdown.js`.**

```js
/**
 * Discord-flavoured markdown → AST. Rendering is done elsewhere with Vue
 * render functions (never v-html), so this module never produces markup.
 * Unrecognised syntax stays literal text, the way Discord shows it. Every
 * scan is memoised or sticky-anchored, so hostile input stays linear.
 */
const MAX_DEPTH = 16
const HEADING = /^(#{1,3}) +(\S.*)$/
const SUBTEXT = /^-# +(\S.*)$/
const LIST_ITEM = /^([ \t]*)([-*]|\d{1,9}\.) +(.*)$/
const FENCE_OPEN = /^```([\w+-]*)$/
const EMOJI = /<(a?):(\w{1,32}):(\d{17,20})>/y
const MENTION = /<(@!?|@&|#)(\d{17,20})>/y
const ANGLE_URL = /<(https?:\/\/[^\s<>]+)>/y
const MASKED = /\[([^[\]\n]+)\]\(\s*<?(https?:\/\/[^\s()<>]+)>?\s*\)/y
const BARE_URL = /https?:\/\/[^\s<]*[^\s<.,:;"')\]!?*_~|]/y
const ESCAPABLE = /[\\*_~|`<>#\-[\]()]/
const PAIRS = [
  ['||', 'spoiler'],
  ['**', 'strong'],
  ['__', 'underline'],
  ['~~', 'strike'],
]
const MENTION_KIND = { '@': 'user', '@!': 'user', '@&': 'role', '#': 'channel' }

export function parse(src) {
  if (typeof src !== 'string') throw new TypeError('markdown source must be a string')
  return parseBlocks(src.replace(/\r\n?/g, '\n').split('\n'), false)
}

function parseBlocks(lines, inQuote) {
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = FENCE_OPEN.exec(line)
    if (fence) {
      const close = lines.indexOf('```', i + 1)
      if (close !== -1) {
        out.push({ type: 'codeblock', lang: fence[1], text: lines.slice(i + 1, close).join('\n') })
        i = close + 1
        continue
      }
    }
    if (!inQuote && line.startsWith('>>> ')) {
      out.push({ type: 'quote', children: parseBlocks([line.slice(4), ...lines.slice(i + 1)], true) })
      break
    }
    if (!inQuote && (line.startsWith('> ') || line === '>')) {
      const inner = []
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) {
        inner.push(lines[i] === '>' ? '' : lines[i].slice(2))
        i++
      }
      out.push({ type: 'quote', children: parseBlocks(inner, true) })
      continue
    }
    let m
    if ((m = HEADING.exec(line))) {
      out.push({ type: 'heading', level: m[1].length, children: parseInline(m[2]) })
      i++
      continue
    }
    if ((m = SUBTEXT.exec(line))) {
      out.push({ type: 'subtext', children: parseInline(m[1]) })
      i++
      continue
    }
    if (LIST_ITEM.test(line)) {
      const items = []
      while (i < lines.length && (m = LIST_ITEM.exec(lines[i]))) {
        items.push({ indent: m[1].replace(/\t/g, '  ').length, marker: m[2], text: m[3] })
        i++
      }
      for (let k = 0; k < items.length; ) {
        const [list, next] = buildList(items, k, items[k].indent, 0)
        out.push(list)
        k = next
      }
      continue
    }
    out.push(line.trim() === '' ? { type: 'blank' } : { type: 'line', children: parseInline(line) })
    i++
  }
  return out
}

function buildList(items, start, indent, depth) {
  const list = { type: 'list', ordered: /\d/.test(items[start].marker), items: [] }
  let k = start
  while (k < items.length && items[k].indent >= indent) {
    const it = items[k]
    if (it.indent > indent && list.items.length && depth < MAX_DEPTH) {
      const [child, next] = buildList(items, k, it.indent, depth + 1)
      list.items[list.items.length - 1].children.push(child)
      k = next
      continue
    }
    list.items.push({ marker: it.marker, children: [{ type: 'line', children: parseInline(it.text) }] })
    k++
  }
  return [list, k]
}

function sticky(re, s, i) {
  re.lastIndex = i
  return re.exec(s)
}

export function parseInline(s, depth = 0) {
  const out = []
  const noClose = new Set()
  let text = ''
  const flush = () => {
    if (text) out.push({ type: 'text', value: text })
    text = ''
  }
  const push = (node, next) => {
    flush()
    out.push(node)
    return next
  }
  const closing = (delim, from) => {
    if (noClose.has(delim)) return -1
    const at = s.indexOf(delim, from)
    if (at === -1) noClose.add(delim)
    return at
  }

  let i = 0
  while (i < s.length) {
    const c = s[i]
    let m
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.test(s[i + 1])) {
      text += s[i + 1]
      i += 2
      continue
    }
    if (c === '`') {
      const ticks = s.startsWith('``', i) ? '``' : '`'
      const at = closing(ticks, i + ticks.length)
      if (at > i + ticks.length) {
        i = push({ type: 'code', text: s.slice(i + ticks.length, at) }, at + ticks.length)
        continue
      }
    }
    if (c === '<') {
      if ((m = sticky(EMOJI, s, i))) {
        i = push({ type: 'emoji', name: m[2], id: m[3], animated: m[1] === 'a', raw: m[0] }, i + m[0].length)
        continue
      }
      if ((m = sticky(MENTION, s, i))) {
        i = push({ type: 'mention', kind: MENTION_KIND[m[1]], id: m[2], raw: m[0] }, i + m[0].length)
        continue
      }
      if ((m = sticky(ANGLE_URL, s, i))) {
        i = push({ type: 'url', href: m[1] }, i + m[0].length)
        continue
      }
    }
    if (c === '[' && (m = sticky(MASKED, s, i))) {
      i = push({ type: 'link', href: m[2], children: parseInline(m[1], depth + 1) }, i + m[0].length)
      continue
    }
    if (c === 'h' && (m = sticky(BARE_URL, s, i))) {
      i = push({ type: 'url', href: m[0] }, i + m[0].length)
      continue
    }
    if (depth < MAX_DEPTH) {
      if (s.startsWith('***', i)) {
        const at = closing('***', i + 3)
        if (at > i + 3) {
          const inner = { type: 'em', children: parseInline(s.slice(i + 3, at), depth + 2) }
          i = push({ type: 'strong', children: [inner] }, at + 3)
          continue
        }
      }
      const pair = PAIRS.find(([d]) => s.startsWith(d, i))
      if (pair) {
        const at = closing(pair[0], i + 2)
        if (at > i + 2) {
          i = push({ type: pair[1], children: parseInline(s.slice(i + 2, at), depth + 1) }, at + 2)
          continue
        }
      }
      if ((c === '*' || c === '_') && isEmOpen(s, i, c)) {
        const at = closing(c, i + 1)
        if (at > i + 1 && isEmClose(s, at, c)) {
          i = push({ type: 'em', children: parseInline(s.slice(i + 1, at), depth + 1) }, at + 1)
          continue
        }
      }
    }
    text += c
    i++
  }
  flush()
  return out
}

const WORD = /[\p{L}\p{N}]/u
function isEmOpen(s, i, c) {
  const next = s[i + 1]
  if (next === undefined || /\s/.test(next) || next === c) return false
  return c === '*' || i === 0 || !WORD.test(s[i - 1])
}
function isEmClose(s, at, c) {
  if (/\s/.test(s[at - 1])) return false
  return c === '*' || at + 1 >= s.length || !WORD.test(s[at + 1])
}

export function walk(nodes, visit) {
  for (const n of nodes) {
    visit(n)
    if (n.children) walk(n.children, visit)
    if (n.items) for (const it of n.items) walk(it.children, visit)
  }
}

export function plainText(nodes, opts = {}) {
  let s = ''
  for (const n of nodes) s += nodeText(n, opts)
  return s
}

function nodeText(n, o) {
  switch (n.type) {
    case 'text':
      return n.value
    case 'code':
      return n.text
    case 'codeblock':
      return (o.raw ? n.lang : '') + n.text + '\n'
    case 'url':
      return n.href
    case 'link':
      return plainText(n.children, o) + (o.raw ? n.href : '')
    case 'emoji':
      return o.raw ? n.raw : `:${n.name}:`
    case 'mention':
      return o.raw ? n.raw : ''
    case 'blank':
      return '\n'
    case 'list':
      return n.items.map((it) => (o.raw ? it.marker : '') + plainText(it.children, o)).join('')
    case 'quote':
      return plainText(n.children, o)
    case 'heading':
    case 'subtext':
    case 'line':
      return plainText(n.children, o) + '\n'
    default:
      return plainText(n.children, o)
  }
}
```

Note on `closing()` memoisation: it caches "no closer after position p"
per delimiter. That's valid because later searches in the same string
always start further right. A closer that exists but fails `isEmClose` is
*not* cached.

- [ ] **Step 4: Run the tests; expect PASS.** If the alnum property fails,
  fast-check prints a minimal counterexample. Fix the parser, not the
  property. The property is the contract that the parser never drops or
  invents content.

- [ ] **Step 5: Coverage and mutation.** Run `bun run test:coverage` and
  `bun run test:mutation`. Expected: 100% on `markdown.js`. For each
  surviving mutant, add a table-driven case pinning the behavior (e.g. a
  survivor on `/\s/.test(next)` needs `'* x*'` asserted as literal).

- [ ] **Step 6: Verify against the real export (local only, nothing
  committed).**

```bash
bun -e '
import { parse, plainText } from "./src/lib/archive/markdown.js"
import fs from "node:fs"
const alnum = (s) => s.replace(/[^\p{L}\p{N}]/gu, "")
let n = 0
for (const c of ["accolades", "rank-requirements"]) for (const f of fs.readdirSync(`archive-export/${c}/data/threads`)) {
  const t = JSON.parse(fs.readFileSync(`archive-export/${c}/data/threads/${f}`, "utf8"))
  for (const m of t.messages) { const s = m.content || ""; if (alnum(plainText(parse(s), { raw: true })) !== alnum(s)) throw new Error("fidelity " + m.id); n++ }
}
console.log("fidelity ok for", n, "messages")'
```

Expected: `fidelity ok for <N> messages`, with no error.

- [ ] **Step 7: Commit.**

```bash
git add src/lib/archive/markdown.js src/lib/archive/markdown.test.js
git commit -m "archive: Discord markdown parser with content-fidelity property tests"
```

---

### Task 5: Key endpoint on the builds API

**Files:**
- Create: `server/src/archiveKey.js`, `server/src/archiveKey.test.js`
- Modify: `server/src/index.js`, `server/docker-compose.yml`, `server/README.md`

**Interfaces:**
- Consumes: `deriveKeys` from Task 2, in tests only (cross-check the kid).
- Produces: `createArchiveKeyHandler(config) → (request: Request) → Promise<Response>`.
  Config: `{fetchImpl, discordApiBase, guildId, roleId, botToken, archiveKey, timeoutMs=5000}`.
  A 200 body is `{key: <base64>, kid: <16 hex>}`.

- [ ] **Step 1: Write the failing tests.** Create
  `server/src/archiveKey.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { createArchiveKeyHandler } from './archiveKey'
import { deriveKeys, keyFromBase64 } from '../../src/lib/archive/crypto'

const KEY = Buffer.alloc(32, 7).toString('base64')
const ROLE = '1377787723976409211'
const GUILD = '1322056087792521269'
const USER = '75633559351595008'
const TOKEN = 'good.token-value_1'

function discord({ me = { status: 200, body: { id: USER, username: 'u' } }, member = { status: 200, body: { roles: [ROLE] } }, throws } = {}) {
  return async (url, init) => {
    if (throws) throw throws
    const r = url.endsWith('/users/@me') ? me : member
    if (r.raw !== undefined) return new Response(r.raw, { status: r.status })
    return new Response(JSON.stringify(r.body), { status: r.status })
  }
}
const cfg = (over = {}) => ({
  fetchImpl: discord(), discordApiBase: 'https://d.test/api', guildId: GUILD, roleId: ROLE, botToken: 'bot', archiveKey: KEY, ...over,
})
const NONE = Symbol('no Authorization header')
const DEFAULT = `Bearer ${TOKEN}`
const req = (auth) => new Request('https://api.test/archive/key', { headers: auth === NONE ? {} : { Authorization: auth } })

async function call(config, auth = DEFAULT) {
  const res = await createArchiveKeyHandler(config)(req(auth))
  const text = await res.text()
  return { status: res.status, text, headers: res.headers }
}

function assertNoKey({ text, headers }) {
  expect(text).not.toContain(KEY)
  for (const [, v] of headers) expect(v).not.toContain(KEY)
}

describe('GET /archive/key', () => {
  it('role holder gets the key and the kid of that key', async () => {
    const r = await call(cfg())
    expect(r.status).toBe(200)
    const body = JSON.parse(r.text)
    expect(body.key).toBe(KEY)
    expect(body.kid).toBe((await deriveKeys(keyFromBase64(KEY))).kid)
    expect(r.headers.get('Cache-Control')).toBe('no-store')
  })

  // (CR/LF injection can't be tested here: the Fetch Headers class itself
  // rejects such values before any handler runs — Bun's included.)
  const denials = [
    ['no Authorization header', cfg(), NONE, 401],
    ['empty Authorization', cfg(), '', 401],
    ['Basic scheme', cfg(), 'Basic abc', 401],
    ['Bearer with no token', cfg(), 'Bearer ', 401],
    ['token with a space (header smuggling)', cfg(), 'Bearer a b', 401],
    ['token with a tab', cfg(), 'Bearer a\tb', 401],
    ['token with a quote', cfg(), 'Bearer a"b', 401],
    ['oversized token', cfg(), `Bearer ${'a'.repeat(600)}`, 401],
    ['Discord rejects token (401)', cfg({ fetchImpl: discord({ me: { status: 401, body: {} } }) }), DEFAULT, 401],
    ['Discord forbids token (403)', cfg({ fetchImpl: discord({ me: { status: 403, body: {} } }) }), DEFAULT, 401],
    ['identify rate-limited (429)', cfg({ fetchImpl: discord({ me: { status: 429, body: {} } }) }), DEFAULT, 503],
    ['identify 5xx', cfg({ fetchImpl: discord({ me: { status: 502, body: {} } }) }), DEFAULT, 503],
    ['identify non-JSON', cfg({ fetchImpl: discord({ me: { status: 200, raw: '<html>' } }) }), DEFAULT, 503],
    ['identify body missing id', cfg({ fetchImpl: discord({ me: { status: 200, body: { username: 'x' } } }) }), DEFAULT, 503],
    ['identify id not a snowflake', cfg({ fetchImpl: discord({ me: { status: 200, body: { id: '../x' } } }) }), DEFAULT, 503],
    ['not in guild (404)', cfg({ fetchImpl: discord({ member: { status: 404, body: {} } }) }), DEFAULT, 403],
    ['in guild without role', cfg({ fetchImpl: discord({ member: { status: 200, body: { roles: ['1'] } } }) }), DEFAULT, 403],
    ['roles not an array', cfg({ fetchImpl: discord({ member: { status: 200, body: { roles: ROLE } } }) }), DEFAULT, 503],
    ['member lookup rate-limited (429)', cfg({ fetchImpl: discord({ member: { status: 429, body: {} } }) }), DEFAULT, 503],
    ['member lookup 5xx', cfg({ fetchImpl: discord({ member: { status: 500, body: {} } }) }), DEFAULT, 503],
    ['member lookup non-JSON', cfg({ fetchImpl: discord({ member: { status: 200, raw: 'nope' } }) }), DEFAULT, 503],
    ['network error', cfg({ fetchImpl: discord({ throws: new TypeError('fetch failed') }) }), DEFAULT, 503],
    ['missing ARCHIVE_KEY', cfg({ archiveKey: '' }), DEFAULT, 503],
    ['malformed ARCHIVE_KEY', cfg({ archiveKey: 'short' }), DEFAULT, 503],
    ['missing role id', cfg({ roleId: undefined }), DEFAULT, 503],
    ['missing bot token', cfg({ botToken: '' }), DEFAULT, 503],
    ['missing guild', cfg({ guildId: null }), DEFAULT, 503],
    ['missing api base', cfg({ discordApiBase: '' }), DEFAULT, 503],
  ]
  it.each(denials)('%s → %i, key never leaked', async (_, config, auth, status) => {
    const r = await call(config, auth)
    expect(r.status).toBe(status)
    expect(r.headers.get('Cache-Control')).toBe('no-store')
    assertNoKey(r)
  })

  it('does not ask Discord anything when no token is present', async () => {
    let asked = false
    const r = await call(cfg({ fetchImpl: async () => ((asked = true), new Response('{}')) }), '')
    expect(r.status).toBe(401)
    expect(asked).toBe(false)
  })

  it('times out a hung Discord call as 503', async () => {
    const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
    const r = await call(cfg({ fetchImpl: hang, timeoutMs: 20 }))
    expect(r.status).toBe(503)
  })

  it('checks the role against the configured guild and the caller id, using the bot token', async () => {
    const seen = []
    const fetchImpl = async (url, init) => {
      seen.push([url, init.headers.Authorization])
      return new Response(JSON.stringify(url.endsWith('@me') ? { id: USER } : { roles: [ROLE] }))
    }
    await call(cfg({ fetchImpl }))
    expect(seen).toEqual([
      ['https://d.test/api/users/@me', `Bearer ${TOKEN}`],
      [`https://d.test/api/v10/guilds/${GUILD}/members/${USER}`, 'Bot bot'],
    ])
  })
})
```

(The last test inspects outbound request shape because the URL and
credential *are* the security behavior: the wrong guild or token would be
a real bypass.)

- [ ] **Step 2: Run and confirm it fails.** Run
  `bun run test server/src/archiveKey.test.js`. Expected: FAIL (module not
  found).

- [ ] **Step 3: Implement `server/src/archiveKey.js`.**

```js
/**
 * GET /archive/key — hands the Legion Archive key only to a caller whose
 * Discord token is valid *and* who holds ARCHIVE_ROLE_ID in the guild right
 * now. Every uncertain path fails closed (401/403/503), never the key.
 * Pure: config and fetch are injected so it's testable under Node.
 */
const KEY_B64 = /^[A-Za-z0-9+/]{43}=$/
const TOKEN = /^Bearer ([A-Za-z0-9._~+/-]{1,512}=*)$/
const SNOWFLAKE = /^\d{17,20}$/

class Upstream extends Error {}

export function createArchiveKeyHandler({ fetchImpl = fetch, discordApiBase, guildId, roleId, botToken, archiveKey, timeoutMs = 5000 }) {
  const configured = [discordApiBase, guildId, roleId, botToken].every((v) => typeof v === 'string' && v !== '') &&
    typeof archiveKey === 'string' && KEY_B64.test(archiveKey)
  const kid = configured ? kidOf(archiveKey) : null

  async function get(url, auth) {
    let res
    try {
      res = await fetchImpl(url, { headers: { Authorization: auth }, signal: AbortSignal.timeout(timeoutMs) })
    } catch {
      throw new Upstream()
    }
    let body = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { status: res.status, body }
  }

  return async function handle(request) {
    if (!configured) return reply(503, { error: 'Archive unavailable.' })
    const m = TOKEN.exec(request.headers.get('Authorization') || '')
    if (!m) return reply(401, { error: 'Sign in with Discord.' })
    try {
      const me = await get(`${discordApiBase}/users/@me`, `Bearer ${m[1]}`)
      if (me.status === 401 || me.status === 403) return reply(401, { error: 'Sign in with Discord.' })
      if (me.status !== 200 || !SNOWFLAKE.test(String(me.body?.id ?? ''))) throw new Upstream()
      const member = await get(`${discordApiBase}/v10/guilds/${guildId}/members/${me.body.id}`, `Bot ${botToken}`)
      if (member.status === 404) return reply(403, { error: 'Restricted to the XVIIIth Legion.' })
      if (member.status !== 200 || !Array.isArray(member.body?.roles)) throw new Upstream()
      if (!member.body.roles.includes(roleId)) return reply(403, { error: 'Restricted to the XVIIIth Legion.' })
      return reply(200, { key: archiveKey, kid: await kid })
    } catch {
      return reply(503, { error: 'Discord could not be reached. Try again.' })
    }
  }
}

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

async function kidOf(b64) {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}
```

The server Docker image only copies `server/src`, so it can't import
`src/lib/archive/crypto.js`. `kidOf` duplicates that one calculation, and
the first test pins the two to the same answer.

- [ ] **Step 4: Run the tests; expect PASS.** Then run
  `bun run test:coverage` and `bun run test:mutation`. Expected: 100% on
  `archiveKey.js`.

- [ ] **Step 5: Wire it into `server/src/index.js`.** Add the import beside
  the `pg` import:

```js
import { createArchiveKeyHandler } from './archiveKey.js'
```

After the `pool` constant:

```js
const archiveKey = createArchiveKeyHandler({
  discordApiBase: DISCORD_API_BASE,
  guildId: GUILD_ID,
  roleId: process.env.ARCHIVE_ROLE_ID,
  botToken: BOT_TOKEN,
  archiveKey: process.env.ARCHIVE_KEY,
})
```

And in the router, right after the `/health` line:

```js
      if (url.pathname === '/archive/key' && request.method === 'GET') return cors(await archiveKey(request))
```

Also update the header comment's first line to say "five routes".

- [ ] **Step 6: Compose env.** In `server/docker-compose.yml`, add these
  under `api.environment`:

```yaml
      # Legion Archive gate. ARCHIVE_KEY is the base64 key from
      # archive-export/.env (keep a copy in a password manager).
      ARCHIVE_KEY: ${ARCHIVE_KEY:-}
      ARCHIVE_ROLE_ID: ${ARCHIVE_ROLE_ID:-1377787723976409211}
```

Append this to `server/README.md`:

```markdown
## Archive key (`GET /archive/key`)

Hands the Legion Archive decryption key to a caller whose Discord token is
valid and who currently holds the archive role in the guild. Anything
uncertain fails closed: 401 (sign in), 403 (no role), 503 (misconfigured or
Discord unreachable).

| Variable | Value |
|---|---|
| `ARCHIVE_KEY` | base64 key from `archive-export/.env` (also stored in a password manager) |
| `ARCHIVE_ROLE_ID` | `1377787723976409211` (XVIIIth Legion) |
| `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` | required — the role check is a bot guild-member lookup |

Until all four are set the endpoint answers 503 and the site shows
"couldn't be reached". Rotating the key (`bun run archive keygen --rotate`,
then `seal --publish`) requires updating `ARCHIVE_KEY` here and redeploying.
```

- [ ] **Step 7: Smoke-test under Bun.**

```bash
cd server && bun install && ARCHIVE_KEY=$(node -e 'console.log(Buffer.alloc(32,1).toString("base64"))') \
  DATABASE_URL=postgres://x@127.0.0.1:1/x timeout 3 bun run src/index.js & sleep 1; \
  curl -s -o /dev/null -w '%{http_code}\n' localhost:8787/archive/key; wait; cd ..
```

Expected: `503` (the other config values are unset, so it fails closed),
and the process starts without errors. Remove any `server/bun.lock` this
creates if it wasn't already tracked (`git status`).

- [ ] **Step 8: Commit.**

```bash
git add server/src/archiveKey.js server/src/archiveKey.test.js server/src/index.js server/docker-compose.yml server/README.md
git commit -m "server: role-gated GET /archive/key, fail-closed on every uncertain path"
```

---

### Task 6: Archive model and whole-archive audit

**Files:**
- Create: `src/lib/archive/model.js`, `src/lib/archive/audit.js`, `src/lib/archive/model.test.js`, `src/lib/archive/audit.test.js`

**Interfaces:**
- Consumes: `COLLECTIONS` (Task 3), `buildLinkIndex`/`resolveRef`/`parseDiscordRef`/`isDiscordHost`/`validateFixes` (Task 3), `parse`/`walk` (Task 4).
- Produces:
  - Index JSON shape (built by Task 7):
    `{format:1, kid, sealedAt, collections:{[key]:{tocThreadId, files:{'forum.json':string,'index.json':string,'links.json':string,'resolve.json':string,'assets.json':string,'threads/<id>.json':string}}}, fixes:{…}}`
  - `createArchive(index, registry=COLLECTIONS) → {collections: Map<key, Collection>, fixes, linkIndex}`,
    where `Collection = {key, prefix, label, tocThreadId, forum, resolve, assets, threads: Map<id, {thread, messages}>}`
  - `orderMessages(messages) → messages` (type 0/19, by position then snowflake)
  - `emojiFile(col, id, animated) → string|null`, `attachmentFile(col, url) → string|null`, `threadTags(col, thread) → tag[]`
  - `mentionLabel(col, archive, node) → {label, color|null}`
  - `classifyHref(href, archive) → {kind:'route', to} | {kind:'text'} | {kind:'external', href} | {kind:'unaccounted', reason}`
  - `auditArchive(archive) → {problems: {collectionKey, threadId, messageId, kind, detail}[], stats}`

- [ ] **Step 1: Write the failing tests** (in-memory synthetic index; no
  files). Create `src/lib/archive/model.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { createArchive, orderMessages, emojiFile, attachmentFile, threadTags, mentionLabel, classifyHref } from './model'
import { makeIndex, IDS } from './testIndex'

describe('createArchive', () => {
  it('builds both collections with ordered, filtered messages', () => {
    const a = createArchive(makeIndex())
    expect([...a.collections.keys()]).toEqual(['accolades', 'ranks'])
    const t = a.collections.get('accolades').threads.get(IDS.A_TOC)
    expect(t.messages.map((m) => m.id)).toEqual([IDS.A_TOC, IDS.A_TOC_M2])
  })
  it.each([
    ['wrong format', (i) => ({ ...i, format: 2 })],
    ['missing collection', (i) => ({ ...i, collections: { accolades: i.collections.accolades } })],
    ['unparseable thread file', (i) => { i.collections.ranks.files[`threads/${IDS.R_TOC}.json`] = '{'; return i }],
    ['toc thread not present', (i) => { i.collections.ranks.tocThreadId = '999999999999999999'; return i }],
  ])('rejects %s', (_, mutate) => {
    expect(() => createArchive(mutate(makeIndex()))).toThrow()
  })
})

describe('orderMessages', () => {
  it('keeps type 0 and 19 only; orders by position then snowflake (as BigInt, not string)', () => {
    const msgs = [
      { id: '100000000000000009', type: 0, position: 1 },
      { id: '99999999999999999', type: 0, position: 1 },
      { id: '100000000000000001', type: 4, position: 0 },
      { id: '100000000000000002', type: 19, position: 2 },
      { id: '100000000000000003', type: 0, position: 0 },
    ]
    expect(orderMessages(msgs).map((m) => m.id)).toEqual(['100000000000000003', '99999999999999999', '100000000000000009', '100000000000000002'])
  })
})

describe('asset lookups', () => {
  const a = createArchive(makeIndex())
  const col = a.collections.get('accolades')
  it('emoji via resolve.json first', () => expect(emojiFile(col, IDS.EMOJI, false)).toBe('emoji-fixture.png'))
  it('emoji fallback via assets.json CDN key (tag emoji missing from resolve)', () =>
    expect(emojiFile(col, IDS.TAG_EMOJI, false)).toBe('emoji-tag.png'))
  it('animated fallback prefers .gif', () => expect(emojiFile(col, IDS.GIF_EMOJI, true)).toBe('emoji-anim.gif'))
  it('unknown emoji → null', () => expect(emojiFile(col, '111111111111111111', false)).toBeNull())
  it('attachment by exact URL (query string included)', () => expect(attachmentFile(col, IDS.ATT_URL)).toBe('att-fixture.png'))
  it('attachment URL without its query string does not match', () => expect(attachmentFile(col, IDS.ATT_URL.split('?')[0])).toBeNull())
  it('threadTags maps applied tag ids to forum tags, skipping unknown ids', () => {
    expect(threadTags(col, { applied_tags: [IDS.TAG, '1'] }).map((t) => t.id)).toEqual([IDS.TAG])
    expect(threadTags(col, {})).toEqual([])
  })
})

describe('mentionLabel', () => {
  const a = createArchive(makeIndex())
  const col = a.collections.get('accolades')
  it('role → name + color', () => expect(mentionLabel(col, a, { kind: 'role', id: IDS.ROLE })).toEqual({ label: '@Fixture Role', color: '#991115' }))
  it('user → @display_name', () => expect(mentionLabel(col, a, { kind: 'user', id: IDS.USER })).toEqual({ label: '@Fixture User', color: null }))
  it('channel in archive → #thread name', () => expect(mentionLabel(col, a, { kind: 'channel', id: IDS.R_TOC }).label).toBe('#Fixture Ranks'))
  it('channel outside archive → #name from resolve.channels', () =>
    expect(mentionLabel(col, a, { kind: 'channel', id: IDS.EXT_CHANNEL }).label).toBe('#fixture-reports'))
  it('unknown ids degrade to a neutral label, never the raw id', () => {
    expect(mentionLabel(col, a, { kind: 'role', id: '1' }).label).toBe('@unknown-role')
    expect(mentionLabel(col, a, { kind: 'user', id: '1' }).label).toBe('@unknown-user')
    expect(mentionLabel(col, a, { kind: 'channel', id: '1' }).label).toBe('#unknown-channel')
  })
})

describe('classifyHref', () => {
  const a = createArchive(makeIndex())
  it('in-site Discord link → route', () => expect(classifyHref(IDS.LINK_TO_RANKS, a).kind).toBe('route'))
  it('fixed external channel → text', () => expect(classifyHref(`<#${IDS.EXT_CHANNEL}>`, a)).toEqual({ kind: 'text' }))
  it('discord.gg invite → unaccounted (never a Discord href)', () =>
    expect(classifyHref('https://discord.gg/abc', a).kind).toBe('unaccounted'))
  it('non-Discord https → external', () =>
    expect(classifyHref('https://example.com/w', a)).toEqual({ kind: 'external', href: 'https://example.com/w' }))
  it.each(['javascript:alert(1)', 'data:text/html,x', '//evil.io', 'ftp://x'])('%s → text', (h) =>
    expect(classifyHref(h, a)).toEqual({ kind: 'text' }))
})
```

- [ ] **Step 2: Shared synthetic index builder.** Create
  `src/lib/archive/testIndex.js`. It's a test helper, so the name has no
  `.test` and it's excluded from mutation. All keys are unquoted JS so the
  leak guard stays quiet.

```js
/** Synthetic, content-free archive index for unit tests. Mirrors the real export's shape only. */
export const IDS = {
  GUILD: '1322056087792521269',
  A_TOC: '100000000000000001', A_TOC_M2: '100000000000000011', A_T2: '100000000000000002', A_T2_M: '100000000000000021',
  R_TOC: '200000000000000001', R_TOC_M: '200000000000000011',
  EXT_CHANNEL: '500000000000000001', DEAD_MSG: '100000000000000099',
  EMOJI: '300000000000000001', TAG_EMOJI: '300000000000000002', GIF_EMOJI: '300000000000000003',
  ROLE: '400000000000000001', USER: '600000000000000001', TAG: '700000000000000001',
  ATT_URL: 'https://cdn.discordapp.com/attachments/100000000000000001/800000000000000001/f.png?ex=1&is=2&hm=3&',
}
const G = IDS.GUILD
export const LINKS = {
  toRanks: `https://discordapp.com/channels/${G}/${IDS.R_TOC}/${IDS.R_TOC_M}`,
  toT2: `https://discord.com/channels/${G}/${IDS.A_T2}`,
  dead: `https://discord.com/channels/${G}/${IDS.A_T2}/${IDS.DEAD_MSG}`,
  backToAccolades: `https://discord.com/channels/${G}/${IDS.A_TOC}/${IDS.A_TOC_M2}`,
}
IDS.LINK_TO_RANKS = LINKS.toRanks

const thread = (id, name, applied_tags, messages) => ({ thread: { id, name, applied_tags }, messages })
const msg = (id, position, content, extra = {}) => ({ id, type: 0, position, content, attachments: [], ...extra })

export function makeIndex() {
  const aThreads = {
    [IDS.A_TOC]: thread(IDS.A_TOC, 'Fixture ToC', [IDS.TAG], [
      msg(IDS.A_TOC, 0, 'Click here', { attachments: [{ url: IDS.ATT_URL, filename: 'f.png' }] }),
      { id: '100000000000000005', type: 4, position: 0, content: 'renamed' },
      msg(IDS.A_TOC_M2, 1, `# Fixture ToC <:fx:${IDS.EMOJI}>\n> * [**Two**](${LINKS.toT2})\n> * [Ranks](${LINKS.toRanks})\n<@&${IDS.ROLE}> <@${IDS.USER}> <#${IDS.EXT_CHANNEL}>`),
    ]),
    [IDS.A_T2]: thread(IDS.A_T2, 'Fixture Two', [], [
      msg(IDS.A_T2, 0, `[Old](${LINKS.dead}) and https://example.com/wiki`),
      msg(IDS.A_T2_M, 1, '||spoiler|| ok'),
    ]),
  }
  const rThreads = {
    [IDS.R_TOC]: thread(IDS.R_TOC, 'Fixture Ranks', [], [msg(IDS.R_TOC, 0, 'Ranks'), msg(IDS.R_TOC_M, 1, `## Rank\n[Back](${LINKS.backToAccolades})`)]),
  }
  const cdn = (id, ext) => `https://cdn.discordapp.com/emojis/${id}.${ext}`
  const files = (threads, extra) => ({
    'forum.json': JSON.stringify({ available_tags: [{ id: IDS.TAG, name: 'Fixture Tag', emoji_id: IDS.TAG_EMOJI }] }),
    'index.json': JSON.stringify(Object.values(threads).map((t) => ({ id: t.thread.id, name: t.thread.name }))),
    'links.json': '[]',
    'resolve.json': JSON.stringify({
      emojis: { [IDS.EMOJI]: { name: 'fx', animated: false, file: 'emoji-fixture.png' } },
      roles: { [IDS.ROLE]: { name: 'Fixture Role', color: '#991115' } },
      users: { [IDS.USER]: { display_name: 'Fixture User' } },
      channels: { [IDS.EXT_CHANNEL]: { name: 'fixture-reports' } },
    }),
    'assets.json': JSON.stringify({
      [cdn(IDS.EMOJI, 'png')]: { file: 'emoji-fixture.png' },
      [cdn(IDS.TAG_EMOJI, 'png')]: { file: 'emoji-tag.png' },
      [cdn(IDS.GIF_EMOJI, 'gif')]: { file: 'emoji-anim.gif' },
      [cdn(IDS.GIF_EMOJI, 'png')]: { file: 'emoji-anim.png' },
      [IDS.ATT_URL]: { file: 'att-fixture.png' },
    }),
    ...Object.fromEntries(Object.entries(threads).map(([id, t]) => [`threads/${id}.json`, JSON.stringify(t)])),
    ...extra,
  })
  return {
    format: 1,
    kid: '0123456789abcdef',
    sealedAt: '2026-09-24T00:00:00.000Z',
    collections: {
      accolades: { tocThreadId: IDS.A_TOC, files: files(aThreads) },
      ranks: { tocThreadId: IDS.R_TOC, files: files(rThreads) },
    },
    fixes: {
      [`${IDS.A_T2}/${IDS.DEAD_MSG}`]: { to: `${IDS.A_T2}/${IDS.A_T2_M}`, why: 'replacement' },
      [IDS.EXT_CHANNEL]: { text: true, why: 'outside archive' },
    },
  }
}
```

It isn't in Stryker's `mutate` list or the coverage `include`, and it must
stay out of both.

- [ ] **Step 3: Audit tests.** Create `src/lib/archive/audit.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { createArchive } from './model'
import { auditArchive } from './audit'
import { makeIndex, IDS } from './testIndex'

const kinds = (a) => auditArchive(createArchive(a)).problems.map((p) => p.kind)

describe('auditArchive', () => {
  it('the synthetic archive is clean', () => {
    const r = auditArchive(createArchive(makeIndex()))
    expect(r.problems).toEqual([])
    expect(r.stats).toMatchObject({ links: 6, route: 4, text: 1, external: 1 })
  })
  it('removing a fix makes its dead link unaccounted, naming where it lives', () => {
    const idx = makeIndex()
    delete idx.fixes[`${IDS.A_T2}/${IDS.DEAD_MSG}`]
    const [p] = auditArchive(createArchive(idx)).problems
    expect(p).toMatchObject({ kind: 'unaccounted-link', collectionKey: 'accolades', threadId: IDS.A_T2, messageId: IDS.A_T2 })
    expect(p.detail).toMatch(/no longer exists/)
  })
  it('a discord.gg invite in content is a problem', () => {
    const idx = makeIndex()
    const f = `threads/${IDS.R_TOC}.json`
    const t = JSON.parse(idx.collections.ranks.files[f])
    t.messages[0].content = 'join https://discord.gg/abc'
    idx.collections.ranks.files[f] = JSON.stringify(t)
    expect(kinds(idx)).toEqual(['unaccounted-link'])
  })
  it.each([
    ['unknown-emoji', `<:nope:111111111111111111>`],
    ['unknown-role', `<@&111111111111111111>`],
    ['unknown-user', `<@111111111111111111>`],
  ])('%s is reported', (kind, content) => {
    const idx = makeIndex()
    const f = `threads/${IDS.R_TOC}.json`
    const t = JSON.parse(idx.collections.ranks.files[f])
    t.messages[0].content = content
    idx.collections.ranks.files[f] = JSON.stringify(t)
    expect(kinds(idx)).toEqual([kind])
  })
  it('an attachment with no asset is reported', () => {
    const idx = makeIndex()
    const f = `threads/${IDS.R_TOC}.json`
    const t = JSON.parse(idx.collections.ranks.files[f])
    t.messages[0].attachments = [{ url: 'https://cdn.discordapp.com/attachments/1/2/x.png' }]
    idx.collections.ranks.files[f] = JSON.stringify(t)
    expect(kinds(idx)).toEqual(['missing-attachment'])
  })
  it('an invalid fix entry is reported', () => {
    const idx = makeIndex()
    idx.fixes['bad'] = { text: true, why: 'x' }
    expect(kinds(idx)).toContain('bad-fix')
  })
  it('channel mentions of unknown external channels are unaccounted without a fix', () => {
    const idx = makeIndex()
    delete idx.fixes[IDS.EXT_CHANNEL]
    expect(kinds(idx)).toEqual(['unaccounted-link'])
  })
})
```

- [ ] **Step 4: Run both and confirm they fail.** Run
  `bun run test src/lib/archive/model.test.js src/lib/archive/audit.test.js`.
  Expected: FAIL (modules not found).

- [ ] **Step 5: Implement `src/lib/archive/model.js`.**

```js
/** Decrypted archive index → queryable collections. Parses the verbatim export files; never rewrites them. */
import { COLLECTIONS } from './registry'
import { buildLinkIndex, parseDiscordRef, resolveRef, isDiscordHost } from './links'

const THREAD_FILE = /^threads\/(\d{17,20})\.json$/
const RENDERED_TYPES = new Set([0, 19])

export function createArchive(index, registry = COLLECTIONS) {
  if (!index || index.format !== 1) throw new Error('unsupported archive format')
  const collections = new Map()
  for (const def of registry) {
    const src = index.collections?.[def.key]
    if (!src) throw new Error(`archive is missing collection "${def.key}"`)
    const json = (name) => JSON.parse(src.files[name])
    const threads = new Map()
    for (const [name, text] of Object.entries(src.files)) {
      const m = THREAD_FILE.exec(name)
      if (!m) continue
      const t = JSON.parse(text)
      threads.set(m[1], { thread: t.thread, messages: orderMessages(t.messages) })
    }
    if (!threads.has(src.tocThreadId)) throw new Error(`collection "${def.key}" has no table-of-contents thread`)
    collections.set(def.key, {
      ...def,
      tocThreadId: src.tocThreadId,
      forum: json('forum.json'),
      resolve: json('resolve.json'),
      assets: json('assets.json'),
      threads,
    })
  }
  return { collections, fixes: index.fixes ?? {}, linkIndex: buildLinkIndex([...collections.values()]) }
}

export function orderMessages(messages) {
  return messages
    .filter((m) => RENDERED_TYPES.has(m.type))
    .sort((a, b) => a.position - b.position || cmpSnowflake(a.id, b.id))
}
function cmpSnowflake(a, b) {
  const x = BigInt(a)
  const y = BigInt(b)
  return x < y ? -1 : x > y ? 1 : 0
}

const cdn = (id, ext) => `https://cdn.discordapp.com/emojis/${id}.${ext}`
export function emojiFile(col, id, animated) {
  const byResolve = col.resolve.emojis?.[id]?.file
  if (byResolve) return byResolve
  const order = animated ? ['gif', 'png', 'webp'] : ['png', 'webp', 'gif']
  for (const ext of order) {
    const hit = col.assets[cdn(id, ext)]?.file
    if (hit) return hit
  }
  return null
}

export function attachmentFile(col, url) {
  return col.assets[url]?.file ?? null
}

export function threadTags(col, thread) {
  const byId = new Map((col.forum.available_tags ?? []).map((t) => [t.id, t]))
  return (thread.applied_tags ?? []).map((id) => byId.get(id)).filter(Boolean)
}

export function findThread(archive, threadId) {
  for (const col of archive.collections.values()) {
    const entry = col.threads.get(threadId)
    if (entry) return { col, entry }
  }
  return null
}

export function mentionLabel(col, archive, node) {
  if (node.kind === 'role') {
    const r = col.resolve.roles?.[node.id]
    return { label: `@${r?.name ?? 'unknown-role'}`, color: r?.color ?? null }
  }
  if (node.kind === 'user') {
    const u = col.resolve.users?.[node.id]
    return { label: `@${u?.display_name ?? u?.username ?? 'unknown-user'}`, color: null }
  }
  const inSite = findThread(archive, node.id)
  const name = inSite?.entry.thread.name ?? col.resolve.channels?.[node.id]?.name ?? 'unknown-channel'
  return { label: `#${name}`, color: null }
}

export function classifyHref(href, archive) {
  const ref = parseDiscordRef(href)
  if (ref) return resolveRef(ref, archive.linkIndex, archive.fixes)
  if (isDiscordHost(href)) return { kind: 'unaccounted', reason: 'Discord link that is not a channel/message link' }
  if (/^https?:\/\/[^/\s]/i.test(href)) return { kind: 'external', href }
  return { kind: 'text' }
}
```

- [ ] **Step 6: Implement `src/lib/archive/audit.js`.**

```js
/** Whole-archive validation. The seal step refuses to publish while any problem remains. */
import { parse, walk } from './markdown'
import { validateFixes } from './links'
import { classifyHref, emojiFile, attachmentFile } from './model'

export function auditArchive(archive) {
  const problems = validateFixes(archive.fixes, archive.linkIndex).map((detail) => ({
    collectionKey: null, threadId: null, messageId: null, kind: 'bad-fix', detail,
  }))
  const stats = { links: 0, route: 0, text: 0, external: 0 }
  for (const col of archive.collections.values()) {
    for (const [threadId, { messages }] of col.threads) {
      for (const m of messages) {
        const at = (kind, detail) => problems.push({ collectionKey: col.key, threadId, messageId: m.id, kind, detail })
        walk(parse(m.content ?? ''), (n) => {
          const href = n.type === 'link' || n.type === 'url' ? n.href : n.type === 'mention' && n.kind === 'channel' ? n.raw : null
          if (href !== null) {
            const r = classifyHref(href, archive)
            stats.links++
            if (r.kind === 'unaccounted') at('unaccounted-link', `${href} — ${r.reason}`)
            else stats[r.kind]++
          }
          if (n.type === 'emoji' && !emojiFile(col, n.id, n.animated)) at('unknown-emoji', n.raw)
          if (n.type === 'mention' && n.kind === 'role' && !col.resolve.roles?.[n.id]) at('unknown-role', n.raw)
          if (n.type === 'mention' && n.kind === 'user' && !col.resolve.users?.[n.id]) at('unknown-user', n.raw)
        })
        for (const a of m.attachments ?? []) if (!attachmentFile(col, a.url)) at('missing-attachment', a.url)
      }
    }
  }
  return { problems, stats }
}
```

`stats.links` counts channel mentions too. In the synthetic index there
are six: toT2, toRanks, the ext-channel mention, the dead link (fixed →
route), the example.com url, and backToAccolades. That's 4 route, 1 text,
1 external, as the test asserts. If a count differs, recount against
`makeIndex()` instead of adjusting the assertion blindly.

- [ ] **Step 7: Run the tests; expect PASS.** Then run coverage and
  mutation (expected: 100% on `audit.js`; `model.js` isn't gated but should
  be close to 100% line coverage).

- [ ] **Step 8: Commit.**

```bash
git add src/lib/archive/model.js src/lib/archive/audit.js src/lib/archive/testIndex.js src/lib/archive/model.test.js src/lib/archive/audit.test.js stryker.config.mjs
git commit -m "archive: collection model, mention/link classification, whole-archive audit"
```

---

### Task 7: Seal / fetch / unseal pipeline and synthetic fixture

**Files:**
- Create: `scripts/archive-fixture.mjs`, `scripts/lib/archive-seal.mjs`, `scripts/lib/archive-seal.test.mjs`, `scripts/seal-archive.mjs`
- Modify: `package.json` (script `archive`)

**Interfaces:**
- Consumes: crypto (Task 2), `createArchive` (Task 6), `auditArchive` (Task 6), `COLLECTIONS` (Task 3).
- Produces:
  - `writeFixture(dir) → {key: base64}`: writes a synthetic
    `archive-export`-shaped tree (both collections, `collections.json`,
    `link-fixes.json`, `.env`) with real PNG/GIF bytes and correct sha256s.
    Content includes the sentinel `FIXTURE-PLAINTEXT-SENTINEL`.
  - `readExport(exportDir) → {index (without kid), assets: {logicalPath, bytes}[]}` (throws on hash mismatch or missing/extra asset)
  - `sealExport({exportDir, rawKey, outDir, now}) → {kid, files: {[name]: sha256}}` (runs `auditArchive` first; throws listing problems)
  - `verifyDir(outDir, lock) → void` (throws on missing, extra, or mismatched file)
  - `unsealDir({dir, rawKey, destDir}) → void` (restores export byte-for-byte)
  - CLI `bun scripts/seal-archive.mjs <keygen|audit|seal|fetch|unseal> [--export d] [--out d] [--lock f] [--env-file f] [--publish] [--rotate]`

- [ ] **Step 1: Fixture generator.** Create `scripts/archive-fixture.mjs`:

```js
/**
 * Writes a synthetic, content-free Legion Archive export for tests and e2e.
 * Shaped like the real exporter's output; never contains real data.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { makeIndex, IDS } from '../src/lib/archive/testIndex.js'

export const SENTINEL = 'FIXTURE-PLAINTEXT-SENTINEL'
// 1x1 PNG and 1x1 GIF, real image bytes so magic-byte scanners see them.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64')

export async function writeFixture(dir) {
  const index = makeIndex()
  // Plant the sentinel in visible content of both collections.
  for (const key of ['accolades', 'ranks']) {
    const toc = index.collections[key].tocThreadId
    const f = `threads/${toc}.json`
    const t = JSON.parse(index.collections[key].files[f])
    t.messages[t.messages.length - 1].content += `\n${SENTINEL}-${key}`
    index.collections[key].files[f] = JSON.stringify(t)
  }
  const exportDirs = { accolades: 'accolades', ranks: 'rank-requirements' }
  for (const [key, col] of Object.entries(index.collections)) {
    const base = join(dir, exportDirs[key])
    await mkdir(join(base, 'data', 'threads'), { recursive: true })
    await mkdir(join(base, 'assets'), { recursive: true })
    const assets = JSON.parse(col.files['assets.json'])
    for (const entry of Object.values(assets)) {
      const bytes = entry.file.endsWith('.gif') ? GIF : PNG
      entry.sha256 = createHash('sha256').update(bytes).digest('hex')
      entry.bytes = bytes.length
      await writeFile(join(base, 'assets', entry.file), bytes)
    }
    col.files['assets.json'] = JSON.stringify(assets, null, 1)
    for (const [name, text] of Object.entries(col.files)) await writeFile(join(base, 'data', name), text)
  }
  await writeFile(join(dir, 'collections.json'), JSON.stringify({
    accolades: { tocThreadId: index.collections.accolades.tocThreadId },
    ranks: { tocThreadId: index.collections.ranks.tocThreadId },
  }, null, 2))
  await writeFile(join(dir, 'link-fixes.json'), JSON.stringify(index.fixes, null, 2))
  const key = randomBytes(32).toString('base64')
  await writeFile(join(dir, '.env'), `ARCHIVE_KEY=${key}\n`)
  return { key, ids: IDS }
}
```

Note: `makeIndex()` gives two assets (`emoji-anim.gif` and
`emoji-anim.png`) the same bytes. That's fine: hashes are per file.

- [ ] **Step 2: Write the failing pipeline tests.** Create
  `scripts/lib/archive-seal.test.mjs`:

```js
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile, writeFile, readdir, rm, unlink, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { writeFixture, SENTINEL } from '../archive-fixture.mjs'
import { readExport, sealExport, verifyDir, unsealDir, readEnvKey } from './archive-seal.mjs'
import { keyFromBase64 } from '../../src/lib/archive/crypto.js'

let root, exp, out, key
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archive-'))
  exp = join(root, 'export')
  out = join(root, 'sealed')
  key = keyFromBase64((await writeFixture(exp)).key)
})

async function tree(dir, prefix = '') {
  const res = {}
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) Object.assign(res, await tree(p, `${prefix}${e.name}/`))
    else res[`${prefix}${e.name}`] = createHash('sha256').update(await readFile(p)).digest('hex')
  }
  return res
}

describe('seal → verify → unseal', () => {
  it('restores every export file byte-for-byte and never touches the input', async () => {
    const before = await tree(exp)
    const lock = await sealExport({ exportDir: exp, rawKey: key, outDir: out, now: new Date(0) })
    expect(await tree(exp)).toEqual(before)
    await verifyDir(out, lock)
    const restored = join(root, 'restored')
    await unsealDir({ dir: out, rawKey: key, destDir: restored })
    const want = Object.fromEntries(Object.entries(before).filter(([p]) => p !== '.env'))
    expect(await tree(restored)).toEqual(want)
  })

  it('sealed output has opaque names only and contains no plaintext', async () => {
    const lock = await sealExport({ exportDir: exp, rawKey: key, outDir: out, now: new Date(0) })
    const names = await readdir(out)
    expect(names.every((n) => /^[0-9a-f]{32}\.bin$/.test(n))).toBe(true)
    expect(Object.keys(lock.files).sort()).toEqual(names.sort())
    for (const n of names) {
      const bytes = await readFile(join(out, n))
      const latin = bytes.toString('latin1')
      expect(latin.startsWith('LAR\u0001')).toBe(true)
      expect(latin).not.toContain(SENTINEL)
      expect(latin).not.toContain('\u0089PNG')
      expect(latin).not.toContain('GIF89a')
    }
  })

  it('refuses to seal while the audit has problems, listing them', async () => {
    const fixes = JSON.parse(await readFile(join(exp, 'link-fixes.json'), 'utf8'))
    for (const k of Object.keys(fixes)) delete fixes[k]
    await writeFile(join(exp, 'link-fixes.json'), JSON.stringify(fixes))
    await expect(sealExport({ exportDir: exp, rawKey: key, outDir: out, now: new Date(0) })).rejects.toThrow(/unaccounted-link/)
    await expect(readdir(out)).rejects.toThrow() // nothing written
  })

  it.each([
    ['an asset whose bytes changed', async () => writeFile(join(exp, 'accolades/assets/emoji-fixture.png'), 'x')],
    ['an asset listed but missing', async () => unlink(join(exp, 'accolades/assets/emoji-tag.png'))],
    ['an unlisted extra asset', async () => writeFile(join(exp, 'accolades/assets/stray.png'), 'x')],
    ['missing collections.json', async () => unlink(join(exp, 'collections.json'))],
  ])('readExport rejects %s', async (_, damage) => {
    await damage()
    await expect(readExport(exp)).rejects.toThrow()
  })

  it.each([
    ['a missing file', async (lock) => unlink(join(out, Object.keys(lock.files)[0]))],
    ['an extra file', async () => writeFile(join(out, 'ffffffffffffffffffffffffffffffff.bin'), 'x')],
    ['a tampered file', async (lock) => {
      const p = join(out, Object.keys(lock.files)[0])
      const b = await readFile(p)
      b[b.length - 1] ^= 1
      await writeFile(p, b)
    }],
  ])('verifyDir rejects %s', async (_, damage) => {
    const lock = await sealExport({ exportDir: exp, rawKey: key, outDir: out, now: new Date(0) })
    await damage(lock)
    await expect(verifyDir(out, lock)).rejects.toThrow()
  })

  it('unseal with the wrong key fails without writing anything', async () => {
    await sealExport({ exportDir: exp, rawKey: key, outDir: out, now: new Date(0) })
    const dest = join(root, 'nope')
    await expect(unsealDir({ dir: out, rawKey: new Uint8Array(32), destDir: dest })).rejects.toThrow()
    await expect(readdir(dest)).rejects.toThrow()
  })

  it('refuses to overwrite a non-empty outDir that is not a previous sealed output', async () => {
    await writeFile(join(root, 'marker'), 'x')
    await expect(sealExport({ exportDir: exp, rawKey: key, outDir: root, now: new Date(0) })).rejects.toThrow(/refusing/)
  })

  it('readEnvKey parses ARCHIVE_KEY from an env file and rejects junk', async () => {
    expect(readEnvKey(`# c\nARCHIVE_KEY=${Buffer.from(key).toString('base64')}\n`)).toEqual(key)
    expect(() => readEnvKey('ARCHIVE_KEY=short')).toThrow()
    expect(() => readEnvKey('OTHER=1')).toThrow(/ARCHIVE_KEY/)
  })
})
```

- [ ] **Step 3: Run and confirm it fails.** Run
  `bun run test scripts/lib/archive-seal.test.mjs`. Expected: FAIL (module
  not found).

- [ ] **Step 4: Implement `scripts/lib/archive-seal.mjs`.**

```js
/** Legion Archive seal pipeline. Plaintext in → opaque ciphertext out; never mutates the export. */
import { readFile, writeFile, readdir, mkdir, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { deriveKeys, seal, open, opaqueName, keyFromBase64 } from '../../src/lib/archive/crypto.js'
import { createArchive } from '../../src/lib/archive/model.js'
import { auditArchive } from '../../src/lib/archive/audit.js'
import { COLLECTIONS } from '../../src/lib/archive/registry.js'

const DATA_FILES = ['forum.json', 'index.json', 'links.json', 'resolve.json', 'assets.json']
const sha = (b) => createHash('sha256').update(b).digest('hex')
const enc = new TextEncoder()

export function readEnvKey(text) {
  const line = text.split(/\r?\n/).find((l) => l.startsWith('ARCHIVE_KEY='))
  if (!line) throw new Error('ARCHIVE_KEY not found in env file')
  return keyFromBase64(line.slice('ARCHIVE_KEY='.length).trim())
}

export async function readExport(exportDir) {
  const meta = JSON.parse(await readFile(join(exportDir, 'collections.json'), 'utf8'))
  const fixes = JSON.parse(await readFile(join(exportDir, 'link-fixes.json'), 'utf8'))
  const index = { format: 1, collections: {}, fixes }
  const assets = []
  for (const def of COLLECTIONS) {
    const base = join(exportDir, def.exportDir)
    const files = {}
    for (const f of DATA_FILES) files[f] = await readFile(join(base, 'data', f), 'utf8')
    for (const f of await readdir(join(base, 'data', 'threads'))) {
      files[`threads/${f}`] = await readFile(join(base, 'data', 'threads', f), 'utf8')
    }
    const listed = JSON.parse(files['assets.json'])
    const onDisk = new Set(await readdir(join(base, 'assets')))
    const done = new Set() // two CDN URLs may share one file; hash-check it once
    for (const entry of Object.values(listed)) {
      if (done.has(entry.file)) continue
      if (!onDisk.has(entry.file)) throw new Error(`${def.key}: asset ${entry.file} listed but missing`)
      const bytes = await readFile(join(base, 'assets', entry.file))
      if (sha(bytes) !== entry.sha256) throw new Error(`${def.key}: asset ${entry.file} does not match its sha256`)
      done.add(entry.file)
      onDisk.delete(entry.file)
      assets.push({ logicalPath: `${def.key}/assets/${entry.file}`, bytes: new Uint8Array(bytes) })
    }
    if (onDisk.size) throw new Error(`${def.key}: unlisted assets on disk: ${[...onDisk].join(', ')}`)
    if (!meta[def.key]?.tocThreadId) throw new Error(`collections.json has no tocThreadId for ${def.key}`)
    index.collections[def.key] = { tocThreadId: meta[def.key].tocThreadId, files }
  }
  return { index, assets }
}

async function prepareOut(outDir) {
  const existing = await readdir(outDir).catch(() => null)
  if (existing && existing.some((n) => !/^[0-9a-f]{32}\.bin$/.test(n))) {
    throw new Error(`refusing to write into ${outDir}: it contains non-archive files`)
  }
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
}

export async function sealExport({ exportDir, rawKey, outDir, now = new Date() }) {
  const { index, assets } = await readExport(exportDir)
  const keys = await deriveKeys(rawKey)
  index.kid = keys.kid
  index.sealedAt = now.toISOString()
  const { problems } = auditArchive(createArchive(index))
  if (problems.length) {
    throw new Error(`archive audit failed (${problems.length}):\n` + problems.map((p) => `  ${p.kind} ${p.collectionKey ?? ''} ${p.threadId ?? ''} ${p.messageId ?? ''} ${p.detail}`).join('\n'))
  }
  await prepareOut(outDir)
  const files = {}
  const put = async (logicalPath, bytes) => {
    const name = `${await opaqueName(keys, logicalPath)}.bin`
    const sealed = await seal(keys, logicalPath, bytes)
    await writeFile(join(outDir, name), sealed)
    files[name] = sha(sealed)
  }
  await put('index', enc.encode(JSON.stringify(index)))
  for (const a of assets) await put(a.logicalPath, a.bytes)
  return { format: 1, kid: keys.kid, files }
}

export async function verifyDir(outDir, lock) {
  const names = new Set(await readdir(outDir))
  for (const [name, hash] of Object.entries(lock.files)) {
    if (!names.delete(name)) throw new Error(`sealed file missing: ${name}`)
    if (sha(await readFile(join(outDir, name))) !== hash) throw new Error(`sealed file hash mismatch: ${name}`)
  }
  if (names.size) throw new Error(`unexpected files in ${outDir}: ${[...names].join(', ')}`)
}

export async function unsealDir({ dir, rawKey, destDir }) {
  const keys = await deriveKeys(rawKey)
  const read = async (logicalPath) => open(keys, logicalPath, new Uint8Array(await readFile(join(dir, `${await opaqueName(keys, logicalPath)}.bin`))))
  const index = JSON.parse(new TextDecoder().decode(await read('index')))
  const writes = []
  for (const def of COLLECTIONS) {
    const col = index.collections[def.key]
    const base = join(destDir, def.exportDir)
    for (const [name, text] of Object.entries(col.files)) writes.push([join(base, 'data', name), enc.encode(text)])
    for (const entry of Object.values(JSON.parse(col.files['assets.json']))) {
      writes.push([join(base, 'assets', entry.file), await read(`${def.key}/assets/${entry.file}`)])
    }
  }
  writes.push([join(destDir, 'collections.json'), enc.encode(JSON.stringify(Object.fromEntries(
    Object.entries(index.collections).map(([k, c]) => [k, { tocThreadId: c.tocThreadId }]),
  ), null, 2))])
  writes.push([join(destDir, 'link-fixes.json'), enc.encode(JSON.stringify(index.fixes, null, 2))])
  // Everything decrypted and authenticated before the first byte is written.
  for (const [p, bytes] of writes) {
    await mkdir(join(p, '..'), { recursive: true })
    await writeFile(p, bytes)
  }
}
```

About the byte-for-byte test for `collections.json` and `link-fixes.json`:
unseal re-serializes them, so the fixture writes them with the same
`JSON.stringify(…, null, 2)` formatting. The **export data** (the part
under the "never mutate" rule) is restored verbatim from the stored
strings. If the round-trip test fails on those two files, also store
their raw text in the index (`index.meta = {collectionsRaw, fixesRaw}`)
and write that back instead.

- [ ] **Step 5: Run the tests; expect PASS.**

- [ ] **Step 6: CLI.** Create `scripts/seal-archive.mjs`:

```js
/**
 * Legion Archive CLI (run with bun or node ≥20):
 *   keygen [--rotate]      write a new ARCHIVE_KEY to archive-export/.env
 *   audit                  list every archive problem (local terminal only — never paste output anywhere public)
 *   seal [--publish]       audit, seal into public/archive/, write archive.lock.json; --publish uploads a GitHub Release
 *   fetch                  CI: download the lock's release into public/archive/ and verify it
 *   unseal --out <dir>     recover the export from public/archive/ (or a fetched release) with the key
 */
import { readFile, writeFile, mkdtemp, rm, access } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { randomBytes } from 'node:crypto'
import { sealExport, verifyDir, unsealDir, readEnvKey, readExport } from './lib/archive-seal.mjs'
import { deriveKeys } from '../src/lib/archive/crypto.js'
import { createArchive } from '../src/lib/archive/model.js'
import { auditArchive } from '../src/lib/archive/audit.js'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    export: { type: 'string', default: 'archive-export' },
    out: { type: 'string', default: 'public/archive' },
    lock: { type: 'string', default: 'archive.lock.json' },
    'env-file': { type: 'string' },
    publish: { type: 'boolean', default: false },
    rotate: { type: 'boolean', default: false },
  },
})
const cmd = positionals[0]
const envFile = values['env-file'] ?? join(values.export, '.env')
const exists = (p) => access(p).then(() => true, () => false)
const key = async () => readEnvKey(await readFile(envFile, 'utf8'))
const sh = (bin, args, opts = {}) => execFileSync(bin, args, { stdio: 'inherit', ...opts })

async function main() {
  if (cmd === 'keygen') {
    if ((await exists(envFile)) && !values.rotate) throw new Error(`${envFile} exists; pass --rotate to replace the key`)
    await writeFile(envFile, `ARCHIVE_KEY=${randomBytes(32).toString('base64')}\n`, { mode: 0o600 })
    console.log(`New key written to ${envFile}. Store it in your password manager now, then set it as the server's ARCHIVE_KEY.`)
    return
  }
  if (cmd === 'audit') {
    const { index } = await readExport(values.export)
    const { problems, stats } = auditArchive(createArchive(index))
    console.log(JSON.stringify(stats))
    for (const p of problems) console.log(`${p.kind}\t${p.collectionKey ?? '-'}\t${p.threadId ?? '-'}\t${p.messageId ?? '-'}\t${p.detail}`)
    process.exitCode = problems.length ? 1 : 0
    return
  }
  if (cmd === 'seal') {
    const lock = await sealExport({ exportDir: values.export, rawKey: await key(), outDir: values.out })
    const prev = (await exists(values.lock)) ? JSON.parse(await readFile(values.lock, 'utf8')) : null
    const n = prev?.release ? Number(prev.release.replace('archive-v', '')) + 1 : 1
    lock.release = values.publish ? `archive-v${n}` : prev?.release ?? null
    if (values.publish) {
      const tmp = await mkdtemp(join(tmpdir(), 'archive-pub-'))
      const tar = join(tmp, `archive-${lock.kid}.tar`)
      sh('tar', ['-cf', tar, '-C', values.out, '.'])
      sh('gh', ['release', 'create', lock.release, tar, '--title', lock.release, '--notes', 'Sealed Legion Archive (ciphertext only).'])
      await rm(tmp, { recursive: true, force: true })
    }
    await writeFile(values.lock, JSON.stringify(lock, null, 2) + '\n')
    console.log(`sealed ${Object.keys(lock.files).length} files, kid ${lock.kid}${values.publish ? `, published ${lock.release}` : ''}`)
    return
  }
  if (cmd === 'fetch') {
    if (!(await exists(values.lock))) return console.log('no archive.lock.json — archive not published yet, skipping')
    const lock = JSON.parse(await readFile(values.lock, 'utf8'))
    if (!lock.release) throw new Error('archive.lock.json has no release — run `seal --publish` first')
    const tmp = await mkdtemp(join(tmpdir(), 'archive-fetch-'))
    sh('gh', ['release', 'download', lock.release, '--pattern', '*.tar', '--dir', tmp])
    await rm(values.out, { recursive: true, force: true })
    sh('mkdir', ['-p', values.out])
    sh('tar', ['-xf', join(tmp, `archive-${lock.kid}.tar`), '-C', values.out])
    await verifyDir(values.out, lock)
    await rm(tmp, { recursive: true, force: true })
    console.log(`verified ${Object.keys(lock.files).length} sealed files from ${lock.release}`)
    return
  }
  if (cmd === 'unseal') {
    const k = await key()
    const lock = JSON.parse(await readFile(values.lock, 'utf8'))
    if ((await deriveKeys(k)).kid !== lock.kid) throw new Error('key does not match archive.lock.json kid')
    await verifyDir(values.out, lock)
    const dest = positionals[1] ?? 'archive-export-restored'
    await unsealDir({ dir: values.out, rawKey: k, destDir: dest })
    console.log(`restored export into ${dest}`)
    return
  }
  console.log('usage: seal-archive.mjs keygen|audit|seal|fetch|unseal')
  process.exitCode = 2
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
```

Add `"archive": "bun scripts/seal-archive.mjs"` to the `package.json`
scripts.

- [ ] **Step 7: CLI smoke test on the fixture.**

```bash
D=$(mktemp -d) && bun -e "import {writeFixture} from './scripts/archive-fixture.mjs'; await writeFixture('$D/x')" \
 && bun scripts/seal-archive.mjs audit --export $D/x && bun scripts/seal-archive.mjs seal --export $D/x --out $D/out --lock $D/lock.json \
 && bun scripts/seal-archive.mjs unseal --export $D/x --out $D/out --lock $D/lock.json $D/restored && diff -r $D/x/accolades $D/restored/accolades && echo OK; rm -rf $D
```

Expected: stats JSON, `sealed N files`, `restored export`, and `OK` with
no diff output.

- [ ] **Step 8: Commit.**

```bash
git add scripts/archive-fixture.mjs scripts/lib/archive-seal.mjs scripts/lib/archive-seal.test.mjs scripts/seal-archive.mjs package.json
git commit -m "archive: seal/fetch/unseal pipeline with audit gate and synthetic fixture"
```

---

### Task 8: Link fixes and the real-export integrity test (local only)

This task handles real content. **Nothing produced here is committed
except the test file**, which reads `archive-export/` at runtime and skips
when it's absent (as in CI).

**Files:**
- Create (local, gitignored): `archive-export/link-fixes.json`, `archive-export/.env`
- Create (committed): `scripts/lib/real-export.test.mjs`

- [ ] **Step 1: Generate the key.** Run `bun run archive keygen`. Then
  **stop and ask the user** to store the printed key's file contents
  (`archive-export/.env`) in their password manager before continuing.

- [ ] **Step 2: Start with an empty overlay and audit.**

```bash
echo '{}' > archive-export/link-fixes.json
bun run archive audit > /tmp/archive-audit.tsv; echo "exit $?"; cut -f1 /tmp/archive-audit.tsv | sort | uniq -c
```

Expected: exit 1. The problems should be about 14 dead links plus one
`unaccounted-link` per distinct external channel target (roughly 30).
Mentions and assets should report zero `unknown-*` and zero
`missing-attachment` (verified during brainstorming). Any
`unknown-emoji`/`unknown-role`/`unknown-user`/`missing-attachment` means
the resolver disagrees with the exporter: investigate before adding
fixes.

- [ ] **Step 3: Fix each dead-message link.** For each `unaccounted-link`
  whose detail says "no longer exists", find the replacement message in the
  target thread: the message whose content contains the link's visible
  label (e.g. the rank or accolade name as a heading or bold line). Use:

```bash
bun -e '
const [thread, label] = process.argv.slice(1)
const fs = await import("node:fs")
for (const c of ["accolades", "rank-requirements"]) {
  const p = `archive-export/${c}/data/threads/${thread}.json`
  if (!fs.existsSync(p)) continue
  for (const m of JSON.parse(fs.readFileSync(p, "utf8")).messages)
    if ((m.content || "").toLowerCase().includes(label.toLowerCase())) console.log(m.id, m.type, (m.content || "").split("\n").find((l) => l.toLowerCase().includes(label.toLowerCase())).slice(0, 120))
}' <targetThreadId> "<link label>"
```

Add one entry per dead link, keyed `"<threadId>/<deadMessageId>"`, as
`{"to": "<threadId>/<replacementId>", "why": "label '<label>' is in replacement message <id>"}`.
If more than one message matches, choose the one where the label is a
heading or the first bold line. If none matches, use
`{"to": "<threadId>", "why": "no replacement post; linking thread top"}`.

- [ ] **Step 4: Map external channels.** For each remaining
  `unaccounted-link` whose target is outside the archive, apply these rules
  in order, then record the decision as a channel-level fix (keyed by the
  channel id alone):
  1. The two external targets the exporter could not name (no
     `target_name` in `links.json`, no entry in `resolve.json`) are exactly
     the two the user ruled out on 2026-09-24. Both exist on Discord, and
     the accolades forum is authoritative for their content. Give each
     `{"text": true, "why": "user decision 2026-09-24: accolades forum is authoritative"}`.
  2. If a thread in either collection is the clear equivalent (same name or
     purpose, e.g. a specialty group's channel when that group has a Ranks
     thread), use `{"to": "<thatThreadId>", "why": "equivalent in-site page"}`.
  3. The repeated navigation-footer link to the server's own
     "table of contents" channel becomes
     `{"to": "<accolades tocThreadId>", "why": "footer ToC → archive ToC"}`.
     If the audit shows the footer in both collections, map it to each
     collection's own ToC with message-level keys instead.
  4. Everything else (reporting, verification, submissions, trials,
     leaderboards, company homes, the server directory, legacy/archived
     channels) gets `{"text": true, "why": "outside the archive; not linked per no-Discord-links rule"}`.

  Get the target channel names from each export's `links.json`
  (`target_name`) and `resolve.json` (`channels`), in the local terminal
  only. Every `why` stays inside the sealed overlay, so it can be as
  specific as needed.

- [ ] **Step 5: Re-audit until clean.** Run
  `bun run archive audit; echo "exit $?"`. Expected: `exit 0`, and the
  stats line shows `text` + `route` + `external` = `links`. The single
  `external` should be the one wiki link.

- [ ] **Step 6: Write the real-export integrity test.** Create
  `scripts/lib/real-export.test.mjs`:

```js
/**
 * Local-only guarantees against the real, gitignored export. Skipped in CI
 * (where archive-export/ never exists). Never prints content.
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile, readdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { readExport, sealExport, unsealDir, readEnvKey } from './archive-seal.mjs'
import { createArchive } from '../../src/lib/archive/model.js'
import { auditArchive } from '../../src/lib/archive/audit.js'
import { parse, plainText } from '../../src/lib/archive/markdown.js'

const EXPORT = 'archive-export'
const present = existsSync(join(EXPORT, '.env'))
const sha = (b) => createHash('sha256').update(b).digest('hex')

async function hashTree(dir, prefix = '') {
  const out = {}
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (prefix === '' && (e.name === '.env' || e.name === 'link-fixes.json' || e.name === 'collections.json')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) Object.assign(out, await hashTree(p, `${prefix}${e.name}/`))
    else out[`${prefix}${e.name}`] = [sha(await readFile(p)), (await stat(p)).mtimeMs]
  }
  return out
}

describe.skipIf(!present)('real export (local only)', () => {
  it('audits clean: every link, mention, emoji, and attachment accounted for', async () => {
    const { index } = await readExport(EXPORT)
    const { problems } = auditArchive(createArchive(index))
    expect(problems.map((p) => `${p.kind} ${p.threadId}/${p.messageId}`)).toEqual([])
  })

  it('every message keeps every letter and digit through the parser', async () => {
    const { index } = await readExport(EXPORT)
    const alnum = (s) => s.replace(/[^\p{L}\p{N}]/gu, '')
    for (const col of Object.values(index.collections)) {
      for (const [name, text] of Object.entries(col.files)) {
        if (!name.startsWith('threads/')) continue
        for (const m of JSON.parse(text).messages) {
          const s = m.content ?? ''
          expect(alnum(plainText(parse(s), { raw: true })), `message ${m.id}`).toBe(alnum(s))
        }
      }
    }
  })

  it('seal → unseal reproduces the export byte-for-byte and leaves inputs untouched (hash + mtime)', async () => {
    const before = await hashTree(EXPORT)
    const tmp = await mkdtemp(join(tmpdir(), 'real-archive-'))
    try {
      const key = readEnvKey(await readFile(join(EXPORT, '.env'), 'utf8'))
      await sealExport({ exportDir: EXPORT, rawKey: key, outDir: join(tmp, 'out') })
      await unsealDir({ dir: join(tmp, 'out'), rawKey: key, destDir: join(tmp, 'restored') })
      const restored = await hashTree(join(tmp, 'restored'))
      const strip = (t) => Object.fromEntries(Object.entries(t).map(([k, [h]]) => [k, h]))
      expect(strip(restored)).toEqual(strip(before))
      expect(await hashTree(EXPORT)).toEqual(before)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }, 120_000)
})
```

- [ ] **Step 7: Run it; expect PASS (3 tests).** Then confirm it skips
  cleanly without the export:
  `mv archive-export /tmp/ae && bun run test scripts/lib/real-export.test.mjs; mv /tmp/ae archive-export`.
  Expected: `3 skipped`.

- [ ] **Step 8: Commit (test only).**

```bash
git status --short   # must list only scripts/lib/real-export.test.mjs
git add scripts/lib/real-export.test.mjs
git commit -m "archive: local-only integrity test against the real export"
```

---

### Task 9: Browser client and Pinia store

**Files:**
- Create: `src/lib/archive/client.js`, `src/lib/archive/client.test.js`, `src/lib/archive/buildConfig.js`, `src/stores/archive.js`, `src/stores/archive.test.js`
- Modify: `src/lib/buildsApi.js` (export `API_BASE`), `vite.config.js` (define)

**Interfaces:**
- Consumes: crypto (Task 2), `createArchive` (Task 6).
- Produces:
  - `class ArchiveAccessError extends Error { state: 'signed-out'|'restricted'|'unavailable'|'outdated'|'integrity'|'unpublished' }`
  - `fetchKey({apiBase, token, fetchImpl}) → {raw: Uint8Array, kid}`
  - `loadArchive({apiBase, token, expectedKid, assetBase, fetchImpl}) → {keys, index}`
  - `loadAssetBlob({keys, assetBase, logicalPath, fetchImpl}) → Blob` (MIME from the extension)
  - Store `useArchive()`: state `{status: 'idle'|'loading'|'ready'|'error', error: state|null, archive}`; actions `load(token)`, `assetUrl(collectionKey, file) → Promise<string>`, `reset()`, `retry(token)`.

- [ ] **Step 1: Build config.** Create `src/lib/archive/buildConfig.js`:

```js
/* global __ARCHIVE_KID__, __ARCHIVE_BASE__ */
// Injected by vite.config.js from archive.lock.json. Absent under vitest.
export const ARCHIVE_KID = typeof __ARCHIVE_KID__ !== 'undefined' ? __ARCHIVE_KID__ : null
export const ARCHIVE_BASE = typeof __ARCHIVE_BASE__ !== 'undefined' ? __ARCHIVE_BASE__ : '/archive/'
```

In `vite.config.js`, add these imports and constants above
`defineConfig`, plus a `define` key:

```js
import { existsSync, readFileSync } from 'node:fs'

// Legion Archive: only the key id travels in the bundle (to detect a
// stale page), never the key. ARCHIVE_LOCK / VITE_ARCHIVE_BASE let the
// e2e stack point at its own throwaway sealed fixture.
const lockPath = process.env.ARCHIVE_LOCK || 'archive.lock.json'
const archiveLock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : null
```

```js
  define: {
    __ARCHIVE_KID__: JSON.stringify(archiveLock?.kid ?? null),
    __ARCHIVE_BASE__: JSON.stringify(process.env.VITE_ARCHIVE_BASE || '/archive/'),
  },
```

In `src/lib/buildsApi.js`, change `const BASE_URL = …` to
`export const API_BASE = …` and replace the use of `BASE_URL` with
`API_BASE`.

- [ ] **Step 2: Write the failing client tests.** Create
  `src/lib/archive/client.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { fetchKey, loadArchive, loadAssetBlob, ArchiveAccessError } from './client'
import { deriveKeys, seal, opaqueName, keyToBase64 } from './crypto'
import { makeIndex } from './testIndex'

const RAW = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const enc = (s) => new TextEncoder().encode(s)

async function server({ keyStatus = 200, keyBody, files = {}, throwOn } = {}) {
  const keys = await deriveKeys(RAW)
  const body = keyBody ?? { key: keyToBase64(RAW), kid: keys.kid }
  return {
    keys,
    fetchImpl: async (url, init) => {
      if (throwOn && url.includes(throwOn)) throw new TypeError('network')
      if (url.endsWith('/archive/key')) return new Response(JSON.stringify(body), { status: keyStatus })
      const name = url.split('/').pop()
      return name in files ? new Response(files[name]) : new Response('nope', { status: 404 })
    },
  }
}
async function state(p) {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(ArchiveAccessError)
    return e.state
  }
  throw new Error('expected rejection')
}

describe('fetchKey', () => {
  it.each([
    [401, 'signed-out'], [403, 'restricted'], [503, 'unavailable'], [500, 'unavailable'], [429, 'unavailable'],
  ])('HTTP %i → %s', async (status, want) => {
    const s = await server({ keyStatus: status })
    expect(await state(fetchKey({ apiBase: 'https://api', token: 't', fetchImpl: s.fetchImpl }))).toBe(want)
  })
  it('no token → signed-out without any request', async () => {
    let called = false
    expect(await state(fetchKey({ apiBase: 'x', token: null, fetchImpl: async () => ((called = true), new Response()) }))).toBe('signed-out')
    expect(called).toBe(false)
  })
  it('network error → unavailable', async () => {
    const s = await server({ throwOn: '/archive/key' })
    expect(await state(fetchKey({ apiBase: 'https://api', token: 't', fetchImpl: s.fetchImpl }))).toBe('unavailable')
  })
  it.each([[{}], [{ key: 'short', kid: 'x' }], [null]])('malformed 200 body %j → unavailable', async (keyBody) => {
    const s = await server({ keyBody })
    expect(await state(fetchKey({ apiBase: 'https://api', token: 't', fetchImpl: s.fetchImpl }))).toBe('unavailable')
  })
  it('sends the bearer token and asks for no caching', async () => {
    let seen
    const s = await server()
    await fetchKey({ apiBase: 'https://api', token: 'tok', fetchImpl: async (u, i) => ((seen = i), s.fetchImpl(u, i)) })
    expect(seen.headers.Authorization).toBe('Bearer tok')
    expect(seen.cache).toBe('no-store')
  })
})

describe('loadArchive', () => {
  async function sealedIndex(keys, index = { ...makeIndex(), kid: keys.kid }) {
    return { [`${await opaqueName(keys, 'index')}.bin`]: await seal(keys, 'index', enc(JSON.stringify(index))) }
  }
  it('returns keys and the decrypted index', async () => {
    const s = await server()
    const files = await sealedIndex(s.keys)
    const s2 = await server({ files })
    const r = await loadArchive({ apiBase: 'https://api', token: 't', expectedKid: s.keys.kid, assetBase: '/archive/', fetchImpl: s2.fetchImpl })
    expect(r.index.collections.accolades.tocThreadId).toBe(makeIndex().collections.accolades.tocThreadId)
  })
  it('null expectedKid → unpublished, no key request made', async () => {
    let called = false
    expect(await state(loadArchive({ apiBase: 'x', token: 't', expectedKid: null, assetBase: '/a/', fetchImpl: async () => ((called = true), new Response()) }))).toBe('unpublished')
    expect(called).toBe(false)
  })
  it('server kid ≠ bundle kid → outdated', async () => {
    const s = await server()
    expect(await state(loadArchive({ apiBase: 'https://api', token: 't', expectedKid: 'ffffffffffffffff', assetBase: '/a/', fetchImpl: s.fetchImpl }))).toBe('outdated')
  })
  it('server returns a key whose real kid differs from the kid it claims → outdated', async () => {
    const s = await server({ keyBody: { key: keyToBase64(new Uint8Array(32)), kid: (await deriveKeys(RAW)).kid } })
    expect(await state(loadArchive({ apiBase: 'https://api', token: 't', expectedKid: s.keys.kid, assetBase: '/a/', fetchImpl: s.fetchImpl }))).toBe('outdated')
  })
  it('index missing (404) → outdated', async () => {
    const s = await server()
    expect(await state(loadArchive({ apiBase: 'https://api', token: 't', expectedKid: s.keys.kid, assetBase: '/a/', fetchImpl: s.fetchImpl }))).toBe('outdated')
  })
  it('tampered index → integrity', async () => {
    const s = await server()
    const files = await sealedIndex(s.keys)
    const [name] = Object.keys(files)
    files[name][files[name].length - 1] ^= 1
    const s2 = await server({ files })
    expect(await state(loadArchive({ apiBase: 'https://api', token: 't', expectedKid: s.keys.kid, assetBase: '/a/', fetchImpl: s2.fetchImpl }))).toBe('integrity')
  })
  it('index kid disagreeing with the key → integrity', async () => {
    const s = await server()
    const files = await sealedIndex(s.keys, { ...makeIndex(), kid: '0000000000000000' })
    const s2 = await server({ files })
    expect(await state(loadArchive({ apiBase: 'https://api', token: 't', expectedKid: s.keys.kid, assetBase: '/a/', fetchImpl: s2.fetchImpl }))).toBe('integrity')
  })
  it('index that decrypts but is not JSON → integrity', async () => {
    const s = await server()
    const files = { [`${await opaqueName(s.keys, 'index')}.bin`]: await seal(s.keys, 'index', enc('{nope')) }
    const s2 = await server({ files })
    expect(await state(loadArchive({ apiBase: 'https://api', token: 't', expectedKid: s.keys.kid, assetBase: '/a/', fetchImpl: s2.fetchImpl }))).toBe('integrity')
  })
})

describe('loadAssetBlob', () => {
  it.each([['a.png', 'image/png'], ['a.gif', 'image/gif'], ['a.jpg', 'image/jpeg'], ['a.webp', 'image/webp'], ['a.bin', 'application/octet-stream']])(
    '%s decrypts with MIME %s',
    async (file, mime) => {
      const s = await server()
      const logicalPath = `accolades/assets/${file}`
      const files = { [`${await opaqueName(s.keys, logicalPath)}.bin`]: await seal(s.keys, logicalPath, enc('img')) }
      const s2 = await server({ files })
      const blob = await loadAssetBlob({ keys: s.keys, assetBase: '/archive/', logicalPath, fetchImpl: s2.fetchImpl })
      expect(blob.type).toBe(mime)
      expect(await blob.text()).toBe('img')
    },
  )
  it('404 or tamper rejects (the image component shows its fallback)', async () => {
    const s = await server()
    await expect(loadAssetBlob({ keys: s.keys, assetBase: '/archive/', logicalPath: 'accolades/assets/x.png', fetchImpl: s.fetchImpl })).rejects.toThrow()
  })
})
```

- [ ] **Step 3: Run and confirm it fails.** Run
  `bun run test src/lib/archive/client.test.js`. Expected: FAIL (module not
  found).

- [ ] **Step 4: Implement `src/lib/archive/client.js`.**

```js
/**
 * Browser side of the Legion Archive: get the key from the role-gated API,
 * fetch + decrypt ciphertext from the static site. The key only ever lives
 * in memory (returned to the caller, never stored).
 */
import { deriveKeys, open, opaqueName, keyFromBase64 } from './crypto'

export class ArchiveAccessError extends Error {
  constructor(state, message = state) {
    super(message)
    this.name = 'ArchiveAccessError'
    this.state = state
  }
}

const MIME = { png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

export async function fetchKey({ apiBase, token, fetchImpl = fetch }) {
  if (!token) throw new ArchiveAccessError('signed-out')
  let res
  try {
    res = await fetchImpl(`${apiBase}/archive/key`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
  } catch {
    throw new ArchiveAccessError('unavailable')
  }
  if (res.status === 401) throw new ArchiveAccessError('signed-out')
  if (res.status === 403) throw new ArchiveAccessError('restricted')
  if (!res.ok) throw new ArchiveAccessError('unavailable')
  const body = await res.json().catch(() => null)
  try {
    return { raw: keyFromBase64(body?.key), kid: body?.kid }
  } catch {
    throw new ArchiveAccessError('unavailable')
  }
}

async function fetchBytes(url, fetchImpl) {
  const res = await fetchImpl(url)
  if (!res.ok) throw new ArchiveAccessError('outdated', `missing ${url}`)
  return new Uint8Array(await res.arrayBuffer())
}

export async function loadArchive({ apiBase, token, expectedKid, assetBase, fetchImpl = fetch }) {
  if (!expectedKid) throw new ArchiveAccessError('unpublished')
  const { raw, kid } = await fetchKey({ apiBase, token, fetchImpl })
  const keys = await deriveKeys(raw)
  if (kid !== expectedKid || keys.kid !== expectedKid) throw new ArchiveAccessError('outdated')
  let bytes
  try {
    bytes = await fetchBytes(`${assetBase}${await opaqueName(keys, 'index')}.bin`, fetchImpl)
  } catch (e) {
    throw e instanceof ArchiveAccessError ? e : new ArchiveAccessError('unavailable')
  }
  let index
  try {
    index = JSON.parse(new TextDecoder().decode(await open(keys, 'index', bytes)))
  } catch {
    throw new ArchiveAccessError('integrity')
  }
  if (index?.kid !== keys.kid || index?.format !== 1) throw new ArchiveAccessError('integrity')
  return { keys, index }
}

export async function loadAssetBlob({ keys, assetBase, logicalPath, fetchImpl = fetch }) {
  const bytes = await fetchBytes(`${assetBase}${await opaqueName(keys, logicalPath)}.bin`, fetchImpl)
  const plain = await open(keys, logicalPath, bytes)
  const ext = logicalPath.split('.').pop().toLowerCase()
  return new Blob([plain], { type: MIME[ext] ?? 'application/octet-stream' })
}
```

- [ ] **Step 5: Store tests.** Create `src/stores/archive.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useArchive } from './archive'
import { ArchiveAccessError } from '../lib/archive/client'
import { makeIndex } from '../lib/archive/testIndex'

beforeEach(() => setActivePinia(createPinia()))

const ok = () => async () => ({ keys: { fake: true }, index: makeIndex() })
const fail = (state) => async () => { throw new ArchiveAccessError(state) }

describe('useArchive', () => {
  it('load → ready with a parsed archive', async () => {
    const s = useArchive()
    await s.load('tok', { loadArchive: ok() })
    expect(s.status).toBe('ready')
    expect(s.archive.collections.get('ranks')).toBeTruthy()
  })
  it.each(['signed-out', 'restricted', 'unavailable', 'outdated', 'integrity', 'unpublished'])('access error %s → error state', async (st) => {
    const s = useArchive()
    await s.load('tok', { loadArchive: fail(st) })
    expect(s.status).toBe('error')
    expect(s.error).toBe(st)
    expect(s.archive).toBeNull()
  })
  it('a malformed index → integrity (never partial content)', async () => {
    const s = useArchive()
    await s.load('tok', { loadArchive: async () => ({ keys: {}, index: { format: 1, collections: {} } }) })
    expect([s.status, s.error, s.archive]).toEqual(['error', 'integrity', null])
  })
  it('concurrent loads share one request', async () => {
    const s = useArchive()
    let calls = 0
    const slow = async () => (calls++, await new Promise((r) => setTimeout(r, 10)), { keys: {}, index: makeIndex() })
    await Promise.all([s.load('t', { loadArchive: slow }), s.load('t', { loadArchive: slow })])
    expect(calls).toBe(1)
  })
  it('assetUrl caches per file and reset revokes every blob URL synchronously and clears content', async () => {
    const revoked = []
    let n = 0
    URL.createObjectURL = () => `blob:${++n}`
    URL.revokeObjectURL = (u) => revoked.push(u)
    const s = useArchive()
    await s.load('tok', { loadArchive: ok() })
    const blob = async () => new Blob(['x'], { type: 'image/png' })
    const a = await s.assetUrl('accolades', 'emoji-fixture.png', { loadAssetBlob: blob })
    const b = await s.assetUrl('accolades', 'emoji-fixture.png', { loadAssetBlob: blob })
    const c = await s.assetUrl('ranks', 'emoji-fixture.png', { loadAssetBlob: blob })
    expect(a).toBe(b)
    expect(c).not.toBe(a)
    s.reset()
    expect(revoked.sort()).toEqual([a, c].sort())
    expect([s.status, s.archive]).toEqual(['idle', null])
  })
  it('an asset that finishes decrypting after reset is revoked, not leaked', async () => {
    const revoked = []
    URL.createObjectURL = () => 'blob:late'
    URL.revokeObjectURL = (u) => revoked.push(u)
    const s = useArchive()
    await s.load('tok', { loadArchive: ok() })
    let release
    const pending = s.assetUrl('accolades', 'big.png', { loadAssetBlob: () => new Promise((r) => (release = r)) })
    s.reset()
    release(new Blob(['x']))
    await pending
    expect(revoked).toEqual(['blob:late'])
  })
  it('assetUrl before ready rejects', async () => {
    await expect(useArchive().assetUrl('accolades', 'x.png')).rejects.toThrow(/not loaded/)
  })
  it('retry clears an error and loads again', async () => {
    const s = useArchive()
    await s.load('tok', { loadArchive: fail('unavailable') })
    await s.retry('tok', { loadArchive: ok() })
    expect(s.status).toBe('ready')
  })
})
```

- [ ] **Step 6: Implement `src/stores/archive.js`.**

```js
import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import { loadArchive, loadAssetBlob, ArchiveAccessError } from '../lib/archive/client'
import { createArchive } from '../lib/archive/model'
import { ARCHIVE_KID, ARCHIVE_BASE } from '../lib/archive/buildConfig'
import { API_BASE } from '../lib/buildsApi'

// Kept outside reactive state on purpose: the key must never be serialised
// by devtools or persisted, and blob URLs need revoking on reset.
let keys = null
let inflight = null
const blobs = new Map() // logical path → Promise<blob URL>
const live = new Set() // resolved blob URLs, revoked synchronously on reset

export const useArchive = defineStore('archive', {
  state: () => ({ status: 'idle', error: null, archive: null }),
  actions: {
    load(token, deps = {}) {
      if (this.status === 'ready') return Promise.resolve()
      if (inflight) return inflight
      this.status = 'loading'
      this.error = null
      inflight = (async () => {
        try {
          const res = await (deps.loadArchive ?? loadArchive)({ apiBase: API_BASE, token, expectedKid: ARCHIVE_KID, assetBase: ARCHIVE_BASE })
          const archive = createArchive(res.index)
          keys = res.keys
          this.archive = markRaw(archive)
          this.status = 'ready'
        } catch (e) {
          keys = null
          this.archive = null
          this.status = 'error'
          this.error = e instanceof ArchiveAccessError ? e.state : 'integrity'
        } finally {
          inflight = null
        }
      })()
      return inflight
    },
    retry(token, deps) {
      this.reset()
      return this.load(token, deps)
    },
    assetUrl(collectionKey, file, deps = {}) {
      if (!keys) return Promise.reject(new Error('archive not loaded'))
      const logicalPath = `${collectionKey}/assets/${file}`
      if (!blobs.has(logicalPath)) {
        const session = keys
        const p = (deps.loadAssetBlob ?? loadAssetBlob)({ keys, assetBase: ARCHIVE_BASE, logicalPath }).then((b) => {
          const url = URL.createObjectURL(b)
          // Signed out (or reset) while this was decrypting: don't keep it.
          if (keys !== session) URL.revokeObjectURL(url)
          else live.add(url)
          return url
        })
        p.catch(() => blobs.delete(logicalPath))
        blobs.set(logicalPath, p)
      }
      return blobs.get(logicalPath)
    },
    reset() {
      keys = null
      for (const u of live) URL.revokeObjectURL(u)
      live.clear()
      blobs.clear()
      this.$reset()
    },
  },
})
```

- [ ] **Step 7: Run the tests; expect PASS.** Then run the whole suite:
  `bun run test` (existing `buildsApi` tests must still pass after the
  rename).

- [ ] **Step 8: Commit.**

```bash
git add src/lib/archive/client.js src/lib/archive/client.test.js src/lib/archive/buildConfig.js src/stores/archive.js src/stores/archive.test.js src/lib/buildsApi.js vite.config.js
git commit -m "archive: browser key/index/asset client and in-memory store"
```

---

### Task 10: Pages, renderer, gate, navigation

**Files:**
- Create: `src/components/archive/ArchiveMarkdown.js`, `src/components/archive/ArchiveImage.vue`, `src/components/archive/ArchiveThread.vue`, `src/components/archive/ArchiveGate.vue`, `src/views/ArchiveView.vue`, `src/components/archive/archive.test.js`, `src/lib/archive/anchor.js`
- Modify: `src/router.js`, `src/components/AppNav.vue`

**Interfaces:**
- Consumes: the store (Task 9), model functions (Task 6), `parse` (Task 4), `classifyHref` (Task 6).
- Produces: routes `/accolades`, `/accolades/:threadId`, `/ranks`, `/ranks/:threadId`. `anchor.js` exports `stashAnchor(hash)`, `takeAnchor() → string|null`.

- [ ] **Step 1: Anchor stash (Review Focus #1).** Create
  `src/lib/archive/anchor.js`:

```js
// discordAuth deliberately drops the URL hash across sign-in (see its
// tests). The archive keeps exactly one validated message anchor itself.
const KEY = 'salamanders-archive-anchor'
const ANCHOR = /^#m-\d{17,20}$/

export function stashAnchor(hash) {
  if (ANCHOR.test(hash)) sessionStorage.setItem(KEY, hash)
  else sessionStorage.removeItem(KEY)
}
export function takeAnchor() {
  const v = sessionStorage.getItem(KEY)
  sessionStorage.removeItem(KEY)
  return v && ANCHOR.test(v) ? v : null
}
```

- [ ] **Step 2: Markdown renderer.** Create
  `src/components/archive/ArchiveMarkdown.js`:

```js
/**
 * AST → VNodes. Text goes through Vue's escaping; there is no v-html
 * anywhere in the archive. Links come only from classifyHref: route,
 * external https, or plain text.
 */
import { defineComponent, h, ref } from 'vue'
import { RouterLink } from 'vue-router'

const Spoiler = defineComponent({
  name: 'ArchiveSpoiler',
  setup(_, { slots }) {
    const shown = ref(false)
    const reveal = () => (shown.value = true)
    return () =>
      h('span', {
        class: ['md-spoiler', { 'is-shown': shown.value }],
        role: 'button',
        tabindex: shown.value ? -1 : 0,
        'aria-expanded': String(shown.value),
        'aria-label': shown.value ? undefined : 'Spoiler, activate to reveal',
        onClick: reveal,
        onKeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), reveal()),
      }, slots.default?.())
  },
})

export default defineComponent({
  name: 'ArchiveMarkdown',
  props: {
    nodes: { type: Array, required: true },
    // { link(href) → classifyHref result, emoji(node) → VNode, mention(node) → {label, color} }
    ctx: { type: Object, required: true },
  },
  setup(props) {
    const inl = (nodes) => nodes.map((n) => inline(n, props.ctx))
    function block(n) {
      switch (n.type) {
        case 'heading': return h(`h${n.level + 1}`, { class: `md-h md-h${n.level}` }, inl(n.children))
        case 'subtext': return h('p', { class: 'md-sub' }, inl(n.children))
        case 'quote': return h('blockquote', { class: 'md-quote' }, n.children.map(block))
        case 'list': return h(n.ordered ? 'ol' : 'ul', { class: 'md-list' }, n.items.map((it) => h('li', it.children.map(block))))
        case 'codeblock': return h('pre', { class: 'md-pre' }, h('code', n.text))
        case 'blank': return h('div', { class: 'md-blank', 'aria-hidden': 'true' })
        default: return h('p', { class: 'md-line' }, inl(n.children))
      }
    }
    function inline(n, ctx) {
      switch (n.type) {
        case 'text': return n.value
        case 'strong': return h('strong', inl(n.children))
        case 'em': return h('em', inl(n.children))
        case 'underline': return h('u', inl(n.children))
        case 'strike': return h('s', inl(n.children))
        case 'spoiler': return h(Spoiler, null, () => inl(n.children))
        case 'code': return h('code', { class: 'md-code' }, n.text)
        case 'emoji': return ctx.emoji(n)
        case 'mention': return mention(n, ctx)
        case 'link': return anchor(ctx.link(n.href), inl(n.children))
        case 'url': return anchor(ctx.link(n.href), [n.href])
        default: return ''
      }
    }
    function anchor(r, children) {
      if (r.kind === 'route') return h(RouterLink, { to: r.to, class: 'md-link' }, () => children)
      if (r.kind === 'external') return h('a', { href: r.href, class: 'md-link md-ext', target: '_blank', rel: 'noopener noreferrer' }, children)
      return h('span', { class: 'md-unlinked' }, children)
    }
    function mention(n, ctx) {
      const { label, color } = ctx.mention(n)
      if (n.kind === 'channel') {
        const r = ctx.link(n.raw)
        if (r.kind === 'route') return h(RouterLink, { to: r.to, class: 'md-mention' }, () => label)
      }
      return h('span', { class: `md-mention md-mention-${n.kind}`, style: color ? { '--role': color } : undefined }, label)
    }
    return () => h('div', { class: 'md' }, props.nodes.map(block))
  },
})
```

- [ ] **Step 3: Image component (Review Focus #4).** Create
  `src/components/archive/ArchiveImage.vue`:

```vue
<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useArchive } from '../../stores/archive'

const props = defineProps({
  collectionKey: { type: String, required: true },
  file: { type: String, required: true },
  alt: { type: String, required: true },
  kind: { type: String, default: 'emoji' }, // 'emoji' | 'attachment'
})
const archive = useArchive()
const src = ref(null)
const failed = ref(false)
const el = ref(null)
let observer = null

async function load() {
  try {
    src.value = await archive.assetUrl(props.collectionKey, props.file)
  } catch {
    failed.value = true
  }
}
onMounted(() => {
  // Attachments can be tens of MB: only fetch + decrypt when near the viewport.
  if (props.kind === 'attachment' && 'IntersectionObserver' in window) {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer.disconnect()
        load()
      }
    }, { rootMargin: '600px' })
    observer.observe(el.value)
  } else load()
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <span ref="el" :class="['arch-img', `arch-img-${kind}`]">
    <img v-if="src" :src="src" :alt="alt" :title="kind === 'emoji' ? alt : undefined" />
    <span v-else-if="failed" class="arch-img-fallback">{{ alt }}</span>
    <span v-else class="arch-img-pending" aria-hidden="true" />
  </span>
</template>

<style scoped>
.arch-img-emoji img { height: 1.375em; width: auto; vertical-align: -0.3em; }
.arch-img-attachment { display: block; margin-top: 0.75rem; }
.arch-img-attachment img { max-width: 100%; max-height: 32rem; border: 1px solid var(--color-ash); border-radius: 3px; }
.arch-img-pending { display: inline-block; width: 1.2em; height: 1.2em; }
.arch-img-attachment .arch-img-pending { display: block; height: 8rem; background: rgba(89, 214, 108, 0.04); }
.arch-img-fallback { font-family: var(--font-mono); font-size: 0.8em; color: var(--color-smoke); }
</style>
```

- [ ] **Step 4: Thread component (Review Focus #2).** Create
  `src/components/archive/ArchiveThread.vue`:

```vue
<script setup>
import { computed, h, watch, nextTick, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useArchive } from '../../stores/archive'
import { parse } from '../../lib/archive/markdown'
import { classifyHref, emojiFile, attachmentFile, threadTags, mentionLabel } from '../../lib/archive/model'
import { takeAnchor } from '../../lib/archive/anchor'
import ArchiveMarkdown from './ArchiveMarkdown'
import ArchiveImage from './ArchiveImage.vue'

const props = defineProps({ collectionKey: String, threadId: String })
const archive = useArchive()
const route = useRoute()
const router = useRouter()

const col = computed(() => archive.archive.collections.get(props.collectionKey))
const entry = computed(() => col.value.threads.get(props.threadId))
const tags = computed(() => threadTags(col.value, entry.value.thread))
const messages = computed(() => entry.value.messages.map((m) => ({ m, ast: parse(m.content ?? '') })))

const ctx = computed(() => ({
  link: (href) => {
    const r = classifyHref(href, archive.archive)
    return r.kind === 'unaccounted' ? { kind: 'text' } : r
  },
  emoji: (n) => {
    const file = emojiFile(col.value, n.id, n.animated)
    return file ? h(ArchiveImage, { collectionKey: props.collectionKey, file, alt: `:${n.name}:` }) : `:${n.name}:`
  },
  mention: (n) => mentionLabel(col.value, archive.archive, n),
}))

function scrollToHash() {
  const id = route.hash.slice(1)
  if (id) nextTick(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }))
}
onMounted(() => {
  const stashed = takeAnchor()
  if (stashed && !route.hash) router.replace({ path: route.path, query: route.query, hash: stashed })
  else scrollToHash()
})
watch(() => [route.hash, props.threadId], scrollToHash)
</script>

<template>
  <article class="arch-thread">
    <header class="arch-head">
      <h1 class="arch-title">{{ entry.thread.name }}</h1>
      <ul v-if="tags.length" class="arch-tags">
        <li v-for="t in tags" :key="t.id" class="arch-tag">
          <ArchiveImage v-if="t.emoji_id && emojiFile(col, t.emoji_id, false)" :collection-key="collectionKey" :file="emojiFile(col, t.emoji_id, false)" alt="" />
          {{ t.name }}
        </li>
      </ul>
    </header>
    <section
      v-for="{ m, ast } in messages"
      :key="m.id"
      :id="m.id === threadId ? undefined : `m-${m.id}`"
      class="arch-msg"
    >
      <ArchiveMarkdown :nodes="ast" :ctx="ctx" />
      <template v-for="a in m.attachments ?? []" :key="a.id ?? a.url">
        <ArchiveImage
          v-if="attachmentFile(col, a.url)"
          :collection-key="collectionKey"
          :file="attachmentFile(col, a.url)"
          :alt="a.filename ?? 'attachment'"
          kind="attachment"
        />
      </template>
    </section>
  </article>
</template>

<style scoped>
.arch-thread { max-width: 52rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
.arch-title { font-family: var(--font-display); text-transform: uppercase; letter-spacing: 0.08em; font-size: 1.6rem; color: var(--color-bone); }
.arch-tags { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.6rem; list-style: none; padding: 0; }
.arch-tag { font-family: var(--font-mono); font-size: 0.72rem; color: var(--color-gold); border: 1px solid rgba(223, 184, 91, 0.35); border-radius: 2px; padding: 2px 6px; display: inline-flex; gap: 0.3rem; align-items: center; }
.arch-msg { padding: 1.1rem 0; border-top: 1px solid rgba(38, 55, 47, 0.5); scroll-margin-top: 5rem; }
.arch-msg:first-of-type { border-top: 0; }
:deep(.md-h1) { font-size: 1.5rem; } :deep(.md-h2) { font-size: 1.25rem; } :deep(.md-h3) { font-size: 1.05rem; }
:deep(.md-h) { font-family: var(--font-display); color: var(--color-bone); margin: 0.9rem 0 0.35rem; }
:deep(.md-line) { margin: 0.1rem 0; }
:deep(.md-blank) { height: 0.7rem; }
:deep(.md-sub) { font-size: 0.8rem; color: var(--color-smoke); margin: 0.15rem 0; }
:deep(.md-quote) { border-left: 3px solid var(--color-ash-2); padding-left: 0.8rem; margin: 0.35rem 0; }
:deep(.md-list) { padding-left: 1.3rem; margin: 0.2rem 0; }
:deep(.md-link) { color: var(--color-drake); text-decoration: underline; text-underline-offset: 2px; }
:deep(.md-code) { font-family: var(--font-mono); font-size: 0.85em; background: rgba(255, 255, 255, 0.06); padding: 0 0.25em; border-radius: 3px; }
:deep(.md-mention) { background: color-mix(in srgb, var(--role, #5865f2) 22%, transparent); color: var(--role, #c9cdfb); border-radius: 3px; padding: 0 0.2em; }
:deep(.md-spoiler) { background: #1e1f22; color: transparent; border-radius: 3px; cursor: pointer; }
:deep(.md-spoiler) * { visibility: hidden; }
:deep(.md-spoiler.is-shown) { background: rgba(255, 255, 255, 0.08); color: inherit; cursor: auto; }
:deep(.md-spoiler.is-shown) * { visibility: visible; }
</style>
```

- [ ] **Step 5: Gate (Review Focus #1, #3, #5).** Create
  `src/components/archive/ArchiveGate.vue`:

```vue
<script setup>
import { watch } from 'vue'
import { useAuth } from '../../stores/auth'
import { useArchive } from '../../stores/archive'
import { stashAnchor } from '../../lib/archive/anchor'

const auth = useAuth()
const archive = useArchive()

watch(() => auth.signedIn, (signedIn) => { if (!signedIn) archive.reset() })
watch(() => [auth.signedIn, archive.status], () => {
  if (auth.signedIn && archive.status === 'idle') archive.load(auth.token)
}, { immediate: true })

function signIn() {
  stashAnchor(window.location.hash)
  auth.signIn()
}
const reload = () => window.location.reload()
const COPY = {
  'signed-out': 'The Legion Archive is restricted to the XVIIIth Legion. Sign in with Discord to continue.',
  restricted: "Restricted to the XVIIIth Legion. Your Discord account doesn't currently hold the role.",
  unavailable: "The archive couldn't be reached. Try again in a moment.",
  outdated: 'This page is out of date. Reload to get the latest archive.',
  integrity: "The archive failed an integrity check and wasn't shown. Reload to try again.",
  unpublished: "The archive hasn't been published yet.",
}
</script>

<template>
  <div v-if="!auth.signedIn || archive.error === 'signed-out'" class="gate">
    <p>{{ COPY['signed-out'] }}</p>
    <button class="btn-ember gate-btn" type="button" @click="signIn">Sign in with Discord</button>
  </div>
  <div v-else-if="archive.status === 'ready'"><slot /></div>
  <div v-else-if="archive.status === 'error'" class="gate" role="alert">
    <p>{{ COPY[archive.error] }}</p>
    <button v-if="archive.error === 'unavailable'" class="btn-ember gate-btn" type="button" @click="archive.retry(auth.token)">Try again</button>
    <button v-else-if="archive.error === 'outdated' || archive.error === 'integrity'" class="btn-ember gate-btn" type="button" @click="reload">Reload</button>
  </div>
  <div v-else class="gate" aria-busy="true"><p>Unsealing the archive…</p></div>
</template>

<style scoped>
.gate { max-width: 34rem; margin: 5rem auto; padding: 0 1.25rem; text-align: center; color: var(--color-smoke); }
.gate-btn { margin-top: 1.2rem; padding: 0.7rem 1.3rem; border-radius: 2px; }
</style>
```

- [ ] **Step 6: View and routes.** Create `src/views/ArchiveView.vue`:

```vue
<script setup>
import { computed } from 'vue'
import { useArchive } from '../stores/archive'
import ArchiveGate from '../components/archive/ArchiveGate.vue'
import ArchiveThread from '../components/archive/ArchiveThread.vue'

const props = defineProps({ collectionKey: { type: String, required: true }, threadId: { type: String, default: null } })
const archive = useArchive()
const resolved = computed(() => {
  const col = archive.archive?.collections.get(props.collectionKey)
  if (!col) return null
  const id = props.threadId ?? col.tocThreadId
  return col.threads.has(id) ? id : null
})
</script>

<template>
  <ArchiveGate>
    <ArchiveThread v-if="resolved" :key="resolved" :collection-key="collectionKey" :thread-id="resolved" />
    <div v-else class="arch-missing">
      <p>That page isn't in the archive.</p>
      <RouterLink :to="`/${collectionKey}`" class="md-link">Back to the table of contents</RouterLink>
    </div>
  </ArchiveGate>
</template>

<style scoped>
.arch-missing { max-width: 34rem; margin: 5rem auto; text-align: center; color: var(--color-smoke); }
</style>
```

In `src/router.js`, insert these before the catch-all route:

```js
  ...[
    { key: 'accolades', title: 'Accolades' },
    { key: 'ranks', title: 'Ranks' },
  ].map(({ key, title }) => ({
    path: `/${key}/:threadId(\\d{17,20})?`,
    name: key,
    component: () => import('./views/ArchiveView.vue'),
    props: (r) => ({ collectionKey: key, threadId: r.params.threadId || null }),
    meta: { title },
  })),
```

Also change `scrollBehavior` to let archive threads own hash scrolling:

```js
  scrollBehavior(to, from) {
    if (to.hash && to.path === from.path) return false
    return { top: 0 }
  },
```

- [ ] **Step 7: Nav.** In `src/components/AppNav.vue`, add `computed` to
  the vue import and replace the `links` constant with:

```js
const baseLinks = [
  { to: '/', label: 'Home' },
  { to: '/planner', label: 'Perk Builder' },
  { to: '/armoury', label: 'Armoury' },
  { to: '/builds', label: 'Builds' },
  { to: '/companies', label: 'Companies' },
]
// A UX hint only — the real gate is the server's role check (see
// src/lib/archive/client.js). Non-members never see the entries.
const links = computed(() =>
  auth.member?.isMember
    ? [...baseLinks, { to: '/accolades', label: 'Accolades', section: true }, { to: '/ranks', label: 'Ranks', section: true }]
    : baseLinks,
)
```

In **both** `<RouterLink v-for="l in links" …>` loops (desktop `.nav-link`
and mobile `.nav-mobile-link`), replace `exact-active-class="is-active"`
with these two attributes. That way a thread sub-page such as
`/ranks/<id>` highlights its section, while `/` still only highlights on
the home page:

```vue
          :exact-active-class="l.section ? '' : 'is-active'"
          :active-class="l.section ? 'is-active' : ''"
```

- [ ] **Step 8: Component tests.** Create
  `src/components/archive/archive.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { h } from 'vue'
import ArchiveMarkdown from './ArchiveMarkdown'
import ArchiveView from '../../views/ArchiveView.vue'
import ArchiveImage from './ArchiveImage.vue'
import { parse } from '../../lib/archive/markdown'
import { useArchive } from '../../stores/archive'
import { useAuth } from '../../stores/auth'
import { makeIndex, IDS } from '../../lib/archive/testIndex'
import { stashAnchor } from '../../lib/archive/anchor'

function router() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/:c(accolades|ranks)/:threadId(\\d{17,20})?', component: ArchiveView, props: (r) => ({ collectionKey: r.params.c, threadId: r.params.threadId || null }) },
      { path: '/', component: { render: () => null } },
    ],
  })
}
const textCtx = { link: () => ({ kind: 'text' }), emoji: (n) => `:${n.name}:`, mention: () => ({ label: '@x', color: null }) }

beforeEach(() => {
  setActivePinia(createPinia())
  sessionStorage.clear()
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
})

describe('ArchiveMarkdown hostile input', () => {
  const hostile = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '[x](javascript:alert(1))', '<javascript:alert(1)>',
    '[x](https://ok.io" onmouseover="alert(1))', '**<b>bold</b>**', '||<svg onload=alert(1)>||', '`<script>`',
  ]
  it.each(hostile)('%s renders as inert text', async (src) => {
    const r = router()
    const w = mount(ArchiveMarkdown, { props: { nodes: parse(src), ctx: textCtx }, global: { plugins: [r] } })
    expect(w.findAll('script, img, svg, [onerror], [onload], [onmouseover]').length).toBe(0)
    for (const a of w.findAll('a')) expect(a.attributes('href')).not.toMatch(/^javascript:/i)
  })
})

async function mountView(path, { status = 'ready', signedIn = true, index = makeIndex() } = {}) {
  const r = router()
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuth()
  auth.member = signedIn ? { id: '1', username: 'u', isMember: true } : null
  const archive = useArchive()
  if (status === 'ready') await archive.load('t', { loadArchive: async () => ({ keys: {}, index }) })
  await r.push(path)
  await r.isReady()
  const w = mount(ArchiveView, { props: { collectionKey: path.split('/')[1], threadId: path.split('/')[2]?.split('#')[0] ?? null }, global: { plugins: [r, pinia], stubs: { ArchiveImage: true } } })
  await flushPromises()
  return { w, r, archive }
}

describe('ArchiveView', () => {
  it('landing renders the ToC; no rendered href points at Discord', async () => {
    const { w } = await mountView('/accolades')
    expect(w.text()).toContain('Fixture ToC')
    for (const a of w.findAll('a')) expect(a.attributes('href')).not.toMatch(/discord(app)?\.com|discord\.gg/i)
    expect(w.find('a[href="/ranks/200000000000000001#m-200000000000000011"]').exists()).toBe(true)
  })
  it('fixed external channel mention renders as text, not a link', async () => {
    const { w } = await mountView('/accolades')
    expect(w.find('.md-mention-channel').text()).toBe('#fixture-reports')
  })
  it('dead link follows its fix to the replacement message', async () => {
    const { w } = await mountView(`/accolades/${IDS.A_T2}`)
    expect(w.find(`a[href="/accolades/${IDS.A_T2}#m-${IDS.A_T2_M}"]`).exists()).toBe(true)
  })
  it('non-Discord link is external with noopener', async () => {
    const { w } = await mountView(`/accolades/${IDS.A_T2}`)
    const a = w.find('a.md-ext')
    expect(a.attributes()).toMatchObject({ href: 'https://example.com/wiki', target: '_blank', rel: 'noopener noreferrer' })
  })
  it('system messages (type 4) are not rendered', async () => {
    const { w } = await mountView('/accolades')
    expect(w.text()).not.toContain('renamed')
  })
  it('messages get m-<id> anchors except the thread starter', async () => {
    const { w } = await mountView('/accolades')
    expect(w.find(`#m-${IDS.A_TOC_M2}`).exists()).toBe(true)
    expect(w.find(`#m-${IDS.A_TOC}`).exists()).toBe(false)
  })
  it('unknown thread id → archive not-found, not a crash', async () => {
    const { w } = await mountView('/ranks/999999999999999999')
    expect(w.text()).toContain("isn't in the archive")
  })
  it('a thread from the other collection is not served under this prefix', async () => {
    const { w } = await mountView(`/ranks/${IDS.A_T2}`)
    expect(w.text()).toContain("isn't in the archive")
  })
  it('spoilers start hidden and reveal on click and on keyboard', async () => {
    const { w } = await mountView(`/accolades/${IDS.A_T2}`)
    const s = w.find('.md-spoiler')
    expect(s.attributes('aria-expanded')).toBe('false')
    await s.trigger('keydown', { key: 'Enter' })
    expect(s.attributes('aria-expanded')).toBe('true')
  })
  it('signed out → sign-in prompt, no content, and a message anchor is stashed on sign-in', async () => {
    const { w } = await mountView('/accolades', { status: 'idle', signedIn: false })
    expect(w.text()).toContain('Sign in with Discord')
    expect(w.text()).not.toContain('Fixture')
    const auth = useAuth()
    auth.signIn = vi.fn()
    window.location.hash = `#m-${IDS.A_TOC_M2}`
    await w.find('button').trigger('click')
    expect(sessionStorage.getItem('salamanders-archive-anchor')).toBe(`#m-${IDS.A_TOC_M2}`)
  })
  it('a stashed anchor is restored after sign-in once content is ready (cold deep link)', async () => {
    stashAnchor(`#m-${IDS.A_TOC_M2}`)
    const { r } = await mountView('/accolades')
    await flushPromises()
    expect(r.currentRoute.value.hash).toBe(`#m-${IDS.A_TOC_M2}`)
  })
  it('a junk stashed anchor is ignored', () => {
    stashAnchor('#<img onerror=1>')
    expect(sessionStorage.getItem('salamanders-archive-anchor')).toBeNull()
  })
  it.each([
    ['restricted', /doesn't currently hold the role/, null],
    ['unavailable', /couldn't be reached/, 'Try again'],
    ['outdated', /out of date/, 'Reload'],
    ['integrity', /integrity check/, 'Reload'],
    ['unpublished', /hasn't been published/, null],
  ])('error %s shows its message', async (st, re, button) => {
    const r = router()
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuth().member = { id: '1', username: 'u', isMember: true }
    const archive = useArchive()
    await archive.load('t', { loadArchive: async () => { const { ArchiveAccessError } = await import('../../lib/archive/client'); throw new ArchiveAccessError(st) } })
    await r.push('/accolades')
    const w = mount(ArchiveView, { props: { collectionKey: 'accolades' }, global: { plugins: [r, pinia] } })
    expect(w.text()).toMatch(re)
    expect(w.text()).not.toContain('Fixture')
    if (button) expect(w.find('button').text()).toBe(button)
  })
  it('signing out while viewing clears content immediately', async () => {
    const { w, archive } = await mountView('/accolades')
    useAuth().member = null
    await flushPromises()
    expect(archive.status).toBe('idle')
    expect(w.text()).not.toContain('Fixture')
  })
})

describe('ArchiveImage', () => {
  it('a failing asset shows its alt text instead of breaking the page', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const archive = useArchive()
    archive.assetUrl = () => Promise.reject(new Error('404'))
    const w = mount(ArchiveImage, { props: { collectionKey: 'accolades', file: 'x.png', alt: ':fx:' }, global: { plugins: [pinia] } })
    await flushPromises()
    expect(w.find('.arch-img-fallback').text()).toBe(':fx:')
  })
  it('attachments wait for the viewport before loading', async () => {
    const observed = []
    window.IntersectionObserver = class { constructor(cb) { this.cb = cb } observe(el) { observed.push(this) } disconnect() {} }
    const pinia = createPinia()
    setActivePinia(pinia)
    const archive = useArchive()
    let asked = 0
    archive.assetUrl = async () => (asked++, 'blob:x')
    mount(ArchiveImage, { props: { collectionKey: 'accolades', file: 'big.png', alt: 'a', kind: 'attachment' }, global: { plugins: [pinia] } })
    await flushPromises()
    expect(asked).toBe(0)
    observed[0].cb([{ isIntersecting: true }])
    await flushPromises()
    expect(asked).toBe(1)
    delete window.IntersectionObserver
  })
})
```

- [ ] **Step 9: Run the tests and iterate to PASS.** Run
  `bun run test src/components/archive/archive.test.js`, then the whole
  suite.

- [ ] **Step 10: Real-content visual check (local only).**

```bash
bun run archive seal     # writes public/archive/ + archive.lock.json locally (not published)
bun run dev
```

In a browser, sign in as a role-holder. The builds API must be running
locally with `ARCHIVE_KEY` from `archive-export/.env` and a real bot
token. Walk the Accolades and Ranks ToCs, click at least one link of each
kind (thread, message anchor, cross-collection, fixed-dead, text, the
wiki link), and confirm spoilers and emojis render. Screenshot problems
to the user privately; never commit them. Then run `git status` and
confirm `archive.lock.json` is the only new tracked-candidate file. **Do
not commit it in this task.** The lock is committed only by the publish
task, once the release exists.

- [ ] **Step 11: Commit.**

```bash
git add src/components/archive src/views/ArchiveView.vue src/lib/archive/anchor.js src/router.js src/components/AppNav.vue
git commit -m "archive: gated Accolades/Ranks pages with safe Discord-markdown rendering"
```

---

### Task 11: Deploy wiring, dist scan, e2e, and the pre-push gate

**Files:**
- Create: `scripts/scan-dist.mjs`, `scripts/scan-dist.test.mjs`, `e2e/tests/archive.spec.js`, `.husky/pre-push`
- Modify: `.github/workflows/deploy.yml`, `e2e/docker-compose.yml`, `e2e/discord-mock/server.js`

**Interfaces:**
- Produces: `scanDir(dir, {sentinels?: string[]}) → string[]` (findings), CLI
  `node scripts/scan-dist.mjs <dir> [--sentinels-from archive-export]`.

- [ ] **Step 1: Failing scan tests.** Create `scripts/scan-dist.test.mjs`:

```js
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanDir, sentinelsFrom } from './scan-dist.mjs'
import { writeFixture, SENTINEL } from './archive-fixture.mjs'

const K = (n) => '"' + n + '":'
let d
beforeEach(async () => {
  d = await mkdtemp(join(tmpdir(), 'dist-'))
  await mkdir(join(d, 'archive'), { recursive: true })
  await mkdir(join(d, 'assets'), { recursive: true })
})

describe('scanDir', () => {
  it('a clean build (ciphertext + normal assets) passes', async () => {
    await writeFile(join(d, 'archive', 'a'.repeat(32) + '.bin'), 'LAR\u0001xxxx')
    await writeFile(join(d, 'assets', 'hero-abc.png'), '\u0089PNG....')
    await writeFile(join(d, 'assets', 'index.js'), 'forum.available_tags.map(t=>t)')
    expect(await scanDir(d)).toEqual([])
  })
  it.each([
    ['plaintext PNG under archive/', 'archive/x.png', '\u0089PNG\r\n'],
    ['plaintext GIF under archive/', 'archive/x.gif', 'GIF89a'],
    ['plaintext JSON under archive/', 'archive/x.bin', '{"a":1}'],
    ['a non-opaque name under archive/', 'archive/emoji-1.bin', 'LAR\u0001'],
    ['export JSON anywhere', 'assets/data.json', `{${K('guild' + '_id')}"1",${K('mention' + '_roles')}[]}`],
    ['export JSON inlined in a bundle', 'assets/index.js', `x=${JSON.stringify(`${K('available' + '_tags')}[],${K('applied' + '_tags')}[]`)}`],
    ['legacy plaintext dirs copied from public/', 'accolades/emoji-1.png', 'x'],
  ])('flags %s', async (_, rel, body) => {
    await mkdir(join(d, rel, '..'), { recursive: true })
    await writeFile(join(d, rel), body, 'latin1')
    expect((await scanDir(d)).length).toBeGreaterThan(0)
  })
  it('flags local sentinels (content strings from the real export)', async () => {
    await writeFile(join(d, 'assets', 'index.js'), `x="${SENTINEL}-accolades"`)
    expect(await scanDir(d, { sentinels: [`${SENTINEL}-accolades`] })).toHaveLength(1)
  })
  it('sentinelsFrom samples thread names, message ids, and asset file names from an export', async () => {
    const exp = await mkdtemp(join(tmpdir(), 'exp-'))
    await writeFixture(exp)
    const s = await sentinelsFrom(exp)
    expect(s).toEqual(expect.arrayContaining(['Fixture ToC', '100000000000000011', 'emoji-fixture.png']))
    expect(s).not.toContain('1322056087792521269') // guild id is public
  })
})
```

- [ ] **Step 2: Implement `scripts/scan-dist.mjs`.**

```js
/** Post-build plaintext scan. CI runs signatures only; locally, --sentinels-from adds real-content strings. */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COLLECTIONS, GUILD_ID } from '../src/lib/archive/registry.js'

const SIGS = ['guild' + '_id', 'mention' + '_roles', 'available' + '_tags', 'applied' + '_tags', 'permission' + '_overwrites']
  .flatMap((k) => ['"' + k + '":', '\\"' + k + '\\":'])
const MAGIC = [['\u0089PNG', 'PNG'], ['GIF8', 'GIF'], ['\u00ff\u00d8\u00ff', 'JPEG'], ['RIFF', 'WEBP'], ['{', 'JSON'], ['[', 'JSON']]

async function* files(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* files(p)
    else yield p
  }
}

export async function scanDir(dir, { sentinels = [] } = {}) {
  const findings = []
  for await (const p of files(dir)) {
    const rel = relative(dir, p).replace(/\\/g, '/')
    const text = (await readFile(p)).toString('latin1')
    if (/^(accolades|rank-requirements)\//.test(rel)) findings.push(`${rel}: plaintext export directory in build`)
    if (rel.startsWith('archive')) {
      if (!/^archive(-e2e)?\/[0-9a-f]{32}\.bin$/.test(rel)) findings.push(`${rel}: non-opaque file under archive/`)
      for (const [m, kind] of MAGIC) if (text.startsWith(m)) findings.push(`${rel}: plaintext ${kind} under archive/`)
    }
    const hits = SIGS.filter((s) => text.includes(s)).length
    if (hits >= 2) findings.push(`${rel}: Discord export JSON signatures (${hits})`)
    for (const s of sentinels) if (text.includes(s)) findings.push(`${rel}: contains archive content sentinel`)
  }
  return findings
}

export async function sentinelsFrom(exportDir) {
  const out = new Set()
  for (const c of COLLECTIONS) {
    const base = join(exportDir, c.exportDir, 'data')
    for (const t of JSON.parse(await readFile(join(base, 'index.json'), 'utf8'))) if (t.name?.length >= 6) out.add(t.name)
    for (const f of await readdir(join(base, 'threads'))) {
      for (const m of JSON.parse(await readFile(join(base, 'threads', f), 'utf8')).messages) out.add(m.id)
    }
    for (const a of Object.values(JSON.parse(await readFile(join(base, 'assets.json'), 'utf8')))) out.add(a.file)
  }
  out.delete(GUILD_ID)
  return [...out]
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, flag, src] = process.argv.slice(2)
  const sentinels = flag === '--sentinels-from' ? await sentinelsFrom(src) : []
  const findings = await scanDir(dir, { sentinels })
  if (findings.length) {
    // Never print sentinel values themselves — only where they were found.
    console.log(findings.join('\n'))
    process.exit(1)
  }
  console.log(`scan clean: ${dir}${sentinels.length ? ` (+${sentinels.length} local sentinels)` : ''}`)
}
```

- [ ] **Step 3: Run the tests; expect PASS.** Also run
  `bun run build && node scripts/scan-dist.mjs dist --sentinels-from archive-export`.
  Expected: `scan clean`. (After Task 1 moved the exports out of
  `public/`, a local build no longer copies plaintext.)

- [ ] **Step 4: Deploy workflow.** In `.github/workflows/deploy.yml`,
  replace the build job's steps with:

```yaml
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - name: Guard — no plaintext archive tracked
        run: node scripts/archive-leak-guard.mjs --tracked
      - name: Fetch and verify the sealed Legion Archive
        run: bun scripts/seal-archive.mjs fetch
        env:
          GH_TOKEN: ${{ github.token }}
      - run: bun run build
        env:
          # (existing VITE_BUILDS_API_URL comment kept verbatim)
          VITE_BUILDS_API_URL: ${{ vars.VITE_BUILDS_API_URL }}
      - name: Scan build output for plaintext
        run: node scripts/scan-dist.mjs dist
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ./dist
```

Keep the existing multi-line comment above `VITE_BUILDS_API_URL` exactly
as it is. Add `contents: read` if it's missing (it's already there).
`gh release download` on a public repo works with the default token.

- [ ] **Step 5: e2e Discord mock.** In `e2e/discord-mock/server.js`, add a
  token and a role table, and replace the member-lookup branch:

```js
const USERS = {
  // Real id from src/data/discord-members.json's memberIds.
  'test-member-token': { id: '75633559351595008', username: 'member-tester' },
  // Well-formed but deliberately absent from that list.
  'test-nonmember-token': { id: '999999999999999999', username: 'nonmember-tester' },
  // In the guild (and the member bake) but without the Legion role.
  'test-norole-token': { id: '87082170719408128', username: 'norole-tester' },
}
const LEGION_ROLE = '1377787723976409211'
// Guild membership as Discord's bot endpoint would report it.
const MEMBERS = {
  '75633559351595008': { roles: [LEGION_ROLE] },
  '87082170719408128': { roles: [] },
}
```

```js
    const memberMatch = url.pathname.match(/^\/v10\/guilds\/[^/]+\/members\/([^/]+)$/)
    if (memberMatch) {
      const member = MEMBERS[memberMatch[1]]
      return withCors(member ? Response.json(member) : Response.json({ message: 'Unknown Member' }, { status: 404 }))
    }
```

Check that `87082170719408128` is in `src/data/discord-members.json`'s
`memberIds` (it is: the second entry), so the nav shows the archive links
for this user and the *server* is what refuses them.

- [ ] **Step 6: e2e compose.** In `e2e/docker-compose.yml`:
  - Add these to `api.environment`:

```yaml
      ARCHIVE_ROLE_ID: '1377787723976409211'
      # Throwaway key for the synthetic fixture only. Must match the web
      # service's E2E_ARCHIVE_KEY below.
      ARCHIVE_KEY: 'ZTJlLXRocm93YXdheS1rZXktMzItYnl0ZXMtbG9uZyE='
```

  - Create `scripts/e2e-archive.mjs`, which builds and seals the synthetic
    fixture with the compose file's throwaway key:

```js
/** e2e only: synthetic fixture → sealed into public/archive-e2e/ with E2E_ARCHIVE_KEY. */
import { rm, writeFile } from 'node:fs/promises'
import { writeFixture } from './archive-fixture.mjs'
import { sealExport, readEnvKey } from './lib/archive-seal.mjs'

const rawKey = readEnvKey(`ARCHIVE_KEY=${process.env.E2E_ARCHIVE_KEY}`)
await rm('e2e/.archive', { recursive: true, force: true })
await writeFixture('e2e/.archive/export')
const lock = await sealExport({ exportDir: 'e2e/.archive/export', rawKey, outDir: 'public/archive-e2e' })
await writeFile('e2e/.archive/lock.json', JSON.stringify(lock, null, 2))
console.log(`e2e archive sealed: ${Object.keys(lock.files).length} files, kid ${lock.kid}`)
```

  - Change the `web` command and environment:

```yaml
    command: sh -c "bun install --frozen-lockfile && bun scripts/e2e-archive.mjs && bun run dev -- --host 0.0.0.0 --port 5173"
    environment:
      VITE_BUILDS_API_URL: http://api:8787
      VITE_DISCORD_API_BASE: http://discord-mock:4400
      VITE_ALLOWED_HOSTS: web
      E2E_ARCHIVE_KEY: 'ZTJlLXRocm93YXdheS1rZXktMzItYnl0ZXMtbG9uZyE='
      ARCHIVE_LOCK: e2e/.archive/lock.json
      VITE_ARCHIVE_BASE: /archive-e2e/
```

  Verify the key literal decodes to exactly 32 bytes:
  `node -e 'console.log(Buffer.from("ZTJlLXRocm93YXdheS1rZXktMzItYnl0ZXMtbG9uZyE=","base64").length)'`.
  Expected: `32`. If not, generate one with
  `node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'`
  and use it in both places.

- [ ] **Step 7: e2e spec.** Create `e2e/tests/archive.spec.js`:

```js
import { test, expect } from '@playwright/test'

const SENTINEL = 'FIXTURE-PLAINTEXT-SENTINEL'
const A_TOC = '100000000000000001'
const R_TOC = '200000000000000001'
const R_MSG = '200000000000000011'

async function signIn(page, token) {
  await page.goto(`/#access_token=${token}&expires_in=3600`)
  await expect(page.locator('.auth-name')).toBeVisible()
}

// Every response body in the flow must be free of fixture plaintext:
// decrypted content may only exist in the DOM.
function watchResponses(page) {
  const leaks = []
  page.on('response', async (res) => {
    try {
      const body = await res.body()
      if (body.toString('latin1').includes(SENTINEL)) leaks.push(res.url())
    } catch {}
  })
  return leaks
}

test('role holder reads both collections and follows links between them', async ({ page }) => {
  const leaks = watchResponses(page)
  await signIn(page, 'test-member-token')
  await page.locator('.nav-links').getByRole('link', { name: 'Accolades' }).click()
  await expect(page).toHaveURL(/\/accolades$/)
  await expect(page.locator('.arch-thread')).toContainText(`${SENTINEL}-accolades`)
  // Scoped to the content: the nav bar also has a "Ranks" link.
  await page.locator('.arch-thread').getByRole('link', { name: 'Ranks', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/ranks/${R_TOC}#m-${R_MSG}$`))
  await expect(page.locator(`#m-${R_MSG}`)).toBeInViewport()
  await page.locator('.arch-thread').getByRole('link', { name: 'Back' }).click()
  await expect(page).toHaveURL(new RegExp(`/accolades/${A_TOC}#m-`))
  const hrefs = await page.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href') || ''))
  expect(hrefs.filter((h) => /discord(app)?\.com|discord\.gg/.test(h) && !h.startsWith('https://discord.gg/salamanders'))).toEqual([])
  expect(leaks).toEqual([])
})

test('signed-in member without the role is refused and never receives the key', async ({ page }) => {
  const leaks = watchResponses(page)
  const keyResponses = []
  page.on('response', (r) => r.url().endsWith('/archive/key') && keyResponses.push(r.status()))
  await signIn(page, 'test-norole-token')
  await page.goto('/accolades')
  await expect(page.getByRole('alert')).toContainText("doesn't currently hold the role")
  await expect(page.locator('.arch-thread')).toHaveCount(0)
  expect(keyResponses).toEqual([403])
  expect(leaks).toEqual([])
})

test('signed out: prompt, no content; deep-link anchor survives sign-in', async ({ page }) => {
  const leaks = watchResponses(page)
  await page.goto(`/ranks/${R_TOC}#m-${R_MSG}`)
  const gateButton = page.locator('.gate').getByRole('button', { name: 'Sign in with Discord' })
  await expect(gateButton).toBeVisible()
  await expect(page.locator('.arch-thread')).toHaveCount(0)
  // Simulate the Discord round-trip. Aborting the navigation to Discord keeps
  // us on the page after the click has stashed the return path and anchor;
  // Discord would then send the browser to the site root with a token.
  await page.route('https://discord.com/**', (r) => r.abort())
  await gateButton.click()
  await page.goto('/#access_token=test-member-token&expires_in=3600')
  await expect(page).toHaveURL(new RegExp(`/ranks/${R_TOC}#m-${R_MSG}$`))
  await expect(page.locator(`#m-${R_MSG}`)).toBeInViewport()
  expect(leaks).toEqual([])
})

test('signing out while reading removes the content immediately', async ({ page }) => {
  await signIn(page, 'test-member-token')
  await page.goto('/accolades')
  await expect(page.locator('.arch-thread')).toBeVisible()
  await page.locator('.nav-bar').getByRole('button', { name: 'Sign out' }).click()
  await expect(page.locator('.arch-thread')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign in with Discord' })).toBeVisible()
})
```

- [ ] **Step 8: Run e2e.** Run `bun run test:e2e`. Expected: every
  existing `builds.spec.js` test still passes, plus 4 archive tests. Clean
  up with `rm -rf e2e/.archive public/archive-e2e`.

- [ ] **Step 9: Pre-push gate.** Create `.husky/pre-push`:

```sh
# Legion Archive merge gate: whole suite, then 100% coverage + mutation on
# the gated units, then (locally, where the plaintext exists) a build scan
# against real-content sentinels.
export PATH="$PWD/node_modules/.bin:$PATH"
bun run test || exit 1
bun run test:coverage || exit 1
bun run test:mutation || exit 1
if [ -d archive-export ]; then
  bun run build >/dev/null && node scripts/scan-dist.mjs dist --sentinels-from archive-export || exit 1
fi
```

Make it executable with `chmod +x .husky/pre-push`.

- [ ] **Step 10: Commit.**

```bash
git add scripts/scan-dist.mjs scripts/scan-dist.test.mjs scripts/e2e-archive.mjs .github/workflows/deploy.yml e2e/docker-compose.yml e2e/discord-mock/server.js e2e/tests/archive.spec.js .husky/pre-push
git commit -m "archive: deploy fetch/verify/scan, e2e coverage of the gate, pre-push merge gate"
```

---

### Task 12: Publish (operator steps — confirm each outward-facing action with the user first)

These steps publish or configure real infrastructure. **Get the user's
explicit go-ahead for Steps 2, 3, and 5.**

- [ ] **Step 1: Final local gate.** Run `git push --dry-run` so the
  pre-push hook runs the full gate. Expected: all green, `scan clean`.

- [ ] **Step 2: Publish the sealed release.** *(Confirm with the user
  first.)* Run `bun run archive seal --publish`. Expected:
  `published archive-v1`, and `archive.lock.json` updated with
  `release: "archive-v1"`. Verify it publicly: download the asset and
  confirm it's ciphertext:
  `gh release download archive-v1 -D /tmp/rel && tar -tf /tmp/rel/*.tar | head -3`
  (opaque `.bin` names only).

- [ ] **Step 3: Configure the server.** *(Confirm with the user first.)*
  On the host running `server/`, add `ARCHIVE_KEY` (the value from
  `archive-export/.env`) and confirm `DISCORD_BOT_TOKEN` and
  `DISCORD_GUILD_ID` in `server/.env`, then `docker compose up -d --build`.
  Check it: `curl -s -o /dev/null -w '%{http_code}' <api>/archive/key`.
  Expected: `401` (configured and waiting for a token). A `503` means
  config is missing.

- [ ] **Step 4: Commit the lock.**

```bash
git add archive.lock.json
git commit -m "archive: publish sealed release archive-v1"
```

- [ ] **Step 5: Push and deploy.** *(Confirm with the user first.)* Push
  the branch, open a PR, and merge per the user's preference. Watch the
  deploy run: the "Fetch and verify" step should print
  `verified N sealed files`, and "Scan build output" should print
  `scan clean`.

- [ ] **Step 6: Production smoke test with the user.** They sign in as a
  role-holder and see content, and an account without the role sees
  "Restricted". **Note:** production needs `VITE_BUILDS_API_URL` set to
  the builds API's public address (still unset as of the spec date). Until
  it's set, the archive pages correctly show "couldn't be reached" (fail
  closed).

- [ ] **Step 7: Clean up the plaintext copies.** Ask the user whether to
  delete the old plaintext copy on any other machine (e.g. the Windows
  clone from 2026-09-24) now that the release plus the key is the backup.
```
