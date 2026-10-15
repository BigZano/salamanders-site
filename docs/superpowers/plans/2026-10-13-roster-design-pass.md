# Roster Design Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Style and animate the `/roster` page (collapsible branches, heat-graded spine, High Command dais, Find me), keep it lean and reliable on live data, and ship four small site-wide fixes (shared page header, readable surface, footer links from the nav's list, reduced-motion guard).

**Architecture:** One pure view-model (`rosterView.js`) turns each roster snapshot into exactly what the templates render; the store skips unchanged snapshots; small composables own open state, polling and reader-pinning; the view stays a thin composition surface over focused components. Motion is CSS only. Collapsed bodies stay in the DOM, so tests and find-in-page keep working.

**Tech Stack:** Vue 3.5 (`<script setup>`, JS, scoped class-selector styles), Pinia 4, Vue Router 5, Tailwind v4 `@theme` tokens in `src/style.css`, Vitest 3 + `@vue/test-utils` (jsdom per file via `// @vitest-environment jsdom`), Bun, Playwright (e2e, Vulkan only).

**Spec:** `docs/superpowers/specs/2026-10-13-roster-design-pass-design.md`. **Visual and behaviour reference (read it, copy its values, do not import it):** `docs/superpowers/specs/2026-10-13-roster-design-pass-mock/index.html` (run per its README).

## Conventions (every task)

- **Run tests with the fixture variable unset.** `VITE_ROSTER_FIXTURE=1` can be inherited from the launching shell; it makes the roster store return fixture data and fails 22 roster tests. Always:
  `env -u VITE_ROSTER_FIXTURE NODE_OPTIONS=--no-experimental-webstorage bun run test <path>` (one file) or the same without `<path>` (all). Below, `TEST <path>` means exactly this.
- **Commit** with the same env prefix: `env -u VITE_ROSTER_FIXTURE NODE_OPTIONS=--no-experimental-webstorage git commit -q -m "<subject> [skip ci]" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"`. The pre-commit hook runs the leak guard and the full suite. Never `--no-verify`. Branch: `feat/roster-design`. Commit only; do not push.
- Match the repo: JS (not TS), 2-space indent, no semicolons, single quotes, tests colocated as `*.test.js`. Names render through `{{ }}` only, never `v-html`.
- Boolean DOM state: bind `undefined` to omit an attribute (`:inert="open ? undefined : ''"`, `:data-open="open ? '' : undefined"`). Vue renders `false` on a non-boolean attribute as the string `"false"`, which for `inert` still means inert.
- DOM changes made by Vue land on the next tick. Any helper that measures layout after changing state must `await nextTick()` first.

## Global Constraints

Copied from the spec; every task's requirements include these.

- No new runtime dependency. No animation library, no virtual scroller. Roster route chunk (JS + CSS) ≤ 25 KB gzipped.
- Tokens: existing palette; new `--color-whitehot: #f2d27a`, `--color-vacant: #ff9a7a`, `--ease-forge: cubic-bezier(0.2, 0.8, 0.2, 1)`. Heat ramp stops (rgb): `0 → 242,210,122`, `0.4 → 255,106,43`, `0.72 → 224,67,29`, `1 → 58,82,70`.
- Motion constants: nodes light 110 ms apart (`--pour: 110ms`); spine segment `0.18s linear`, node `0.32s cubic-bezier(0.3, 1.7, 0.5, 1)`, body height `0.34s var(--ease-forge)`. Only `transform`, `opacity` and `grid-template-rows` (one contained branch) animate. `contain: layout style` on each branch. No scroll listeners, no IntersectionObserver, no JS per frame.
- Reader pinning: reading line at `innerHeight * 0.35`; pinned bar clamped to `[90, innerHeight * 0.6]` from the top; correction is `scrollBy({ top, behavior: 'instant' })` (the site sets `html { scroll-behavior: smooth }`).
- Polling: `setTimeout` chain at 60 000 ms, paused while hidden, immediate refresh on becoming visible if the last run is older than 60 s, no overlap.
- Avatars: `AVATAR_ORIGINS = ['https://cdn.discordapp.com']`; `<img>` only for https URLs on that origin; `width="64" height="64"`, `decoding="async"`, no `loading="lazy"`; initials underneath. Images in bar heads, High Command and Servitors load at mount; images inside a branch body get their `src` on that branch's first open.
- Names are the server's display names, never `v-html`. Chips: fixed `line-height` and `min-height`, `max-width: 100%`, `overflow-wrap: anywhere`.
- Sigils: `I`–`VII`, `A`, `L`, `R`, **`M`** (Forge, Companies' "Armoury"), `VD`, `?`. Chip company tag only when it differs from the branch's own company or the branch is not a company.
- Hooks and texts that must survive (tests and e2e): `data-branch`, `data-kind`, `data-rank`, `data-tier` (branch rows only), `data-lateral` (the Terminator `.rs-row` only), `data-id`; `.rs-high-command .rs-branches .rs-branch .rs-head .rs-aside .rs-row .rs-unassigned .rs-servitors .rs-infirmary .rs-infirmary-toggle .rs-rank .rs-member .rs-tag .rs-badge .rs-warn .rs-signin .rs-dev-scenes .rs-meta`; texts `Vacant`, `Acting`, `Check name`, `Servitors`, `Still holds the Legion role`, `Order of Battle`, `Infirmary`, `Loading the roster…`, `Sign in with Discord to see the roster.`, `The roster could not be loaded. Try again shortly.`, `The roster could not be refreshed. Showing the last copy.`, `out of date`. `.rs-branch` is on exactly the twelve branch articles; Unassigned and High Command are not `.rs-branch`. Collapsed bodies stay in the DOM.
- New hook (additive): `data-jump="<key>"` on each branch article (`company-3`…), the Unassigned panel (`unassigned`) and the dais (`high-command`).

## Review Focus

The five inputs most likely to bite a person, each pinned by a test in the named task.

1. **Empty roster** (every head vacant, nobody listed): page renders, no dais, `0 on the roll`, twelve static bars, no throw. (T4 view model, T11 `empty` scene.)
2. **Hostile or odd display names and avatar URLs** (`<img onerror>` as a name, 32-char names, emoji, `javascript:` or look-alike-origin avatars): rendered as inert text, row height stable, avatar falls back to initials. (T9.)
3. **Viewer not on the roll, or only in High Command** (Infirmary-only, role stripped): Find me says so, or scrolls to the dais; never throws. (T4 index, T11.)
4. **A new snapshot lands while branches are open, and a branch the reader had open stops being openable**: open set is kept, stale keys are ignored, Expand all still works. (T6, T11.)
5. **Bad fragments**: `#access_token=…` (auth callback), `#unknown`, empty hash, URL-encoded keys: ignored without error. (T6.)

---

### Task 1: Tokens, `.surface`, reduced-motion guard

**Files:**
- Modify: `src/style.css` (`@theme`, `@layer base`, `@layer components`)
- Create: `src/style.test.js` (node environment)

**Interfaces:**
- Produces: CSS tokens `--color-whitehot`, `--color-vacant`, `--ease-forge`; utility class `.surface`; a global `prefers-reduced-motion` guard. Later tasks use `var(--ease-forge)` and `.surface`.

- [ ] **Step 1: Write the failing tests** in `src/style.test.js`. Read `style.css` as text. Tests: `defines the roster tokens` (the three declarations with the exact values above); `.surface keeps body text readable over the brightest lava` (parse the first `rgba(r,g,b,a)` inside the `.surface` rule; blend it over lava `rgb(255,176,102)`; assert WCAG contrast of that against `rgb(195,208,198)` is `>= 4.5`; include a small `luminance`/`contrast` helper in the test); `guards reduced motion` (an `@media (prefers-reduced-motion: reduce)` block containing `animation-duration: 0.01ms !important`, `transition-duration: 0.01ms !important`, `animation-iteration-count: 1 !important`, `scroll-behavior: auto !important`).
- [ ] **Step 2: Run** `TEST src/style.test.js`. Expected: FAIL (three failures).
- [ ] **Step 3: Implement** in `src/style.css`: the three tokens in `@theme`; `.surface` in `@layer components` = `background: linear-gradient(180deg, rgba(14, 28, 22, 0.86), rgba(9, 18, 14, 0.9)); border: 1px solid var(--color-ash); backdrop-filter: blur(8px);` (the mock's `.surface`); the guard in `@layer base` using `*, *::before, *::after`. `0.01ms`, not `none`, so Vue `<Transition>` still gets `transitionend`.
- [ ] **Step 4: Run** `TEST src/style.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/style.css src/style.test.js` — `feat(site): roster tokens, .surface panel and a global reduced-motion guard`.

---

### Task 2: `PageHeader` component

**Files:**
- Create: `src/components/PageHeader.vue`, `src/components/PageHeader.test.js`

**Interfaces:**
- Produces: `<PageHeader eyebrow? title titleId? lede?>` with a default slot rendered after the lede. Root is `<header class="page-head">`; attrs (e.g. `class`) fall through to it.

- [ ] **Step 1: Write the failing tests** (jsdom). `renders eyebrow, title and lede` (eyebrow text in `.eyebrow`, one `h1` with the title, lede in `.page-lede`); `omits the eyebrow and lede when empty`; `puts titleId on the h1`; `renders the slot after the lede`; `lets the parent add a class to the header`.
- [ ] **Step 2: Run** `TEST src/components/PageHeader.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `PageHeader.vue`: props `{ eyebrow: String = '', title: String (required), titleId: String = '', lede: String = '' }`; `<p v-if="eyebrow" class="eyebrow">` (the global utility from `style.css`), `<h1 :id="titleId || undefined" class="page-title">`, `<p v-if="lede" class="page-lede">`, `<slot />`. Scoped styles copy Companies' `.c-title` (Oswald `--font-display`, uppercase, 700, `clamp(2.2rem, 7vw, 3.6rem)`, `letter-spacing: 0.01em`, `margin: 0.4rem 0 0.6rem`, `color: var(--color-bone)`) and use `#c3d0c6`, `max-width: 52ch`, `line-height: 1.6` for the lede.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(site): shared PageHeader component`.

---

### Task 3: Shared nav links and `SiteFooter`

**Files:**
- Create: `src/lib/useNavLinks.js`, `src/lib/useNavLinks.test.js`, `src/components/SiteFooter.vue`, `src/components/SiteFooter.test.js`
- Modify: `src/components/AppNav.vue` (script: drop `baseLinks` and the `links` computed, use the composable), `src/App.vue` (render `<SiteFooter />`; move the footer markup and its scoped styles into `SiteFooter.vue`; drop now-unused `DISCORD`/`year`)

**Interfaces:**
- Produces: `useNavLinks(): ComputedRef<Array<{ to: string, label: string, section?: true }>>`. Signed-out and non-members get Home, Perk Builder, Armoury, Builds, Companies. Members (`auth.member?.isMember`) also get Accolades, Ranks, Reports, Roster (`section: true`), in that order. `corrections.privileges?.historyViewer` appends Version History (`/history`, `section: true`). Same entries and order as `AppNav.vue` today.
- Consumes: `useAuth()` from `src/stores/auth`, `usePerkCorrections()` from `src/stores/perkCorrections`.

- [ ] **Step 1: Write the failing tests.** `useNavLinks.test.js` (jsdom; mock both stores with a `reactive` object so the computed re-evaluates): `signed out gets the five base links`; `a member also gets Accolades, Ranks, Reports and Roster, in order`; `historyViewer adds Version History`; `a non-member historyViewer gets base plus Version History only`. `SiteFooter.test.js` (jsdom; mock `useNavLinks`; `RouterLinkStub`): `lists every nav link except Home plus Discord`; `shows Roster to a member and not to a visitor`; `shows the current year in the fine print`.
- [ ] **Step 2: Run** both files. Expected: FAIL (modules not found).
- [ ] **Step 3: Implement** `useNavLinks` (a `computed` over the two stores), `SiteFooter.vue` (the footer markup and styles currently in `App.vue`, links from `useNavLinks().value.filter((l) => l.to !== '/')` plus the Discord anchor `https://discord.gg/salamanders`), then switch `AppNav.vue` to `const links = useNavLinks()` (keep its own `DISCORD` constant; the template is unchanged).
- [ ] **Step 4: Run** `TEST src/lib/useNavLinks.test.js`, `TEST src/components/SiteFooter.test.js`, then the whole suite. Expected: all PASS.
- [ ] **Step 5: Commit** — `feat(site): footer links come from the nav's own list`.

---

### Task 4: `rosterView.js` — the one-pass view model

**Files:**
- Create: `src/lib/rosterView.js`, `src/lib/rosterView.test.js`
- Reference (algorithm to port, with the deliberate differences below): `ladder()`, `summary()`, `heat()` and `chip()` in the mock.

**Interfaces:**
- Produces (all pure, no DOM, input never mutated):
  - `heatAt(t: number): string` — `'rgb(r,g,b)'`, `t` clamped to `[0,1]`, interpolating `HEAT_STOPS` (exported).
  - `SIGILS: Record<string,string>` keyed by branch key (`company-1`…`company-7`, `venerable-dreadnoughts`, `forge`, `librarius`, `apothecarion`, `reclusiam`) and `UNASSIGNED_SIGIL = '?'`.
  - `showCompanyTag(member, branch | null): boolean` — `member.company` truthy and (`branch` is null, or `branch.kind !== 'company'`, or `member.company !== branch.number`).
  - `buildRosterView(roster): RosterView`:
    ```
    RosterView = {
      banner: { hero: { rank, member } | null, court: Row[] },   // hero = first High Command row's first member; the rest of that row leads court
      branches: ViewBranch[],        // same order and keys as roster.branches
      unassigned: { count: number, items: LadderItem[] } | null,
      servitors: Member[],
      summary: { total: number, vacant: string[], acting: string[], mismatch: string[] },  // branch keys; total = unique ids, servitors excluded
      index: Map<string, string>,    // member id -> first of: branch key, 'unassigned', 'high-command'
      openableKeys: string[],        // openable branch keys, then 'unassigned' if present
    }
    ViewBranch = { key, kind, label, number: number | null, sigil, count, openable,
                   head: { rank, vacant, members, shown: Member[] /* first 2 */, more: number }, ladder: LadderItem[] }
    Row = { rank, members }
    Heat = { h: string, hp: string, hn: string }
    LadderItem = { type: 'aside', s, heat, members }
               | { type: 'group', s, heat, tier, rows: Row[], last: boolean }   // same-tier consecutive non-lateral rows are peers
               | { type: 'lateral', s, heat, row: Row }                         // rank.lateral
    ```
    `s` is the 0-based sequence over all items. With `n` = number of group items (min 1) and a group's 1-based order `i`: `heat = { h: heatAt(i/n), hp: heatAt((i-1)/n), hn: heatAt(min(1,(i+1)/n)) }`; an aside uses order 0; a lateral row after group `k` uses `hp = heatAt(k/n)`, `hn = heatAt(min(1,(k+1)/n))`, `h = heatAt((k+0.5)/n)` (aside: `k = 0`). `last` is true only on the final item when it is a group. `count` = non-vacant head members + aside + all rank members. `openable` = has rows or aside.
- Consumes: the roster contract in `docs/handoff/2026-10-13-roster.md`.

- [ ] **Step 1: Write the failing tests** (node env; fixture = `src/data/roster.fixture.json`'s `.roster`, empty scene via `sceneOf(fixture, 'empty').roster` from `./rosterScenes`; a `deepFreeze` helper for the input). Tests: `heatAt endpoints and clamping` (`heatAt(0) === 'rgb(242,210,122)'`, `heatAt(0.4) === 'rgb(255,106,43)'`, `heatAt(1) === 'rgb(58,82,70)'`, `heatAt(-1)` and `heatAt(2)` equal the ends); `heat only cools` (sum of channels never increases over `0..1` in steps of `0.05`); `SIGILS covers every roster branch and Forge is M`; `shared sigils agree with companies.json` (map `company-1..7 → first…seventh`, `forge → armoury`, `apothecarion`, `librarius`, `reclusiam` to themselves; assert `SIGILS[key] === companies.find(id).sigil`); `showCompanyTag` (company branch own company → false; other company → true; specialty branch → true; null branch with company → true; no company → false); `keeps the twelve branches in order`; `1st company ladder starts with the aside, then groups, with the Terminator as a lateral between Sergeant and Company Veteran`; `peers share a group` (hand-built branch with two tier-2 rows → one group of two rows); `sequence, heat and last are consistent` (`s` is `0..n-1`, first group's `h === heatAt(1/n)`, only the final group has `last`); `Venerable Dreadnoughts is not openable and has an empty ladder`; `head shows two and counts the rest` (hand-built head of 3 → `shown.length === 2`, `more === 1`); `banner: hero is the first High Command member and the rest of that row leads the court` (hand-built row with two holders); `summary` (`vacant` equals `['company-6']`, `acting` equals `['company-2']`, `mismatch` equals `['company-3']`, `total` equals the unique ids counted independently by walking the JSON); `index prefers the branch over the banner and falls back to the banner` (the Chapter Master who is also 4th Captain → `'company-4'`; a High Command-only id → `'high-command'`; an Unassigned id → `'unassigned'`; an unknown id → `undefined`); `openableKeys lists openable branches then unassigned`; `empty roster` (hero `null`, `court` empty, every branch not openable, `unassigned` `null`, `summary.total === 0`, `summary.vacant.length === 12`); `does not mutate its input and is deterministic` (frozen input; two calls `toEqual`).
- [ ] **Step 2: Run** `TEST src/lib/rosterView.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `rosterView.js` to the interfaces above. One pass over `roster`; the ladder builder is a port of the mock's `ladder()` (group/lateral/aside, heat per item); build `index` and `summary` in the same walk; do not import `companies.json` (the sigil constant is local; only the test imports it).
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(roster): one-pass roster view model`.

---

### Task 5: Store dedupe (P1) and the `view` getter

**Files:**
- Modify: `src/stores/roster.js`, `src/stores/roster.test.js` (add tests; existing ones stay green)

**Interfaces:**
- Consumes: `buildRosterView` (T4).
- Produces: `store.view: RosterView | null` (a Pinia getter over `roster`); `load()` assigns `this.roster` only when the snapshot differs.

- [ ] **Step 1: Write the failing tests** (reuse the file's existing mock setup for `../lib/rosterApi`; wrap `buildRosterView` with `vi.mock('../lib/rosterView', async (orig) => ({ ...(await orig()), buildRosterView: vi.fn((await orig()).buildRosterView) }))`). Tests: `view is null before a roster arrives`; `an identical snapshot assigns nothing` (load twice with equal `fetchedAt`, `stale` and `viewer.infirmary` but separate objects: `store.roster` is the same reference after the second load, and reading `store.view` after each load calls `buildRosterView` once); `a new fetchedAt replaces the snapshot and rebuilds the view`; `a change in stale replaces it`; `a change in viewer.infirmary replaces it` (viewer flags are computed per request, so the same snapshot can differ); `status and message still update on a skipped snapshot` (error banner clears after a good identical reload).
- [ ] **Step 2: Run** `TEST src/stores/roster.test.js`. Expected: new tests FAIL, old ones PASS.
- [ ] **Step 3: Implement** in `load()` after the fetch resolves and passes the sequence guard: if `this.roster` exists and `data.fetchedAt`, `data.stale` and `data.viewer?.infirmary` all equal the current ones, skip `this.roster = markRaw(data)`; still set `status = 'ready'` and clear `message`. Add `getters: { view: (s) => (s.roster ? buildRosterView(s.roster) : null) }`.
- [ ] **Step 4: Run** `TEST src/stores/roster.test.js` and `TEST src/views/Roster.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** — `perf(roster): skip unchanged snapshots and expose the view model`.

---

### Task 6: `useOpenBranches`

**Files:**
- Create: `src/lib/useOpenBranches.js`, `src/lib/useOpenBranches.test.js`

**Interfaces:**
- Produces: `useOpenBranches(): { open: ShallowRef<ReadonlySet<string>>, isOpen(key): boolean, toggle(key): void, openKey(key): void, setAll(keys: string[], value: boolean): void, allOpen(keys: string[]): boolean, hashKey(): string | null }`. State is a `shallowRef(new Set())` replaced on every change. `allOpen([])` is `false`. `hashKey()` returns the decoded `location.hash` minus `#`, or `null` for empty, undecodable or `access_token=`-style fragments (anything containing `=`).

- [ ] **Step 1: Write the failing tests** (jsdom): `starts closed`; `toggle opens then closes`; `openKey is idempotent`; `setAll opens and closes the given keys and leaves others alone`; `allOpen is true only when every given key is open, false for none`; `a key that is no longer in the list is ignored by allOpen`; `hashKey reads #company-3`; `hashKey decodes %2D-style input`; `hashKey ignores #access_token=abc&expires_in=1, an empty hash and a bad escape like #%E0%A4%A` (all `null`, no throw).
- [ ] **Step 2: Run** `TEST src/lib/useOpenBranches.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** to the interface. Validation of a key against known branches is the caller's job.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(roster): open-branch state with safe hash deep links`.

---

### Task 7: `pinReader`

**Files:**
- Create: `src/lib/pinReader.js`, `src/lib/pinReader.test.js`

**Interfaces:**
- Produces: `INSTANT_CLASS = 'rs-instant'`; `withReaderPinned(items: Element[], mutate: () => void, root = document.documentElement): Promise<void>`; `openNow(open: () => void, root = document.documentElement): Promise<void>`. Both add `INSTANT_CLASS` to `root` before `mutate`/`open`, `await nextTick()` (Vue patches on the next tick), and remove the class two animation frames later (also when `mutate` throws). `withReaderPinned` measures the reading-line branch before and after and calls `window.scrollBy({ top: after - want, behavior: 'instant' })` only when `|after - want| >= 0.5`; with no items it just runs `mutate`. `openNow` forces layout (`void root.offsetHeight`) after the tick. Rule values are in Global Constraints.

- [ ] **Step 1: Write the failing tests** (jsdom; stub `getBoundingClientRect` per element, `window.innerHeight = 800`, `window.scrollBy = vi.fn()`, `requestAnimationFrame` to run callbacks immediately; elements are plain divs). Tests: `pins the branch that contains the reading line` (three stacked rects; the middle one contains `y = 280`; after `mutate` its top moves by +300 → `scrollBy({ top: 300, behavior: 'instant' })`); `falls back to the nearest branch when none contains the line`; `clamps the pinned bar: top 20 pins to 90, top 900 pins to 480`; `does not scroll when nothing moved`; `adds the instant class during mutate and removes it afterwards`; `removes the class even when mutate throws`; `no items just runs mutate and never scrolls`; `openNow runs open once, awaits the tick, and cleans up`.
- [ ] **Step 2: Run** `TEST src/lib/pinReader.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** to the interface; the reading-line choice is "containing the line, else the smallest distance from the line to the element's top or bottom edge, ties to the earlier element".
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(roster): keep the reader's place on bulk open and close`.

---

### Task 8: `useRosterPolling`

**Files:**
- Create: `src/lib/useRosterPolling.js`, `src/lib/useRosterPolling.test.js`

**Interfaces:**
- Produces: `useRosterPolling({ load: () => unknown | Promise<unknown>, intervalMs = 60_000, now = Date.now }): { start(): void, stop(): void }`. `start()` is idempotent: it runs `load` now, then schedules the next run `intervalMs` after the previous one settles (a `setTimeout` chain, never overlapping). At a tick with `document.hidden` it skips `load` and reschedules. A `visibilitychange` to visible runs `load` at once if `now() - lastRun >= intervalMs`, and restarts the chain. A `load` that throws or rejects does not break the chain. `stop()` clears the timer and removes the listener, and is safe to call twice.

- [ ] **Step 1: Write the failing tests** (jsdom, `vi.useFakeTimers()`; control `document.hidden` with `Object.defineProperty`): `start loads once immediately`; `loads again after 60 s, not before`; `never overlaps: a pending load blocks the next tick until it settles`; `hidden ticks skip load and keep ticking`; `becoming visible after 60 s loads at once`; `becoming visible within 60 s does not`; `a rejecting load does not stop the chain`; `start twice keeps a single chain`; `stop clears the timer and removes the visibility listener (spy on removeEventListener), and a second stop is harmless`.
- [ ] **Step 2: Run** `TEST src/lib/useRosterPolling.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** to the interface.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(roster): visibility-aware, non-overlapping polling`.

---

### Task 9: Avatar gating, context key, `RosterMember`

**Files:**
- Create: `src/lib/rosterAvatar.js`, `src/lib/rosterAvatar.test.js`, `src/lib/rosterContext.js`
- Modify: `src/components/roster/RosterMember.vue`
- Create: `src/components/roster/RosterMember.test.js`

**Interfaces:**
- Produces: `AVATAR_ORIGINS`; `safeAvatar(url: unknown): string | null` (https, origin in the allowlist, parseable; otherwise `null`); `initials(name: string): string` (first code point of the first two words, uppercased; `''` for empty). `ROSTER_VIEWER = Symbol('rosterViewer')` — a provided `Ref<string | null>` holding the signed-in member's id.
- `RosterMember` props: `member` (required), `branch` (`{ kind, number } | null`, default `null`, feeds `showCompanyTag`), `imageReady` (Boolean, default `true`), `hero` (Boolean, default `false`). Root `<li class="rs-member" :data-id>`; default slot renders last. Avatar span `.rs-avatar` holds the initials (aria-hidden) plus, when `imageReady && safeAvatar(member.avatar)`, an `<img class="rs-avatar-img" width="64" height="64" decoding="async" alt="">`; `.rs-initials` is on the span when no image can show. Tag `.rs-tag` (ordinal), `.rs-badge` "Acting", `.rs-badge.rs-warn` "Check name" (keep its `title`), `.rs-badge` "Bot". When `inject(ROSTER_VIEWER, null)?.value === member.id`: class `rs-me` and a `You` tag.

- [ ] **Step 1: Write the failing tests.** `rosterAvatar.test.js` (node): `allows the Discord CDN`, `rejects http, other origins, look-alike origins (https://cdn.discordapp.com.evil.test/a.png), javascript: and data: URLs, junk, null, undefined and ''`, `initials: two words, one word, emoji first, empty`. `RosterMember.test.js` (jsdom): `shows the display name as text, never as HTML` (name `<img src=x onerror=alert(1)>` yields no `img` element from it and the literal text is present); `shows initials and no img without an avatar`; `renders the image with width, height and async decoding for an allowlisted URL`; `holds the image back until imageReady`; `falls back to initials for a javascript: or foreign-origin avatar`; `the company tag follows showCompanyTag`; `shows Acting, Check name and Bot`; `marks the viewer's own chip with rs-me and You` (provide `ROSTER_VIEWER` via `global.provide`); `hero renders the large variant class`; `renders its slot`.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement** the modules and the component. Port chip CSS from the mock (`.m`, `.av`, `.avimg`, `.nm`, `.tag`, `.b*`, `.m.me`, `.ping`, hero sizes from `.hero`): fixed `line-height` and `min-height`, `max-width: 100%`, `overflow-wrap: anywhere`; Drake hover and `.rs-me` ring; initials sit under an `object-fit: cover` image.
- [ ] **Step 4: Run** both files and `TEST src/views/Roster.test.js` (the old view still mounts this component). Expected: PASS.
- [ ] **Step 5: Commit** — `feat(roster): styled member chip with gated avatars`.

---

### Task 10: `RosterRank`, `RosterLadder`, `RosterBranch`

**Files:**
- Create: `src/components/roster/RosterRank.vue`, `RosterLadder.vue`, `RosterBranch.vue` and a test for each (`*.test.js` beside them)
- Modify: `src/components/roster/roster.css` (list the new hook `data-jump` and the new classes; keep it a hook reference)

**Interfaces:**
- Consumes: `ViewBranch` / `LadderItem` / `Row` (T4); `RosterMember` (T9); `INSTANT_CLASS` (T7).
- Produces:
  - `<RosterRank :row :branch? :with-tier :image-ready>`: `<div class="rs-row" :data-rank :data-tier? :data-lateral?>` with an `h3` label plus count and a `<ul class="rs-chips">` of `RosterMember`. `data-tier` only when `with-tier`; `data-lateral` (empty value) only when `row.rank.lateral`.
  - `<RosterLadder :items :branch? :image-ready :spine>`: one `.rs-step` per item with inline `--s`, `--h`, `--hp`, `--hn` and a diamond `<i class="rs-node">`; a group with several rows wraps them in `.rs-peers`; a lateral item gets the hollow-node modifier; an aside item renders `.rs-aside` with the "Honoured Dreadnoughts" label and chips; `spine=false` hides spine and nodes.
  - `<RosterBranch :branch :open>` emits `toggle`: `<article class="rs-branch" :data-branch :data-kind :data-jump :data-open>`; bar with sigil, title, `.rs-head` (rank `h3`, up to two chips, `+N`, or the word `Vacant` with the dashed-hex icon), count, chevron; the whole bar is the toggle via a stretched `<button aria-expanded aria-controls>` containing the `h2`; a non-openable branch renders the `h2` with no button and no chevron. Body `<div class="rs-body" :id :inert="open ? undefined : ''">` always in the DOM. A local `opened` flag turns true on first `open` and is passed as `image-ready` to the body's chips. The Unassigned panel reuses this component with `variant="unassigned"`: root class `rs-unassigned` instead of `rs-branch`, `data-jump="unassigned"`, no `data-branch`, no head.
- Styles are scoped and ported from the mock:

| Mock selectors | Lives in |
|---|---|
| `.rk`, `.rk-l`, `.chips` | `RosterRank` |
| `.ladder`, `.rg`, `.rg::before` (segment), `.node`, `.rg.lat`, `.rg.last`, `.peers`, `.aside`, `.aside-l`, `.no-spine` | `RosterLadder` |
| `.branch`, `.bar`, `.sigil`, `.t`, `.bar-btn`, `.head`, `.head-l`, `.more`, `.vacant`, `.tail`, `.chev`, `.body`, `.body-in`, `.flash` | `RosterBranch` |
| `.instant .body, .instant .body-in { transition: none !important }` | `RosterBranch` as `:global(.rs-instant) .rs-body, :global(.rs-instant) .rs-body-in` |

  Add `contain: layout style` to the branch root, `min-height: 44px` touch targets on bars at phone width, and the phone breakpoint (`max-width: 760px`) rules from the mock.

- [ ] **Step 1: Write the failing tests** (jsdom; hand-built `ViewBranch` objects plus the fixture through `buildRosterView`). `RosterRank`: `data-rank always, data-tier only with with-tier, data-lateral only for a lateral rank`; `renders one rs-member per member`. `RosterLadder`: `renders items in order with --s, --h, --hp, --hn`; `peers share one step and render two rs-row`; `a lateral item carries data-lateral on its rs-row only`; `an aside renders .rs-aside and no rs-row`; `spine=false renders no rs-node`. `RosterBranch`: `title, sigil and count render`; `head shows two chips and +N`; `a vacant head shows the word Vacant`; `the button reflects aria-expanded and emits toggle on click`; `a non-openable branch has no button`; `the body is in the DOM but inert when closed, and not inert when open` (attribute absent, not "false"); `body avatars are not requested until first open, then stay` (members with allowlisted avatars: 0 body `img` when closed, `>0` after open, still `>0` after closing again); `bar-head avatars load at once`; `hooks: data-branch, data-kind, data-jump, data-open only when open`; `the Unassigned variant has rs-unassigned, no rs-branch and no data-branch`.
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement** the three components to the interfaces; move the existing structural markup's hooks onto them exactly as listed in Global Constraints. Use `useTemplateRef` only if needed; otherwise props down, `toggle` up.
- [ ] **Step 4: Run** the three files. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(roster): branch bar, heat-spine ladder and rank rows`. (These components are not mounted by the page until Task 11, so their visual check against the mock happens in Task 11, Step 5.)

---

### Task 11: Banner, Status, Infirmary and the composed `Roster.vue`

**Files:**
- Create: `src/components/roster/RosterBanner.vue`, `RosterStatus.vue`, `RosterInfirmary.vue` and a test for each
- Modify: `src/views/Roster.vue`, `src/views/Roster.test.js` (existing tests must pass unchanged; add new ones), `src/components/roster/roster.css`

**Interfaces:**
- Consumes: `store.view` (T5), `useOpenBranches` (T6), `withReaderPinned` / `openNow` (T7), `useRosterPolling` (T8), `ROSTER_VIEWER` (T9), `PageHeader` (T2), `RosterBranch` / `RosterRank` (T10).
- Produces:
  - `<RosterBanner :banner>`: `<section class="rs-high-command" data-jump="high-command" aria-label="High Command">`; the hero's rank wrapper is a `.rs-row` with `data-rank` (and no `data-tier`) holding the rank label and the first `li.rs-member` in the section (a `RosterMember` with `hero`); court rows via `RosterRank` (no `data-tier`). Banner chips load their avatars at mount. Renders nothing when `banner.hero` is null.
  - `<RosterStatus :summary :updated :stale :openable :all-open :can-infirmary :infirmary-open :message>` emitting `find`, `toggle-all`, `toggle-infirmary`, `jump(key)`. Texts: `N on the roll`; `1 vacant post` / `N vacant posts`; `1 acting head` / `N acting heads`; `1 branch with a name to check` / `N branches with names to check` (each only when non-zero, each a link/button emitting `jump` with the first key); `.rs-meta` span `Updated {updated}` plus ` · out of date` when stale; buttons `Find me` (`.rs-find`), `Expand all`/`Collapse all` (`.rs-expand-all`, only when `openable`), and `Infirmary` (`button.rs-infirmary-toggle`, `aria-pressed`, only when `can-infirmary`); a `role="status"` paragraph for `message`.
  - `<RosterInfirmary :status :infirmary>`: the existing Infirmary markup and messages (`.rs-infirmary`, `h2`, denied/error/loading text, `N on leave`, one `.rs-member` per member with `.rs-rank` and the `Still holds the Legion role` badge), restyled.
  - `Roster.vue`: composition only. It provides `ROSTER_VIEWER` (`computed(() => auth.member?.id ?? null)`); starts polling (`store.load(auth.token)` plus `store.loadInfirmary(auth.token)` while the Infirmary is open); keeps the existing `watch(auth.member)` reload; `toggleAll()` runs `withReaderPinned(branchEls, () => open.setAll(view.openableKeys, !allOpen))` with `branchEls` = the `.rs-branch, .rs-unassigned` elements; `jumpTo(key)` runs `openNow(() => open.openKey(key))`, then scrolls `[data-jump="key"]` to the centre (`behavior: 'smooth'`) and adds the flash class (removed on `animationend`); `findMe()` looks `auth.member?.id` up in `view.index`: none → message `You are not on the roll. Check your Legion and rank roles in Discord.`; `'high-command'` → scroll the dais; otherwise `openNow` the branch then centre `[data-jump="key"] [data-id="id"]` and add the ping class. On first appearance of a view it opens and scrolls to `open.hashKey()` when that key is in `view.openableKeys`. Page header: eyebrow `XVIII Legion`, title `Order of Battle`, `title-id="roster-title"`, lede `Who leads what, read live from Discord roles. Open a branch to see its ranks.`, `aria-labelledby="roster-title"` on the section. Branch bars use `<RosterBranch>` per `view.branches`, then Unassigned, then the Servitors section (`section.rs-servitors`, `h2` `Servitors`, greyscale chips, no explainer line).
  - Port from the mock: `.status`, `.actions`, `.btn`, `.btn.find`, `.findmsg` (Status); `.dais`, `.hero*`, `.court` (Banner); `.srv`, `.inf*` (Servitors/Infirmary); `rs-flash` and `rs-ping` keyframes.

- [ ] **Step 1: Write the failing tests.** Component tests (jsdom): `RosterBanner` renders the hero first with its `data-id`, court rows without `data-tier`, nothing for a null hero; `RosterStatus` plural/singular strings, hides zero counts, emits `find`, `toggle-all`, `jump` with the key, shows the Infirmary button only when allowed, shows `out of date` when stale, label flips between `Expand all` and `Collapse all`; `RosterInfirmary` denied/error/loading/ready text and the `Still holds the Legion role` badge. New `Roster.test.js` cases (keep the existing ones; stub `Element.prototype.scrollIntoView` and `window.scrollBy`; provide viewer ids through the mocked `auth.member`): `Find me opens the viewer's branch` (viewer id of a 3rd Company Battle-Brother from the fixture → `[data-branch="company-3"]` has `data-open`, no message); `Find me with an unknown id shows the not-on-the-roll message and opens nothing`; `Find me for a High Command-only member scrolls the dais and opens nothing`; `Expand all opens every openable branch and the label flips; Collapse all closes them`; `a status link opens its branch` (click the vacant-post link → `company-6` open); `a #company-3 hash opens that branch after load`; `a #access_token=x or #nope hash opens nothing and does not throw`; `open branches stay open when a new snapshot arrives` (open company-3, `store.load` with a changed `fetchedAt` → still `data-open`); `a vanished branch key is harmless` (open company-1, then a snapshot where company-1 has no rows → no throw, Expand all still works); `the empty scene renders: no dais, 0 on the roll, twelve static bars with no buttons`; `unmount stops polling` (timers cleared).
- [ ] **Step 2: Run** the new test files and `TEST src/views/Roster.test.js`. Expected: new tests FAIL; old tests may FAIL until the view is rewritten.
- [ ] **Step 3: Implement** the components and rewrite `Roster.vue` to the interfaces above. All the old `Roster.test.js` assertions must pass without edits.
- [ ] **Step 4: Run** `TEST src/components/roster`, `TEST src/views/Roster.test.js`, then the full suite. Expected: PASS.
- [ ] **Step 5: Visual check** (Chrome; start the dev server with the variable on that one command only: `VITE_ROSTER_FIXTURE=1 bun run dev`). Compare to the mock at 1440 px and 390 px for scenes `full`, `empty`, `stale`, `error`, `denied`, `signin`, `loading`: header, status line and links, dais, bars, open branch, Find me, Expand all and Collapse all with no jump of the reader's bar, Infirmary, Servitors. Keyboard: Tab to a bar, Enter opens, closed bodies are skipped.
- [ ] **Step 6: Commit** — `feat(roster): styled roster page with Find me, status links and bulk open`.

---

### Task 12: Fixture scale argument

**Files:**
- Modify: `scripts/roster-fixture.mjs`, `scripts/roster-fixture.test.mjs`

**Interfaces:**
- Produces: `syntheticGuild(scale = 1)` and `buildFixture(scale = 1)`; CLI `node scripts/roster-fixture.mjs [--scale N] [--out PATH]` (defaults: scale 1, the committed fixture path). `scale` multiplies the count of every waterfall rank's members in each company and specialty branch (not the head rows, High Command or servitors); ids stay unique and 9-prefixed. `buildFixture(1)` must equal the committed `src/data/roster.fixture.json` exactly.

- [ ] **Step 1: Write the failing tests** (append to the existing file): `scale 1 is exactly the committed fixture` (already covered by the drift test; keep it), `scale 5 has about five times the waterfall members` (members in all branch rows ≥ 4.5× scale 1), `scale 5 keeps the shape` (12 branches, same High Command row keys, same vacant/acting heads), `scale 5 ids are unique and synthetic` (all `9`-prefixed, no duplicates across roster).
- [ ] **Step 2: Run** `TEST scripts/roster-fixture.test.mjs`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the argument (multiply the loop counts inside `syntheticGuild`), the CLI flags, and keep the default output unchanged.
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5: Commit** — `chore(roster): fixture scale argument for performance checks`.

---

### Task 13: Companies port, `/roster` volcano profile, readability

**Files:**
- Modify: `src/views/Companies.vue` (header to `PageHeader`; readability), `src/lib/fireTuning.js` (`ROUTE_PROFILE_DEFAULTS`)
- Create: `src/views/Companies.test.js`, `src/lib/fireTuning.test.js`

**Interfaces:**
- Consumes: `PageHeader` (T2), `.surface` (T1).
- Produces: `<PageHeader class="c-head" eyebrow="The Chapter" title="Companies & Sections" lede="…">` with the search `<input>` in the slot (same `v-model`, `aria-label`, placeholder, class); the old `.c-title` and `.c-intro` rules removed. A `'/roster'` entry in `ROUTE_PROFILE_DEFAULTS` (start at `{ bearing: 0.5, scale: 0.55, variance: 0.8, density: 0.55 }`, tuned visually: the roster is a wide, long, reading page, so it should not fall back to `'*'`).

- [ ] **Step 1: Write the failing tests.** `Companies.test.js` (jsdom, stub RouterLink if needed): `renders the PageHeader copy` (h1 `Companies & Sections`, eyebrow `The Chapter`), `the search box still filters` (type a company title fragment, only matching `.company` articles remain; a non-match shows `No companies match`). `fireTuning.test.js`: `/roster has its own profile, not the fallback` (`profileFor('/roster')` is not `routeProfiles['*']` and its `density <= 0.6`).
- [ ] **Step 2: Run** both. Expected: FAIL.
- [ ] **Step 3: Implement** the header swap and the profile. **Readability:** at ≤ 760 px put each company's text blocks (`.block`) on `.surface`; on wider screens add a left-edge scrim behind the text column (`linear-gradient(90deg, rgba(5, 10, 8, 0.78), rgba(5, 10, 8, 0.5) 62%, transparent)`), so text at 4.5:1 or better holds against the lava at 390 px and 1440 px.
- [ ] **Step 4: Run** both files and the full suite. Expected: PASS.
- [ ] **Step 5: Visual check** (Chrome, 390 px and 1440 px): Companies header looks unchanged except the brighter lede; body text no longer collides with the glow; the Roster page's volcano is calmer and still sits behind the dais without hiding it. Compare against the Companies screenshots from before the change (take them first).
- [ ] **Step 6: Commit** — `feat(site): Companies uses PageHeader; readable text over the volcano; /roster volcano profile`.

---

### Task 14: Measure, e2e spec, handoff

**Files:**
- Modify: `e2e/tests/roster.spec.js`, `docs/handoff/2026-10-13-roster.md`, `src/components/roster/roster.css` (final hook list)
- Reference: `docs/superpowers/specs/2026-10-13-roster-design-pass-mock/bench.js` (the sampler)

- [ ] **Step 1: Bundle budget (P3, P4).** `bun run build`; for each `dist/assets/Roster*` file print `gzip -c <file> | wc -c`; the sum (JS + CSS, including any chunk created only for roster components) must be ≤ 25 600 bytes. `git diff main -- package.json` shows no new dependency.
- [ ] **Step 2: Performance (P5, P10, P11, P13).** Generate the 5× roster into the dev fixture path (`node scripts/roster-fixture.mjs --scale 5 --out src/data/roster.fixture.json`), run `VITE_ROSTER_FIXTURE=1 bun run dev`, open `/roster` in Chrome. Using the sampler logic in `bench.js` (rAF deltas, long-animation-frame, per-frame `getBoundingClientRect().top` of the reading-line bar), record: first render scripting time (DevTools Performance, 4× CPU throttle if the user can set it; otherwise native speed, and say so), worst frame and slow-frame count for single open of the biggest branch and for Expand all, the reader's-bar movement during Expand all and Collapse all from three starting branches (must be ≤ 1 px), and Find me and status-link landing error (must be ≤ 2 px). Then restore the committed fixture: `git checkout -- src/data/roster.fixture.json`. If the 5× first render misses 150 ms or frames drop below 55 fps, stop and report: the spec's fallback is render-on-first-open for branch bodies.
- [ ] **Step 3: Write the e2e additions** (written here, run on Vulkan; the Discord mock's `test-captain-token` is member `100000000000000020`, Captain of the 3rd Company): `Find me opens the viewer's branch` (sign in, `/roster`, click `Find me`, expect `[data-branch="company-3"]` to have attribute `data-open` and `.rs-me` to be visible); `Expand all opens every branch with ranks and Collapse all closes them` (button toggles, `[data-branch][data-open]` count goes `> 0` then `0`); `a #company-3 deep link opens the branch` (`page.goto('/roster#company-3')`). The four existing specs must remain valid unchanged.
- [ ] **Step 4: Update `docs/handoff/2026-10-13-roster.md`:** status becomes "design pass built"; the hook list gains `data-jump` and the new classes; add a "Measured" section with the numbers from Steps 1 and 2 and the 60 Hz caveat; note that the e2e specs are written but not run until Vulkan; keep the deploy section.
- [ ] **Step 5: Run the full suite** (`TEST` without a path). Expected: all PASS.
- [ ] **Step 6: Commit** — `docs(roster): measured results, e2e coverage and handoff for the design pass`.

---

## Self-review notes

- **Spec coverage:** §1 visual → T1, T9–T11; §2 behaviour (collapse, bulk pin, Find me, status links, deep link, inert, polling) → T6, T7, T8, T10, T11; §3 units → T2–T11; §4 hooks → Global Constraints and T10/T11 tests; §5 P1 → T5, P2 → T4/T5, P3/P4 → T14, P5/P10/P11/P13 → T14, P6/P7 → T10 review, P8 → T8, P9 → existing tests (T5, T11), P12 → T9/T10; §6 items 1–4 → T2/T13, T1/T13, T3, T1; §7 accessibility → T10/T11; §8 verification → T14; §9 order → T1–T14 order; new e2e → T14; fixture scale → T12.
- **Interfaces** are defined once, in the task that produces them: `heatAt`, `SIGILS`, `showCompanyTag`, `buildRosterView`/`RosterView` (T4); `store.view` (T5); `useOpenBranches` (T6); `withReaderPinned`, `openNow`, `INSTANT_CLASS` (T7); `useRosterPolling` (T8); `safeAvatar`, `initials`, `ROSTER_VIEWER`, `RosterMember` props (T9); component props (T10, T11).
- **Not built, by decision:** virtualization, name search, typeface change, server ETag, Archive header port, company emblems.
