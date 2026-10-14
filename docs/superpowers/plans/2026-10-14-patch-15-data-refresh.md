# Patch 15.0 Data Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the baked weapon, perk and class data up to Patch 15.0, show each melee weapon version's defence type in the Armoury, and migrate saved Tactical builds.

**Architecture:** The wiki bake scripts gain pure, tested helpers (defence parsing, a patch-overrides layer, hold flags, a drift report) and two opt-in flags so only corroborated data is adopted. A small pure module migrates saved Tactical builds on load, and the planner store, a notice component and the gallery card use it. The Armoury reads the new `defence` field.

**Tech Stack:** Vue 3, Pinia, Vitest (jsdom for components), `node-html-parser`, Bun/Node scripts.

**Spec:** `docs/superpowers/specs/2026-10-14-patch-15-data-refresh-design.md` (read it first; the plan implements it).

## Global Constraints

- No server, schema or Docker change. The API reads `weapon-trees.json` and `perk-details.json` from `main` on GitHub, so overrides must land in those files.
- Tests run with `NODE_OPTIONS=--no-experimental-webstorage npx vitest run <path>`. The pre-commit hook runs the whole suite.
- Defence labels are exactly `Block`, `Balanced`, `Fencing`. The wiki's "Balance" maps to `Balanced`.
- Patch date is `2026-10-01`. Patch name in UI copy is "Patch 15.0".
- The weapon key stays `Thunder Hammer`; the UI label is "Two-Handed Thunder Hammer".
- Default behaviour of `wiki:perks` and `wiki:weapons` must not change (the weekly `data-check` workflow runs `wiki:all` and opens a PR). The hold flags are opt-in.
- Every override entry carries a non-empty `sources` array.
- `classes.json` and `weapons.json` end with a trailing newline; `perk-details.json`, `weapon-trees.json` and `last-patch.json` do not. Scripts write LF JSON (`JSON.stringify(x, null, 2)`); git's autocrlf handles the working copy.
- Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Work in `.claude/worktrees/patch-15-data` on branch `feat/patch-15-data`. Do not touch `feat/sky-dragons`.

## Review Focus

1. Names reused across slots (*Vital Data* L6 to L8, *Improved Efficiency* L15 to L6): the name in its new slot is kept, in its old slot dropped. Tasks 5, 6.
2. A dropped pick takes its rationale with it; no orphan `justifications` entry survives. Tasks 5, 6.
3. A version row with a blank or unrecognised `Defence` gets no `defence` key and renders without a stray "·". Tasks 1, 8.
4. A weapon with no perk tree (`perksPending`) must not break the Armoury or a Perk Builder slot. Task 8.
5. Old or hostile saved state (malformed localStorage, share links with no `createdAt`, builds missing `prestigePicks`) neither throws nor wrongly flags. Tasks 6, 7.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/lib/drift.mjs` | `listDrift`: compare two keyed lists, split changes into numeric and wording |
| `scripts/lib/weapon-parse.mjs` | Wiki weapon parsers (moved out of the bake script), `normalizeDefence`, `buildTree`, `mergeTrees` |
| `scripts/lib/patch-overrides.mjs` | `deriveRows`, `applyOverrides`, `holdClasses` |
| `src/data/patch-overrides.json` | The sourced overrides (Tactical grid fix, prestige, starting, four pins) |
| `src/data/perk-migrations.json` | Old-slot table for saved-build migration |
| `src/lib/patchMigration.js` | `migrateSelection`, `isStaleBuild` (pure) |
| `src/components/StaleNotice.vue` | The "re-pick these perks" notice |
| `src/data/data-integrity.test.js` | Whole-dataset invariants |
| `docs/handoff/2026-10-14-patch-15-data.md` | In-game verification list and held-drift report |

Modified: `scripts/fetch-wiki-weapons.mjs`, `scripts/fetch-wiki-perks.mjs`, `src/stores/planner.js`, `src/views/Planner.vue`, `src/views/Armoury.vue`, `src/components/WeaponSlot.vue`, `src/components/BuildCard.vue`, `src/lib/weapons.js`, and the data files `weapons.json`, `classes.json`, `weapon-trees.json`, `perk-details.json`, `last-patch.json`.

---

### Task 1: Weapon parsers with defence type

**Files:**
- Create: `scripts/lib/drift.mjs`, `scripts/lib/drift.test.mjs`, `scripts/lib/weapon-parse.mjs`, `scripts/lib/weapon-parse.test.mjs`
- Modify: `scripts/fetch-wiki-weapons.mjs` (import the moved parsers; keep `run()` working until Task 2)

**Interfaces:**
- Produces from `drift.mjs`: `listDrift(oldItems: {key:string,text:string}[], newItems: {key:string,text:string}[]): { added: string[], removed: string[], changed: { key:string, old:string, new:string, kind:'numeric'|'wording' }[] }`. `kind` is `'numeric'` when the sequences of numbers (`/\d+(?:\.\d+)?/g`) in the two texts differ.
- Produces from `weapon-parse.mjs`:
  - `normalizeDefence(raw: string): 'Block'|'Balanced'|'Fencing'|null` (case-insensitive; "Balance" and "Balanced" both give `'Balanced'`; anything else `null`).
  - `parseVersions(doc): Version[]`, `Version = { quality, name, gauges, figures, defence? }`. The `Defence` column is never a gauge; `defence` is present only when `normalizeDefence` returns non-null.
  - `parsePerks`, `parseBudget`, `parseMeta`, `parseIntro` (moved unchanged).
  - `buildTree(doc): { perks, budget, intro, meta, versions, perksPending?: true }`. Throws `Error('no readable perk table or versions')` when both are empty. When perks are empty but versions exist: `perks: []`, `perksPending: true`.
  - `mergeTrees(previous: Record<string,Tree>, fresh: Record<string,Tree>, opts: { keepPerks: boolean }): Record<string,Tree>`.

- [ ] **Step 1: Write failing tests** in `scripts/lib/drift.test.mjs`: identical lists give empty added, removed and changed; "for 5 seconds" to "for 10 seconds" is `kind: 'numeric'`; "Reload all Weapons 10% faster" to "This Weapon reloads 10% faster" is `kind: 'wording'`; keys only in one list land in `added` / `removed`.
- [ ] **Step 2: Write failing tests** in `scripts/lib/weapon-parse.test.mjs`, building docs with `parse` from `node-html-parser`. Fixture A is an `<h3>In-game shown stats</h3>` table with columns Quality, Version Name, Strength, Speed, Cleaving Potential, Defence and rows (Standard, Standard-Issue, 5, 4+, 4, Balance), (Master-Crafted, Master-Crafted - Beta, 10, 2+, 4, Block), (Master-Crafted, Master-Crafted - Gamma, 6, 8+, 2, Fencing). Assertions:
  - `versions.map(v => v.defence)` equals `['Balanced','Block','Fencing']`.
  - `Object.keys(versions[0].gauges)` equals `['Strength','Speed','Cleaving Potential']` and `versions[0].gauges.Speed.value` is `4.5`.
  - A ranged table (Firepower…, Magazine Capacity, no Defence column): `'defence' in v` is `false`, `figures['Magazine Capacity']` kept.
  - Defence cell `'—'` or `''`: no `defence` key.
  - `normalizeDefence('balance')`, `('BALANCED')` give `'Balanced'`; `('Parry')` gives `null`.
  - `buildTree`: fixture A plus a `<h2>Perk List</h2>` table gives no `perksPending`; fixture A alone gives `perks` equal `[]` and `perksPending === true`; an empty doc throws `/no readable perk table or versions/`.
  - `mergeTrees` with `keepPerks: true`: an existing weapon keeps `previous.perks` and `previous.budget` but takes `fresh.versions`; a weapon only in `fresh` is taken whole; a weapon only in `previous` (failed fetch) is kept; with `keepPerks: false` fresh wins and previous-only weapons are still kept.
- [ ] **Step 3: Run** `npx vitest run scripts/lib/drift.test.mjs scripts/lib/weapon-parse.test.mjs`. Expected: FAIL (modules missing).
- [ ] **Step 4: Implement** `drift.mjs`, then `weapon-parse.mjs` (move the parsers out of `fetch-wiki-weapons.mjs`; in `parseVersions` handle the `Defence` key before the gauge parse), then change `fetch-wiki-weapons.mjs` to import them and use `buildTree` in `run()`.
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Commit** `feat(bake): parse weapon defence type, tolerate weapons with no perk table`.

---

### Task 2: Weapon bake, class weapon lists, weapon invariants

**Files:**
- Modify: `scripts/fetch-wiki-weapons.mjs` (`--keep-perks` flag, held-drift report), `src/data/weapons.json`, `src/data/classes.json`, `src/data/weapon-trees.json` (regenerated)
- Create: `src/data/data-integrity.test.js` (weapon half)

**Interfaces:**
- Consumes: `buildTree`, `mergeTrees`, `listDrift`.
- Produces: `weapon-trees.json` entries with `versions[].defence`, and `perksPending: true` on `One-Handed Thunder Hammer`.

- [ ] **Step 1: Write failing tests** in `src/data/data-integrity.test.js` (imports the JSON files directly):
  - every name in `weapons.json` `fallbackWeapons` except `Heavy Firearms Melee` is a key of `weapon-trees.json` `weapons`.
  - every weapon in every class's `weapons` lists appears in `weapons.json` `fallbackWeapons` for that slot.
  - `Thunder Hammer` versions: `Standard-Issue` is `Balanced`, `Master-Crafted - Beta` is `Fencing`, `Master-Crafted - Gamma` is `Block`.
  - `Power Axe` version `Frost Axe` and `One-Handed Thunder Hammer` version `Power Maul` are both `Balanced`.
  - every version of `Chainsword`, `Combat Knife`, `Power Fist`, `Power Sword`, `Thunder Hammer`, `Power Axe`, `Omnissiah Axe` and `One-Handed Thunder Hammer` has a `defence` in `['Block','Balanced','Fencing']`; no version of any primary or secondary weapon has one.
  - `One-Handed Thunder Hammer`: `perksPending === true`, `perks` equals `[]`, 10 versions.
  - `Auto Bolt Rifle` perk `Fast Reload` (Master-Crafted) still reads "Reload all Weapons 10% faster" (perks held).
  - class melee lists: Tactical includes `Power Sword`, `Power Axe`, `One-Handed Thunder Hammer`; Assault and Bulwark include `One-Handed Thunder Hammer`; Techmarine includes `Thunder Hammer` and `One-Handed Thunder Hammer`; Vanguard, Sniper and Heavy are unchanged.
- [ ] **Step 2: Run** `npx vitest run src/data/data-integrity.test.js`. Expected: FAIL.
- [ ] **Step 3: Edit** `weapons.json`: add `"One-Handed Thunder Hammer"` after `"Thunder Hammer"` in `fallbackWeapons.melee`. Edit `classes.json` melee lists: Tactical `["Combat Knife","Chainsword","Power Sword","Power Axe","One-Handed Thunder Hammer"]`; Assault `["Chainsword","Thunder Hammer","One-Handed Thunder Hammer","Power Fist","Power Sword","Power Axe"]`; Bulwark the same list; Techmarine `["Combat Knife","Thunder Hammer","One-Handed Thunder Hammer","Power Sword","Power Axe","Omnissiah Axe"]`.
- [ ] **Step 4: Implement the flag** in `fetch-wiki-weapons.mjs`: read the previous `weapon-trees.json`, build fresh trees with `buildTree`, combine with `mergeTrees(previous, fresh, { keepPerks: process.argv.includes('--keep-perks') })`, and when keeping perks print one line per weapon from `listDrift` over `${quality}|${name}` keys: `held <weapon>: <n> wording, <n> numeric, <n> added, <n> removed`.
- [ ] **Step 5: Run** `node scripts/fetch-wiki-weapons.mjs --keep-perks`. Expected: `One-Handed Thunder Hammer` baked with 0 perks and 10 versions; only `Heavy Firearms Melee` (if any) under "Not baked"; `held` lines match the spec's figures (about 103 wording, 30 numeric, 12 added/removed in total). Save the full output for Task 9.
- [ ] **Step 6: Run** `npx vitest run src/data/data-integrity.test.js` and `git diff --stat src/data`. Expected: PASS; `weapon-trees.json` changes are `versions` (defence), new weapon, `meta`/`intro` only.
- [ ] **Step 7: Commit** `data(weapons): bake defence types and the One-Handed Thunder Hammer, class melee lists`.

---

### Task 3: Patch-overrides layer

**Files:**
- Create: `scripts/lib/patch-overrides.mjs`, `scripts/lib/patch-overrides.test.mjs`, `src/data/patch-overrides.json`

**Interfaces:**
- Produces:
  - `deriveRows(perkList: Perk[]): string[][]`, `Perk = { level:number|null, name:string, description:string }`. Level `L` lands at `rows[Math.floor((L-2)/8)][(L-2)%8]`. Throws `Error('level out of range: <L>')` for `L<2` or `L>25`, and on a duplicate level.
  - `applyOverrides(className: string, state: { perkList: Perk[], prestige: Perk[] }, overrides: object): { perkList: Perk[], prestige: Perk[], starting: string|null, warnings: string[] }`. Pure; unknown class returns the state unchanged with no warnings.
  - `holdClasses<T>(previous: Record<string,T>, fresh: Record<string,T>, adopt: string[]): Record<string,T>`: names in `adopt` take `fresh`, all others take `previous` (or `fresh` if there is no previous).
- Override JSON shape (per class): `grid[{level,name,description,sources}]`, `prestige[{replaces,name,description,sources}]`, `pins[{name,description,wikiSaid,reason,sources}]`, `starting{text,sources}`.

- [ ] **Step 1: Write failing tests**:
  - `deriveRows`: a 24-perk list (levels 2 to 25) gives 3 rows of 8; level 6 is `[0][4]`, level 25 is `[2][7]`; level 1, 26 and a repeated level throw.
  - `applyOverrides` grid: the entry at the given level replaces name and description; if the wiki list already has that name at that level, a warning contains `stale override`.
  - prestige: the perk named `replaces` is replaced and keeps its position; a missing target adds a warning.
  - pins: description becomes the pinned text; if the wiki text is neither `wikiSaid` nor the pin, a warning contains `re-evaluate`; if the wiki text equals the pin, a warning contains `redundant`.
  - `starting` is returned as the text, else `null`; a class with no overrides returns no warnings.
  - `holdClasses`: with `adopt: ['Tactical']` the other classes' objects are the `previous` ones (same reference), and a class missing from `previous` takes `fresh`.
- [ ] **Step 2: Run** `npx vitest run scripts/lib/patch-overrides.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `patch-overrides.mjs`.
- [ ] **Step 4: Create** `src/data/patch-overrides.json` with `patch: "15.0"`, `date: "2026-10-01"` and `classes.Tactical`:
  - `grid`: level 6, name `Improved Efficiency`, description `Auspex Scan recharges 25% faster`, sources `["Patch Notes 15.0 (Focus)","Neonsect Tactical guide"]`. Reason: the wiki lists *Marksman's Mandate* at levels 6 and 15.
  - `prestige`: replaces `Exigency Charge`, name `Passive Chambering`, description `Any unequipped Ranged Weapon reloads automatically after 10 seconds`, same sources.
  - `starting`: text `Bolt Weapons now penetrate 1 additional enemy and Bolter Weapons get +20% Non Head Shot Damage`, same sources.
  - `pins` (each with `reason: "Not in Patch Notes 15.0 or the Neonsect guide; presumed false"`, sources `["Patch Notes 15.0 (Focus): not mentioned","Neonsect Tactical guide: not mentioned"]`):
    - `Balanced Distribution`: description `Your Primary Weapon deals 10% more Damage, but your Secondary Weapon deals 10% less Damage`; wikiSaid `Your Primary Weapon deals 15% more Damage, but your Secondary Weapon deals 15% less Damage`.
    - `Heightened Vigour`: description `After a perfectly timed Parry or Dodge, you deal 10% more Melee and Gun Strike Damage, do not lose control upon taking Heavy Hits and you cannot be knocked back for 10 seconds`; wikiSaid `After a perfectly timed Parry, Block, or Dodge, you deal 10% more Melee and Gun Strike Damage, do not lose control upon taking Heavy Hits, and cannot be knocked back for 10 seconds`.
    - `Plasma Boost`: description `When the Plasma Incinerator is 30% Overheated, its Damage increases by 40% and their Charged Shots use 1 less energy`; wikiSaid `When Plasma Weapons are 30% Overheated, their Damage increases by 40% and their Charged Shots use 1 less energy`.
    - `Relentless Pursuit`: description `After a Gun Strike, Ranged Damage increases by 25% for 5 seconds`; wikiSaid `After a Gun Strike, Ranged Damage increases by 25% for 10 seconds`.
- [ ] **Step 5: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 6: Commit** `feat(bake): patch-overrides layer with sourced Tactical corrections`.

---

### Task 4: Class perk bake, Tactical grid and class invariants

**Files:**
- Modify: `scripts/fetch-wiki-perks.mjs` (`--classes`, overrides, row derivation, drift report), `src/data/classes.json` (`rows`, Tactical `starting`), `src/data/perk-details.json` (regenerated)
- Modify: `src/data/data-integrity.test.js` (class half)

**Interfaces:**
- Consumes: `deriveRows`, `applyOverrides`, `holdClasses`, `listDrift`, `patch-overrides.json`.
- Produces: `classes.json` Tactical `rows` per the spec; `perk-details.json` Tactical perks and prestige list.

- [ ] **Step 1: Write failing tests** appended to `data-integrity.test.js`:
  - for every class, no perk name appears twice in `rows.flat()`, and every grid perk has a non-empty description in `perk-details.json`.
  - Tactical rows by slot: L6 `[0][4]` is `Improved Efficiency`; L8 `[0][6]` `Vital Data`; L9 `[0][7]` `Tactical Reserve`; L12 `[1][2]` `Focused Strike`; L14 `[1][4]` `Pulse Auspex`; L15 `[1][5]` `Marksman's Mandate`; L16 `[1][6]` `Strongpoint`; L18 `[2][0]` `Armour Reinforcement`; L22 `[2][4]` `Mobile Auspex`; L23 `[2][5]` `Bladesman's Mandate`; L24 `[2][6]` `Prime Target`; L25 `[2][7]` `Marked for Death`.
  - Tactical prestige names include `Passive Chambering` (description as in the override) and exclude `Exigency Charge`; Tactical `starting` equals the override text.
  - pins hold: each pin's `description` equals the Tactical perk description in `perk-details.json`.
  - accepted: `Emperor's Judgement` contains `Ranged Weapons`; `Versatility` contains `Primary Weapon is equipped in the Secondary Weapon slot`; `Secure Stockpile` contains `90 seconds`.
  - every override entry (grid, prestige, pins, starting) has a non-empty `sources` array.
- [ ] **Step 2: Run** `npx vitest run src/data/data-integrity.test.js`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the script changes. `--classes A,B` selects adopted classes (default: all, preserving today's behaviour). For each class: parse the perk list and prestige, `applyOverrides`, derive `rows`, build the keyed `perks` object. Combine with `holdClasses` for `perk-details.json` (key `classes`) and for the `rows` and `starting` in `classes.json` (all other `classes.json` fields untouched). Print each adopted class's changed grid slots, any warnings, and for every held class the `listDrift` summary (`held <Class>: <n> grid, <n> numeric, <n> wording`, plus a `prestige CHANGED` note). Write `classes.json` with a trailing newline.
- [ ] **Step 4: Run** `node scripts/fetch-wiki-perks.mjs --classes Tactical`. Expected: Tactical reports 11 changed grid slots, 0 warnings; held lines match the spec (Assault 1 grid, Heavy prestige changed, Vanguard 6 numeric, and so on). Save the full output for Task 9.
- [ ] **Step 5: Run** the Step 2 command and `git diff --stat src/data`. Expected: PASS; `classes.json` changes only Tactical `rows` and `starting`; `perk-details.json` changes only Tactical (and its `fetched` stamp).
- [ ] **Step 6: Commit** `data(tactical): Patch 15.0 rework, sourced overrides, held drift for other classes`.

---

### Task 5: Saved-build migration module

**Files:**
- Create: `src/data/perk-migrations.json`, `src/lib/patchMigration.js`, `src/lib/patchMigration.test.js`

**Interfaces:**
- Produces:
  - `Notice = { kind:'replaced'|'reworked', level:number|null, was:string, now:string, note?:string }` (`level` is `null` for prestige).
  - `migrateSelection({ className, selectedPerks, justifications, prestigePicks, createdAt }): { selectedPerks, justifications, prestigePicks, notices: Notice[] }`. Pure; never mutates its input. `selectedPerks` and `justifications` are keyed by column (`(level-2)%8`).
  - `isStaleBuild(build: { className, perks?, prestigePicks?, createdAt? }): boolean`; true when `migrateSelection` yields at least one notice, with `selectedPerks` built from `build.perks[col]`. Tolerates missing `perks` and `prestigePicks`.
- Data: `perk-migrations.json` has `patch: "15.0"`, `date: "2026-10-01"`, and `classes.Tactical.slots` as `{level,was,now,action,note?}` entries: 6 Vital Data to Improved Efficiency (note "Vital Data moved to level 8"); 8 Close Targeting to Vital Data; 9 Signal Jammer to Tactical Reserve; 12 Steady Aim to Focused Strike; 14 Priority Targeting to Pulse Auspex; 15 Improved Efficiency to Marksman's Mandate; 16 Expert Timing to Strongpoint; 18 Kraken Penetrator Rounds to Armour Reinforcement (note "its effect moved into the starting perk"); 22 Target Lock to Mobile Auspex; 23 Precise Calibration to Bladesman's Mandate; 24 Concentrated Fire to Prime Target; all `replaced`; plus 25 Marked for Death to Marked for Death as `reworked`. `classes.Tactical.prestige` has `{was:"Exigency Charge",now:"Passive Chambering",action:"replaced"}`.

- [ ] **Step 1: Write failing tests**:
  - a Tactical `{7:'Signal Jammer'}` with `justifications {7:'jam'}`: result `selectedPerks` has no key 7, `justifications` has no key 7, one notice `{kind:'replaced', level:9, was:'Signal Jammer', now:'Tactical Reserve'}`.
  - name reuse: `{4:'Vital Data'}` is dropped (level 6 slot); `{6:'Vital Data'}` is kept with no notice; `{5:'Improved Efficiency'}` is dropped; `{4:'Improved Efficiency'}` is kept.
  - `reworked`: `{7:'Marked for Death'}` with `createdAt:'2026-09-20T00:00:00Z'` is kept and yields a `reworked` notice; with `createdAt:'2026-10-05T00:00:00Z'` or none yields no notice.
  - prestige `['Acuity','Exigency Charge',null,null]` becomes `['Acuity',null,null,null]` with a notice whose `level` is `null`.
  - class `Vanguard` with the same names is untouched with `notices` equal `[]`.
  - inputs are not mutated (deep-freeze the arguments).
  - `isStaleBuild`: true for a Tactical build whose `perks[7]` is `Signal Jammer`; false for the same build with `Tactical Reserve`; false for a build with no `perks`, no `prestigePicks`, no `createdAt`; true for `perks[7]` `Marked for Death` with an old `createdAt`.
- [ ] **Step 2: Run** `npx vitest run src/lib/patchMigration.test.js`. Expected: FAIL.
- [ ] **Step 3: Create** the JSON and implement `patchMigration.js` (derive `col = (level - 2) % 8`).
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(builds): migrate saved Tactical builds across the 15.0 rework`.

---

### Task 6: Planner store wiring and the stale-perk notice

**Files:**
- Modify: `src/stores/planner.js`, `src/stores/planner.test.js`, `src/views/Planner.vue`
- Create: `src/components/StaleNotice.vue`, `src/components/StaleNotice.test.js`

**Interfaces:**
- Consumes: `migrateSelection`, `Notice`.
- Produces: planner state `staleNotices: Notice[]` (persisted with the rest of the saved state); action `dismissStaleNotices(): void`. `StaleNotice` props `{ notices: Notice[] }`, emits `dismiss`.

- [ ] **Step 1: Write failing store tests** in `planner.test.js` (same `setActivePinia` / `localStorage.clear()` setup):
  - `applyBuildData` with a Tactical build `{className:'Tactical', perkIds:{7:'Signal Jammer'}, justifications:{7:'jam'}, prestigePicks:['Exigency Charge',null,null,null], createdAt:'2026-09-20T00:00:00Z'}`: `selected` has no key 7, `justified` has no key 7, the prestige pick is cleared, `staleNotices` has 2 entries.
  - same with `perkIds:{7:'Marked for Death'}`: the pick stays and `staleNotices[0].kind` is `'reworked'`.
  - `applyEncoded` of an encoded Tactical build holding `Signal Jammer` drops it with one notice (no `createdAt`, so `Marked for Death` is not flagged).
  - `hydrate` with saved state holding an old Tactical pick drops it and sets a notice; `hydrate` with malformed JSON in localStorage does not throw.
  - a current Tactical build and a Vanguard build produce `staleNotices` equal `[]`.
  - `dismissStaleNotices` empties the list and persists it.
- [ ] **Step 2: Write failing component tests** in `StaleNotice.test.js` (`// @vitest-environment jsdom`): with no notices nothing renders (`wrapper.find('.stale-notice').exists()` is `false`); with one `replaced` and one `reworked` notice it renders two `.stale-item` rows, the heading names the replaced count ("re-pick 1 perk"), a replaced row shows `was` and `now`, a `null`-level row reads "Prestige"; clicking `.stale-dismiss` emits `dismiss`.
- [ ] **Step 3: Run** `npx vitest run src/stores/planner.test.js src/components/StaleNotice.test.js`. Expected: FAIL.
- [ ] **Step 4: Implement**: add `staleNotices` state and `dismissStaleNotices`; a private helper that runs `migrateSelection` over a class's `selectedPerks`, `justifications` and `prestigePicks`, writes the result back and replaces `staleNotices`; call it from `applyBuildData` (pass `r.createdAt`), `applyEncoded` (no date) and `hydrate` (no date, every class present in the saved state; keep it inside the existing try/catch); include `staleNotices` in `persist`. Create `StaleNotice.vue` (`<aside class="stale-notice" role="status">`, `.stale-item` rows, `button.stale-dismiss`) in the style of the existing panels. In `Planner.vue` render it directly after the `.classbar` div: `<StaleNotice :notices="planner.staleNotices" @dismiss="planner.dismissStaleNotices()" />`.
- [ ] **Step 5: Run** the Step 3 command. Expected: PASS.
- [ ] **Step 6: Commit** `feat(planner): flag perks dropped by the Tactical rework`.

---

### Task 7: Gallery chip

**Files:**
- Modify: `src/components/BuildCard.vue`, `src/components/BuildCard.test.js`

**Interfaces:**
- Consumes: `isStaleBuild(build)`.

- [ ] **Step 1: Write failing tests** in `BuildCard.test.js` (reuse its `build` helper and `router`): a Tactical build with `perks: [null,null,null,null,null,null,null,'Signal Jammer']` renders `.b-stale` with text `Pre-15.0 · needs review`; the same build with `Tactical Reserve` has no `.b-stale`; a Tactical build with `perks[7]` `Marked for Death` and `createdAt: '2026-09-20T00:00:00Z'` shows the chip; the existing helper's build (no `prestigePicks`, no `createdAt`, `perks: []`) shows none.
- [ ] **Step 2: Run** `npx vitest run src/components/BuildCard.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement**: import `isStaleBuild`, render `<span v-if="isStaleBuild(build)" class="b-stale" title="Perks in this build changed in Patch 15.0. Open it in the builder to review.">Pre-15.0 · needs review</span>` inside `.b-card-top`, styled to match the existing `.b-class` chip.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(builds): flag pre-15.0 builds that need review in the gallery`.

---

### Task 8: Armoury and weapon slot: defence badge, labels, pending tree

**Files:**
- Modify: `src/lib/weapons.js`, `src/lib/weapons.test.js`, `src/views/Armoury.vue`, `src/components/WeaponSlot.vue`
- Create: `src/views/Armoury.test.js`, `src/components/WeaponSlot.test.js`

**Interfaces:**
- Produces from `weapons.js`: `DISPLAY_NAME: Record<string,string>` (`{ 'Thunder Hammer': 'Two-Handed Thunder Hammer' }`), `weaponLabel(name: string): string`, `versionLabel(v: { name:string, quality?:string, defence?:string }): string`.

- [ ] **Step 1: Write failing tests**:
  - `weapons.test.js`: `weaponLabel('Thunder Hammer')` is `'Two-Handed Thunder Hammer'`, `weaponLabel('Power Axe')` is `'Power Axe'`; `versionLabel({name:'Master-Crafted - Beta',quality:'Master-Crafted',defence:'Fencing'})` is `'Master-Crafted - Beta — Master-Crafted · Fencing'`; with no defence there is no `·`; with no quality: `versionLabel({name:'Power Maul',defence:'Balanced'})` is `'Power Maul · Balanced'`.
  - `Armoury.test.js` (jsdom; pinia plus a memory router; `stubs: { WeaponTree: true }`): after choosing the Melee tab, `.w-item` texts include `Two-Handed Thunder Hammer` and `One-Handed Thunder Hammer`; clicking Thunder Hammer shows `.defence` with text `Balanced` (Standard-Issue), and setting the version select to `Master-Crafted - Gamma` changes it to `Block`; clicking One-Handed Thunder Hammer shows `.w-pending` and no WeaponTree; a ranged weapon shows no `.defence`.
  - `WeaponSlot.test.js` (jsdom; pinia; set Tactical with `planner.setWeapon('melee','One-Handed Thunder Hammer')`): opening the tree shows `.slot-pending` containing "not published yet" and does not render WeaponTree; the select's option for Thunder Hammer reads `Two-Handed Thunder Hammer`.
- [ ] **Step 2: Run** `npx vitest run src/lib/weapons.test.js src/views/Armoury.test.js src/components/WeaponSlot.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers; in `Armoury.vue` use `weaponLabel` for list buttons, the hero name and the search filter (match either the key or the label), `versionLabel` for the version `<option>` text, a `<span v-if="version?.defence" class="defence" :data-defence="version.defence">{{ version.defence }}</span>` in `.stats-head`, and `<WeaponTree v-if="!data.perksPending" …/><p v-else class="w-pending">Perk tree not published yet. The wiki has this weapon's stats but not its perk list.</p>`. In `WeaponSlot.vue` use `weaponLabel` in the options and add a `slot-pending` message for `data.perksPending` before the WeaponTree branch. Style the badge to match the existing chips; no new colours beyond the existing tokens.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(armoury): show defence type per version and label the two-handed Thunder Hammer`.

---

### Task 9: Patch marker, handoff and full verification

**Files:**
- Modify: `src/data/last-patch.json`
- Create: `docs/handoff/2026-10-14-patch-15-data.md`

- [ ] **Step 1: Run** `node scripts/check-updates.mjs`. Expected: prints the latest official patch (Hotfix 15.1, 8 October) as NEW and rewrites `last-patch.json`. If the feed returns something else, record that in the handoff.
- [ ] **Step 2: Write the handoff** with: what shipped; the in-game verification list (the eight wiki-only Tactical decisions from the spec with their accept or pin outcome, the Tactical starting-perk wording, the Passive Chambering text, a screenshot request for the One-Handed Thunder Hammer perk screen); the held-drift reports saved from Task 2 Step 5 and Task 4 Step 4, trimmed to the lists; how to adopt a held class (`bun run wiki:perks -- --classes Heavy`) or weapon set (`bun run wiki:weapons`); and the deploy note: the API reads the bake from `main` on GitHub with a 10-minute cache, so no redeploy is needed and the weekly `data-check` workflow will open a PR containing the held drift.
- [ ] **Step 3: Run the whole suite and build**: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run` and `bun run build`. Expected: all tests pass (1173 plus the new ones, 4 skipped as before), build succeeds.
- [ ] **Step 4: Look at it**: `bun run dev`, open `/armoury`, Melee tab, Thunder Hammer; confirm the badge changes with the version and One-Handed Thunder Hammer shows the pending message; open `/planner` with a Tactical share link containing `Signal Jammer` and confirm the notice. State plainly in the commit or handoff if the browser check was not done.
- [ ] **Step 5: Commit** `docs(patch-15): handoff with in-game verification list and held drift`.
