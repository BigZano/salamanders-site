# Deathwatch Foundation and Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the site-wide mobile baseline, the contributor setup, and a fixture-driven Deathwatch shell (gate, `/companies` banner, hub, area navigation as a bottom sheet, scoped theme) so the Event Tracker port and the backend can follow.

**Architecture:** Three chunks. Chunks 0 and 1 are small PRs to `main`. Chunk 2 builds the shell on `feat/deathwatch` against a dev-only fixture adapter that mirrors the roster's (`?scene=`), so it runs with no backend. Pure logic (route table, drag math) lives in small gated modules; components stay thin.

**Tech Stack:** Vue 3 `<script setup>`, Pinia, vue-router 5, Vitest + Vue Test Utils (jsdom per file via `// @vitest-environment jsdom`), Tailwind v4 tokens in `src/style.css` plus scoped component CSS, Bun.

**Spec:** `docs/superpowers/specs/2026-10-20-deathwatch-design.md` (on `feat/deathwatch`).

**Not in this plan (own plans later):** backend, data layer and the seven Event Tracker views, Manage, Armouring Hall and Chronicles of Valor bodies, image pipeline, the Watch Commander's first PR and cutover. This plan leaves placeholders where they plug in.

**Branches.** Chunk 0: `feat/mobile-baseline` from `main` → PR to `main`. Chunk 1: `chore/contributor-setup` from `main` → PR to `main`. Chunk 2: `feat/dw-shell` from `feat/deathwatch` → PR into `feat/deathwatch`. This plan and the spec live on `feat/deathwatch`; cut chunk 0 and 1 branches in separate worktrees (`superpowers:using-git-worktrees`) and read the plan from the `feat/deathwatch` checkout. Pushing runs the repo's pre-push gate (suite, coverage, mutation, ~7 min): push once per chunk, not per task.

## Global Constraints

- Viewport meta is exactly `width=device-width, initial-scale=1.0, viewport-fit=cover`. Never `user-scalable=no` or `maximum-scale`.
- No `overscroll-behavior: none` and no `user-select: none` on `body` (the site is scrolling documents).
- Every `:hover` rule lives inside `@media (hover: hover) and (pointer: fine)`; every control has an `:active` state.
- Text fields are 16px on coarse pointers. Never `100vh` for shells or sheets: use `100dvh`/`100svh`; bottom-anchored UI pads with `env(safe-area-inset-bottom, 0px)`.
- Animate `transform` and `opacity` only, under 300 ms, easing `var(--ease-forge)`; every animation has a `prefers-reduced-motion` variant. No new easing curves.
- Deathwatch area is dark only; fonts are self-hosted (`@fontsource-variable/cinzel`), no Google Fonts requests.
- **`v-html` is forbidden** in `src/components/deathwatch/`, `src/views/deathwatch/` and `src/components/company/DeathwatchBanner.vue`.
- No member names, Discord ids, role ids or passwords in any committed file, fixture or test. Fixtures use invented values.
- Access rule: the gate trusts `GET /deathwatch/me` only, never `auth.member.isMember`.
- Commands: tests `NODE_OPTIONS=--no-experimental-webstorage node_modules/.bin/vitest run <file>`; full suite `NODE_OPTIONS=--no-experimental-webstorage bun run test`; mutation `node_modules/.bin/stryker run` (never `npx stryker`). The commit hook runs the whole suite.
- Commit with explicit paths (`git add <paths>`, never `-A`) and end each message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- A Discord user **outside the Legion list** (`isMember: false`) who holds access must reach the allowed state. Pinned in Task 2.6.
- **Expired token** while a member is still stored, and a **stale `/me` answer** arriving after `reset()`/sign-out, must never show or keep the allowed state. Pinned in Tasks 2.3 and 2.6.
- **Hostile or stale return paths** (`//evil.example`, `https://…`, `javascript:…`, a fallback older than 10 minutes, a tampered fallback) must be ignored. Pinned in Task 2.4.
- **Garbage URL params** (`__proto__`, `constructor`, unknown tab, odd sub-slug) must not throw or leak a prototype value, and **Manage for a non-Commander** must show a notice, not the dashboard. Pinned in Tasks 2.1 and 2.8.
- **Sheet gesture edges:** zero or negative elapsed time, `NaN`, a second finger mid-drag, unmounting while open (page scroll must unlock). Pinned in Tasks 2.2 and 2.9.

## File map

Chunk 0: modify `index.html`, `src/style.css`, `src/style.test.js`, `package.json`; create `docs/handoff/2026-10-20-mobile-baseline.md`.
Chunk 1: create `.github/workflows/pr-check.yml`, `scripts/pr-check-workflow.test.mjs`, `docs/handoff/2026-10-20-deathwatch-contributing.md`, `PRODUCT.md`, `DESIGN.md`; modify `README.md`.
Chunk 2:

| File | Responsibility |
| --- | --- |
| `src/lib/deathwatch/areas.js` (+test, gated) | Area/tab table and URL resolution |
| `src/lib/deathwatch/sheetDrag.js` (+test, gated) | Drag damping and dismiss decision |
| `src/lib/deathwatch/api.js`, `scenes.js`, `fixture.js` (+tests) | `/me` client; dev scenes; dev-only fixture gate |
| `src/stores/deathwatch.js` (+test) | Access state machine |
| `src/lib/discordAuth.js`, `src/stores/auth.js` (+tests) | Return path with fallback; `signIn({ returnTo })` |
| `src/components/deathwatch/deathwatch.css`, `DeathwatchShell.vue` | Scoped dark tokens, font, backdrop |
| `src/components/deathwatch/DeathwatchGate.vue` | Five-state gate |
| `src/components/deathwatch/DeathwatchNav.vue`, `DeathwatchNavSheet.vue`, `DeathwatchAreaBar.vue` | Tab list; bottom sheet; banner trigger |
| `src/views/deathwatch/DeathwatchLayout.vue`, `DeathwatchHub.vue`, `DeathwatchArea.vue` | Routes' views |
| `src/components/company/DeathwatchBanner.vue` | "REDACTED" banner on `/companies` |
| `src/router.js`, `src/views/Companies.vue`, `src/lib/fireTuning.js`, `vitest.config.js`, `stryker.config.mjs`, `package.json` | Wiring |

---

# Chunk 0 — Mobile baseline (branch `feat/mobile-baseline`)

### Task 0.1: Viewport meta and base-layer touch CSS

**Files:** Modify `index.html`, `src/style.css`; Test `src/style.test.js`.

**Interfaces:** Produces nothing code-level; later tasks rely on the baseline existing.

- [ ] **Step 1: Failing tests** in `src/style.test.js`, new `describe('mobile baseline')`, reading `index.html` via `new URL('../index.html', import.meta.url)`:
  - `lets the page paint under the notch`: viewport content is exactly `width=device-width, initial-scale=1.0, viewport-fit=cover`.
  - `never disables zoom`: html contains neither `user-scalable` nor `maximum-scale`.
  - `removes the tap flash and font inflation`: css contains `-webkit-tap-highlight-color: transparent;` and `-webkit-text-size-adjust: 100%;`.
  - `makes controls tap immediately`: a rule selecting `button`, `a` and `[role='button']` sets `touch-action: manipulation`.
  - `keeps text fields at 16px on touch screens`: a `@media (pointer: coarse)` block sets `font-size: 16px` on `input`, `textarea`, `select`.
  - `pads for the notch and home indicator`: css contains `env(safe-area-inset-left, 0px)`, `env(safe-area-inset-right, 0px)` and `env(safe-area-inset-bottom, 0px)` on `body`.
  - `leaves pull-to-refresh and text selection alone`: css contains no `overscroll-behavior: none`; the `body` rule has no `user-select: none`.
- [ ] **Step 2:** Run `src/style.test.js` → the new tests FAIL.
- [ ] **Step 3: Implement** the meta change in `index.html`; in `src/style.css` base layer add the `html` and control rules, side/bottom inset padding on `body`, and an unlayered `@media (pointer: coarse)` block at the end of the file using `!important` for the 16px rule (scoped component CSS outranks the base layer; say so in a comment). Excluded from that rule: checkboxes and radios.
- [ ] **Step 4: Audit.** Run `grep -rn "font-size" src --include=*.vue` limited to input/textarea/select selectors and confirm none exceeds `1rem`; run `grep -rn "position: \(fixed\|sticky\)" src` and, for each element anchored to the left, right or bottom edge, add `env(safe-area-inset-*, 0px)` padding or record why it needs none. Put the list in the PR description.
- [ ] **Step 5:** Run the style tests → PASS; run the full suite → PASS.
- [ ] **Step 6: Commit** `index.html src/style.css src/style.test.js` (`feat(mobile): viewport-fit, tap flash, touch-action, 16px fields, safe-area padding`).

### Task 0.2: Gate the shared hovers and give buttons a press state

**Files:** Modify `src/style.css`; Test `src/style.test.js`.

- [ ] **Step 1: Failing tests:**
  - `applies hover styles only where hover exists`: with every `@media (hover: hover) and (pointer: fine) { … }` block removed (brace-matched), `style.css` contains no `:hover`.
  - `gives the shared buttons a press state`: `.btn-ember:active` and `.btn-drake:active` each contain `transform: scale(0.97)`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement:** wrap the `.btn-ember:hover` and `.btn-drake:hover` rules in the media query; change `.btn-ember:active` to `transform: scale(0.97)`; add `.btn-drake:active` the same and add `transform 0.15s ease` to `.btn-drake`'s transition list.
- [ ] **Step 4:** Run style tests and full suite → PASS.
- [ ] **Step 5: Commit** (`feat(mobile): gate shared button hovers behind (hover: hover), add press states`).

### Task 0.3: LAN dev script, phone checklist, PR

**Files:** Modify `package.json` (`"dev:lan": "vite --host"`); Create `docs/handoff/2026-10-20-mobile-baseline.md`.

- [ ] **Step 1:** Add the script. Run `bun run dev:lan`; expected: the output lists a `Network:` URL. Stop it.
- [ ] **Step 2:** Write the checklist doc: for each fix, the page to open and what a pass looks like, on a real phone. Cover: no grey flash on tapping links and buttons; a tapped `.btn-ember` does not stay "hovered"; focusing the search box on `/companies` and `/builds` does not zoom the page; landscape on a notched phone leaves nothing under the notch or rounded corners; the home-indicator area is clear at the foot of the footer; pull-to-refresh still works on a long page. State which items are verified from code and which only on a device.
- [ ] **Step 3:** Run the full suite → PASS. Commit `package.json docs/handoff/2026-10-20-mobile-baseline.md`.
- [ ] **Step 4:** Push (`git push -u origin feat/mobile-baseline`), then `gh pr create --base main` with the checklist and the Task 0.1 audit list in the body.

---

# Chunk 1 — Contributor setup (branch `chore/contributor-setup`)

### Task 1.1: PR check workflow

**Files:** Create `.github/workflows/pr-check.yml`, `scripts/pr-check-workflow.test.mjs`.

- [ ] **Step 1: Failing test** `scripts/pr-check-workflow.test.mjs` (reads the workflow file as text):
  - `runs on pull_request, never pull_request_target`.
  - `references no secrets`: no `secrets.` anywhere in the file.
  - `asks for read access only`: `permissions:` is exactly `contents: read`.
  - `runs the suite and the build`: contains `bun run test` and `bun run build`.
- [ ] **Step 2:** Run → FAIL (file missing).
- [ ] **Step 3: Implement** the workflow: name `PR check`; trigger `pull_request` on branches `[main, 'feat/**']`; a concurrency group per PR that cancels in progress; one job on `ubuntu-latest`: checkout, `oven-sh/setup-bun@v2`, `bun install --frozen-lockfile` with `HUSKY: '0'`, `node scripts/archive-leak-guard.mjs --tracked`, `bun run test`, `bun run build`. No mutation run (the maintainer's pre-push gate covers it).
- [ ] **Step 4:** Run the test → PASS.
- [ ] **Step 5:** Commit, push, `gh pr create --base main`. Expected: the `PR check` run appears on the PR and passes. If `bun run build` fails because the sealed archive is absent, add the `bun scripts/seal-archive.mjs fetch` step with `GH_TOKEN: ${{ github.token }}` exactly as `deploy.yml` has it, and push again.

### Task 1.2: Contributor onboarding doc

**Files:** Create `docs/handoff/2026-10-20-deathwatch-contributing.md`; Modify `README.md` (a short pointer).

- [ ] **Step 1:** Write the doc for a first-time GitHub user, in order: fork on GitHub; clone the fork; `git remote add upstream` and fetch; branch from `upstream/feat/deathwatch` named `dw/<topic>`; `bun install`; run with `VITE_DEATHWATCH_FIXTURE=1 bun run dev` and the scene names (Task 2.3); phone testing with `bun run dev:lan`; run the tests (the Node v26 `NODE_OPTIONS` note); open the PR **into `feat/deathwatch`, not `main`**; what the `PR check` shows; keep the fork current (`git fetch upstream` then merge `upstream/feat/deathwatch`). Rules: no real names, ids or passwords in anything committed, no `v-html`, do not touch `.github/` or `server/` without asking, forks never hold secrets. Add a short "using Claude Code here" note pointing at the spec and this doc.
- [ ] **Step 2:** Verify: `node scripts/archive-leak-guard.mjs --tracked` passes; every path the doc names exists (`ls`).
- [ ] **Step 3:** Commit `docs/handoff/2026-10-20-deathwatch-contributing.md README.md`.

### Task 1.3: PRODUCT.md and DESIGN.md (interactive, with Bret)

**Files:** Create `PRODUCT.md`, `DESIGN.md` at the repo root.

- [ ] **Step 1:** Run `/impeccable init` and interview Bret (this blocks on his answers); it writes `PRODUCT.md`. Product truth only: the site, the community, phone-first, the access model.
- [ ] **Step 2:** Run `/impeccable document` to generate `DESIGN.md` from the existing tokens and components; add a "Deathwatch area" section from spec "Sub-theme and motion".
- [ ] **Step 3:** Verify: re-run the impeccable `context` command; `productPath` and `designPath` are non-null. Neither file contains names, ids or passwords.
- [ ] **Step 4:** Commit both files; push; PR to `main` (or add to the Task 1.1 PR if still open).

---

# Chunk 2 — Shell (branch `feat/dw-shell`)

### Task 2.0: Sync

- [ ] After Bret merges the chunk 0 and chunk 1 PRs: `git switch feat/deathwatch`, `git merge origin/main`, run the full suite → PASS, `git switch -c feat/dw-shell`. Add `@fontsource-variable/cinzel` now (`bun add @fontsource-variable/cinzel`) and commit `package.json bun.lock`.

### Task 2.1: Area table and URL resolution (pure, gated)

**Files:** Create `src/lib/deathwatch/areas.js`, `areas.test.js`; Modify `vitest.config.js` (add to `GATED`), `stryker.config.mjs` (add to `mutate`).

**Interfaces — Produces:**
```js
export const AREAS // { [slug]: { label: string, blurb: string, tabs: { slug: string, label: string }[] } }
export function resolveArea(params: { area?: unknown, tab?: unknown, sub?: unknown }):
  { area: string, tab: string, sub: string, canonical: string } | null
```
Slugs and labels are the archive's, verbatim: `eventtracker` "Event Tracker" (`standings` Standings, `kill-teams` Kill Teams, `players` Players, `honour-roll` Honour Roll, `game-stats` Game Stats, `scoring` Scoring, `archive` Archive); `armouringhall` "Armouring Hall" (`standard` Standard, `specialist` Specialist, `watch-command` Watch Command); `chronicles` "Chronicles of Valor" (`hall-of-champions` Hall of Champions, `chamber-of-honor` Chamber of Honor, `player-profiles` Player Profiles, `in-memoriam` In Memoriam, `operational-records` Operational Records); `manage` "Manage" (`enter-mission` Enter mission, `manage` Manage, `checks` Checks, `records` Records, `page-texts` Page Texts). Blurbs: Event Tracker "Standings, Kill Teams, players and honours"; Armouring Hall "Specialist armour, standard uniform and heraldry"; Chronicles of Valor "Deeds and honours of the Watch Fortress"; Manage "The Watch Commander's dashboard".

- [ ] **Step 1: Failing tests** (`areas.test.js`):
  - `lists the four areas in hub order`: keys equal `['eventtracker','armouringhall','chronicles','manage']`.
  - `lists the seven Event Tracker views in order` (exact slug array above) and the other areas' tab slugs.
  - `defaults to the first tab`: `resolveArea({ area: 'eventtracker' })` → `{ area: 'eventtracker', tab: 'standings', sub: '', canonical: '/deathwatch/eventtracker/standings' }`.
  - `falls back for an unknown tab`: `{ area: 'eventtracker', tab: 'nonsense' }` → tab `standings`.
  - `rejects an unknown area`: `{ area: 'nope' }` → `null`; `{}` and non-string inputs → `null`.
  - `survives prototype keys`: `{ area: '__proto__' }`, `{ area: 'constructor' }`, `{ area: 'eventtracker', tab: '__proto__' }` → `null` / first-tab fallback, no throw.
  - `keeps a sub-slug only for the Armouring Hall`: `{ area: 'armouringhall', tab: 'standard', sub: 'battlebrother' }` → canonical `/deathwatch/armouringhall/standard/battlebrother`; the same `sub` under `eventtracker` → `''`.
  - `drops a hostile sub-slug`: `'../x'`, `'A B'`, `''`, 41 characters, non-string → `''`. A valid sub matches `^[a-z0-9]{1,40}$`.
- [ ] **Step 2:** Run → FAIL. **Step 3: Implement** with `Object.hasOwn` lookups (no bare `obj[key]` on user input). **Step 4:** tests + coverage for the file at 100% → PASS. **Step 5:** commit (`feat(deathwatch): area and tab table with URL resolution`).

### Task 2.2: Sheet drag math (pure, gated)

**Files:** Create `src/lib/deathwatch/sheetDrag.js`, `sheetDrag.test.js`; Modify `vitest.config.js`, `stryker.config.mjs`.

**Interfaces — Produces:**
```js
export const DISMISS_RATIO = 0.4        // fraction of sheet height
export const DISMISS_VELOCITY = 0.11    // px per ms
export const MIN_FLICK = 20             // px
export function dragOffset(delta: number): number
export function shouldDismiss(a: { distance: number, elapsedMs: number, height: number }): boolean
```
`dragOffset`: `delta >= 0` returns `delta`; `delta < 0` returns `-Math.sqrt(-delta)` (friction past the open position); non-finite returns `0`. `shouldDismiss`: `false` if any input is non-finite or `height <= 0`; `true` if `distance >= height * DISMISS_RATIO`; otherwise `true` only if `elapsedMs > 0`, `distance >= MIN_FLICK` and `distance / elapsedMs > DISMISS_VELOCITY`.

- [ ] **Step 1: Failing tests:** `dragOffset(30) === 30`; `dragOffset(-100) === -10`; `dragOffset(-4) === -2`; `NaN`, `Infinity`, `undefined` → `0`. `shouldDismiss`: distance exactly `height * 0.4` → true, one pixel less and slow → false; flick `{ distance: 40, elapsedMs: 100, height: 400 }` → true (0.4 px/ms); `{ distance: 19, elapsedMs: 1 }` → false (below `MIN_FLICK`); exactly `0.11 px/ms` → false, just above → true; `elapsedMs` `0`, `-5`, `NaN` → velocity rule off (no division by zero), distance rule still applies; negative distance → false; `height` `0`/`NaN` → false.
- [ ] **Step 2–5:** FAIL → implement → PASS with 100% coverage → commit.

### Task 2.3: `/me` client, scenes, fixture gate, access store

**Files:** Create `src/lib/deathwatch/api.js`, `scenes.js`, `fixture.js`, `src/stores/deathwatch.js` and a test beside each.

**Interfaces — Consumes:** `request(path, { token, cache })` from `src/lib/buildsApi.js` (throws `BuildsApiError` with `.status`). **Produces:**
```js
getMe(token: string | null): Promise<{ access: boolean, watchCommander: boolean }>   // request('/deathwatch/me', { token, cache: 'no-store' })
SCENES = ['allowed','commander','denied','signin','checking','unavailable']
sceneOf(name: string): { _fixture: true, scene: string, status: Status, commander: boolean }   // unknown name → 'allowed'
loadFixture(): Promise<ReturnType<typeof sceneOf> | null>
// Status = 'idle' | 'checking' | 'allowed' | 'denied' | 'signin' | 'unavailable'
useDeathwatch(): store { status: Status, commander: boolean, load(token: string | null): Promise<void>, reset(): void }
```
`loadFixture` returns non-null only when `import.meta.env.DEV && import.meta.env.VITE_DEATHWATCH_FIXTURE` (write that condition literally so production builds drop the import), taking the scene from `?scene=` else the env value, as `src/lib/rosterFixture.js` does. `sceneOf`: `allowed` → allowed, `commander` → allowed + commander, `denied`/`signin`/`unavailable` → that status, `checking` → status `checking` (the store then never resolves). The spec's "signed-out" gate state is `signin` in code, matching the roster's statuses.

- [ ] **Step 1: Failing tests.** `scenes.test.js`: each scene's status/commander; unknown name → allowed. `api.test.js`: `getMe('t')` calls `request` with the path and `{ token: 't', cache: 'no-store' }`. `stores/deathwatch.test.js` (mock `api` and `fixture`):
  - `signs in first when there is no token`: `load(null)` → `signin`, `getMe` not called.
  - `answers 401 with signin, 403 with denied, other errors with unavailable`.
  - `denies when access is false` and never reports commander then; `allows when access is true` and `commander` follows `watchCommander`; `commander` is `false` whenever `access` is `false` even if the server says otherwise.
  - `drops a stale answer`: `load` started, then `reset()` (or a second `load`), then the first resolves → state unchanged. (Review Focus: stale `/me` after sign-out.)
  - `reset()` returns to `idle` with `commander: false`.
  - `applies a fixture scene` including `checking` (stays `checking`).
- [ ] **Step 2:** FAIL. **Step 3:** Implement, mirroring `src/stores/roster.js` (sequence counter; `statusOf(err)`). **Step 4:** PASS. **Step 5:** commit.

### Task 2.4: Return path with fallback, `signIn({ returnTo })`, sign-out reset

**Files:** Modify `src/lib/discordAuth.js`, `src/stores/auth.js`; Test `src/lib/discordAuth.test.js`, `src/stores/auth.test.js`.

**Interfaces — Consumes:** `useDeathwatch().reset()` (Task 2.3). **Produces:**
```js
export const RETURN_FALLBACK_MS = 10 * 60 * 1000
export function sanitizeReturnPath(p: unknown): string | null   // a string of ≤ 512 chars starting with one "/", not "//", no backslash, no whitespace
export function beginSignIn(options?: { returnTo?: string }): void
// auth store: signIn(options?: { returnTo?: string }): void   (passes options to beginSignIn)
```
`beginSignIn` writes the sanitized `returnTo` (else the current path + search) to `sessionStorage` under the existing key **and** to `localStorage` under `salamanders-discord-return-fallback` as `{ path, at }`. `scrubCallbackHash` prefers the `sessionStorage` value, else a fallback no older than `RETURN_FALLBACK_MS`; both are re-sanitized on read, and both keys are removed.

- [ ] **Step 1: Failing tests:** `sanitizeReturnPath` accepts `/deathwatch` and `/a/b?x=1#h`, rejects `//evil.example`, `https://evil.example`, `/\\evil`, `javascript:alert(1)`, `''`, `'/ x'`, 513 characters, non-strings. `beginSignIn({ returnTo: '/deathwatch' })` stores that path in both stores; hostile `returnTo` is ignored and the current path used. `scrubCallbackHash` with an empty `sessionStorage` and a fresh fallback restores the fallback path; an 11-minute-old fallback does not; a tampered hostile fallback does not; both keys are gone after. `auth.signIn({ returnTo })` forwards it; `auth.signOut()` leaves `useDeathwatch()` at `idle`.
- [ ] **Step 2–5:** FAIL → implement → PASS (existing auth tests still pass) → commit.

### Task 2.5: Scoped theme, shell, `v-html` guard

**Files:** Create `src/components/deathwatch/deathwatch.css`, `DeathwatchShell.vue`, `DeathwatchShell.test.js`, `src/components/deathwatch/no-v-html.test.js`.

**Interfaces — Produces:** `DeathwatchShell` (default slot) renders `<div class="dw">` with an `aria-hidden` `.dw-backdrop` layer (translucent dark gradient so the volcano shows through; a real image slots in later) and imports the Cinzel font and `deathwatch.css`. `deathwatch.css` defines on `.dw`: `--dw-bg:#060906; --dw-surface:#0b110c; --dw-surface-2:#111a12; --dw-ink:#e2ecdc; --dw-muted:#83978a; --dw-line:#1a2b1c; --dw-line-2:#2a4a2d; --dw-accent:#7fd35c; --dw-accent-ink:#041004; --dw-silver:#c3ccd5; --dw-gold:#e0b43c; --dw-down:#e5736a; --dw-up:#5fcf8b; --dw-font-title:'Cinzel Variable', 'Cinzel', Georgia, serif`.

- [ ] **Step 1: Failing tests:** shell renders its slot inside `.dw`; the backdrop is `aria-hidden="true"`; `deathwatch.css` contains each token above; contrast (helpers in `src/test-utils/contrast.js`) of `--dw-ink` and of `--dw-muted` on `--dw-surface` is ≥ 4.5, and `--dw-accent-ink` on `--dw-accent` is ≥ 4.5. `no-v-html.test.js`: walks `src/components/deathwatch`, `src/views/deathwatch` (when present) and `src/components/company/DeathwatchBanner.vue` and fails if any file contains `v-html`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** `bun run build`; expected: the Cinzel font file appears in a lazy chunk only. Commit.

### Task 2.6: The gate

**Files:** Create `src/components/deathwatch/DeathwatchGate.vue`, `DeathwatchGate.test.js`.

**Interfaces — Consumes:** `useAuth()` (`member`, `token`, `signIn(options)`), `useDeathwatch()`. **Produces:** `DeathwatchGate` (default slot shown only when `status === 'allowed'`). It does `watch(() => auth.member, () => store.load(auth.token), { immediate: true })` (`auth.token` is not reactive; `auth.member` is). It never reads `isMember`.

States and copy: `signin` → eyebrow "Watch Fortress Ebonhold", "Clearance required. Sign in with Discord to be verified.", a `.btn-ember` button "Sign in with Discord" calling `auth.signIn({ returnTo: route.fullPath })`; `idle`/`checking` → "Verifying clearance…" with `aria-busy="true"` and a reserved min-height; `denied` → "Your clearance is not on record. Access is held by the Deathwatch and by those the Watch Commander has cleared."; `unavailable` → "The fortress could not be reached. Try again in a moment." with `role="alert"` and a "Try again" button calling `store.load(auth.token)`. Buttons are at least 44px tall.

- [ ] **Step 1: Failing tests** (mock auth, api, router): each state's text; the sign-in button passes the current `fullPath`; **a member with `isMember: false` whose `/me` says `access: true` renders the slot**; **a stored member with a null token shows signin and never calls `getMe`**; slot content is not mounted in `denied`, `signin`, `unavailable`, `checking`; "Try again" reloads.
- [ ] **Step 2–5:** FAIL → implement (scoped CSS on `--dw-*` tokens) → PASS → commit.

### Task 2.7: The `/companies` banner

**Files:** Create `src/components/company/DeathwatchBanner.vue`, `DeathwatchBanner.test.js`; Modify `src/views/Companies.vue` (one import, one element directly after `</PageHeader>`), `src/views/Companies.test.js`.

**Interfaces — Consumes:** `useAuth()`, `useRouter()`. **Produces:** `<a class="dw-banner" href="/deathwatch" aria-label="REDACTED — Deathwatch access">` showing the text `REDACTED`. Click handler: ignore if `event.defaultPrevented`, `event.button !== 0`, or any of meta/ctrl/shift/alt is held; otherwise `preventDefault()`, then `auth.signedIn ? router.push('/deathwatch') : auth.signIn({ returnTo: '/deathwatch' })`. It fetches nothing. At least 56px tall, full width on phones, hover only inside the hover media query, `:active` feedback.

- [ ] **Step 1: Failing tests:** renders `REDACTED` with `href="/deathwatch"`; signed-out click → `signIn` called once with `{ returnTo: '/deathwatch' }`, `push` not called, default prevented; signed-in click → `push('/deathwatch')`, `signIn` not called; ctrl-click and middle-button → neither called, default not prevented; `Companies.test.js`: `a.dw-banner` exists exactly once.
- [ ] **Step 2–5:** FAIL → implement → PASS (run every `Companies*.test.js`; if a missing-router injection warning appears, give those mounts a stub router) → commit.

### Task 2.8: Routes, hub, area view, nav list

**Files:** Modify `src/router.js`, `src/router.test.js`; Create `src/views/deathwatch/DeathwatchLayout.vue`, `DeathwatchHub.vue`, `DeathwatchArea.vue`, `src/components/deathwatch/DeathwatchNav.vue` and tests.

**Interfaces — Consumes:** `AREAS`, `resolveArea` (2.1); `DeathwatchShell` (2.5); `DeathwatchGate` (2.6); `useDeathwatch().commander`. **Produces:** routes — parent `/deathwatch` (`DeathwatchLayout`, meta `{ title: 'Watch Fortress Ebonhold', ashOver: true }`) with children `''` (name `deathwatch`, `DeathwatchHub`) and `':area/:tab?/:sub?'` (name `deathwatch-area`, `DeathwatchArea`), placed before the catch-all. Canonicalization runs on entry (`beforeEnter`) **and** on param-only changes (`onBeforeRouteUpdate` in `DeathwatchArea`): unknown area → the `not-found` route; a differing canonical path → `replace` to it. `DeathwatchNav` props `{ area: string, current: string }`, emits `navigate`; renders `<nav aria-label="<Area label> sections">` with a `RouterLink` per tab to `/deathwatch/<area>/<tab>` (current has `aria-current="page"`) and a final "Back to the Fortress" link to `/deathwatch`. `DeathwatchHub`: one full-width card per area from `AREAS` (the Manage card only when `commander`) plus a "Return to the Salamanders" card to `/`; one column under 640px, three from 900px; `h1` "Watch Fortress Ebonhold" in `--dw-font-title`, eyebrow "XVIIIth Legiones Astartes, The Salamanders", tagline "Suffer not the alien to live." `DeathwatchArea`: body is a placeholder card "This view is being rebuilt." per tab; for `manage` when not `commander`, a notice "Restricted to the Watch Commander." replaces everything.

- [ ] **Step 1: Failing tests:** `router.test.js`: `/deathwatch/eventtracker/players` resolves to `deathwatch-area`; `/deathwatch/eventtracker` ends at `/deathwatch/eventtracker/standings`; `/deathwatch/eventtracker/nonsense` → standings; `/deathwatch/nope` → `not-found`; navigating `players` → `bogus` within the area canonicalizes. Nav: tabs in `AREAS` order, current marked, back link present. Hub: three area cards with the right hrefs, Manage card only for the commander, return card to `/`. Area: manage + non-commander shows the notice and no tab list.
- [ ] **Step 2–5:** FAIL → implement → PASS (full suite, since `router.js` is shared) → commit.

### Task 2.9: Bottom sheet and the area bar

**Files:** Create `src/components/deathwatch/DeathwatchNavSheet.vue`, `DeathwatchAreaBar.vue` and tests; Modify `DeathwatchArea.vue`.

**Interfaces — Consumes:** `dragOffset`, `shouldDismiss` (2.2); `DeathwatchNav` (2.8). **Produces:**
```
DeathwatchNavSheet: v-model (boolean open), default slot. Native <dialog class="dw-sheet">.
DeathwatchAreaBar: props { areaLabel: string, tabLabel: string, open: boolean }, emits 'open'. A <button class="dw-areabar" aria-haspopup="dialog" :aria-expanded="open">.
```
Sheet behavior: open calls `showModal()`; Escape, a click on the dialog backdrop, a dismiss gesture, and `DeathwatchNav`'s `navigate` each set the model to false; close waits for the transform transition to end (immediately under reduced motion) before `close()`. Handle: pointer capture; a second pointer is ignored while one is down; `pointermove` sets `style.transform = translateY(<dragOffset>px)` directly; release calls `shouldDismiss` with the measured distance, elapsed time and height, else springs back (transition 200 ms `var(--ease-forge)`). CSS: bottom-anchored, `max-height: min(80dvh, 34rem)`, `padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0px))`, `overscroll-behavior: contain`, handle `touch-action: none`, `body:has(.dw-sheet[open]) { overflow: hidden }`, `transform`/`opacity` transitions only. Wide screens (≥ 900px): the bar is hidden and `DeathwatchArea` shows `DeathwatchNav` as a sidebar instead.

- [ ] **Step 1: Failing tests** (jsdom lacks `showModal`/`close`: stub them on `HTMLDialogElement.prototype`): opening calls `showModal`; `cancel`/Escape and a backdrop click emit `update:modelValue(false)`; a nav `navigate` closes it; a fast flick closes, a short slow drag springs back (transform reset); **a second pointer mid-drag is ignored**; reduced motion closes without waiting for `transitionend`; **unmounting while open calls `close()` and leaves no `open` attribute**. Area bar renders both labels, `aria-expanded` follows `open`, click emits `open`.
- [ ] **Step 2–5:** FAIL → implement → PASS → commit.

### Task 2.10: Deathwatch fire profile (sparks)

**Files:** Modify `src/lib/fireTuning.js`, `src/lib/fireTuning.test.js`.

**Interfaces — Produces:** `profileFor(path)` resolves the exact key, else the key `<first segment>/*`, else `'*'`, else `NEUTRAL_PROFILE`; `ROUTE_PROFILE_DEFAULTS` gains `'/deathwatch/*': { bearing: 0.45, scale: 0.5, variance: 0.7, density: 0.5 }` (starting values, tuned in Step 4). The `'/'` profile stays `0 / 1 / 1 / 1`.

- [ ] **Step 1: Failing tests:** `/deathwatch` and `/deathwatch/eventtracker/standings` return the Deathwatch profile; `/companies` unchanged; an unknown path still returns `'*'`; `/` unchanged.
- [ ] **Step 2–3:** FAIL → implement → PASS (existing fire tests pass).
- [ ] **Step 4: Look.** Run `VITE_DEATHWATCH_FIXTURE=1 bun run dev`, open `/deathwatch?scene=allowed` in the browser, and confirm rising sparks and ash are visible through the backdrop and do not hurt text contrast. If the backdrop hides them, add `DeathwatchSparks.vue` in the shell: about 14 `aria-hidden`, `pointer-events: none` elements animated with `transform` and `opacity` only, none under `prefers-reduced-motion`; add a mount test. Tune the profile values.
- [ ] **Step 5:** Commit.

### Task 2.11: Full verification and PR

- [ ] **Step 1:** Run the full suite, `bun run test:coverage` (the two new gated files at 100%) and `node_modules/.bin/stryker run` (100%: fix survivors with better tests, not by loosening config) and `bun run build`.
- [ ] **Step 2:** Walk every scene (`allowed`, `commander`, `denied`, `signin`, `checking`, `unavailable`) at desktop width in the browser; open the sheet, switch tabs, check `/deathwatch/eventtracker/bogus` and `/deathwatch/nope`.
- [ ] **Step 3:** Write `docs/handoff/2026-10-20-deathwatch-shell.md`: what exists, how to run the scenes, and the real-phone checks (sheet drag and rubber-band, bottom safe-area, iOS left-edge swipe, the Discord sign-in return path through the Discord app, first-load time). State what was verified from code and what needs the device. Commit.
- [ ] **Step 4:** Push `feat/dw-shell`; `gh pr create --base feat/deathwatch`; hand Bret the phone checklist.
