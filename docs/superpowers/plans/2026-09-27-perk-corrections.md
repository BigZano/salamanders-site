# Perk Corrections & Version History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let forge and leadership roles correct weapon and class perks live on the site, keep a permanent version history (perk edits, build deletions, privilege revocations) visible to those roles, and let the Master of the Forge and Admins revoke elevated privileges.

**Architecture:** Postgres on the existing builds API (`server/`) is the source of truth. A pure module, `server/src/perkCorrectionsCore.js`, applies corrections over the wiki bake. The API uses it to validate and the site imports it directly to render, so both apply corrections identically. The API serves active corrections as one JSON document (`GET /perk-corrections`). The site fetches it on load, falls back to a bundled snapshot (`src/data/perk-corrections.json`), and updates optimistically when an editor saves.

**Tech Stack:** Bun + `pg` (server), Vue 3 + Pinia + vue-router (site), Vitest, Playwright (e2e via `e2e/docker-compose.yml`).

**Spec:** `docs/superpowers/specs/2026-09-27-perk-corrections-design.md`

## Global Constraints

- Guild `1322056087792521269`. Role ids: Techmarine `1322056087859499042`, Mechadendrite Expert `1362522277677240521`, Master of the Forge `1322056087867883565`, Legion Hierarchy `1322056087880597522`. Administrator = Discord permission bit or guild owner (existing `roles.isAdmin`).
- Edit perks + view history: all five. Delete others' builds: Admin, Forge, Mechadendrite, Techmarine (not Hierarchy). Revoke/reinstate: Admin → anyone except Admins; Forge → holders of Techmarine or Mechadendrite who hold neither Forge nor Hierarchy. Hierarchy, Mechadendrite, Techmarine revoke no one. Nobody revokes themselves.
- Revoked = normal member: no edit, no history, no deleting others' builds; own builds and reports unaffected.
- Nothing is ever purged. Every change writes one `edit_events` row in the same transaction.
- Limits: target and perk name ≤ 80, description ≤ 500, note/reason ≤ 200. Plain text only, never `v-html`.
- Class perks: `edit` only. Weapon perks: `add|remove|edit` per quality in `Standard, Master-Crafted, Artificer, Relic, Heroic`.
- `remove`/`edit` must name a perk present in that tier after current corrections, otherwise 404.
- Errors: 401 no/invalid token, 403 wrong role or revoked, 400 bad body, 404 unknown target/perk, 409 revoke-when-revoked / reinstate-when-not / revert-when-reverted, 503 Discord or bake unreachable (fail closed).
- Webhook: `REPORTS_WEBHOOK_URL`, fire-and-forget after commit, `allowed_mentions: { parse: [] }`, content included, suffix ` · <site>/history`.
- `GET /perk-corrections` is public, `Cache-Control: public, max-age=30`; the public document carries no author ids.
- Tests on this machine need `NODE_OPTIONS=--no-experimental-webstorage` (Node 26), for `npx vitest` and for the pre-commit hook.

## Review Focus

1. **A correction removes a perk from the middle of a tier.** Expected: perks already chosen in saved builds stay chosen (ids must not shift). Pinned in Task 1 (`key` preserved) and Task 8 (WeaponTree ids use `key`).
2. **An add is reverted while a later edit or remove targets that added perk.** Expected: the page still renders and the orphaned edit is skipped, with no crash. Pinned in Task 1.
3. **The API is down or unreachable.** Expected: pages render with the bundled snapshot and edit controls are hidden. Pinned in Task 7 (`canEdit` false when not live).
4. **A revoked editor still has edit controls on screen and saves.** Expected: the server returns 403 and the page rolls the optimistic change back with the error shown. Pinned in Task 5 (403) and Task 7 (rollback).
5. **A perk name or note contains `@everyone` or a role mention.** Expected: the webhook pings nobody. Pinned in Task 4 (`allowed_mentions`).

---

## File Map

| File | Responsibility |
|---|---|
| `server/src/perkCorrectionsCore.js` (new) | Pure apply/validate helpers, public document shape; shared by server and site |
| `server/src/privileges.js` (new) | Role → privilege policy, revoke authority, live lookup wrapper |
| `server/src/webhook.js` (new) | Fire-and-forget Discord webhook notifier |
| `server/src/bake.js` (new) | Cached loader for the wiki bake (from GitHub raw) |
| `server/src/buildRow.js` (new) | `rowToBuild` shared by index.js and the history store |
| `server/src/historyStore.js` (new) | Postgres: corrections, revocations, events, build soft delete, seed |
| `server/src/perks.js` (new) | HTTP handler: corrections, history, privileges |
| `server/src/buildModeration.js` (new) | HTTP: moderator status + soft delete for builds |
| `server/src/seed.js` (new) | One-off: seed corrections from a document on stdin |
| `server/src/index.js` | Wire the above; list hides deleted builds |
| `server/schema.sql` | New tables + builds columns |
| `src/data/perk-corrections.json` (new; replaces `weapon-perk-overrides.json`) | Bundled snapshot of the API document |
| `src/lib/perksApi.js` (new) | Client for the new routes |
| `src/stores/perkCorrections.js` (new) | Pinia: document, privileges, optimistic submit |
| `src/lib/weapons.js` | Drop the static override layer; add `perkSuggestions` |
| `src/components/PerkEditPanel.vue` (new) | Edit/remove/add form |
| `src/components/WeaponTree.vue`, `src/views/Planner.vue` | Render through corrections; host the edit panel |
| `src/views/History.vue` (new), `src/router.js`, `src/components/AppNav.vue` | Version History tab |
| `scripts/snapshot-perk-corrections.mjs` (new), `.github/workflows/deploy.yml`, `package.json` | Refresh bundled snapshot at deploy |
| `e2e/discord-mock/server.js`, `e2e/docker-compose.yml`, `e2e/tests/perks.spec.js` (new) | E2E |

---

### Task 1: Correction core (pure, shared)

**Files:**
- Create: `server/src/perkCorrectionsCore.js`
- Test: `server/src/perkCorrectionsCore.test.js`

**Interfaces:**
- Produces:
  - `QUALITIES: string[]`, `OPS: string[]`, `LIMITS: {target, perkName, description, note}`
  - `applyWeaponCorrections(tree: {perks:[{name,quality,description,key?}], ...}, corrections: DocEntry[]) → tree` (new object; every perk carries `key`: bake index or `c<id>`; touched perks carry `corrected: {id, createdAt}`)
  - `applyClassCorrections(perks: {[name]: {level, description}}, corrections: DocEntry[]) → same shape` (edited perks carry `corrected`)
  - `hasWeaponPerk(tree, quality, name) → boolean`
  - `toDocument(corrections: Correction[], version?: string) → {version, weapons:{[target]:DocEntry[]}, classes:{[target]:DocEntry[]}}`
  - `flattenDocument(doc) → [{kind, target, quality, op, perkName, description}]`
  - `DocEntry = {id, op, quality|null, perkName, description|null, createdAt}`; `Correction = DocEntry & {kind, target, note, active, author}`

- [ ] **Step 1: Write the failing test**

```js
// server/src/perkCorrectionsCore.test.js
import { describe, it, expect } from 'vitest'
import { applyWeaponCorrections, applyClassCorrections, hasWeaponPerk, toDocument, flattenDocument } from './perkCorrectionsCore'

const tree = {
  budget: 7,
  perks: [
    { name: 'A', quality: 'Standard', description: 'a' },
    { name: 'B', quality: 'Standard', description: 'b' },
    { name: 'C', quality: 'Relic', description: 'c' },
  ],
}
const e = (id, op, quality, perkName, description = null) => ({ id, op, quality, perkName, description, createdAt: `t${id}` })

describe('applyWeaponCorrections', () => {
  it('keys every bake perk by its bake index, even with no corrections', () => {
    expect(applyWeaponCorrections(tree, []).perks.map((p) => p.key)).toEqual([0, 1, 2])
  })

  it('removing a perk leaves the others on their bake keys', () => {
    const out = applyWeaponCorrections(tree, [e(1, 'remove', 'Standard', 'A')])
    expect(out.perks.map((p) => [p.name, p.key])).toEqual([['B', 1], ['C', 2]])
  })

  it('adds, edits and marks what it touched', () => {
    const out = applyWeaponCorrections(tree, [e(1, 'add', 'Relic', 'D', 'd'), e(2, 'edit', 'Standard', 'B', 'b2')])
    expect(out.perks.find((p) => p.name === 'D')).toMatchObject({ quality: 'Relic', description: 'd', key: 'c1', corrected: { id: 1, createdAt: 't1' } })
    expect(out.perks.find((p) => p.name === 'B')).toMatchObject({ description: 'b2', key: 1, corrected: { id: 2 } })
    expect(out.perks.find((p) => p.name === 'A').corrected).toBeUndefined()
    expect(out.budget).toBe(7)
  })

  it('only touches the named quality and one perk per correction', () => {
    const dup = { perks: [...tree.perks, { name: 'C', quality: 'Relic', description: 'c2' }, { name: 'C', quality: 'Standard', description: 'cs' }] }
    const out = applyWeaponCorrections(dup, [e(1, 'remove', 'Relic', 'C')])
    expect(out.perks.filter((p) => p.name === 'C').map((p) => [p.quality, p.description])).toEqual([['Relic', 'c2'], ['Standard', 'cs']])
  })

  it('skips an edit or remove whose perk is gone (e.g. its add was reverted)', () => {
    const out = applyWeaponCorrections(tree, [e(1, 'edit', 'Relic', 'Ghost', 'x'), e(2, 'remove', 'Relic', 'Ghost')])
    expect(out.perks.map((p) => p.name)).toEqual(['A', 'B', 'C'])
  })

  it('never mutates its input', () => {
    const before = JSON.stringify(tree)
    applyWeaponCorrections(tree, [e(1, 'remove', 'Standard', 'A'), e(2, 'edit', 'Standard', 'B', 'z')])
    expect(JSON.stringify(tree)).toBe(before)
  })

  it('hasWeaponPerk sees corrections once applied', () => {
    const out = applyWeaponCorrections(tree, [e(1, 'add', 'Relic', 'D', 'd')])
    expect(hasWeaponPerk(out, 'Relic', 'D')).toBe(true)
    expect(hasWeaponPerk(out, 'Standard', 'D')).toBe(false)
  })
})

describe('applyClassCorrections', () => {
  const perks = { Stim: { level: 2, description: 'old' }, Other: { level: 3, description: 'o' } }
  it('edits text by name and ignores unknown perks and non-edits', () => {
    const out = applyClassCorrections(perks, [e(1, 'edit', null, 'Stim', 'new'), e(2, 'edit', null, 'Nope', 'x'), e(3, 'remove', null, 'Other')])
    expect(out.Stim).toEqual({ level: 2, description: 'new', corrected: { id: 1, createdAt: 't1' } })
    expect(out.Other).toEqual({ level: 3, description: 'o' })
    expect(out.Nope).toBeUndefined()
    expect(perks.Stim.description).toBe('old')
  })
})

describe('toDocument / flattenDocument', () => {
  const rows = [
    { id: 1, kind: 'weapon', target: 'Las Fusil', quality: 'Relic', op: 'remove', perkName: 'X', description: null, note: 'n', active: true, author: { id: '9', username: 'u' }, createdAt: 't1' },
    { id: 2, kind: 'class', target: 'Tactical', quality: null, op: 'edit', perkName: 'Y', description: 'y', note: null, active: true, author: { id: '9', username: 'u' }, createdAt: 't2' },
  ]
  it('groups by kind and target in input order, with no author or note', () => {
    const doc = toDocument(rows, 'v1')
    expect(doc).toEqual({
      version: 'v1',
      weapons: { 'Las Fusil': [{ id: 1, op: 'remove', quality: 'Relic', perkName: 'X', description: null, createdAt: 't1' }] },
      classes: { Tactical: [{ id: 2, op: 'edit', quality: null, perkName: 'Y', description: 'y', createdAt: 't2' }] },
    })
  })
  it('flattens back to seedable corrections', () => {
    expect(flattenDocument(toDocument(rows, 'v1'))).toEqual([
      { kind: 'weapon', target: 'Las Fusil', quality: 'Relic', op: 'remove', perkName: 'X', description: null },
      { kind: 'class', target: 'Tactical', quality: null, op: 'edit', perkName: 'Y', description: 'y' },
    ])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run server/src/perkCorrectionsCore.test.js`
Expected: FAIL, "Failed to resolve import ./perkCorrectionsCore"

- [ ] **Step 3: Write the implementation**

```js
// server/src/perkCorrectionsCore.js
/**
 * Perk corrections: in-game fixes layered over the wiki bake. Pure, no I/O.
 * The API uses it to validate and to build the public document; the site
 * imports this same file (../../server/src/…) to render, so both sides apply
 * corrections identically. See
 * docs/superpowers/specs/2026-09-27-perk-corrections-design.md.
 *
 * Every weapon perk comes back with a stable `key`: its index in the bake,
 * or `c<correction id>` for an added perk. Saved builds reference perks by
 * an id built from that key, so removing a perk mid-tier must not shift the
 * others.
 */
export const QUALITIES = ['Standard', 'Master-Crafted', 'Artificer', 'Relic', 'Heroic']
export const OPS = ['add', 'remove', 'edit']
export const LIMITS = { target: 80, perkName: 80, description: 500, note: 200 }

const mark = (c) => ({ id: c.id, createdAt: c.createdAt })

/** Apply in order. An edit/remove whose perk is gone (its add was reverted) is skipped. */
export function applyWeaponCorrections(tree, corrections = []) {
  const perks = tree.perks.map((p, i) => ({ ...p, key: p.key ?? i }))
  for (const c of corrections) {
    if (c.op === 'add') {
      perks.push({ name: c.perkName, quality: c.quality, description: c.description, key: `c${c.id}`, corrected: mark(c) })
      continue
    }
    const i = perks.findIndex((p) => p.quality === c.quality && p.name === c.perkName)
    if (i < 0) continue
    if (c.op === 'remove') perks.splice(i, 1)
    else if (c.op === 'edit') perks[i] = { ...perks[i], description: c.description, corrected: mark(c) }
  }
  return { ...tree, perks }
}

/** Class perks are a fixed grid keyed by name: only their text changes. */
export function applyClassCorrections(perks, corrections = []) {
  const out = { ...perks }
  for (const c of corrections) {
    if (c.op !== 'edit' || !out[c.perkName]) continue
    out[c.perkName] = { ...out[c.perkName], description: c.description, corrected: mark(c) }
  }
  return out
}

export function hasWeaponPerk(tree, quality, name) {
  return tree.perks.some((p) => p.quality === quality && p.name === name)
}

/**
 * Public document of active corrections, grouped by kind then target. Input
 * must already be in apply order (oldest first). Authors and notes stay out:
 * they're for the history tab, behind the role check.
 */
export function toDocument(corrections, version = new Date().toISOString()) {
  const doc = { version, weapons: {}, classes: {} }
  for (const c of corrections) {
    const bucket = c.kind === 'class' ? doc.classes : doc.weapons
    ;(bucket[c.target] ??= []).push({
      id: c.id,
      op: c.op,
      quality: c.quality ?? null,
      perkName: c.perkName,
      description: c.description ?? null,
      createdAt: c.createdAt,
    })
  }
  return doc
}

/** Document → plain corrections, in document order (for seeding). */
export function flattenDocument(doc) {
  const out = []
  for (const [kind, bucket] of [['weapon', doc.weapons], ['class', doc.classes]]) {
    for (const [target, list] of Object.entries(bucket || {})) {
      for (const c of list) {
        out.push({ kind, target, quality: c.quality ?? null, op: c.op, perkName: c.perkName, description: c.description ?? null })
      }
    }
  }
  return out
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run server/src/perkCorrectionsCore.test.js`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/perkCorrectionsCore.js server/src/perkCorrectionsCore.test.js
git commit -m "feat(perks): pure correction core shared by API and site"
```

---

### Task 2: Privilege policy

**Files:**
- Create: `server/src/privileges.js`
- Test: `server/src/privileges.test.js`

**Interfaces:**
- Consumes: `roles.rolesOf(id) → string[]|null`, `roles.isAdmin(id, held) → boolean` (existing `discordRoles.js`); `store.openRevocation(discordId) → object|null` (Task 3).
- Produces:
  - `ROLE_IDS = {techmarine, mechadendrite, forge, hierarchy}`
  - `privilegesFrom({roles, admin, revoked}, ids?) → {admin, editor, historyViewer, moderator, revoked, revoker: 'admin'|'forge'|null}`
  - `mayRevoke(actor: {id, revoker}, target: {id, roles, admin}|null, ids?) → boolean`
  - `createPrivileges({roles, store, ids?}) → { forUser(user:{id}) → {id, ...privilegesFrom}, target(discordId) → {id, roles, admin}|null }`

- [ ] **Step 1: Write the failing test**

```js
// server/src/privileges.test.js
import { describe, it, expect } from 'vitest'
import { ROLE_IDS as R, privilegesFrom, mayRevoke, createPrivileges } from './privileges'

const p = (roles, admin = false, revoked = false) => privilegesFrom({ roles, admin, revoked })

describe('privilegesFrom', () => {
  it.each([
    ['techmarine', [R.techmarine], { editor: true, historyViewer: true, moderator: true, revoker: null }],
    ['mechadendrite', [R.mechadendrite], { editor: true, historyViewer: true, moderator: true, revoker: null }],
    ['forge', [R.forge], { editor: true, historyViewer: true, moderator: true, revoker: 'forge' }],
    ['hierarchy', [R.hierarchy], { editor: true, historyViewer: true, moderator: false, revoker: null }],
    ['plain member', ['1377787723976409211'], { editor: false, historyViewer: false, moderator: false, revoker: null }],
  ])('%s', (_, roles, want) => {
    expect(p(roles)).toMatchObject(want)
  })

  it('admin by permission alone gets everything', () => {
    expect(p([], true)).toMatchObject({ admin: true, editor: true, historyViewer: true, moderator: true, revoker: 'admin' })
  })

  it('a revocation drops every elevated power', () => {
    expect(p([R.forge, R.techmarine], false, true)).toEqual({
      admin: false, editor: false, historyViewer: false, moderator: false, revoked: true, revoker: null,
    })
  })

  it('an admin cannot be revoked, even with a stray revocation row', () => {
    expect(p([], true, true)).toMatchObject({ editor: true, revoked: false, revoker: 'admin' })
  })
})

describe('mayRevoke', () => {
  const actor = (roles, admin = false, id = '1') => ({ id, ...p(roles, admin) })
  const target = (roles, admin = false, id = '2') => ({ id, roles, admin })

  it('admin may revoke anyone but an admin', () => {
    const a = actor([], true)
    expect(mayRevoke(a, target([R.forge]))).toBe(true)
    expect(mayRevoke(a, target([R.hierarchy]))).toBe(true)
    expect(mayRevoke(a, target([], true))).toBe(false)
  })

  it('forge may revoke techmarines and mechadendrites only', () => {
    const f = actor([R.forge])
    expect(mayRevoke(f, target([R.techmarine]))).toBe(true)
    expect(mayRevoke(f, target([R.mechadendrite]))).toBe(true)
    expect(mayRevoke(f, target([R.hierarchy]))).toBe(false)
    expect(mayRevoke(f, target([R.forge]))).toBe(false)
    expect(mayRevoke(f, target([R.techmarine, R.hierarchy]))).toBe(false)
    expect(mayRevoke(f, target([], true))).toBe(false)
  })

  it('hierarchy, techmarine and mechadendrite revoke no one', () => {
    for (const r of [R.hierarchy, R.techmarine, R.mechadendrite]) expect(mayRevoke(actor([r]), target([R.techmarine]))).toBe(false)
  })

  it('nobody revokes themselves; missing target is refused', () => {
    expect(mayRevoke(actor([], true, '5'), target([R.forge], false, '5'))).toBe(false)
    expect(mayRevoke(actor([], true), null)).toBe(false)
  })
})

describe('createPrivileges', () => {
  const roles = {
    rolesOf: async (id) => ({ '1': [R.techmarine], '2': [] }[id] ?? null),
    isAdmin: async (id) => id === '2',
  }
  const store = { openRevocation: async (id) => (id === '1' ? { id: 7 } : null) }
  const priv = createPrivileges({ roles, store })

  it('looks up roles, admin and revocation live', async () => {
    expect(await priv.forUser({ id: '1' })).toMatchObject({ id: '1', editor: false, revoked: true })
    expect(await priv.forUser({ id: '2' })).toMatchObject({ id: '2', admin: true, editor: true })
    expect(await priv.forUser({ id: '3' })).toMatchObject({ id: '3', editor: false, revoked: false })
  })

  it('target() returns null for someone not in the guild', async () => {
    expect(await priv.target('3')).toBeNull()
    expect(await priv.target('1')).toEqual({ id: '1', roles: [R.techmarine], admin: false })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run server/src/privileges.test.js`
Expected: FAIL, "Failed to resolve import ./privileges"

- [ ] **Step 3: Write the implementation**

```js
// server/src/privileges.js
/**
 * Who may do what above a normal member: edit perks, read the version
 * history, delete other people's builds, revoke those powers. See the roles
 * table in docs/superpowers/specs/2026-09-27-perk-corrections-design.md.
 *
 * Master of the Forge and Legion Hierarchy stand on even footing: neither can
 * revoke the other; only an Administrator can. A revocation turns someone back
 * into a normal member; Administrators cannot be revoked.
 */
export const ROLE_IDS = {
  techmarine: process.env.TECHMARINE_ROLE_ID || '1322056087859499042',
  mechadendrite: process.env.MECHADENDRITE_ROLE_ID || '1362522277677240521',
  forge: process.env.FORGE_ROLE_ID || '1322056087867883565',
  hierarchy: process.env.HIERARCHY_ROLE_ID || '1322056087880597522',
}

export function privilegesFrom({ roles, admin, revoked }, ids = ROLE_IDS) {
  const has = (k) => (roles || []).includes(ids[k])
  const isAdmin = !!admin
  const out = !isAdmin && !!revoked
  const editor = !out && (isAdmin || has('techmarine') || has('mechadendrite') || has('forge') || has('hierarchy'))
  return {
    admin: isAdmin,
    editor,
    historyViewer: editor,
    moderator: !out && (isAdmin || has('techmarine') || has('mechadendrite') || has('forge')),
    revoked: out,
    revoker: out ? null : isAdmin ? 'admin' : has('forge') ? 'forge' : null,
  }
}

export function mayRevoke(actor, target, ids = ROLE_IDS) {
  if (!actor?.revoker || !target || target.admin || actor.id === target.id) return false
  if (actor.revoker === 'admin') return true
  const t = (k) => (target.roles || []).includes(ids[k])
  return (t('techmarine') || t('mechadendrite')) && !t('forge') && !t('hierarchy')
}

/** Live lookups (Discord + open revocation). Throws Upstream like discordRoles.js. */
export function createPrivileges({ roles, store, ids = ROLE_IDS }) {
  return {
    async forUser(user) {
      const held = await roles.rolesOf(user.id)
      if (!held) return { id: user.id, ...privilegesFrom({ roles: [], admin: false, revoked: false }, ids) }
      const admin = await roles.isAdmin(user.id, held)
      const revoked = !!(await store.openRevocation(user.id))
      return { id: user.id, ...privilegesFrom({ roles: held, admin, revoked }, ids) }
    },
    async target(discordId) {
      const held = await roles.rolesOf(discordId)
      if (!held) return null
      return { id: discordId, roles: held, admin: await roles.isAdmin(discordId, held) }
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run server/src/privileges.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/privileges.js server/src/privileges.test.js
git commit -m "feat(perks): privilege policy for editors, moderators and revokers"
```

---

### Task 3: Schema and history store

**Files:**
- Modify: `server/schema.sql` (append)
- Create: `server/src/buildRow.js`, `server/src/historyStore.js`, `server/src/seed.js`
- Modify: `server/src/index.js` (import `rowToBuild` from `buildRow.js`; delete its local copy)

**Interfaces:**
- Consumes: `flattenDocument` (Task 1).
- Produces `createHistoryStore(pool)` returning:
  - `listActive() → Correction[]` (oldest first)
  - `insertCorrection(c:{kind,target,quality,op,perkName,description,note}, actor:{id,username}) → Correction`
  - `revertCorrection(id:number, actor, note:string|null) → Correction | 'missing' | 'conflict'`
  - `seedCorrections(list, actor) → number` (0 if that actor already has rows)
  - `history({subject, q, before, limit}) → {events: Event[], next: number|null}`; `Event = {id, subject, subjectId, action, actor:{id,username}, snapshot, note, createdAt}`
  - `openRevocation(discordId) → Revocation|null`, `listOpenRevocations() → Revocation[]`
  - `revoke(target:{id,username}, actor, reason) → Revocation | 'conflict'`
  - `reinstate(discordId, actor, note) → Revocation | 'conflict'`; `Revocation = {id, discordId, username, revokedBy:{id,username}, reason, createdAt, liftedBy, liftedAt}`
  - `buildAuthor(id) → {id, username}|null` (non-deleted only)
  - `softDeleteBuild(id, actor) → Build | 'missing'` (the build as `rowToBuild` returns it)
- `rowToBuild(row) → Build` from `buildRow.js`.

This task is Postgres glue with no unit tests, matching `reportsStore.js`. It's covered by the handler tests in Task 5 (through an in-memory stand-in with this contract) and by e2e in Task 11. The check here is that schema and seed run on a real database.

- [ ] **Step 1: Append the schema**

```sql
-- Perk corrections and version history
-- (see docs/superpowers/specs/2026-09-27-perk-corrections-design.md).
-- Nothing in the API deletes from these tables.
alter table builds add column if not exists deleted_at timestamptz;
alter table builds add column if not exists deleted_by text;

create table if not exists perk_corrections (
  id                 bigserial primary key,
  kind               text not null check (kind in ('weapon', 'class')),
  target             text not null,
  quality            text check (quality in ('Standard', 'Master-Crafted', 'Artificer', 'Relic', 'Heroic')),
  op                 text not null check (op in ('add', 'remove', 'edit')),
  perk_name          text not null,
  description        text,
  note               text,
  active             boolean not null default true,
  author_discord_id  text not null,
  author_username    text not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check ((kind = 'weapon' and quality is not null) or (kind = 'class' and quality is null and op = 'edit'))
);

create index if not exists perk_corrections_active_idx on perk_corrections (active, created_at, id);

create table if not exists edit_events (
  id                bigserial primary key,
  subject           text not null check (subject in ('perk_correction', 'build', 'privilege')),
  subject_id        text not null,
  action            text not null check (action in ('created', 'edited', 'reverted', 'deleted', 'revoked', 'reinstated')),
  actor_discord_id  text not null,
  actor_username    text not null,
  snapshot          jsonb,
  note              text,
  created_at        timestamptz not null default now()
);

create index if not exists edit_events_subject_idx on edit_events (subject, id desc);

create table if not exists privilege_revocations (
  id                   bigserial primary key,
  discord_id           text not null,
  username             text not null,
  revoked_by           text not null,
  revoked_by_username  text not null,
  reason               text not null,
  created_at           timestamptz not null default now(),
  lifted_by            text,
  lifted_by_username   text,
  lifted_at            timestamptz
);

-- At most one open revocation per member.
create unique index if not exists privilege_revocations_open_idx
  on privilege_revocations (discord_id) where lifted_at is null;
```

- [ ] **Step 2: Extract `rowToBuild`**

```js
// server/src/buildRow.js
/** builds row → API shape. Shared by index.js and historyStore.js (deleted-build snapshots). */
export const rowToBuild = (r) => ({
  id: r.id,
  title: r.title,
  role: r.role,
  notes: r.notes,
  className: r.class_name,
  level: r.level,
  prestige: r.prestige,
  prestigePicks: r.prestige_picks,
  perks: r.perks,
  perkIds: r.perk_ids,
  justifications: r.justifications,
  weapons: r.weapons,
  weaponPerks: r.weapon_perks,
  author: { id: r.author_discord_id, username: r.author_discord_username },
  createdAt: r.created_at,
})
```

In `server/src/index.js`, delete the local `const rowToBuild = …` block and add `import { rowToBuild } from './buildRow.js'` beside the other imports.

- [ ] **Step 3: Write the store**

```js
// server/src/historyStore.js
/**
 * Postgres side of perks.js and buildModeration.js: perk corrections,
 * privilege revocations, build soft deletes, and the edit_events history they
 * all write to. Each change and its event commit together; nothing here
 * deletes a row. Rows come back camelCased with ISO timestamps.
 */
import { rowToBuild } from './buildRow.js'

const iso = (d) => (d instanceof Date ? d.toISOString() : d)

const toCorrection = (r) => ({
  id: Number(r.id),
  kind: r.kind,
  target: r.target,
  quality: r.quality,
  op: r.op,
  perkName: r.perk_name,
  description: r.description,
  note: r.note,
  active: r.active,
  author: { id: r.author_discord_id, username: r.author_username },
  createdAt: iso(r.created_at),
})

const toEvent = (e) => ({
  id: Number(e.id),
  subject: e.subject,
  subjectId: e.subject_id,
  action: e.action,
  actor: { id: e.actor_discord_id, username: e.actor_username },
  snapshot: e.snapshot,
  note: e.note,
  createdAt: iso(e.created_at),
})

const toRevocation = (r) => ({
  id: Number(r.id),
  discordId: r.discord_id,
  username: r.username,
  revokedBy: { id: r.revoked_by, username: r.revoked_by_username },
  reason: r.reason,
  createdAt: iso(r.created_at),
  liftedBy: r.lifted_by ? { id: r.lifted_by, username: r.lifted_by_username } : null,
  liftedAt: iso(r.lifted_at),
})

export function createHistoryStore(pool) {
  async function inTx(fn) {
    const client = await pool.connect()
    try {
      await client.query('begin')
      const out = await fn(client)
      await client.query('commit')
      return out
    } catch (err) {
      await client.query('rollback').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  const event = (q, { subject, subjectId, action, actor, snapshot, note }) =>
    q.query(
      `insert into edit_events (subject, subject_id, action, actor_discord_id, actor_username, snapshot, note)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [subject, String(subjectId), action, actor.id, actor.username, JSON.stringify(snapshot ?? null), note ?? null],
    )

  const insertOne = async (q, c, actor) => {
    const { rows } = await q.query(
      `insert into perk_corrections (kind, target, quality, op, perk_name, description, note, author_discord_id, author_username)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [c.kind, c.target, c.quality, c.op, c.perkName, c.description, c.note ?? null, actor.id, actor.username],
    )
    const out = toCorrection(rows[0])
    await event(q, { subject: 'perk_correction', subjectId: out.id, action: 'created', actor, snapshot: out, note: c.note })
    return out
  }

  return {
    async listActive() {
      const { rows } = await pool.query('select * from perk_corrections where active order by created_at, id')
      return rows.map(toCorrection)
    },

    insertCorrection: (c, actor) => inTx((q) => insertOne(q, c, actor)),

    revertCorrection: (id, actor, note) =>
      inTx(async (q) => {
        const { rows } = await q.query('select * from perk_corrections where id = $1 for update', [id])
        if (!rows.length) return 'missing'
        if (!rows[0].active) return 'conflict'
        const before = toCorrection(rows[0])
        const updated = await q.query('update perk_corrections set active = false, updated_at = now() where id = $1 returning *', [id])
        await event(q, { subject: 'perk_correction', subjectId: id, action: 'reverted', actor, snapshot: before, note })
        return toCorrection(updated.rows[0])
      }),

    seedCorrections: (list, actor) =>
      inTx(async (q) => {
        const { rows } = await q.query('select 1 from perk_corrections where author_discord_id = $1 limit 1', [actor.id])
        if (rows.length) return 0
        for (const c of list) await insertOne(q, { ...c, note: 'seeded from the 2026-09-27 member error report' }, actor)
        return list.length
      }),

    async history({ subject = null, q = null, before = null, limit = 50 }) {
      const where = []
      const args = []
      if (subject) where.push(`subject = $${args.push(subject)}`)
      if (q) where.push(`snapshot::text ilike $${args.push(`%${q}%`)}`)
      if (before) where.push(`id < $${args.push(before)}`)
      const sql = `select * from edit_events ${where.length ? `where ${where.join(' and ')}` : ''}
                   order by id desc limit $${args.push(limit + 1)}`
      const { rows } = await pool.query(sql, args)
      const events = rows.slice(0, limit).map(toEvent)
      return { events, next: rows.length > limit ? events.at(-1).id : null }
    },

    async openRevocation(discordId) {
      const { rows } = await pool.query('select * from privilege_revocations where discord_id = $1 and lifted_at is null', [discordId])
      return rows.length ? toRevocation(rows[0]) : null
    },

    async listOpenRevocations() {
      const { rows } = await pool.query('select * from privilege_revocations where lifted_at is null order by created_at desc')
      return rows.map(toRevocation)
    },

    revoke: (target, actor, reason) =>
      inTx(async (q) => {
        const { rows } = await q.query(
          `insert into privilege_revocations (discord_id, username, revoked_by, revoked_by_username, reason)
           values ($1,$2,$3,$4,$5)
           on conflict (discord_id) where lifted_at is null do nothing
           returning *`,
          [target.id, target.username, actor.id, actor.username, reason],
        )
        if (!rows.length) return 'conflict'
        const out = toRevocation(rows[0])
        await event(q, { subject: 'privilege', subjectId: target.id, action: 'revoked', actor, snapshot: out, note: reason })
        return out
      }),

    reinstate: (discordId, actor, note) =>
      inTx(async (q) => {
        const { rows } = await q.query(
          `update privilege_revocations set lifted_by = $2, lifted_by_username = $3, lifted_at = now()
           where discord_id = $1 and lifted_at is null returning *`,
          [discordId, actor.id, actor.username],
        )
        if (!rows.length) return 'conflict'
        const out = toRevocation(rows[0])
        await event(q, { subject: 'privilege', subjectId: discordId, action: 'reinstated', actor, snapshot: out, note })
        return out
      }),

    async buildAuthor(id) {
      const { rows } = await pool.query(
        'select author_discord_id, author_discord_username from builds where id = $1 and deleted_at is null',
        [id],
      )
      return rows.length ? { id: rows[0].author_discord_id, username: rows[0].author_discord_username } : null
    },

    softDeleteBuild: (id, actor) =>
      inTx(async (q) => {
        const { rows } = await q.query('select * from builds where id = $1 and deleted_at is null for update', [id])
        if (!rows.length) return 'missing'
        const build = rowToBuild(rows[0])
        await q.query('update builds set deleted_at = now(), deleted_by = $2 where id = $1', [id, actor.id])
        await event(q, { subject: 'build', subjectId: id, action: 'deleted', actor, snapshot: build, note: null })
        return build
      }),
  }
}
```

- [ ] **Step 4: Write the seed entry point**

```js
// server/src/seed.js
/**
 * One-off: seed perk corrections from a document (the shape of
 * GET /perk-corrections, e.g. src/data/perk-corrections.json) read on stdin.
 * Idempotent: does nothing if the system author already has rows.
 *
 *   docker compose exec -T api bun run src/seed.js < ../src/data/perk-corrections.json
 */
import { Pool } from 'pg'
import { createHistoryStore } from './historyStore.js'
import { flattenDocument } from './perkCorrectionsCore.js'

const SYSTEM = { id: '0', username: 'system (error report 2026-09-27)' }

const doc = JSON.parse(await Bun.stdin.text())
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const n = await createHistoryStore(pool).seedCorrections(flattenDocument(doc), SYSTEM)
console.log(n ? `Seeded ${n} perk corrections.` : 'Already seeded — nothing to do.')
await pool.end()
```

- [ ] **Step 5: Verify schema and seed on a throwaway Postgres**

Run (PowerShell, from repo root; Docker Desktop running):
```pwsh
docker run -d --name pc-check -e POSTGRES_PASSWORD=x -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
Start-Sleep 4
Get-Content server/schema.sql | docker exec -i pc-check psql -U postgres -d t -v ON_ERROR_STOP=1
Get-Content server/schema.sql | docker exec -i pc-check psql -U postgres -d t -v ON_ERROR_STOP=1
docker rm -f pc-check
```
Expected: both runs finish without `ERROR` (the second run shows the schema is idempotent). The seed itself is exercised in Task 12 once `src/data/perk-corrections.json` exists.

- [ ] **Step 6: Run the full suite (index.js import change)**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/schema.sql server/src/buildRow.js server/src/historyStore.js server/src/seed.js server/src/index.js
git commit -m "feat(perks): schema and Postgres store for corrections, revocations and history"
```

---

### Task 4: Webhook notifier and bake loader

**Files:**
- Create: `server/src/webhook.js`, `server/src/bake.js`
- Test: `server/src/webhook.test.js`, `server/src/bake.test.js`

**Interfaces:**
- Consumes: `Upstream` from `discordRoles.js`.
- Produces:
  - `createNotifier({url, suffix?, fetchImpl?, log?}) → notify(content: string): void`
  - `createBakeLoader({baseUrl, fetchImpl?, ttlMs?, now?}) → loadBake(): Promise<{weapons, classes}>` (throws `Upstream` only if nothing is cached)

- [ ] **Step 1: Write the failing tests**

```js
// server/src/webhook.test.js
import { describe, it, expect, vi } from 'vitest'
import { createNotifier } from './webhook'

describe('createNotifier', () => {
  it('posts the content plus suffix and never pings anyone', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}'))
    createNotifier({ url: 'https://hook.test', suffix: ' · https://site.test/history', fetchImpl })('by @everyone <@&123>')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://hook.test')
    expect(JSON.parse(init.body)).toEqual({
      content: 'by @everyone <@&123> · https://site.test/history',
      allowed_mentions: { parse: [] },
    })
  })

  it('is a no-op without a url and logs (not throws) on failure', async () => {
    const fetchImpl = vi.fn()
    createNotifier({ url: null, fetchImpl })('x')
    expect(fetchImpl).not.toHaveBeenCalled()

    const log = vi.fn()
    createNotifier({ url: 'https://hook.test', fetchImpl: vi.fn().mockRejectedValue(new Error('down')), log })('x')
    await new Promise((r) => setTimeout(r, 0))
    expect(log).toHaveBeenCalled()
  })

  it('keeps content inside Discord’s 2000-character limit', () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}'))
    createNotifier({ url: 'https://hook.test', suffix: ' · link', fetchImpl })('x'.repeat(3000))
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).content.length).toBeLessThanOrEqual(2000)
  })
})
```

```js
// server/src/bake.test.js
import { describe, it, expect, vi } from 'vitest'
import { createBakeLoader } from './bake'
import { Upstream } from './discordRoles'

const files = {
  'https://raw.test/data/weapon-trees.json': { weapons: { 'Las Fusil': { perks: [] } } },
  'https://raw.test/data/perk-details.json': { classes: { Tactical: { perks: {} } } },
}
const okFetch = () => vi.fn(async (url) => new Response(JSON.stringify(files[String(url)])))

describe('createBakeLoader', () => {
  it('loads both files and caches within the ttl', async () => {
    const fetchImpl = okFetch()
    let t = 0
    const load = createBakeLoader({ baseUrl: 'https://raw.test/data/', fetchImpl, ttlMs: 100, now: () => t })
    expect(Object.keys((await load()).weapons)).toEqual(['Las Fusil'])
    await load()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    t = 101
    await load()
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('serves stale data when a refresh fails', async () => {
    let t = 0
    const fetchImpl = okFetch()
    const load = createBakeLoader({ baseUrl: 'https://raw.test/data/', fetchImpl, ttlMs: 1, now: () => t })
    await load()
    fetchImpl.mockImplementation(async () => new Response('nope', { status: 500 }))
    t = 5
    expect((await load()).classes.Tactical).toBeTruthy()
  })

  it('throws Upstream when nothing was ever loaded', async () => {
    const load = createBakeLoader({ baseUrl: 'https://raw.test/data/', fetchImpl: async () => new Response('x', { status: 404 }) })
    await expect(load()).rejects.toBeInstanceOf(Upstream)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run server/src/webhook.test.js server/src/bake.test.js`
Expected: FAIL, unresolved imports

- [ ] **Step 3: Write the implementations**

```js
// server/src/webhook.js
/**
 * Fire-and-forget Discord webhook. Mentions are always disabled: perk names,
 * notes and usernames are user-typed and must never ping @everyone or a role.
 */
const MAX = 2000

export function createNotifier({ url, suffix = '', fetchImpl = fetch, log = console.error }) {
  return function notify(content) {
    if (!url) return
    const room = MAX - suffix.length
    const body = (content.length > room ? content.slice(0, room - 1) + '…' : content) + suffix
    fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: body, allowed_mentions: { parse: [] } }),
    }).catch(log)
  }
}
```

```js
// server/src/bake.js
/**
 * The wiki bake (src/data/weapon-trees.json + perk-details.json), read from
 * the repo's main branch so the API validates against exactly what the site
 * ships, without rebuilding the API image on every re-bake. Cached; a failed
 * refresh keeps serving the last good copy.
 */
import { Upstream } from './discordRoles.js'

export function createBakeLoader({ baseUrl, fetchImpl = fetch, ttlMs = 10 * 60_000, now = Date.now }) {
  let cached = null
  let at = 0

  async function get(file) {
    const res = await fetchImpl(new URL(file, baseUrl), { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`${file}: ${res.status}`)
    return res.json()
  }

  return async function loadBake() {
    if (cached && now() - at < ttlMs) return cached
    try {
      const [trees, details] = await Promise.all([get('weapon-trees.json'), get('perk-details.json')])
      if (!trees?.weapons || !details?.classes) throw new Error('unexpected bake shape')
      cached = { weapons: trees.weapons, classes: details.classes }
      at = now()
      return cached
    } catch (err) {
      if (cached) return cached
      throw new Upstream(`Perk data unavailable: ${err.message}`)
    }
  }
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run server/src/webhook.test.js server/src/bake.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/webhook.js server/src/webhook.test.js server/src/bake.js server/src/bake.test.js
git commit -m "feat(perks): webhook notifier with mentions off, cached bake loader"
```

---

### Task 5: Perks / history / privileges HTTP handler

**Files:**
- Create: `server/src/perks.js`
- Test: `server/src/perks.test.js`

**Interfaces:**
- Consumes: Task 1 (`QUALITIES, OPS, LIMITS, applyWeaponCorrections, hasWeaponPerk, toDocument`), Task 2 (`mayRevoke`, `createPrivileges`), Task 3 store contract, Task 4 `notify`/`loadBake`, `roles.identify` + `Upstream` from `discordRoles.js`.
- Produces: `createPerksHandler({roles, privileges, store, loadBake, notify}) → handle(request, url): Promise<Response|null>` (null = not a perks path); `validateCorrection(body) → correction | errorString`.

- [ ] **Step 1: Write the failing test**

```js
// server/src/perks.test.js
import { describe, it, expect, vi } from 'vitest'
import { createPerksHandler, validateCorrection } from './perks'
import { createPrivileges, ROLE_IDS as R } from './privileges'
import { Upstream } from './discordRoles'

const USERS = {
  member: { id: '100000000000000001', username: 'member', roles: ['1377787723976409211'] },
  tm: { id: '100000000000000002', username: 'tm', roles: [R.techmarine] },
  tm2: { id: '100000000000000006', username: 'tm2', roles: [R.techmarine] },
  forge: { id: '100000000000000003', username: 'forge', roles: [R.forge] },
  lh: { id: '100000000000000004', username: 'lh', roles: [R.hierarchy] },
  admin: { id: '100000000000000005', username: 'admin', roles: [], admin: true },
}
const byId = (id) => Object.values(USERS).find((u) => u.id === id)

function fakeRoles({ fail } = {}) {
  return {
    identify: async (req) => {
      if (fail) throw new Upstream()
      const u = USERS[(req.headers.get('Authorization') || '').slice(7)]
      return u ? { id: u.id, username: u.username } : null
    },
    rolesOf: async (id) => byId(id)?.roles ?? null,
    isAdmin: async (id) => !!byId(id)?.admin,
  }
}

// In-memory stand-in with historyStore.js's contract.
function memStore() {
  const corrections = []
  const events = []
  const revocations = []
  const ev = (e) => events.push({ id: events.length + 1, createdAt: 't', ...e })
  return {
    corrections, events, revocations,
    listActive: async () => corrections.filter((c) => c.active),
    insertCorrection: async (c, actor) => {
      const row = { ...c, id: corrections.length + 1, active: true, author: actor, createdAt: `t${corrections.length + 1}` }
      corrections.push(row)
      ev({ subject: 'perk_correction', subjectId: String(row.id), action: 'created', actor, snapshot: row, note: c.note })
      return row
    },
    revertCorrection: async (id, actor, note) => {
      const c = corrections.find((x) => x.id === id)
      if (!c) return 'missing'
      if (!c.active) return 'conflict'
      c.active = false
      ev({ subject: 'perk_correction', subjectId: String(id), action: 'reverted', actor, snapshot: c, note })
      return c
    },
    history: async ({ subject }) => ({ events: events.filter((e) => !subject || e.subject === subject).reverse(), next: null }),
    openRevocation: async (id) => revocations.find((r) => r.discordId === id && !r.liftedAt) || null,
    listOpenRevocations: async () => revocations.filter((r) => !r.liftedAt),
    revoke: async (target, actor, reason) => {
      if (revocations.some((r) => r.discordId === target.id && !r.liftedAt)) return 'conflict'
      const r = { id: revocations.length + 1, discordId: target.id, username: target.username, revokedBy: actor, reason, liftedAt: null }
      revocations.push(r)
      ev({ subject: 'privilege', subjectId: target.id, action: 'revoked', actor, snapshot: r, note: reason })
      return r
    },
    reinstate: async (id, actor) => {
      const r = revocations.find((x) => x.discordId === id && !x.liftedAt)
      if (!r) return 'conflict'
      r.liftedAt = 't'
      r.liftedBy = actor
      return r
    },
  }
}

const BAKE = {
  weapons: {
    'Las Fusil': {
      perks: [
        { name: 'Perpetual Velocity', quality: 'Relic', description: 'pv' },
        { name: 'Increased Capacity', quality: 'Standard', description: 'ic' },
      ],
    },
  },
  classes: { Tactical: { perks: { 'Adrenaline Rush': { level: 2, description: 'ar' } } } },
}

function setup(over = {}) {
  const roles = fakeRoles(over)
  const store = memStore()
  const notify = vi.fn()
  const handle = createPerksHandler({
    roles,
    privileges: createPrivileges({ roles, store }),
    store,
    loadBake: over.loadBake || (async () => BAKE),
    notify,
  })
  async function call(who, method, path, body) {
    const headers = who ? { Authorization: `Bearer ${who}` } : {}
    const req = new Request(`https://api.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const res = await handle(req, new URL(req.url))
    return res && { status: res.status, body: await res.json(), headers: res.headers }
  }
  return { store, notify, call }
}

const REMOVE_PV = { kind: 'weapon', target: 'Las Fusil', quality: 'Relic', op: 'remove', perkName: 'Perpetual Velocity', note: 'checked in game' }
const ADD_HH = { kind: 'weapon', target: 'Las Fusil', quality: 'Relic', op: 'add', perkName: 'Head Hunter', description: 'Headshots deal 10% more Damage' }

describe('routing and the public document', () => {
  it('ignores other paths', async () => {
    expect(await setup().call(null, 'GET', '/builds')).toBeNull()
  })

  it('serves the document to anyone, briefly cacheable', async () => {
    const { call } = setup()
    await call('tm', 'POST', '/perk-corrections', REMOVE_PV)
    const res = await call(null, 'GET', '/perk-corrections')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=30')
    expect(res.body.weapons['Las Fusil'][0]).toMatchObject({ op: 'remove', perkName: 'Perpetual Velocity' })
    expect(JSON.stringify(res.body)).not.toContain('100000000000000002')
  })
})

describe('POST /perk-corrections', () => {
  it('401 without a token, 403 for a plain member', async () => {
    const { call } = setup()
    expect((await call(null, 'POST', '/perk-corrections', REMOVE_PV)).status).toBe(401)
    expect((await call('member', 'POST', '/perk-corrections', REMOVE_PV)).status).toBe(403)
  })

  it.each(['tm', 'forge', 'lh', 'admin'])('%s may correct; the webhook says what changed', async (who) => {
    const { call, notify } = setup()
    const res = await call(who, 'POST', '/perk-corrections', ADD_HH)
    expect(res.status).toBe(201)
    expect(res.body.weapons['Las Fusil'][0]).toMatchObject({ op: 'add', perkName: 'Head Hunter' })
    expect(notify).toHaveBeenCalledWith(`Perk correction by ${USERS[who].username}: Las Fusil / Relic — added Head Hunter`)
  })

  it('404 when removing or editing a perk that is not in that tier', async () => {
    const { call } = setup()
    expect((await call('tm', 'POST', '/perk-corrections', { ...REMOVE_PV, quality: 'Standard' })).status).toBe(404)
    expect((await call('tm', 'POST', '/perk-corrections', { ...REMOVE_PV, perkName: 'Nope' })).status).toBe(404)
    expect((await call('tm', 'POST', '/perk-corrections', { ...REMOVE_PV, target: 'Nope Rifle' })).status).toBe(404)
  })

  it('a perk added by an earlier correction can then be edited or removed', async () => {
    const { call } = setup()
    await call('tm', 'POST', '/perk-corrections', ADD_HH)
    expect((await call('tm', 'POST', '/perk-corrections', { ...ADD_HH, op: 'edit', description: 'x' })).status).toBe(201)
    expect((await call('tm', 'POST', '/perk-corrections', { ...ADD_HH, op: 'remove' })).status).toBe(201)
  })

  it('a perk already removed cannot be removed again', async () => {
    const { call } = setup()
    await call('tm', 'POST', '/perk-corrections', REMOVE_PV)
    expect((await call('tm', 'POST', '/perk-corrections', REMOVE_PV)).status).toBe(404)
  })

  it('class perks: edit only, and only existing perks', async () => {
    const { call } = setup()
    const base = { kind: 'class', target: 'Tactical', perkName: 'Adrenaline Rush', description: 'new' }
    expect((await call('tm', 'POST', '/perk-corrections', { ...base, op: 'edit' })).status).toBe(201)
    expect((await call('tm', 'POST', '/perk-corrections', { ...base, op: 'add' })).status).toBe(400)
    expect((await call('tm', 'POST', '/perk-corrections', { ...base, op: 'edit', perkName: 'Nope' })).status).toBe(404)
  })

  it('a revoked editor is refused', async () => {
    const { call } = setup()
    await call('forge', 'POST', '/privileges/100000000000000002/revoke', { reason: 'bad edits', username: 'tm' })
    const res = await call('tm', 'POST', '/perk-corrections', ADD_HH)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/revoked/)
  })

  it('503 when Discord or the bake is unreachable', async () => {
    expect((await setup({ fail: true }).call('tm', 'POST', '/perk-corrections', ADD_HH)).status).toBe(503)
    const noBake = setup({ loadBake: async () => { throw new Upstream() } })
    expect((await noBake.call('tm', 'POST', '/perk-corrections', REMOVE_PV)).status).toBe(503)
  })
})

describe('validateCorrection', () => {
  it.each([
    [null, /Malformed/],
    [{ ...ADD_HH, kind: 'armour' }, /weapon or class/],
    [{ ...ADD_HH, quality: 'Legendary' }, /tier/],
    [{ ...ADD_HH, op: 'swap' }, /add, remove or edit/],
    [{ ...ADD_HH, perkName: '' }, /Name the perk/],
    [{ ...ADD_HH, perkName: 'x'.repeat(81) }, /Name the perk/],
    [{ ...ADD_HH, description: '' }, /Describe/],
    [{ ...ADD_HH, description: 'x'.repeat(501) }, /Describe/],
    [{ ...ADD_HH, note: 'x'.repeat(201) }, /Note/],
  ])('rejects %j', (body, msg) => {
    expect(validateCorrection(body)).toMatch(msg)
  })

  it('trims, and drops the description on a remove', () => {
    expect(validateCorrection({ ...REMOVE_PV, perkName: '  Perpetual Velocity ', description: 'ignored' })).toMatchObject({
      perkName: 'Perpetual Velocity',
      description: null,
    })
  })
})

describe('revert', () => {
  it('reverts once, 409 the second time, 404 for unknown ids', async () => {
    const { call, notify } = setup()
    await call('tm', 'POST', '/perk-corrections', REMOVE_PV)
    const res = await call('lh', 'POST', '/perk-corrections/1/revert', { note: 'wrong' })
    expect(res.status).toBe(200)
    expect(res.body.weapons).toEqual({})
    expect(notify).toHaveBeenLastCalledWith('lh reverted perk correction #1 (Las Fusil / Relic — removed Perpetual Velocity): wrong')
    expect((await call('lh', 'POST', '/perk-corrections/1/revert')).status).toBe(409)
    expect((await call('lh', 'POST', '/perk-corrections/99/revert')).status).toBe(404)
    expect((await call('member', 'POST', '/perk-corrections/1/revert')).status).toBe(403)
  })
})

describe('GET /history', () => {
  it('editors only; bad subject is 400', async () => {
    const { call } = setup()
    await call('tm', 'POST', '/perk-corrections', REMOVE_PV)
    expect((await call('member', 'GET', '/history')).status).toBe(403)
    expect((await call('lh', 'GET', '/history?subject=nope')).status).toBe(400)
    const res = await call('lh', 'GET', '/history?subject=perk_correction')
    expect(res.status).toBe(200)
    expect(res.body.events[0]).toMatchObject({ action: 'created', actor: { username: 'tm' } })
  })

  it('open revocations only for someone who can revoke', async () => {
    const { call } = setup()
    await call('forge', 'POST', '/privileges/100000000000000002/revoke', { reason: 'r', username: 'tm' })
    expect((await call('lh', 'GET', '/history')).body.revocations).toEqual([])
    expect((await call('forge', 'GET', '/history')).body.revocations).toHaveLength(1)
  })
})

describe('privileges', () => {
  it('/privileges/me reports the caller', async () => {
    const { call } = setup()
    expect((await call('forge', 'GET', '/privileges/me')).body).toEqual({ editor: true, historyViewer: true, moderator: true, revoked: false, revoker: 'forge' })
    expect((await call('lh', 'GET', '/privileges/me')).body).toMatchObject({ editor: true, moderator: false, revoker: null })
  })

  it('forge revokes a techmarine; reason required; double revoke 409; reinstate', async () => {
    const { call, notify } = setup()
    const path = '/privileges/100000000000000002'
    expect((await call('forge', 'POST', `${path}/revoke`, { username: 'tm' })).status).toBe(400)
    expect((await call('forge', 'POST', `${path}/revoke`, { reason: 'vandalism', username: 'tm' })).status).toBe(201)
    expect(notify).toHaveBeenLastCalledWith('forge revoked site privileges for tm: vandalism')
    expect((await call('forge', 'POST', `${path}/revoke`, { reason: 'again', username: 'tm' })).status).toBe(409)
    expect((await call('tm', 'GET', '/privileges/me')).body).toMatchObject({ editor: false, revoked: true })
    expect((await call('forge', 'POST', `${path}/reinstate`)).status).toBe(200)
    expect((await call('forge', 'POST', `${path}/reinstate`)).status).toBe(409)
    expect((await call('tm', 'GET', '/privileges/me')).body).toMatchObject({ editor: true, revoked: false })
  })

  it('who may revoke whom', async () => {
    const { call } = setup()
    const r = (who, target) => call(who, 'POST', `/privileges/${USERS[target].id}/revoke`, { reason: 'x', username: target })
    expect((await r('forge', 'lh')).status).toBe(403)
    expect((await r('lh', 'forge')).status).toBe(403)
    expect((await r('lh', 'tm')).status).toBe(403)
    expect((await r('tm', 'tm2')).status).toBe(403)
    expect((await r('admin', 'forge')).status).toBe(201)
    expect((await r('admin', 'lh')).status).toBe(201)
    expect((await r('admin', 'admin')).status).toBe(403)
  })

  it('404 for someone not in the guild', async () => {
    expect((await setup().call('admin', 'POST', '/privileges/199999999999999999/revoke', { reason: 'x' })).status).toBe(404)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run server/src/perks.test.js`
Expected: FAIL, "Failed to resolve import ./perks"

- [ ] **Step 3: Write the implementation**

```js
// server/src/perks.js
/**
 * Perk corrections, the version history, and privilege revocation. See
 * docs/superpowers/specs/2026-09-27-perk-corrections-design.md.
 *
 * GET /perk-corrections is public (the site renders from it). Everything else
 * identifies the caller with Discord and checks privileges live
 * (privileges.js) on every request; uncertain paths fail closed. Storage sits
 * behind `store` (historyStore.js in production) so this file is testable
 * without Postgres.
 */
import { Upstream } from './discordRoles.js'
import { QUALITIES, OPS, LIMITS, applyWeaponCorrections, hasWeaponPerk, toDocument } from './perkCorrectionsCore.js'
import { mayRevoke } from './privileges.js'

const REVERT = /^\/perk-corrections\/(\d{1,15})\/revert$/
const PRIVILEGE = /^\/privileges\/(\d{17,20})\/(revoke|reinstate)$/
const SUBJECTS = ['perk_correction', 'build', 'privilege']
const PREFIXES = ['/perk-corrections', '/history', '/privileges']
const PAST = { add: 'added', remove: 'removed', edit: 'edited' }

const str = (v) => (typeof v === 'string' ? v.trim() : '')
const label = (c) => `${c.target}${c.quality ? ` / ${c.quality}` : ''} — ${PAST[c.op]} ${c.perkName}`

export function createPerksHandler({ roles, privileges, store, loadBake, notify = () => {} }) {
  const doc = async () => toDocument(await store.listActive())

  /** → null when the correction's target (and, for remove/edit, its perk) exists; else a 404 message. */
  async function missingTarget(c) {
    const bake = await loadBake()
    if (c.kind === 'class') {
      const cls = bake.classes[c.target]
      if (!cls) return `Unknown class: ${c.target}.`
      return cls.perks?.[c.perkName] ? null : `${c.target} has no perk named ${c.perkName}.`
    }
    const tree = bake.weapons[c.target]
    if (!tree) return `Unknown weapon: ${c.target}.`
    if (c.op === 'add') return null
    const active = (await store.listActive()).filter((x) => x.kind === 'weapon' && x.target === c.target)
    return hasWeaponPerk(applyWeaponCorrections(tree, active), c.quality, c.perkName)
      ? null
      : `${c.target} has no ${c.quality} perk named ${c.perkName}.`
  }

  async function route(request, url) {
    const { pathname } = url
    const method = request.method

    if (pathname === '/perk-corrections' && method === 'GET') return reply(200, await doc(), 'public, max-age=30')

    const user = await roles.identify(request)
    if (!user) return reply(401, { error: 'Sign in with Discord.' })
    const me = await privileges.forUser(user)
    const refuse = () =>
      reply(403, { error: me.revoked ? 'Your site privileges have been revoked.' : 'Restricted to the forge and Legion leadership.' })

    if (pathname === '/privileges/me' && method === 'GET') {
      const { editor, historyViewer, moderator, revoked, revoker } = me
      return reply(200, { editor, historyViewer, moderator, revoked, revoker })
    }

    if (pathname === '/perk-corrections' && method === 'POST') {
      if (!me.editor) return refuse()
      const c = validateCorrection(await request.json().catch(() => null))
      if (typeof c === 'string') return reply(400, { error: c })
      const missing = await missingTarget(c)
      if (missing) return reply(404, { error: missing })
      const saved = await store.insertCorrection(c, user)
      notify(`Perk correction by ${user.username}: ${label(saved)}${saved.note ? ` ("${saved.note}")` : ''}`)
      return reply(201, await doc())
    }

    const rv = REVERT.exec(pathname)
    if (rv && method === 'POST') {
      if (!me.editor) return refuse()
      const note = str(((await request.json().catch(() => null)) || {}).note)
      if (note.length > LIMITS.note) return reply(400, { error: 'Note is too long (200 characters max).' })
      const result = await store.revertCorrection(Number(rv[1]), user, note || null)
      if (result === 'missing') return reply(404, { error: 'Correction not found.' })
      if (result === 'conflict') return reply(409, { error: 'That correction was already reverted — refresh.' })
      notify(`${user.username} reverted perk correction #${result.id} (${label(result)})${note ? `: ${note}` : ''}`)
      return reply(200, await doc())
    }

    if (pathname === '/history' && method === 'GET') {
      if (!me.historyViewer) return refuse()
      const subject = url.searchParams.get('subject') || null
      if (subject && !SUBJECTS.includes(subject)) return reply(400, { error: 'Unknown history filter.' })
      const q = str(url.searchParams.get('q')).slice(0, LIMITS.target) || null
      const beforeRaw = url.searchParams.get('before') || ''
      const before = /^\d{1,15}$/.test(beforeRaw) ? Number(beforeRaw) : null
      const page = await store.history({ subject, q, before, limit: 50 })
      return reply(200, { ...page, revocations: me.revoker ? await store.listOpenRevocations() : [] })
    }

    const pm = PRIVILEGE.exec(pathname)
    if (pm && method === 'POST') {
      const [, targetId, action] = pm
      const target = await privileges.target(targetId)
      if (!target) return reply(404, { error: 'That member is not in the server.' })
      if (!mayRevoke(me, target)) return reply(403, { error: "You can't change that member's privileges." })
      const body = (await request.json().catch(() => null)) || {}
      const reason = str(body.reason)
      if (reason.length > LIMITS.note) return reply(400, { error: 'Reason is too long (200 characters max).' })
      if (action === 'revoke') {
        if (!reason) return reply(400, { error: 'Give a reason.' })
        const username = str(body.username).slice(0, 100) || targetId
        const r = await store.revoke({ id: targetId, username }, user, reason)
        if (r === 'conflict') return reply(409, { error: 'Already revoked.' })
        notify(`${user.username} revoked site privileges for ${username}: ${reason}`)
        return reply(201, r)
      }
      const r = await store.reinstate(targetId, user, reason || null)
      if (r === 'conflict') return reply(409, { error: 'That member is not revoked.' })
      notify(`${user.username} reinstated site privileges for ${r.username}`)
      return reply(200, r)
    }
    return null
  }

  return async function handle(request, url) {
    if (!PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) return null
    try {
      return (await route(request, url)) ?? reply(404, { error: 'Not found.' })
    } catch (err) {
      if (err instanceof Upstream) return reply(503, { error: 'Discord or the perk data could not be reached. Try again.' })
      throw err
    }
  }
}

/** → clean correction, or an error message string. */
export function validateCorrection(b) {
  if (!b || typeof b !== 'object') return 'Malformed correction.'
  const c = {
    kind: str(b.kind),
    target: str(b.target),
    quality: str(b.quality) || null,
    op: str(b.op),
    perkName: str(b.perkName),
    description: str(b.description) || null,
    note: str(b.note) || null,
  }
  if (!['weapon', 'class'].includes(c.kind)) return 'Pick weapon or class.'
  if (!c.target || c.target.length > LIMITS.target) return 'Name the weapon or class.'
  if (c.kind === 'class') {
    if (c.op !== 'edit') return 'Class perks can only have their text corrected.'
    c.quality = null
  } else {
    if (!QUALITIES.includes(c.quality)) return 'Pick a tier.'
    if (!OPS.includes(c.op)) return 'Pick add, remove or edit.'
  }
  if (!c.perkName || c.perkName.length > LIMITS.perkName) return 'Name the perk (80 characters max).'
  if (c.op === 'remove') c.description = null
  else if (!c.description || c.description.length > LIMITS.description) return 'Describe the perk (500 characters max).'
  if (c.note && c.note.length > LIMITS.note) return 'Note is too long (200 characters max).'
  return c
}

function reply(status, body, cache = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache },
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run server/src/perks.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/perks.js server/src/perks.test.js
git commit -m "feat(perks): corrections, history and privilege routes"
```

---

### Task 6: Build moderation (soft delete, Techmarine, revocation) and server wiring

**Files:**
- Create: `server/src/buildModeration.js`
- Test: `server/src/buildModeration.test.js`
- Modify: `server/src/index.js`, `server/.env.example`, `server/README.md`

**Interfaces:**
- Consumes: `roles.identify`, `privileges.forUser` (Task 2), `store.buildAuthor`/`store.softDeleteBuild` (Task 3), `notify` (Task 4), `createPerksHandler` (Task 5), `createBakeLoader` (Task 4), `createHistoryStore` (Task 3).
- Produces: `createBuildModeration({roles, privileges, store, notify}) → { status(request) → Response, remove(request, id) → Response }`. The routes keep their shapes (`GET /builds/moderator` → `{moderator}`, `DELETE /builds/:id` → 204).

- [ ] **Step 1: Write the failing test**

```js
// server/src/buildModeration.test.js
import { describe, it, expect, vi } from 'vitest'
import { createBuildModeration } from './buildModeration'
import { Upstream } from './discordRoles'

const ME = { poster: { id: '1', username: 'poster' }, mod: { id: '2', username: 'mod' }, other: { id: '3', username: 'other' } }
const PRIV = { '1': { moderator: false }, '2': { moderator: true }, '3': { moderator: false } }

function setup({ fail = false } = {}) {
  const deleted = []
  const notify = vi.fn()
  const mod = createBuildModeration({
    roles: {
      identify: async (req) => {
        if (fail) throw new Upstream()
        return ME[(req.headers.get('Authorization') || '').slice(7)] || null
      },
    },
    privileges: { forUser: async (u) => PRIV[u.id] },
    store: {
      buildAuthor: async (id) => (id === '7' && !deleted.includes('7') ? { id: '1', username: 'poster' } : null),
      softDeleteBuild: async (id) => {
        deleted.push(id)
        return { id: 7, title: 'Melta Bulwark', author: { id: '1', username: 'poster' } }
      },
    },
    notify,
  })
  const req = (who) => new Request('https://api.test/builds/7', { method: 'DELETE', headers: who ? { Authorization: `Bearer ${who}` } : {} })
  return { mod, notify, deleted, req }
}

describe('build deletion', () => {
  it('poster deletes their own without a ping', async () => {
    const { mod, notify, deleted, req } = setup()
    expect((await mod.remove(req('poster'), '7')).status).toBe(204)
    expect(deleted).toEqual(['7'])
    expect(notify).not.toHaveBeenCalled()
  })

  it('a moderator deletes someone else’s and the webhook hears about it', async () => {
    const { mod, notify, req } = setup()
    expect((await mod.remove(req('mod'), '7')).status).toBe(204)
    expect(notify).toHaveBeenCalledWith('mod deleted build #7 "Melta Bulwark" by poster')
  })

  it('401 / 403 / 404 / 503', async () => {
    const { mod, req } = setup()
    expect((await mod.remove(req(null), '7')).status).toBe(401)
    expect((await mod.remove(req('other'), '7')).status).toBe(403)
    expect((await mod.remove(req('poster'), '8')).status).toBe(404)
    expect((await setup({ fail: true }).mod.remove(req('poster'), '7')).status).toBe(503)
  })

  it('status reports moderator, false when signed out or Discord is down', async () => {
    const { mod, req } = setup()
    expect(await (await mod.status(req('mod'))).json()).toEqual({ moderator: true })
    expect(await (await mod.status(req(null))).json()).toEqual({ moderator: false })
    expect(await (await setup({ fail: true }).mod.status(req('mod'))).json()).toEqual({ moderator: false })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run server/src/buildModeration.test.js`
Expected: FAIL, unresolved import

- [ ] **Step 3: Write the implementation**

```js
// server/src/buildModeration.js
/**
 * Build deletion: the poster may delete their own; a moderator (Admin, Master
 * of the Forge, Mechadendrite Expert, Techmarine, and not revoked — see
 * privileges.js) may delete anyone's. Deletes are soft and land in the
 * version history; a moderator deleting someone else's build pings the
 * webhook.
 */
import { Upstream } from './discordRoles.js'

export function createBuildModeration({ roles, privileges, store, notify = () => {} }) {
  return {
    async status(request) {
      try {
        const user = await roles.identify(request)
        return reply(200, { moderator: user ? (await privileges.forUser(user)).moderator : false })
      } catch {
        return reply(200, { moderator: false })
      }
    },

    async remove(request, id) {
      try {
        const user = await roles.identify(request)
        if (!user) return reply(401, { error: 'Sign in with Discord to delete a build.' })
        const author = await store.buildAuthor(id)
        if (!author) return reply(404, { error: 'Not found.' })
        const own = author.id === user.id
        if (!own && !(await privileges.forUser(user)).moderator) {
          return reply(403, { error: 'Only the poster or a moderator can delete this build.' })
        }
        const build = await store.softDeleteBuild(id, user)
        if (build === 'missing') return reply(404, { error: 'Not found.' })
        if (!own) notify(`${user.username} deleted build #${build.id} "${build.title}" by ${build.author.username}`)
        return new Response(null, { status: 204 })
      } catch (err) {
        if (err instanceof Upstream) return reply(503, { error: 'Discord could not be reached. Try again.' })
        throw err
      }
    },
  }
}

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run server/src/buildModeration.test.js`
Expected: PASS

- [ ] **Step 5: Wire `server/src/index.js`**

Make these edits:

1. Imports (beside the existing ones):
```js
import { createPrivileges } from './privileges.js'
import { createHistoryStore } from './historyStore.js'
import { createPerksHandler } from './perks.js'
import { createBuildModeration } from './buildModeration.js'
import { createNotifier } from './webhook.js'
import { createBakeLoader } from './bake.js'
```
2. Delete the `MOD_ROLE_IDS` constant with its comment, and delete the `isModerator`, `moderatorStatus` and `deleteBuild` functions. Moderator roles now live in `privileges.js`, and `DISCORD_MOD_ROLE_ID` is no longer read.
3. After the `reports` handler block, add:
```js
// Perk corrections, version history, privilege revocation — see perks.js.
// The webhook is the reports one: leadership watches a single channel.
const history = createHistoryStore(pool)
const privileges = createPrivileges({ roles, store: history })
const notify = createNotifier({ url: process.env.REPORTS_WEBHOOK_URL || null, suffix: ` · ${ALLOWED_ORIGIN}/history` })
const perks = createPerksHandler({
  roles,
  privileges,
  store: history,
  notify,
  loadBake: createBakeLoader({
    baseUrl: process.env.BAKE_BASE_URL || 'https://raw.githubusercontent.com/BigZano/salamanders-site/main/src/data/',
  }),
})
const moderation = createBuildModeration({ roles, privileges, store: history, notify })
```
4. In `listBuilds`, hide soft-deleted builds:
```js
  const { rows } = className
    ? await pool.query('select * from builds where deleted_at is null and class_name = $1 order by created_at desc', [className])
    : await pool.query('select * from builds where deleted_at is null order by created_at desc')
```
5. In `Bun.serve` → `fetch`, directly after the `reportsRes` lines:
```js
      const perksRes = await perks(request, url)
      if (perksRes) return cors(perksRes)
```
and replace the two moderation routes:
```js
      if (url.pathname === '/builds/moderator' && request.method === 'GET') return cors(await moderation.status(request))
      …
      if (idMatch && request.method === 'DELETE') return cors(await moderation.remove(request, idMatch[1]))
```
6. Update the file's header comment: "five routes, one table" becomes "builds routes here; reports, perks and moderation live in their own modules".

- [ ] **Step 6: Document the env and schema step**

Append to `server/.env.example`:
```
# Perk corrections: where the API reads the wiki bake (defaults to main on GitHub).
# BAKE_BASE_URL=https://raw.githubusercontent.com/BigZano/salamanders-site/main/src/data/
# Role overrides (defaults are the live guild's ids):
# TECHMARINE_ROLE_ID=  MECHADENDRITE_ROLE_ID=  FORGE_ROLE_ID=  HIERARCHY_ROLE_ID=
```
In `server/README.md`, under "Existing databases", add: "Perk corrections (2026-09-27) added tables and two `builds` columns; re-run `schema.sql` (idempotent), then seed once with `docker compose exec -T api bun run src/seed.js < ../src/data/perk-corrections.json`. `DISCORD_MOD_ROLE_ID` is no longer read; moderator roles live in `src/privileges.js`."

- [ ] **Step 7: Run the full suite**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add server/src/buildModeration.js server/src/buildModeration.test.js server/src/index.js server/.env.example server/README.md
git commit -m "feat(builds): soft delete into history, Techmarines moderate, revocation applies"
```

---

### Task 7: Site data layer (snapshot, API client, store)

**Files:**
- Create: `src/data/perk-corrections.json` (converted from `src/data/weapon-perk-overrides.json`, which is then deleted)
- Create: `src/lib/perksApi.js`, `src/stores/perkCorrections.js`, `scripts/snapshot-perk-corrections.mjs`
- Test: `src/stores/perkCorrections.test.js`
- Modify: `src/lib/weapons.js`, `src/lib/weapons.test.js`, `package.json`, `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: `applyWeaponCorrections`, `applyClassCorrections` via `../../server/src/perkCorrectionsCore.js`; `request` from `src/lib/buildsApi.js`; `detailsFor` from `src/stores/planner.js`.
- Produces:
  - `perksApi`: `getCorrections()`, `getPrivileges(token)`, `submitCorrection(c, token)`, `revertCorrection(id, note, token)`, `getHistory({subject,q,before}, token)`, `revokePrivileges(discordId, {reason, username}, token)`, `reinstatePrivileges(discordId, note, token)`
  - `usePerkCorrections()` store: state `{doc, live, privileges}`; getters `weaponTree(name, tree)`, `classPerks(className)`, `describe(className, perkName)`, `canEdit`; actions `load()`, `loadPrivileges(token)`, `submit(correction, token)`, `revert(id, note, token)`
  - `weapons.js`: `resolveWeapon` returns the raw tree; new `perkSuggestions() → [{name, description}]`

- [ ] **Step 1: Convert the overrides file into the document shape**

Run from repo root:
```bash
node -e '
const o = require("./src/data/weapon-perk-overrides.json").weapons
const doc = { version: "2026-09-27T00:00:00.000Z", weapons: {}, classes: {} }
let id = 0
const at = "2026-09-27T00:00:00.000Z"
for (const [w, tiers] of Object.entries(o)) for (const [q, { remove = [], add = [] }] of Object.entries(tiers)) {
  for (const n of remove) (doc.weapons[w] ??= []).push({ id: ++id, op: "remove", quality: q, perkName: n, description: null, createdAt: at })
  for (const p of add) (doc.weapons[w] ??= []).push({ id: ++id, op: "add", quality: q, perkName: p.name, description: p.description, createdAt: at })
}
require("fs").writeFileSync("src/data/perk-corrections.json", JSON.stringify(doc, null, 2) + "\n")
console.log(id, "corrections")'
git rm -q src/data/weapon-perk-overrides.json
```
Expected: `45 corrections`

- [ ] **Step 2: Write the failing store test**

```js
// src/stores/perkCorrections.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import baked from '../data/weapon-trees.json'
import bundled from '../data/perk-corrections.json'

vi.mock('../lib/perksApi', () => ({
  getCorrections: vi.fn(),
  getPrivileges: vi.fn(),
  submitCorrection: vi.fn(),
  revertCorrection: vi.fn(),
}))
import * as api from '../lib/perksApi'
import { usePerkCorrections } from './perkCorrections'

const names = (tree, q) => tree.perks.filter((p) => p.quality === q).map((p) => p.name)

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
})

describe('perk corrections store', () => {
  it('renders the bundled snapshot before (or without) the API', () => {
    const s = usePerkCorrections()
    const occ = s.weaponTree('Occulus Bolt Carbine', baked.weapons['Occulus Bolt Carbine'])
    expect(names(occ, 'Standard')).toEqual(['Great Might', 'Remote Threat'])
    expect(names(occ, 'Relic')).not.toContain('Tyranid Eliminator')
    expect(s.canEdit).toBe(false)
  })

  // A removal the bake no longer has means the wiki caught up: drop that correction.
  it('every bundled removal still names a perk in the bake', () => {
    for (const [weapon, list] of Object.entries(bundled.weapons)) {
      expect(baked.weapons[weapon], weapon).toBeTruthy()
      for (const c of list.filter((c) => c.op === 'remove')) {
        const inBake = baked.weapons[weapon].perks.some((p) => p.quality === c.quality && p.name === c.perkName)
        expect(inBake, `${weapon} / ${c.quality} / ${c.perkName}`).toBe(true)
      }
    }
  })

  it('an API failure keeps the snapshot and disables editing', async () => {
    api.getCorrections.mockRejectedValue(new Error('down'))
    api.getPrivileges.mockResolvedValue({ editor: true })
    const s = usePerkCorrections()
    await s.load()
    await s.loadPrivileges('tok')
    expect(s.live).toBe(false)
    expect(s.canEdit).toBe(false)
    expect(s.doc).toBe(bundled)
  })

  it('editing needs a live document and editor privileges', async () => {
    api.getCorrections.mockResolvedValue({ version: 'v', weapons: {}, classes: {} })
    api.getPrivileges.mockResolvedValue({ editor: true })
    const s = usePerkCorrections()
    await s.load()
    await s.loadPrivileges('tok')
    expect(s.canEdit).toBe(true)
  })

  it('submit shows the change immediately, then adopts the server document', async () => {
    let resolve
    api.submitCorrection.mockReturnValue(new Promise((r) => (resolve = r)))
    const s = usePerkCorrections()
    const c = { kind: 'weapon', target: 'Las Fusil', quality: 'Relic', op: 'add', perkName: 'Zeal', description: 'z' }
    const pending = s.submit(c, 'tok')
    expect(names(s.weaponTree('Las Fusil', baked.weapons['Las Fusil']), 'Relic')).toContain('Zeal')
    const server = { version: 'v2', weapons: { 'Las Fusil': [{ id: 99, op: 'add', quality: 'Relic', perkName: 'Zeal', description: 'z', createdAt: 't' }] }, classes: {} }
    resolve(server)
    await pending
    expect(s.doc).toBe(server)
  })

  it('a refused submit rolls back and rethrows', async () => {
    api.submitCorrection.mockRejectedValue(Object.assign(new Error('Your site privileges have been revoked.'), { status: 403 }))
    const s = usePerkCorrections()
    const before = s.doc
    await expect(s.submit({ kind: 'weapon', target: 'Las Fusil', quality: 'Relic', op: 'add', perkName: 'Zeal', description: 'z' }, 'tok')).rejects.toThrow(/revoked/)
    expect(s.doc).toBe(before)
  })

  it('class corrections change the planner description', async () => {
    const s = usePerkCorrections()
    const perk = Object.keys(s.classPerks('Tactical'))[0]
    api.submitCorrection.mockImplementation(async () => ({ version: 'v', weapons: {}, classes: { Tactical: [{ id: 1, op: 'edit', quality: null, perkName: perk, description: 'fixed', createdAt: 't' }] } }))
    await s.submit({ kind: 'class', target: 'Tactical', op: 'edit', perkName: perk, description: 'fixed' }, 'tok')
    expect(s.describe('Tactical', perk)).toBe('fixed')
    expect(s.classPerks('Tactical')[perk].corrected).toEqual({ id: 1, createdAt: 't' })
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/stores/perkCorrections.test.js`
Expected: FAIL, "Failed to resolve import ./perkCorrections"

- [ ] **Step 4: Write the API client and store**

```js
// src/lib/perksApi.js
/**
 * Client for perk corrections, version history and privileges
 * (server/src/perks.js). Only GET /perk-corrections is public; everything
 * else needs a live Discord token and is re-checked by the server.
 */
import { request } from './buildsApi'

export const getCorrections = () => request('/perk-corrections')
export const getPrivileges = (token) => request('/privileges/me', { token })
export const submitCorrection = (correction, token) => request('/perk-corrections', { method: 'POST', token, body: correction })
export const revertCorrection = (id, note, token) =>
  request(`/perk-corrections/${id}/revert`, { method: 'POST', token, body: note ? { note } : {} })

export function getHistory({ subject, q, before } = {}, token) {
  const p = new URLSearchParams()
  if (subject) p.set('subject', subject)
  if (q) p.set('q', q)
  if (before) p.set('before', String(before))
  const qs = p.toString()
  return request(`/history${qs ? `?${qs}` : ''}`, { token })
}

export const revokePrivileges = (discordId, { reason, username }, token) =>
  request(`/privileges/${discordId}/revoke`, { method: 'POST', token, body: { reason, username } })
export const reinstatePrivileges = (discordId, note, token) =>
  request(`/privileges/${discordId}/reinstate`, { method: 'POST', token, body: note ? { reason: note } : {} })
```

```js
// src/stores/perkCorrections.js
import { defineStore } from 'pinia'
import bundled from '../data/perk-corrections.json'
import { applyWeaponCorrections, applyClassCorrections } from '../../server/src/perkCorrectionsCore.js'
import * as api from '../lib/perksApi'
import { detailsFor } from './planner'

// Perk corrections over the wiki bake. Starts from the snapshot bundled at
// deploy time (works offline); load() swaps in the live document. Editing
// is offered only against a live document, to someone the server calls an
// editor — the server re-checks every write regardless.
let pendingId = 0

function withPending(doc, c) {
  const bucket = c.kind === 'class' ? 'classes' : 'weapons'
  const entry = {
    id: `pending-${++pendingId}`,
    op: c.op,
    quality: c.quality ?? null,
    perkName: c.perkName,
    description: c.description ?? null,
    createdAt: new Date().toISOString(),
  }
  return { ...doc, [bucket]: { ...doc[bucket], [c.target]: [...(doc[bucket][c.target] || []), entry] } }
}

export const usePerkCorrections = defineStore('perkCorrections', {
  state: () => ({ doc: bundled, live: false, privileges: null }),
  getters: {
    weaponTree: (s) => (name, tree) => (tree ? applyWeaponCorrections(tree, s.doc.weapons[name] || []) : tree),
    classPerks: (s) => (className) => applyClassCorrections(detailsFor(className).perks, s.doc.classes[className] || []),
    describe() {
      return (className, perkName) => this.classPerks(className)[perkName]?.description || ''
    },
    canEdit: (s) => s.live && !!s.privileges?.editor,
  },
  actions: {
    async load() {
      try {
        this.doc = await api.getCorrections()
        this.live = true
      } catch {
        this.live = false
      }
    },
    async loadPrivileges(token) {
      if (!token) {
        this.privileges = null
        return
      }
      try {
        this.privileges = await api.getPrivileges(token)
      } catch {
        this.privileges = null
      }
    },
    async submit(correction, token) {
      const before = this.doc
      this.doc = withPending(before, correction)
      try {
        this.doc = await api.submitCorrection(correction, token)
      } catch (err) {
        this.doc = before
        throw err
      }
    },
    async revert(id, note, token) {
      this.doc = await api.revertCorrection(id, note, token)
    },
  },
})
```

- [ ] **Step 5: Drop the static override layer from `weapons.js`**

In `src/lib/weapons.js`: remove `import overrides from '../data/weapon-perk-overrides.json'`, the `applyPerkOverrides` function with its comment, and the two `applyPerkOverrides(...)` wrappers in `resolveWeapon` (return `{ ...hit, source: 'baked' }` and `{ ...live, source: 'wiki' }` as before). Add:

```js
/** Every perk name in the bake with its first-seen text — the "+ Add perk" autocomplete. */
export function perkSuggestions() {
  const seen = new Map()
  for (const tree of Object.values(baked.weapons)) {
    for (const p of tree.perks) if (!seen.has(p.name)) seen.set(p.name, p.description)
  }
  return [...seen].map(([name, description]) => ({ name, description })).sort((a, b) => a.name.localeCompare(b.name))
}
```

Replace `src/lib/weapons.test.js` with:
```js
import { describe, it, expect } from 'vitest'
import { resolveWeapon, perkSuggestions } from './weapons'

describe('weapons', () => {
  it('resolveWeapon returns the raw bake; corrections are applied by the store', async () => {
    const w = await resolveWeapon('Occulus Bolt Carbine')
    expect(w.source).toBe('baked')
    expect(w.perks.some((p) => p.name === 'Tyranid Eliminator')).toBe(true)
  })

  it('perkSuggestions lists each perk name once, sorted', () => {
    const s = perkSuggestions()
    const names = s.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names)
    expect(s.find((p) => p.name === 'Divine Might').description).toBe('Damage increases by 10%')
  })
})
```

- [ ] **Step 6: Snapshot script and deploy step**

```js
// scripts/snapshot-perk-corrections.mjs
/**
 * Refresh src/data/perk-corrections.json from the live API before a build,
 * so the site's offline fallback is current. Never fails the build: on any
 * problem the committed snapshot stays.
 *
 *   VITE_BUILDS_API_URL=https://… bun run perks:snapshot
 */
import { writeFile } from 'node:fs/promises'

const OUT = new URL('../src/data/perk-corrections.json', import.meta.url)
const base = process.env.VITE_BUILDS_API_URL

if (!base) {
  console.log('VITE_BUILDS_API_URL unset — keeping the committed perk corrections snapshot.')
} else {
  try {
    const res = await fetch(`${base}/perk-corrections`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`API responded ${res.status}`)
    const doc = await res.json()
    if (!doc?.weapons || !doc?.classes) throw new Error('unexpected document shape')
    await writeFile(OUT, JSON.stringify(doc, null, 2) + '\n')
    const n = [...Object.values(doc.weapons), ...Object.values(doc.classes)].reduce((a, l) => a + l.length, 0)
    console.log(`Perk corrections snapshot: ${n} active corrections (${doc.version}).`)
  } catch (err) {
    console.warn(`Keeping the committed perk corrections snapshot: ${err.message}`)
  }
}
```

In `package.json` scripts, add `"perks:snapshot": "node scripts/snapshot-perk-corrections.mjs",`.

In `.github/workflows/deploy.yml`, before `- run: bun run build`, add:
```yaml
      - name: Refresh perk corrections snapshot (offline fallback)
        run: node scripts/snapshot-perk-corrections.mjs
        env:
          VITE_BUILDS_API_URL: ${{ vars.VITE_BUILDS_API_URL }}
```

- [ ] **Step 7: Run the suite**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/data/perk-corrections.json src/lib/perksApi.js src/stores/perkCorrections.js src/stores/perkCorrections.test.js src/lib/weapons.js src/lib/weapons.test.js scripts/snapshot-perk-corrections.mjs package.json .github/workflows/deploy.yml
git commit -m "feat(perks): site store for live corrections with bundled fallback"
```

---

### Task 8: Render through corrections, with a "Corrected" tag

**Files:**
- Modify: `src/components/WeaponTree.vue`, `src/views/Planner.vue`, `src/components/AppNav.vue`
- Test: `src/components/WeaponTree.test.js` (new)

**Interfaces:**
- Consumes: `usePerkCorrections` (Task 7), `useAuth`.
- Produces: in `WeaponTree`, perk ids are `${slug(quality)}-${slug(name)}-${p.key}`. For bake perks `key` equals the old index, so saved builds keep their picks. `AppNav` loads the document on mount and privileges whenever the token changes.

- [ ] **Step 1: Write the failing component test**

```js
// src/components/WeaponTree.test.js
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import WeaponTree from './WeaponTree.vue'
import { usePerkCorrections } from '../stores/perkCorrections'
import { usePlanner } from '../stores/planner'

const data = {
  budget: 5,
  perks: [
    { name: 'A', quality: 'Standard', description: 'a' },
    { name: 'B', quality: 'Standard', description: 'b' },
  ],
}

beforeEach(() => setActivePinia(createPinia()))

describe('WeaponTree with corrections', () => {
  it('keeps bake ids stable when an earlier perk is removed', async () => {
    const s = usePerkCorrections()
    s.doc = { version: 'v', classes: {}, weapons: { Test: [{ id: 1, op: 'remove', quality: 'Standard', perkName: 'A', description: null, createdAt: 't' }] } }
    const w = mount(WeaponTree, { props: { weapon: 'Test', data } })
    const nodes = w.findAll('.wnode')
    expect(nodes.map((n) => n.text())).toEqual(['B'])
    await nodes[0].trigger('click')
    // B was index 1 in the bake: its id must still end in -1.
    expect(Object.keys(usePlanner().weaponPerks.Test)).toEqual(['standard-b-1'])
  })

  it('tags corrected perks in the detail panel', async () => {
    const s = usePerkCorrections()
    s.doc = { version: 'v', classes: {}, weapons: { Test: [{ id: 1, op: 'edit', quality: 'Standard', perkName: 'B', description: 'fixed', createdAt: '2026-09-27T12:00:00.000Z' }] } }
    const w = mount(WeaponTree, { props: { weapon: 'Test', data } })
    await w.findAll('.wnode')[1].trigger('mouseenter')
    expect(w.find('.wdetail-desc').text()).toBe('fixed')
    expect(w.find('.corrected-tag').text()).toContain('Corrected in game')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/WeaponTree.test.js`
Expected: FAIL: node text still shows `A`, and `.corrected-tag` isn't found

- [ ] **Step 3: Update `WeaponTree.vue`**

In `<script setup>`, add the import and replace the `perks` computed:
```js
import { usePerkCorrections } from '../stores/perkCorrections'
const corrections = usePerkCorrections()
const tree = computed(() => corrections.weaponTree(props.weapon, props.data))

// Ids come from each perk's stable `key` (its bake index, or c<id> for an
// added perk) so a correction removing a perk never shifts saved picks.
const perks = computed(() =>
  tree.value.perks.map((p) => ({ ...p, id: `${slug(p.quality)}-${slug(p.name)}-${p.key}` })),
)
const correctedOn = (p) => new Date(p.corrected.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
```
In the template, inside `.wdetail-top` after the name:
```html
        <span v-if="inspected.corrected" class="corrected-tag" :title="`Corrected from an in-game check · ${correctedOn(inspected)}`">
          Corrected in game · {{ correctedOn(inspected) }}
        </span>
```
Add a small dot on corrected nodes, inside the `.wnode` button after the name:
```html
              <span v-if="p.corrected" class="wnode-fix" aria-label="Corrected in game" />
```
Styles:
```css
.corrected-tag {
  margin-left: auto;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 0.58rem;
  color: var(--color-gold);
  border: 1px solid rgba(214, 170, 72, 0.45);
  border-radius: 2px;
  padding: 0.1rem 0.35rem;
}
.wnode-fix {
  margin-left: auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-gold);
}
```

- [ ] **Step 4: Update `Planner.vue`'s popout text**

In `<script setup>`: `import { usePerkCorrections } from '../stores/perkCorrections'`, `const corrections = usePerkCorrections()`, and change `hoveredText` to:
```js
const hoveredText = computed(() =>
  hovered.value ? corrections.describe(planner.activeClass, hovered.value.name) : '',
)
const hoveredCorrected = computed(() =>
  hovered.value ? !!corrections.classPerks(planner.activeClass)[hovered.value.name]?.corrected : false,
)
```
In the popout template, after `.pp-meta`:
```html
          <p v-if="hoveredCorrected" class="pp-fixed">Corrected in game</p>
```
Style:
```css
.pp-fixed {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 0.58rem;
  color: var(--color-gold);
  margin: 0.2rem 0 0.3rem;
}
```
Remove `describePerk` from the `../stores/planner` import in `Planner.vue` if it's no longer used there.

- [ ] **Step 5: Load corrections and privileges in `AppNav.vue`**

```js
import { onMounted } from 'vue'
import { usePerkCorrections } from '../stores/perkCorrections'
const corrections = usePerkCorrections()
onMounted(() => corrections.load())
// auth.token reads storage and isn't reactive; auth.member is (sign-out clears it).
watch(() => auth.member, () => corrections.loadPrivileges(auth.token), { immediate: true })
```
Add `onMounted` to the existing `vue` import rather than a second import line. Extend `links` so history viewers get the tab regardless of the archive's member check:
```js
const links = computed(() => {
  const out = auth.member?.isMember
    ? [
        ...baseLinks,
        { to: '/accolades', label: 'Accolades', section: true },
        { to: '/ranks', label: 'Ranks', section: true },
        { to: '/reports', label: 'Reports', section: true },
      ]
    : [...baseLinks]
  if (corrections.privileges?.historyViewer) out.push({ to: '/history', label: 'Version History', section: true })
  return out
})
```

- [ ] **Step 6: Run the suite**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/components/WeaponTree.vue src/components/WeaponTree.test.js src/views/Planner.vue src/components/AppNav.vue
git commit -m "feat(perks): render weapon and class perks through live corrections"
```

---

### Task 9: Editing UI

**Files:**
- Create: `src/components/PerkEditPanel.vue`
- Test: `src/components/PerkEditPanel.test.js`
- Modify: `src/components/WeaponTree.vue`, `src/views/Planner.vue`

**Interfaces:**
- Consumes: `usePerkCorrections().submit(correction, token)`, `useAuth().token`, `perkSuggestions()` (Task 7).
- Produces: `<PerkEditPanel kind target quality perk suggestions @done>`. Props: `kind: 'weapon'|'class'`, `target: string`, `quality: string|null`, `perk: {name, description}|null` (null means add mode), `suggestions: {name, description}[]` (default `[]`). It emits `done` after a successful save or on cancel.

- [ ] **Step 1: Write the failing test**

```js
// src/components/PerkEditPanel.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import PerkEditPanel from './PerkEditPanel.vue'
import { usePerkCorrections } from '../stores/perkCorrections'

// The real auth store reads a Discord token from storage; the panel only needs one.
vi.mock('../stores/auth', () => ({ useAuth: () => ({ token: 'tok' }) }))

beforeEach(() => setActivePinia(createPinia()))

describe('PerkEditPanel', () => {
  it('edit text submits an edit with the note', async () => {
    const s = usePerkCorrections()
    s.submit = vi.fn().mockResolvedValue()
    const w = mount(PerkEditPanel, { props: { kind: 'weapon', target: 'Las Fusil', quality: 'Relic', perk: { name: 'Head Hunter', description: 'old' } } })
    await w.get('button.pe-edit').trigger('click')
    await w.get('textarea').setValue('Headshots deal 10% more Damage')
    await w.get('input.pe-note').setValue('patch 14.1')
    await w.get('form').trigger('submit')
    await flushPromises()
    expect(s.submit).toHaveBeenCalledWith(
      { kind: 'weapon', target: 'Las Fusil', quality: 'Relic', op: 'edit', perkName: 'Head Hunter', description: 'Headshots deal 10% more Damage', note: 'patch 14.1' },
      'tok',
    )
    expect(w.emitted('done')).toHaveLength(1)
  })

  it('remove needs a confirm click, then submits a remove', async () => {
    const s = usePerkCorrections()
    s.submit = vi.fn().mockResolvedValue()
    const w = mount(PerkEditPanel, { props: { kind: 'weapon', target: 'Las Fusil', quality: 'Relic', perk: { name: 'Head Hunter', description: 'x' } } })
    await w.get('button.pe-remove').trigger('click')
    expect(s.submit).not.toHaveBeenCalled()
    await w.get('button.pe-confirm').trigger('click')
    await flushPromises()
    expect(s.submit.mock.calls[0][0]).toMatchObject({ op: 'remove', perkName: 'Head Hunter' })
  })

  it('add mode prefills the text of a known perk name', async () => {
    const w = mount(PerkEditPanel, {
      props: { kind: 'weapon', target: 'Las Fusil', quality: 'Relic', perk: null, suggestions: [{ name: 'Divine Might', description: 'Damage increases by 10%' }] },
    })
    await w.get('input.pe-name').setValue('Divine Might')
    expect(w.get('textarea').element.value).toBe('Damage increases by 10%')
  })

  it('class perks offer edit only', () => {
    const w = mount(PerkEditPanel, { props: { kind: 'class', target: 'Tactical', quality: null, perk: { name: 'Stim', description: 's' } } })
    expect(w.find('button.pe-remove').exists()).toBe(false)
    expect(w.find('button.pe-edit').exists()).toBe(true)
  })

  it('shows the server error and stays open when a save is refused', async () => {
    const s = usePerkCorrections()
    s.submit = vi.fn().mockRejectedValue(new Error('Your site privileges have been revoked.'))
    const w = mount(PerkEditPanel, { props: { kind: 'weapon', target: 'Las Fusil', quality: 'Relic', perk: { name: 'Head Hunter', description: 'x' } } })
    await w.get('button.pe-edit').trigger('click')
    await w.get('form').trigger('submit')
    await flushPromises()
    expect(w.get('.pe-error').text()).toContain('revoked')
    expect(w.emitted('done')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/PerkEditPanel.test.js`
Expected: FAIL, unresolved import

- [ ] **Step 3: Write the component**

```vue
<!-- src/components/PerkEditPanel.vue -->
<script setup>
import { ref, watch } from 'vue'
import { usePerkCorrections } from '../stores/perkCorrections'
import { useAuth } from '../stores/auth'

// Edit / remove an existing perk, or (perk = null) add one to a tier. The
// store applies the change at once; a refusal rolls it back and lands here.
const props = defineProps({
  kind: { type: String, required: true },
  target: { type: String, required: true },
  quality: { type: String, default: null },
  perk: { type: Object, default: null },
  suggestions: { type: Array, default: () => [] },
})
const emit = defineEmits(['done'])
const corrections = usePerkCorrections()
const auth = useAuth()

const mode = ref(props.perk ? 'idle' : 'add') // idle | edit | remove | add
const name = ref('')
const text = ref(props.perk?.description || '')
const note = ref('')
const error = ref('')
const busy = ref(false)

watch(
  () => props.perk,
  (p) => {
    mode.value = p ? 'idle' : 'add'
    text.value = p?.description || ''
    note.value = ''
    error.value = ''
  },
)
watch(name, (n) => {
  const hit = props.suggestions.find((s) => s.name === n.trim())
  if (hit) text.value = hit.description
})

async function save(op) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await corrections.submit(
      {
        kind: props.kind,
        target: props.target,
        quality: props.kind === 'weapon' ? props.quality : null,
        op,
        perkName: op === 'add' ? name.value.trim() : props.perk.name,
        description: op === 'remove' ? null : text.value.trim(),
        note: note.value.trim() || null,
      },
      auth.token,
    )
    emit('done')
  } catch (err) {
    error.value = err.message || 'That did not save.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="pe">
    <div v-if="mode === 'idle'" class="pe-actions">
      <button type="button" class="pe-edit" @click="mode = 'edit'">Edit text</button>
      <button v-if="kind === 'weapon'" type="button" class="pe-remove" @click="mode = 'remove'">Remove from this tier</button>
    </div>

    <div v-else-if="mode === 'remove'" class="pe-actions">
      <span>Remove {{ perk.name }} from {{ quality }}?</span>
      <input v-model="note" class="pe-note" maxlength="200" placeholder="Note (optional), e.g. checked in game, patch 14.1" aria-label="Note" />
      <button type="button" class="pe-confirm" :disabled="busy" @click="save('remove')">Remove</button>
      <button type="button" @click="mode = 'idle'">Cancel</button>
    </div>

    <form v-else class="pe-form" @submit.prevent="save(mode === 'add' ? 'add' : 'edit')">
      <template v-if="mode === 'add'">
        <label class="pe-label" for="pe-name">Perk name</label>
        <input id="pe-name" v-model="name" class="pe-name" maxlength="80" list="pe-suggest" required />
        <datalist id="pe-suggest">
          <option v-for="s in suggestions" :key="s.name" :value="s.name" />
        </datalist>
      </template>
      <label class="pe-label" for="pe-text">Perk text</label>
      <textarea id="pe-text" v-model="text" rows="3" maxlength="500" required />
      <input v-model="note" class="pe-note" maxlength="200" placeholder="Note (optional), e.g. checked in game, patch 14.1" aria-label="Note" />
      <div class="pe-actions">
        <button type="submit" :disabled="busy">Save</button>
        <button type="button" @click="perk ? (mode = 'idle') : emit('done')">Cancel</button>
      </div>
    </form>

    <p v-if="error" class="pe-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.pe {
  margin-top: 0.7rem;
  padding-top: 0.7rem;
  border-top: 1px dashed var(--color-ash);
}
.pe-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  color: #c3d0c6;
}
.pe-form {
  display: grid;
  gap: 0.4rem;
}
.pe-label {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 0.58rem;
  color: var(--color-smoke);
}
.pe input,
.pe textarea {
  background: rgba(5, 10, 8, 0.7);
  border: 1px solid var(--color-ash);
  color: var(--color-bone);
  border-radius: 2px;
  padding: 0.4rem 0.5rem;
  font: inherit;
  font-size: 0.85rem;
}
.pe button {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.68rem;
  color: var(--color-bone);
  background: transparent;
  border: 1px solid var(--color-ash-2);
  border-radius: 2px;
  padding: 0.35rem 0.6rem;
  cursor: pointer;
}
.pe .pe-confirm,
.pe .pe-remove:hover {
  border-color: var(--color-ember);
  color: var(--color-ember);
}
.pe-error {
  margin-top: 0.4rem;
  color: var(--color-ember);
  font-size: 0.8rem;
}
</style>
```

- [ ] **Step 4: Host it in `WeaponTree.vue`**

Script:
```js
import PerkEditPanel from './PerkEditPanel.vue'
import { perkSuggestions } from '../lib/weapons'
const suggestions = perkSuggestions()
const adding = ref(null) // quality being added to
```
Tier header becomes:
```html
          <div class="wtier-head">
            {{ t.quality }}
            <button v-if="corrections.canEdit" type="button" class="wtier-add" :aria-label="`Add a perk to ${t.quality}`" @click="adding = t.quality">+</button>
          </div>
```
Inside `.wdetail`, after `.wdetail-desc`:
```html
      <PerkEditPanel
        v-if="corrections.canEdit"
        :key="inspected.id"
        kind="weapon"
        :target="weapon"
        :quality="inspected.quality"
        :perk="{ name: inspected.name, description: inspected.description }"
        @done="inspected = perks.find((p) => p.name === inspected.name && p.quality === inspected.quality) || null"
      />
```
After the `.wdetail` block:
```html
    <div v-if="adding" class="wdetail" :data-q="slug(adding)">
      <div class="wdetail-top">
        <span class="wdetail-q">{{ adding }}</span>
        <strong class="wdetail-name">Add a perk</strong>
      </div>
      <PerkEditPanel kind="weapon" :target="weapon" :quality="adding" :perk="null" :suggestions="suggestions" @done="adding = null" />
    </div>
```
Style:
```css
.wtier-add {
  margin-left: 0.4rem;
  border: 0;
  background: rgba(10, 20, 16, 0.35);
  color: inherit;
  border-radius: 2px;
  width: 1.2rem;
  cursor: pointer;
  font-weight: 800;
}
```

- [ ] **Step 5: Host it in `Planner.vue`'s perk-author panel**

Import `PerkEditPanel`. Inside `.pa-body`, after the textarea:
```html
            <PerkEditPanel
              v-if="corrections.canEdit"
              :key="editingPerk.name"
              kind="class"
              :target="planner.activeClass"
              :perk="{ name: editingPerk.name, description: corrections.describe(planner.activeClass, editingPerk.name) }"
            />
```

- [ ] **Step 6: Run the suite**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/components/PerkEditPanel.vue src/components/PerkEditPanel.test.js src/components/WeaponTree.vue src/views/Planner.vue
git commit -m "feat(perks): in-place perk editing for forge and leadership roles"
```

---

### Task 10: Version History page and privileges panel

**Files:**
- Create: `src/views/History.vue`, `src/lib/historyLabels.js`
- Test: `src/lib/historyLabels.test.js`
- Modify: `src/router.js`

**Interfaces:**
- Consumes: `getHistory`, `revokePrivileges`, `reinstatePrivileges` (Task 7), `usePerkCorrections().revert/privileges`, `useAuth()`.
- Produces: `historyLabel(event) → string` in `src/lib/historyLabels.js`; route `/history` named `history`.

- [ ] **Step 1: Write the failing label test**

```js
// src/lib/historyLabels.test.js
import { describe, it, expect } from 'vitest'
import { historyLabel } from './historyLabels'

const actor = { id: '1', username: 'tm' }
describe('historyLabel', () => {
  it.each([
    [{ subject: 'perk_correction', action: 'created', actor, snapshot: { target: 'Las Fusil', quality: 'Relic', op: 'remove', perkName: 'Perpetual Velocity' } }, 'tm removed Perpetual Velocity — Las Fusil / Relic'],
    [{ subject: 'perk_correction', action: 'reverted', actor, snapshot: { target: 'Tactical', quality: null, op: 'edit', perkName: 'Stim' } }, 'tm reverted: edited Stim — Tactical'],
    [{ subject: 'build', action: 'deleted', actor, snapshot: { title: 'Melta Bulwark', author: { username: 'poster' } } }, 'tm deleted build "Melta Bulwark" by poster'],
    [{ subject: 'privilege', action: 'revoked', actor, snapshot: { username: 'bad', reason: 'vandalism' } }, 'tm revoked privileges for bad: vandalism'],
    [{ subject: 'privilege', action: 'reinstated', actor, snapshot: { username: 'bad' } }, 'tm reinstated privileges for bad'],
  ])('%#', (event, want) => {
    expect(historyLabel(event)).toBe(want)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/lib/historyLabels.test.js`
Expected: FAIL, unresolved import

- [ ] **Step 3: Write the labels**

```js
// src/lib/historyLabels.js
// One-line summaries for Version History entries (server/src/perks.js events).
const PAST = { add: 'added', remove: 'removed', edit: 'edited' }
const where = (s) => `${s.target}${s.quality ? ` / ${s.quality}` : ''}`

export function historyLabel(e) {
  const who = e.actor.username
  const s = e.snapshot || {}
  if (e.subject === 'perk_correction') {
    const what = `${PAST[s.op]} ${s.perkName} — ${where(s)}`
    return e.action === 'reverted' ? `${who} reverted: ${what}` : `${who} ${what}`
  }
  if (e.subject === 'build') return `${who} deleted build "${s.title}" by ${s.author?.username}`
  if (e.action === 'revoked') return `${who} revoked privileges for ${s.username}: ${s.reason}`
  return `${who} reinstated privileges for ${s.username}`
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/lib/historyLabels.test.js`
Expected: PASS

- [ ] **Step 5: Write the view**

```vue
<!-- src/views/History.vue -->
<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useAuth } from '../stores/auth'
import { usePerkCorrections } from '../stores/perkCorrections'
import * as api from '../lib/perksApi'
import { historyLabel } from '../lib/historyLabels'

// Version History: every perk correction, soft-deleted build and privilege
// change, newest first. The server decides who sees it; this page only
// hides what the caller can't use.
const auth = useAuth()
const corrections = usePerkCorrections()
const FILTERS = [
  { key: null, label: 'All' },
  { key: 'perk_correction', label: 'Perks' },
  { key: 'build', label: 'Builds' },
  { key: 'privilege', label: 'Privileges' },
]
const subject = ref(null)
const q = ref('')
const events = ref([])
const next = ref(null)
const revocations = ref([])
const error = ref('')
const openId = ref(null)
const revoking = ref(null) // event whose actor is being revoked
const reason = ref('')
const busy = ref(false)

const canRevoke = computed(() => !!corrections.privileges?.revoker)
const me = computed(() => auth.member?.id)

async function load(more = false) {
  error.value = ''
  if (!auth.token) return
  try {
    const page = await api.getHistory({ subject: subject.value, q: q.value.trim(), before: more ? next.value : null }, auth.token)
    events.value = more ? [...events.value, ...page.events] : page.events
    next.value = page.next
    revocations.value = page.revocations
  } catch (err) {
    error.value = err.status === 403 ? 'Version History is restricted to the forge and Legion leadership.' : err.message
  }
}
onMounted(() => load())
watch(subject, () => load())
let t
watch(q, () => {
  clearTimeout(t)
  t = setTimeout(() => load(), 300)
})

async function run(fn) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await fn()
    await load()
  } catch (err) {
    error.value = err.message || 'That did not go through.'
  } finally {
    busy.value = false
  }
}
const revert = (e) => run(() => corrections.revert(Number(e.subjectId), null, auth.token))
const revoke = () =>
  run(async () => {
    await api.revokePrivileges(revoking.value.actor.id, { reason: reason.value.trim(), username: revoking.value.actor.username }, auth.token)
    revoking.value = null
    reason.value = ''
  })
const reinstate = (r) => run(() => api.reinstatePrivileges(r.discordId, null, auth.token))
const when = (d) => new Date(d).toLocaleString()
</script>

<template>
  <section class="hist">
    <header class="hist-head">
      <p class="eyebrow">The Forge</p>
      <h1 class="hist-title">Version History</h1>
      <p class="hist-intro">Every perk correction, deleted build and privilege change. Nothing here is ever removed.</p>
    </header>

    <p v-if="!auth.signedIn" class="hist-empty">Sign in with Discord to view the history.</p>
    <template v-else>
      <div class="hist-tools">
        <button v-for="f in FILTERS" :key="f.label" type="button" class="hist-filter" :class="{ on: subject === f.key }" @click="subject = f.key">
          {{ f.label }}
        </button>
        <input v-model="q" type="search" class="hist-search" placeholder="Weapon, class, perk or build…" aria-label="Search history" />
      </div>

      <p v-if="error" class="hist-error" role="alert">{{ error }}</p>

      <section v-if="canRevoke && revocations.length" class="hist-revoked">
        <h2>Revoked privileges</h2>
        <ul>
          <li v-for="r in revocations" :key="r.id">
            <strong>{{ r.username }}</strong> — {{ r.reason }} <span class="hist-meta">by {{ r.revokedBy.username }}, {{ when(r.createdAt) }}</span>
            <button type="button" :disabled="busy" @click="reinstate(r)">Reinstate</button>
          </li>
        </ul>
      </section>

      <ol class="hist-list">
        <li v-for="e in events" :key="e.id" class="hist-item" :data-subject="e.subject">
          <button type="button" class="hist-line" :aria-expanded="openId === e.id" @click="openId = openId === e.id ? null : e.id">
            <span class="hist-when">{{ when(e.createdAt) }}</span>
            <span class="hist-what">{{ historyLabel(e) }}</span>
          </button>
          <div v-if="openId === e.id" class="hist-detail">
            <p v-if="e.note" class="hist-note">Note: {{ e.note }}</p>
            <pre class="hist-snap">{{ JSON.stringify(e.snapshot, null, 2) }}</pre>
            <div class="hist-actions">
              <button v-if="e.subject === 'perk_correction' && e.action === 'created'" type="button" :disabled="busy" @click="revert(e)">Revert</button>
              <button v-if="canRevoke && e.actor.id !== me && e.actor.id !== '0'" type="button" @click="revoking = e">Revoke {{ e.actor.username }}</button>
            </div>
            <form v-if="revoking?.id === e.id" class="hist-revoke" @submit.prevent="revoke">
              <label :for="`reason-${e.id}`">Reason (required)</label>
              <input :id="`reason-${e.id}`" v-model="reason" maxlength="200" required />
              <button type="submit" :disabled="busy || !reason.trim()">Confirm revoke</button>
              <button type="button" @click="revoking = null">Cancel</button>
            </form>
          </div>
        </li>
      </ol>
      <p v-if="!events.length && !error" class="hist-empty">Nothing yet.</p>
      <button v-if="next" type="button" class="hist-more" @click="load(true)">Older</button>
    </template>
  </section>
</template>

<style scoped>
.hist {
  max-width: 60rem;
  margin: 0 auto;
  padding: 2rem 1rem 4rem;
}
.hist-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  color: var(--color-bone);
  font-size: 2rem;
}
.hist-intro,
.hist-empty,
.hist-meta {
  color: var(--color-smoke);
}
.hist-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 1.2rem 0;
}
.hist-filter,
.hist button {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.7rem;
  color: var(--color-bone);
  background: transparent;
  border: 1px solid var(--color-ash);
  border-radius: 2px;
  padding: 0.35rem 0.7rem;
  cursor: pointer;
}
.hist-filter.on {
  border-color: var(--color-ember);
  color: var(--color-ember);
}
.hist-search,
.hist-revoke input {
  flex: 1;
  min-width: 12rem;
  background: rgba(5, 10, 8, 0.7);
  border: 1px solid var(--color-ash);
  color: var(--color-bone);
  border-radius: 2px;
  padding: 0.4rem 0.6rem;
}
.hist-error {
  color: var(--color-ember);
}
.hist-list {
  list-style: none;
  padding: 0;
  display: grid;
  gap: 0.4rem;
}
.hist-item {
  border: 1px solid var(--color-ash);
  border-left: 3px solid var(--color-ash-2);
  border-radius: 5px;
  background: rgba(14, 28, 22, 0.4);
}
.hist-item[data-subject='perk_correction'] {
  border-left-color: var(--color-gold);
}
.hist-item[data-subject='build'] {
  border-left-color: var(--color-drake);
}
.hist-item[data-subject='privilege'] {
  border-left-color: var(--color-ember);
}
.hist .hist-line {
  display: flex;
  gap: 1rem;
  width: 100%;
  text-align: left;
  border: 0;
  text-transform: none;
  letter-spacing: 0;
  font-family: inherit;
  font-size: 0.85rem;
  padding: 0.6rem 0.8rem;
}
.hist-when {
  flex: none;
  color: var(--color-smoke);
  font-family: var(--font-mono);
  font-size: 0.7rem;
}
.hist-detail {
  padding: 0 0.8rem 0.8rem;
}
.hist-snap {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.72rem;
  color: #c3d0c6;
  background: rgba(5, 10, 8, 0.6);
  padding: 0.6rem;
  border-radius: 3px;
  max-height: 20rem;
  overflow: auto;
}
.hist-actions,
.hist-revoke {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  margin-top: 0.5rem;
}
.hist-revoked {
  margin-bottom: 1.2rem;
  padding: 0.8rem;
  border: 1px solid var(--color-ember);
  border-radius: 5px;
}
.hist-revoked ul {
  list-style: none;
  padding: 0;
  display: grid;
  gap: 0.4rem;
}
.hist-more {
  margin-top: 1rem;
}
</style>
```

- [ ] **Step 6: Add the route**

In `src/router.js`, after the `reports-review` route:
```js
  {
    path: '/history',
    name: 'history',
    component: () => import('./views/History.vue'),
    meta: { title: 'Version History' },
  },
```

- [ ] **Step 7: Run the suite and a build**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run && npx vite build`
Expected: tests PASS; build succeeds

- [ ] **Step 8: Commit**

```bash
git add src/lib/historyLabels.js src/lib/historyLabels.test.js src/views/History.vue src/router.js
git commit -m "feat(perks): Version History page with revert, revoke and reinstate"
```

---

### Task 11: End-to-end

**Files:**
- Modify: `e2e/discord-mock/server.js`, `e2e/docker-compose.yml`
- Create: `e2e/tests/perks.spec.js`

**Interfaces:**
- Consumes: everything above, through the browser.

- [ ] **Step 1: Give the mock a Techmarine, a Forge and the bake**

In `e2e/discord-mock/server.js`:
```js
// USERS, add:
  // Techmarine — edits perks, sees history, moderates builds.
  'test-techmarine-token': { id: '100000000000000010', username: 'techmarine-tester' },
  // Master of the Forge — may revoke the Techmarine.
  'test-forge-token': { id: '100000000000000011', username: 'forge-tester' },
```
```js
const TECHMARINE_ROLE = '1322056087859499042'
const FORGE_ROLE = '1322056087867883565'
// MEMBERS, add:
  '100000000000000010': { roles: [LEGION_ROLE, TECHMARINE_ROLE] },
  '100000000000000011': { roles: [LEGION_ROLE, FORGE_ROLE] },
```
Before the final 404, serve the repo's bake (mounted read-only at `/bake`):
```js
    // The wiki bake, standing in for raw.githubusercontent.com (BAKE_BASE_URL).
    const bakeMatch = url.pathname.match(/^\/bake\/(weapon-trees|perk-details)\.json$/)
    if (bakeMatch) return withCors(new Response(Bun.file(`/bake/${bakeMatch[1]}.json`), { headers: { 'Content-Type': 'application/json' } }))
```
Update the member-lookup comment ("No build-moderator scenario is exercised…") to say the Techmarine and Forge testers hold mod roles.

In `e2e/docker-compose.yml`: under `discord-mock` add
```yaml
    volumes:
      - ../src/data:/bake:ro
```
Under `api.environment`, remove `DISCORD_MOD_ROLE_ID: ''` and add `BAKE_BASE_URL: http://discord-mock:4400/bake/`.

- [ ] **Step 2: Write the spec**

```js
// e2e/tests/perks.spec.js
import { test, expect } from '@playwright/test'

async function signIn(page, token) {
  await page.goto(`/#access_token=${token}&expires_in=3600`)
  await expect(page.locator('.auth-name').first()).toBeVisible()
}

async function openLasFusil(page) {
  await page.goto('/armoury')
  await page.locator('button', { hasText: 'Las Fusil' }).first().click()
  await page.locator('.wnode', { hasText: 'Increased Capacity' }).first().hover()
}

test('a Techmarine corrects a perk, members see it, the Forge revokes the Techmarine', async ({ browser }) => {
  const text = `E2E corrected text ${Date.now()}`

  const tm = await (await browser.newContext()).newPage()
  await signIn(tm, 'test-techmarine-token')
  await openLasFusil(tm)
  await tm.getByRole('button', { name: 'Edit text' }).click()
  await tm.getByLabel('Perk text').fill(text)
  await tm.getByLabel('Note').fill('e2e check')
  await tm.getByRole('button', { name: 'Save' }).click()
  await expect(tm.locator('.wdetail-desc')).toHaveText(text)
  await expect(tm.getByRole('link', { name: 'Version History' }).first()).toBeVisible()

  const member = await (await browser.newContext()).newPage()
  await signIn(member, 'test-member-token')
  await openLasFusil(member)
  await expect(member.locator('.wdetail-desc')).toHaveText(text)
  await expect(member.locator('.corrected-tag')).toContainText('Corrected in game')
  await expect(member.getByRole('button', { name: 'Edit text' })).toHaveCount(0)
  await expect(member.getByRole('link', { name: 'Version History' })).toHaveCount(0)

  const forge = await (await browser.newContext()).newPage()
  await signIn(forge, 'test-forge-token')
  await forge.goto('/history')
  const entry = forge.locator('.hist-item', { hasText: 'techmarine-tester edited Increased Capacity' }).first()
  await entry.locator('.hist-line').click()
  await entry.getByRole('button', { name: 'Revoke techmarine-tester' }).click()
  await entry.getByLabel('Reason (required)').fill('e2e revoke')
  await entry.getByRole('button', { name: 'Confirm revoke' }).click()
  await expect(forge.locator('.hist-revoked')).toContainText('techmarine-tester')

  await tm.reload()
  await openLasFusil(tm)
  await expect(tm.getByRole('button', { name: 'Edit text' })).toHaveCount(0)
  await expect(tm.getByRole('link', { name: 'Version History' })).toHaveCount(0)

  await forge.locator('.hist-revoked').getByRole('button', { name: 'Reinstate' }).click()
  await expect(forge.locator('.hist-revoked')).toHaveCount(0)
})
```

- [ ] **Step 3: Run the e2e stack**

Run: `bun run test:e2e`
Expected: every spec passes, including `perks.spec.js`. On Windows run it from Git Bash, since the script uses `$?`.

- [ ] **Step 4: Commit**

```bash
git add e2e/discord-mock/server.js e2e/docker-compose.yml e2e/tests/perks.spec.js
git commit -m "test(e2e): perk correction, member view, revoke and reinstate"
```

---

### Task 12: Go-live on Vulkan (Bret approves each outward step)

These steps change production. Each needs Bret's go-ahead at the time it runs, per the collaborate-and-ask rule.

- [ ] **Step 1: Push `main`** after the whole-branch review passes. Expected: the deploy workflow runs the snapshot step. It logs "Keeping the committed perk corrections snapshot" until the API is updated, which is fine.
- [ ] **Step 2: On Vulkan**, in `~/Documents/salamanders-site`:
```bash
git pull
cd server
docker compose exec -T db psql -U salamanders salamanders_builds -v ON_ERROR_STOP=1 < schema.sql
docker compose up -d --build api
docker compose exec -T api bun run src/seed.js < ../src/data/perk-corrections.json
curl -s localhost:8787/perk-corrections | head -c 300
```
Expected: `Seeded N perk corrections.`, and the document lists `Occulus Bolt Carbine`.
- [ ] **Step 3: Re-run the deploy** (`gh workflow run "Deploy to GitHub Pages"`) so the bundled snapshot picks up the real correction ids.
- [ ] **Step 4: Smoke-test live:** as Bret (Admin), open `/history` and check the seeded rows are there. Then open the Armoury, confirm the Occulus Bolt Carbine Standard tier shows Great Might and Remote Threat, and check the webhook channel receives a test correction. Revert that test correction afterwards.
