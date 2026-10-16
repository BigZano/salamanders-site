# Tactical Bolt Rifle as a Secondary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Tactical pick the Bolt Rifle (and only that primary) as their Secondary, with a perk tree and budget independent of a Bolt Rifle in the Primary slot.

**Architecture:** Perk picks and budgets are keyed by weapon name. A new pure function `perkStateKey(slot, weapon)` returns the plain name for a weapon in its own slot (every case today, so nothing migrates) and `"<weapon> (<Slot>)"` for a weapon sitting in a slot it does not belong to. The store snapshot and the three UI call sites use that key; `WeaponTree` takes it as an optional `stateKey` prop. The server needs no change.

**Tech Stack:** Vue 3 + Pinia, Vitest (+ fast-check, @vue/test-utils), Stryker mutation gate, Playwright e2e in docker.

**Spec:** `docs/superpowers/specs/2026-10-15-tactical-bolt-rifle-secondary-design.md`

## Global Constraints

- Existing builds, share links, localStorage state and gallery rows must keep working with **no migration**: for any weapon in its own slot the key stays the bare weapon name.
- Tactical's Secondary offers `Bolt Rifle` and no other primary; it is always offered, **not** gated on `Tactical Reserve`.
- Out of scope: Armoury "Equip as secondary"; gating on `Tactical Reserve`; weapon perks on gallery cards.
- `PERK_NAME` (server) allows letters, digits, spaces and `' ’ - ( ) . , & : + % /`, so `Bolt Rifle (Secondary)` passes the server unchanged.
- Test behaviour only (return values, store state, DOM text); never logs or mock calls. Raise/validate at the boundary.
- Run tools from the repo-local binaries: `node_modules/.bin/vitest`, `node_modules/.bin/stryker` (bun is not on PATH; `node_modules/.bin/bun` is 1.4.2).
- Do **not** push. The pre-commit hook runs the whole vitest suite (~30 s); the pre-push gate (suite + coverage + mutation, ~5 min) is run by hand in Task 6.
- Commit trailer on every commit: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Branch: `feat/tactical-bolt-rifle-secondary` (already created; the spec is committed on it).
- No real member names or Discord data in tests (public repo): every identifier here is invented.

## Review Focus

Failure modes the spec implies that no single task's headline test covers; each has a pinning test in the task named.

1. A Bolt Rifle chosen as Secondary while the Primary Bolt Rifle already has picks starts with **0** picks, not the primary's → Task 3 store test, Task 6 e2e.
2. A wiki correction to the Bolt Rifle shows in **both** trees (corrections target the weapon, not the key) → Task 4 `WeaponTree` test.
3. Switching the Secondary away from Bolt Rifle and back restores that slot's own picks, never the primary's → Task 3 store test.
4. A Tactical with the Bolt Rifle only as Primary, or a pre-change share link, produces the same payload keys as before → Task 3 store tests.
5. Hostile slot/weapon inputs (`constructor`, `__proto__`, arrays, `null`, wrong case) never throw and never invent a key → Task 1.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/lib/perkStateKey.js` | create | The key rule. Pure, gated at 100% coverage + mutation. |
| `src/lib/perkStateKey.test.js` | create | Unit, hostile-input and property tests for the rule. |
| `vitest.config.js`, `stryker.config.mjs` | modify | Add the new file to the coverage and mutation gates. |
| `src/data/classes.json` | modify | Tactical `weapons.secondary` gains `"Bolt Rifle"`. |
| `src/data/data-integrity.test.js` | modify | Exact off-slot allowlist; no weapon native to two slots. |
| `src/stores/planner.js` | modify | `snapshotWeaponPerks` keys by slot + weapon. |
| `src/stores/planner.test.js` | modify | Two-slot independence, round-trips, legacy payloads. |
| `src/components/WeaponTree.vue` | modify | Optional `stateKey` prop drives picks, budget, reset. |
| `src/components/WeaponSlot.vue` | modify | Passes `perkStateKey(slot, weapon)`; per-slot count. |
| `src/views/Planner.vue` | modify | `weaponPerkCount` uses the key. |
| `src/components/WeaponTree.test.js`, `WeaponSlot.test.js` | modify | `stateKey` behaviour; Tactical offers the Bolt Rifle. |
| `server/src/buildText.test.js` | modify | Pin: two copies and the qualified key survive validation. |
| `e2e/tests/planner-weapons.spec.js` | create | Both slots, independent picks, survive reload. |

---

### Task 1: `perkStateKey` — the key rule

**Files:**
- Create: `src/lib/perkStateKey.js`
- Create: `src/lib/perkStateKey.test.js`
- Modify: `vitest.config.js` (the `GATED` array)
- Modify: `stryker.config.mjs` (the `mutate` array)

**Interfaces:**
- Consumes: `src/data/weapons.json` → `fallbackWeapons: { primary: string[], secondary: string[], melee: string[] }`.
- Produces: `export function perkStateKey(slot: string, weapon: string): string`. `''` for a non-string weapon; the bare `weapon` when it is in `fallbackWeapons[slot]`, when `slot` is not an own key of `fallbackWeapons`, or when no slot lists it; otherwise `` `${weapon} (${Slot})` `` with `Slot` = slot capitalised (`Bolt Rifle (Secondary)`).

- [ ] **Step 1: Write the failing test**

Create `src/lib/perkStateKey.test.js`:

```js
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { perkStateKey } from './perkStateKey'
import weaponList from '../data/weapons.json'
import classes from '../data/classes.json'

const LISTS = weaponList.fallbackWeapons
const SLOTS = Object.keys(LISTS)
const CAPITALISED = { primary: 'Primary', secondary: 'Secondary', melee: 'Melee' }
const EVERY_WEAPON = Object.values(LISTS).flat()

describe('perkStateKey', () => {
  it('is the plain weapon name for a weapon in its own slot', () => {
    for (const slot of SLOTS) {
      for (const w of LISTS[slot]) expect(perkStateKey(slot, w), `${slot}: ${w}`).toBe(w)
    }
  })

  it('qualifies a weapon that sits in a slot it does not belong to', () => {
    expect(perkStateKey('secondary', 'Bolt Rifle')).toBe('Bolt Rifle (Secondary)')
    expect(perkStateKey('primary', 'Chainsword')).toBe('Chainsword (Primary)')
    expect(perkStateKey('melee', 'Bolt Pistol')).toBe('Bolt Pistol (Melee)')
  })

  it('qualifies every weapon in every slot that is not its own, with that slot capitalised', () => {
    for (const slot of SLOTS) {
      for (const other of SLOTS.filter((s) => s !== slot)) {
        for (const w of LISTS[other]) {
          expect(perkStateKey(slot, w), `${slot}: ${w}`).toBe(`${w} (${CAPITALISED[slot]})`)
        }
      }
    }
  })

  it('gives a Bolt Rifle in the Primary and one in the Secondary different keys', () => {
    expect(perkStateKey('primary', 'Bolt Rifle')).toBe('Bolt Rifle')
    expect(perkStateKey('secondary', 'Bolt Rifle')).toBe('Bolt Rifle (Secondary)')
  })

  it('is empty for a blank or non-string weapon', () => {
    for (const bad of ['', null, undefined, 0, 5, true, {}, [], ['Bolt Rifle']]) {
      expect(perkStateKey('secondary', bad), String(bad)).toBe('')
    }
  })

  it('leaves the weapon alone when the slot is unknown, wrong-cased, empty or not a string', () => {
    const slots = ['tertiary', 'Secondary', 'SECONDARY', '', ' secondary', undefined, null, 7, {}, ['secondary']]
    for (const slot of slots) expect(perkStateKey(slot, 'Bolt Rifle'), String(slot)).toBe('Bolt Rifle')
  })

  it('does not treat object prototype names as slots', () => {
    for (const slot of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(perkStateKey(slot, 'Bolt Rifle'), slot).toBe('Bolt Rifle')
    }
  })

  it('leaves a weapon no slot lists alone, however it is spelled', () => {
    for (const w of ['Unreleased Cannon', 'bolt rifle', 'Bolt Rifle ', '__proto__', 'constructor', 'toString']) {
      for (const slot of SLOTS) expect(perkStateKey(slot, w), `${slot}: ${w}`).toBe(w)
    }
  })

  it('never changes a weapon no slot lists, for any text', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SLOTS), fc.string(), (slot, w) => {
        fc.pre(!EVERY_WEAPON.includes(w))
        expect(perkStateKey(slot, w)).toBe(w)
      }),
    )
  })

  it('never throws, for any slot and weapon of any type', () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (slot, w) => {
        expect(() => perkStateKey(slot, w)).not.toThrow()
      }),
    )
  })

  it('gives the weapons of any one loadout distinct keys, for every class', () => {
    for (const [cls, c] of Object.entries(classes)) {
      for (const p of ['', ...c.weapons.primary]) {
        for (const s of ['', ...c.weapons.secondary]) {
          for (const m of ['', ...c.weapons.melee]) {
            const keys = [perkStateKey('primary', p), perkStateKey('secondary', s), perkStateKey('melee', m)].filter(Boolean)
            expect(new Set(keys).size, `${cls}: ${p} / ${s} / ${m}`).toBe(keys.length)
          }
        }
      }
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node_modules/.bin/vitest run src/lib/perkStateKey.test.js`
Expected: FAIL — `Failed to resolve import "./perkStateKey"`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/perkStateKey.js`:

```js
import weaponList from '../data/weapons.json'

const LISTS = weaponList.fallbackWeapons

/**
 * Where a weapon's perk picks and budget are stored. Picks are keyed by weapon
 * name, which is the weapon itself in every slot it belongs to. The one exception
 * is a weapon sitting in a slot it does not belong to (Tactical's Bolt Rifle as a
 * Secondary): it gets "<weapon> (<Slot>)" so it is configured apart from the same
 * weapon in its own slot. Keeping every other key unchanged means saved builds,
 * share links and stored rows need no migration.
 *
 * Anything that is not a known slot, or a weapon no slot lists, keeps its bare
 * name; a non-string weapon has no key.
 */
export function perkStateKey(slot, weapon) {
  if (typeof weapon !== 'string') return ''
  if (typeof slot !== 'string' || !Object.hasOwn(LISTS, slot)) return weapon
  if (LISTS[slot].includes(weapon)) return weapon
  const belongsElsewhere = Object.values(LISTS).some((names) => names.includes(weapon))
  return belongsElsewhere ? `${weapon} (${slot[0].toUpperCase()}${slot.slice(1)})` : weapon
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node_modules/.bin/vitest run src/lib/perkStateKey.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Wire the file into the coverage and mutation gates**

In `vitest.config.js`, add `'src/lib/perkStateKey.js',` to `GATED` after `'src/lib/longPress.js',`.
In `stryker.config.mjs`, add `'src/lib/perkStateKey.js',` to `mutate` after `'src/lib/longPress.js',`.

- [ ] **Step 6: Run coverage and mutation on the unit**

Run: `node_modules/.bin/vitest run --coverage`
Expected: all tests pass; no threshold error naming `src/lib/perkStateKey.js` (100% lines/branches/functions/statements).

Run: `node_modules/.bin/stryker run --mutate src/lib/perkStateKey.js`
Expected: `Mutation score 100`, zero survivors. If a mutant survives, add the test that kills it (do not weaken the code or exclude the line); an *equivalent* mutant means a redundant branch — delete the branch.

- [ ] **Step 7: Commit**

```bash
git add src/lib/perkStateKey.js src/lib/perkStateKey.test.js vitest.config.js stryker.config.mjs docs/superpowers/specs/2026-10-15-tactical-bolt-rifle-secondary-design.md docs/superpowers/plans/2026-10-15-tactical-bolt-rifle-secondary.md
git commit -m "$(cat <<'EOF'
feat(planner): perkStateKey, a per-slot key for off-slot weapons

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Data — Tactical may take the Bolt Rifle as a Secondary

**Files:**
- Modify: `src/data/data-integrity.test.js:26-33` (the "only gives a class weapons that exist for that slot" test)
- Modify: `src/data/classes.json` (Tactical `weapons.secondary`)

**Interfaces:**
- Consumes: `fallbackWeapons` from `weapons.json`, `classes.json`.
- Produces: `classes.Tactical.weapons.secondary` contains `'Bolt Rifle'`; the integrity suite pins it as the only cross-slot weapon in the dataset.

- [ ] **Step 1: Write the failing test**

In `src/data/data-integrity.test.js`, replace the existing test:

```js
  it('only gives a class weapons that exist for that slot', () => {
    const bad = []
    for (const [cls, c] of Object.entries(classes)) {
      for (const [slot, names] of Object.entries(c.weapons)) {
        for (const n of names) if (!weaponList.fallbackWeapons[slot].includes(n)) bad.push(`${cls} ${slot}: ${n}`)
      }
    }
    expect(bad).toEqual([])
  })
```

with:

```js
  // Tactical Reserve swaps the Secondary for a Primary Bolt Rifle. Anything else
  // in the wrong slot is a data error, so this list is exact, not a floor.
  const OFF_SLOT = ['Tactical secondary: Bolt Rifle']
  const offSlot = () => {
    const found = []
    for (const [cls, c] of Object.entries(classes)) {
      for (const [slot, names] of Object.entries(c.weapons)) {
        for (const n of names) if (!weaponList.fallbackWeapons[slot].includes(n)) found.push(`${cls} ${slot}: ${n}`)
      }
    }
    return found
  }

  it('only gives a class weapons that exist for that slot, bar the Bolt Rifle Tactical Reserve allows', () => {
    expect(offSlot()).toEqual(OFF_SLOT)
  })

  it('only places a weapon in the wrong slot when another slot lists it', () => {
    const everyWeapon = Object.values(weaponList.fallbackWeapons).flat()
    for (const entry of offSlot()) expect(everyWeapon, entry).toContain(entry.split(': ')[1])
  })

  it('lists no weapon in more than one slot', () => {
    const seen = new Map()
    const twice = []
    for (const [slot, names] of Object.entries(weaponList.fallbackWeapons)) {
      for (const n of names) {
        if (seen.has(n)) twice.push(`${n}: ${seen.get(n)} and ${slot}`)
        seen.set(n, slot)
      }
    }
    expect(twice).toEqual([])
  })

  it('lets Tactical take the Bolt Rifle as a Secondary as well as a Primary, and no other primary', () => {
    expect(classes.Tactical.weapons.primary).toContain('Bolt Rifle')
    expect(classes.Tactical.weapons.secondary).toContain('Bolt Rifle')
    const otherPrimaries = classes.Tactical.weapons.primary.filter((n) => n !== 'Bolt Rifle')
    for (const n of otherPrimaries) expect(classes.Tactical.weapons.secondary, n).not.toContain(n)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node_modules/.bin/vitest run src/data/data-integrity.test.js`
Expected: FAIL — `only gives a class weapons … bar the Bolt Rifle` (received `[]`, expected `['Tactical secondary: Bolt Rifle']`) and `lets Tactical take the Bolt Rifle as a Secondary` (secondary does not contain `Bolt Rifle`).

- [ ] **Step 3: Make the data change**

In `src/data/classes.json`, append `"Bolt Rifle"` to Tactical's `weapons.secondary` (match the file's existing indentation), so it reads:

```json
    "secondary": [
      "Bolt Pistol",
      "Heavy Bolt Pistol",
      "Plasma Pistol",
      "Bolt Rifle"
    ],
```

- [ ] **Step 4: Run the suite to verify it passes**

Run: `node_modules/.bin/vitest run`
Expected: PASS everywhere. If an existing test (e.g. `Armoury.test.js`) breaks on Tactical's secondary list, read it, fix the assertion to the new truth, and say so in the commit message.

- [ ] **Step 5: Commit**

```bash
git add src/data/classes.json src/data/data-integrity.test.js
git commit -m "$(cat <<'EOF'
feat(data): Tactical can take the Bolt Rifle as a Secondary

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Store — the snapshot keys by slot and weapon

**Files:**
- Modify: `src/stores/planner.js` (import near line 4; `snapshotWeaponPerks` near line 227)
- Modify: `src/stores/planner.test.js` (new `describe` after `describe('toggleWeaponPerk validIds', …)`)

**Interfaces:**
- Consumes: `perkStateKey(slot, weapon): string` (Task 1).
- Produces: `planner.snapshotWeaponPerks(): { [key: string]: { [perkId: string]: true } }` where `key = perkStateKey(slot, weapon)`; empty keys and keys with no picks are omitted. `toggleWeaponPerk`, `weaponUsed`, `weaponBudget`, `setWeaponBudget`, `resetWeaponTree` are unchanged and are passed the key by callers.

- [ ] **Step 1: Write the failing tests**

In `src/stores/planner.test.js`, add after the `toggleWeaponPerk validIds` describe block:

```js
describe('the same weapon in two slots', () => {
  const SECONDARY = 'Bolt Rifle (Secondary)'

  function bothSlots(planner) {
    planner.setClass('Tactical')
    planner.setWeapon('primary', 'Bolt Rifle')
    planner.setWeapon('secondary', 'Bolt Rifle')
  }

  it('snapshots a perk tree for each copy under its own key', () => {
    const planner = usePlanner()
    bothSlots(planner)
    planner.toggleWeaponPerk('Bolt Rifle', 'a')
    planner.toggleWeaponPerk(SECONDARY, 'b')

    expect(planner.buildSnapshot().weaponPerks).toEqual({ 'Bolt Rifle': { a: true }, [SECONDARY]: { b: true } })
  })

  it('starts the Secondary copy empty even when the Primary copy already has picks', () => {
    const planner = usePlanner()
    planner.setClass('Tactical')
    planner.setWeapon('primary', 'Bolt Rifle')
    planner.toggleWeaponPerk('Bolt Rifle', 'a')
    planner.setWeapon('secondary', 'Bolt Rifle')

    expect(planner.buildSnapshot().weaponPerks).toEqual({ 'Bolt Rifle': { a: true } })
    expect(planner.weaponUsed(SECONDARY)).toBe(0)
  })

  it('keeps a separate budget for each copy', () => {
    const planner = usePlanner()
    bothSlots(planner)
    planner.setWeaponBudget(SECONDARY, 2)
    for (const id of ['a', 'b', 'c']) {
      planner.toggleWeaponPerk('Bolt Rifle', id)
      planner.toggleWeaponPerk(SECONDARY, id)
    }

    expect(planner.weaponUsed('Bolt Rifle')).toBe(3)
    expect(planner.weaponUsed(SECONDARY)).toBe(2)
  })

  it('resets one copy without touching the other', () => {
    const planner = usePlanner()
    bothSlots(planner)
    planner.toggleWeaponPerk('Bolt Rifle', 'a')
    planner.toggleWeaponPerk(SECONDARY, 'b')
    planner.resetWeaponTree(SECONDARY)

    expect(planner.buildSnapshot().weaponPerks).toEqual({ 'Bolt Rifle': { a: true } })
  })

  it('brings back the Secondary copy picks, not the Primary ones, when the Secondary returns', () => {
    const planner = usePlanner()
    bothSlots(planner)
    planner.toggleWeaponPerk('Bolt Rifle', 'a')
    planner.toggleWeaponPerk(SECONDARY, 'b')

    planner.setWeapon('secondary', 'Bolt Pistol')
    expect(planner.buildSnapshot().weaponPerks).toEqual({ 'Bolt Rifle': { a: true } })

    planner.setWeapon('secondary', 'Bolt Rifle')
    expect(planner.buildSnapshot().weaponPerks).toEqual({ 'Bolt Rifle': { a: true }, [SECONDARY]: { b: true } })
  })

  it('round-trips both copies through a saved build', () => {
    const source = usePlanner()
    bothSlots(source)
    source.toggleWeaponPerk('Bolt Rifle', 'a')
    source.toggleWeaponPerk(SECONDARY, 'b')
    const snap = source.buildSnapshot({ title: 'Two rifles' })

    setActivePinia(createPinia())
    const target = usePlanner()
    target.applyBuildData({ ...snap, id: 1, author: { id: '1', username: 'x' }, createdAt: 'now' })

    expect(target.activeWeapons).toEqual({ primary: 'Bolt Rifle', secondary: 'Bolt Rifle' })
    expect(target.weaponPerks).toEqual({ 'Bolt Rifle': { a: true }, [SECONDARY]: { b: true } })
  })

  it('round-trips both copies through a share link', () => {
    const source = usePlanner()
    bothSlots(source)
    source.toggleWeaponPerk('Bolt Rifle', 'a')
    source.toggleWeaponPerk(SECONDARY, 'b')
    const link = source.encode()

    setActivePinia(createPinia())
    const target = usePlanner()
    target.applyEncoded(link)

    expect(target.activeWeapons).toEqual({ primary: 'Bolt Rifle', secondary: 'Bolt Rifle' })
    expect(target.weaponPerks).toEqual({ 'Bolt Rifle': { a: true }, [SECONDARY]: { b: true } })
  })

  it('keeps the plain key for a weapon in its own slot, so older links and builds still load', () => {
    const planner = usePlanner()
    planner.setClass('Tactical')
    planner.setWeapon('primary', 'Bolt Rifle')
    planner.setWeapon('secondary', 'Bolt Pistol')
    planner.toggleWeaponPerk('Bolt Rifle', 'a')
    planner.toggleWeaponPerk('Bolt Pistol', 'p')
    expect(planner.buildSnapshot().weaponPerks).toEqual({ 'Bolt Rifle': { a: true }, 'Bolt Pistol': { p: true } })

    const legacy = btoa(JSON.stringify({ c: 'Tactical', w: { primary: 'Bolt Rifle' }, wp: { 'Bolt Rifle': { z: true } } }))
    setActivePinia(createPinia())
    const loaded = usePlanner()
    loaded.applyEncoded(legacy)
    expect(loaded.buildSnapshot().weaponPerks).toEqual({ 'Bolt Rifle': { z: true } })
  })

  it('leaves out a slot with no weapon even if perks are parked under the empty key', () => {
    const planner = usePlanner()
    planner.setClass('Tactical')
    planner.toggleWeaponPerk('', 'ghost')
    planner.setWeapon('secondary', '')

    expect(Object.keys(planner.buildSnapshot().weaponPerks)).not.toContain('')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node_modules/.bin/vitest run src/stores/planner.test.js`
Expected: FAIL on `snapshots a perk tree for each copy`, `brings back the Secondary copy picks`, and both round-trip tests (the snapshot has no `Bolt Rifle (Secondary)` key). The independent-budget, reset and legacy tests may already pass because those actions are key-agnostic.

- [ ] **Step 3: Write the implementation**

In `src/stores/planner.js`, add after the `migrateSelection` import:

```js
import { perkStateKey } from '../lib/perkStateKey'
```

Replace `snapshotWeaponPerks`:

```js
    snapshotWeaponPerks() {
      const equipped = Object.values(this.weapons[this.activeClass] || {}).filter(Boolean)
      const out = {}
      for (const w of equipped) {
        if (this.weaponPerks[w]) out[w] = { ...this.weaponPerks[w] }
      }
      return out
    },
```

with:

```js
    // One entry per equipped slot, under the key perkStateKey gives it, so the
    // same weapon in two slots keeps two separate trees.
    snapshotWeaponPerks() {
      const out = {}
      for (const [slot, weapon] of Object.entries(this.weapons[this.activeClass] || {})) {
        const key = perkStateKey(slot, weapon)
        if (key && this.weaponPerks[key]) out[key] = { ...this.weaponPerks[key] }
      }
      return out
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node_modules/.bin/vitest run src/stores/planner.test.js`
Expected: PASS, including every pre-existing snapshot test (`only snapshots weapon perks for weapons actually equipped`, `ignores a cleared … weapon slot`).

- [ ] **Step 5: Commit**

```bash
git add src/stores/planner.js src/stores/planner.test.js
git commit -m "$(cat <<'EOF'
feat(planner): snapshot weapon perks per slot, so two copies stay apart

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: UI — each slot's tree uses its own key

**Files:**
- Modify: `src/components/WeaponTree.vue` (props near line 7; `budget`/`selected` near lines 39-40; `toggle` near line 106; template lines ~121 and ~125)
- Modify: `src/components/WeaponSlot.vue` (import, `spent`, `<WeaponTree>`)
- Modify: `src/views/Planner.vue` (import; `weaponPerkCount` near line 127)
- Modify: `src/components/WeaponTree.test.js` (new `describe`)
- Modify: `src/components/WeaponSlot.test.js` (new tests, helper)

**Interfaces:**
- Consumes: `perkStateKey(slot, weapon)` (Task 1); store actions keyed by string (Task 3).
- Produces: `WeaponTree` prop `stateKey?: string` (defaults to `weapon`); `WeaponSlot` passes `:state-key="perkStateKey(slot, weapon)"`.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/WeaponTree.test.js`:

```js
describe('WeaponTree stateKey', () => {
  const tree = (props = {}) => mount(WeaponTree, { props: { weapon: 'Test', data, ...props } })
  const points = (w) => w.find('.wtree-pts').text()

  it('keeps picks, budget and reset apart from the same weapon without a stateKey', async () => {
    const planner = usePlanner()
    const primary = tree()
    const secondary = tree({ stateKey: 'Test (Secondary)' })

    await primary.findAll('.wnode')[0].trigger('click')
    expect(points(primary)).toBe('1 / 5 points')
    expect(points(secondary)).toBe('0 / 5 points')

    await secondary.findAll('.wnode')[1].trigger('click')
    expect(Object.keys(planner.weaponPerks.Test)).toHaveLength(1)
    expect(Object.keys(planner.weaponPerks['Test (Secondary)'])).toHaveLength(1)

    const budget = secondary.find('.wtree-budget input')
    budget.element.value = '2'
    await budget.trigger('change')
    expect(points(secondary)).toBe('1 / 2 points')
    expect(points(primary)).toBe('1 / 5 points')

    await secondary.find('.wtree-reset').trigger('click')
    expect(points(secondary)).toBe('0 / 2 points')
    expect(points(primary)).toBe('1 / 5 points')
  })

  it('shows a correction to the weapon in both copies', async () => {
    const s = usePerkCorrections()
    s.doc = { version: 'v', classes: {}, weapons: { Test: [{ id: 1, op: 'edit', quality: 'Standard', perkName: 'B', description: 'fixed', createdAt: '2026-09-27T12:00:00.000Z' }] } }
    for (const w of [tree(), tree({ stateKey: 'Test (Secondary)' })]) {
      await w.findAll('.wnode')[1].trigger('mouseenter')
      expect(w.find('.wdetail-desc').text()).toBe('fixed')
    }
  })
})
```

In `src/components/WeaponSlot.test.js`, replace the helper line:

```js
const slot = () => mount(WeaponSlot, { props: { slot: 'melee', label: 'Melee' }, global: { stubs: { WeaponTree: true } } })
```

with:

```js
const slotOf = (name, label) => mount(WeaponSlot, { props: { slot: name, label }, global: { stubs: { WeaponTree: true } } })
const slot = () => slotOf('melee', 'Melee')
```

and add inside the `describe('WeaponSlot', …)` block:

```js
  it('offers Tactical the Bolt Rifle as a Secondary, and no other primary', () => {
    planner.setClass('Tactical')
    const values = slotOf('secondary', 'Secondary').findAll('option').map((o) => o.element.value)
    expect(values).toEqual(['', 'Bolt Pistol', 'Heavy Bolt Pistol', 'Plasma Pistol', 'Bolt Rifle'])
  })

  it('does not offer the Bolt Rifle as a Secondary to a class that cannot take it', () => {
    planner.setClass('Assault')
    const values = slotOf('secondary', 'Secondary').findAll('option').map((o) => o.element.value)
    expect(values).not.toContain('Bolt Rifle')
  })

  it('counts each slot’s own perks when the same weapon is in two slots', () => {
    planner.setClass('Tactical')
    planner.setWeapon('primary', 'Bolt Rifle')
    planner.setWeapon('secondary', 'Bolt Rifle')
    planner.toggleWeaponPerk('Bolt Rifle', 'a')
    planner.toggleWeaponPerk('Bolt Rifle', 'b')
    planner.toggleWeaponPerk('Bolt Rifle (Secondary)', 'x')

    expect(slotOf('primary', 'Primary').find('.slot-pts').text()).toBe('2 perks')
    expect(slotOf('secondary', 'Secondary').find('.slot-pts').text()).toBe('1 perk')
  })

  it('gives the open tree the slot’s own key', async () => {
    planner.setClass('Tactical')
    planner.setWeapon('primary', 'Bolt Rifle')
    planner.setWeapon('secondary', 'Bolt Rifle')
    const keyed = async (name, label) => {
      const w = slotOf(name, label)
      await w.find('.slot-toggle').trigger('click')
      await flushPromises()
      return w.findComponent(WeaponTree).props('stateKey')
    }

    expect(await keyed('primary', 'Primary')).toBe('Bolt Rifle')
    expect(await keyed('secondary', 'Secondary')).toBe('Bolt Rifle (Secondary)')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node_modules/.bin/vitest run src/components/WeaponTree.test.js src/components/WeaponSlot.test.js`
Expected: FAIL — `WeaponTree stateKey` (both trees share `Test`, so the first assertion reads `1 / 5` for the secondary), the slot count test (`Bolt Rifle` counts 2 for both), and `gives the open tree the slot's own key` (`stateKey` prop undefined). The offers-Tactical test already passes thanks to Task 2.

- [ ] **Step 3: Write the implementation**

`src/components/WeaponTree.vue` — props:

```js
const props = defineProps({
  weapon: { type: String, required: true },
  // Where this tree's picks and budget live. Defaults to the weapon itself; a slot
  // passes its own key when the same weapon sits in two slots (see lib/perkStateKey.js).
  stateKey: { type: String, default: '' },
  data: { type: Object, required: true }, // { perks:[{name,quality,description}], budget }
})
```

Add after `const corrections = usePerkCorrections()`:

```js
const treeKey = computed(() => props.stateKey || props.weapon)
```

Change the two computeds:

```js
const budget = computed(() => planner.weaponBudgets[treeKey.value] ?? props.data.budget ?? 10)
const selected = computed(() => planner.weaponPerks[treeKey.value] || {})
```

Change `toggle`:

```js
  planner.toggleWeaponPerk(treeKey.value, p.id, props.data.budget ?? 10, perkIds.value)
```

Template: `planner.setWeaponBudget(weapon, $event.target.value)` → `planner.setWeaponBudget(treeKey, $event.target.value)`, and `planner.resetWeaponTree(weapon)` → `planner.resetWeaponTree(treeKey)`. Leave `corrections.weaponTree(props.weapon, …)` and every other `weapon` use unchanged: corrections target the weapon, not the slot.

`src/components/WeaponSlot.vue` — add the import after the `weapons` import:

```js
import { perkStateKey } from '../lib/perkStateKey'
```

Replace the `spent` line with:

```js
const stateKey = computed(() => perkStateKey(props.slot, weapon.value))
const spent = computed(() => (weapon.value ? planner.weaponUsed(stateKey.value) : 0))
```

and the tree element with:

```html
      <WeaponTree v-else-if="status === 'ready' && data" :weapon="weapon" :state-key="stateKey" :data="data" />
```

`src/views/Planner.vue` — add after the `createLongPress` import:

```js
import { perkStateKey } from '../lib/perkStateKey'
```

Replace `weaponPerkCount`:

```js
// Weapon perks picked for the weapon currently in a given slot.
function weaponPerkCount(slotKey) {
  const key = perkStateKey(slotKey, planner.activeWeapons[slotKey])
  return key ? planner.weaponUsed(key) : 0
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node_modules/.bin/vitest run src/components src/views`
Expected: PASS (the Armoury tree passes no `stateKey`, so it keeps editing the plain weapon key).

- [ ] **Step 5: Commit**

```bash
git add src/components/WeaponTree.vue src/components/WeaponSlot.vue src/views/Planner.vue src/components/WeaponTree.test.js src/components/WeaponSlot.test.js
git commit -m "$(cat <<'EOF'
feat(planner): each weapon slot keeps its own perk tree and budget

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Server — pin that two copies pass validation

**Files:**
- Modify: `server/src/buildText.test.js` (a new test next to the maximal-build tests, near line 111)

**Interfaces:**
- Consumes: `validateBuildText(b)` from `server/src/buildText.js` (no code change).
- Produces: a regression pin; if validation ever starts rejecting or collapsing the qualified key, this fails.

- [ ] **Step 1: Write the pin test**

Add inside the `describe('validateBuildText', …)` block:

```js
  it('keeps the same weapon in two slots and a perk tree for each copy', () => {
    const out = validateBuildText(
      b({
        className: 'Tactical',
        weapons: { primary: 'Bolt Rifle', secondary: 'Bolt Rifle' },
        weaponPerks: { 'Bolt Rifle': { a: true }, 'Bolt Rifle (Secondary)': { b: true } },
      }),
    )
    expect(out.weapons).toEqual({ primary: 'Bolt Rifle', secondary: 'Bolt Rifle' })
    expect(out.weaponPerks).toEqual({ 'Bolt Rifle': { a: true }, 'Bolt Rifle (Secondary)': { b: true } })
  })
```

- [ ] **Step 2: Run it**

Run: `node_modules/.bin/vitest run server/src/buildText.test.js`
Expected: PASS immediately — this pins behaviour that already holds (`PERK_NAME` allows parentheses; three weapon slots stay under the six-entry cap). It is not red-first by design. To prove the pin bites, temporarily change the key to `'Bolt Rifle <Secondary>'` and confirm FAIL with `A weapon name is not valid.`, then revert.

- [ ] **Step 3: Commit**

```bash
git add server/src/buildText.test.js
git commit -m "$(cat <<'EOF'
test(server): pin that a build can carry the same weapon in two slots

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: e2e and the merge gate

**Files:**
- Create: `e2e/tests/planner-weapons.spec.js`

**Interfaces:**
- Consumes: the running site (`/planner`), default class Tactical, selects labelled `Primary Weapon` / `Secondary Weapon`, `.slot`, `.slot-toggle`, `.wnode`, `.slot-pts`.
- Produces: end-to-end proof both copies are selectable and independent, and survive a reload.

- [ ] **Step 1: Write the spec**

Create `e2e/tests/planner-weapons.spec.js`:

```js
import { test, expect } from '@playwright/test'

// Tactical is the Planner's default class, and the only one that may take the
// Bolt Rifle as a Secondary (Tactical Reserve).
const slot = (page, label) => page.locator('.slot', { has: page.getByLabel(label) })

async function pick(page, label, count) {
  const s = slot(page, label)
  await s.locator('.slot-toggle').click()
  const nodes = s.locator('.wnode')
  for (let i = 0; i < count; i++) await nodes.nth(i).click()
}

test('Tactical can field the Bolt Rifle as Primary and Secondary, each with its own perks', async ({ page }) => {
  await page.goto('/planner')

  await page.getByLabel('Primary Weapon').selectOption('Bolt Rifle')
  await page.getByLabel('Secondary Weapon').selectOption('Bolt Rifle')

  await pick(page, 'Primary Weapon', 2)
  await pick(page, 'Secondary Weapon', 1)

  await expect(slot(page, 'Primary Weapon').locator('.slot-pts')).toHaveText('2 perks')
  await expect(slot(page, 'Secondary Weapon').locator('.slot-pts')).toHaveText('1 perk')

  await page.reload()
  await expect(page.getByLabel('Secondary Weapon')).toHaveValue('Bolt Rifle')
  await expect(slot(page, 'Primary Weapon').locator('.slot-pts')).toHaveText('2 perks')
  await expect(slot(page, 'Secondary Weapon').locator('.slot-pts')).toHaveText('1 perk')
})

test('the Secondary list for Tactical offers the Bolt Rifle but not the other primaries', async ({ page }) => {
  await page.goto('/planner')
  const options = await page.getByLabel('Secondary Weapon').locator('option').evaluateAll((els) => els.map((o) => o.value))
  expect(options).toContain('Bolt Rifle')
  expect(options).not.toContain('Heavy Bolt Rifle')
  expect(options).not.toContain('Auto Bolt Rifle')
})
```

- [ ] **Step 2: Run the whole merge gate locally**

Run each; every one must pass:

```bash
node_modules/.bin/vitest run
node_modules/.bin/vitest run --coverage
node_modules/.bin/stryker run
```

Expected: suite green (all prior tests plus the new ones); coverage thresholds met including `src/lib/perkStateKey.js`; mutation score 100 across the gated list.

- [ ] **Step 3: Run the e2e suite**

Run: `npm run test:e2e` (docker; slow). Expected: `planner-weapons.spec.js` passes. The docker e2e suite is intermittently flaky on `main`; if a *different* spec fails, re-run once and check the failure against `main` before blaming this change. A leftover root-owned `e2e/test-results` from an earlier run may need `sudo rm -rf` before re-running.

- [ ] **Step 4: Eyeball it in the browser**

Run the dev server (`node_modules/.bin/vite`), open `/planner` as Tactical, choose Bolt Rifle in both slots, open both trees, and confirm picks and "Perk-point budget" move independently and the `+N` badges in the build summary match. Report anything that looks off; do not claim the visual check passed unless it was actually done.

- [ ] **Step 5: Commit**

```bash
git add e2e/tests/planner-weapons.spec.js
git commit -m "$(cat <<'EOF'
test(e2e): Bolt Rifle in both Tactical slots keeps separate perks

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```
