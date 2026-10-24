# Deathwatch Parity: Frame and View Skeletons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Deathwatch shell up to parity with the original Watch Fortress Ebonhold site (the Oct 18 build, a Claude Artifact) in look and structure: its painted per-area backdrops, crest and cogitator frame, destination menu, and all 20 views as skeletons that the real content later replaces one file at a time.

**Architecture:** The look (tokens, 9-slice frame, plaque headings, painted backdrops) lives in the shell's scoped CSS. Each view is one single-file component under `src/views/deathwatch/pages/<area>/<tab>.vue`, found by a registry built from `import.meta.glob`, so a later port (or the Watch Commander's pull request) overwrites a file without touching anything shared. A view skeleton is its real headings and column labels over five small shimmer primitives.

**Tech Stack:** Vue 3 `<script setup>`, vue-router 5, Pinia, Vitest + Vue Test Utils, plain scoped CSS on the `--dw-*` tokens, `@fontsource` fonts.

**Spec:** `docs/superpowers/specs/2026-10-20-deathwatch-design.md` (on `feat/deathwatch`; the Look, Sub-theme and Navigation sections). The reference is the original site: its 20 views and chrome are summarised in the tables below. It is not in the repo and holds real names, so nothing from its data enters a file here.

**Not in this plan:** real view content, the data layer and scoring port, the intro door animation and the card-swell exit (the hub is the static destination menu), Armouring Hall heraldry sprites and the blackletter face, the Legion password gate (Discord replaces it), the bottom tab bar (the area bar and sheet stay), the image pipeline (images go in as they came).

**Branch.** `feat/dw-parity` from `feat/dw-shell` (PR #19 is not merged), in `.claude/worktrees/dw-parity`; its PR targets `feat/dw-shell`. Push once, at the end: the pre-push gate takes ~7 min and tests must not run while it does.

## Global Constraints

- The area is dark only; every colour is a `--dw-*` token on `.dw`, never on `:root`. New tokens get the contrast test (4.5:1 against `--dw-surface`) when they are text.
- **`v-html` is forbidden** under `src/components/deathwatch/` and `src/views/deathwatch/` (a test scans them). SVG icons are data rendered with `v-for`, not markup strings.
- Animate `transform` and `opacity` only, under 300 ms, easing `var(--ease-forge)`, except the two slow ambient loops (backdrop drift 40 s, flicker 5 s); every animation has a `prefers-reduced-motion: reduce` variant that turns it off.
- Tap targets are at least 44px on phones; no `100vh` (use `dvh`); bottom-fixed UI pads `env(safe-area-inset-bottom, 0px)`; every hover is inside `@media (hover: hover) and (pointer: fine)` and every pressable has `:active { transform: scale(0.97) }`.
- Fonts are self-hosted through `@fontsource`; no Google Fonts requests. Barlow 400/500/600, Barlow Condensed 500/600/700, Teko (variable), Cinzel (already) are loaded only with the Deathwatch routes.
- No member names, Discord ids, role ids or passwords in any committed file. Skeleton text is the original's static labels only.
- Commands: tests `NODE_OPTIONS=--no-experimental-webstorage node_modules/.bin/vitest run <file>`; full suite `NODE_OPTIONS=--no-experimental-webstorage bun run test`; mutation `node_modules/.bin/stryker run`. Commit with explicit paths and end each message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- A URL with an unknown area, an unknown tab, or hostile params (`__proto__`, `constructor`) must never throw in the registry or the area view: it falls back to the area's first view or the existing not-found handling. Pinned in Tasks 3 and 4.
- The painted backdrop must never cost readability: text sits on the dense framed panel, and with the image blocked or slow the page is still the dark ground. Pinned in Task 2.
- Reduced motion: no backdrop drift, no flicker, no shimmer. Pinned in Tasks 2 and 3.
- A 360px-wide phone: no horizontal scroll from the frame's border-image, long column-label tables scroll inside their own wrapper, and the area bar and sheet keep working. Checked in Chrome in Task 7.
- The legal disclaimer must be on every Deathwatch page, hub included. Pinned in Task 6.

## Source facts (from the original)

**Backdrops.** hub: a blurred green hall (36 KB); Event Tracker: marines firing at a xenos; Chronicles: a hall painting; Armouring Hall: a figure study; Manage: a darker scene. Each at 50-60% opacity under a dark gradient, drifting slowly (`scale(1.02)` to `scale(1.1) translate(-1%, -1.5%)`, 40 s alternate) with a 5 s opacity flicker (+-18%).

**Frame.** Panels and the desktop rail are chamfered (14px corners) with a green 9-slice SVG border-image (`--frame`, slice 30), scanline and grain texture, a glowing 4px "tab" strip centred on the top and bottom edges. Section headings (`h2`) are small plaques: Teko 500, uppercase, `clamp(24px, 2.7vw, 32px)`, green with a glow, framed with the small SVG border (`--frame-s`, slice 12). Buttons are chamfered dark glass with glowing green Teko type. The rail is 300px wide (crest 120px, eyebrow "Watch Fortress Ebonhold" in Barlow Condensed 600 spaced green, then the area title in Cinzel 32px), nav rows have a 24px icon, 18px Barlow Condensed uppercase, a sliding green indicator behind the current row.

**Legal footer, verbatim.** "© 2026 Watch Fortress Ebonhold · A fan-run page for Warhammer 40,000: Space Marine 2." then a line break, then "Not affiliated with or endorsed by Games Workshop or Focus Entertainment. Warhammer 40,000, Space Marine and all associated marks are trademarks of Games Workshop Ltd."

**Nav icons** (24x24 viewBox, stroke 1.7, round caps and joins; `d` strings are in Task 2's step 3): standings, kill-teams, players, honour-roll, game-stats, scoring, archive, standard, specialist, watch-command, hall-of-champions, chamber-of-honor, player-profiles, in-memoriam, operational-records, enter-mission, manage, checks, records, page-texts, and `menu` for "Back to the Fortress".

**The 20 views** (headings `h2` unless noted; tables list their real column labels; "tiles" are labelled stat tiles; "form" is labelled fields):

| Page (`<area>/<tab>.vue`) | Content |
| --- | --- |
| `eventtracker/standings` | Standings: podium (3 cards), table `# / Kill Team / W1 / W2 / W3 / W4 / Total / Gap / Ø/mission`; Points progression: chart; Watch Companies: table `Company / Kill Teams / Points` |
| `eventtracker/kill-teams` | Kill Team profile: form (`Kill Team`) and tiles `Rank, Event points, Move, Gap to #1, Missions played, KIA`; Players: table `Player / Obj / Kills / Special / Melee / Ranged / Items / Dmg taken / Incaps / Revives / MVP`; Points per week: table `Week / Points / Total`; Missions: table `Mission / Kills / Special / Melee / Ranged / Incaps / Revives / Seed / Armoury / Relic / Ext / Points / MVP` |
| `eventtracker/players` | Players: table `# / Player / MVP / Kills / Special / Revives / Incaps / Seeds / Class` |
| `eventtracker/honour-roll` | Honour Roll: tiles `Event Champion, MVP, Executioner · most kills, Terminator · most special kills, Blade Master · melee damage, Marksman · ranged damage, Scavenger · most items, Guardian Angel · most revives, Gene-Seed Hunter · seeds found`; Kill Team awards: tiles `Best Average` |
| `eventtracker/game-stats` | Game Stats: tiles `Missions played, Kills, Special Kills, Melee Damage, Ranged Damage, Items Found, Damage Taken, Incapacitations, Revives, In-Game Score, Gene-Seed`; tables `Class / Played / Share / Ø kills / Seeds` and `Kill Team / Tactical / Assault / Vanguard / Bulwark / Sniper / Heavy / Techmarine / Apothecary` |
| `eventtracker/scoring` | Event points per mission: tiles `Base points, Incap penalty`; Best possible mission: tiles `Played mission, Gene-Seed, 2 Guardian Relics, 3 Armoury Data, Extermination Rank, Total`; MVP score per objective: tiles `Kills, Special, Melee, Ranged, Items` |
| `eventtracker/archive` | Archive: two event tiles |
| `chronicles/hall-of-champions` | (no heading) a champion tile; Past Champions: two tiles; How to earn this honor?: tiles `Requirements, Award, Accolade Duration, Legacy` |
| `chronicles/chamber-of-honor` | Battle-Brother Honours: tiles `MVP, Executioner, Terminator, Blade Master, Marksman, Scavenger, Guardian Angel, Gene-Seed Hunter` |
| `chronicles/player-profiles` | table `# / Player / Tours / Missions / MVP / Kills / Special / Melee / Ranged / Items / Dmg taken / Incaps / Revives / Seed` |
| `chronicles/in-memoriam` | three memorial tiles (no labels) |
| `chronicles/operational-records` | Current Kill-Team Standings: table `# / Kill Team / Points`; one record tile |
| `armouringhall/standard`, `specialist`, `watch-command` | a figure placeholder and tiles `Helm, Pauldrons, Wargear, Breastplate, Gauntlets, Greaves, Armour Set` |
| `manage/enter-mission` | Enter mission: form `Kill Team, Week, Objective, Played, In-Game Score, Gene-Seed`; Reset all missions: one danger button |
| `manage/manage` | Scoring: form `Base points, Incap penalty, Revive bonus, Gene-Seed bonus, Armoury Data bonus, Guardian Relic bonus`; Rename or merge player: form; Kill Teams: form; Restore from backup; Event archive; Reset Kill Teams |
| `manage/checks` | Data checks: a list placeholder |
| `manage/records` | New operational record: form; Kill Teams (h3); Top Operatives (h3); Records created here |
| `manage/page-texts` | Page Texts: form |

## File map

| File | Responsibility |
| --- | --- |
| `src/components/deathwatch/deathwatch.css` | Tokens, frame, plaque, button, backdrops, legal footer |
| `src/components/deathwatch/img/*` | The images, as they came |
| `src/components/deathwatch/DeathwatchShell.vue` | Fonts, `data-area` from the route |
| `src/lib/deathwatch/icons.js` (+test, gated) | Slug to SVG shape list |
| `src/lib/deathwatch/pages.js` (+test, gated) | `pageLoader(area, tab)` over the glob |
| `src/components/deathwatch/skeleton/Sk{Table,Podium,Chart,Tiles,Form}.vue` (+tests) | Shimmer primitives |
| `src/views/deathwatch/pages/<area>/<tab>.vue` x20 (+one table-driven test) | The skeleton views |
| `src/components/deathwatch/DeathwatchNav.vue`, `DeathwatchAreaBar.vue`, `DeathwatchLegal.vue`; `src/views/deathwatch/DeathwatchArea.vue`, `DeathwatchHub.vue` | Rail, bar, footer, area frame, menu |

---

### Task 1: Fonts and images

**Files:** Modify `package.json`, `bun.lock`; Create `src/components/deathwatch/img/` (copies of the scratch images, names below).

- [ ] **Step 1:** `bun add @fontsource-variable/teko @fontsource/barlow @fontsource/barlow-condensed`.
- [ ] **Step 2:** Copy from the scratch extraction (`.../scratchpad/artifact-images/`) into `src/components/deathwatch/img/` under these names: `img-07.webp` to `crest.webp`, `img-08.webp` to `crest-large.webp`, `img-05.jpg` to `bg-hub.jpg`, `img-03.webp` to `bg-tracker.webp`, `img-01.webp` to `bg-chronicles.webp`, `img-02.jpg` to `bg-armouring.jpg`, `img-04.jpg` to `bg-manage.jpg`, `img-09.webp` to `card-tracker.webp`, `img-10.jpg` to `card-armouring.jpg`, `img-11.webp` to `card-chronicles.webp`, `img-12.png` to `clan.png`.
- [ ] **Step 3:** Run `bun run build` → Expect: succeeds, nothing yet references the files. **Commit** `package.json bun.lock src/components/deathwatch/img` (`feat(deathwatch): fonts and the original's images`).

### Task 2: The look

**Files:** Modify `src/components/deathwatch/deathwatch.css`, `deathwatch.css.test.js`, `DeathwatchShell.vue`, `DeathwatchShell.test.js`; Create `src/lib/deathwatch/icons.js`, `icons.test.js`.

**Interfaces:** Produces CSS classes `dw-panel` (framed, chamfered panel), `dw-plaque` (section heading), `dw-btn` (chamfered button), `dw-legal`; tokens `--dw-font-hud` (Teko), `--dw-font-body` (Barlow), `--dw-font-cond` (Barlow Condensed), `--dw-frame`, `--dw-frame-s`, `--dw-grain`, `--dw-scan`; `.dw[data-area]` backdrop selection; and `ICONS: Record<string, Array<[tag, attrs]>>` from `icons.js` with `iconFor(slug): Array<[tag, attrs]>` (`menu` included; an unknown slug gives `[]`).

- [ ] **Step 1: Failing tests.** `icons.test.js`: every tab slug in `AREAS` has a non-empty icon; `menu` has one; `iconFor('__proto__')`, `iconFor('constructor')` and `iconFor(7)` give `[]`; every shape's tag is one of `path, circle, rect`. `deathwatch.css.test.js` (extend): defines the three font tokens and the four frame tokens; `.dw-plaque`, `.dw-panel`, `.dw-btn` and `.dw-legal` rules exist; one backdrop rule per `data-area` value (`hub, eventtracker, armouringhall, chronicles, manage`) each naming its image; the backdrop animations are removed under `prefers-reduced-motion: reduce`; the backdrop still ends under a translucent dark gradient. `DeathwatchShell.test.js`: with a route of `/deathwatch/chronicles/in-memoriam` the wrapper has `data-area="chronicles"`; `/deathwatch` gives `hub`; an unknown area gives `hub`.
- [ ] **Step 2:** Run the three files → FAIL.
- [ ] **Step 3: Implement.** `icons.js` holds the shapes from the original (24x24, stroke): standings `<path d="M3 21h18M6 21V11h4v10M10 21V5h4v16M14 21v-7h4v7"/>`; kill-teams `<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/>`; players `<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4.2 4.2-6 8-6s7 1.8 8 6"/>`; honour-roll `<path d="M7 4h10v5a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 14v4M8 21h8"/>`; game-stats `<path d="M3 3v18h18M7 15l4-5 3 3 5-7"/>`; scoring `<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>`; archive `<path d="M3 5h18v4H3zM5 9v11h14V9M10 13h4"/>`; standard `<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M12 7v10M8 11h8"/>`; specialist `<path d="M6 21v-7a6 6 0 0 1 12 0v7M4 21h16M9 13h6M12 8V3M9 5h6"/>`; watch-command `<path d="M4 17h16l-1.6-9-4.4 3.6L12 5l-2 6.6L5.6 8zM4 20h16"/>`; hall-of-champions `<path d="M12 21v-4M8 21h8M7 4h10v4a5 5 0 0 1-10 0zM5 5a3 3 0 0 0 2 5M19 5a3 3 0 0 1-2 5M10 2l2 1.5L14 2"/>`; chamber-of-honor `<circle cx="12" cy="15" r="5"/><path d="M9 3l3 7 3-7M7 3h4M13 3h4M12 13v4M10 15h4"/>`; player-profiles `<circle cx="10" cy="8" r="4"/><path d="M2 21c1-4.2 4.2-6 8-6s7 1.8 8 6M18 3l1 2 2 .3-1.5 1.4.4 2.1-1.9-1-1.9 1 .4-2.1L15 5.3l2-.3z"/>`; in-memoriam `<path d="M12 3c1.5 2 1.5 3.5 0 5-1.5-1.5-1.5-3 0-5zM9 10h6v11H9zM6 21h12"/>`; operational-records `<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7M9 8h3"/>`; enter-mission `<path d="M12 5v14M5 12h14"/>`; manage `<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>`; checks `<path d="M4 12l5 5L20 6"/>`; records `<path d="M6 3h9l4 4v14H6zM14 3v5h5M12.5 11v6M9.5 14h6"/>`; page-texts `<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>`; menu `<path d="M3 11l9-8 9 8M5 9.5V21h5v-6h4v6h5V9.5"/>`; written as `[tag, attrs]` data. In `deathwatch.css`: import nothing (fonts are imported in the shell); add the tokens and classes from "Source facts" using the `--frame` and `--frame-s` 9-slice SVGs (data URIs, stroke `%237fd35c`, the large one with the 4 side ticks), `.dw[data-area='x'] .dw-backdrop` rules with `background-image` url of the matching `img/` file under the existing translucent gradient, the drift and flicker keyframes on `.dw-backdrop::after`-style pseudo or the backdrop itself (transform and opacity only), and a reduced-motion block. `DeathwatchShell.vue` imports the four font stylesheets (`@fontsource-variable/teko`, `@fontsource/barlow/latin-{400,500,600}.css`, `@fontsource/barlow-condensed/latin-{500,600,700}.css`) and sets `:data-area="area"` from `useRoute().params.area` through a small `areaOf(params)` that accepts only a key of `AREAS` (own-property check) and otherwise returns `'hub'`.
- [ ] **Step 4:** Run the three files → PASS; full suite → PASS. **Step 5: Commit** (`feat(deathwatch): the cogitator look, per-area backdrops and nav icons`).

### Task 3: View registry and skeleton primitives

**Files:** Create `src/lib/deathwatch/pages.js`, `pages.test.js`, `src/components/deathwatch/skeleton/SkTable.vue`, `SkPodium.vue`, `SkChart.vue`, `SkTiles.vue`, `SkForm.vue` and `skeleton.test.js`.

**Interfaces:** Produces `pageLoader(area: unknown, tab: unknown): (() => Promise<Component>) | null` (a lazy loader for `src/views/deathwatch/pages/<area>/<tab>.vue`, `null` when there is none, own-key lookups only); `<SkTable :columns="string[]" :rows="number = 5">` (real column labels in a header row, shimmer bars below, inside a horizontally scrolling wrapper); `<SkPodium>` (three cards, the middle raised); `<SkChart>` (a framed plot area with axis lines); `<SkTiles :labels="string[]">` (one tile per label, label real, value a shimmer bar); `<SkForm :fields="string[]">` (a label and a disabled-looking field each). All primitives are `aria-hidden` except their real labels' text staying in the DOM, and the shimmer is an opacity pulse that is off under reduced motion.

- [ ] **Step 1: Failing tests.** `pages.test.js`: a loader exists for every tab of every area in `AREAS` (use the 20 files of Task 4 as the thing to satisfy: this test is expected to fail until Task 4, so write it now and commit it with Task 4); `pageLoader('eventtracker', 'nope')`, `pageLoader('nope', 'standings')`, `pageLoader('__proto__', 'x')`, `pageLoader('eventtracker', '__proto__')`, `pageLoader(1, 2)` all give `null`; no loader exists for a page the table does not list. `skeleton.test.js`: `SkTable` renders each column label once and `rows` bar rows; `SkTiles` renders each label; `SkForm` renders a label per field; `SkPodium` renders three cards; every primitive's shimmer class has a reduced-motion rule in its style block (read the SFC source).
- [ ] **Step 2:** Run `skeleton.test.js` → FAIL. **Step 3: Implement** the five primitives with scoped styles on the `--dw-*` tokens (bars are `--dw-line-2` at low opacity; the wrapper scrolls with `overscroll-behavior-x: contain`), and `pages.js` as `const pages = import.meta.glob('../../views/deathwatch/pages/*/*.vue')` with `pageLoader` doing `Object.hasOwn(pages, key)` on the exact key built from two validated slugs (`/^[a-z-]{1,40}$/`).
- [ ] **Step 4:** Run `skeleton.test.js` → PASS. **Step 5: Commit** the primitives and their test (`feat(deathwatch): shimmer primitives for view skeletons`). `pages.js` and its test wait for Task 4.

### Task 4: The 20 skeleton views and the area frame

**Files:** Create the 20 views under `src/views/deathwatch/pages/`, `src/views/deathwatch/pages/pages.test.js`; Modify `DeathwatchArea.vue`, `DeathwatchArea.test.js`, `DeathwatchNav.vue`, `DeathwatchNav.test.js`, `DeathwatchAreaBar.vue`, `DeathwatchAreaBar.test.js`.

**Interfaces:** Consumes Tasks 2 and 3. Each view is a component with no props whose root holds its `h2.dw-plaque` headings and skeleton primitives exactly as the "20 views" table lists.

- [ ] **Step 1: Failing tests.** `pages.test.js` (table-driven over the 20 pages): mounts each and expects every heading and tile and column label from the table to be in its text, and no text outside those labels (a guard against real names); `pages.js`'s loader finds all 20 and `AREAS` has no tab without one. `DeathwatchArea.test.js`: the open tab's page renders inside `.dw-panel` with its title; an unknown tab falls back to the area's first view; a loader that rejects shows a status line, not a blank; Manage still shows the restricted notice for a non-Commander. `DeathwatchNav.test.js`: each link has its icon (an `svg` with the tab's shapes, `aria-hidden`), the current one has `aria-current="page"`, and the last link is "Back to the Fortress" with the `menu` icon. `DeathwatchAreaBar.test.js`: shows the crest image and the area and tab names.
- [ ] **Step 2:** Run these files → FAIL. **Step 3: Implement.** Write the 20 views. `DeathwatchArea.vue`: desktop becomes the original's two columns (rail 300px: crest `crest.webp` 120px, eyebrow `Watch Fortress Ebonhold`, area title, the nav; main: the framed `.dw-panel` holding `<component :is>` from `defineAsyncComponent(pageLoader(...))` with a small loading line), sticky under the site header; below 900px the area bar (crest 44px, names) opens the existing sheet. Keep every existing prop, emit and accessible name that the current tests rely on. `DeathwatchNav.vue` renders icons with `v-for` over `iconFor(slug)` and the row style (18px Barlow Condensed uppercase, 24px icon, green current marker).
- [ ] **Step 4:** Run the area, nav, bar and pages tests → PASS; full suite → PASS (including `no-v-html.test.js`). **Step 5: Commit** `src/views/deathwatch src/lib/deathwatch/pages.js src/lib/deathwatch/pages.test.js src/components/deathwatch` (`feat(deathwatch): the 20 view skeletons, the registry and the area frame`).

### Task 5: The destination menu

**Files:** Modify `src/views/deathwatch/DeathwatchHub.vue`, `DeathwatchHub.test.js`.

- [ ] **Step 1: Failing tests:** the hub shows the crest (`crest-large.webp`), the eyebrow, the title and the tagline; three cards with the painted images and the existing label and blurb (Event Tracker, Armouring Hall, Chronicles of Valor) each linking to its first view; a Salamanders card ("Return to the Salamanders", icon `clan.png`) linking to `/`; the Manage entry only for the Commander and as a small corner button, not a card; card images have empty `alt` (the card text names them).
- [ ] **Step 2:** Run → FAIL. **Step 3: Implement** the menu in the original's arrangement (three painted cards in a row from 640px, stacked on phones with 44px+ targets; the Salamanders card full width beneath), the hub backdrop from Task 2, `loading="lazy"` on card images below the fold, dimensioned (`width`/`height`) to avoid layout shift, the squeeze on press and gated hover.
- [ ] **Step 4:** Run → PASS. **Step 5: Commit** (`feat(deathwatch): the painted destination menu`).

### Task 6: The legal footer

**Files:** Create `src/components/deathwatch/DeathwatchLegal.vue`, `DeathwatchLegal.test.js`; Modify `DeathwatchHub.vue`, `DeathwatchArea.vue` and their tests.

- [ ] **Step 1: Failing tests:** `DeathwatchLegal` renders the two sentences of the disclaimer exactly (see "Legal footer, verbatim"); the hub and an area page each contain it.
- [ ] **Step 2:** Run → FAIL. **Step 3: Implement** the component (`.dw-legal`, small muted Barlow, centred, 4.5:1) and place it at the foot of the hub and under the framed panel.
- [ ] **Step 4:** Run → PASS; full suite → PASS. **Step 5: Commit** (`feat(deathwatch): the fan-site disclaimer on every page`).

### Task 7: Check it against the original, document, push

**Files:** Modify `DESIGN.md`, `docs/handoff/2026-10-20-deathwatch-shell.md`.

- [ ] **Step 1: Look.** With `VITE_DEATHWATCH_FIXTURE=1 bun run dev`, compare in Chrome at 1280x900 and 390x844, against the original served locally: hub, one page of each of the four areas, the sheet open on the phone. Fix any difference that is not on the "Not in this plan" list. Check for horizontal scroll at 360px and that backdrop images are dimmed enough for the panel text (4.5:1 holds on the panel, not the image).
- [ ] **Step 2: Docs.** `DESIGN.md`'s Deathwatch section names the cogitator look (frame, plaque, grain, scanlines, Teko/Barlow/Cinzel) and the per-area backdrops in place of the plain translucent backdrop; the shell handoff says every view is a skeleton file under `pages/` that a port replaces, and lists what is deferred.
- [ ] **Step 3:** Full suite and `bun run test:coverage` → PASS. **Step 4: Commit** (`docs(deathwatch): the parity look and the skeleton convention`). **Step 5:** Push `feat/dw-parity` once; report to Bret (no PR until they say).
