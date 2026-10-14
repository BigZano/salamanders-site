# Patch 15.0 data refresh (Spec A)

Branch: `feat/patch-15-data` (worktree off `main`). Date: 2026-10-14.

Spec A of two. **Spec B+C** (Perk Builder: melee version picker, Tactical slot rules, rationale boxes for weapons and prestige picks) is separate and builds on this one.

## Goal

Bring the baked game data up to Patch 15.0 (1 October 2026) and make the Armoury show each melee weapon version's defence type (Block, Balanced or Fencing). No server or DB change.

## What we found

- `src/data/last-patch.json` is Patch 14.0 (28 July). Weapon and perk bakes date from 27 September. Patch 15.0 changed the Tactical class and added weapons.
- The Armoury cannot show defence type because `parseVersions` in `scripts/fetch-wiki-weapons.mjs` treats every non-numeric column as a gauge. The wiki's `Defence` column holds text ("Balance"), fails the number parse, and is dropped. Only melee versions have it.
- Defence type belongs to a weapon **version**, not a weapon. The Thunder Hammer is Balance at Standard-Issue, Fencing at Master-Crafted Beta and Block at Master-Crafted Gamma.
- The wiki's Tactical page now matches 15.0 in 11 grid slots, but lists *Marksman's Mandate* at both level 6 and level 15. The official notes say level 6 became *Improved Efficiency*. That is a wiki error.
- The wiki still shows the prestige perk *Exigency Charge*. The notes say it became *Passive Chambering*.
- The wiki's Tactical text differs from our bake in eight same-name perks (see "Wiki-only edits"). Neither the patch notes nor the third-party guide mention them.
- Hotfix 15.1 (8 October) postdates the wiki pages we compared. It changes only One-Handed Thunder Hammer numbers and perks; it does not touch the Tactical perks or the weapon-slot rules.
- The wiki page for the One-Handed Thunder Hammer is a stub: versions and stats, no perk list. Hotfix 15.1 names its perks (Charge Overflow, Rapid Recharge, Deflective Charge, Reverberating Slam, Perfect Reprisal, Preparedness, Brutal Reforge) but gives no tiers or full text, so the tree cannot be built from any source we have.
- The wiki has also drifted outside Tactical since our 27 September bake, with none of it in the patch notes (see "Held drift").

## Sources and corroboration

Use the wiki, official patch notes, game media and any other trustworthy source, and cross-check them. Rules:

1. Official patch notes win a conflict. The wiki is the structural baseline (grids, weapon lists, stat tables).
2. Each override records its sources. Each fact is tagged **corroborated** (two or more independent sources agree), **single-source** or **wiki-only**.
3. **A wiki change the patch notes do not mention is presumed false** when it changes a number or a behaviour. The previously baked value stays, pinned in overrides. Two kinds of uncorroborated change are accepted: wording-only edits, and edits that follow directly from a corroborated change (for example, text that must cover a Primary Weapon in the Secondary slot because *Tactical Reserve* exists). Every pinned or accepted-uncorroborated item goes on Bret's in-game list. This applies to all classes, not only Tactical.
4. Third-party-only facts, such as slot layouts from community guides, stay tagged and are verified in-game before they are treated as settled.
5. Bret's in-game check is the final word, as with perk corrections.
6. Game media (screenshots, official images) can be read directly. Video cannot, so those facts need Bret's eyes.

Sources used so far: Patch Notes 15.0 (Focus community blog), the September Community Update, the Fandom wiki, and the Neonsect Tactical guide (third party).

## Design

### 1. Data pipeline

- **Defence type.** `parseVersions` reads the `Defence` column into `version.defence`, one of `Block`, `Balanced`, `Fencing`. It maps the wiki's "Balance" to "Balanced". Ranged versions have none. Gauges are unchanged.
- **Weapon list.** `One-Handed Thunder Hammer` joins the melee list in `weapons.json` that drives the bake. The heroic variants arrive as versions: the wiki lists Frost Axe (Power Axe) and Power Maul (One-Handed Thunder Hammer) as Balanced, which matches the notes. Iron Hands is a heroic Auto Bolt Rifle, and the bake picks it up if the wiki lists it.
- **No perk tree yet for the One-Handed Thunder Hammer.** A weapon with versions but no perk table is baked with `perks: []` and `perksPending: true` instead of failing. The Armoury and the Perk Builder show "Perk tree not published yet" for it, and the tree is filled later by a wiki bake or by adding the perks to `weapon-trees.json` by hand. The perk-corrections editor cannot do it: it has no add button for an empty tree, and the page would keep saying "not published yet" because it reads the bake flag.
- **Thunder Hammer name.** Keep the key `Thunder Hammer`, because saved builds store weapon names. Add a display alias map so the UI reads "Two-Handed Thunder Hammer" (the official notes use that name).
- **Class weapon lists.** Update the melee lists in `classes.json`, corroborated by the wiki's per-class weapon tables and the official notes:
  - Tactical: add Power Sword, Power Axe and One-Handed Thunder Hammer.
  - Assault and Bulwark: add One-Handed Thunder Hammer.
  - Techmarine: add Thunder Hammer (the two-handed one) and One-Handed Thunder Hammer.
  - Vanguard, Sniper and Heavy are unchanged.
- **Tactical grid.** `fetch-wiki-perks.mjs` derives each class's `rows` from the wiki's level numbers (level L sits at column `(L-2) % 8`, tier `floor((L-2)/8)`). It rewrites only `rows` in `classes.json`, leaving the hand-kept fields alone, and prints a diff of every changed slot across all classes. That catches unannounced changes in other classes too.
- **Patch overrides.** A committed `src/data/patch-overrides.json`. Each entry names the class and slot (or weapon), the corrected value, and its `sources`. The bakes apply it after parsing the wiki. When the wiki already matches an override, the bake warns so the entry can be deleted. First entries:
  - Tactical level 6 becomes *Improved Efficiency* ("Auspex Scan recharges 25% faster").
  - Prestige *Exigency Charge* becomes *Passive Chambering* ("Any unequipped Ranged Weapon reloads automatically after 10 seconds").
  - Tactical's starting perk text becomes the notes' wording: "Bolt Weapons now penetrate 1 additional enemy and Bolter Weapons get +20% Non Head Shot Damage". Corroborated by the Neonsect guide, which gives the same effects in its own words. The wiki class page is checked at bake time, and the class perk's own wording is confirmed in-game.
  - Four pins that keep the pre-15.0 text for wiki-only changes (see "Wiki-only edits").
- **Held drift.** By rule 3, wiki-only changes are not adopted. Two opt-in flags make that mechanical, and the default behaviour of both scripts is unchanged, so the weekly `data-check` workflow (which runs `wiki:all` and opens a PR) keeps working:
  - `bun run wiki:perks -- --classes Tactical` adopts the wiki for the named classes only, applies overrides, and holds every other class at its previous bake.
  - `bun run wiki:weapons -- --keep-perks` keeps `perks` and `budget` for weapons already in the bake, and takes fresh `versions`, `meta` and `intro`. New weapons are taken whole.
  Both print a drift report of everything held. Adopting a held class or weapon later is one re-run without the flag.
- **Patch marker.** `last-patch.json` is bumped by running `check-updates` once the data is in. That records the latest official announcement, which is Hotfix 15.1 (8 October).

### 2. Existing saved builds

Saved Tactical builds store perk names. All 11 changed slots got a **different effect**, so none is a pure rename. The migration therefore has no `renamed` action (nothing would use it). Actions:

- `replaced`: the pick is dropped, along with its rationale.
- `reworked`: same name, new effect. The pick stays and is flagged, because its rationale may no longer fit.

Match on **(column, old name)**, not name alone, because names moved between slots.

| Level | Old (dropped) | Now in that slot | Notes |
|---|---|---|---|
| 6 | Vital Data | Improved Efficiency | Vital Data moved to level 8 |
| 8 | Close Targeting | Vital Data | |
| 9 | Signal Jammer | Tactical Reserve | |
| 12 | Steady Aim | Focused Strike | |
| 14 | Priority Targeting | Pulse Auspex | |
| 15 | Improved Efficiency | Marksman's Mandate | |
| 16 | Expert Timing | Strongpoint | |
| 18 | Kraken Penetrator Rounds | Armour Reinforcement | Kraken's effect moved into the starting perk |
| 22 | Target Lock | Mobile Auspex | |
| 23 | Precise Calibration | Bladesman's Mandate | |
| 24 | Concentrated Fire | Prime Target | |
| prestige | Exigency Charge | Passive Chambering | picked by name |
| 25 | Marked for Death | (same name) | `reworked`: effect changed from headshot kill to "weakens one Majoris- or Extremis-level enemy" |

Numeric tweaks (for example Secure Stockpile 60 to 90 seconds) neither drop nor flag.

**Where it runs:** when a build is applied (`applyBuildData`), a share link opens (`applyEncoded`), or local storage loads. This keeps working across the three entry points because it matches content, not dates. `reworked` needs the build's `createdAt` (before 2026-10-01), so it applies to gallery builds only.

**Flagging, computed with no DB column:**
- The Perk Builder shows a notice after load: "Tactical rework (Patch 15.0): re-pick N perks" with the old name, what now sits there, and where a moved perk went.
- A gallery card gets a "Pre-15.0 · needs review" chip when the build has a stale pick or a `reworked` one.

### 3. Armoury

- Version dropdown entries read "Master-Crafted – Beta · Fencing".
- The stats header shows a defence badge for the selected version.
- The label only. No claims about parry mechanics, because the forum sources contradict each other.
- The Melee tab lists the One-Handed Thunder Hammer. The alias map applies to the Thunder Hammer label.

### 4. Testing

- Parser test for `Defence`, using saved wiki HTML. "Balance" becomes "Balanced", ranged versions have none, a row with no `Defence` column does not break.
- Data integrity tests: no duplicate perk within a class grid (would have caught Marksman's Mandate), every grid perk has a description, every class weapon exists in the bake, every override names a source.
- Pin tests: after a re-bake, each pinned perk still carries its pre-15.0 text, and the bake warns when the wiki text for a pin changes (re-evaluate) or now equals the pin (redundant).
- Hold-flag tests: `--classes` leaves other classes byte-identical, and `--keep-perks` leaves existing perks byte-identical while taking new versions.
- Migration tests: each row in the table above, including that the same name at a different column is not touched, and that a post-patch build is not flagged.
- Component tests for the Armoury badge and the gallery chip.

## Wiki-only edits (decided by the blend rule)

The wiki's Tactical text differs from our bake in eight same-name perks that neither the patch notes nor the third-party guide mention. By rule 3 above:

| Level | Perk | Wiki change | Decision | Why |
|---|---|---|---|---|
| 2 | Balanced Distribution | 10% to 15% | **Pin old (10%)** | Numeric balance change, not in the notes |
| 3 | Heightened Vigour | adds Block to Parry or Dodge | **Pin old** | Behaviour change, not in the notes |
| 4 | Emperor's Judgement | Primary Weapon to Ranged Weapons | Accept | Follows from Tactical Reserve (a Primary can sit in the Secondary slot) |
| 10 | Plasma Boost | Plasma Incinerator to all Plasma Weapons | **Pin old** | Scope broadened, not in the notes |
| 11 | Relentless Pursuit | 5 to 10 seconds | **Pin old (5)** | Numeric balance change, not in the notes |
| 17 | Radiating Impact | "scales with difficulty" removed | Accept | Wording only; the notes mention only an ally-damage bug fix |
| 19 | Versatility | adds "a Primary in the Secondary slot also benefits" | Accept | Follows from Tactical Reserve |
| 20 | Emperor's Vengeance | drops the non-reload fallback | Accept | No practical effect for Tactical (it has no non-reloading Primary) |

Four pins, four accepts. All eight go on Bret's in-game list, and any decision can be flipped by editing one override entry. The re-bake's text diff across every class applies the same rule to any other wiki-only change it finds.

## Held drift (outside Tactical)

Measured on 2026-10-14 against the 27 September bake. None of it is in the patch notes, so all of it is held:

- **Weapon perks:** 103 wording-only edits, 30 numeric or behavioural ones, and 12 add/remove pairs (mostly capitalisation renames such as *Tide of Battle*). Examples of the numeric ones: Elite Hunter 50% to 25%, Tactical Precision 30% to 20%, Able Precision 5 to 10 seconds, Fast Reload "all Weapons" to "this Weapon".
- **Class perks, non-Tactical:** about 20 numeric or behavioural edits across Vanguard, Techmarine, Heavy, Bulwark, Sniper and Assault; one changed grid slot for Assault; one changed prestige perk for Heavy (*Honed Precision* to *Restorative Capacity*).

The drift report is saved in the handoff for Bret's in-game check. Anything he confirms is adopted by re-running that class or weapon without the hold flag.

## Other open items

- Passive Chambering is not on the wiki yet, so it lives in overrides until the wiki catches up.
- The One-Handed Thunder Hammer perk tree (see the Design section) was filled on 2026-10-14 from Bret's in-game perk list (`docs/handoff/sources/`). The list has no Heroic perk for the Power Maul; ask whether it has one.
- Hotfix 15.1's One-Handed Thunder Hammer numbers (+10% base damage, Power Maul +30% per charge) are PvE damage figures we don't bake, so there is nothing to update.

## Out of scope

Perk Builder version picker, Tactical slot rules (melee blocks primary, Tactical Reserve), and rationale boxes: **Spec B+C**. PvP-only changes. Perk budgets (the notes do not mention any).

## Rollout

No server, schema or Docker change. Ships through the normal deploy. Tests run with `NODE_OPTIONS=--no-experimental-webstorage`.
