# Companies and Roster Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the members-only `/roster` page into the public `/companies` page: a collapsed Ranks bar under every company, a public leadership-and-counts view backed by a new `GET /roster/public`, and the full ladder for signed-in Legion members.

**Architecture:** A pure server projection (`rosterPublic.js`) behind an unauthenticated, cache-backed handler. On the client, `Companies.vue` becomes a thin composition: `CompanyArticle` (story, moved out unchanged), an async `CompanyRanks` slot that wraps the existing `RosterBranch` bar (new `embedded` variant, two bodies: the ladder for members, `PublicShape` for the public), and two composables (`useCompanyRoster` for mode and data, `useRosterActions` for Find me / Expand all / jumps / Infirmary). `Roster.vue` is deleted and `/roster` redirects.

**Tech Stack:** Vue 3.5 `<script setup>` (JS, no TypeScript in this repo), Pinia, vue-router 5, Vitest + @vue/test-utils + jsdom, Bun server (`server/src`), Playwright e2e (Vulkan only), Stryker.

**Spec:** `docs/superpowers/specs/2026-10-14-companies-roster-merge-design.md` (read it first; this plan only decides what the spec leaves open).

**Two PRs.** Tasks 1-3 are PR 1 (server only, nothing user-visible). Tasks 4-12 are PR 2 (branch from `main` after PR 1 merges). Stop at the end of Task 3 and wait for Bret.

## Choices this plan makes beyond the spec (Bret to confirm at review)

1. **Dev fixture:** the public fixture is derived at runtime in dev (`rosterFixture.js` calls `publicRoster` on the fixture roster), not written as a second JSON file by `scripts/roster-fixture.mjs`. No second committed file, so no drift test.
2. **Public members carry a local id:** `pub-<rankKey>-<n>`, never a Discord id, so the existing `RosterMember`, `RosterRank`, `RosterBanner` need no change.
3. **Polling stops** when the member load answers 401 or 403 (a signed-in non-Legion visitor must not hit the server every minute on a now-popular public page), and the page falls back to the public view.
4. **Server memoization** keys on the snapshot's `roster` object; the projection function is injectable (`project`) so a test can count calls.
5. **`/roster` route name removed;** only the path redirect remains (nothing links by route name).

## Global Constraints

- Public response keys are exactly: `fetchedAt`, `stale`, `highCommand[].rank{key,label,tier}`, `highCommand[].members[].name`, `branches[].{key,kind,label,number?}`, `branches[].head{rank{key,label,tier},vacant,members[].{name,acting?}}`, `branches[].aside` (a number), `branches[].rows[].{rank{key,label,tier,lateral?},count}`. Anything else is dropped.
- `GET /roster/public`: GET only, never reads `Authorization`, reads `roster.current()` only, `Cache-Control: public, max-age=60` on 200, 503 `{ error: 'The roster is not available yet. Try again.' }` with `no-store` when no roster has loaded.
- The public view fetches once and never polls. Members keep the one-minute poll.
- Styling is scoped CSS on the existing `@theme` tokens. No utility classes, no Tailwind rewrite.
- Keep these hooks stable (tests and e2e select on them): `.rs-branch`, `[data-branch]`, `[data-jump]`, `[data-open]`, `.rs-high-command`, `.rs-find`, `.rs-expand-all`, `.rs-infirmary-toggle`, `.rs-status`, `.rs-head`, `.rs-me`, `.rs-servitors`, `.rs-unassigned`, `.rs-infirmary`.
- In-page ids are the `companies.json` ids plus `high-command` and `muster`.
- The repo is public: synthetic names and ids only (fixture ids start with `9`). No real member names, ids, or avatar URLs in code, tests, docs or commits.
- Run tests with `T="env -u VITE_ROSTER_FIXTURE NODE_OPTIONS=--no-experimental-webstorage npx vitest run"`, then `$T <path>`. The full suite is `bun run test` with the same prefix.
- `server/src/rosterPublic.js` and `rosterPublicHandler.js` join the 100% coverage gate (`vitest.config.js` `GATED`) and the Stryker `mutate` list.
- Per-task commits are local to branch `feat/companies-roster-merge` (Bret's choice of execution method approves them). Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never `--no-verify`. Never push or merge: Bret does. The pre-commit hook runs the whole suite and a leak guard.
- Files with backslashes or long content: use the Write/Edit tools, not heredocs.

## Review Focus

Failure modes the spec implies that no single task's happy path covers. Each has a test in the task named.

1. A branch head with more than two holders (Venerable Dreadnoughts): the public view must still name every holder (Task 6, Task 7).
2. Vacant head with acting heads, and a name containing markup: "Acting" shows instead of "Vacant"; names render as text (Task 1, Task 7).
3. A token that goes bad mid-session (401 on a poll): the page drops to the public view and stops polling (Task 8).
4. The server's first-load 503 for the public fetch: no bars, story intact, no console error (Task 8, Task 10).
5. Infirmary open when a chip or a deep link is used: the page returns to the order first, then jumps (Task 11).

---

## PART A: PR 1, server `GET /roster/public`

### Task 1: Public projection

**Files:**
- Create: `server/src/rosterPublic.js`
- Test: `server/src/rosterPublic.test.js`
- Modify: `vitest.config.js` (add to `GATED`), `stryker.config.mjs` (add to `mutate`)

**Interfaces:**
- Consumes: the `buildRoster` output shape (`server/src/rosterCore.js`): `{ highCommand: [{rank, members}], branches: [{key, kind, label, number?, head:{rank, members, vacant}, aside, rows:[{rank, members}]}], unassigned, servitors }`; `syntheticGuild`, `buildRoster` for tests (`scripts/roster-fixture.mjs`, `server/src/rosterCore.js`).
- Produces: `export function publicRoster(roster): { highCommand, branches }` with exactly the allowlisted shape in Global Constraints (no `fetchedAt`/`stale`; the handler adds those).

- [ ] **Step 1: Write the failing tests** in `rosterPublic.test.js`, building `roster = buildRoster(syntheticGuild(), { guildId: '1' })`:
  - `keeps only allowlisted keys`: deep-walk `publicRoster(roster)`; every key path must be in an explicit allowlist set written in the test.
  - `carries no id, avatar url, role id, company or flag`: `JSON.stringify` the result and assert it contains none of: `cdn.discordapp.com`, `nameMismatch`, `alsoCompanies`, `avatar`, any `L.*` role id string from `rosterLadder.js`, any `/9000000000000000\d\d/` id; and none of the names found in `roster.unassigned.rows`, `roster.servitors`.
  - `names every holder of a head rank and every High Command holder`: for the Venerable Dreadnoughts branch, `head.members.map(m => m.name)` equals the input names, more than two of them if the fixture has more (else build a one-off roster with three).
  - `marks acting heads and vacant posts`: company 2's head members all `acting: true`; company 6 `vacant: true` with `members: []`.
  - `counts aside Dreadnoughts and rank rows without names`: `aside` is a number equal to input `aside.length`; each row is `{ rank, count }` with `count` equal to input `members.length` and no `members` key.
  - `keeps lateral on a lateral rank only` (Terminator row has `rank.lateral === true`; others lack the key).
  - `does not mutate its input`: `structuredClone` before, `toEqual` after.
  - `passes names through as text`: a head named `<b>x</b>` comes out byte-identical (escaping is the view's job).
- [ ] **Step 2: Run** `$T server/src/rosterPublic.test.js`. Expected: FAIL, cannot resolve `./rosterPublic.js`.
- [ ] **Step 3: Implement** `publicRoster(roster)` in `server/src/rosterPublic.js`: map, don't delete (an allowlist builds new objects from named fields, so a future field on the member object cannot ride along). Spread nothing from member or rank objects except the named fields.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Gate it.** Add `'server/src/rosterPublic.js'` to `GATED` in `vitest.config.js` and to `mutate` in `stryker.config.mjs`. Run `npx vitest run --coverage server/src/rosterPublic.test.js` (Expected: 100% for the file) and `npx stryker run --mutate server/src/rosterPublic.js` (Expected: no survivors; add tests until none).
- [ ] **Step 6: Commit** `server/src/rosterPublic.js server/src/rosterPublic.test.js vitest.config.js stryker.config.mjs` with `feat(roster): public projection of the order of battle`.

### Task 2: Public handler

**Files:**
- Create: `server/src/rosterPublicHandler.js`
- Test: `server/src/rosterPublicHandler.test.js`
- Modify: `vitest.config.js`, `stryker.config.mjs` (same two lists)

**Interfaces:**
- Consumes: `publicRoster` (Task 1); a `roster` object with `current(): Promise<{ roster, fetchedAt, stale } | null>` (`server/src/roster.js`).
- Produces: `export function createRosterPublicHandler({ roster, project = publicRoster }): (request: Request, url: URL) => Promise<Response | null>`; returns `null` for anything that is not `GET /roster/public`.

- [ ] **Step 1: Write the failing tests** (set up like `rosterHandler.test.js`: a `setup()` returning `ask(path, method, headers)`):
  - routing: `it.each` of `/roster`, `/roster/infirmary`, `/roster/public/x`, `/roster/publics`, `/builds`, `/` return `null`; `POST`, `PUT`, `DELETE` on `/roster/public` return `null`.
  - `returns the projection with fetchedAt and stale`: status 200, body `toEqual({ fetchedAt: SNAP.fetchedAt, stale: false, ...publicRoster(SNAP.roster) })`, `Content-Type: application/json`, `Cache-Control: public, max-age=60`.
  - `passes stale through`.
  - `ignores an Authorization header`: same 200 body with a header, with a garbage header, and with none.
  - `is 503 and no-store when no roster has loaded`: body `{ error: 'The roster is not available yet. Try again.' }`.
  - `computes the projection once per snapshot`: two requests against the same snapshot object with a counting `project`: count is 1; a new snapshot object: count is 2.
  - `lets a thrown error from current() propagate` (`rejects.toThrow`), matching the member handler's behaviour.
- [ ] **Step 2: Run** `$T server/src/rosterPublicHandler.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `createRosterPublicHandler` in `server/src/rosterPublicHandler.js`; memoize with a `WeakMap` keyed on `snap.roster`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Gate it** exactly as Task 1 step 5 (coverage 100%, no Stryker survivors).
- [ ] **Step 6: Commit** the handler, its test, and the two config files: `feat(roster): unauthenticated GET /roster/public handler`.

### Task 3: Wire, e2e, docs, security review

**Files:**
- Modify: `server/src/index.js` (import `createRosterPublicHandler`; `const rosterPublicRoutes = createRosterPublicHandler({ roster })`; in `fetch`, call it before `rosterRoutes` and return `cors(res)` when non-null)
- Create: `e2e/tests/roster-public.spec.js`
- Modify: `docs/superpowers/specs/2026-10-13-roster-design.md` (Access section: one paragraph pointing to the new spec)

**Interfaces:** Consumes Task 2. Produces the live route.

- [ ] **Step 1: Write the e2e spec** (Playwright `request` fixture, API at `http://api:8787`, no sign-in): `GET /roster/public answers without sign-in` (200; 12 branches; company 3's head contains `E2E Captain`; the body text does not contain `E2E Sergeant`, `E2E Servitor`, `E2E Convalescent`, `100000000000000020`, or `cdn.discordapp.com`); `GET /roster still needs sign-in` (401).
- [ ] **Step 2: Wire `index.js`** as above. Run `$T` (whole suite) and `bun run test:coverage`: green and 100% on gated files.
- [ ] **Step 3: Docs.** Add to the Access section of the 2026-10-13 roster spec: the full roster stays Legion-only; a smaller allowlisted public projection is served at `GET /roster/public` (see the 2026-10-14 spec).
- [ ] **Step 4: Opus security review.** Dispatch one fresh reviewer on the most capable model over `git diff origin/main...HEAD`, brief = the spec's "Privacy and security" and "Server" sections plus Global Constraints; it must try to make the response leak an id, avatar URL, role id, or non-leader name, and try to make the endpoint trigger more than one Discord sweep per TTL. Fix anything it finds with a test first.
- [ ] **Step 5: Commit** (`feat(roster): serve GET /roster/public; e2e and docs`), then **stop**. Tell Bret: push the branch so e2e runs on Vulkan (no local Docker), then after it is green and he merges, check on the live server (the API base is the repo variable `VITE_BUILDS_API_URL`; Bret knows the host) with `curl -s <api>/roster/public` (body has no ids or avatar URLs) and `curl -si <api>/roster` (401). Do not start PART B until PR 1 is merged.

---

## PART B: PR 2, the page merge (branch from `main` after PR 1 merges)

### Task 4: Company keys and data

**Files:**
- Create: `src/lib/companyKeys.js`, `src/lib/companyKeys.test.js`
- Modify: `src/data/companies.json`

**Interfaces:**
- Produces (all pure):
  - `HIGH_COMMAND_ID = 'high-command'`, `MUSTER_ID = 'muster'`
  - `HIGH_COMMAND_ENTRY = { id: 'high-command', sigil: 'HC', title: 'High Command', subtitle: '', keywords: 'high command lord of drakes chapter master pyre guard lord chaplain leadership' }`
  - `articleIdOfBranch(branchKey: string): string | null`: `company-3` → `third`, `forge` → `armoury`, `venerable-dreadnoughts` → `dreadnoughts`, `high-command` → `high-command`, `unassigned` → `muster`, unknown → `null`
  - `branchKeyOfArticle(articleId: string): string | null`: inverse for the roster branches; `high-command` → `high-command`; `muster` → `unassigned`; unknown → `null`
  - `legacyRosterTarget(to: { hash: string, query: object }): { path: '/companies', hash: string, query: object }`: maps a legacy hash through `articleIdOfBranch`; an unknown hash or one containing `=` (the OAuth fragment) gives `hash: ''`; the query is kept.

- [ ] **Step 1: Write the failing tests:** every `companies.json` entry has a unique `branch`; every key in `fixture.roster.branches` (`src/data/roster.fixture.json`) is some entry's `branch`; the mappings above, as a table; `legacyRosterTarget` cases `#company-3` → `#third`, `#forge` → `#armoury`, `#unassigned` → `#muster`, `#nope` → ``, `#access_token=x&y=1` → ``, `` → ``, `?scene=denied` kept; `companies.json` has the Dreadnoughts entry directly after `seventh`.
- [ ] **Step 2: Run** `$T src/lib/companyKeys.test.js`. Expected: FAIL.
- [ ] **Step 3: Data.** Give every existing `companies.json` entry a `"branch"` (`company-1`…`company-7`, `apothecarion`, `librarius`, `forge` for `armoury`, `reclusiam`). Add after `seventh`: `id: "dreadnoughts"`, `sigil: "VD"`, `branch: "venerable-dreadnoughts"`, `title: "The Venerable Dreadnoughts"`, `subtitle: "Entombed veterans of the Legion's oldest wars"`, `keywords: "venerable dreadnoughts dreadnought sarcophagus entombed ancient"`, one section `{ h: "About", p: ["Wounded past the saving of flesh, the Legion's oldest heroes are entombed in the sarcophagi of Dreadnoughts and wake to fight again in its hour of need.", "Their full story is still being written."] }`. Mention in the PR description that this copy is a placeholder for Bret.
- [ ] **Step 4: Implement** `companyKeys.js` (derive the maps from `companies.json` at import; only `high-command` and `muster` are special-cased).
- [ ] **Step 5: Run** the new test and `$T src/views/Companies.test.js`. Expected: PASS (the Companies test reads `companies.length`, so the new entry is covered).
- [ ] **Step 6: Commit** `feat(companies): branch keys, Dreadnoughts entry, legacy hash mapping`.

### Task 5: Redirect and nav

**Files:**
- Modify: `src/router.js` (replace the `/roster` route with `{ path: '/roster', redirect: legacyRosterTarget }`; drop the lazy `Roster.vue` import), `src/lib/useNavLinks.js` (remove the Roster entry), `src/lib/useNavLinks.test.js`, `src/components/SiteFooter.test.js`
- Create: `src/router.test.js` (`// @vitest-environment jsdom`)

**Interfaces:** Consumes `legacyRosterTarget` (Task 4).

- [ ] **Step 1: Write the failing tests:** router: after `await router.push('/roster#company-3')`, `router.currentRoute.value.fullPath` is `/companies#third`; `/roster?scene=denied` keeps its query; `/roster#nope` lands on `/companies`. Nav: the member list is `['Home', 'Perk Builder', 'Armoury', 'Builds', 'Companies', 'Accolades', 'Ranks', 'Reports']` and no link has `to: '/roster'`; footer test: a member does not see Roster. (Update the two existing assertions that expect Roster.)
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement** the router and nav edits. `Roster.vue` still exists until Task 11; nothing imports it from the router any more.
- [ ] **Step 4: Run** the three files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(nav): /roster redirects to /companies; Roster link removed`.

### Task 6: Public client data

**Files:**
- Modify: `src/lib/rosterApi.js` (add `getPublicRoster`), `src/lib/rosterApi.test.js`, `src/lib/rosterFixture.js`, `src/lib/rosterFixture.test.js`
- Create: `src/lib/rosterPublicView.js` + test, `src/stores/rosterPublic.js` + test

**Interfaces:**
- Produces:
  - `getPublicRoster(): Promise<PublicSnapshot>`: `request('/roster/public')` with no token and the default fetch cache.
  - `buildPublicView(snapshot): { banner, branches, openableKeys, fetchedAt, stale }`. `banner` has `buildRosterView`'s shape (`{ hero: {rank, member} | null, court: [{rank, members}] }`). Each branch has `buildRosterView`'s branch fields (`key, kind, label, number, sigil, count, openable, head{rank, vacant, members, shown, more}`) plus `ladder: []`, `shape: [{ s, label, count, lateral?, aside?, heat:{h,hp,hn} }]` (aside row labelled `Honoured Dreadnoughts`), and `extraHeads: { rank, members } | null` (head holders beyond the first two). Every member is `{ id: 'pub-<rankKey>-<n>', name, acting? }`. `openable` is true when `shape` is non-empty. `count` uses `branchOf`'s formula (heads unless vacant, plus aside, plus row counts). Sigils from `SIGILS` in `rosterView.js`; heat from `heatAt`.
  - `useRosterPublic()` Pinia store: state `{ status: 'idle'|'loading'|'ready'|'error', snapshot: null }`, getter `view` (null until ready), action `load(): Promise<void>` (ignores a second call while one is in flight; sets `error` on any failure and keeps nothing).
  - `loadFixture()` result gains a `public` field: the snapshot `publicRoster(scene.roster ?? fixture.roster)` (with `fetchedAt` and `stale` copied from the scene's roster or the fixture's) for every scene except two. Scene `error`: `public` is `null`, and `useRosterPublic().load()` treats `null` as a failure. Scene `loading`: `public` is `undefined`, and `load()` then never resolves.

- [ ] **Step 1: Write failing tests:** `buildPublicView` on `publicRoster(fixture.roster)`: twelve branches; a head with three holders yields `shown` of two, `more` of 1, and `extraHeads.members` of one named; vacant company 6 has `head.vacant` and `openable` per `shape`; acting heads keep `acting`; `shape` rows are in ladder order with counts and no `members`; ids all start `pub-` and match no `/\d{17,20}/`; `openableKeys` lists branches with `shape`; hero is the first High Command rank's first holder. Store: `idle → loading → ready` with `view` set; failure → `error`, `view` null; a second concurrent `load` makes one request. API: `getPublicRoster` sends no `Authorization` header. Fixture: with `VITE_ROSTER_FIXTURE` stubbed, `public` equals the `publicRoster(fixture.roster)` snapshot for `full`, derives from the emptied roster for `empty`, is `null` for `error`, and is `undefined` for `loading`; the store test covers `null` → `error` status and `undefined` → still `loading` after `flushPromises`.
- [ ] **Step 2: Run** the four test files. Expected: FAIL.
- [ ] **Step 3: Implement** the four units. In `rosterFixture.js` import `publicRoster` from `../../server/src/rosterPublic.js` inside the existing dev-only dynamic-import branch so production builds drop it.
- [ ] **Step 4: Run** the four files, then `bun run build` and confirm `server/src/rosterPublic` is absent from `dist` (`grep -rl rosterPublic dist` returns nothing). Expected: PASS and no match.
- [ ] **Step 5: Commit** `feat(roster): public roster client, store and view model`.

### Task 7: Embedded bar and public shape

**Files:**
- Modify: `src/components/roster/RosterBranch.vue`, `src/components/roster/RosterBranch.test.js`
- Create: `src/components/roster/PublicShape.vue`, `src/components/roster/PublicShape.test.js`

**Interfaces:**
- `RosterBranch`: `variant` gains `'embedded'`. Embedded keeps `data-branch`, `data-kind`, `data-jump`, `data-open`, classes `rs-panel surface rs-branch rs-embedded`; it drops the sigil and title column; the toggle button's visible text is `Ranks` with `aria-label` `${branch.label} ranks`; heading level `h3`. The body becomes `<slot name="body">` whose default content is the existing `RosterLadder`.
- `PublicShape` props: `items: Array` (a branch's `shape`), `extraHeads: Object | null`, `branch: Object | null`. Emits `sign-in`. Renders, in order: the extra-heads row (existing `RosterRank`, named chips), one `.rs-shape-row[data-rank]` per item (label and count, heat markers like the ladder's, no chips), and a closing `.rs-shape-signin` line ("Legion member? Sign in with Discord to see everyone") with a `button` that emits `sign-in`.

- [ ] **Step 1: Write failing tests.** `RosterBranch`: embedded renders no `.rs-sigil` and no title text, shows the head chips and count, button text `Ranks` with the aria-label, toggles like a branch (`aria-expanded`, `inert` while shut, `data-open`), and a `body` slot replaces the ladder; the default and `unassigned` variants are unchanged (the existing tests stay as they are). `PublicShape`: rows and counts render in order with no member chips; an `extraHeads` row shows three names; a name containing `<b>x</b>` renders as text (`.html()` contains `&lt;b&gt;`); the sign-in button emits `sign-in`; an empty `items` still renders the sign-in line.
- [ ] **Step 2: Run** both test files. Expected: FAIL.
- [ ] **Step 3: Implement** the variant and the component, with scoped CSS on existing tokens. The embedded bar grid is `minmax(4.5rem, auto) minmax(0, 1fr) 3.6rem` (label, head, tail), stacking the head under the label at the existing 760px breakpoint.
- [ ] **Step 4: Run** `$T src/components/roster`. Expected: PASS for the whole directory (the old roster tests are the regression net).
- [ ] **Step 5: Commit** `feat(roster): embedded ranks bar and public shape body`.

### Task 8: `useCompanyRoster`

**Files:**
- Create: `src/lib/useCompanyRoster.js`, `src/lib/useCompanyRoster.test.js` (jsdom)

**Interfaces:**
- Consumes: `useAuth()` (`token`, `member`), `useRoster()` (member store, `view`, `status`, `load`, `loadInfirmary`), `useRosterPublic()` (Task 6), `useRosterPolling` (`{ load, intervalMs }` → `{ start, stop }`).
- Produces: `useCompanyRoster({ infirmaryOpen }): { mode, loading, view, store, note, updated, stale, start, stop, loadMember }` where `infirmaryOpen` is a `Ref<boolean>`, `mode` is `'full'` when `store.roster` is set, else `'public'` when the public snapshot is ready, else `'none'`; `loading` is true until one of those is decided; `view` is `store.view` or the public view or null; `note` is `''` or `'The live roster is unavailable. Showing the public view.'`; `updated` and `stale` come from the member snapshot (empty/false in public mode); `loadMember()` loads the roster (and the Infirmary when `infirmaryOpen`).

- [ ] **Step 1: Write failing tests** (mock `../stores/auth` and `../lib/rosterApi` like `Roster.test.js` does; fake timers for polling):
  - signed out (no token): only `getPublicRoster` is called; `mode === 'public'`; `getRoster` never called.
  - token + Legion: `mode === 'full'`; `getPublicRoster` never called; polling repeats each 60 s.
  - token + 403: ends `public`; `getRoster` is called once even after 3 minutes (polling stopped) (Review Focus 3).
  - token goes bad on a poll (second `getRoster` rejects 401): switches to `public` and stops.
  - token + 503 on first load with no roster: `public` with `note` set.
  - refresh fails with a roster in hand: stays `full`, no note, store status `error`.
  - sign-out (`auth.member` set to null, `useRoster().reset()`): `public`, `getPublicRoster` called once.
  - public 503: `mode === 'none'`, `loading` false, no throw (Review Focus 4).
  - `stop()` clears the poll and the visibility listener.
- [ ] **Step 2: Run** `$T src/lib/useCompanyRoster.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Decision order on `start()`: no token → public load; token → member load, then public load only if the store ended `signin`, `denied`, or `error` with no roster. A `watch` on `auth.member` repeats the decision on sign-out.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(companies): useCompanyRoster picks the public or full roster`.

### Task 9: `CompanyArticle` extraction (pure refactor)

**Files:**
- Create: `src/components/company/CompanyArticle.vue`, `src/components/company/CompanyArticle.test.js`
- Modify: `src/views/Companies.vue`, `src/views/Companies.test.js`

**Interfaces:**
- `CompanyArticle` props `{ company: Object }` (a `companies.json` entry); emits `index`; slot `ranks` between the header and the story; renders `<article class="company" :id="company.id">`, the header (`.sigil`, `.company-title`, `.company-sub`), a button `.c-top` labelled `↑ Index` that emits `index`, then the story blocks. The story markup, helpers (`bioLength`, `initials`) and every story style move here verbatim, including the wide-screen `.block.surface` scrim rule.

- [ ] **Step 1: Write failing tests** for `CompanyArticle` (renders title, subtitle, a prose block, a list, a notable card; the `ranks` slot renders after the header and before the first `.block`; the `↑ Index` button emits `index`). Change `Companies.test.js` to import `CompanyArticle.vue?raw` for the scrim-rule test (the rule moved).
- [ ] **Step 2: Run** both. Expected: FAIL.
- [ ] **Step 3: Move** the markup and styles; `Companies.vue` keeps header, search, chips, and renders `<CompanyArticle v-for>` (handler for `index` is a stub for now).
- [ ] **Step 4: Run** `$T src/views src/components/company`. Expected: PASS, with the existing Companies tests untouched except the one import.
- [ ] **Step 5: Commit** `refactor(companies): extract CompanyArticle`.

### Task 10: Ranks in the page, both modes

**Files:**
- Create: `src/components/company/CompanyRanks.vue`, `src/components/company/CompanyRanks.test.js`, `src/views/Companies.roster.test.js` (jsdom)
- Modify: `src/views/Companies.vue` (`useOpenBranches` is reused unchanged)

**Interfaces:**
- `CompanyRanks` props `{ branch: Object | null, mode: 'full'|'public'|'none', loading: Boolean, open: Boolean }`; emits `toggle`, `sign-in`. `loading` → a static `.rs-ranks-loading` bar the same height as a collapsed bar; `mode === 'none'` or `branch === null` → renders nothing; otherwise `RosterBranch variant="embedded"` with body `RosterLadder` (full) or `PublicShape` (public, `:items="branch.shape" :extra-heads="branch.extraHeads"`).
- `Companies.vue` loads `CompanyRanks` with `defineAsyncComponent`, composes `useCompanyRoster({ infirmaryOpen })` and `useOpenBranches`, provides `ROSTER_VIEWER` (`auth.member?.id ?? null`), renders the High Command panel (`RosterBanner`, `id="high-command"`) before the chips, a chip for it, and passes each article `<template #ranks><CompanyRanks .../></template>` with `branch` looked up by the entry's `branch` key.

- [ ] **Step 1: Write failing tests.** `CompanyRanks`: placeholder when `loading`; nothing when `none` or no branch; embedded bar with the ladder body in `full`; embedded bar with `PublicShape` in `public`; `toggle` and `sign-in` re-emitted. Page (`Companies.roster.test.js`, mocks as in Task 8): full mode shows 12 `.rs-branch` bars (one per company and specialty), `.rs-high-command` before the chip row, all closed; public mode shows 12 bars whose head text contains a leader's name and whose opened body has `.rs-shape-row` and no member chips beyond heads (no `li.rs-member` inside a body); the public DOM contains no `data-id` matching `/^\d{17,20}$/` and no `<img` avatars; a roster 503 renders the stories and chips with zero `.rs-branch` and no thrown error; the `note` renders in the member-fallback case; search `forge` leaves the Armoury article and hides every other; search `chaplain` keeps High Command; no `.rs-branch` is in the DOM straight after `mount` and all twelve appear after `flushPromises` (the async `CompanyRanks` has resolved).
- [ ] **Step 2: Run** the two files. Expected: FAIL.
- [ ] **Step 3: Implement** `CompanyRanks.vue` and the `Companies.vue` composition. Chips: the High Command chip first (when the panel exists), then one per filtered company in `companies.json` order. Reuse `scrollBehavior()` for chip scrolls; `jumpTo` keeps the `scrollIntoView` button approach.
- [ ] **Step 4: Run** `$T src/views src/components`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(companies): ranks bars and High Command on the Companies page`.

### Task 11: Members' tools, Muster, deep links; retire Roster.vue

**Files:**
- Create: `src/lib/useRosterActions.js`, `src/components/roster/RosterServitors.vue`, `src/components/company/MusterSection.vue`, `src/views/Companies.members.test.js` (jsdom)
- Modify: `src/views/Companies.vue`
- Delete: `src/views/Roster.vue`, `src/views/Roster.test.js`

**Interfaces:**
- `useRosterActions({ root, view, open, infirmaryOpen, viewerId }): { findMessage, jumpToBranch, findMe, toggleAll, toggleInfirmary, applyHash, scrollToArticle }`, moved from `Roster.vue` (`findMe`, `toggleAll`, `flash`, `showOrder`, `jumpTo`, `applyHash`); `jumpToBranch(key)` keeps the old `jumpTo(key)` behaviour (open without animation via `openNow`, scroll the `[data-jump]` element to centre, flash it); `scrollToArticle(id)` is the chips' scroll; `applyHash()` reads `useOpenBranches().hashKey()`, treats it as an article id, scrolls to it on mount, opens its bar (via `branchKeyOfArticle`) once data arrives, and ignores `=`, unknown, and non-openable keys.
- `MusterSection` props `{ unassigned: Object | null, servitors: Array, open: Boolean }`; emits `toggle`; renders `id="muster"`, an `Unassigned` `RosterBranch variant="unassigned"` and `RosterServitors`.
- In full mode `Companies.vue` also renders, in order: dev scene links (dev fixture only), the member notices (`rs-note`), `RosterStatus` (toolbar), the chips (with a `Muster` chip), then either `RosterInfirmary` (when open, hiding the High Command panel, the articles and Muster) or the order; the `↑ Index` handler scrolls to `#company-index` (the chip `<nav>`, `tabindex="-1"`) and focuses it; Muster hides while the search query is non-empty.

- [ ] **Step 1: Port the tests first.** Create `Companies.members.test.js` from `Roster.test.js`: keep every case that still applies by mounting `Companies` (twelve `.rs-branch`; vacant/acting/aside/tag; `Check name`; Infirmary button for command only; Infirmary swap and back; Find me (own chip, not on the roll, High Command only → scrolls `.rs-high-command`); Expand all/Collapse all; status link opens its branch; scroll behaviour under reduced motion; branches stay open across snapshots; a branch that stops being openable; empty roster; unmount cleanup; no overlapping requests; the hook-attribute tests; the dev scene switcher). Change what the move changes: `#company-3` becomes `#third` and `/companies` is the pushed path; `#venerable-dreadnoughts` becomes `#dreadnoughts` (nothing to open); add: `Muster` chip and section only in full mode; Infirmary open then a chip click returns to the order before scrolling (Review Focus 5); `↑ Index` scrolls to and focuses the chip nav; search hides Muster; a signed-in 403 shows the public view with no toolbar and no Muster. Drop only the three cases the spec replaced (the signed-out prompt page, the refusal page, the bare error page), whose behaviour is now covered in Tasks 8 and 10.
- [ ] **Step 2: Run** `$T src/views/Companies.members.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the composable, the two small components, and the `Companies.vue` additions; move `.rs-servitors` styles into `RosterServitors.vue`; the dev scene `<nav>` and the `rs-note` styles come with them.
- [ ] **Step 4: Delete** `Roster.vue` and `Roster.test.js`; `grep -rn "views/Roster" src e2e` must return nothing. Run the whole suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(companies): members' tools and Muster; retire the Roster page`.

### Task 12: e2e, visual verification, docs

**Files:**
- Modify: `e2e/tests/roster.spec.js` (re-point every `page.goto('/roster...')` to `/companies...`; the heading assertion becomes the Companies heading; `#company-3` becomes `#third`; the denied case asserts the public view (bars present, no `Expand all`)), `docs/superpowers/specs/2026-10-14-companies-roster-merge-design.md` (status line)
- Create: `e2e/tests/companies-public.spec.js` (signed out: 12 `.rs-branch` bars, company 3's head shows `E2E Captain`, opening it shows rank rows and no `E2E Sergeant`, the page source has no `100000000000000020`)

- [ ] **Step 1: Update and add the e2e specs** as above (Vulkan only; ask Bret to push the branch).
- [ ] **Step 2: Visual verification** in Chrome with `VITE_ROSTER_FIXTURE=1 bun run dev` (port 5174 if 5173 is taken): scenes `full` (member view) and `signin` (public view), at about 1400 px and 390 px. Check and record: an opened ladder at the 60rem column (spec risk 1; fall back to widening the article container if it is cramped); the Ranks bar over the volcano (risk 2); no console errors; High Command, chips, `↑ Index`, Muster, Infirmary swap, `/roster#company-3` redirecting to `#third`. Close the browser tab afterwards.
- [ ] **Step 3: Build check:** `bun run build`; the Companies chunk must not contain `RosterLadder` or `rosterView` code (the ranks chunk is separate: compare chunk file names in `dist/assets`).
- [ ] **Step 4: Full gates:** `bun run test`, `bun run test:coverage`, `bun run test:mutation` all green (the pre-push hook runs these).
- [ ] **Step 5: Update** the spec's status line to "implemented" with the PR numbers, and the memory note.
- [ ] **Step 6: Commit** `test(e2e): Companies public and member specs`, then a final fresh review on the most capable model over `git diff origin/main...HEAD` before Bret merges.
