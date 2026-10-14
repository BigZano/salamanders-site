# Game files as the source of truth (plan sketch)

Status: **not started**. Pinned 2026-10-14 at Bret's request: "if it's from game data, I have it installed ... that'd be the ultimate source of truth". This is a sketch to brainstorm from, not a spec. It supersedes the "wiki first" order in the data-source policy once it works.

## Why

- The wiki scrape is wrong in both directions: it lags a patch, it sometimes errs (a perk at two levels, a prestige swap the game does not have), and it has no page at all for new content (the One-Handed Thunder Hammer perks came from a hand copy).
- A cross-check against sealed.build, which datamines the game files, showed that every wiki edit we were holding back and that their data covers was true (see `2026-10-14-sealed-build-review.md`). Our rule of thumb ("patch notes win, uncorroborated wiki edits are presumed false") was wrong because the real source was never in the picture.
- Bret has the game installed, so the primary source is on the machine this repo is worked on.

## Goal

A local extraction step, run by Bret after each game update, that reads the installed game and writes a committed, version-stamped snapshot of the data we need (class perk grids, prestige perks, weapon variants and numbers, weapon perk trees with their prerequisites). The bakes then use the snapshot first, patch notes second and the wiki last, and the drift report says which wiki values are wrong.

## Sketch

1. **Spike (feasibility, throwaway).** Find the Steam install. List its pak or IoStore files. Try one open-source Unreal asset reader on them. Find where perks, weapons and class definitions live and whether they are readable (encryption is the first unknown). Success is "we can print the Tactical perk grid and the Bolt Rifle variants from the files".
2. **Oracle.** Our own baked data (7 classes, 31 weapons) and the cross-check results are the test: the extractor is right when it reproduces what we know is right and explains the differences.
3. **Snapshot format.** JSON of names, descriptions, numbers and tree structure, stamped with the Steam build id and the dates on the files (their site does the same). No icons, models or audio in the first version.
4. **Provenance on every value** (`game-files`, `patch-notes`, `wiki`, `community`), with an `unverified` flag, so a reader and a maintainer can tell how a number got here.
5. **Bake order.** Game snapshot, then official patch notes (they explain intent, and cover anything the files do not show), then the wiki (fills gaps). `patch-overrides.json` stays for the rare place all of them are wrong, with sources.
6. **Trigger.** The Steam build id changing is a better "a patch landed" signal than the title of an announcement; it can feed the news alert (`2026-10-14-sm2-news-alert.md`).

## Things to settle before building

- **Is it allowed?** Reading your own install for your own tooling is common practice, but check Focus and Saber's policy on datamining and on republishing extracted text and numbers. This site is a fan project; the text and stats are already public on the wiki, but icons and models are a different matter, which is why the first version leaves them out.
- **Where it runs.** Locally only: the game files do not go in the repo or in CI. The committed snapshot is what CI and the server use, so no install is needed there.
- **Format and tooling** are unknown until the spike. Do not pick a parser first.
- **Maintenance.** A game update can change the format. The spike should say how fragile it is.
- **Who runs it.** Bret, after each patch, with a one-command script and a diff against the committed snapshot.

## Next step

Run the brainstorming step, then the spike as a time-boxed probe (an hour or two). Nothing is committed from the spike except a note on what was found.
