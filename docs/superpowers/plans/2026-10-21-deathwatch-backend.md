# Deathwatch Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Deathwatch API to the builds server: a live Discord access verdict, the document store, grants, audit rows and the six endpoints the front end will call.

**Architecture:** Same shape as the reports feature. A handler (`createDeathwatchHandler`) is chained into `server/src/index.js`; it asks an access module for a verdict (Discord identity and roles via `discordRoles.js`, plus the grants table) and talks to a Postgres store. Pure parts (body validation, ETags, the verdict and its cache, the handler) are unit-tested here with a fake Discord and an in-memory store and join the 100% coverage and mutation gate. The SQL store is tested against a recording fake pool here and against real Postgres only on Vulkan.

**Tech Stack:** Bun server, `pg`, Vitest, Stryker, Playwright (API-level, in `e2e/`).

**Spec:** `docs/superpowers/specs/2026-10-20-deathwatch-design.md`, section "Backend (`server/`)" and the rows for chunk 3.

**Not in this plan:** the front-end data store and polling (chunk 4; note for it: a 304 reaches `fetch` as a non-ok response, so `buildsApi.request` needs a 304 branch), the Manage UI (chunk 5), the browser-level e2e the spec lists (gate states, banner flow, a Commander write through the UI; they need the views from chunks 4 and 5), the one-time data import and cutover (chunk 8), real role ids (Bret supplies them in `server/.env` at deploy).

**Branch.** `feat/dw-backend` from `feat/deathwatch`, in its own worktree (`superpowers:using-git-worktrees`) → PR into `feat/deathwatch`. Read this plan from the `feat/deathwatch` checkout. It touches only `server/**`, `e2e/**`, `vitest.config.js` and `stryker.config.mjs`; the last two will conflict trivially with #19 (both append to the gated lists), keep both sets of lines. Push after Task 3.7 (Vulkan needs the branch) and once more after Task 3.8; the pre-push gate takes ~7 min and tests must not run while it does. Backend e2e runs on Vulkan only; ask Bret before using it.

## Global Constraints

- Limits, verbatim from the spec: collections `teams`, `cfg`, `archive`; id matches `^[A-Za-z0-9_-]{1,64}$`; a document is a JSON object of at most 1 MB; a request body is at most 2 MB; `discordId` matches `^\d{17,20}$`; at most 200 active grants. Same CORS origin rule as the other routes.
- Access = Watch Commander role **or** Deathwatch role **or** an active grant. Watch Commander status comes only from the Discord role, never from a grant. Env names `DEATHWATCH_ROLE_ID` and `WATCH_COMMANDER_ROLE_ID`, **no defaults in code**; if either is not a snowflake the whole area answers 503.
- Discord is asked live. Reads (`/me`, `/data`) may use a verdict cache of 30 seconds keyed by a hash of the token. Writes and grant changes never use it. Any Discord failure (`Upstream`) is 503; fail closed.
- Authentication is a bearer header, not a cookie. Every response carries `Cache-Control: no-store`.
- History rows and grant events are written in the same transaction as the change they record.
- No member names, Discord user ids, role ids or passwords in any committed file or test. Tests and the e2e mock use invented 18-digit ids.
- Commands: tests `NODE_OPTIONS=--no-experimental-webstorage node_modules/.bin/vitest run <file>`; full suite `NODE_OPTIONS=--no-experimental-webstorage bun run test`; mutation `node_modules/.bin/stryker run` (never `npx stryker`). The commit hook runs the whole suite.
- Match the server's style: `createX({ ...deps })` factories, injected `now`/`fetchImpl`, `reply(status, body)` helpers, a file header that says what the unit guarantees. Commit with explicit paths (never `git add -A`) and end each message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- A document id of `__proto__` or `constructor` must be stored and served back as an ordinary own key, not set a prototype or vanish. Pinned in Tasks 3.4 and 3.5.
- Document text containing U+0000 or a lone surrogate (Postgres `jsonb` rejects both) must answer 400, never a 500. Pinned in Tasks 3.2 and 3.5.
- A caller without access who sends a valid `If-None-Match` must get 403, never 304; a stale tag after a write must get 200. Pinned in Task 3.5.
- A revoked grant must stop working at once (the verdict cache is dropped), and a Commander demoted in Discord must be refused on a write while a cached read still says commander. Pinned in Tasks 3.3 and 3.5.
- A granted user who is **not in the guild** has access, and a non-granted user who is not in the guild gets `{ access: false }` with status 200 from `/me`, not an error. Pinned in Tasks 3.3 and 3.5.

## File map

| File | Responsibility |
| --- | --- |
| `server/src/cors.js` (+test, gated) | `applyCors`: origin, methods, request headers, exposed `ETag` |
| `server/src/deathwatchValidate.js` (+test, gated) | Limits; parse and validate a document write and a grant body |
| `server/src/deathwatchEtag.js` (+test, gated) | `etagOf`, `ifNoneMatches` |
| `server/src/deathwatchAccess.js` (+test, gated) | The access verdict and its 30 s cache |
| `server/src/deathwatchStore.js` (+test), `server/schema.sql` | Postgres side: documents, history, grants, grant events |
| `server/src/deathwatchHandler.js` (+test, gated) | The six routes |
| `server/src/index.js`, `server/docker-compose.yml`, `server/.env.example`, `server/README.md`, `vitest.config.js`, `stryker.config.mjs` | Wiring and docs |
| `e2e/discord-mock/server.js`, `e2e/docker-compose.yml`, `e2e/tests/deathwatch-api.spec.js` | API-level e2e (Vulkan) |

---

### Task 3.1: CORS helper that exposes the ETag

**Files:** Create `server/src/cors.js`, `server/src/cors.test.js`; Modify `server/src/index.js` (the `cors` function).

**Interfaces:** Produces `applyCors(res: Response, origin: string): Response`, which sets the headers on `res` and returns the same object. Later tasks rely on `index.js` using it so the browser may send `If-None-Match` and read `ETag`.

- [ ] **Step 1: Failing tests** in `cors.test.js`:
  - `allows the configured origin`: `Access-Control-Allow-Origin` equals the origin passed.
  - `allows the methods the API uses`: `Access-Control-Allow-Methods` is `GET, POST, DELETE, OPTIONS`.
  - `allows the headers the client sends`: `Access-Control-Allow-Headers` is `Content-Type, Authorization, If-None-Match`.
  - `lets the page read the ETag`: `Access-Control-Expose-Headers` is `ETag`.
  - `returns the response it was given`: `applyCors(res, o) === res`.
- [ ] **Step 2:** Run the file → FAIL (module missing).
- [ ] **Step 3: Implement** `applyCors` in `cors.js`; in `index.js` import it and make `cors(res)` return `applyCors(res, ALLOWED_ORIGIN)`.
- [ ] **Step 4:** Run the file → PASS.
- [ ] **Step 5: Commit** `server/src/cors.js server/src/cors.test.js server/src/index.js` (`feat(server): CORS helper that allows If-None-Match and exposes ETag`).

### Task 3.2: Pure helpers: write validation and ETag matching

**Files:** Create `server/src/deathwatchValidate.js`, `server/src/deathwatchEtag.js` and a `.test.js` for each.

**Interfaces:** Produces, from `deathwatchValidate.js`:
`COLLECTIONS = ['teams', 'cfg', 'archive']`, `MAX_DOC_BYTES = 1048576`, `MAX_BODY_BYTES = 2097152`, `MAX_ACTIVE_GRANTS = 200`,
`isDiscordId(v: unknown): boolean`,
`parseDocWrite(b: unknown): { col, id, op: 'set' | 'delete', doc: object | null } | string`,
`parseGrantBody(b: unknown): { discordId: string } | string`
(a string return is the error message, like `validate` in `reports.js`). From `deathwatchEtag.js`:
`etagOf(text: string): string`, `ifNoneMatches(header: string | null, etag: string): boolean`.

- [ ] **Step 1: Failing tests, `deathwatchValidate.test.js`:**
  - `accepts a set for each collection` and returns `{ col, id, op: 'set', doc }`; `accepts a delete without a doc` and returns `doc: null` (a supplied doc is ignored).
  - `rejects a body that is not an object`: `null`, an array, a string, a number.
  - `rejects an unknown collection`: `'users'`, `'__proto__'`, `'constructor'`, a non-string.
  - `rejects a bad id`: empty, 65 characters, `'a b'`, `'../x'`, a number. `accepts` 64 characters, `'__proto__'`, `'a-b_C9'`.
  - `rejects an unknown op`; `rejects a set whose doc is missing, null, an array or a string`.
  - `enforces the document size in bytes`: a doc whose JSON is exactly `MAX_DOC_BYTES` bytes is accepted, one byte more is rejected; a doc of `'€'` characters under `MAX_DOC_BYTES` characters but over it in bytes is rejected.
  - `rejects what jsonb cannot store`: U+0000 in a value and in a key; a lone high and a lone low surrogate in a value and in a key. `accepts` a valid surrogate pair (an emoji).
  - `parseGrantBody accepts 17 to 20 digits` and ignores extra fields; `rejects` 16 digits, 21 digits, non-digits, padded whitespace, a number, a missing field. `isDiscordId` agrees.
- [ ] **Step 2: Failing tests, `deathwatchEtag.test.js`:** `etagOf` is a quoted 32-character lowercase hex string, equal for equal text and different for different text; `ifNoneMatches` is true for the exact tag, for the weak form `W/"…"`, for the tag inside a comma list with other tags, and for `*`; false for `null`, an empty string, another tag, and the tag without its quotes.
- [ ] **Step 3:** Run both files → FAIL.
- [ ] **Step 4: Implement.** `parseDocWrite` serialises the doc once with a `JSON.stringify` replacer that flags any key or string value containing U+0000 or failing `String.prototype.isWellFormed()`, then measures that JSON with `TextEncoder`; ids and collections are checked with the spec regex and `COLLECTIONS.includes`. `etagOf` is the first 32 hex characters of SHA-256 (`node:crypto`) wrapped in double quotes.
- [ ] **Step 5:** Run both → PASS. **Step 6: Commit** the four files (`feat(deathwatch-api): write validation and ETag helpers`).

### Task 3.3: The access verdict and its cache

**Files:** Create `server/src/deathwatchAccess.js`, `server/src/deathwatchAccess.test.js`.

**Interfaces:** Consumes `roles.identify(request)` and `roles.rolesOf(userId)` (`discordRoles.js`; `Upstream` propagates) and `store.isGranted(discordId): Promise<boolean>`. Produces
`createDeathwatchAccess({ roles, store, deathwatchRoleId, commanderRoleId, ttlMs = 30_000, maxEntries = 1000, now = Date.now })` returning
`{ configured: boolean, resolve(request, { fresh = false } = {}): Promise<null | { user: { id, username }, access: boolean, watchCommander: boolean }>, forget(): void }`.
`null` means no valid Discord identity (401). `configured` is true only when both role ids match `^\d{17,20}$`.

- [ ] **Step 1: Failing tests** (fake `roles` keyed by bearer token like `reports.test.js`; fake `store`; a controllable `now`; invented ids):
  - `configured`: false for undefined, `''`, `'abc'`, a 16-digit id, either one missing; true for two valid ids.
  - `each access combination`: Commander role → `{ access: true, watchCommander: true }`; Deathwatch role → access only; both roles; grant only → access, **not** watchCommander; a Legion-only role → neither; no roles → neither.
  - `a user who is not in the guild` (`rolesOf` → `null`): with a grant → access; without → `{ access: false, watchCommander: false }`.
  - `does not touch the grants table for a role holder` (`isGranted` not called).
  - `returns null` for no Authorization header and for an unknown token; neither is cached.
  - `Upstream fails closed`: `identify` or `rolesOf` throwing `Upstream` rejects with it, even for a granted user, and nothing is cached.
  - `caches a verdict for ttlMs`: two `resolve` calls inside the window make one `identify` and one `rolesOf`; one ms past the window looks up again.
  - `keys the cache by token`: two tokens, and two tokens differing in the last character, each get their own lookup.
  - `fresh bypasses the cache and does not write to it`.
  - `forget drops every cached verdict`.
  - `is bounded`: with `maxEntries: 2`, a third token evicts the oldest.
- [ ] **Step 2:** Run → FAIL. **Step 3: Implement.** Cache key is the SHA-256 hex of the whole `Authorization` header (`node:crypto`) in a `Map` of `{ verdict, until }`; evict the first key when full. Verdict order: `identify` → `rolesOf` (`null` → `[]`) → Commander → Deathwatch role → `store.isGranted`.
- [ ] **Step 4:** Run → PASS. **Step 5: Commit** (`feat(deathwatch-api): live access verdict with a short cache`).

### Task 3.4: Postgres store and schema

**Files:** Modify `server/schema.sql`; Create `server/src/deathwatchStore.js`, `server/src/deathwatchStore.test.js`.

**Interfaces:** Consumes `MAX_ACTIVE_GRANTS` from `deathwatchValidate.js` and a `pg` `Pool`. Produces
`createDeathwatchStore(pool)` returning
`readAll(): Promise<{ teams, cfg, archive }>` (each an id → document map, all three always present),
`writeDoc({ col, id, op, doc }, actor: { id }): Promise<{ changed: boolean }>`,
`isGranted(discordId): Promise<boolean>`,
`listGrants(): Promise<Array<{ discordId, grantedBy, grantedAt }>>`,
`grant(discordId, actor): Promise<'granted' | 'exists' | 'limit'>`,
`revoke(discordId, actor): Promise<'revoked' | 'none'>`.

- [ ] **Step 1: Append the DDL** to `schema.sql` (idempotent, like the existing tables):

```sql
-- Deathwatch area (docs/superpowers/specs/2026-10-20-deathwatch-design.md).
-- Only deathwatch_docs rows are ever deleted; the history table keeps what was removed.
create table if not exists deathwatch_docs (
  col         text not null check (col in ('teams', 'cfg', 'archive')),
  id          text not null check (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  doc         jsonb not null check (jsonb_typeof(doc) = 'object'),
  updated_at  timestamptz not null default now(),
  updated_by  text not null,
  primary key (col, id)
);

create table if not exists deathwatch_doc_history (
  id                bigserial primary key,
  col               text not null,
  doc_id            text not null,
  op                text not null check (op in ('set', 'delete')),
  doc               jsonb not null, -- as written; for a delete, the document that was removed
  actor_discord_id  text not null,
  created_at        timestamptz not null default now()
);
create index if not exists deathwatch_doc_history_doc_idx on deathwatch_doc_history (col, doc_id, id desc);

create table if not exists deathwatch_grants (
  discord_id  text primary key check (discord_id ~ '^\d{17,20}$'),
  granted_by  text not null,
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  revoked_by  text
);

create table if not exists deathwatch_grant_events (
  id                bigserial primary key,
  discord_id        text not null,
  actor_discord_id  text not null,
  action            text not null check (action in ('granted', 'revoked')),
  created_at        timestamptz not null default now()
);
```

- [ ] **Step 2: Failing tests** in `deathwatchStore.test.js` with a recording fake pool (`connect()` returns a client whose `query(sql, params)` logs the call and answers from a script matched on SQL substrings; `release` is spied). Assert on the order of statements and the parameters, not on SQL wording beyond the key phrases:
  - `readAll returns the three collections, empty ones present`.
  - `readAll keeps ids like __proto__ and constructor as own keys`: the map's prototype is still `Object.prototype`, `Object.keys` includes the id, and `JSON.stringify` round-trips it.
  - `writeDoc set upserts and records history in one transaction`: `begin`, upsert, history insert (params carry col, id, op `set`, the document, `actor.id`), `commit`.
  - `writeDoc set of an identical document records no history` (the upsert returns no row → `changed: false`).
  - `writeDoc delete removes the row and records the removed document` (`delete … returning doc`; history op `delete`); `delete of a missing document` returns `changed: false` and writes no history.
  - `a failure rolls back, releases the client and rethrows`.
  - `isGranted` queries for `revoked_at is null` with the id; `listGrants` returns only active grants, camelCased.
  - `grant`: takes `pg_advisory_xact_lock` first; a new id → `'granted'` with an upsert (that clears `revoked_at` and `revoked_by`) and a `granted` event; an active id → `'exists'` and no event; 200 active → `'limit'` and no insert.
  - `revoke`: an active id → `'revoked'` with a `revoked` event; none → `'none'` and no event.
- [ ] **Step 3:** Run → FAIL. **Step 4: Implement** with the same `inTx` shape as `reportsStore.js` (copy it; do not refactor the other stores). Upsert is `insert … on conflict (col, id) do update … where deathwatch_docs.doc is distinct from excluded.doc returning 1`; the document goes in as `JSON.stringify(doc)` with `$n::jsonb`; `readAll` selects `order by col, id` and builds each map with `Object.fromEntries`; the advisory lock key is any fixed bigint constant.
- [ ] **Step 5:** Run → PASS. **Step 6: Commit** `server/schema.sql server/src/deathwatchStore.js server/src/deathwatchStore.test.js` (`feat(deathwatch-api): document, history and grant store`). The SQL itself is proven on Vulkan in Task 3.8.

### Task 3.5: The handler

**Files:** Create `server/src/deathwatchHandler.js`, `server/src/deathwatchHandler.test.js`.

**Interfaces:** Consumes the access object (Task 3.3), the store (Task 3.4) and the helpers (Task 3.2). Produces `createDeathwatchHandler({ access, store })` returning `async (request: Request, url: URL) => Response | null` (`null` for any path outside `/deathwatch`), chained in `index.js` like `createReportsHandler`.

Routes and statuses (the common prefix: `!access.configured` → 503 `{ error: 'The Deathwatch area is not configured.' }`; `resolve` → `null` → 401 `{ error: 'Sign in with Discord.' }`; `Upstream` → 503 `{ error: 'Discord could not be reached. Try again.' }`; any other error is rethrown; an unknown path or method under the prefix → 404 `{ error: 'Not found.' }`):

| Route | Verdict | Behaviour |
| --- | --- | --- |
| `GET /deathwatch/me` | cached | 200 `{ access, watchCommander }`; never 403 |
| `GET /deathwatch/data` | cached | no access → 403, store not read; else `store.readAll()` serialised once, `ETag` header, 304 with no body when `ifNoneMatches` |
| `POST /deathwatch/doc` | **fresh**, Commander only (403) | `Content-Type` not JSON → 415; body over `MAX_BODY_BYTES` → 413; unparseable → 400; `parseDocWrite` error → 400 with its message; 200 `{ ok: true, changed }` |
| `GET /deathwatch/grants` | **fresh**, Commander only | 200 `{ grants }` |
| `POST /deathwatch/grants` | **fresh**, Commander only | same 415/413/400 rules; `parseGrantBody`; `'granted'` → 201, `'exists'` → 200, both `{ discordId }`; `'limit'` → 409; then `access.forget()` |
| `DELETE /deathwatch/grants/:discordId` | **fresh**, Commander only | not `isDiscordId` → 400; `'revoked'` → 200 `{ discordId }`, `'none'` → 404; then `access.forget()` |

- [ ] **Step 1: Failing tests.** Build `setup()` like `reports.test.js`: the **real** `createDeathwatchAccess` over a fake Discord (token → invented user and roles; spies on `identify` and `rolesOf`), an in-memory store with the Task 3.4 contract (including history rows), a `call(who, method, path, body, headers)` helper returning `{ status, body, headers }`. Users: a Commander, a Deathwatch member, a granted user not in the guild, a user with no roles, a Legion-only user. Tests:
  - `ignores paths outside /deathwatch`, including `/deathwatchx`; `404 for unknown paths and methods`.
  - `503 for every route when not configured`, and Discord is never called; `401` without a token and with an unknown one on every route; `503 on Upstream` on every route; a non-Upstream error propagates.
  - `/me` for each user in the table above (including the not-in-guild granted user: access true, Commander false; the not-in-guild user without a grant: 200 with both false); every response has `Cache-Control: no-store`.
  - `/data`: 403 without access and the store is not read; 200 with the three maps and an `ETag`; the same data gives the same tag; a matching `If-None-Match` → 304 with the tag and an empty body; a weak-form match → 304; a mismatch → 200; **a user without access that sends the current tag gets 403**; after a Commander write the old tag gets 200 with a new tag.
  - `reads use the cached verdict`: two `/data` calls make one `rolesOf`.
  - `POST /doc`: 401; 403 for a Deathwatch member who is not Commander; 415 for `text/plain` and for no content type; 413 for a body of `MAX_BODY_BYTES + 1` bytes; 400 for malformed JSON and for each invalid-field case (collection, id, op, missing doc, NUL in a value); set then delete round-trip through `/data`; the history actor is the caller and a forged `actor` field in the body is ignored; an identical set returns `changed: false`; **id `__proto__` is stored and returned by `/data` as an own key**.
  - `a write is checked live`: the Commander's token is cached by a `/me` call, Discord then drops their role, `POST /doc` → 403 while `/me` (still cached) says commander.
  - `grants`: list is Commander-only; create returns 201 and a repeat 200; a bad id → 400; the 201st active grant → 409; a Deathwatch member cannot grant; a revoke of an unknown id → 404; revoking a bad id → 400; `a revoked grant stops working at once`: the granted user reads `/data` (200, verdict cached), the Commander revokes, the next `/data` is 403; `a new grant works at once`: a denied user (cached as denied) is granted and reads `/data` with 200.
- [ ] **Step 2:** Run → FAIL. **Step 3: Implement** with a local `reply(status, body)` that sets `Content-Type: application/json` and `Cache-Control: no-store`; read the body once with `request.text()` and measure bytes with `TextEncoder`; a 304 is `new Response(null, { status: 304, headers })` with the `ETag`.
- [ ] **Step 4:** Run → PASS. **Step 5: Commit** (`feat(deathwatch-api): the six routes`).

### Task 3.6: Wire it in and document it

**Files:** Modify `server/src/index.js`, `server/docker-compose.yml`, `server/.env.example`, `server/README.md`.

- [ ] **Step 1: `index.js`.** Create the store and access (`deathwatchRoleId: process.env.DEATHWATCH_ROLE_ID`, `commanderRoleId: process.env.WATCH_COMMANDER_ROLE_ID`, `roles` as already built), build the handler, and call it in the `fetch` chain beside `reports` and `perks` (`if (res) return cors(res)`). Add `maxRequestBodySize: 4 * 1024 * 1024` to `Bun.serve` so an oversized or chunked body is refused by the server before the handler reads it; a comment says why.
- [ ] **Step 2:** `docker-compose.yml` passes `DEATHWATCH_ROLE_ID: ${DEATHWATCH_ROLE_ID:-}` and `WATCH_COMMANDER_ROLE_ID: ${WATCH_COMMANDER_ROLE_ID:-}` with a comment that the area answers 503 until both are set; `.env.example` lists both with the same note and no values.
- [ ] **Step 3:** `README.md` gets a "Deathwatch (`/deathwatch/*`)" section: the endpoint table from Task 3.5, who may call each, the two env vars, the fail-closed 503, the 30 s read cache and which calls bypass it, the limits, and the idempotent schema command from the existing sections (apply it before starting the new image). It states that the one-time data import belongs to a later chunk.
- [ ] **Step 4:** Run the full suite → PASS (no test covers `index.js`; Task 3.8 exercises it). **Step 5: Commit** the four files (`feat(deathwatch-api): wire the handler, env and docs`).

### Task 3.7: Put the security-critical units under the gate

**Files:** Modify `vitest.config.js` (`GATED`), `stryker.config.mjs` (`mutate`).

- [ ] **Step 1:** Add `server/src/cors.js`, `deathwatchEtag.js`, `deathwatchValidate.js`, `deathwatchAccess.js` and `deathwatchHandler.js` (full paths) to both lists. The store is not gated: its SQL cannot be mutation-tested without Postgres.
- [ ] **Step 2:** Run `NODE_OPTIONS=--no-experimental-webstorage bun run test:coverage`. Every new file must report 100% lines, branches, functions and statements; add a test for each gap.
- [ ] **Step 3:** Run `node_modules/.bin/stryker run` (several minutes; nothing else running). Kill each survivor with a test. Only for a mutant that cannot change behaviour, add `// Stryker disable next-line <Mutator>: <why it is equivalent>` in the style already used in `archiveKey.js`; the reason must be specific.
- [ ] **Step 4:** Full suite → PASS. **Step 5: Commit** the config files and any new tests (`test(deathwatch-api): coverage and mutation gate for the access units`). **Step 6:** Push `feat/dw-backend` once (the pre-push gate runs the suite, coverage and mutation).

### Task 3.8: API-level end to end (runs on Vulkan, with Bret)

**Files:** Modify `e2e/discord-mock/server.js`, `e2e/docker-compose.yml`; Create `e2e/tests/deathwatch-api.spec.js`.

**Interfaces:** The mock gains three tokens: `test-deathwatch-token`, `test-commander-token`, `test-granted-token`, with invented ids in the `2000000000000000xx` range and two invented role ids for the Deathwatch and Commander roles. The first two are guild members holding those roles; the third is **absent from the guild** (the mock's member lookup answers 404). Keep these members in a separate map used only by the single-member lookup, **not** in `MEMBERS`, so the roster and public-roster specs' counts are unchanged. The `api` service gets the same two role ids as `DEATHWATCH_ROLE_ID` and `WATCH_COMMANDER_ROLE_ID`.

- [ ] **Step 1: Spec** `deathwatch-api.spec.js` using Playwright's `request` fixture against `const API = process.env.API_URL || 'http://api:8787'` (as `perks.spec.js` does), serial:
  - `/me`: no token → 401; Deathwatch holder → `{ access: true, watchCommander: false }`; Commander → both true; `test-member-token` (Legion only) and `test-norole-token` → both false.
  - `/data`: Legion-only → 403; Deathwatch holder → 200 with `teams`, `cfg`, `archive`.
  - Writes: Deathwatch holder `POST /doc` → 403; Commander `set` of `teams/alpha` → 200; `/data` now contains it; the old `ETag` with `If-None-Match` → 200 and a new tag; the new tag → 304; Commander `delete` → 200 and it is gone; a body over 2 MB → 413.
  - Grants: the granted token is denied (`/data` 403); the Commander grants it (201); it now reads `/data` (200); the Commander revokes (200); it is denied again at once. A Deathwatch holder cannot list grants (403).
  - CORS: an `OPTIONS /deathwatch/data` preflight from the site origin allows `If-None-Match`; a `GET /deathwatch/data` response exposes `ETag`.
- [ ] **Step 2: Mock and compose changes** as described under Interfaces.
- [ ] **Step 3: Run on Vulkan.** Ask Bret before using it. The branch is already pushed from Task 3.7; run `bun run test:e2e` there. Expected: all specs pass, including the existing ones (this proves `schema.sql`, the real SQL in the store, `index.js` and the CORS headers). Fix and re-run until green; any code fix goes back through the unit tests first.
- [ ] **Step 4: Commit** the three files, push, and open the PR into `feat/deathwatch`. The PR description lists what Bret owes before deploy: the two role ids in `server/.env`, applying `schema.sql`, restarting the API, and a manual check that the area stays 503 until both ids are set.
