# Legacy Accolades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One sealed, Legion-only page, `/accolades/legacy`, listing every retired Discord accolade role with a hand-written blurb and the members who held it, frozen from a one-time Discord snapshot.

**Architecture:** The data rides inside the existing sealed Legion Archive bundle as `index.legacy` (additive; format stays 1). A pure module `src/lib/archive/legacy.js` audits it at seal time and builds the page's view model. A snapshot script pulls roles and holders from Discord into a gitignored `archive-export/legacy-accolades.json` with merge-never-replace semantics. The page reuses `ArchiveGate`, `ArchivePlaque` and `RosterMember` chips; the lock records `legacy: true` so a later re-seal cannot silently drop it.

**Tech Stack:** Vue 3 + Pinia + vue-router, Vitest (+ fast-check, @vue/test-utils), Stryker mutation gate, Playwright e2e in docker, Node/bun scripts.

**Spec:** `docs/superpowers/specs/2026-10-16-legacy-accolades-design.md`

## Global Constraints

- **Names never reach git or the public build in plaintext.** Ciphertext in the release, lock in git; plaintext only in `archive-export/` (gitignored) and in an authorized browser session.
- **The etch cannot be wiped by accident:** the lock gains `legacy: true` once a bundle containing it is published; `seal` then refuses to run without the file unless `--drop-legacy` is passed. The snapshot script merges, never replaces: holders are only dropped with `--prune`.
- **Reuse the archive:** same gate, key endpoint, lock, release flow, deploy and leak scans. No second key, bundle or auth path.
- Names, blurbs and role names render as plain text; no markdown, HTML or links come from the data. No rendered link may point at Discord.
- Unknown fields anywhere in the legacy payload are rejected; a role with no holders is valid and says "No holders on record".
- Terminal output of the snapshot script lists ids and counts only, never names.
- **No real member names, role names, blurbs or Discord ids in any committed file** (public repo). Every fixture identifier here is invented: roles `81000000000000000N`, users `82000000000000000N`.
- Test behaviour only (return values, DOM text, written files, thrown errors); never logs or mock calls. Raise/validate at the boundary.
- Run tools from the repo-local binaries: `node_modules/.bin/vitest`, `node_modules/.bin/stryker`; `node_modules/.bin/bun` is 1.4.2 (bun is not on PATH). Plain `node` cannot run scripts that import `src/lib/archive/model.js` (extensionless imports); use bun for the seal CLI.
- Do **not** push, and do **not** run `seal --publish` (creates a GitHub release) without the owner's explicit go-ahead (Task 10). The pre-commit hook runs the leak guard and the whole vitest suite (~30 s).
- Commit trailer on every commit: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Branch: `feat/legacy-accolades` (created in Task 1; the spec and this plan are committed on it first).
- Mutation bar: `legacy.js` and `legacy-snapshot.mjs` at 100% coverage and 100% mutation. If a mutant survives, add the test that kills it; if it is truly equivalent, rewrite the code so the mutant disappears. Never add `// Stryker disable`.

## Review Focus

Failure modes the spec implies that no single task's headline test covers; each has a pinning test in the task named.

1. Numeric or array ids that coerce to a valid-looking string (`810000000000000001`, `['810…']`) must not pass the audit → Task 1.
2. Deleting the roles and re-running the snapshot must not empty or re-date the data → Task 5.
3. A re-seal on a machine without the file must not silently drop the page; a file that is `null` or unreadable must not be treated as "absent" → Task 3.
4. A bundle sealed before this feature still loads; Accolades and Ranks are unaffected; the page shows a "not sealed yet" plaque → Tasks 2 and 7.
5. A short holder name ("Ed") must not become a build-scan sentinel (it would match minified code) while its id still does → Task 6.
6. Markup or bidi characters in names and blurbs render as inert text; one member under several accolades, and a role with zero holders, render correctly → Tasks 1 and 7.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/lib/archive/legacy.js` | create | `auditLegacy`, `legacyView`, `readableColor`, `canonicalLegacy`, `LEGACY_FILE`. Pure; gated at 100% coverage + mutation. |
| `src/lib/archive/legacy.test.js` | create | Hostile battery, boundaries, properties. |
| `vitest.config.js`, `stryker.config.mjs` | modify | Add the two gated units. |
| `src/lib/archive/testIndex.js` | modify | `makeLegacy()` synthetic payload; `makeIndex()` carries it. |
| `src/lib/archive/model.js` | modify | `createArchive` exposes `archive.legacy` (`null` when absent). |
| `src/lib/archive/audit.js` | modify | `auditArchive` reports `bad-legacy` problems. |
| `scripts/lib/archive-seal.mjs` | modify | Read/seal/unseal the file; lock flag; permanence guard. |
| `scripts/seal-archive.mjs` | modify | Pass the previous lock and `--drop-legacy` into `sealExport`. |
| `scripts/archive-fixture.mjs` | modify | Fixture writes a synthetic legacy file with a sentinel in a blurb. |
| `scripts/lib/discord.mjs` | create | `createDiscord`: rate-limit-aware fetch, member pagination, roles. Lifted from `fetch-discord-members.mjs`. Behaviour-tested but not mutation-gated (I/O and timing glue, moved verbatim). |
| `scripts/fetch-discord-members.mjs` | modify | Uses the shared lib. |
| `scripts/lib/legacy-snapshot.mjs` | create | `buildSnapshot`, `colorHex`. Pure; gated. |
| `scripts/snapshot-legacy-accolades.mjs` | create | CLI glue around the two libs above. |
| `scripts/scan-dist.mjs` | modify | Legacy sentinels for the pre-push build scan. |
| `src/views/LegacyAccolades.vue` | create | The page. |
| `src/router.js`, `src/lib/useNavLinks.js` | modify | Route and members-only nav entry. |
| `e2e/tests/archive.spec.js` | modify | Member sees the page; non-member and signed-out do not; no response leaks. |
| `package.json` | modify | `legacy:snapshot` script. |

---

### Task 1: The pure legacy module

**Files:**
- Create: `src/lib/archive/legacy.js`, `src/lib/archive/legacy.test.js`
- Modify: `vitest.config.js`, `stryker.config.mjs`, commit the spec and this plan

**Interfaces:**
- Produces (all from `src/lib/archive/legacy.js`):
  - `LEGACY_FILE: 'legacy-accolades.json'`, `NAME_MAX = 32`, `ROLE_NAME_MAX = 100`, `BLURB_MAX = 600`
  - `auditLegacy(legacy: unknown): string[]` — problem descriptions (positions only, never data); `[]` means valid
  - `legacyView(legacy): { snapshotDate: string, accolades: [{ roleId, name, color: string|null, paragraphs: string[], countLabel: string, holders: [{ id, name }] }] }`
  - `luminance(hex: string): number`, `readableColor(color: string|null, min?: number): string|null`
  - `canonicalLegacy(legacy): string` — `JSON.stringify(legacy, null, 2) + '\n'`

- [ ] **Step 1: Branch and commit the spec and plan**

```bash
git switch -c feat/legacy-accolades
git add docs/superpowers/specs/2026-10-16-legacy-accolades-design.md docs/superpowers/plans/2026-10-16-legacy-accolades.md
git commit -m "docs: legacy accolades spec and plan" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Write the failing tests**

Create `src/lib/archive/legacy.test.js`:

```js
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  LEGACY_FILE, NAME_MAX, ROLE_NAME_MAX, BLURB_MAX,
  auditLegacy, legacyView, luminance, readableColor, canonicalLegacy,
} from './legacy'

const ROLE_A = '810000000000000001'
const ROLE_B = '810000000000000002'
const USER_A = '820000000000000001'
const USER_B = '820000000000000002'

const valid = () => ({
  snapshot: '2026-10-16T12:00:00.000Z',
  accolades: [
    { roleId: ROLE_A, name: 'Fixture Laurel', color: '#d4a017', blurb: 'One.\n\nTwo.', holders: [{ id: USER_A, name: 'Alpha Holder' }, { id: USER_B, name: 'beta holder' }] },
    { roleId: ROLE_B, name: 'Fixture Ember', color: null, blurb: 'Three.', holders: [] },
  ],
})
const edit = (fn) => {
  const l = valid()
  fn(l)
  return l
}
const deepFreeze = (o) => {
  Object.values(o).forEach((v) => typeof v === 'object' && v !== null && deepFreeze(v))
  return Object.freeze(o)
}

// Values that look like a snowflake only after coercion, or are nearly one.
const BAD_IDS = [
  undefined, null, 810000000000000001, ['810000000000000001'], {}, '', '8100000000000000', '8'.repeat(16), '8'.repeat(21),
  'x810000000000000001', '810000000000000001x', '810000000000000001\n', ' 810000000000000001', '81000000000000000a1',
]
const BAD_TEXT = [undefined, null, 5, ['x'], {}, '', ' x', 'x ', '\u200b', 'a\u200bb', 'a\u202eb', 'a\u0007b', 'a\tb', 'a\nb']
// it.each spreads an array case into several arguments; wrapping each value keeps it whole.
const each = (list) => list.map((v) => [v])

describe('auditLegacy', () => {
  it('accepts a valid payload, including a member under two accolades and a role with no holders', () => {
    expect(auditLegacy(valid())).toEqual([])
    expect(auditLegacy(edit((l) => l.accolades[1].holders.push({ id: USER_A, name: 'Alpha Holder' })))).toEqual([])
  })

  it.each(each([null, undefined, 0, '', 'x', [], true]))('rejects %j as the whole payload', (v) => {
    expect(auditLegacy(v)).toEqual(['legacy: not an object'])
  })

  it.each([
    undefined, null, 42, '', '2026-10-16', '2026-10-16T12:00:00Z', '2026-10-16T12:00:00.000+00:00',
    '2026-13-01T00:00:00.000Z', '2026-02-31T00:00:00.000Z', ' 2026-10-16T12:00:00.000Z', '2026-10-16T12:00:00.000Z\n',
  ])('rejects snapshot %j', (snapshot) => {
    expect(auditLegacy(edit((l) => (l.snapshot = snapshot))).join()).toMatch(/snapshot/)
  })

  it.each(each([undefined, null, [], {}, 'x']))('rejects accolades %j and says only that', (accolades) => {
    expect(auditLegacy(edit((l) => (l.accolades = accolades)))).toEqual(['legacy: accolades must be a non-empty array'])
  })

  it.each(each([null, 5, 'x', [], undefined]))('rejects an accolade that is %j', (a) => {
    expect(auditLegacy(edit((l) => (l.accolades[0] = a)))).toEqual(['accolade 1: not an object'])
  })

  it.each(each(BAD_IDS))('rejects roleId %j', (roleId) => {
    expect(auditLegacy(edit((l) => (l.accolades[0].roleId = roleId))).join()).toMatch(/accolade 1: roleId is not a snowflake/)
  })

  it('rejects a repeated roleId, but reports two bad ids as bad, not as repeated', () => {
    expect(auditLegacy(edit((l) => (l.accolades[1].roleId = ROLE_A)))).toEqual(['accolade 2: roleId appears twice'])
    const both = auditLegacy(edit((l) => ((l.accolades[0].roleId = 'nope'), (l.accolades[1].roleId = 'nope'))))
    expect(both).toEqual(['accolade 1: roleId is not a snowflake', 'accolade 2: roleId is not a snowflake'])
  })

  it.each(each([...BAD_TEXT, 'x'.repeat(ROLE_NAME_MAX + 1)]))('rejects role name %j', (name) => {
    expect(auditLegacy(edit((l) => (l.accolades[0].name = name))).join()).toMatch(/accolade 1: name/)
  })

  it.each(each([undefined, '', 'red', '#fff', '#12345', '#1234567', 'ff0000', '#gg0000', '#FF000G', 5, ['#ff0000'], '#ff0000 ', ' #ff0000']))(
    'rejects color %j',
    (color) => {
      expect(auditLegacy(edit((l) => (l.accolades[0].color = color))).join()).toMatch(/accolade 1: color/)
    },
  )
  it.each(['#FF00aa', '#000000', null])('accepts color %j', (color) => {
    expect(auditLegacy(edit((l) => (l.accolades[0].color = color)))).toEqual([])
  })

  it.each([undefined, null, 5, '', ' x', 'x ', 'x\n', '\nx', 'a\tb', 'a\rb', 'a\u200bb', 'x'.repeat(BLURB_MAX + 1)])('rejects blurb %j', (blurb) => {
    expect(auditLegacy(edit((l) => (l.accolades[0].blurb = blurb))).join()).toMatch(/accolade 1: blurb/)
  })
  it('accepts paragraph breaks in a blurb, and a blurb of exactly the limit', () => {
    expect(auditLegacy(edit((l) => (l.accolades[0].blurb = 'a\n\nb\nc')))).toEqual([])
    expect(auditLegacy(edit((l) => (l.accolades[0].blurb = 'x'.repeat(BLURB_MAX))))).toEqual([])
  })

  it('counts characters, not UTF-16 units, against every limit', () => {
    expect(auditLegacy(edit((l) => (l.accolades[0].holders[0].name = '😀'.repeat(NAME_MAX))))).toEqual([])
    expect(auditLegacy(edit((l) => (l.accolades[0].holders[0].name = '😀'.repeat(NAME_MAX + 1)))).join()).toMatch(/holder 1: name/)
    expect(auditLegacy(edit((l) => (l.accolades[0].name = 'x'.repeat(ROLE_NAME_MAX))))).toEqual([])
    expect(auditLegacy(edit((l) => (l.accolades[0].blurb = '😀'.repeat(BLURB_MAX))))).toEqual([])
  })

  it.each([undefined, null, {}, 'x', 5])('rejects holders %j without throwing', (holders) => {
    expect(auditLegacy(edit((l) => (l.accolades[0].holders = holders)))).toEqual(['accolade 1: holders must be an array'])
  })

  it.each(each([null, 5, 'x', []]))('rejects a holder that is %j', (h) => {
    expect(auditLegacy(edit((l) => (l.accolades[0].holders[0] = h)))).toEqual(['accolade 1, holder 1: not an object'])
  })

  it.each(each(BAD_IDS))('rejects holder id %j', (id) => {
    expect(auditLegacy(edit((l) => (l.accolades[0].holders[0].id = id))).join()).toMatch(/holder 1: id is not a snowflake/)
  })

  it('rejects a repeated holder id within a role, but allows it across roles', () => {
    expect(auditLegacy(edit((l) => (l.accolades[0].holders[1].id = USER_A)))).toEqual(['accolade 1, holder 2: id appears twice'])
    const bad = auditLegacy(edit((l) => ((l.accolades[0].holders[0].id = 'x'), (l.accolades[0].holders[1].id = 'x'))))
    expect(bad).toEqual(['accolade 1, holder 1: id is not a snowflake', 'accolade 1, holder 2: id is not a snowflake'])
  })

  it.each(each([...BAD_TEXT, 'x'.repeat(NAME_MAX + 1)]))('rejects holder name %j', (name) => {
    expect(auditLegacy(edit((l) => (l.accolades[0].holders[0].name = name))).join()).toMatch(/holder 1: name/)
  })

  it('rejects unknown fields at every level, including a smuggled __proto__', () => {
    expect(auditLegacy(edit((l) => (l.extra = 1)))).toEqual(['legacy: has an unknown field'])
    expect(auditLegacy(edit((l) => (l.accolades[0].avatar = 'x')))).toEqual(['accolade 1: has an unknown field'])
    expect(auditLegacy(edit((l) => (l.accolades[0].holders[0].email = 'x')))).toEqual(['accolade 1, holder 1: has an unknown field'])
    const smuggled = JSON.parse(`{"snapshot":"2026-10-16T12:00:00.000Z","accolades":[],"__proto__":{"x":1}}`)
    expect(auditLegacy(smuggled).join()).toMatch(/unknown field/)
  })

  it('reports every problem, not just the first', () => {
    const l = edit((x) => {
      x.snapshot = 'x'
      x.accolades[0].name = ''
      x.accolades[0].holders[0].id = 'x'
      x.accolades[1].blurb = ''
    })
    expect(auditLegacy(l)).toHaveLength(4)
  })

  it('never echoes data into a problem, and never mutates its input', () => {
    const l = edit((x) => (x.accolades[0].holders[0].name = 'SECRET-NAME' + 'x'.repeat(NAME_MAX)))
    expect(JSON.stringify(auditLegacy(l))).not.toContain('SECRET-NAME')
    expect(() => auditLegacy(deepFreeze(valid()))).not.toThrow()
  })

  it('accepts whatever valid parts it is built from (property)', () => {
    const id = fc.stringMatching(/^[1-9]\d{16,19}$/)
    const accolade = fc.record({
      roleId: id,
      name: fc.stringMatching(/^[A-Za-z0-9]{1,100}$/),
      color: fc.oneof(fc.constant(null), fc.stringMatching(/^#[0-9a-f]{6}$/)),
      blurb: fc.stringMatching(/^[A-Za-z0-9]{1,600}$/),
      holders: fc.uniqueArray(fc.record({ id, name: fc.stringMatching(/^[A-Za-z0-9]{1,32}$/) }), { selector: (h) => h.id, maxLength: 20 }),
    })
    fc.assert(
      fc.property(fc.uniqueArray(accolade, { selector: (a) => a.roleId, minLength: 1, maxLength: 8 }), (accolades) => {
        expect(auditLegacy({ snapshot: '2026-10-16T12:00:00.000Z', accolades })).toEqual([])
      }),
    )
  })
})

describe('legacyView', () => {
  it('gives the snapshot date, the accolades in file order, and each one ready to show', () => {
    expect(legacyView(valid())).toEqual({
      snapshotDate: '2026-10-16',
      accolades: [
        {
          roleId: ROLE_A, name: 'Fixture Laurel', color: '#d4a017', paragraphs: ['One.', 'Two.'], countLabel: '2 holders',
          holders: [{ id: USER_A, name: 'Alpha Holder' }, { id: USER_B, name: 'beta holder' }],
        },
        { roleId: ROLE_B, name: 'Fixture Ember', color: null, paragraphs: ['Three.'], countLabel: 'No holders on record', holders: [] },
      ],
    })
  })

  it.each([[0, 'No holders on record'], [1, '1 holder'], [2, '2 holders'], [11, '11 holders']])('labels %i holders as "%s"', (n, label) => {
    const holders = Array.from({ length: n }, (_, i) => ({ id: `82000000000000${String(i).padStart(4, '0')}`, name: `h${i}` }))
    expect(legacyView(edit((l) => (l.accolades[0].holders = holders))).accolades[0].countLabel).toBe(label)
  })

  it('sorts holders by name ignoring case, and ties by id whatever order they arrive in', () => {
    const holders = [
      { id: '820000000000000003', name: 'b' },
      { id: '820000000000000002', name: 'alpha' },
      { id: '820000000000000001', name: 'Alpha' },
      { id: '820000000000000004', name: 'B' },
      { id: '820000000000000005', name: 'c' },
    ]
    const want = ['820000000000000001', '820000000000000002', '820000000000000003', '820000000000000004', '820000000000000005']
    const ids = (hs) => legacyView(edit((l) => (l.accolades[0].holders = hs))).accolades[0].holders.map((h) => h.id)
    expect(ids(holders)).toEqual(want)
    expect(ids([...holders].reverse())).toEqual(want)
  })

  it('splits paragraphs on blank lines only', () => {
    const paras = (blurb) => legacyView(edit((l) => (l.accolades[0].blurb = blurb))).accolades[0].paragraphs
    expect(paras('a\n\nb')).toEqual(['a', 'b'])
    expect(paras('a\n\n\n\nb')).toEqual(['a', 'b'])
    expect(paras('a\nb')).toEqual(['a\nb'])
  })

  it('never mutates its input, and hands back its own holder arrays', () => {
    const l = deepFreeze(valid())
    const view = legacyView(l)
    view.accolades[0].holders.push({ id: 'x', name: 'x' })
    expect(l.accolades[0].holders).toHaveLength(2)
  })

  it('never loses or invents a holder, and the order they arrive in does not matter (property)', () => {
    const holdersArb = fc.uniqueArray(
      fc.record({ id: fc.stringMatching(/^[1-9]\d{16,19}$/), name: fc.stringMatching(/^[A-Za-z0-9]{1,32}$/) }),
      { selector: (h) => h.id, maxLength: 25 },
    )
    fc.assert(
      fc.property(holdersArb, (holders) => {
        const view = (hs) => legacyView(edit((l) => (l.accolades[0].holders = hs))).accolades[0].holders
        const fwd = view(holders)
        expect(view([...holders].reverse())).toEqual(fwd)
        expect(fwd.map((h) => h.id).sort()).toEqual(holders.map((h) => h.id).sort())
      }),
    )
  })
})

describe('luminance and readableColor', () => {
  it('weights the channels like sight does', () => {
    expect(luminance('#000000')).toBe(0)
    expect(luminance('#ffffff')).toBeCloseTo(1, 5)
    expect(luminance('#ff0000')).toBeCloseTo(0.2126, 4)
    expect(luminance('#00ff00')).toBeCloseTo(0.7152, 4)
    expect(luminance('#0000ff')).toBeCloseTo(0.0722, 4)
    expect(luminance('#808080')).toBeCloseTo(0.2195, 3)
    expect(luminance('#FFFFFF')).toBeCloseTo(1, 5)
  })

  it.each(['#ffffff', '#00ff00', '#ff0000', '#5865f2', '#d4a017', '#FFFFFF'])('keeps %s, which reads on the dark inlay', (c) => {
    expect(readableColor(c)).toBe(c)
  })
  it.each(['#000000', '#0000ff', '#8b0000', '#202020', '#1f1e1d'])('drops %s, which would vanish into it', (c) => {
    expect(readableColor(c)).toBeNull()
  })
  it('passes a missing colour through as missing', () => {
    expect(readableColor(null)).toBeNull()
  })
  it('keeps a colour exactly at the threshold and drops one just under', () => {
    expect(readableColor('#6e6e6e', luminance('#6e6e6e'))).toBe('#6e6e6e')
    expect(readableColor('#6e6e6e', luminance('#6e6e6e') + 1e-9)).toBeNull()
  })
})

describe('canonicalLegacy', () => {
  it('is two-space JSON with a trailing newline that parses back to the same payload', () => {
    const text = canonicalLegacy(valid())
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('\n  "snapshot"')
    expect(JSON.parse(text)).toEqual(valid())
  })
  it('names the file the export carries it in', () => {
    expect(LEGACY_FILE).toBe('legacy-accolades.json')
  })
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `node_modules/.bin/vitest run src/lib/archive/legacy.test.js`
Expected: FAIL, `Failed to resolve import "./legacy"`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/archive/legacy.js`:

```js
/**
 * Legacy Accolades: validation and the view model for the sealed `legacy` payload
 * (docs/superpowers/specs/2026-10-16-legacy-accolades-design.md). Pure: no I/O, no globals.
 * `auditLegacy` is what keeps a bad file out of the sealed bundle; `legacyView` is what the page renders.
 */
export const LEGACY_FILE = 'legacy-accolades.json'
export const NAME_MAX = 32 // Discord's own cap on nicknames and display names
export const ROLE_NAME_MAX = 100 // Discord's cap on role names
export const BLURB_MAX = 600

const SNOWFLAKE = /^\d{17,20}$/
const COLOR = /^#[0-9a-f]{6}$/i
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const HIDDEN = /[\p{Cc}\p{Cf}]/u // control characters and invisible formatting (zero-width, bidi overrides)
const TOP_KEYS = ['snapshot', 'accolades']
const ACCOLADE_KEYS = ['roleId', 'name', 'color', 'blurb', 'holders']
const HOLDER_KEYS = ['id', 'name']

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const hasUnknownKey = (o, allowed) => Object.keys(o).some((k) => !allowed.includes(k))
// typeof first: a number or a one-element array would otherwise coerce into a match.
const isSnowflake = (v) => typeof v === 'string' && SNOWFLAKE.test(v)
const isPlain = (s, max, { newlines = false } = {}) =>
  typeof s === 'string' && s !== '' && s === s.trim() && [...s].length <= max && !HIDDEN.test(newlines ? s.replaceAll('\n', '') : s)

function isInstant(s) {
  if (typeof s !== 'string' || !INSTANT.test(s)) return false
  const t = Date.parse(s)
  // Date.parse rolls 2026-02-31 over to March; only a value that survives the round trip is a real date.
  return Number.isFinite(t) && new Date(t).toISOString() === s
}

/** Problems with a legacy payload, as short descriptions that name positions and never quote data. */
export function auditLegacy(legacy) {
  if (!isObject(legacy)) return ['legacy: not an object']
  const problems = []
  const bad = (where, what) => problems.push(`${where}: ${what}`)
  if (hasUnknownKey(legacy, TOP_KEYS)) bad('legacy', 'has an unknown field')
  if (!isInstant(legacy.snapshot)) bad('legacy', 'snapshot is not a UTC instant like 2026-01-02T03:04:05.000Z')
  if (!Array.isArray(legacy.accolades) || legacy.accolades.length === 0) {
    bad('legacy', 'accolades must be a non-empty array')
    return problems
  }
  const seenRoles = new Set()
  legacy.accolades.forEach((a, i) => {
    const at = `accolade ${i + 1}`
    if (!isObject(a)) return bad(at, 'not an object')
    if (hasUnknownKey(a, ACCOLADE_KEYS)) bad(at, 'has an unknown field')
    if (!isSnowflake(a.roleId)) bad(at, 'roleId is not a snowflake')
    else if (seenRoles.has(a.roleId)) bad(at, 'roleId appears twice')
    seenRoles.add(a.roleId)
    if (!isPlain(a.name, ROLE_NAME_MAX)) bad(at, `name must be 1-${ROLE_NAME_MAX} characters of plain text`)
    if (a.color !== null && !(typeof a.color === 'string' && COLOR.test(a.color))) bad(at, 'color must be #rrggbb or null')
    if (!isPlain(a.blurb, BLURB_MAX, { newlines: true })) bad(at, `blurb must be 1-${BLURB_MAX} characters of plain text`)
    if (!Array.isArray(a.holders)) return bad(at, 'holders must be an array')
    const seenHolders = new Set()
    a.holders.forEach((h, j) => {
      const who = `${at}, holder ${j + 1}`
      if (!isObject(h)) return bad(who, 'not an object')
      if (hasUnknownKey(h, HOLDER_KEYS)) bad(who, 'has an unknown field')
      if (!isSnowflake(h.id)) bad(who, 'id is not a snowflake')
      else if (seenHolders.has(h.id)) bad(who, 'id appears twice')
      seenHolders.add(h.id)
      if (!isPlain(h.name, NAME_MAX)) bad(who, `name must be 1-${NAME_MAX} characters of plain text`)
    })
  })
  return problems
}

// Headings are large text, which needs 3:1 against the plaque's near-black inlay (luminance about 0.008).
const READABLE_LUMINANCE = 0.15
const channel = (hex, at) => (parseInt(hex.slice(at, at + 2), 16) / 255) ** 2.2

/** Relative luminance of "#rrggbb" (a plain 2.2 gamma: only used to pick readable colours). */
export const luminance = (hex) => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5)

/** The role colour if it shows up on the dark inlay, else null (the page then uses its normal heading colour). */
export const readableColor = (color, min = READABLE_LUMINANCE) => (color !== null && luminance(color) >= min ? color : null)

const byName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id)
const countLabel = (n) => (n === 0 ? 'No holders on record' : n === 1 ? '1 holder' : `${n} holders`)

/** What the page shows. Input is an audited payload; it is never mutated. */
export function legacyView(legacy) {
  return {
    snapshotDate: legacy.snapshot.slice(0, 10),
    accolades: legacy.accolades.map((a) => ({
      roleId: a.roleId,
      name: a.name,
      color: readableColor(a.color),
      paragraphs: a.blurb.split(/\n{2,}/),
      countLabel: countLabel(a.holders.length),
      holders: a.holders.map((h) => ({ id: h.id, name: h.name })).sort(byName),
    })),
  }
}

/** The one on-disk format of the export file: the snapshot script writes it, `unseal` restores it. */
export const canonicalLegacy = (legacy) => JSON.stringify(legacy, null, 2) + '\n'
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `node_modules/.bin/vitest run src/lib/archive/legacy.test.js`
Expected: PASS, all tests.

- [ ] **Step 6: Add the file to the coverage and mutation gates**

In `vitest.config.js`, replace `  'src/lib/archive/prune.js',` with:

```js
  'src/lib/archive/prune.js',
  'src/lib/archive/legacy.js',
```

In `stryker.config.mjs`, replace `  'src/lib/archive/prune.js',` with:

```js
  'src/lib/archive/prune.js',
    'src/lib/archive/legacy.js',
```

- [ ] **Step 7: Check coverage and mutation on the new file**

Run: `node_modules/.bin/vitest run --coverage src/lib/archive/legacy.test.js`
Expected: the `legacy.js` row reads 100 / 100 / 100 / 100 (other gated files will show threshold errors because only one test file ran; ignore those here).

Run: `node_modules/.bin/stryker run --mutate src/lib/archive/legacy.js`
Expected: mutation score 100%. For any survivor, add the test that kills it (or restructure the code if the mutant is equivalent), then re-run.

- [ ] **Step 8: Commit**

```bash
git add src/lib/archive/legacy.js src/lib/archive/legacy.test.js vitest.config.js stryker.config.mjs
git commit -m "feat(archive): pure audit and view model for legacy accolades" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The archive model carries it, the audit checks it

**Files:**
- Modify: `src/lib/archive/testIndex.js`, `src/lib/archive/model.js`, `src/lib/archive/audit.js`
- Test: `src/lib/archive/model.test.js`, `src/lib/archive/audit.test.js`

**Interfaces:**
- Consumes: `auditLegacy` from Task 1.
- Produces: `makeLegacy()` and `IDS.LEGACY_ROLE_A/B/C`, `IDS.LEGACY_USER_A/B/C` from `testIndex.js`; `makeIndex()` now includes `legacy: makeLegacy()`; `createArchive(index).legacy` is the payload or `null`; `auditArchive` problems of `kind: 'bad-legacy'` with `collectionKey/threadId/messageId` all `null`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/archive/model.test.js` (add `makeLegacy` to its existing `testIndex` import):

```js
describe('createArchive and the legacy accolades', () => {
  it('carries the sealed payload as given', () => {
    expect(createArchive(makeIndex()).legacy).toEqual(makeLegacy())
  })
  it('has none for a bundle sealed before they existed', () => {
    const i = makeIndex()
    delete i.legacy
    expect(createArchive(i).legacy).toBeNull()
  })
})
```

In `src/lib/archive/audit.test.js` add `makeLegacy` to the `testIndex` import and append inside `describe('auditArchive', ...)`:

```js
  describe('legacy accolades', () => {
    it('are absent from an older bundle without a problem', () => {
      const idx = makeIndex()
      delete idx.legacy
      expect(auditArchive(createArchive(idx)).problems).toEqual([])
    })
    it('a bad payload is a bad-legacy problem that sits on no thread', () => {
      const idx = makeIndex()
      idx.legacy.accolades[1].roleId = idx.legacy.accolades[0].roleId
      expect(auditArchive(createArchive(idx)).problems).toEqual([
        { collectionKey: null, threadId: null, messageId: null, kind: 'bad-legacy', detail: 'accolade 2: roleId appears twice' },
      ])
    })
    it.each([0, '', false, [], 'x'].map((v) => [v]))('a present but unusable payload (%j) is reported, not skipped', (legacy) => {
      const idx = makeIndex()
      idx.legacy = legacy
      expect(kinds(idx)).toEqual(['bad-legacy'])
    })
    it('the synthetic payload is itself valid', () => {
      expect(auditArchive(createArchive({ ...makeIndex(), legacy: makeLegacy() })).problems).toEqual([])
    })
  })
```

- [ ] **Step 2: Run to see them fail**

Run: `node_modules/.bin/vitest run src/lib/archive/model.test.js src/lib/archive/audit.test.js`
Expected: FAIL (`makeLegacy` is not exported / `legacy` is undefined).

- [ ] **Step 3: Implement**

In `src/lib/archive/testIndex.js`, replace the line
`  ROLE: '400000000000000001', USER: '600000000000000001', TAG: '700000000000000001',`
with:

```js
  ROLE: '400000000000000001', USER: '600000000000000001', TAG: '700000000000000001',
  LEGACY_ROLE_A: '810000000000000001', LEGACY_ROLE_B: '810000000000000002', LEGACY_ROLE_C: '810000000000000003',
  LEGACY_USER_A: '820000000000000001', LEGACY_USER_B: '820000000000000002', LEGACY_USER_C: '820000000000000003',
```

Add this function directly above `export function makeIndex() {`:

```js
/** Synthetic legacy accolades: one member under two roles, holders deliberately unsorted, a role with none, a dark colour, two paragraphs. */
export function makeLegacy() {
  return {
    snapshot: '2026-10-16T12:00:00.000Z',
    accolades: [
      {
        roleId: IDS.LEGACY_ROLE_A, name: 'Fixture Laurel', color: '#d4a017', blurb: 'Fixture blurb one.',
        holders: [{ id: IDS.LEGACY_USER_B, name: 'beta holder' }, { id: IDS.LEGACY_USER_A, name: 'Alpha Holder' }],
      },
      {
        roleId: IDS.LEGACY_ROLE_B, name: 'Fixture Ember', color: null, blurb: 'Fixture blurb two.',
        holders: [{ id: IDS.LEGACY_USER_A, name: 'Alpha Holder' }, { id: IDS.LEGACY_USER_C, name: 'Ed' }],
      },
      { roleId: IDS.LEGACY_ROLE_C, name: 'Fixture Ash', color: '#202020', blurb: 'Fixture blurb three.\n\nSecond paragraph.', holders: [] },
    ],
  }
}

```

And in `makeIndex()`, replace
```js
      [IDS.EXT_CHANNEL]: { text: true, why: 'outside archive' },
    },
  }
}
```
with
```js
      [IDS.EXT_CHANNEL]: { text: true, why: 'outside archive' },
    },
    legacy: makeLegacy(),
  }
}
```

In `src/lib/archive/model.js`, replace
`  return { collections, fixes: index.fixes ?? {}, linkIndex: buildLinkIndex([...collections.values()]) }`
with:

```js
  // `legacy` is the sealed Legacy Accolades payload (see legacy.js); a bundle sealed before it existed has none.
  return { collections, fixes: index.fixes ?? {}, linkIndex: buildLinkIndex([...collections.values()]), legacy: index.legacy ?? null }
```

In `src/lib/archive/audit.js`, add `import { auditLegacy } from './legacy'` after the existing imports, and replace
```js
  const problems = validateFixes(archive.fixes, archive.linkIndex).map((detail) => ({
    collectionKey: null, threadId: null, messageId: null, kind: 'bad-fix', detail,
  }))
```
with:

```js
  const problem = (kind) => (detail) => ({ collectionKey: null, threadId: null, messageId: null, kind, detail })
  const problems = [
    ...validateFixes(archive.fixes, archive.linkIndex).map(problem('bad-fix')),
    // `!== null`, not truthiness: a present-but-unusable payload (0, '', false) must be reported, not skipped.
    ...(archive.legacy !== null ? auditLegacy(archive.legacy).map(problem('bad-legacy')) : []),
  ]
```

- [ ] **Step 4: Run to see them pass, then the whole suite**

Run: `node_modules/.bin/vitest run src/lib/archive/model.test.js src/lib/archive/audit.test.js`
Expected: PASS.

Run: `node_modules/.bin/vitest run`
Expected: whole suite passes. If another test enumerates `makeIndex()` keys or compares whole indexes and now trips on `legacy`, update that test's expectation to include it; do not special-case the fixture.

- [ ] **Step 5: Mutation check on audit.js**

Run: `node_modules/.bin/stryker run --mutate src/lib/archive/audit.js`
Expected: 100%. (Survivors in the new lines mean a missing test; add it.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/archive/testIndex.js src/lib/archive/model.js src/lib/archive/audit.js src/lib/archive/model.test.js src/lib/archive/audit.test.js
git commit -m "feat(archive): the archive model carries the legacy accolades and the audit checks them" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Seal, unseal and the permanence guard

**Files:**
- Modify: `scripts/lib/archive-seal.mjs`, `scripts/seal-archive.mjs`, `scripts/archive-fixture.mjs`
- Test: `scripts/lib/archive-seal.test.mjs`

**Interfaces:**
- Consumes: `LEGACY_FILE`, `canonicalLegacy` (Task 1); `makeLegacy`, `index.legacy` (Task 2).
- Produces: `readExport(dir).index.legacy` (parsed file, absent when no file); `sealExport({ exportDir, rawKey, outDir, now, prevLock = null, dropLegacy = false })` returning `{ format, kid, files, legacy?: true }`; `unsealDir` writes `legacy-accolades.json` in canonical form; `writeFixture(dir)` writes a synthetic `legacy-accolades.json` whose first blurb carries `${SENTINEL}-legacy`.

- [ ] **Step 1: Write the failing tests**

In `scripts/lib/archive-seal.test.mjs`, change the `node:fs/promises` import to also bring in `mkdir`, and add imports:

```js
import { LEGACY_FILE, canonicalLegacy } from '../../src/lib/archive/legacy.js'
```

Append at the end of the file:

```js
describe('legacy accolades', () => {
  const legacyPath = () => join(exp, LEGACY_FILE)
  const seal = (extra = {}) => sealExport({ exportDir: exp, rawKey: key, outDir: out, now: new Date(0), ...extra })

  it('travels in the sealed index and flags the lock', async () => {
    const onDisk = JSON.parse(await readFile(legacyPath(), 'utf8'))
    expect((await readExport(exp)).index.legacy).toEqual(onDisk)
    expect((await seal()).legacy).toBe(true)
  })

  it('an export without it seals as before and the lock says nothing about it', async () => {
    await unlink(legacyPath())
    expect((await readExport(exp)).index.legacy).toBeUndefined()
    expect(Object.keys(await seal())).toEqual(['format', 'kid', 'files'])
  })

  it('is restored as canonical JSON even when the input was compact', async () => {
    const compact = JSON.stringify(JSON.parse(await readFile(legacyPath(), 'utf8')))
    await writeFile(legacyPath(), compact)
    await seal()
    const restored = join(root, 'restored')
    await unsealDir({ dir: out, rawKey: key, destDir: restored })
    const text = await readFile(join(restored, LEGACY_FILE), 'utf8')
    expect(JSON.parse(text)).toEqual(JSON.parse(compact))
    expect(text).toBe(canonicalLegacy(JSON.parse(compact)))
  })

  it('refuses to seal a bad payload, naming the problem, and writes nothing', async () => {
    const l = JSON.parse(await readFile(legacyPath(), 'utf8'))
    l.accolades[1].roleId = l.accolades[0].roleId
    await writeFile(legacyPath(), canonicalLegacy(l))
    await expect(seal()).rejects.toThrow(/bad-legacy.*roleId appears twice/)
    await expect(readdir(out)).rejects.toThrow()
  })

  it('does not treat a file that is null, or cannot be read, as absent', async () => {
    await writeFile(legacyPath(), 'null')
    await expect(readExport(exp)).rejects.toThrow(/null/)
    await unlink(legacyPath())
    await mkdir(legacyPath())
    await expect(readExport(exp)).rejects.toThrow()
  })

  describe('once a published bundle carried it', () => {
    it('a seal without the file is refused, and nothing is written', async () => {
      await unlink(legacyPath())
      await expect(seal({ prevLock: { legacy: true } })).rejects.toThrow(/legacy/)
      await expect(readdir(out)).rejects.toThrow()
    })
    it('--drop-legacy lets it go, and the new lock no longer claims it', async () => {
      await unlink(legacyPath())
      const lock = await seal({ prevLock: { legacy: true }, dropLegacy: true })
      expect('legacy' in lock).toBe(false)
    })
    it.each([null, {}, { legacy: false }])('does not matter when the last lock was %j', async (prevLock) => {
      await unlink(legacyPath())
      await expect(seal({ prevLock })).resolves.toBeTruthy()
    })
    it('a seal that still has the file goes through', async () => {
      expect((await seal({ prevLock: { legacy: true } })).legacy).toBe(true)
    })
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `node_modules/.bin/vitest run scripts/lib/archive-seal.test.mjs`
Expected: FAIL (legacy not read/sealed; fixture has no legacy file).

- [ ] **Step 3: Implement**

In `scripts/archive-fixture.mjs` add imports:

```js
import { LEGACY_FILE, canonicalLegacy } from '../src/lib/archive/legacy.js'
```

and, in `writeFixture`, directly before `const key = randomBytes(32).toString('base64')`:

```js
  // The legacy accolades sit beside the collections; the sentinel rides in a blurb so every leak check covers them too.
  index.legacy.accolades[0].blurb += ` ${SENTINEL}-legacy`
  await writeFile(join(dir, LEGACY_FILE), canonicalLegacy(index.legacy))
```

In `scripts/lib/archive-seal.mjs`, add after the registry import:

```js
import { LEGACY_FILE, canonicalLegacy } from '../../src/lib/archive/legacy.js'
```

In `readExport`, replace the final `  return { index, assets }` with:

```js
  const legacyText = await readFile(join(exportDir, LEGACY_FILE), 'utf8').catch((e) => {
    if (e.code === 'ENOENT') return null // no file: a bundle without legacy accolades
    throw e
  })
  if (legacyText !== null) {
    const legacy = JSON.parse(legacyText)
    // JSON `null` would read as "absent" downstream and quietly drop the page.
    if (legacy === null) throw new Error(`${LEGACY_FILE} must not be null`)
    index.legacy = legacy
  }
  return { index, assets }
```

Replace the `sealExport` signature and first line with:

```js
export async function sealExport({ exportDir, rawKey, outDir, now = new Date(), prevLock = null, dropLegacy = false }) {
  const { index, assets } = await readExport(exportDir)
  // Once a published bundle carried the legacy accolades, sealing without them would silently drop the page.
  if (prevLock?.legacy && !dropLegacy && !index.legacy) {
    throw new Error(`the last published archive carried the legacy accolades, but ${LEGACY_FILE} is missing from ${exportDir}: restore it (unseal) or pass --drop-legacy`)
  }
```

Replace `  return { format: 1, kid: keys.kid, files }` with:

```js
  return { format: 1, kid: keys.kid, files, ...(index.legacy ? { legacy: true } : {}) }
```

In `unsealDir`, after the line `  writes.push([join(destDir, 'link-fixes.json'), enc.encode(JSON.stringify(index.fixes, null, 2))])` add:

```js
  if (index.legacy) writes.push([join(destDir, LEGACY_FILE), enc.encode(canonicalLegacy(index.legacy))])
```

In `scripts/seal-archive.mjs`: add `'drop-legacy': { type: 'boolean', default: false },` to the `parseArgs` options; add this line to the header comment block, directly under the `seal [--publish]` line, in the same style:
` *                        (a bundle that carried legacy accolades cannot be re-sealed without legacy-accolades.json unless --drop-legacy)`; and replace the first lines of the `seal` branch:

```js
  if (cmd === 'seal') {
    const lock = await sealExport({ exportDir: values.export, rawKey: await key(), outDir: values.out })
    const prev = (await exists(values.lock)) ? JSON.parse(await readFile(values.lock, 'utf8')) : null
```
with:
```js
  if (cmd === 'seal') {
    const prev = (await exists(values.lock)) ? JSON.parse(await readFile(values.lock, 'utf8')) : null
    const lock = await sealExport({ exportDir: values.export, rawKey: await key(), outDir: values.out, prevLock: prev, dropLegacy: values['drop-legacy'] })
```
and change the final log line of that branch to
``console.log(`sealed ${Object.keys(lock.files).length} files, kid ${lock.kid}${lock.legacy ? ', with legacy accolades' : ''}${values.publish ? `, published ${lock.release}` : ''}`)``.

- [ ] **Step 4: Run to see them pass, then the whole suite**

Run: `node_modules/.bin/vitest run scripts/lib/archive-seal.test.mjs`
Expected: PASS (including the pre-existing "restores every export file byte-for-byte", which now also covers the legacy file).

Run: `node_modules/.bin/vitest run`
Expected: whole suite passes.

- [ ] **Step 5: Smoke the CLI wiring (it is glue the unit tests do not reach)**

```bash
rm -rf /tmp/leg-exp /tmp/leg-out /tmp/leg-lock.json
node_modules/.bin/bun -e "import('./scripts/archive-fixture.mjs').then((m) => m.writeFixture('/tmp/leg-exp'))"
S="node_modules/.bin/bun scripts/seal-archive.mjs seal --export /tmp/leg-exp --out /tmp/leg-out --lock /tmp/leg-lock.json --env-file /tmp/leg-exp/.env"
$S && grep -c '"legacy": true' /tmp/leg-lock.json
rm /tmp/leg-exp/legacy-accolades.json
$S; echo "exit=$?"
$S --drop-legacy && grep -c legacy /tmp/leg-lock.json
```
Expected: first seal prints `sealed N files, kid …, with legacy accolades` and grep prints `1`; second prints `the last published archive carried the legacy accolades, but legacy-accolades.json is missing …` with `exit=1`; third seals and grep prints `0`. Clean up with `rm -rf /tmp/leg-exp /tmp/leg-out /tmp/leg-lock.json`.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/archive-seal.mjs scripts/lib/archive-seal.test.mjs scripts/seal-archive.mjs scripts/archive-fixture.mjs
git commit -m "feat(archive): seal, unseal and guard the legacy accolades" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Shared Discord helper

**Files:**
- Create: `scripts/lib/discord.mjs`, `scripts/lib/discord.test.mjs`
- Modify: `scripts/fetch-discord-members.mjs`

**Interfaces:**
- Produces: `API` (`'https://discord.com/api/v10'`); `createDiscord({ token, fetchImpl = fetch, sleep = <setTimeout promise>, log = () => {} })` returning `{ discordFetch(url), fetchAllMembers(guildId), fetchRoles(guildId) }`. `fetchAllMembers` pages `limit=1000&after=<last id>` until a short page; `fetchRoles` returns `GET /guilds/{id}/roles`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/lib/discord.test.mjs`:

```js
import { describe, it, expect } from 'vitest'
import { createDiscord, API } from './discord.mjs'

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, ...init })
const GUILD = '800000000000000001'

// A Discord stand-in: each call takes the next answer; `waits` records the pauses the helper asked for.
function harness(...answers) {
  const seen = { urls: [], auths: [], waits: [] }
  const queue = [...answers]
  const fetchImpl = async (url, init) => {
    seen.urls.push(url)
    seen.auths.push(init.headers.Authorization)
    if (!queue.length) throw new Error('unexpected extra request')
    return queue.shift()
  }
  const discord = createDiscord({ token: 'tok', fetchImpl, sleep: async (ms) => void seen.waits.push(ms) })
  return { discord, seen }
}
const member = (i) => ({ user: { id: String(100000000000000000n + BigInt(i)) }, roles: [] })
const page = (n, from = 0) => Array.from({ length: n }, (_, i) => member(from + i))

describe('discordFetch', () => {
  it('authenticates as the bot and returns the parsed body', async () => {
    const { discord, seen } = harness(json({ ok: 1 }))
    expect(await discord.discordFetch(`${API}/x`)).toEqual({ ok: 1 })
    expect(seen.auths).toEqual(['Bot tok'])
  })

  it('throws on a non-OK answer, with its status and body', async () => {
    const { discord } = harness(new Response('nope', { status: 403, statusText: 'Forbidden' }))
    await expect(discord.discordFetch(`${API}/x`)).rejects.toThrow('Discord API 403 Forbidden: nope')
  })

  it('waits out a 429 for as long as Discord says, then retries', async () => {
    const { discord, seen } = harness(json({ retry_after: 2.5 }, { status: 429 }), json({ ok: 1 }))
    expect(await discord.discordFetch(`${API}/x`)).toEqual({ ok: 1 })
    expect(seen.waits).toEqual([2500])
    expect(seen.urls).toHaveLength(2)
  })

  it('pauses until the bucket resets when it is empty, and not otherwise', async () => {
    const empty = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '1.5' }
    const a = harness(json({}, { headers: empty }))
    await a.discord.discordFetch(`${API}/x`)
    expect(a.seen.waits).toEqual([1500])
    const b = harness(json({}, { headers: { ...empty, 'x-ratelimit-remaining': '5' } }))
    await b.discord.discordFetch(`${API}/x`)
    expect(b.seen.waits).toEqual([])
    const c = harness(json({}, { headers: { 'x-ratelimit-remaining': '0' } }))
    await c.discord.discordFetch(`${API}/x`)
    expect(c.seen.waits).toEqual([])
  })
})

describe('fetchAllMembers', () => {
  it('pages by the last id until a short page, and returns everyone', async () => {
    const { discord, seen } = harness(json(page(1000)), json(page(3, 1000)))
    const all = await discord.fetchAllMembers(GUILD)
    expect(all).toHaveLength(1003)
    expect(seen.urls).toEqual([
      `${API}/guilds/${GUILD}/members?limit=1000&after=0`,
      `${API}/guilds/${GUILD}/members?limit=1000&after=${page(1000)[999].user.id}`,
    ])
  })
  it('stops after one short page', async () => {
    const { discord, seen } = harness(json(page(5)))
    expect(await discord.fetchAllMembers(GUILD)).toHaveLength(5)
    expect(seen.urls).toHaveLength(1)
  })
  it('asks once more after an exactly full page, and accepts that it was the last', async () => {
    const { discord, seen } = harness(json(page(1000)), json([]))
    expect(await discord.fetchAllMembers(GUILD)).toHaveLength(1000)
    expect(seen.urls).toHaveLength(2)
  })
})

describe('fetchRoles', () => {
  it('returns the guild roles', async () => {
    const { discord, seen } = harness(json([{ id: '1', name: 'r', color: 0 }]))
    expect(await discord.fetchRoles(GUILD)).toEqual([{ id: '1', name: 'r', color: 0 }])
    expect(seen.urls).toEqual([`${API}/guilds/${GUILD}/roles`])
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `node_modules/.bin/vitest run scripts/lib/discord.test.mjs`
Expected: FAIL, cannot resolve `./discord.mjs`.

- [ ] **Step 3: Implement**

Create `scripts/lib/discord.mjs` (the logic is lifted unchanged from `fetch-discord-members.mjs`; `fetch`, the sleep and the logger are injectable):

```js
/**
 * Discord REST helpers for the maintenance scripts (fetch-discord-members, snapshot-legacy-accolades).
 * Discord's rate-limit headers and 429 bodies are honoured; the member list is paginated.
 * Needs a bot token, and the GUILD_MEMBERS privileged intent for the member list.
 */
export const API = 'https://discord.com/api/v10'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createDiscord({ token, fetchImpl = fetch, sleep = wait, log = () => {} }) {
  /** Fetch with Discord's rate-limit headers/429 body honored. */
  async function discordFetch(url) {
    for (;;) {
      const res = await fetchImpl(url, { headers: { Authorization: `Bot ${token}` } })

      if (res.status === 429) {
        const { retry_after } = await res.json()
        log(`  rate limited, retrying in ${retry_after}s`)
        await sleep(retry_after * 1000)
        continue
      }
      if (!res.ok) {
        throw new Error(`Discord API ${res.status} ${res.statusText}: ${await res.text()}`)
      }

      const body = await res.json()
      if (res.headers.get('x-ratelimit-remaining') === '0') {
        const resetAfter = Number(res.headers.get('x-ratelimit-reset-after') || 0)
        if (resetAfter > 0) await sleep(resetAfter * 1000)
      }
      return body
    }
  }

  /** Paginate /guilds/{id}/members (max 1000/page) until exhausted. */
  async function fetchAllMembers(guildId) {
    const members = []
    let after = '0'
    for (;;) {
      const page = await discordFetch(`${API}/guilds/${guildId}/members?limit=1000&after=${after}`)
      members.push(...page)
      log(`  fetched page: ${page.length} members (total ${members.length})`)
      if (page.length < 1000) break
      after = page[page.length - 1].user.id
    }
    return members
  }

  const fetchRoles = (guildId) => discordFetch(`${API}/guilds/${guildId}/roles`)

  return { discordFetch, fetchAllMembers, fetchRoles }
}
```

Rewrite `scripts/fetch-discord-members.mjs` (read it first; keep its header comment exactly as it is) so everything after the header is:

```js
import { writeFile } from 'node:fs/promises'
import { createDiscord } from './lib/discord.mjs'

const GUILD_ID = '1322056087792521269'
const ROLE_ID = '1377787723976409211'
const OUT = new URL('../src/data/discord-members.json', import.meta.url)

const token = process.env.DISCORD_BOT_TOKEN
if (!token) {
  console.error('DISCORD_BOT_TOKEN not set.')
  process.exit(1)
}

const { fetchAllMembers } = createDiscord({ token, log: console.log })

async function run() {
  console.log(`Fetching members of guild ${GUILD_ID}...`)
  const members = await fetchAllMembers(GUILD_ID)

  const memberIds = members
    .filter((m) => m.roles.includes(ROLE_ID))
    .map((m) => m.user.id)

  await writeFile(
    OUT,
    JSON.stringify(
      { fetched: new Date().toISOString(), guildId: GUILD_ID, roleId: ROLE_ID, memberIds },
      null,
      2,
    ),
  )
  console.log(`\n${memberIds.length}/${members.length} members hold the role. Wrote ${OUT.pathname}`)
}

run().catch((err) => {
  console.error(`\nFetch failed: ${err.message}`)
  process.exit(1)
})
```

- [ ] **Step 4: Run to see the tests pass; smoke the refactored script**

Run: `node_modules/.bin/vitest run scripts/lib/discord.test.mjs`
Expected: PASS.

Run: `env -u DISCORD_BOT_TOKEN node scripts/fetch-discord-members.mjs; echo "exit=$?"`
Expected: `DISCORD_BOT_TOKEN not set.` and `exit=1` (the module graph loads and the guard still fires). Do not run it with a token; it overwrites `src/data/discord-members.json`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/discord.mjs scripts/lib/discord.test.mjs scripts/fetch-discord-members.mjs
git commit -m "refactor(scripts): share the Discord REST helper" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The snapshot

**Files:**
- Create: `scripts/lib/legacy-snapshot.mjs`, `scripts/lib/legacy-snapshot.test.mjs`, `scripts/snapshot-legacy-accolades.mjs`
- Modify: `vitest.config.js`, `stryker.config.mjs`, `package.json`

**Interfaces:**
- Consumes: `nameOf` from `server/src/displayNames.js`; `createDiscord` (Task 4); `auditLegacy`, `canonicalLegacy`, `LEGACY_FILE` (Task 1); `GUILD_ID` from `src/lib/archive/registry.js`.
- Produces:
  - `colorHex(int: unknown): string | null` — `#rrggbb`, or `null` for 0, out-of-range and non-integers
  - `buildSnapshot({ existing, roles, members, roleIds, now, prune? }): { legacy, report }` where `legacy` is the payload and `report = { missingRoles: string[], unknownRoles: string[], keptAbsent: { [roleId]: number }, nameless: string[] }` (ids and counts only)

- [ ] **Step 1: Write the failing tests**

Create `scripts/lib/legacy-snapshot.test.mjs`:

```js
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { buildSnapshot, colorHex } from './legacy-snapshot.mjs'

const R1 = '810000000000000001'
const R2 = '810000000000000002'
const R3 = '810000000000000003'
const U = (n) => `82000000000000000${n}`
const NOW = new Date('2026-10-16T12:00:00.000Z')
const LATER = new Date('2026-11-01T08:00:00.000Z')

const role = (id, name, color = 0) => ({ id, name, color })
const member = (n, roles, { nick = null, global_name = null, username = `user${n}` } = {}) => ({ nick, roles, user: { id: U(n), username, global_name } })
const deepFreeze = (o) => {
  Object.values(o).forEach((v) => typeof v === 'object' && v !== null && deepFreeze(v))
  return Object.freeze(o)
}

const members = () => [
  member(1, [R1], { nick: 'Alpha', global_name: 'ignored' }),
  member(2, [R1, R2], { global_name: 'Beta' }),
  member(3, [R2]),
  member(4, [R3]),
]
const input = (over = {}) => ({
  existing: null,
  roles: [role(R1, 'Laurel', 0xd4a017), role(R2, 'Ember'), role(R3, 'Third', 0x112233)],
  members: members(),
  roleIds: [R1, R2],
  now: NOW,
  ...over,
})
const stored = (roleId, over = {}) => ({ roleId, name: `old ${roleId.slice(-1)}`, color: null, blurb: `blurb ${roleId.slice(-1)}`, holders: [], ...over })

describe('colorHex', () => {
  it.each([[0xd4a017, '#d4a017'], [1, '#000001'], [0xffffff, '#ffffff']])('writes %i as %s', (n, hex) => {
    expect(colorHex(n)).toBe(hex)
  })
  it.each([0, -1, 0x1000000, 1.5, '5', NaN, null, undefined])('has no colour for %j', (v) => {
    expect(colorHex(v)).toBeNull()
  })
})

describe('buildSnapshot, first run', () => {
  it('lists the requested roles oldest first, with each one’s current holders by id and the names the guild shows', () => {
    const { legacy, report } = buildSnapshot(input({ roleIds: [R2, R1] }))
    expect(legacy).toEqual({
      snapshot: '2026-10-16T12:00:00.000Z',
      accolades: [
        { roleId: R1, name: 'Laurel', color: '#d4a017', blurb: '', holders: [{ id: U(1), name: 'Alpha' }, { id: U(2), name: 'Beta' }] },
        { roleId: R2, name: 'Ember', color: null, blurb: '', holders: [{ id: U(2), name: 'Beta' }, { id: U(3), name: 'user3' }] },
      ],
    })
    expect(report).toEqual({ missingRoles: [], unknownRoles: [], keptAbsent: { [R1]: 0, [R2]: 0 }, nameless: [] })
  })

  it('leaves out everyone who holds only other roles, and members the guild sent without roles', () => {
    const { legacy } = buildSnapshot(input({ roleIds: [R1], members: [...members(), { user: { id: U(9), username: 'x' } }] }))
    expect(legacy.accolades[0].holders.map((h) => h.id)).toEqual([U(1), U(2)])
  })

  it('asks for each role once however often it is listed', () => {
    expect(buildSnapshot(input({ roleIds: [R1, R1] })).legacy.accolades).toHaveLength(1)
  })

  it('names a member the guild shows no name for by their id, keeps them, and reports only the id', () => {
    const ghost = member(5, [R1], { nick: '\u200b', username: '\u200b' })
    const { legacy, report } = buildSnapshot(input({ roleIds: [R1], members: [ghost, member(6, [R1, R2], { nick: '\u200b', username: '\u200b' })] }))
    expect(legacy.accolades[0].holders).toEqual([{ id: U(5), name: U(5) }, { id: U(6), name: U(6) }])
    expect(report.nameless).toEqual([U(5), U(6)])
    const both = buildSnapshot(input({ roleIds: [R1, R2], members: [member(6, [R1, R2], { nick: '\u200b', username: '\u200b' })] }))
    expect(both.report.nameless).toEqual([U(6)])
  })

  it.each([undefined, null, 5, ['x'], {}, '123', '8'.repeat(21), 'x810000000000000001'].map((v) => [v]))('refuses role id %j', (bad) => {
    expect(() => buildSnapshot(input({ roleIds: [R1, bad] }))).toThrow(TypeError)
  })
  it.each([undefined, null, R1, {}].map((v) => [v]))('refuses a role id list that is %j, not a list', (roleIds) => {
    expect(() => buildSnapshot(input({ roleIds }))).toThrow(TypeError)
  })

  it('never mutates what it is given', () => {
    const i = input({ existing: { snapshot: '2026-01-01T00:00:00.000Z', accolades: [stored(R1, { holders: [{ id: U(9), name: 'Gone' }] })] } })
    expect(() => buildSnapshot(deepFreeze(i))).not.toThrow()
  })
})

describe('buildSnapshot, runs after the first', () => {
  const first = () => buildSnapshot(input()).legacy

  it('is idempotent', () => {
    expect(buildSnapshot(input({ existing: first() })).legacy).toEqual(first())
  })

  it('a later identical pull changes only the date', () => {
    const again = buildSnapshot(input({ existing: first(), now: LATER })).legacy
    expect(again).toEqual({ ...first(), snapshot: '2026-11-01T08:00:00.000Z' })
  })

  it('keeps blurbs and the stored order, refreshes name and colour, and appends new roles oldest first', () => {
    const existing = { snapshot: '2026-01-01T00:00:00.000Z', accolades: [stored(R2), stored(R1)] }
    const { legacy } = buildSnapshot(input({ existing, roleIds: [R3, R1, R2] }))
    expect(legacy.accolades.map((a) => [a.roleId, a.name, a.color, a.blurb])).toEqual([
      [R2, 'Ember', null, 'blurb 2'],
      [R1, 'Laurel', '#d4a017', 'blurb 1'],
      [R3, 'Third', '#112233', ''],
    ])
  })

  it('keeps stored accolades it was not asked about', () => {
    const existing = { snapshot: '2026-01-01T00:00:00.000Z', accolades: [stored(R3, { holders: [{ id: U(7), name: 'Kept' }] })] }
    const { legacy } = buildSnapshot(input({ existing, roleIds: [R1] }))
    expect(legacy.accolades.map((a) => a.roleId)).toEqual([R3, R1])
    expect(legacy.accolades[0]).toEqual(existing.accolades[0])
  })

  it('keeps a holder the new pull no longer shows, and reports how many', () => {
    const existing = { snapshot: '2026-01-01T00:00:00.000Z', accolades: [stored(R1, { holders: [{ id: U(9), name: 'Gone' }, { id: U(1), name: 'Old Alpha' }] })] }
    const { legacy, report } = buildSnapshot(input({ existing, roleIds: [R1] }))
    expect(legacy.accolades[0].holders).toEqual([{ id: U(1), name: 'Alpha' }, { id: U(2), name: 'Beta' }, { id: U(9), name: 'Gone' }])
    expect(report.keptAbsent).toEqual({ [R1]: 1 })
  })

  it('--prune drops them', () => {
    const existing = { snapshot: '2026-01-01T00:00:00.000Z', accolades: [stored(R1, { holders: [{ id: U(9), name: 'Gone' }] })] }
    const { legacy, report } = buildSnapshot(input({ existing, roleIds: [R1], prune: true }))
    expect(legacy.accolades[0].holders.map((h) => h.id)).toEqual([U(1), U(2)])
    expect(report.keptAbsent).toEqual({ [R1]: 0 })
  })

  it.each([false, true])('a role already gone from the guild keeps its stored entry and date (prune=%s)', (prune) => {
    const existing = { snapshot: '2026-01-01T00:00:00.000Z', accolades: [stored(R1, { holders: [{ id: U(9), name: 'Gone' }] })] }
    const { legacy, report } = buildSnapshot(input({ existing, roles: [], roleIds: [R1], prune, now: LATER }))
    expect(legacy).toEqual(existing)
    expect(report).toEqual({ missingRoles: [R1], unknownRoles: [], keptAbsent: {}, nameless: [] })
  })

  it('a requested role that is gone and was never stored is reported and not invented', () => {
    const { legacy, report } = buildSnapshot(input({ roles: [role(R1, 'Laurel')], roleIds: [R1, R3] }))
    expect(legacy.accolades.map((a) => a.roleId)).toEqual([R1])
    expect(report.missingRoles).toEqual([R3])
    expect(report.unknownRoles).toEqual([R3])
  })

  it('a first run that finds nothing is dated now, and has no accolades', () => {
    const { legacy } = buildSnapshot(input({ roles: [], roleIds: [R1] }))
    expect(legacy).toEqual({ snapshot: '2026-10-16T12:00:00.000Z', accolades: [] })
  })

  it('never loses a recorded holder, nor misses a current one (property)', () => {
    const pool = [1, 2, 3, 4, 5, 6, 7, 8]
    fc.assert(
      fc.property(fc.subarray(pool), fc.subarray(pool), (recorded, current) => {
        const existing = { snapshot: '2026-01-01T00:00:00.000Z', accolades: [stored(R1, { holders: recorded.map((n) => ({ id: U(n), name: `old${n}` })) })] }
        const ms = current.map((n) => member(n, [R1], { nick: `new${n}` }))
        const ids = (prune) => buildSnapshot(input({ existing, members: ms, roleIds: [R1], prune })).legacy.accolades[0].holders.map((h) => h.id)
        expect(ids(false)).toEqual([...new Set([...recorded, ...current])].sort().map(U))
        expect(ids(true)).toEqual([...current].sort().map(U))
      }),
    )
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `node_modules/.bin/vitest run scripts/lib/legacy-snapshot.test.mjs`
Expected: FAIL, cannot resolve `./legacy-snapshot.mjs`.

- [ ] **Step 3: Implement the pure core**

Create `scripts/lib/legacy-snapshot.mjs`:

```js
/**
 * Pure core of scripts/snapshot-legacy-accolades.mjs: Discord's roles and members in, the
 * legacy-accolades payload out. No I/O, so the permanence rules can be tested: holders only
 * accumulate (unless pruned), blurbs and order survive, and a role that has already left the
 * guild keeps whatever was stored for it. Reports carry ids and counts, never names.
 */
import { nameOf } from '../../server/src/displayNames.js'

const SNOWFLAKE = /^\d{17,20}$/
const compareIds = (a, b) => {
  const x = BigInt(a)
  const y = BigInt(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/** Discord's integer role colour as "#rrggbb"; 0 means "no colour" and, like anything out of range, is null. */
export function colorHex(int) {
  return Number.isInteger(int) && int > 0 && int <= 0xffffff ? `#${int.toString(16).padStart(6, '0')}` : null
}

/**
 * @param existing the payload already on disk, or null
 * @param roles    GET /guilds/{id}/roles
 * @param members  every guild member (GET /guilds/{id}/members, all pages)
 * @param roleIds  the retired roles to capture
 * @param prune    drop recorded holders the new pull does not show (default: keep them)
 */
export function buildSnapshot({ existing = null, roles, members, roleIds, now, prune = false }) {
  if (!Array.isArray(roleIds) || !roleIds.every((id) => typeof id === 'string' && SNOWFLAKE.test(id))) {
    throw new TypeError('roleIds must be an array of snowflake strings')
  }
  const wanted = [...new Set(roleIds)]
  const live = new Map(roles.map((r) => [r.id, r]))
  // Insertion order is output order: stored accolades keep their place, new ones are appended.
  const entries = new Map((existing?.accolades ?? []).map((a) => [a.roleId, a]))
  const report = { missingRoles: [], unknownRoles: [], keptAbsent: {}, nameless: [] }
  const nameless = new Set()
  let pulled = false

  for (const id of wanted.sort(compareIds)) {
    const role = live.get(id)
    const kept = entries.get(id)
    if (!role) {
      report.missingRoles.push(id)
      if (!kept) report.unknownRoles.push(id)
      continue
    }
    pulled = true
    const holders = new Map((prune ? [] : kept?.holders ?? []).map((h) => [h.id, h]))
    const current = new Set()
    for (const m of members) {
      if (!(m.roles ?? []).includes(id)) continue
      const name = nameOf(m)
      if (name === null) nameless.add(m.user.id)
      current.add(m.user.id)
      // A member with no usable name keeps their place, named by id; the owner can fix it by hand.
      holders.set(m.user.id, { id: m.user.id, name: name ?? m.user.id })
    }
    report.keptAbsent[id] = [...holders.keys()].filter((h) => !current.has(h)).length
    entries.set(id, {
      roleId: id,
      name: role.name,
      color: colorHex(role.color),
      blurb: kept?.blurb ?? '',
      holders: [...holders.values()].sort((a, b) => compareIds(a.id, b.id)),
    })
  }

  report.nameless = [...nameless]
  // The date only moves when something was actually pulled: a later run against deleted roles cannot re-date the data.
  const snapshot = pulled || !existing ? now.toISOString() : existing.snapshot
  return { legacy: { snapshot, accolades: [...entries.values()] }, report }
}
```

- [ ] **Step 4: Run to see the tests pass**

Run: `node_modules/.bin/vitest run scripts/lib/legacy-snapshot.test.mjs`
Expected: PASS.

- [ ] **Step 5: Gate it, and check coverage and mutation**

In `vitest.config.js` replace `  'src/lib/archive/legacy.js',` with:

```js
  'src/lib/archive/legacy.js',
  'scripts/lib/legacy-snapshot.mjs',
```

In `stryker.config.mjs` replace `    'src/lib/archive/legacy.js',` with:

```js
    'src/lib/archive/legacy.js',
    'scripts/lib/legacy-snapshot.mjs',
```

Run: `node_modules/.bin/vitest run --coverage scripts/lib/legacy-snapshot.test.mjs`
Expected: the `legacy-snapshot.mjs` row is 100 across the board (ignore other files' threshold errors).

Run: `node_modules/.bin/stryker run --mutate scripts/lib/legacy-snapshot.mjs`
Expected: 100%. Add tests for survivors.

- [ ] **Step 6: Write the CLI glue**

Create `scripts/snapshot-legacy-accolades.mjs`:

```js
/**
 * Snapshot the retired accolade roles and their holders into archive-export/legacy-accolades.json,
 * the gitignored input of the Legacy Accolades page (see
 * docs/superpowers/specs/2026-10-16-legacy-accolades-design.md). Read-only against Discord.
 *
 *   DISCORD_BOT_TOKEN=... bun run legacy:snapshot -- --roles <id>,<id>,... [--prune] [--out <file>]
 *
 * Merges into the file if it exists: blurbs and order are kept, holders only accumulate (--prune
 * drops anyone the new pull does not show), and a role already deleted in Discord keeps its stored
 * entry. A new role gets an empty blurb, which the seal audit rejects until it is written.
 * Needs the bot's GUILD_MEMBERS intent, like scripts/fetch-discord-members.mjs.
 * Prints ids and counts only; the file itself holds names and must never be committed.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { GUILD_ID } from '../src/lib/archive/registry.js'
import { auditLegacy, canonicalLegacy } from '../src/lib/archive/legacy.js'
import { createDiscord } from './lib/discord.mjs'
import { buildSnapshot } from './lib/legacy-snapshot.mjs'

const { values } = parseArgs({
  options: {
    roles: { type: 'string' },
    out: { type: 'string', default: 'archive-export/legacy-accolades.json' },
    prune: { type: 'boolean', default: false },
  },
})
const token = process.env.DISCORD_BOT_TOKEN
if (!token) {
  console.error('DISCORD_BOT_TOKEN not set.')
  process.exit(1)
}
if (!values.roles) {
  console.error('usage: legacy:snapshot -- --roles <id>,<id>,... [--prune] [--out <file>]')
  process.exit(2)
}

async function run() {
  const existing = await readFile(values.out, 'utf8').then(JSON.parse, (e) => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  const discord = createDiscord({ token, log: console.log })
  const roles = await discord.fetchRoles(GUILD_ID)
  const members = await discord.fetchAllMembers(GUILD_ID)
  const { legacy, report } = buildSnapshot({
    existing, roles, members, roleIds: values.roles.split(',').map((s) => s.trim()), now: new Date(), prune: values.prune,
  })

  // 0o600: the file holds member names. The mode only applies when the file is created.
  await writeFile(values.out, canonicalLegacy(legacy), { mode: 0o600 })

  console.log(`\npulled ${roles.length} roles and ${members.length} members; wrote ${legacy.accolades.length} accolades to ${values.out}`)
  for (const a of legacy.accolades) console.log(`  ${a.roleId}: ${a.holders.length} holders${a.blurb ? '' : ', blurb missing'}`)
  for (const [id, n] of Object.entries(report.keptAbsent)) if (n) console.log(`  ${id}: ${n} recorded holders are no longer shown (kept; --prune drops them)`)
  if (report.missingRoles.length) console.log(`  roles no longer in the guild (stored entry kept): ${report.missingRoles.join(', ')}`)
  if (report.nameless.length) console.log(`  members with no usable display name, named by id: ${report.nameless.join(', ')}`)
  const problems = auditLegacy(legacy)
  if (problems.length) console.log(`\nnot ready to seal yet (${problems.length}):\n${problems.map((p) => `  ${p}`).join('\n')}`)
  if (report.unknownRoles.length) {
    console.error(`\nrequested roles that are not in the guild and were never recorded: ${report.unknownRoles.join(', ')}`)
    process.exitCode = 1
  }
}

run().catch((err) => {
  console.error(`\nSnapshot failed: ${err.message}`)
  process.exit(1)
})
```

In `package.json` add after the `"discord:members"` line:

```json
    "legacy:snapshot": "node scripts/snapshot-legacy-accolades.mjs",
```

- [ ] **Step 7: Smoke the glue (no token, no network)**

Run: `env -u DISCORD_BOT_TOKEN node scripts/snapshot-legacy-accolades.mjs --roles 810000000000000001; echo "exit=$?"`
Expected: `DISCORD_BOT_TOKEN not set.`, `exit=1`.

Run: `DISCORD_BOT_TOKEN=x node scripts/snapshot-legacy-accolades.mjs; echo "exit=$?"`
Expected: the `usage:` line, `exit=2`.

(The module graph loading under plain node is part of this check: `legacy-snapshot.mjs` imports the server's `displayNames.js`.)

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/legacy-snapshot.mjs scripts/lib/legacy-snapshot.test.mjs scripts/snapshot-legacy-accolades.mjs vitest.config.js stryker.config.mjs package.json
git commit -m "feat(archive): snapshot the retired accolade roles and their holders" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Leak defence

**Files:**
- Modify: `scripts/scan-dist.mjs`, `scripts/archive-leak-guard.test.mjs`
- Test: `scripts/scan-dist.test.mjs`

**Interfaces:**
- Consumes: `LEGACY_FILE` (Task 1), the fixture's synthetic legacy file (Task 3).
- Produces: `sentinelsFrom(exportDir, { publicText })` also returns, from `<exportDir>/legacy-accolades.json`: every blurb, role names and holder names of at least six characters, and every holder id; it throws if the file exists but cannot be read.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('scanDir', ...)` in `scripts/scan-dist.test.mjs` (the existing imports already cover `mkdtemp`, `writeFile`, `mkdir`, `tmpdir`, `join`, `writeFixture`; add `unlink` to the `node:fs/promises` import):

```js
  describe('legacy accolades', () => {
    const fresh = async () => {
      const exp = await mkdtemp(join(tmpdir(), 'exp-'))
      await writeFixture(exp)
      return exp
    }
    it('sentinelsFrom samples blurbs, role names, holder ids and long-enough holder names', async () => {
      const s = await sentinelsFrom(await fresh())
      expect(s).toEqual(expect.arrayContaining(['Fixture Laurel', 'Alpha Holder', '820000000000000001', 'Fixture blurb two.']))
    })
    it('leaves out a holder name too short to be told from minified code, but still samples that holder’s id', async () => {
      const s = await sentinelsFrom(await fresh())
      expect(s).not.toContain('Ed')
      expect(s).toContain('820000000000000003')
    })
    it('a holder name or id in a built bundle is a finding', async () => {
      const sentinels = await sentinelsFrom(await fresh())
      await writeFile(join(d, 'assets', 'index.js'), 'x="Alpha Holder"')
      await writeFile(join(d, 'assets', 'other.js'), 'y=820000000000000002')
      expect(await scanDir(d, { sentinels })).toHaveLength(2)
    })
    it('an export with no legacy file samples exactly what it did before', async () => {
      const exp = await fresh()
      await unlink(join(exp, 'legacy-accolades.json'))
      const s = await sentinelsFrom(exp)
      expect(s).not.toContain('Alpha Holder')
      expect(s).toContain('Fixture ToC')
    })
    it('a legacy file that cannot be read is an error, not a silent skip', async () => {
      const exp = await fresh()
      await unlink(join(exp, 'legacy-accolades.json'))
      await mkdir(join(exp, 'legacy-accolades.json'))
      await expect(sentinelsFrom(exp)).rejects.toThrow()
    })
  })
```

In `scripts/archive-leak-guard.test.mjs`, add `'archive-export/legacy-accolades.json',` after `'archive-export/.env',` in the `blocks %s` list.

- [ ] **Step 2: Run to see them fail**

Run: `node_modules/.bin/vitest run scripts/scan-dist.test.mjs scripts/archive-leak-guard.test.mjs`
Expected: the new `scan-dist` tests FAIL (no legacy sentinels). The leak-guard addition passes at once: it pins behaviour the existing path rule already gives.

- [ ] **Step 3: Implement**

In `scripts/scan-dist.mjs` add to the imports:

```js
import { LEGACY_FILE } from '../src/lib/archive/legacy.js'
```

Add above `sentinelsFrom`:

```js
async function readLegacy(exportDir) {
  try {
    return JSON.parse(await readFile(join(exportDir, LEGACY_FILE), 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}
```

In `sentinelsFrom`, directly before `  out.delete(GUILD_ID)` add:

```js
  for (const a of (await readLegacy(exportDir))?.accolades ?? []) {
    out.add(a.blurb)
    // A name shorter than six characters would match ordinary minified code; the holder's id stands in for it.
    if (a.name.length >= 6) out.add(a.name)
    for (const h of a.holders) {
      out.add(h.id)
      if (h.name.length >= 6) out.add(h.name)
    }
  }
```

- [ ] **Step 4: Run to see them pass**

Run: `node_modules/.bin/vitest run scripts/scan-dist.test.mjs scripts/archive-leak-guard.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/scan-dist.mjs scripts/scan-dist.test.mjs scripts/archive-leak-guard.test.mjs
git commit -m "feat(archive): the build scan knows the legacy accolades" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The page, the route, the nav link

**Files:**
- Create: `src/views/LegacyAccolades.vue`, `src/views/LegacyAccolades.test.js`
- Modify: `src/router.js`, `src/lib/useNavLinks.js`, `src/router.test.js`, `src/lib/useNavLinks.test.js`

**Interfaces:**
- Consumes: `legacyView` (Task 1), `archive.archive.legacy` (Task 2), `makeLegacy`/`makeIndex` (Task 2), `ArchiveGate`, `ArchivePlaque`, `RosterMember` (existing).
- Produces: route `legacy-accolades` at `/accolades/legacy` (`meta: { title: 'Legacy Accolades', ashOver: true }`); a members-only nav entry `{ to: '/accolades/legacy', label: 'Legacy Accolades', section: true }` between Accolades and Ranks. Page hooks for tests and e2e: `.leg` (article), `.leg-name`, `.leg-blurb`, `.leg-count`, `.leg-holders`, `.rs-name` (from the chips).

- [ ] **Step 1: Write the failing tests**

Create `src/views/LegacyAccolades.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import LegacyAccolades from './LegacyAccolades.vue'
import { useArchive } from '../stores/archive'
import { useAuth } from '../stores/auth'
import { makeIndex, makeLegacy } from '../lib/archive/testIndex'

// Only Discord's full-page redirect is stubbed; the real signIn runs.
vi.mock('../lib/discordAuth', async (orig) => ({ ...(await orig()), beginSignIn: vi.fn() }))

beforeEach(() => {
  setActivePinia(createPinia())
  sessionStorage.clear()
})

// legacy: the payload to seal into the index, or null for a bundle that predates the page.
async function mountPage({ signedIn = true, ready = true, legacy = makeLegacy() } = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/accolades/legacy', component: LegacyAccolades },
      { path: '/accolades', component: { render: () => null } },
    ],
  })
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuth().member = signedIn ? { id: '1', username: 'u', isMember: true } : null
  if (ready) {
    const index = makeIndex()
    if (legacy === null) delete index.legacy
    else index.legacy = legacy
    await useArchive().load('t', { loadArchive: async () => ({ keys: {}, index }) })
  }
  await router.push('/accolades/legacy')
  await router.isReady()
  const w = mount(LegacyAccolades, { global: { plugins: [router, pinia] } })
  await flushPromises()
  return w
}

describe('LegacyAccolades', () => {
  it('lists the accolades in file order, with their holder counts and the snapshot date', async () => {
    const w = await mountPage()
    expect(w.findAll('.leg-name').map((n) => n.text())).toEqual(['Fixture Laurel', 'Fixture Ember', 'Fixture Ash'])
    expect(w.findAll('.leg-count').map((n) => n.text())).toEqual(['2 holders', '2 holders', 'No holders on record'])
    expect(w.text()).toContain('2026-10-16')
  })

  it('shows holders alphabetically, ignoring case', async () => {
    const w = await mountPage()
    const first = w.findAll('.leg-accolade')[0]
    expect(first.findAll('.rs-name').map((n) => n.text())).toEqual(['Alpha Holder', 'beta holder'])
  })

  it('shows a member who held two accolades under both', async () => {
    const w = await mountPage()
    expect(w.findAll('.rs-name').filter((n) => n.text() === 'Alpha Holder')).toHaveLength(2)
  })

  it('breaks a blurb into paragraphs, and shows no list for a role nobody held', async () => {
    const w = await mountPage()
    const third = w.findAll('.leg-accolade')[2]
    expect(third.findAll('.leg-blurb').map((p) => p.text())).toEqual(['Fixture blurb three.', 'Second paragraph.'])
    expect(third.find('.leg-holders').exists()).toBe(false)
  })

  it('tints a heading with its role colour only when that colour reads on the dark plaque', async () => {
    const w = await mountPage()
    const [laurel, ember, ash] = w.findAll('.leg-name')
    expect(laurel.element.style.color).toBe('rgb(212, 160, 23)')
    expect(ember.attributes('style')).toBeUndefined() // no colour
    expect(ash.attributes('style')).toBeUndefined() // #202020 would vanish
  })

  it('renders hostile names and blurbs as inert text', async () => {
    const legacy = makeLegacy()
    legacy.accolades[0].holders[0].name = '<img src=x onerror=alert(1)>'
    legacy.accolades[0].blurb = '<script>alert(1)</script>'
    const w = await mountPage({ legacy })
    expect(w.findAll('script, img, [onerror]')).toHaveLength(0)
    expect(w.text()).toContain('<img src=x onerror=alert(1)>')
    expect(w.text()).toContain('<script>alert(1)</script>')
  })

  it('links back to Accolades, and nowhere near Discord', async () => {
    const w = await mountPage()
    const hrefs = w.findAll('a').map((a) => a.attributes('href'))
    expect(hrefs).toContain('/accolades')
    for (const h of hrefs) expect(h).not.toMatch(/discord(app)?\.com|discord\.gg/i)
  })

  it('says so, and offers the way back, for a bundle sealed before the page existed', async () => {
    const w = await mountPage({ legacy: null })
    expect(w.text()).toContain("haven't been sealed into the archive yet")
    expect(w.find('a[href="/accolades"]').exists()).toBe(true)
    expect(w.find('.leg').exists()).toBe(false)
  })

  it('shows a signed-out visitor the sign-in prompt and none of the content', async () => {
    const w = await mountPage({ signedIn: false, ready: false })
    expect(w.text()).toContain('Sign in with Discord')
    expect(w.text()).not.toContain('Alpha Holder')
    expect(w.text()).not.toContain('Fixture Laurel')
  })
})
```

In `src/router.test.js` append:

```js
describe('the Legacy Accolades route', () => {
  it('is its own page, and the thread route still takes thread ids', () => {
    expect(router.resolve('/accolades/legacy').name).toBe('legacy-accolades')
    expect(router.resolve('/accolades/legacy').meta).toMatchObject({ title: 'Legacy Accolades', ashOver: true })
    expect(router.resolve('/accolades').name).toBe('accolades')
    expect(router.resolve('/accolades/200000000000000001').name).toBe('accolades')
  })
})
```

In `src/lib/useNavLinks.test.js` change the member expectation on line 25 to
`['Home', 'Perk Builder', 'Armoury', 'Builds', 'Companies', 'Accolades', 'Legacy Accolades', 'Ranks', 'Reports']`, and add inside the `describe`:

```js
  it('puts Legacy Accolades right after Accolades for a member, and never shows it to anyone else', () => {
    state.auth.member = { isMember: true }
    const links = useNavLinks()
    expect(links.value.find((l) => l.label === 'Legacy Accolades')).toEqual({ to: '/accolades/legacy', label: 'Legacy Accolades', section: true })
    expect(labels(links).indexOf('Legacy Accolades')).toBe(labels(links).indexOf('Accolades') + 1)
    for (const member of [null, { isMember: false }]) {
      state.auth.member = member
      expect(labels(useNavLinks())).not.toContain('Legacy Accolades')
    }
  })
```

- [ ] **Step 2: Run to see them fail**

Run: `node_modules/.bin/vitest run src/views/LegacyAccolades.test.js src/router.test.js src/lib/useNavLinks.test.js`
Expected: FAIL (component missing; route not found; nav list lacks the link).

- [ ] **Step 3: Implement the page**

Create `src/views/LegacyAccolades.vue`:

```vue
<script setup>
import { computed } from 'vue'
import { useArchive } from '../stores/archive'
import { legacyView } from '../lib/archive/legacy'
import ArchiveGate from '../components/archive/ArchiveGate.vue'
import ArchivePlaque from '../components/archive/ArchivePlaque.vue'
import RosterMember from '../components/roster/RosterMember.vue'

// The gate renders this only once the archive is unsealed. `legacy` is null for a bundle sealed before
// this page existed; sign-out resets the store, hence the optional chain.
const archive = useArchive()
const view = computed(() => (archive.archive?.legacy ? legacyView(archive.archive.legacy) : null))
</script>

<template>
  <ArchiveGate>
    <ArchivePlaque v-if="view">
      <article class="leg">
        <header>
          <p class="leg-eyebrow"><RouterLink to="/accolades" class="leg-back">Accolades</RouterLink></p>
          <h1 class="leg-title">Legacy Accolades</h1>
          <p class="leg-note">Roles retired from the Discord server. Holders as recorded on {{ view.snapshotDate }}.</p>
          <div class="leg-rule" aria-hidden="true" />
        </header>
        <section v-for="a in view.accolades" :key="a.roleId" class="leg-accolade" :aria-labelledby="`leg-${a.roleId}`">
          <h2 :id="`leg-${a.roleId}`" class="leg-name" :style="a.color ? { color: a.color } : undefined">{{ a.name }}</h2>
          <p v-for="(p, i) in a.paragraphs" :key="i" class="leg-blurb">{{ p }}</p>
          <p class="leg-count">{{ a.countLabel }}</p>
          <ul v-if="a.holders.length" class="leg-holders">
            <RosterMember v-for="h in a.holders" :key="h.id" :member="h" :image-ready="false" />
          </ul>
        </section>
      </article>
    </ArchivePlaque>
    <ArchivePlaque v-else narrow>
      <div class="leg-missing">
        <p class="leg-eyebrow">Legion Archive</p>
        <p>The Legacy Accolades haven't been sealed into the archive yet.</p>
        <RouterLink to="/accolades" class="leg-missing-link">Back to the Accolades</RouterLink>
      </div>
    </ArchivePlaque>
  </ArchiveGate>
</template>

<!-- ArchiveThread's heading styles are scoped to that component, so the few the page shares are repeated here
     rather than lifting them out of the fidelity-critical thread view. -->
<style scoped>
.leg { color: #d9ded8; line-height: 1.6; }
.leg-eyebrow { font-family: var(--font-mono); font-size: 0.7rem; letter-spacing: 0.28em; text-transform: uppercase; color: var(--color-smoke); margin: 0 0 0.9rem; }
.leg-missing .leg-eyebrow { color: var(--color-averland); }
.leg-back { color: var(--color-smoke); transition: color 0.2s; }
.leg-back::before { content: '\2190\00a0\00a0'; }
.leg-back:hover { color: var(--color-averland); }
.leg-title {
  font-family: var(--font-display); font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; line-height: 1.05;
  font-size: clamp(1.8rem, 4.5vw, 2.7rem); margin: 0; color: var(--color-averland);
  text-shadow: 0 -1px 0 rgba(0, 0, 0, 0.95), 0 1px 0 rgba(255, 225, 170, 0.1), 0 0 14px rgba(253, 184, 37, 0.14);
}
.leg-note { font-family: var(--font-mono); font-size: 0.74rem; color: var(--color-smoke); margin: 0.9rem 0 0; }
.leg-rule {
  height: 2px; margin: 1.6rem 0 0.4rem;
  background: linear-gradient(90deg, transparent, #7a4c12 12%, var(--color-averland) 50%, #7a4c12 88%, transparent);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.9);
}
.leg-accolade { position: relative; padding: 1.6rem 0; }
.leg-accolade + .leg-accolade::before {
  content: ''; position: absolute; top: 0; left: 15%; right: 15%; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(253, 184, 37, 0.25), transparent);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.8);
}
.leg-name { font-family: var(--font-display); font-weight: 700; font-size: 1.3rem; text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 0.5rem; color: var(--color-bone); }
.leg-blurb { margin: 0.4rem 0; white-space: pre-line; }
.leg-count { font-family: var(--font-mono); font-size: 0.7rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-smoke); margin: 0.9rem 0 0.5rem; }
.leg-holders { display: flex; flex-wrap: wrap; gap: 0.38rem; margin: 0; padding: 0; list-style: none; }
.leg-missing { text-align: center; color: #c9cfc9; }
.leg-missing-link { display: inline-block; margin-top: 0.9rem; color: var(--color-bone); text-decoration: underline; text-decoration-color: rgba(89, 214, 108, 0.5); text-underline-offset: 3px; }
.leg-missing-link:hover { color: #fff; text-decoration-color: var(--color-drake); }
</style>
```

In `src/router.js`, insert before the `...[ { key: 'accolades', ...` spread:

```js
  {
    path: '/accolades/legacy',
    name: 'legacy-accolades',
    component: () => import('./views/LegacyAccolades.vue'),
    meta: { title: 'Legacy Accolades', ashOver: true },
  },
```

In `src/lib/useNavLinks.js`, after the `Accolades` entry add:

```js
          { to: '/accolades/legacy', label: 'Legacy Accolades', section: true },
```

- [ ] **Step 4: Run to see them pass, then the whole suite**

Run: `node_modules/.bin/vitest run src/views/LegacyAccolades.test.js src/router.test.js src/lib/useNavLinks.test.js`
Expected: PASS.

Run: `node_modules/.bin/vitest run`
Expected: whole suite passes. (On `/accolades/legacy` both the Accolades and Legacy Accolades nav links show as active, since the router treats the latter as a child of the former; that is intended.)

- [ ] **Step 5: Look at it**

Run `node_modules/.bin/vite build` to confirm the bundle builds, then, if a dev host is available, `node_modules/.bin/bun run archive:dev` to view the page against the fixture bundle. Check: heading tint, chip wrapping at narrow widths, the missing-plaque state. If no browser is available, say so in the report rather than claiming a visual check.

- [ ] **Step 6: Commit**

```bash
git add src/views/LegacyAccolades.vue src/views/LegacyAccolades.test.js src/router.js src/router.test.js src/lib/useNavLinks.js src/lib/useNavLinks.test.js
git commit -m "feat(archive): the Legacy Accolades page" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: End to end

**Files:**
- Modify: `e2e/tests/archive.spec.js`

**Interfaces:**
- Consumes: the e2e archive is sealed from `writeFixture` (Task 3), so it already carries the synthetic legacy payload and a sentinel in its first blurb; page hooks from Task 7. Tokens (`test-member-token`, `test-norole-token`) and `watchResponses` already exist in the spec.

- [ ] **Step 1: Keep the existing nav click unambiguous, then add the specs**

The new nav entry also matches the substring "Accolades", so in the first existing test change
`getByRole('link', { name: 'Accolades' })` to `getByRole('link', { name: 'Accolades', exact: true })`
(Playwright's strict mode would otherwise reject the two-link match). Then append to `e2e/tests/archive.spec.js`:

```js
test('role holder reads the Legacy Accolades page, and no response carries plaintext', async ({ page }) => {
  const leaks = watchResponses(page)
  await signIn(page, 'test-member-token')
  await page.locator('.nav-links').getByRole('link', { name: 'Legacy Accolades' }).click()
  await expect(page).toHaveURL(/\/accolades\/legacy$/)
  const legacy = page.locator('.leg')
  await expect(legacy).toContainText('Fixture Laurel')
  await expect(legacy).toContainText('Alpha Holder')
  await expect(legacy).toContainText(`${SENTINEL}-legacy`)
  await expect(legacy.locator('.leg-count').last()).toHaveText('No holders on record')
  expect(leaks).toEqual([])
})

test('legacy: a signed-in member without the role is refused and sees no holders', async ({ page }) => {
  const leaks = watchResponses(page)
  await signIn(page, 'test-norole-token')
  await page.goto('/accolades/legacy')
  await expect(page.getByRole('alert')).toContainText("doesn't currently hold the role")
  await expect(page.locator('.leg')).toHaveCount(0)
  expect(leaks).toEqual([])
})

test('legacy: signed out sees the prompt and nothing else', async ({ page }) => {
  const leaks = watchResponses(page)
  await page.goto('/accolades/legacy')
  await expect(page.locator('.gate').getByRole('button', { name: 'Sign in with Discord' })).toBeVisible()
  await expect(page.locator('.leg')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('Alpha Holder')
  expect(leaks).toEqual([])
})
```

- [ ] **Step 2: Run the e2e suite**

Run: `node_modules/.bin/bun run test:e2e` (docker; slow). The docker e2e is intermittently flaky on `main` (see the project's e2e notes): re-run a failing test once before treating it as real, and check that a failure is not in a spec this change did not touch. If docker is not available on this host, do not claim these passed; say they were not run.
Expected: the three new specs and the existing archive specs pass.

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/archive.spec.js
git commit -m "test(e2e): the Legacy Accolades page is gated like the rest of the archive" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The merge gate

**Files:** none (verification only).

- [ ] **Step 1: Whole suite, coverage, mutation**

Run each in turn and expect success:

```bash
node_modules/.bin/vitest run
node_modules/.bin/vitest run --coverage
node_modules/.bin/stryker run
```
Expected: all tests pass; every gated file (including `legacy.js` and `legacy-snapshot.mjs`) at 100% coverage; mutation score 100%. The mutation run takes several minutes.

- [ ] **Step 2: Build and scan**

```bash
node_modules/.bin/vite build
node scripts/scan-dist.mjs dist --sentinels-from archive-export
```
Expected: `scan clean: dist (+N local sentinels)`. (`archive-export` here is the owner's real, local export; it has no legacy file yet, so this exercises the unchanged path. The legacy sentinels get their real run in Task 10.)

- [ ] **Step 3: Check nothing real slipped in**

Run: `git diff main --stat`, then grep `git diff main` for each of the eight real role ids in the memory note (`legacy-accolades-state.md`).
Expected: no match (the real ids live only in that note and, later, on a command line). Skim the diff for any real name; every fixture value is invented.

- [ ] **Step 4: Report**

Say what was run and the numbers. If the e2e suite or the visual check could not be run, say so plainly.

---

### Task 10: Go live (with the owner; not for subagents)

This is the time-critical part: the snapshot must be taken **while the Discord roles still exist**, and the owner deletes the roles last. Several steps publish things; stop and get the owner's go-ahead at each marked **STOP**.

**Files:** `archive-export/legacy-accolades.json` (local, gitignored, never committed), `archive.lock.json` (committed).

- [ ] **Step 1: Take the role ids from the project's memory notes**

They are listed in `~/.claude/projects/-home-artellus-Documents-salamanders-site/memory/legacy-accolades-state.md`: the six "Move to website" roles and the two lethal-variant roles. Do not write them into any committed file.

- [ ] **Step 2: Run the snapshot (read-only against Discord)**

```bash
DISCORD_BOT_TOKEN="$(grep '^DISCORD_BOT_TOKEN=' server/.env | cut -d= -f2-)" \
  node scripts/snapshot-legacy-accolades.mjs --roles <the eight ids, comma separated>
```
Expected: `wrote 8 accolades to archive-export/legacy-accolades.json`, a holder count per role, and `blurb missing` on every line. Read the report with the owner: no `requested roles that are not in the guild` line (if one appears, that role id is wrong or already deleted: stop and sort it out before anything else); the third either-or role the owner already removed must not be among the eight.

- [ ] **Step 3: Write the blurbs with the owner**

Draft the six oldest roles' blurbs with the owner, then the two lethal variants, in `archive-export/legacy-accolades.json` (plain text, 1-600 characters, blank line for a paragraph break). Fix any holder name that came out as a bare id. Reorder the accolades if the owner wants a different order (file order is page order).

- [ ] **Step 4: Audit**

Run: `node_modules/.bin/bun scripts/seal-archive.mjs audit`
Expected: the stats line and no problem lines. Keep this output on the terminal.

- [ ] **Step 5: Local sentinel scan**

```bash
node_modules/.bin/vite build && node scripts/scan-dist.mjs dist --sentinels-from archive-export
```
Expected: `scan clean`. This now includes every holder id, long-enough holder name, role name and blurb as sentinels.

- [ ] **Step 6: STOP — ask the owner before publishing**

`seal --publish` creates GitHub Release `archive-v5` (ciphertext only). Confirm, then:

```bash
node_modules/.bin/bun scripts/seal-archive.mjs seal --publish
git add archive.lock.json
git commit -m "archive: publish sealed release archive-v5" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
Expected: `sealed N files, kid …, with legacy accolades, published archive-v5`; the lock diff shows `"legacy": true` and a new release tag, and contains no content.

- [ ] **Step 7: STOP — ask the owner before merging and pushing**

Merge `feat/legacy-accolades` into `main` the way the repo usually does, then push over HTTPS (the owner's preference; the pre-push gate takes about five minutes) and verify the push landed (`git ls-remote origin main` matches `git rev-parse main`). The deploy workflow fetches the release named in the lock.

- [ ] **Step 8: Verify the live page**

Signed in as a Legion member: `/accolades/legacy` shows all eight accolades with blurbs and holders, and the nav shows "Legacy Accolades". Signed out: the sign-in prompt only. Signed in without the role: the restricted notice. In the browser's network tab no response body contains a holder name.

- [ ] **Step 9: Owner deletes the roles in Discord**

Only now. Afterwards, update `legacy-accolades-state.md` in the memory notes: the page is live, which release holds it, and that `archive-export/legacy-accolades.json` plus `ARCHIVE_KEY` are the backup (the sealed release also restores it via `unseal`).
