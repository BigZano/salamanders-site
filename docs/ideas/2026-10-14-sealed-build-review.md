# sealed.build ("Purity Seal") review: where we differ, and what to earmark

Status: review notes from 2026-10-14. Nothing here is built. Read-only: the site was browsed like a visitor, and its one public data file (`/data/game.json`, allowed by its robots.txt) was read once into scratch space to cross-check our data. None of its data or text is copied into this repo, and nothing should be.

## What it is

A Space Marine 2 build planner with a public build library, a "Codex" reference and a patch ledger. At review time it had 20 public builds and 8 members, so it is small in community and strong in data. Its builds are mostly curated from creator videos (credited, with a "claim or remove" link for the creator).

## The Codex

- **Data source.** Perk trees, weapon stats, icons and texts are extracted from the game files and labelled with the game version ("Game data for Hotfix 15.1"). Official patch notes are layered on top. A few values are marked "unverified" (for example the Auspex Scan cooldown, "community-measured"), and rows marked `?` are shown as not yet verified. Every Codex page has a "Report wrong data" link.
- **Class pages.** Ability with cooldown, starting perk, the 3x8 perk tree with unlock levels and a readable list, prestige perks (4 slots, tiers), and a Wargear section that states the slot rules in words: with a Power Sword, Power Axe or One-Handed Thunder Hammer a Tactical carries no primary; Tactical Reserve swaps the sidearm for a second Bolt Rifle, so pistols cannot be equipped. They list "Bolt Rifle (Tactical Reserve)" as a secondary option.
- **Weapon pages.** Every variant with its gauges and defence type, plus a "Numbers" table datamined from the files (base damage, cleave, stagger, parry window, combo delay) and an attacks table (multiplier, damage, area damage, hits, stagger, guard break). Ammo figures per variant. Weapon perk trees are real trees: each perk has prerequisites (`requires`), exclusions (`excludes`), a lane, and the quality columns carry XP unlock costs (0 / 1500 / 7500 / 17000); the point budget is stated.
- **Other pages.** Enemies, difficulty, Crucible, Siege mutators, grenades and equipment. A search box over perks and weapons. Weapon pages list the builds that use them.

## Patch management and tracking

- **A ledger of every game version since launch** (38 entries, 2024-09-09 to Hotfix 15.1). Each entry has the date, a build-relevant summary, an `impact` rating (none / low / medium / high), a link to the official notes, and a `changed` list of the classes, perks and weapons it touched.
- **Builds remember their patch.** A build shows "sealed for current patch" or "older patch", a patch history of its own versions, and a "still works on Hotfix 15.1" vote. A build is flagged when a later patch changes a class, perk or weapon it uses, so "nobody walks into Absolute with a nerfed loadout".
- **The data version is detected from the game files** (the Steam build id and the dates on the pak files), not typed in.
- **Why it matters to us.** Our "Needs review" chip and the saved-build migration are a one-off table (Tactical and one Assault slot) that someone has to write by hand for each patch. Their ledger is the general mechanism, and it covers every patch in the same shape.

## What the cross-check found about our own data

Their Hotfix 15.1 game data was compared, by script and in scratch space only, with what we hold back from the wiki:

- **Every held wiki edit that their data covers matches the wiki's new text, not our old text.** 60 class perk edits (22 numeric, 38 wording), 102 weapon perk edits (30 numeric, 72 wording) and all 23 weapon version stat edits (Melta Rifle, Multi-Melta, Plasma Incinerator, Las Fusil, Heavy Bolter, Heavy Plasma Incinerator), though only their PvE numbers could be checked (the game data has no PvP figures). Nothing went the other way.
- **All four Tactical pins are contradicted** (Balanced Distribution 15%, Heightened Vigour with Block, Plasma Boost on all Plasma Weapons, Relentless Pursuit 10 seconds). The pins were wrong.
- **The official Hotfix 15.1 text also changes the Melta Rifle** (magazine 6, ammo pool 12, falloff distances), the Heavy Melta Rifle's falloff, an Auspex Scan Gun Strike fix and a Tactical Reserve fix. An earlier note in the spec says it touched only the One-Handed Thunder Hammer; that was wrong.
- **One exception, in our favour:** the wiki swaps Heavy's prestige perk *Honed Precision* for *Restorative Capacity*, but their data keeps *Honed Precision* and has no *Restorative Capacity*. That hold was right.
- Assault level 14 really did change (*Furious Strikes* exists in their data), so it needs a migration entry when adopted.
- **One-Handed Thunder Hammer:** our stats and defence types match theirs on all 10 versions, and 16 of our 20 perks match word for word. Differences to recheck in the game: they call the Relic perk *Brutal Reforge* (as does the Hotfix 15.1 text) where our in-game list says *Brutal Force*; they list a Heroic perk, *Crackling Hammerfall* ("Hold the Attack button to perform a powerful Ground Slam that consumes all Charges. Damage is increased by 30% per Charge spent"), which fits the hotfix line about the Power Maul's 30% per charge; *Perfect Reprisal* and *Preparedness* have the post-hotfix wording ("Light Attacks", "with the One-Handed Thunder Hammer").

**Status: done in `ab68ad3`** (the adoption pass: bakes re-run with no hold flags, the four pins removed, Heavy's *Honed Precision* kept by override, Assault level 14 migrated). A full audit afterwards, against 168 class perks, 535 weapon perks and 1,808 stat cells, is summarised in `docs/handoff/2026-10-14-patch-15-data.md`.

Reading: the wiki was behind the game in September and has since caught up, and our hold rule treated that catch-up as suspect. The rule only looked at the Patch 15.0 notes; older notes (for example Hotfix 12.2 buffed Moving Target and Retribution) already backed several of the edits. Next step is an adoption pass, not more holding. See `2026-10-14-game-files-source-of-truth.md` for the real fix.

## Where we differ

| | sealed.build | Us |
|---|---|---|
| Game data | Datamined from the game files, version-stamped, with verified/unverified markers | Wiki scrape plus patch-note overrides |
| Patch tracking | Ledger of all 38 versions, impact ratings, per-patch `changed` lists, builds flagged against it | Latest patch marker only; one-off migration for 15.0 Tactical |
| Weapon perk trees | Prerequisites, exclusions, XP costs, point budget | Flat tiers with a point budget |
| Weapon numbers | Damage, cleave, stagger, parry window, attack tables | Gauges and magazine figures |
| Reference scope | Enemies, difficulty, Crucible, Siege mutators, equipment | Armoury only |
| Builds | One description each, loadout variants, source credit for creators, difficulty/mode tags, "still works" votes, clone | Per-perk written rationale, library, share links, moderation |
| Community | Public, small (20 builds) | Discord-linked chapter, roster, reports, companies |
| Fixing data | "Report wrong data" link | Perk-corrections editor for people with the right role |
| Rationale per perk | Not seen | Yes, and required before saving to the library |

Things we have that they do not appear to: the per-perk rationale ("why this perk"), the corrections editor, the Discord-role community layer and the roster. Keep those.

## Earmarks

| # | Idea | Value | Effort | Verdict |
|---|---|---|---|---|
| 1 | **Game files as the source of truth** (Bret has the game installed) | Highest | Spike first, then medium | Pinned: `2026-10-14-game-files-source-of-truth.md` |
| 2 | **Patch ledger plus general build flagging** (`patches.json` with date, summary, impact, `changed`; builds flagged by `createdAt` against later patches that touch what they use) | High | Medium; builds on the 15.0 migration and `createdAt` already in the database | Earmark. Replaces the one-off chip. Shares data with the news alert |
| 3 | **Provenance and "unverified" markers** per value (game files, patch notes, wiki, community) | High trust, low effort | Small | Earmark; do it with #1 |
| 4 | **Wargear rule text and Tactical Reserve as a secondary option** | Matches Spec B+C | Small | Fold into Spec B+C |
| 5 | **Loadout variants per build** (a melta or solo alternative) | Medium | Medium | Consider with Spec B+C |
| 6 | **Weapon perk prerequisites, exclusions and XP costs** | Stops impossible builds | Needs #1 data | After #1 |
| 7 | **Weapon numbers** (damage, cleave, parry window) on Armoury pages | Medium | Needs #1 data | After #1 |
| 8 | **Creator credit on curated builds** | Small | Small | Maybe |
| 9 | **"Still works on this patch" vote** | Medium | Small, needs login | Maybe, after #2 |
| 10 | **Enemy, difficulty, Crucible and Siege reference pages** | Low for a perk-builder | Large | Skip unless asked |
| 11 | **Reach out to the maintainers** (shared data, a link, a correction channel) | Unknown | A message | Bret's call; both sites benefit from agreeing on facts |

Do not copy their dataset or texts: use them to cross-check and to learn what to extract ourselves.
