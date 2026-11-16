# Librarius, batch 1 (Discord → site, read-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Librarius forum is readable on the site, under its first Reliquarium tab, for exactly the people
Discord lets read it. Its full history is imported, kept live over the gateway, and shown as a topic list and
one page per post.

**Architecture:** New `server/src/librarius*.js` modules inside the existing Bun API. These are a hand-written
gateway client over Bun's WebSocket, a rate-limited REST reader, a one-time import with catch-up, a Postgres
store, Discord's permission rules computed per member, and read-only routes. On the site there are a Pinia
store, a topic list, a post page that reuses the Legion Archive's markdown parser and renderer, and the
Reliquarium gate and nav changes. Batch 1 also adds a site-wide Content-Security-Policy, and publishes the API
port on localhost only.

**Tech Stack:** Bun 1.4.4, Postgres 16, Vue 3 + Pinia + vue-router, Vitest 4 + fast-check + @vue/test-utils,
Stryker 9, Playwright (docker e2e).

**Spec:** `docs/superpowers/specs/2026-11-15-librarius-design.md` (approved, commits 2212335 and 9e9eb52).
Batch 1 = the spec's "Rollout, in three batches" item 1. Batches 2 and 3 get their own plans, after this
ships and after batch 2's check of Components V2 in the guild.

## Global Constraints

- **No new dependencies.** The server keeps `pg` as its only package. The site adds none. Bun's built-in
  `WebSocket` is the gateway client.
- **No live Discord data in git:** no member names, post titles, tag names, rule names or the channel id.
  Tests, fixtures, the mock and docs use invented names and ids in the `200000000000000400`–`499` range.
  The real channel id lives only in `server/.env` as `LIBRARIUS_CHANNEL_ID`.
- **Discord REST:** `${DISCORD_API_BASE}/v10/...`. `DISCORD_API_BASE` defaults to `https://discord.com/api`,
  and e2e points it at the mock.
- **Ids are strings in JavaScript**, never `Number`. A snowflake matches `/^\d{17,20}$/`. Postgres holds them
  as `bigint`, and `pg` hands `bigint` back as a string.
- **Never log or return a token, or a signed CDN link in error text.** Strip `https?://\S*` the way
  `galleryPoll.js` `describe()` does.
- **Every `/librarius` route answers through `httpReply.reply` (no-store) and fails closed.** Discord
  unreachable (`Upstream`) is 503; no identity is 401; no read permission is 403; unconfigured is 503.
- **No `v-html`, `innerHTML`, `outerHTML` or `insertAdjacentHTML`** anywhere in the Librarius area. A guard test
  enforces it (Task 17).
- **The gate:** every new module named "gated" below goes into **both** `stryker.config.mjs` `mutate` and
  `vitest.config.js` `GATED`, at 100% coverage and 100% mutation.
  - Use the **adversarial-tdd** skill for each: property tests (fast-check) plus hostile-input batteries.
  - Assert behaviour: return values, the SQL and params a fake pool received, what a fake fetch or socket
    received. Never assert logs.
  - Build test values inside `it`, not in `describe`, or Stryker reports false survivors.
  - For scoped mutation runs mid-task, use a temporary `stryker.scoped.config.mjs` that spreads the base and
    sets `mutate: [file]` and `thresholds: { high: 100, low: 0, break: null }`. Delete it after.
  - Don't run two Stryker runs in one checkout at once.
- **Copy:** plain English in user-facing strings, matching the Reliquarium's voice ("The Librarius couldn't be
  reached.").
- **Commits:** one per task, `feat(librarius): …` / `test(librarius): …`, ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push. The owner decides on the PR.

## Review Focus

1. **An old last-read spot in a 7,900-message post.** Opening the post loads around it. "Load newer" then
   walks to the end with no gap and no duplicate. Task 13 (store `loadNewer` de-dupes by id) and Task 6
   (`listMessages` `around`) pin it.
2. **A member who loses the role mid-session.** After the 30-second verdict window, reads answer 403 and the
   open page drops to "Restricted". The answer is never stale beyond that. Task 10 (TTL test) and Task 13
   (403 during a poll → `denied`) pin it.
3. **Messages posted, edited or deleted while the gateway is down.** On the next READY, catch-up stores the
   new ones and fixes edits and deletes within the newest 100 of each post. Task 8 (window test) and
   Task 19 (e2e drop-and-reconnect) pin it.
4. **Hostile Discord content renders inert and fast:** `javascript:`, `data:` and `http:` links, 4000-character
   nested formatting, zero-width and RTL characters, links to other Discord channels. Task 14's hostile battery
   (render ctx + `LibMessage`) pins it.
5. **An image link that expired on a post nobody opened for weeks.** The read path refreshes it before
   answering. If the refresh fails, the page shows "Image unavailable" instead of a broken image. Task 11
   (handler refresh) and Task 14 (`@error` state) pin it.

---

## File structure

| File | Responsibility | Gated |
|---|---|---|
| `server/src/librariusPerms.js` | Discord's permission algorithm, pure | yes |
| `server/src/librariusParse.js` | Discord thread/message/emoji objects → store rows; reaction arithmetic; link expiry | yes |
| `server/schema.sql` (append) | Librarius tables | — |
| `server/src/librariusStore.js` | the only module that talks to the Librarius tables | yes |
| `server/src/librariusDiscord.js` | rate-limited REST reads for the Librarius | yes |
| `server/src/librariusGuild.js` | cached guild roles, owner, forum overwrites and tags, custom emoji | yes |
| `server/src/librariusGateway.js` | gateway connection: identify, heartbeat, resume, reconnect | yes |
| `server/src/librariusIngest.js` | gateway dispatch → store and cache updates | yes |
| `server/src/librariusImport.js` | first-run import and catch-up | yes |
| `server/src/librariusLinks.js` | attachment-link refresh timer and on-read refresh | yes |
| `server/src/librariusAccess.js` | per-request verdict: who is asking, can they read | yes |
| `server/src/librariusConfig.js` | env → configured / forum id / warning line | yes |
| `server/src/librariusHandler.js` | the `/librarius` routes | yes |
| `server/src/index.js`, `server/docker-compose.yml`, `server/.env.example`, `server/README.md` | wiring, env, port binding, owner notes | — |
| `src/lib/librarius/api.js` | site client for the routes | yes |
| `src/lib/librarius/snowflake.js` | snowflake ↔ time | yes |
| `src/stores/librarius.js` | page state, paging, polling merge, stale-answer guard | yes |
| `src/lib/librarius/layout.js` | grouping, article threshold, excerpt, first unread, date rail | yes |
| `src/lib/librarius/render.js` | the render context for `ArchiveMarkdown` (links, mentions, emoji) | yes |
| `src/components/librarius/LibMessage.vue`, `TopicList.vue`, `PostPage.vue`, `librarius.css` | the pages | — |
| `src/views/Reliquarium.vue`, `src/router.js`, `src/lib/useNavLinks.js`, `src/lib/discordAuth.js`, `src/stores/auth.js` | tab, gate, routes, nav hint | — |
| `scripts/csp.mjs`, `scripts/check-csp.mjs`, `vite.config.js`, `.husky/pre-push` | Content-Security-Policy | `scripts/csp.mjs` yes |
| `e2e/discord-mock/server.js`, `e2e/docker-compose.yml`, `e2e/tests/librarius-api.spec.js`, `e2e/tests/librarius.spec.js` | the e2e loop | — |

Calls this plan makes that the spec left to the builder:
- **Catch-up window:** the newest 100 messages of each post, one REST page.
- **Page size:** 50, at most 100.
- **Long reply → article:** 600 characters or more, or a heading, or 2 or more images.
- **Grouping:** same author within 7 minutes, neither message an article, no reply line.
- **Live updates:** polling a change cursor (`rev`), every 10 s on a post page and every 30 s on the topic
  list, only while the tab is visible.
- **Shown name and avatar:** the current server name from the roster cache, else the snapshot stored with the
  message.
- **Gateway session:** not persisted. A restart identifies anew (the token has 1000 identifies a day, none in
  use), and catch-up covers the gap.
- **Link refresh:** `POST /v10/attachments/refresh-urls`, which answered 200 for this bot on 2026-11-15.
- **The nav hint** is stored with the sign-in record as `librarius`.

---

### Task 1: Discord's permission rules (`librariusPerms.js`)

**Files:**
- Create: `server/src/librariusPerms.js`
- Test: `server/src/librariusPerms.test.js`
- Modify: `stryker.config.mjs`, `vitest.config.js` (add to the gated lists)

**Interfaces:**
- Produces:
  - `P` — frozen bigint bits: `ADMINISTRATOR 1n<<3n`, `MANAGE_CHANNELS 1n<<4n`, `ADD_REACTIONS 1n<<6n`,
    `VIEW_CHANNEL 1n<<10n`, `SEND_MESSAGES 1n<<11n`, `MANAGE_MESSAGES 1n<<13n`, `ATTACH_FILES 1n<<15n`,
    `READ_MESSAGE_HISTORY 1n<<16n`, `MANAGE_THREADS 1n<<34n`, `SEND_MESSAGES_IN_THREADS 1n<<38n`.
  - `ALL = (1n << 64n) - 1n`.
  - `toBits(value) → bigint`: a string of 1–40 digits or a bigint ≥ 0n; anything else is `0n`.
  - `permissionsIn({ guildId, ownerId, roles, overwrites, memberId, memberRoleIds }) → bigint`.
  - `canRead(bits) → boolean`.

- [ ] **Step 1: Write the failing tests.** Use invented ids. `guildId` doubles as the `@everyone` role id.
  The "live shape" fixture is: `@everyone` base `VIEW|SEND|HISTORY|SEND_IN_THREADS|ADD_REACTIONS`; a forum
  overwrite denying `@everyone` VIEW; a reader role allowed VIEW.

```js
it('reads the live shape: the reader role sees it, a member without it does not', () => {
  expect(canRead(permissionsIn({ ...LIVE, memberId: A, memberRoleIds: [READER] }))).toBe(true)
  expect(permissionsIn({ ...LIVE, memberId: B, memberRoleIds: [OTHER] })).toBe(0n)
})
it('gives the owner everything, whatever the overwrites say', ...)            // === ALL
it('gives Administrator (on any held role or @everyone) everything, overwrites ignored', ...)
it('applies @everyone, then all held roles (deny before allow), then the member', () => {
  // role allow beats @everyone deny; member deny beats role allow; member allow beats role deny;
  // one held role's allow beats another held role's deny (union, allow applied last)
})
it('ignores overwrites for roles the member does not hold, other members, and unknown types', ...)
it('answers 0n when View Channel is gone after the overwrites, even with other bits allowed', ...)
it('treats hostile input as nothing: non-arrays, non-snowflake ids, "12a", -1, 1e3, 41 digits', ...)
it('property: an allow-only overwrite for a held role never removes a bit', () => fc.assert(...))
it('property: a deny-only member overwrite never adds a bit', () => fc.assert(...))
```

- [ ] **Step 2: Run them and see them fail.** `bunx vitest run server/src/librariusPerms.test.js`. Expected:
  FAIL, module not found.
- [ ] **Step 3: Implement `permissionsIn` in the order Discord documents** (owner → base OR of `@everyone` and
  held roles → Administrator short-circuit → `@everyone` overwrite → union of held roles' overwrites, deny
  then allow → member overwrite → no VIEW_CHANNEL → `0n`). `canRead = VIEW_CHANNEL && READ_MESSAGE_HISTORY`.
  `toBits` mirrors `discordRoles.js`'s `perms()`.
- [ ] **Step 4: Run the tests and see them pass.** Run a scoped Stryker on the file and expect 100%.
- [ ] **Step 5: Commit** `feat(librarius): Discord's permission rules, computed per member`.

### Task 2: Discord objects → rows (`librariusParse.js`)

**Files:**
- Create: `server/src/librariusParse.js`
- Test: `server/src/librariusParse.test.js`
- Modify: both gated lists

**Interfaces:**
- Produces:
  - `MESSAGE_KINDS = new Set([0, 19, 20, 23])`: default, reply, slash-command and context-command results.
    Every other type (system lines, pins, joins) is not stored.
  - `snowflakeTime(id) → Date`, from `(BigInt(id) >> 22n) + 1420070400000n`.
  - `linkExpiry(url) → string | null`: the ISO time from the `ex` query parameter (hex seconds), else null.
  - `parseThread(raw, forumId)` → `{ id, ownerId, title, tagIds, pinned, locked, archived, createdAt }` or
    null. It is null unless `raw.parent_id === forumId` and `raw.id` is a snowflake.
    - `title` is cut to 100 characters.
    - `tagIds` are snowflakes only, at most 5.
    - `pinned` is `(flags & 2) !== 0`.
    - `createdAt` is `thread_metadata.create_timestamp`, else `snowflakeTime(id)`.
  - `parseMessage(raw)` → `{ id, postId, authorId, authorName, authorAvatar, webhookId, kind, content, embeds,
    stickers, reactions, replyTo, createdAt, editedAt, attachments }` or null. Each field:
    - `postId` is `raw.channel_id`.
    - `authorName` is `global_name || username`, cut to 80.
    - `authorAvatar` is `https://cdn.discordapp.com/avatars/<id>/<hash>.png?size=64` when the hash matches
      `/^(a_)?[0-9a-f]{32}$/`, else null.
    - `content` is cut to 4000.
    - `attachments`, at most 10, each `{ id, position, filename (≤200), contentType, size, width, height,
      url, proxyUrl, expiresAt }`. `url` must start with `https://cdn.discordapp.com/attachments/` and
      `proxyUrl` with `https://media.discordapp.net/attachments/` (or null). An attachment failing either is
      dropped.
    - `embeds`, at most 10, each `{ type, url, title (≤256), description (≤4096), provider (≤256), thumbnail,
      image }`.
      - `url` is `https:` only, or null.
      - `thumbnail` and `image` are `{ url: proxy_url, width, height }`, and only when the `proxy_url` host is
        `media.discordapp.net` or `images-ext-<n>.discordapp.net`. A raw outside image URL is never kept.
    - `stickers`, at most 3, each `{ id, name }`.
    - `reactions` is `[{ key, id, name, animated, count }]`, with `count − 1` when `me` is set (the bot's own).
      Entries left at zero are dropped.
    - `replyTo` is set for kind 19 only, from `message_reference.message_id`.
    - `createdAt` is `raw.timestamp`, else `snowflakeTime(id)`. `editedAt` is `raw.edited_timestamp` or null.
  - `parseEmoji(list) → [{ id, name, animated }]`: snowflake ids, names matching `/^\w{1,32}$/`.
  - `emojiKey({ id, name }) → string`: `c:<id>` for custom, `u:<name>` for unicode.
  - `applyReaction(reactions, emoji, delta) → reactions` (pure): adjusts by key, adds a new entry at the end,
    drops one that reaches 0, never goes negative.

- [ ] **Step 1: Write the failing tests.**
  - The happy paths for each function, using invented fixtures.
  - A hostile battery covering:
    - non-objects, a missing author, an unknown kind;
    - an attachment URL on another host (dropped);
    - an embed image without a proxy (no image), `javascript:` and `http:` embed URLs (null);
    - 5000-character content (cut to 4000);
    - reactions with `me: true` (one less, and none left at zero);
    - a tag list of 7 and bad tag ids;
    - an `ex` that isn't hex.
  - Property tests:
    - `parseMessage` and `parseThread` never throw on `fc.anything()`;
    - `applyReaction(applyReaction(r, e, 1), e, -1)` equals `r` for any `r` without zero counts.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Plain functions, no imports.
- [ ] **Step 4: Run them and see them pass.** Run a scoped Stryker and expect 100%.
- [ ] **Step 5: Commit** `feat(librarius): read Discord's threads, messages and emoji into rows`.

### Task 3: The tables (`schema.sql`)

**Files:**
- Modify: `server/schema.sql` (append a Librarius section after the Reliquarium's)
- Test: `server/src/librariusSchema.test.js` (reads the file as text)

- [ ] **Step 1: Write the failing test.** It asserts that `schema.sql` contains, idempotently
  (`if not exists`):
  - `create sequence if not exists librarius_rev`;
  - the tables `librarius_posts`, `librarius_messages` (FK to posts, `on delete cascade`, `rev bigint not null
    default nextval('librarius_rev')`), `librarius_attachments` (FK to messages, cascade),
    `librarius_tombstones`, `librarius_reads` (PK `member_id, post_id`, FK cascade) and `librarius_sync`
    (single row: `id smallint primary key default 1 check (id = 1)`);
  - the indexes `(post_id, id)` and `(post_id, rev)` on messages, `(post_id, rev)` on tombstones,
    `(message_id)` and `(expires_at)` on attachments.
- [ ] **Step 2: Run it and see it fail.**
- [ ] **Step 3: Append the SQL.** Columns:
  - **posts:** `id bigint pk, owner_id bigint, title text not null, tag_ids text[] not null default '{}',
    pinned, locked, archived boolean not null default false, created_at timestamptz not null, import_cursor
    bigint, viewed_at timestamptz, updated_at timestamptz not null default now()`
  - **messages:** `id bigint pk, post_id, author_id bigint not null, author_name text not null, author_avatar
    text, webhook_id bigint, kind smallint not null, content text not null, embeds/stickers/reactions jsonb not
    null default '[]', reply_to bigint, created_at timestamptz not null, edited_at timestamptz, rev`
  - **attachments:** `id bigint pk, message_id, position smallint, filename text not null, content_type text,
    size integer not null, width integer, height integer, url text not null, proxy_url text, expires_at
    timestamptz`
  - **tombstones:** `message_id bigint not null, post_id bigint not null, rev bigint not null default
    nextval('librarius_rev'), deleted_at timestamptz not null default now()`
  - **reads:** `member_id bigint, post_id bigint, last_read bigint not null`
  - **sync:** `import_done boolean not null default false, last_run_at, last_ok_at timestamptz, last_error
    text`

  Head the section with a comment: a copy of what Discord holds, a delete in Discord deletes here, ids are
  snowflakes. The app role's default privileges already cover new tables and sequences (`app-role.sql`).
- [ ] **Step 4: Run it and see it pass.**
- [ ] **Step 5: Commit** `feat(librarius): the tables`.

### Task 4: The store (`librariusStore.js`)

**Files:**
- Create: `server/src/librariusStore.js`
- Test: `server/src/librariusStore.test.js`, using the recording `fakePool` pattern from
  `galleryStore.test.js` (the SQL itself is proven by e2e)
- Modify: both gated lists

**Interfaces:**
- Consumes: the row shapes from Task 2 (`parseThread`, `parseMessage`); `applyReaction`; `createInTx`.
- Produces `createLibrariusStore(pool)` with:
  - `knownPostIds() → Promise<Set<string>>`
  - `upsertPost(post)`; `deletePost(id)`; `deletePostsNotIn(ids) → string[]`
  - `upsertMessages(rows)`. One transaction: insert … on conflict (id) do update, with `rev =
    nextval('librarius_rev')`. The message's attachments are replaced. Rows whose `postId` is not a stored post
    are skipped.
  - `deleteMessages(ids)`. One transaction: `insert into librarius_tombstones (message_id, post_id) select id,
    post_id … where id = any($1)`, then delete.
  - `adjustReaction(messageId, emoji, delta)` and `clearReactions(messageId, key | null)`. Each is one
    transaction: `select reactions … for update`, `applyReaction`, update with a new `rev`.
  - `listPosts(memberId)` → `[{ id, title, tagIds, pinned, locked, archived, createdAt, lastActivityAt,
    replies, unread, latest: { id, authorId, authorName, authorAvatar, content (first 400 chars), image: { id,
    url, expiresAt } | null } | null, posterIds: string[≤3] }]`.
    - `replies` counts every message except the opening one (`id <> post id`).
    - `unread` counts messages with `id > last_read`, and is 0 when the member has no read row.
    - `posterIds` are the last 3 distinct authors.
    - Order: pinned first, then `lastActivityAt` descending.
  - `getPost(id, memberId) → { post, lastRead: string | null } | null`
  - `listMessages(postId, { before, after, around, limit }) → { rows, hasOlder, hasNewer }`.
    - Rows are oldest first, each with its `attachments`, and `limit` is 1–100.
    - `around` takes `floor(limit/2)` at or before it and the rest after it.
    - `hasOlder` and `hasNewer` come from fetching one extra row.
  - `changes(postId, sinceRev) → { rows, deleted: string[], rev }`; `currentRev() → string`
  - `setRead(memberId, postId, messageId)`: upsert with `greatest(last_read, $3)`
  - `markViewed(postId)`
  - `importCursor(postId) → string | null`; `setImportCursor(postId, messageId)`
  - `windowIds(postId, limit) → [{ id, editedAt }]`, newest first
  - `syncStatus() → { importDone, lastRunAt, lastOkAt, lastError }`; `setSync(fields)`. The only accepted keys
    are `import_done`, `last_run_at`, `last_ok_at` and `last_error`. Any other key throws `TypeError`, as in
    `galleryStore` `SYNC_COLUMNS`.
  - `attachmentsToRefresh({ expiringBefore, viewedSince, limit }) → [{ id, url }]`. These are attachments of
    posts viewed since `viewedSince`, expiring before `expiringBefore`.
  - `updateAttachmentUrls([{ id, url, expiresAt }])`; `pruneTombstones(before)`

- [ ] **Step 1: Write the failing tests.** For each method, assert the statements it sends: the fragments and
  their `$n` params, the order in which they run, and that transactions roll back on a thrown query.
  - Every caller value is a `$n` param. The only built SQL is a fixed fragment or a `setSync` column from the
    allowlist.
  - `around` splits 50 as 25 before and 25 after.
  - `limit` 0, 101, `'5'` or `NaN` throws `RangeError`.
  - A non-snowflake id throws `TypeError` before any query.
  - `setRead` never lowers (`greatest`).
  - `deleteMessages([])` sends nothing.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Follow `galleryStore.js` structure (`needId` guard, `inTx`).
- [ ] **Step 4: Run them and see them pass.** Run a scoped Stryker and expect 100%.
- [ ] **Step 5: Commit** `feat(librarius): the store`.

### Task 5: REST reads with their own rate limits (`librariusDiscord.js`)

**Files:**
- Create: `server/src/librariusDiscord.js`
- Test: `server/src/librariusDiscord.test.js` (fake `fetchImpl`, fake `sleep`, fake `now`)
- Modify: both gated lists

**Interfaces:**
- Consumes: `Upstream` from `discordRoles.js`.
- Produces `createLibrariusDiscord({ fetchImpl = fetch, apiBase, botToken, guildId, timeoutMs = 10_000, sleep,
  now = Date.now, perSecond = 5 })` with:
  - `gatewayBot() → { url, remaining, resetAfterMs }` (`GET /v10/gateway/bot`)
  - `guild() → raw` (`GET /v10/guilds/:guild`); `channel(id) → raw`
  - `activeThreads() → raw[]` (`GET /v10/guilds/:guild/threads/active` → `.threads`)
  - `archivedThreads(forumId, before | null) → { threads, hasMore }`
    (`/threads/archived/public?limit=100[&before=ISO]`)
  - `messagesAfter(channelId, afterId, limit = 100) → raw[]`, oldest first (Discord answers newest first)
  - `newest(channelId, limit = 100) → raw[]`, newest first
  - `message(channelId, id) → raw | null`. Null on 404 with code 10008; any other 404 is `Upstream`.
  - `emojis() → raw[]` (`GET /v10/guilds/:guild/emojis`)
  - `refreshUrls(urls) → Map<original, refreshed>`: `POST /v10/attachments/refresh-urls`
    `{ attachment_urls }`, at most 50, more throws `RangeError`.
- Rules:
  - At most `perSecond` calls a second across the whole client, so the Librarius never crowds the other
    features off Discord's 50/s.
  - Per bucket: remember `X-RateLimit-Bucket` per route key, and when `Remaining` is `0`, sleep
    `Reset-After` before the next call to that bucket.
  - A 429 sleeps `Retry-After` (at most 30 s) and retries once; a second 429 is `Upstream`.
  - A network error or timeout is `Upstream('Discord is unreachable.')`.
  - Messages name a status at most: never a URL or the token.
  - Not configured (empty `apiBase`, `botToken` or `guildId`) throws `Upstream`.

- [ ] **Step 1: Write the failing tests.**
  - Each call's URL, method and `Authorization: Bot <token>` header.
  - Ordering: `messagesAfter` is reversed to oldest first.
  - `message` answers 404 with code 10008 → null; 404 with another code → `Upstream`.
  - Rate limits: a 429 waits then retries; two 429s throw; a bucket at 0 sleeps before its next call but not
    before another bucket's; a sixth call in one second sleeps.
  - An `Upstream` message never contains `https://` or the token.
  - Hostile bodies (non-JSON, non-array, `threads` missing) are `Upstream`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Model it on `galleryDiscord.js`.
- [ ] **Step 4: Run them and see them pass.** Run a scoped Stryker and expect 100%.
- [ ] **Step 5: Commit** `feat(librarius): rate-limited Discord reads`.

### Task 6: Cached guild facts (`librariusGuild.js`)

**Files:**
- Create: `server/src/librariusGuild.js`
- Test: `server/src/librariusGuild.test.js`
- Modify: both gated lists

**Interfaces:**
- Consumes: `discord.guild()`, `discord.channel(forumId)` and `discord.emojis()` from Task 5; `parseEmoji`
  from Task 2.
- Produces `createLibrariusGuild({ discord, forumId, ttlMs = 300_000, emojiTtlMs = 600_000, now = Date.now })`
  with:
  - `facts() → { ownerId, roles: [{ id, permissions, name, color }], overwrites, tags: [{ id, name }] }`
    (`color` is `#rrggbb` or null for 0)
  - `emoji() → [{ id, name, animated }]`
  - `invalidate(kind)` where `kind` is `'guild' | 'forum' | 'emoji'`. Anything else throws `TypeError`.
  - `setEmoji(rawList)`
- Rules:
  - The guild and the forum are cached separately, each for `ttlMs`.
  - Concurrent callers share one in-flight read.
  - A failure throws `Upstream` and caches nothing. No stale copy is served for permissions (fail closed).
  - An `invalidate` that lands during an in-flight read stops that read's answer from being stored, using the
    `verdictCache` epoch idea.

- [ ] **Step 1: Write the failing tests.**
  - Caching: reads within the TTL hit cache; TTL expiry refetches; two parallel calls make one fetch.
  - Failure: a failure is not cached.
  - Invalidation: `invalidate('forum')` refetches only the forum; invalidation mid-flight discards that answer.
  - `setEmoji` replaces the list.
  - Hostile role, overwrite and tag shapes are filtered out.
- [ ] **Step 2: Run them and see them fail.** Step 3: Implement. Step 4: Run them, see them pass, and run a
  scoped Stryker (expect 100%).
- [ ] **Step 5: Commit** `feat(librarius): cached roles, forum overwrites, tags and emoji`.

### Task 7: The gateway connection (`librariusGateway.js`)

**Files:**
- Create: `server/src/librariusGateway.js`
- Test: `server/src/librariusGateway.test.js`, with a `FakeSocket` class recording `send` and `close` and
  exposing `open()`, `receive(obj)` and `drop(code)`; `vi.useFakeTimers()`; `random = () => 0.5`
- Modify: both gated lists

**Interfaces:**
- Consumes: `discord.gatewayBot()`.
- Produces:
  - `INTENTS = 34313`, made up of GUILDS 1, GUILD_EMOJIS_AND_STICKERS 8, GUILD_MESSAGES 512,
    GUILD_MESSAGE_REACTIONS 1024 and MESSAGE_CONTENT 32768.
  - `FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014])`.
  - `createGateway({ discord, botToken, intents = INTENTS, onDispatch, WebSocketImpl = globalThis.WebSocket,
    timers = { setTimeout, clearTimeout }, random = Math.random, log = console.error })` →
    `{ start(), stop(), status() → { state, lastReadyAt, lastError } }`.
  - `state` is one of `idle | connecting | ready | waiting | stopped | failed`.
- Behaviour:
  - **Connect:** `start()` → `gatewayBot()`. When `remaining === 0`, wait `resetAfterMs`. Then connect to
    `url + '/?v=10&encoding=json'`.
  - **On op 10 HELLO:**
    - Send the first heartbeat after `interval × random()`, then one every `interval`.
    - Send **IDENTIFY** `{ token, intents, properties: { os: 'linux', browser: 'salamanders-site', device:
      'salamanders-site' } }`, or **RESUME** `{ token, session_id, seq }` when a session is held.
  - **Heartbeat ACK check:** a heartbeat whose predecessor got no ACK (op 11) closes with code 4000 and
    reconnects, resuming.
  - **op 1:** heartbeat now.
  - **op 7:** close 4000 and resume.
  - **op 9:** `d: true` resumes; `d: false` drops the session and identifies again after 1–5 s.
  - **op 0:**
    - Store `s`.
    - `READY` keeps `session_id` and `resume_gateway_url` (resumes use it), sets `state = 'ready'` and resets
      the backoff. `RESUMED` resets the backoff too.
    - Every dispatch calls `onDispatch(t, d)` and awaits it. A throw or rejection is caught and logged, and
      never stops the connection.
  - **On close:**
    - A `FATAL_CLOSE` code → `state = 'failed'`, `lastError` names the code, no reconnect.
    - 4007 or 4009 → drop the session and identify again.
    - Anything else → reconnect after a backoff of 1, 2, 4 … up to 60 s, resuming when a session is held.
  - **`stop()`:** closes 1000, clears timers, never reconnects.
  - The token never appears in `lastError` or in a log line.

- [ ] **Step 1: Write the failing tests.** One `it` per behaviour above, driving the `FakeSocket` and advancing
  fake timers. Assert:
  - the JSON sent;
  - the URLs connected to (the first from `gatewayBot`, the resume one after READY);
  - `status()` transitions;
  - that `onDispatch` sees `(t, d)` in order;
  - that a throwing `onDispatch` leaves the connection `ready`;
  - that no log or `lastError` contains the token.
- [ ] **Step 2: Run them and see them fail.** Step 3: Implement. Step 4: Run them, see them pass, and run a
  scoped Stryker (expect 100%).
- [ ] **Step 5: Commit** `feat(librarius): the gateway connection`.

### Task 8: Import and catch-up (`librariusImport.js`)

**Files:**
- Create: `server/src/librariusImport.js`
- Test: `server/src/librariusImport.test.js` (fake `discord`, fake `store`, both in memory)
- Modify: both gated lists

**Interfaces:**
- Consumes: Task 5 reads; Task 4 `upsertPost`, `deletePostsNotIn`, `upsertMessages`, `deleteMessages`,
  `importCursor`, `setImportCursor`, `windowIds` and `setSync`; Task 2 `parseThread` and `parseMessage`.
- Produces `createImport({ discord, store, forumId, windowSize = 100, log = console.error })` →
  `{ run() → Promise<void>, status() }`.
  - `run()` never rejects. Overlapping calls share one run.
  - `status()` reads `store.syncStatus()`.
- `run()` does, in order:
  1. Collect the threads: active ones filtered to `parent_id === forumId`, plus every archived page (`before`
     = the last page's oldest `thread_metadata.archive_timestamp`, until `hasMore` is false). Upsert each.
     Then `deletePostsNotIn(all ids)`, but only when every list call succeeded.
  2. For each post, page `messagesAfter(post, cursor ?? '0', 100)` until a short page. Upsert the parsed
     rows, then `setImportCursor` to the last id of each page.
  3. For each post, compare `newest(post, windowSize)` with `windowIds(post, windowSize)`.
     - A stored id inside the fetched page's id range but absent from it → `deleteMessages`.
     - A differing `edited_timestamp` → upsert.
     - A stored id older than the fetched page is left alone. That is the stated limit of the catch-up.
  4. `setSync({ import_done: true, last_ok_at: now, last_error: null })`.
  - Any `Upstream` stops the run. `setSync({ last_error })` records it, with links stripped. Cursors already
    set stay, so the next run resumes.

- [ ] **Step 1: Write the failing tests.**
  - Import:
    - a fresh import of 2 posts (one archived) with 230 and 3 messages pages 3 + 1 times, and the cursors end
      at the newest ids;
    - a second run with nothing new makes one short page per post.
  - The window:
    - a message deleted in Discord inside the window is deleted; one edited is upserted;
    - a stored message older than the window survives.
  - Failures:
    - a failure on page 2 records `last_error` and leaves the page-1 cursor;
    - an archived-list failure deletes no posts.
  - Overlap: two overlapping `run()`s make one pass.
- [ ] **Step 2: Run them and see them fail.** Step 3: Implement. Step 4: Run them, see them pass, and run a
  scoped Stryker (expect 100%).
- [ ] **Step 5: Commit** `feat(librarius): import the full history, and catch up after a gap`.

### Task 9: Gateway events → store (`librariusIngest.js`)

**Files:**
- Create: `server/src/librariusIngest.js`
- Test: `server/src/librariusIngest.test.js`
- Modify: both gated lists

**Interfaces:**
- Consumes:
  - Task 4 store methods;
  - Task 2 parsers and `emojiKey`;
  - Task 6 `guild.invalidate` and `guild.setEmoji`;
  - Task 10's `access.forget` (passed in);
  - `fetchMessage = discord.message`;
  - `onReady` (wired to `importer.run`).
- Produces `createIngest({ store, guild, access, forumId, fetchMessage, onReady, log })` →
  `{ load() → Promise<void>, dispatch(type, data) → Promise<void>, botUserId() → string | null }`.
- Events:
  - **`READY`:** set `botUserId` from `d.user.id`, then call `onReady()` without awaiting it.
  - **`THREAD_CREATE` / `THREAD_UPDATE`:** `parseThread` → `upsertPost`, and add the id to the known set.
  - **`THREAD_DELETE`:** `deletePost`, if `parent_id` is the forum.
  - **`THREAD_LIST_SYNC`:** upsert each thread whose parent is the forum.
  - **`MESSAGE_CREATE` / `MESSAGE_UPDATE`:** only when `channel_id` is known.
    - When `author` is present: `parseMessage` → `upsertMessages([row])`.
    - An update without `author` (a partial one) is re-read with `fetchMessage` and upserted. When that
      answers null, delete it.
  - **`MESSAGE_DELETE`:** `deleteMessages([id])`. **`MESSAGE_DELETE_BULK`:** `deleteMessages(ids)`. Both only
    when the channel is known.
  - **`MESSAGE_REACTION_ADD` / `REMOVE`:** `adjustReaction(message_id, emoji, ±1)`. Skipped when
    `user_id === botUserId()` or the channel is unknown.
  - **`MESSAGE_REACTION_REMOVE_ALL`:** `clearReactions(message_id, null)`. **`REMOVE_EMOJI`:**
    `clearReactions(message_id, emojiKey(emoji))`.
  - **`CHANNEL_UPDATE`** of the forum: `guild.invalidate('forum')` and `access.forget()`.
  - **`GUILD_ROLE_CREATE` / `UPDATE` / `DELETE`:** `guild.invalidate('guild')` and `access.forget()`.
  - **`GUILD_EMOJIS_UPDATE`:** `guild.setEmoji(d.emojis)`.
  - **Anything else:** ignored.

- [ ] **Step 1: Write the failing tests.**
  - One per event row.
  - Unknown-channel filtering: a message in another channel stores nothing.
  - The bot's own reaction is ignored.
  - A partial update re-reads the message.
  - A parse returning null stores nothing.
  - `load()` seeds the known set from `knownPostIds()`.
- [ ] **Step 2: Run them and see them fail.** Step 3: Implement. Step 4: Run them, see them pass, and run a
  scoped Stryker (expect 100%).
- [ ] **Step 5: Commit** `feat(librarius): live events into the store`.

### Task 10: Who may read (`librariusAccess.js`)

**Files:**
- Create: `server/src/librariusAccess.js`
- Test: `server/src/librariusAccess.test.js`
- Modify: both gated lists

**Interfaces:**
- Consumes:
  - `roles.identify(request)` and `roles.memberOf(id)` from `discordRoles.js`;
  - `guild.facts()` from Task 6;
  - `permissionsIn` and `canRead` from Task 1;
  - `createVerdictCache`.
- Produces `createLibrariusAccess({ roles, guild, guildId, ttlMs = 30_000, maxEntries, now })` →
  `{ resolve(request, { fresh }) → { user, read, perms } | null, forget() }`.
  - No identity → null.
  - Not in the guild (`memberOf` null) → `{ user, read: false, perms: 0n }`.
  - Otherwise `perms = permissionsIn({ guildId, ownerId, roles, overwrites, memberId: user.id, memberRoleIds })`
    and `read = canRead(perms)`.
  - `Upstream` propagates.

- [ ] **Step 1: Write the failing tests.**
  - The live-shape reader is allowed; the Legion-only member is refused; the owner is allowed.
  - The cache: a cached verdict is reused within `ttlMs` and refetched after it.
  - `forget()` drops verdicts.
  - `fresh` skips the cache.
  - `Upstream` from either call propagates and is not cached.
- [ ] **Step 2: Run them and see them fail.** Step 3: Implement. Step 4: Run them, see them pass, and run a
  scoped Stryker (expect 100%).
- [ ] **Step 5: Commit** `feat(librarius): the read verdict follows the forum's Discord permissions`.

### Task 11: Config, link refresh and the routes (`librariusConfig.js`, `librariusLinks.js`, `librariusHandler.js`)

**Files:**
- Create: `server/src/librariusConfig.js`, `server/src/librariusLinks.js`, `server/src/librariusHandler.js`,
  and a test for each
- Modify: both gated lists (all three)

**Interfaces:**
- **`librariusConfig(env)`** → `{ configured, forumId, report }`.
  - `forumId` is `env.LIBRARIUS_CHANNEL_ID` when it matches `/^\d{17,20}$/`.
  - `report` is null when the variable is unset. A set but malformed one gives `"Librarius is not configured,
    so every /librarius route answers 503 and the gateway stays off: LIBRARIUS_CHANNEL_ID (not a Discord
    channel id)."`.
- **`createLinkRefresh({ discord, store, intervalMs = 600_000, aheadMs = 7_200_000, viewedWithinMs =
  86_400_000, now, timers, log })`** → `{ start(), stop(), runOnce(), refresh(attachments) }`.
  - `runOnce`:
    - Take `attachmentsToRefresh({ expiringBefore: now + aheadMs, viewedSince: now − viewedWithinMs, limit:
      200 })`.
    - Refresh them in chunks of 50 with `refreshUrls`, then `updateAttachmentUrls` with `linkExpiry` of each
      new URL.
    - `pruneTombstones(now − 1 day)`.
  - `refresh(attachments)` (≤50) → `Map<id, { url, expiresAt }>`. It is used by the read path, and swallows
    `Upstream` by returning an empty map.
  - `runOnce` never rejects. Errors are logged without links.
- **`createLibrariusHandler({ access, store, guild, links, importer, roster, guildId, forumId, configured,
  now })`** → `handle(request, url) → Response | null`.
  - **Gates, in order:** a path that isn't `/librarius` or under it → null; unknown route → 404;
    `!configured` → 503; no verdict → 401; `!verdict.read` → 403 `"Restricted to those who can read the
    Librarius in Discord."` (except `/librarius/me`); `Upstream` → 503 `"Discord could not be reached. Try
    again."`.
  - **Freshness:** GETs use the cached verdict; the PUT asks `fresh`.
  - **Routes:**
    - `GET /librarius/me` → `{ access: verdict.read, ready, tags, roles: [{ id, name, color }], guildId,
      forumId }`. `ready` is `(await importer.status()).importDone`.
    - `GET /librarius/posts` → `{ posts, people }`. `people` holds `{ id: { name, avatar } }` for every
      latest author and poster, from `roster.members()`, falling back to the stored snapshot.
    - `GET /librarius/posts/:id` → `{ post, lastRead, rev }`. It calls `store.markViewed(id)`, and an unknown
      post is 404 `"No such post."`.
    - `GET /librarius/posts/:id/messages?before|after|around&limit` → `{ messages, hasOlder, hasNewer, people,
      rev }`.
      - At most one of `before`, `after` and `around`, each a snowflake. `limit` is 1–100, default 50.
        Anything else is 400 `"That page cursor is not valid."`.
      - Before answering, attachments whose `expiresAt` is within 5 minutes go through `links.refresh` (the
        first 50), and the refreshed URLs are used.
      - `people` covers authors, `<@id>` mentions (regex `/<@!?(\d{17,20})>/g`) and the authors of replied-to
        messages.
    - `GET /librarius/posts/:id/changes?since=<rev>` → `{ messages, deleted, rev, people }`. `since` must be
      digits.
    - `PUT /librarius/posts/:id/read` with JSON `{ messageId }` → 204. It goes through `readJson` with a 1 KB
      limit; a malformed body is 400.
    - `GET /librarius/emoji` → `{ emoji }`.
  - **Message view:** `{ id, authorId, authorName, authorAvatar, content, createdAt, editedAt, replyTo: { id,
    authorId, authorName, content (first 200) } | null, attachments: [{ id, filename, contentType, size,
    width, height, url }], embeds, stickers, reactions, origin: 'discord' }`.
    - `replyTo` is null when the replied-to message isn't stored.
    - A member's name and avatar come from the roster when present.

- [ ] **Step 1: Write the failing tests.**
  - The config report wording.
  - Link refresh: chunking at 50; expiry parsed; failure swallowed; tombstones pruned.
  - The handler:
    - every gate in order, with the exact status and copy;
    - every route's shape, using fake access, store, guild, links and importer;
    - cursor validation (two cursors, `abc`, limit 0 and 101);
    - the expiring-link refresh used, and the stale link kept when refresh fails;
    - `people` filled from the roster, with the snapshot used when absent;
    - the PUT 415 and 413.
- [ ] **Step 2: Run them and see them fail.** Step 3: Implement. Step 4: Run them, see them pass, and run a
  scoped Stryker (expect 100% on each).
- [ ] **Step 5: Commit** `feat(librarius): the read-only routes and link refresh`.

### Task 12: Wiring, env, port binding, owner notes

**Files:**
- Modify: `server/src/index.js`, `server/docker-compose.yml`, `server/.env.example`, `server/README.md`
- Test: `server/src/composePorts.test.js` (reads `server/docker-compose.yml` as text)

**Interfaces:**
- Consumes everything in Tasks 4–11.

- [ ] **Step 1: Write the failing test.** It asserts:
  - the api service publishes `'127.0.0.1:8787:8787'` and no `'8787:8787'` without a host;
  - `LIBRARIUS_CHANNEL_ID: ${LIBRARIUS_CHANNEL_ID:-}` is in the api environment.
- [ ] **Step 2: Run it and see it fail.**
- [ ] **Step 3: Wire `index.js`.**
  - Build the pieces: `librariusConfig(process.env)`, then `librariusDiscord`, `librariusGuild`,
    `librariusAccess`, `librariusStore(pool)`, `librariusImport`, `librariusLinks`, `librariusIngest` and
    `librariusGateway` (with `onDispatch = ingest.dispatch` and `onReady = () => importer.run()`).
  - Add the handler before the 404, in the same `try` chain as `gallery`.
  - **Startup:** only when `configured` (log the `report` otherwise), run `await ingest.load()` →
    `importer.run()` (not awaited) → `links.start()` → `gateway.start()`.
  - **Containment:** every one of these is started inside `.catch((e) => console.error('Librarius:', …))`,
    and nothing they throw reaches `Bun.serve`.
  - **Compose:** change `ports` to `'127.0.0.1:8787:8787'`.
  - **Env files:** add `LIBRARIUS_CHANNEL_ID` to compose and to `.env.example`, explained as in the gallery
    block. It is not a secret, but it's kept out of git because it's live data.
  - **README:** add `## Librarius (/librarius/*)` with the routes, gates and rollout. Rollout order:
    1. Apply `schema.sql`.
    2. Set `LIBRARIUS_CHANNEL_ID` in `server/.env`.
    3. Rebuild the API, keeping rollback tag `server-api:pre-librarius`.
    4. Check:
       - `curl -s -o /dev/null -w '%{http_code}' localhost:8787/librarius/me` answers 401;
       - `docker compose logs api` shows no "Librarius is not configured";
       - the import finishes (`/librarius/me` `ready: true` for a reader);
       - port 8787 is no longer reachable from another machine on the LAN.
- [ ] **Step 4: Run the whole suite.** `bun run test` should pass. Then smoke-test the server locally on
  another port (the live container holds 8787): `cd server && PORT=8799 LIBRARIUS_CHANNEL_ID= bun run
  src/index.js` starts, and `curl -s localhost:8799/health` answers `{"ok":true}`.
- [ ] **Step 5: Commit** `feat(librarius): wire it in; the API listens on localhost only`.

### Task 13: Site client, snowflakes and the store (`api.js`, `snowflake.js`, `stores/librarius.js`)

**Files:**
- Create: `src/lib/librarius/api.js`, `src/lib/librarius/snowflake.js`, `src/stores/librarius.js`, and a test for
  each
- Modify: both gated lists (all three)

**Interfaces:**
- **`api.js`:** `getMe(token)`, `listPosts(token)`, `getPost(token, id)`, `listMessages(token, id, { before,
  after, around, limit })`, `getChanges(token, id, since)`, `markRead(token, id, messageId)` and
  `listEmoji(token)`, all through `buildsApi.request` with `cache: 'no-store'`. Ids are `encodeURIComponent`ed.
- **`snowflake.js`:** `snowflakeAt(date) → string`; `timeOf(id) → Date`.
- **`useLibrarius` (Pinia)** state:
  - `status`: `idle | checking | allowed | importing | denied | signin | unavailable`
  - `me`, `posts`, `people`
  - `post: { id, info, messages, hasOlder, hasNewer, rev, lastRead }`
  - `error`

  Actions:
  - `load(token)`: `getMe` → `allowed` when `access && ready`, `importing` when `access && !ready`, `denied`
    when `!access`. 401 → `signin`; 403 → `denied`; else `unavailable`.
  - `loadPosts(token)`
  - `openPost(token, id)`: `getPost`, then `listMessages` with `around: lastRead` if `lastRead`, else the
    newest page.
  - `loadOlder(token)` and `loadNewer(token)`: they merge and de-dupe by id, keep the oldest-first order and
    update `hasOlder` / `hasNewer`.
  - `poll(token)`:
    - It calls `getChanges(since: post.rev)`.
    - It replaces messages by id, removes `deleted`, and appends new ones only when `!hasNewer`.
    - It moves `rev`.
    - A 403 → `status = 'denied'`, and the lists are emptied.
  - `markRead(token, messageId)`: sent only when `messageId > lastRead`, compared as `BigInt`.
  - `reset()`

  Every answer obeys the `seq` / `unlessStale` guard from `stores/gallery.js`, so a late answer never lands
  after `reset()` or a newer call.

- [ ] **Step 1: Write the failing tests.**
  - The status mapping.
  - `openPost` around `lastRead` versus newest.
  - `loadOlder` and `loadNewer` de-dupe (the Review Focus 1 case: overlapping pages give no duplicates and no
    gaps).
  - Poll merge:
    - an edit replaces;
    - a delete removes;
    - new messages append only at the end;
    - a 403 during a poll → `denied` (the Review Focus 2 case).
  - `markRead` never sends a lower id.
  - A stale answer after `reset()` is dropped.
  - `snowflakeAt` / `timeOf` round-trip (property test over 2015–2100).
- [ ] **Step 2: Run them and see them fail.** Step 3: Implement. Step 4: Run them, see them pass, and run a
  scoped Stryker (expect 100%).
- [ ] **Step 5: Commit** `feat(librarius): site client and store`.

### Task 14: How a message reads (`layout.js`, `render.js`, `LibMessage.vue`)

**Files:**
- Create: `src/lib/librarius/layout.js`, `src/lib/librarius/render.js`,
  `src/components/librarius/LibMessage.vue`, `src/components/librarius/librarius.css`, and tests for each
- Modify: both gated lists (`layout.js` and `render.js`)

**Interfaces:**
- Consumes: `parse` and `plainText` from `src/lib/archive/markdown.js`; `ArchiveMarkdown` from
  `src/components/archive/ArchiveMarkdown.js`; `parseDiscordRef` and `isDiscordHost` from
  `src/lib/archive/links.js`.
- **`layout.js`:**
  - `isArticle(message, nodes) → boolean`: content ≥ 600, or a `heading` node, or ≥ 2 image attachments.
  - `groupMessages(messages) → [{ message, grouped }]`: same author as the previous, within 7 minutes, neither
    an article, no `replyTo`.
  - `excerpt(content, max = 120) → string`: `plainText(parse(content))` with whitespace collapsed, cut with `…`.
  - `firstUnread(messages, lastRead) → id | null`: null when `lastRead` is null.
  - `railMonths(createdAt, lastAt) → [{ label: 'Nov 2026', at: Date }]`.
- **`render.js`:** `createRenderCtx({ guildId, postTitles: Map, people, roles })` → `{ link, emoji, mention }`
  in the shape `ArchiveMarkdown` takes.
  - `link(href)`:
    - A Discord URL or `<#id>` naming a Librarius post → `{ kind: 'route', to:
      '/reliquarium/librarius/<post>' + (msg ? '#m-<msg>' : '') }`.
    - Any other `https:` URL, Discord's included → `{ kind: 'external', href }`.
    - Anything else → `{ kind: 'text' }`.
  - `mention`:
    - A user → `@name` from `people`, else `@unknown-member`.
    - A role → `@<role name>` with `color`.
    - A channel → a post's title, else `#channel`.
  - `emoji(node)` → `h('img', { src: 'https://cdn.discordapp.com/emojis/<id>.<gif|webp>?size=48', alt:
    ':name:', class: 'lb-emoji', loading: 'lazy' })`.
- **`LibMessage.vue`:** props `{ message, grouped, article, people, ctx }`.
  - It renders the avatar, name and time (hidden when `grouped`), the reply line, the body through
    `ArchiveMarkdown`, attachments, embeds, stickers and reactions.
  - The root element has `id="m-<id>"`.
  - The reply line: `↪ replying to <name>: <excerpt>`, linking `#m-<replyTo.id>`.
  - **Attachments:**
    - `image/*` → `<img loading="lazy">` with width and height. `@error` swaps it for the text "Image
      unavailable".
    - Videos and other files → a link to the CDN with the filename and size. The spec says links, not
      players.
  - **Embeds:** the title as an external link, the description through `ArchiveMarkdown`, and the
    thumbnail or image from the proxy URL only.
  - **Reactions:** read-only chips with the emoji image or character and the count.
  - **Stickers:** `[sticker: name]`.
  - The `article` prop adds class `lb-article`.

- [ ] **Step 1: Write the failing tests.**
  - The layout rules at their boundaries: 599 and 600 characters, 7 minutes ± 1 s, one or two images.
  - Every `link` branch.
  - A hostile battery through `LibMessage` (Review Focus 4):
    - `javascript:alert(1)`, `data:text/html,…` and `http://` links render as text, not anchors;
    - a 4000-character run of nested `**__~~||` renders in under 50 ms;
    - zero-width and RTL characters stay text;
    - a Discord link to another channel is an external `https://discord.com/...` anchor with
      `rel="noopener noreferrer"`.
  - The image `@error` state shows "Image unavailable" (Review Focus 5).
  - The grouped header is hidden.
  - The reply line links `#m-<id>`.
- [ ] **Step 2: Run them and see them fail.** Step 3: Implement. Step 4: Run them, see them pass, and run a
  scoped Stryker on `layout.js` and `render.js` (expect 100%).
- [ ] **Step 5: Commit** `feat(librarius): how a message reads`.

### Task 15: The topic list (`TopicList.vue`)

**Files:**
- Create: `src/components/librarius/TopicList.vue`, `src/components/librarius/TopicList.test.js`

**Interfaces:**
- Consumes: `useLibrarius` (`posts`, `people`, `me`, `loadPosts`), `excerpt`, `useAuth().token`.
- Behaviour, matching the spec's "Topic list" sketch:
  - **Rows:** title; tags (names from `me.tags`); "N new" when `unread > 0`; the latest author's name and
    `excerpt(latest.content)`; a thumbnail when `latest.image`; reply count; relative last activity; up to
    3 poster avatars.
  - **Order and filters:**
    - Pinned posts come first, marked "Pinned".
    - Tag chips filter the list (`All` plus each tag).
    - A sort select offers "Latest activity" (the default) or "Newest" (`createdAt`).
    - Archived posts are hidden behind a "Show archived (N)" button.
  - **Links:**
    - Each row is a `RouterLink` to `/reliquarium/librarius/<id>`.
    - The button "Start a post in Discord ↗" is an external link to
      `https://discord.com/channels/<guildId>/<forumId>` with `target="_blank" rel="noopener noreferrer"`.
  - **Polling:** `loadPosts` every 30 s while `document.visibilityState === 'visible'`, cleared on unmount.
  - **Empty state:** "Nothing here yet. Posts are started in Discord." and the same button.

- [ ] **Step 1: Write the failing tests.**
  - The order (pinned first, then activity).
  - The tag filter.
  - Switching the sort.
  - The archived toggle count.
  - The unread badge.
  - The Discord button `href`.
  - The 30 s poll only while visible, and stopped on unmount (fake timers).
  - The empty state.
- [ ] **Step 2: Run them and see them fail.** Step 3: Implement. Step 4: Run them and see them pass.
- [ ] **Step 5: Commit** `feat(librarius): the topic list`.

### Task 16: The post page (`PostPage.vue`)

**Files:**
- Create: `src/components/librarius/PostPage.vue`, `src/components/librarius/PostPage.test.js`

**Interfaces:**
- Consumes: `useLibrarius` (`openPost`, `loadOlder`, `loadNewer`, `poll`, `markRead`, `post`, `people`),
  `groupMessages`, `isArticle`, `firstUnread`, `railMonths`, `snowflakeAt`, `createRenderCtx`, `LibMessage`.
- Behaviour, matching the spec's "Post page" sketch:
  - **Header:** a breadcrumb (`Reliquarium › Librarius › <title>`), the title, tags, reply count and start
    date, and "Open in Discord ↗" (`https://discord.com/channels/<guild>/<post>`).
  - **Messages:**
    - The opening message (id === post id) renders with `article`.
    - Replies render through `groupMessages`, with `isArticle` per message.
    - "Load older" and "Load newer" buttons appear while `hasOlder` / `hasNewer`.
  - **Since your last visit:**
    - A divider "SINCE YOUR LAST VISIT · N NEW" sits before `firstUnread`.
    - On open, it scrolls to the divider, else to the URL hash `#m-<id>`, else to the newest message.
  - **The date rail:** `railMonths`. A click calls `openPost` around `snowflakeAt(month)`.
  - **Marking read:** an `IntersectionObserver` on messages sends `markRead(newest visible id)`, debounced to
    2 s.
  - **Polling:** `poll` every 10 s while the tab is visible, cleared on unmount and when `postId` changes.
  - **Back:** the router's saved position applies. The page only scrolls on first open of a post.

- [ ] **Step 1: Write the failing tests.**
  - Use a fake `IntersectionObserver` and fake timers.
  - The opening message is an article.
  - The divider position, and none on a first visit.
  - "Load older" calls the store.
  - The rail click opens around the month's snowflake.
  - `markRead` is debounced and sent with the newest visible id.
  - The poll cadence, and its stop on unmount.
  - The "Open in Discord" `href`.
  - The `#m-<id>` hash scroll target.
- [ ] **Step 2: Run them and see them fail.** Step 3: Implement. Step 4: Run them and see them pass.
- [ ] **Step 5: Commit** `feat(librarius): the post page`.

### Task 17: The Reliquarium tab, the routes and the nav hint

**Files:**
- Modify: `src/router.js`, `src/router.test.js`, `src/views/Reliquarium.vue`, `src/views/Reliquarium.test.js`,
  `src/lib/discordAuth.js`, `src/lib/discordAuth.test.js`, `src/stores/auth.js`, `src/stores/auth.test.js`,
  `src/lib/useNavLinks.js`, `src/lib/useNavLinks.test.js`
- Create: `src/components/librarius/no-v-html.test.js` (copy of the gallery guard, scanning
  `components/librarius`, `lib/librarius`, `stores/librarius.js`)

**Interfaces:**
- **Routes:**
  - `/reliquarium/:tab(librarius|clips|art|submit|mine|review)?` (name `reliquarium`)
  - `/reliquarium/librarius/:postId(\\d{17,20})` (name `reliquarium-post`, same component)
- **`scrollBehavior(to, from, savedPosition)`:**
  - It returns `savedPosition` when going Back to a Librarius route.
  - It returns `false` for a Librarius post with a hash, because `PostPage` scrolls to `#m-<id>` itself once
    the messages load.
- **`discordAuth.js`:**
  - `finishSignIn` also asks `GET /librarius/me` the way `askMembership` asks `/membership`: same timeout,
    false on any failure. It stores `librarius: boolean` in the sign-in record.
  - `currentMember()` returns `librarius`.
  - New `rememberLibrarius(access)` updates the stored record.
- **`auth` store:** a new action `noteLibrarius(access)` calls `rememberLibrarius` and then
  `this.member = currentMember()`.
- **`useNavLinks`:**
  - When `member.isMember`, the list is unchanged.
  - When `!isMember && member.librarius`, it's the base links plus Reliquarium (`section: true`).
- **`Reliquarium.vue`:**
  - It loads both stores: `gallery.load` and `librarius.load`.
  - The page is allowed when either is. "Restricted" only shows when both are `denied`, and "Sign in" when
    both are `signin`.
  - The tabs are `Librarius` (when librarius is `allowed`/`importing`), then the gallery's tabs (when the
    gallery is `allowed`).
  - The default tab is Librarius when available, else Clips.
  - On the `reliquarium-post` route it renders `PostPage`; on tab `librarius`, `TopicList`. When librarius is
    `importing` it shows "The Librarius is being brought over from Discord. Check back in a few minutes."
  - After `librarius.load` it calls `auth.noteLibrarius(access)`.
  - On sign-out it calls `librarius.reset()`, the same way it already resets the gallery.
  - The header lede becomes "The Librarius, clips and artwork from the Legion, kept in one place."

- [ ] **Step 1: Write the failing tests.**
  - Router: both routes resolve, and `/reliquarium/librarius/abc` is not found.
  - Back to a post restores the saved position, and a post with a hash gets `false`.
  - Reliquarium:
    - Librarius is the first tab;
    - a Librarius-only viewer (gallery 403, librarius allowed) sees only the Librarius tab, with no Clips;
    - a gallery-only viewer sees no Librarius tab;
    - both denied → "Restricted to the XVIIIth Legion.";
    - the default tab.
  - `discordAuth`: the stored `librarius` flag, and false on failure or timeout.
  - `useNavLinks`: the Librarius-only nav.
  - The no-v-html guard passes, and finds a planted violation.
- [ ] **Step 2: Run them and see them fail.** Step 3: Implement. Step 4: `bun run test` passes in full.
- [ ] **Step 5: Commit** `feat(librarius): the first Reliquarium tab, for whoever Discord lets read it`.

### Task 18: Content-Security-Policy

**Files:**
- Create: `scripts/csp.mjs`, `scripts/csp.test.mjs`, `scripts/check-csp.mjs`, `scripts/check-csp.test.mjs`
- Modify: `vite.config.js` (a build-only plugin), `.husky/pre-push`, both gated lists (`scripts/csp.mjs`)

**Interfaces:**
- **`scripts/csp.mjs`:**
  - `inlineScriptHashes(html) → string[]`: `'sha256-<base64>'` of each `<script>` without `src`, exactly as
    written between the tags.
  - `buildCsp({ apiOrigin, scriptHashes }) → string`, with exactly these directives:

```
default-src 'self'; script-src 'self' <hashes>; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https://cdn.discordapp.com https://media.discordapp.net https://*.discordapp.net https://*.r2.cloudflarestorage.com https://i.ytimg.com;
media-src 'self' blob: https://cdn.discordapp.com https://media.discordapp.net https://*.r2.cloudflarestorage.com;
font-src 'self' data:; connect-src 'self' <apiOrigin> https://discord.com;
frame-src https://www.youtube.com https://clips.twitch.tv https://medal.tv;
object-src 'none'; base-uri 'none'; form-action 'self'; manifest-src 'self'
```

    `apiOrigin` must be a bare `https://host[:port]`; anything else throws.
- **`vite.config.js`:** a plugin `{ name: 'csp-meta', apply: 'build', transformIndexHtml: { order: 'post',
  handler } }`.
  - It inserts `<meta http-equiv="Content-Security-Policy" content="…">` as the first child of `<head>`.
  - `apiOrigin` is the origin of `VITE_BUILDS_API_URL` from `loadEnv`.
  - Dev is untouched, because HMR needs inline scripts.
- **`scripts/check-csp.mjs dist`:** exits 1 unless `dist/index.html` has the meta, every inline script's hash
  is in `script-src`, and the policy has no `'unsafe-eval'` or `*` source.
- **`.husky/pre-push`:** after the mutation line, add `bun run build >/dev/null && node scripts/check-csp.mjs
  dist || exit 1`.

- [ ] **Step 1: Write the failing tests.**
  - The hash of a known script string.
  - The exact policy text.
  - `apiOrigin` with a path, `http:`, or `javascript:` throws.
  - `check-csp` against a temp dir with a good file, a missing meta, an unlisted inline script, and
    `'unsafe-eval'`.
- [ ] **Step 2: Run them and see them fail.** Step 3: Implement. Step 4: `bun run build && node
  scripts/check-csp.mjs dist` exits 0.
- [ ] **Step 5: Verify the production bundle in a browser,** using the method in memory
  `armouring-hall-2-live-check`.
  - Run `bun run preview`, then the cached `mcr.microsoft.com/playwright:v1.48.0-jammy` image with
    `--network host`.
  - Seed `localStorage['salamanders-discord-member']` with invented values.
  - Answer `builds-api.armorybot.win/**` and `discord.com/api/**` with `context.route` fixtures: gallery items
    with an R2 video and a YouTube embed; Librarius posts with an image, an emoji and an embed thumbnail.
  - Record `securitypolicyviolation` events on `/`, `/planner`, `/armoury`, `/builds`, `/companies`,
    `/accolades`, `/reliquarium/clips`, `/reliquarium/librarius`, a post page and `/deathwatch`.
  - **Expected: zero violations.** Widen a directive only for a source the site really uses, and add it to
    the policy test.
- [ ] **Step 6: Commit** `feat(site): a Content-Security-Policy on every page`.

### Task 19: The e2e loop

**Files:**
- Modify: `e2e/discord-mock/server.js`, `e2e/docker-compose.yml`
- Create: `e2e/tests/librarius-api.spec.js`, `e2e/tests/librarius.spec.js`

**Interfaces (all invented):**
- **The mock:**
  - **Ids:** forum `200000000000000400`; reader role `200000000000000401` (name `E2E Reader`, color
    `0x3a5246`); bot user `200000000000000499`.
  - **New users:**
    - `test-librarian-token` → `200000000000000402`, reader role only, **not** Legion;
    - `test-shut-out-token` → `200000000000000403`, reader role plus a member overwrite denying VIEW.
  - **Posts:** an active post `200000000000000410` with tag `200000000000000420` (`E2E Tag`), seeded with
    130 messages, and an archived post `200000000000000411` with 3.
  - **Guild route:** it gains `@everyone` permissions `'274877975616'` (VIEW, SEND, READ_MESSAGE_HISTORY,
    SEND_MESSAGES_IN_THREADS, ADD_REACTIONS) and the reader role with `name`.
  - **REST routes:**
    - `GET /v10/channels/<forum>`: overwrites deny `@everyone` VIEW, allow reader VIEW, deny shut-out VIEW;
      tags.
    - `GET /v10/guilds/<g>/threads/active` and `/v10/channels/<forum>/threads/archived/public`.
    - `GET /v10/channels/<post>/messages` (`after`, `limit`, newest first) and `/messages/<id>`.
    - `GET /v10/guilds/<g>/emojis`.
    - `POST /v10/attachments/refresh-urls`, echoing each URL with a later `ex`.
    - `GET /v10/gateway/bot` → `{ url: 'ws://discord-mock:4400/gateway', session_start_limit: { remaining:
      1000, reset_after: 0, total: 1000, max_concurrency: 1 } }`.
  - **Gateway:** a `Bun.serve` `websocket` at `/gateway`.
    - On open: HELLO with a 1000 ms interval.
    - On IDENTIFY or RESUME: READY with `user.id` = the bot.
    - Heartbeats get an ACK.
  - **Test hooks, each changing the REST state and broadcasting the dispatch:**
    - `POST /__test/librarius/message { post, content, authorId, attachments? }` → MESSAGE_CREATE
    - `/edit/:id { content }` → MESSAGE_UPDATE
    - `/delete/:id` → MESSAGE_DELETE
    - `/react/:id { emoji, userId }` → MESSAGE_REACTION_ADD
    - `POST /__test/librarius/drop { downMs }`: closes every socket with code 4000 and refuses upgrades for
      `downMs`.
    - `POST /__test/librarius/quiet-message` stores a message with **no** dispatch, for the catch-up test.
- **Compose:** the api gains `LIBRARIUS_CHANNEL_ID: '200000000000000400'`.

- [ ] **Step 1: Write the specs.** Each finds its own items, since other workers run in parallel.
  - **`librarius-api.spec.js`:**
    - **Parity:**
      - the librarian gets `access: true`;
      - `test-member-token` (Legion, no reader role) gets `access: false`, and `/librarius/posts` 403;
      - the shut-out user gets 403;
      - no token gets 401.
    - **The import:**
      - both posts are listed, the archived one flagged;
      - the active post has 129 replies;
      - the first page has 50 messages and `hasOlder`;
      - `before` reaches the start with no duplicates.
    - **Live:** a hook message shows in `/changes` within 5 s; then the edit, the delete (in `deleted`) and a
      reaction count.
    - **Catch-up:** `drop { downMs: 3000 }`, a `quiet-message` while down, then the quiet message is listed
      within 10 s of the reconnect.
    - **Read marker:** a PUT, then `unread` on `/posts` counts a later hook message.
  - **`librarius.spec.js`:**
    - Seed the librarian's sign-in the way the other browser specs do.
    - `/reliquarium` shows only the Librarius tab.
    - The topic list shows both posts (the archived one behind "Show archived").
    - Opening the post shows 50 messages; "Load older" adds more.
    - A hook message appears within 15 s.
    - "Open in Discord" points at `https://discord.com/channels/1322056087792521269/200000000000000410`.
- [ ] **Step 2: Run `bun run test:e2e`.** Expected: the new specs pass. A failure elsewhere gets a rerun first
  and is checked against `origin/main`; `layout.spec.js` is known red on main.
- [ ] **Step 3: Commit** `test(librarius): the whole loop against the Discord mock`.

### Task 20: Branch gate and hand-off

- [ ] **Step 1:** `bun run test && bun run test:coverage && bun run test:mutation`. Expect 100% on every gated
  file, the new ones included.
- [ ] **Step 2: Scrub.** `git diff origin/main --stat` and `git grep -n -E` for the real
  Discord channel id, the real verifier bot name and the real forum names (the owner holds the list; none of them
  may be written into this repo, this plan included) give no hits. Check every name in tests and fixtures
  against the memory rule `no-real-member-names-in-repo`.
- [ ] **Step 3:** Run `superpowers:requesting-code-review` on the branch, and fix what holds up.
- [ ] **Step 4:** Report to the owner:
  - the branch;
  - the gate output;
  - the rollout commands from the README section (schema, env, rebuild with tag `pre-librarius`, checks);
  - that the deploy and the PR are theirs.
