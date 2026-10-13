# Roster — frontend design pass

Status: draft for review, 2026-10-13. Not committed.

The roster's data side is done and merged (`docs/superpowers/specs/2026-10-13-roster-design.md`,
handoff `docs/handoff/2026-10-13-roster.md`). `/roster` is a structural page with no
styling. This spec is its visual and interaction design, plus four small site-wide
fixes that the roster work needs or exposes.

## Intent

Members open the roster to find themselves and see who leads what. Leadership opens
it to spot gaps: vacant posts, acting heads, names that disagree with roles, people
with no rank. It is behind sign-in and Legion-role gating, so the page can assume a
signed-in Legion member and offer "Find me".

Success: a member finds their own entry in two clicks or fewer; leadership sees every
gap from the top of the page without opening a branch; the page stays fast and
reliable on live data refreshed every minute; nothing regresses in the existing tests.

A throwaway mock (real fixture, real tokens) was reviewed and approved with these
edits, all folded in below: no category sub-labels ("Company", "Specialty",
"Honoured", "No company role"), no explanatory line under Servitors.

## Scope

In:
- Roster page visual design and interaction (collapsible branches, heat spine,
  High Command dais, status line, Find me, Infirmary, Servitors).
- Client performance and reliability work on the roster path (section 5).
- Site-wide: shared page header, readable surface over the volcano, footer links
  from the nav's own list, global reduced-motion guard.

Out (decided):
- Body typeface change. Later, separately.
- Name search. Find me replaces it.
- Server changes (ETag, compression). The payload is 25 KB raw, 2.7 KB gzipped.
- List virtualization. Revisit only if the budgets in section 5 fail at 5× size.
- Porting Archive headers to the shared page header (own eyebrow styles and hooks).
- Company emblems and emoji. They live on the Linux backend host, not in this repo,
  and the roster does not use them: sigils stay text, matching the Companies page. The
  hex sigil is the slot if emblems are wanted later.

## 1. Visual design

Palette (existing tokens, nothing new except where noted): Basalt `#0b1511` panels,
Ash `#26372f` hairlines, Bone `#e8efe9` text, Gold `#dfb85b` High Command and heads,
Ember `#ff6a2b` the lit state, Drake `#59d66c` hover and focus, Averland `#fdb825`
Acting. New tokens, because CSS uses them: `--color-whitehot: #f2d27a`,
`--color-vacant: #ff9a7a`, `--ease-forge: cubic-bezier(0.2, 0.8, 0.2, 1)`.

Type: Oswald (`--font-display`) uppercase for ranks and branch titles, mixed case for
High Command names. Cascadia (`--font-mono`) for counts, tags, status line, badges.
Names in `--font-sans`. No new font files.

Signature: the heat spine. Each open branch draws a vertical spine, with one diamond
node per rank group. Colour encodes rank: whitehot, then ember, then magma, then cold
ash (`#3a5246`), interpolated by rank-group index. Opening pours the heat down the
spine and lights each node in sequence (110 ms apart). Everything else is quiet.

Page, top to bottom:
1. Shared page header: eyebrow `XVIII Legion`, h1 `Order of Battle`, lede.
2. Status line (mono): `N on the roll`, then links for `vacant post(s)`,
   `acting head(s)`, `branch(es) with a name to check` (each shown only if non-zero,
   each opens and scrolls to its first branch), then `Updated h:mm`. Stale adds
   `out of date`.
3. Actions: `Find me`, `Expand all` / `Collapse all`, `Infirmary` (command only).
4. High Command dais: first rank is the hero (large name, gold); remaining ranks in a
   right column as label plus chips. Stacks on phones.
5. Twelve branch bars, then `Unassigned` if non-empty, then `Servitors`.

Branch bar: hex sigil (the same text sigils the Companies page uses: `I` to `VII`,
`A` Apothecarion, `L` Librarius, `R` Reclusiam, and `M` for the Forge, which the
Companies page calls the Armoury; plus `VD` for Venerable Dreadnoughts and `?` for
Unassigned, which have no Companies counterpart), title, head (rank label, up to
two member chips, `+N`), member count, chevron. No sub-label under the title. The whole
bar is the toggle (stretched-button pattern). A branch with nothing under its head
(Venerable Dreadnoughts) is static: no chevron, no hover highlight.

Open branch: ladder with the spine. Rank groups in order; ranks sharing a `tier` are
peers on one node, side by side. A `lateral` rank (Terminator) gets a hollow node on a
dashed stub off the spine. Dreadnought `aside` is a dashed side slot before the first
rank. Members wrap as chips beside the rank label (24 Scouts take 5 rows, not 24).
Unassigned has no spine.

Member chip: avatar (initials fallback), name, then only the badges that carry
information: company tag (only when it differs from the branch's own company, and in
non-company branches), `Acting` (Averland), `Check name` (amber, with the existing
title text), `Bot`. The viewer's own chip carries a Drake ring and a `You` tag.

States: vacant head is a dashed hex and the word `Vacant` in `--color-vacant`;
servitors are greyscale; the Infirmary panel replaces the order view as it does now.

Copy rules: plain verbs, sentence case in prose. Kept strings that tests use:
`Vacant`, `Acting`, `Check name`, `Servitors`, `Still holds the Legion role`,
`Order of Battle`, `Infirmary`, the sign-in, denied and error messages.

## 2. Behaviour

- Branches start collapsed. Open state is a set of branch keys, kept across the 60 s
  refresh (keyed by branch, never by data identity).
- `Expand all` / `Collapse all` acts on every openable branch; its label reflects state.
  Bulk changes snap with no height animation (the spine still pours) and keep the
  reader's place: the branch under the reading line (about 35% down the viewport) is
  pinned, and the page is corrected with `scrollBy({ top, behavior: 'instant' })` in
  the same frame, before paint. `instant` is required because `style.css` sets
  `html { scroll-behavior: smooth }`, which would turn a plain `scrollBy` into a slide.
- A single click on one bar animates that branch's height. Only content below it moves
  and the clicked bar stays put, so this is safe.
- Deep link `#<branch-key>` (for example `#company-3`) opens that branch and scrolls
  to it once data is loaded. The router uses `createWebHistory` and auth already
  preserves the fragment across sign-in (`stashAnchor`), so hashes are safe. Opening a
  branch does not rewrite the URL.
- Find me: looks the signed-in `auth.member.id` up in an id-to-branch index built with
  the view model; opens that branch instantly (no height animation), then scrolls the
  chip to the centre and pulses it twice. No timers: the target is measured after the
  open has laid out, so it is exact on slow machines too. If
  the id is not on the roll, it says so in a status line under the actions and points
  at Discord roles. If the viewer is only in the High Command banner, it scrolls to
  the banner.
- Status-line links and `#branch` deep links follow the same instant-open-then-scroll
  rule, then flash the branch border.
- Closed branch bodies are `inert`, so keyboard focus and screen readers skip them.
- Polling: one `setTimeout` chain at 60 s, paused while the tab is hidden; on return
  to visible, refresh at once if the last fetch is older than 60 s; no overlapping
  requests (the store's sequence guard stays).

## 3. Architecture

Everything under `src/components/roster/` and `src/views/Roster.vue` may be restructured
(handoff). Components are split by responsibility (Vue skill split rules); the view
stays a thin composition surface. JS, `<script setup>`, scoped class-selector styles,
matching the repo (the Vue skill's TypeScript default does not apply).

| Unit | Responsibility |
|---|---|
| `views/Roster.vue` | Fetch lifecycle, scene switcher, which panel shows. No markup for branches. |
| `components/PageHeader.vue` | Eyebrow, h1 (with `titleId`), lede, default slot. Site-wide. |
| `roster/RosterStatus.vue` | Status line, actions row, Find me message. Props in, events out. |
| `roster/RosterBanner.vue` | High Command dais. |
| `roster/RosterBranch.vue` | One branch: bar plus collapsible body. Props `branch`, `open`; emits `toggle`. |
| `roster/RosterLadder.vue` | Spine, rank groups, peers, lateral, aside. |
| `roster/RosterMember.vue` | One chip. No per-instance computed; a plain `initials()` helper. |
| `roster/RosterInfirmary.vue` | Extracted from the view. |
| `lib/rosterView.js` | Pure: `buildRosterView(roster)`, `heatAt(t)`, `showCompanyTag(member, branch)`. |
| `lib/useOpenBranches.js` | Open set, toggle, set-all, hash deep link. |
| `lib/useRosterPolling.js` | The 60 s visible-aware loop and cleanup. |
| `lib/pinReader.js` | `withReaderPinned(items, mutate)` and `openNow(open)`: async DOM helpers for bulk changes and jumps (section 2). Both wait one Vue tick before measuring, because state changes patch the DOM on the next tick. Unit-tested with stubbed rects. |
| `lib/useNavLinks.js` | Shared nav link list (site-wide, section 6). |

`buildRosterView` runs once per snapshot, in one pass over the roster, and returns
exactly what the templates need: High Command hero and court, each branch's sigil,
count, head display, and ladder items (already grouped into peers, lateral rows and
aside, each with its sequence index and heat colours), the summary counts with the
branch keys they link to, and the id-to-branch index. Templates only render it. The
store exposes it as a getter over the raw snapshot, so it recomputes only when the
snapshot is replaced.

All roster text is interpolated, never `v-html` (display names are user-controlled).
Avatar URLs are used as `<img src>` only if their origin is in a one-line allowlist
(`AVATAR_ORIGINS`, default the Discord CDN that the server already builds `?size=64`
URLs for); anything else falls back to initials. Decided: roster avatars come from the Discord
user fetch (the server's CDN URLs), so the default allowlist stands and there is no
local image host.

Names are the guild display names the server already sends (`nick`, else `global_name`,
else `username`, at most 32 characters). The roster adds no other member fields, so the
data contract is unchanged. A chip never changes row height: it has a fixed
`line-height` and `min-height`, `max-width: 100%` and `overflow-wrap: anywhere`, so
emoji fallback glyphs and long names cannot stretch or overflow a row.

## 4. Data and hooks that must not change

Data contract in the handoff is unchanged. These hooks and texts stay (tests and e2e):
`data-branch`, `data-kind`, `data-rank`, `data-tier`, `data-lateral`, `data-id`;
`.rs-high-command`, `.rs-branches`, `.rs-branch`, `.rs-head`, `.rs-aside`, `.rs-row`,
`.rs-unassigned`, `.rs-servitors`, `.rs-infirmary`, `.rs-infirmary-toggle`, `.rs-rank`,
`.rs-member`, `.rs-tag`, `.rs-badge`, `.rs-warn`, `.rs-signin`, `.rs-dev-scenes`.
Collapsed branch bodies stay in the DOM (CSS collapse, not `v-if`), so
`toContainText` and the jsdom queries keep working. `.rs-branch` stays on exactly
twelve branch elements; the Unassigned panel is not `.rs-branch`.

## 5. Performance and reliability

Measured facts: 204 members in the fixture; payload 25 KB raw, 2.7 KB gzip; route
already lazy-loaded; snapshot already `markRaw` (no deep proxying).

Changes and budgets:

| # | Requirement | How it is checked |
|---|---|---|
| P1 | A poll whose `fetchedAt` and `stale` match the current snapshot assigns nothing. Today every poll swaps the object and re-renders everything; the server only refreshes every 5 minutes, so four polls in five are waste. | Unit test: roster ref identity unchanged, `buildRosterView` not called again. |
| P2 | View model built in one O(n) pass, only on a new snapshot. | Unit test with a call counter; structural test of the output. |
| P3 | No new runtime dependency. No animation library, no virtual scroller. | `package.json` diff. |
| P4 | Roster route chunk (JS + CSS) at most 25 KB gzipped. | `vite build` output, recorded in the plan. |
| P5 | First render of the 204-member fixture at most 50 ms scripting at 4× CPU throttle; a synthetic 5× roster (about 1,000 members) at most 150 ms; expand and collapse hold 55 fps or better on the 5× roster. | Chrome performance trace, numbers recorded in the PR. Soft targets, not CI gates (timing tests flake). If the 5× case fails, add render-on-first-open for branch bodies; not built now. |
| P6 | Motion is CSS only: `transform`, `opacity`, and `grid-template-rows` on a single branch, which is contained (`contain: layout style`). No scroll listeners, no IntersectionObserver, no JS per frame. | Code review. |
| P7 | No per-chip listeners (chips are not interactive). One handler per bar. | Code review. |
| P8 | After unmount: no timer, no `visibilitychange` listener. | Unit test. |
| P9 | A failed refresh keeps the last copy and shows the existing banner; a 401 or 403 clears everything (existing behaviour, kept). | Existing store tests stay green. |
| P10 | Reader stays put. During Expand all and Collapse all the branch under the reading line moves at most 1 px. | Mock measured 0 px from three starting branches; the unpinned version flew the reader's bar 1,380 px away at up to 275 px per frame. Re-measured on the real page. |
| P11 | Find me, status links and deep links centre their target within 2 px, with no timers. | Mock measured 0 px; the timer version landed 28 px off and depended on the machine keeping up. |
| P12 | Avatars: images in bar heads, High Command and Servitors are requested at mount; images inside a branch body get their `src` on that branch's first open. Every `<img>` has `width`/`height` attributes (64) and `decoding="async"`, with the initials underneath as the placeholder, so nothing shifts or pops. No `loading="lazy"`: it has no effect when branches start collapsed. | Mock with 217 real 64 px PNGs: 25 requests at load instead of 217; opening the largest branch (43 members) and then Expand all (about 150 more images) dropped no frames (worst 17 ms). |
| P13 | Bulk open and close do one layout, not about 20 frames of layout across the whole document. | Follows from P10; frame sampler shows no slow frames. |

Why P10 to P13 exist: the "skipping" seen in the mock was not slow rendering (every
variant held 60 fps, worst frame 17 ms, with and without the live volcano behind it).
It was layout shift: opening every branch at once grew the page by thousands of pixels
in a third of a second, so the section being read was thrown off screen. Fix the
structure, not the paint. If stalls remain on a faster or slower display than the one
tested (60 Hz here), measure again there; P13 also lowers the work per frame.

The synthetic 5× roster comes from `scripts/roster-fixture.mjs` (a new scale
argument); the committed fixture does not change size.

## 6. Site-wide items

Each is its own change, independently revertible.

1. Shared page header. `PageHeader.vue` (section 3). Roster uses it first; Companies
   (its hand-rolled eyebrow, `.c-title`, `.c-intro`) swaps in with unchanged visual
   size and a brighter lede (`#c3d0c6`). Archive headers stay as they are.
2. Readable surface. Promote the mock's panel (`rgba(14,28,22,0.86)` to
   `rgba(9,18,14,0.9)`, 8 px blur, Ash border) to a `.surface` utility beside
   `.panel-forge`. Roster panels use it. On Companies, text and chips that sit over the
   lava get it too (mobile showed body text and pills colliding with the glow). Choose
   between `.surface` behind text columns and calming the volcano per route after
   reading `MountDeathfire.vue`. Acceptance: body text at least 4.5:1 against the
   worst-case lava position, at 390 px and 1440 px, on Companies and Roster.
3. Footer links from the nav's list. Extract the link list from `AppNav.vue` into
   `useNavLinks()`; the footer renders it (members see Accolades, Ranks, Reports,
   Roster), plus Discord. One source of truth, so the two cannot drift again.
4. Global reduced-motion guard in `style.css` base layer: animation and transition
   durations to `0.01ms` (not `none`, so `transitionend` and `animationend` still
   fire for Vue `<Transition>`), iteration count 1, smooth scroll off. The canvas
   already handles reduced motion in its own code and is untouched.

## 7. Accessibility

Bars are real buttons with `aria-expanded` and `aria-controls`; the click target is
the whole bar; focus ring is visible (Drake, inset). Closed bodies are `inert`. Status
messages use `role="status"`; refusals and errors keep `role="alert"`. Colour is never
the only signal: the heat is decoration on top of rank labels; vacant, acting and
check-name carry text. Touch targets at least 44 px tall on phones for bars and
actions. Reduced motion shows the final state with no pour.

## 8. Verification

Here (Windows): `vitest` for the new pure modules, composables, store dedupe, view,
and each component; the existing roster tests stay green; Chrome checks against the
fixture scenes (`full`, `stale`, `empty`, `loading`, `signin`, `denied`, `error`) at
1440 px and 390 px, keyboard-only pass, and the performance trace for P5.
On Vulkan (no Docker here): the e2e suite, including a new Find me and expand spec.
Status of the new e2e spec in the PR is "written, not run" until then.

Measurement method: a small in-page sampler (requestAnimationFrame deltas, the
long-animation-frame observer, and the pinned element's `getBoundingClientRect().top`
per frame), pasted into the console; it is not shipped or committed. Always run it
cold (right after load) and warm, with the live volcano behind the page.

Sigils are a small constant in `rosterView.js`, not an import of `companies.json` (that
file is large prose and would bloat the roster chunk). A test-only import checks that
every sigil the roster shares with Companies agrees with it, so the two cannot drift.

New unit tests: `withReaderPinned` and `openNow` (stubbed rects: reading-line choice,
clamping, instant scroll correction, class cleanup); avatar gating (origin allowlist,
body images only after first open); `heatAt` endpoints and monotonic cooling; ladder grouping (peers,
lateral, aside, empty rows); `showCompanyTag` cases; summary counts and link targets;
id-to-branch index including High Command-only and not-found; `useOpenBranches`
(toggle, set-all, hash, survives a new snapshot); `useRosterPolling` (visible-only,
refresh on return, cleanup); store dedupe (P1); `PageHeader`; `useNavLinks` gating.

## 9. Delivery order

1. Plumbing: tokens, `.surface`, reduced-motion guard, `PageHeader`, `useNavLinks`
   plus footer. No roster change yet.
2. Roster logic, no visuals: `rosterView`, store dedupe, `useOpenBranches`,
   `useRosterPolling`, all unit-tested.
3. Roster components and styles, against the fixture scenes.
4. Companies ported to `PageHeader`; Companies readability fix.
5. e2e spec (written here, run on Vulkan) and the handoff doc update.

Build on a branch; commit and push only when asked.

## Open questions

None blocking. The surface-versus-calmer-volcano choice in 6.2 is made in the plan
after reading `MountDeathfire.vue`, against the contrast acceptance above.
