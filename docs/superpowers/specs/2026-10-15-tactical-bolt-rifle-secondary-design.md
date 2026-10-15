# Tactical Bolt Rifle as a Secondary — design

Tactical's `Tactical Reserve` perk replaces the Secondary Weapon with a Primary
Bolt Rifle, and `Versatility` extends its bonus to a Primary equipped in the
Secondary slot. The Planner must let a Tactical pick the Bolt Rifle — and only
the Bolt Rifle — as their Secondary, and configure it independently of a Bolt
Rifle in the Primary slot.

## Requirements

- Tactical's Secondary dropdown offers `Bolt Rifle`, in addition to its pistols.
  No other primary is offered.
- The Bolt Rifle may be both Primary and Secondary at once. The two copies have
  their own perk tree picks and their own perk budget.
- The Bolt Rifle is always offered; it is not gated on having picked
  `Tactical Reserve`.
- Existing builds, share links, localStorage state and gallery rows keep working
  with no migration.

## Out of scope

- An "Equip as secondary" action in the Armoury. The Armoury keeps equipping to
  a weapon's native slot.
- Gating the option on `Tactical Reserve` being picked.
- Showing weapon perks on gallery cards (`BuildCard` does not show them today).

## Why this is more than a data change

Weapon perk picks and budgets are keyed by weapon *name*: `weaponPerks[weapon]`
and `weaponBudgets[weapon]`. The same key runs through the store actions, the
equipped-weapon snapshot, the `wp` share-link payload, the `weaponPerks` build
payload the server stores as `weapon_perks` jsonb, the per-slot count in
`Planner.vue`, and `WeaponTree`. Two Bolt Rifles would write to the same entry.

## Approach: slot-qualified key, only for off-slot weapons

Re-keying everything by slot would be the cleaner model but needs a migration of
localStorage, share links and the live builds table, for one weapon. Instead the
key stays the weapon name wherever the weapon is in its own slot (every case
today) and is qualified only where a weapon sits in a slot it does not belong to.

### `perkStateKey(slot, weapon)` — `src/lib/weapons.js`

Pure. "Native" means the weapon is in `weapons.json` `fallbackWeapons[slot]`.

| Input | Result |
|---|---|
| blank / missing `weapon` | `''` |
| `weapon` native to `slot` | `weapon` |
| `weapon` not native to `slot`, native to another slot | `"<weapon> (<Slot>)"`, e.g. `Bolt Rifle (Secondary)` |
| `weapon` not in any slot list, or unknown `slot` | `weapon` (a weapon the bake does not know yet never gets a surprise key) |

`<Slot>` is the slot name with its first letter capitalised. The qualified key
contains only characters the server's `PERK_NAME` already allows (letters,
spaces, parentheses).

### Wiring

- **Store (`src/stores/planner.js`).** `toggleWeaponPerk`, `weaponUsed`,
  `weaponBudget`, `setWeaponBudget` and `resetWeaponTree` are already
  string-keyed and keep their signatures; callers pass the key.
  `snapshotWeaponPerks` changes from looping over equipped weapon names to
  looping over slot/weapon pairs and using `perkStateKey`, so the payload is e.g.
  `{ "Bolt Rifle": {…}, "Bolt Rifle (Secondary)": {…} }`. `encode`,
  `applyEncoded`, `buildSnapshot` and `applyBuildData` already copy arbitrary
  keys and need no change.
- **`WeaponTree.vue`.** New optional prop `stateKey`, defaulting to `weapon`. It
  drives the selected picks, budget, used count, toggle, budget edit and reset.
  `weapon` still drives the data and perk-correction targets, so a correction to
  the Bolt Rifle applies to both copies.
- **`WeaponSlot.vue`.** Passes `perkStateKey(slot, weapon)` as `stateKey` and
  uses it for the perk count.
- **`Planner.vue` `weaponPerkCount`.** Uses `perkStateKey(slotKey, w)`.
- **Armoury.** Passes nothing; unchanged.

### Data and server

- `src/data/classes.json`: add `"Bolt Rifle"` to `Tactical.weapons.secondary`.
- `server/src/buildText.js`: no code change. `weaponsOf` only checks slot names
  and `weaponPerksOf` accepts any `PERK_NAME` key; entry caps (6) exceed the
  maximum possible (3).
- Old rows, links and localStorage hold only native keys, which are unchanged.
- A switched-away secondary keeps its stored picks (so switching back restores
  them), as every other weapon does today.

## Testing

Adversarial, per the project's testing posture; behaviour only, no mock-call
assertions.

- **`perkStateKey`** (unit + property): every row of the table above; a property
  over every class's slot lists that the keys within one loadout are pairwise
  distinct; hostile inputs — blank, `null`, unknown slot, wrong-case slot,
  unknown weapon, a weapon native to the slot. Mutation score 100% on the
  function.
- **Integrity (`src/data/data-integrity.test.js`).**
  - The existing "class weapons exist for that slot" test gains an exact
    allowlist: the only off-slot weapon anywhere is Tactical / secondary /
    Bolt Rifle, so any other stray cross-slot weapon still fails.
  - Every off-slot weapon is native to some other slot.
  - No weapon is native to two slots (otherwise two keys could collide).
  - Tactical lists Bolt Rifle in both primary and secondary.
- **Store (`planner.test.js`).** With the Bolt Rifle in both slots: a perk
  toggled in one leaves the other at 0; budgets are independent; reset on one
  leaves the other; the snapshot carries both keys; a share link round-trips
  through `encode` / `applyEncoded`; switching the secondary away and back
  restores its picks; non-Tactical builds are byte-identical to before.
- **Server (`buildText.test.js`).** `validateBuildText` keeps
  `weapons: { primary: 'Bolt Rifle', secondary: 'Bolt Rifle' }` and a
  `weaponPerks` entry keyed `Bolt Rifle (Secondary)`.
- **Components.** `WeaponTree` honours `stateKey`; `WeaponSlot` shows the
  per-slot count and passes the key.
- **e2e.** One Planner spec: Tactical, Bolt Rifle in both slots, one perk picked
  in each tree, reload, both persist. The docker e2e suite is intermittently
  flaky on main; a failure here is checked against that before blaming the
  change.
- **Gate.** Whole-suite regression (no new failures) and 100% mutation on
  `perkStateKey`, via the repo's pre-push gate.
