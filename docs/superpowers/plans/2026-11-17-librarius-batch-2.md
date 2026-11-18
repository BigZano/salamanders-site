# Librarius, batch 2 (site → Discord: replies) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member who can reply in the Librarius in Discord can reply from the site, with the markdown composer.
- The reply goes to Discord through one webhook under their server name and picture, readable in full in
  Discord.
- They can edit and delete it from the site, and "Delete on site" in Discord's Apps menu points them there.
- No member is ever struck by AutoMod or a spam filter because of the site.

**Architecture:** Builds on batch 1. Work on branch `feat/librarius-replies`, cut from `feat/librarius`; it is rebased onto `main` once batch 1 merges. New server modules:
- `librariusMarkdown.js`: the shared parser, moved from `src/lib/archive/markdown.js`, with an `extended`
  dialect added;
- `librariusForm.js`: an extended reply → Discord messages (Components V2, or plain), plus the splitter;
- `librariusSend.js`: validation, AutoMod copyable rules, mention cap;
- `librariusWebhook.js`: execute, edit, delete; the name cleaner;
- `librariusOutbox.js`: the durable queue and worker, with spacing, ceiling, breaker and no blind resend;
- `librariusUploads.js`: magic bytes and metadata stripping;
- `librariusLimits.js`: per-member rate limits;
- `librariusCommand.js`: the "Delete on site" interaction.

The site gains a composer, edit/delete/quote actions and a sending/blocked state on the post page.

**Tech Stack:** as batch 1. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-15-librarius-design.md`. Sections: "Composer", "Markdown: two dialects",
"Site → Discord", "Uploads", "Access", "Security", "No member is ever struck". Batch-1 rulings stand
(`.superpowers/sdd/2026-11-15-librarius-batch-1/progress.md`).

## Global Constraints

- **Everything from batch 1's Global Constraints holds**:
  - no new dependencies;
  - no live data in git;
  - ids are strings;
  - no tokens or signed links in logs;
  - no-store, fail-closed routes;
  - no `v-html`;
  - gated modules at 100% coverage and 100% mutation (scoped runs use `--concurrency 2`);
  - assert behaviour, never logs.
- **The webhook URL is a secret.** It lives only in `server/.env` as `LIBRARIUS_WEBHOOK_URL`, is never logged,
  never sent to a browser, and never appears in an error text.
- **Every Discord send goes through ONE builder** (`librariusWebhook.js` `sendBody`), which always sets
  `allowed_mentions: { parse: [], users: [...picked ids, max 10] }` and the form's flags. No other code
  posts to Discord with the webhook.
- **No-strikes numbers, verbatim from the spec:**
  - 3 replies a minute per member;
  - 20 edits a minute per member;
  - 30 uploads an hour per member;
  - parts of one reply at least 1500 ms apart;
  - at most 20 webhook messages a minute across all members;
  - at most 10 mentions a reply;
  - 2 Discord blocks within an hour pause all sending for 1 hour;
  - an AutoMod block (Discord error code 200000) is never retried.
- **Reply caps:**
  - at most 3 Discord messages a reply;
  - primary (Components V2) about 4000 text characters a message, so about 12,000 a reply;
  - fallback 2000 a message;
  - at most 10 images a reply, 10 MB each, PNG/JPEG/WebP/GIF only, judged by their bytes.
- **The site never creates a post (thread).** There is no route for it.
- **The probe (Task 1) only ever posts into `LIBRARIUS_PROBE_CHANNEL_ID`**, the owner's private test forum,
  never into the Librarius. It refuses to run if that id equals `LIBRARIUS_CHANNEL_ID`.

## Review Focus

1. **A reply that times out after Discord has already stored it must never post twice.** The outbox checks the
   thread's recent webhook messages first (Task 6).
2. **Splitting must never cut inside a code block, table, list item or a surrogate pair**, and the composer's
   meter and the server must agree to the character (Task 3, one shared module).
3. **A member who loses Send-in-Threads, is timed out, or meets a locked post mid-compose is refused at send,
   and keeps their draft.** The composer must not lose text on a 403 (Tasks 8, 10).
4. **A part of a site reply deleted in Discord removes the whole reply** on both sides, and any reactions on it
   (Task 6, ingest).
5. **Hostile markdown in the extended dialect** (footnote loops, a 6000-cell table, nested quotes past the cap,
   `upload:` refs to someone else's upload) is refused or rendered inert (Tasks 2, 4).

---

## Group A: the guild check (owner-run, gates everything that reaches the Librarius)

### Task 1: The probe (`server/src/librariusProbeRun.js`, not gated)
**Files:** Create `server/src/librariusProbeRun.js`. Modify `server/README.md` with a short "Batch 2 probe"
section.

**Behaviour.**
- **Config:** a CLI the owner runs inside the API container, reading `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`,
  `LIBRARIUS_CHANNEL_ID` and `LIBRARIUS_PROBE_CHANNEL_ID`.
  - It exits 2 with a plain message if the probe id is missing, is not a snowflake, or equals the Librarius id.
  - It exits 2 if the channel is not type 15 (forum).
- **Setup:**
  - it creates a webhook `Librarius probe` in the probe forum (`POST /v10/channels/:id/webhooks`);
  - it creates one post by webhook with `thread_name: "Librarius probe <ISO time>"` and a plain first message.
- **Sends, into that post (`thread_id`), with `wait=true`, `with_components=true` and `allowed_mentions:
  { parse: [] }`:**
  1. A V2 message (`flags: 32768`): one Container with a Text Display of exactly 3990 characters, a Separator,
     a Media Gallery with one PNG attached as `attachment://probe.png` (a 1×1 PNG built in code), and an
     action row with a link button "Open On Site" → `https://sm2salamanders.site/reliquarium/librarius`.
  2. A V2 message whose Text Displays total 4001 characters. Record the status and Discord's error text.
  3. A V2 message with `<@OWNER_ID>` in its text (the owner id from `GET /v10/guilds/:id`). The owner checks by
     eye that the mention renders and didn't ping them.
  4. A 3-part reply of about 11,500 characters in all. The parts are 1500 ms apart; part 1 is then edited
     (PATCH) to add jump links to parts 2 and 3.
  5. A plain message of exactly 2000 characters (`flags: 4`, SUPPRESS_EMBEDS).
  6. Three more replies within 60 s (the per-member cap burst).
  7. **Only with `--automod`:** one message containing the first keyword of the guild's KEYWORD AutoMod rule.
     Record the status and code (200000 = blocked).
- **Cleanup and report:**
  - Delete the probe webhook at the end. Leave the post for the owner to look at.
  - Print a table: each step, its HTTP status, Discord's code and message (links cut, no token), the time it
    took, and the returned message id.
  - Then print the owner's checklist, verbatim:
    > Open the probe post on desktop and on a phone. (a) Message 1 shows in full, the image sits inside the box, the button works. (b) Message 3 shows your name as a mention and you got no ping. (c) The 3-part reply reads in order with working jump links. (d) Search Discord for a word from message 1: is it found? (e) Your moderators' AutoMod alert channel shows nothing (or, with --automod, what it shows). (f) Your account has no timeout or warning. Reply with the table and a–f.

**Steps:**
- [ ] Step 1: Write it. Pure helpers (`buildV2(text, { image, button })`, `chunkText`) live in
  `librariusForm.js` once Task 3 exists. Until then, keep them local and import them later.
- [ ] Step 2: Smoke it against the e2e mock (add `/v10/channels/:id/webhooks` POST/DELETE and the webhook
  execute/edit routes to the mock; Task 13 extends them). Commit
  `feat(librarius): an owner-run probe of how Discord treats our replies`.
- [ ] **Step 3 (controller): owner runs it.** The controller gives the owner the one-line `!` command.
  - Batch 2 Groups B–D may be built meanwhile, behind `LIBRARIUS_WEBHOOK_URL` unset (all write routes
    answer 503).
  - Rollout waits for the owner's a–f.
  - If step 2 shows the V2 limit is below 4000, Task 3's `PRIMARY_LIMIT` becomes the measured value minus 50.
  - If (d) fails or V2 is refused, the form switch goes to `plain`.

## Group B: server

### Task 2: One parser for both sides, and the extended dialect (`server/src/librariusMarkdown.js`, gated)
**Files:**
- **Create:** `server/src/librariusMarkdown.js` (moved from `src/lib/archive/markdown.js`, no imports).
- **Modify:** `src/lib/archive/markdown.js`, which becomes `export * from '../../../server/src/librariusMarkdown.js'`
  so every archive import keeps working. Add a guard test in the style of `src/lib/gallery/sharedParser.test.js`.
- **Move tests:** `src/lib/archive/markdown.test.js` moves to `server/src/librariusMarkdown.test.js`. Swap the
  gated-list entries.

**Interfaces:** `parse(src, { dialect = 'discord' } = {})`, `parseInline`, `plainText`, `walk`, all as today.
Node types added only for `extended`:
- `heading` with `level` 4–6;
- `table { head: cells[], rows: cells[][] }`, where a cell is inline nodes; at most 50 rows × 10 columns;
  beyond that the table stays literal text;
- `divider`;
- `image { alt, ref }`, where `ref` is the N of `upload:N`, N = 1–10; any other image URL stays literal text;
- `footnoteRef { label }` and `footnotes [{ label, children }]`; a label matches `/^\w{1,20}$/`; at most 20
  footnotes; an undefined ref stays literal.

**The `discord` dialect also gains multi-line spoilers:**
- A `||` opened on one line closes on a later line of the same paragraph (no blank line between). This is
  batch 1's parked item.
- Prove it changes no archive page except those with a multi-line spoiler: `src/components/archive/real-render.test.js`
  must still pass locally.

**Tests:**
- every new node, at its limits and one past them;
- hostile: footnote self-reference, 10,000 `|`, `upload:0`, `upload:11`, `upload:1.5`, `![x](https://…)`;
- property tests: parse never throws on `fc.string()` in either dialect, and runs linearly (a 50k-character
  input in under 200 ms);
- the existing archive suite is green and unchanged.

**Commit:** `feat(librarius): one parser for site and server, with the site's extended markdown`.

### Task 3: The Discord form and the splitter (`server/src/librariusForm.js`, gated; shared with the site)
**Files:** Create `server/src/librariusForm.js` (no imports except `./librariusMarkdown.js`), plus its test.

**Interfaces:**
- **Constants:** `FORM = 'v2' | 'plain'` (exported `DEFAULT_FORM = 'v2'`), `PRIMARY_LIMIT = 3950`,
  `PLAIN_LIMIT = 1950` (50 kept back for markers and the footer), `MAX_PARTS = 3`.
- **`toDiscord(source, { form, authorId, replyTo: { authorId, url } | null, siteUrl, images: [{ ref, name }] })`**
  → `{ parts: [{ text, components | null, files: [names] }], length, overBudget: boolean }`. The flattening
  rules:
  - headings 4–6 become `**text**`;
  - a table becomes a fenced code block of cells padded to the column width;
  - a divider becomes a V2 Separator, or a blank line in plain;
  - footnotes go at the end of the part that cites them;
  - a V2 image becomes a Media Gallery item `attachment://<name>` in place; a plain image is attached under its
    part;
  - the reply line `-# ↪ <@id> [jump](<url>)` goes first;
  - the footer is `-# <@authorId>`, plus a link button "Open On Site" → `siteUrl` in V2, or the text line
    `-# <@authorId> · [Open On Site](<siteUrl>)` in plain.
- **`split(text, limit)`** → `string[]`. It breaks at a blank line; else at a line end outside a code fence, table
  or list item; else at a sentence end (`. ! ?` + space); else at a space; else hard, never inside a surrogate
  pair. Markers: every part is prefixed `**1/N** ` when N > 1. Part 1's links to the later parts come from
  `markers(ids)`.
- **`markers(partIds, threadUrlBase)`** → part 1's line `-# continues: [2/N](<url>) · [3/N](<url>)`, and the
  later parts' `-# [↑ from 1/N](<url>)`.
- **`budget(source, opts)`** → `{ used, limit: MAX_PARTS * limitFor(form), parts }`, which the composer meter
  uses.

**Tests:**
- every flattening rule;
- the splitter boundaries at the limit, limit + 1, a fence across the cut, a table across it, a list item, an
  emoji pair at the cut;
- `overBudget` at exactly 3 parts versus 4;
- properties: rejoined parts (minus markers) equal the input; every part ≤ limit; the parts never split a
  surrogate pair.

**Commit:** `feat(librarius): a site reply in Discord's form, split where a reader would`.

### Task 4: What a reply may hold (`server/src/librariusSend.js`, gated)
**Interfaces:**
- **`validateReply({ source, replyTo, mentions, uploads }, { form, automod, mentionCap = 10, ownUploadIds })`** →
  `{ ok: true, clean } | { ok: false, status, error, rule?, match? }`. Refusals, with this exact copy:
  - empty or whitespace → 400 "Write something first.";
  - over budget → 413 "That's longer than Discord can carry in 3 messages.";
  - a link that isn't http(s) → 400 "Links must start with http:// or https://.";
  - an `upload:N` not in `ownUploadIds` → 400 "That picture isn't one of yours.";
  - more than 10 mentions, or a mention not picked → 400 "Pick people to mention from the list (10 at most).";
  - an AutoMod match → 422 `"Blocked by the server's AutoMod rule \"<rule name>\"."` with `match`
    `{ start, end }` in the source.
- **`automodMatcher(rules, { memberRoleIds, isAdmin })`** → `(text) => null | { rule, start, end }`.
  - It applies type 1 (KEYWORD) rules with Discord's wildcard semantics: `*word`, `word*`, `*word*`, else a
    whole word; case-insensitive; the `allow_list` exempts.
  - Type 5 (MENTION_SPAM) is enforced as a cap at `min(10, mention_total_limit − 1)`.
  - Exempt: rules' `exempt_roles` and `exempt_channels` (forum id), and Administrator or Manage Server holders.
  - `regex_patterns` run with a 50 ms budget and a 10,000-character input cap, else they're treated as no match
    and logged once without the text. There are none today.
- **`cleanName(name)`**: 1–80 characters, "discord" and "clyde" removed case-insensitively, falling back to
  "Member".

**Tests:** each refusal; the wildcard table; allow list; exempt role; admin exempt; the mention cap at the
live 40 → 10; a regex timeout; and properties for the name cleaner.

**Commit:** `feat(librarius): a reply is checked against the server's own rules before it leaves`.

### Task 5: The webhook and its setup (`server/src/librariusWebhook.js`, gated; `librariusWebhookSetupRun.js`)
**Interfaces:**
- **`createWebhookClient({ fetchImpl, url, apiBase, timeoutMs = 15000, sleep, now })`.** `url` is
  `LIBRARIUS_WEBHOOK_URL`, parsed into id and token, and refused if it's not
  `https://discord.com/api/webhooks/<id>/<token>` (or the e2e mock's `http://discord-mock:4400/api/webhooks/…`
  when `apiBase` is http).
  - `send(threadId, body, files)` → message (`?wait=true&thread_id=&with_components=true`, multipart when there
    are files);
  - `edit(threadId, messageId, body)`;
  - `remove(threadId, messageId)`;
  - `recent(threadId, limit = 20)`, through the bot client (Task 6 passes `discord.newest`).
  - **Errors** are `WebhookError { status, code }`:
    - 401 or 404 on send → `fatal: true`;
    - Discord's JSON code 200000 or 200001 → `blocked: true`;
    - timeout → `unknown: true` (the message may have landed).
  - Messages never hold the URL or the token.
- **`sendBody({ form, part, username, avatarUrl, mentionIds })`** → JSON with `allowed_mentions: { parse: [],
  users: mentionIds.slice(0, 10) }` and flags `32768` (v2) or `4` (plain). It is the only body builder.
- **`librariusWebhookSetupRun.js`:** an owner-run CLI. It creates the webhook `Librarius` on
  `LIBRARIUS_CHANNEL_ID` with the bot token, prints `LIBRARIUS_WEBHOOK_URL=` and the value ONCE to stdout, and
  says to paste it into `server/.env`. It refuses if a webhook named `Librarius` owned by the app already exists
  (it prints its id and a delete hint).

**Tests:** URL parsing hostile battery; every error mapping; `allowed_mentions` never includes `everyone` or
`roles` for any input (property test); the multipart shape.

**Commit:** `feat(librarius): the one webhook, and one builder for everything it sends`.

### Task 6: The outbox (`server/src/librariusOutbox.js`, gated) and its tables
**Schema (`server/schema.sql`):**
- `librarius_outbox (id bigserial pk, kind text check (kind in ('send','edit','delete')), message_key text not
  null, author_id bigint not null, payload jsonb not null, state text not null default 'pending' check (state in
  ('pending','sending','sent','blocked','failed')), attempts int not null default 0, next_at timestamptz not null
  default now(), last_error text, created_at timestamptz not null default now())`;
- `librarius_parts (message_id bigint not null, part_index smallint not null, discord_id bigint primary key)`;
- `librarius_uploads (id bigserial pk, author_id bigint not null, name text not null, content_type text not
  null, bytes bytea not null, created_at timestamptz not null default now())`;
- `librarius_events (id bigserial pk, at timestamptz not null default now(), actor_id bigint not null, action text
  not null, post_id bigint, message_id bigint, note text)`;
- `librarius_messages` gains `origin text not null default 'discord'`, `source text` (the extended source),
  `state text` (null | 'sending' | 'blocked').

A site message has no id of its own: its id IS its first part's Discord id, once Discord returns it. Until
then it exists only as an outbox entry (keyed by `message_key`, a random 16-byte hex the route makes), and the
post page shows it from `GET /librarius/posts/:id/pending` (Task 8).

**Worker (`createOutbox({ store, webhook, discord, form, now, timers, log })`):**
- `start` / `stop` / `kick`. It runs one entry at a time, oldest `next_at` first.
- **Send:**
  - build the parts with `toDiscord`;
  - send part 1, then wait ≥1500 ms, then part 2, and so on;
  - after the last part, edit part 1's markers;
  - store the parts and upsert the message (`origin 'site'`, `source`);
  - delete its uploads;
  - log an event.
- **Webhook ceiling:** a sliding 60 s window allows 20 messages, and the worker waits past it.
- **No blind resend:** on `unknown`, read `recent(threadId)` and look for a message from our webhook whose text
  equals the part's text. If one is found, adopt it; otherwise resend once.
- **`blocked`:** state `blocked`, never retried. Count it toward the breaker: 2 in 3600 s pauses sending 3600 s.
  `/librarius/me` exposes `sendingPausedUntil` to Manage Messages holders.
- **`fatal`:** stop everything and log "The Librarius webhook was refused (status N): create it again with
  librariusWebhookSetupRun.". The routes answer 503 for writes until a restart.
- **Other failures:** retry at 5 s, 30 s, 2 min, 10 min, then `failed`.
- **Edit:** re-split; edit the parts in place; delete the surplus; append any new parts with `↑ from 1/N`;
  update part 1's markers. In an archived thread, unarchive (`PATCH /channels/:id {archived:false}`), edit, and
  archive again.
- **Delete:** remove every part via the webhook. A Discord-written message is deleted by the bot
  (`DELETE /v10/channels/:thread/messages/:id`).
- **Ingest changes (`librariusIngest.js`):**
  - ignore `MESSAGE_CREATE` and `MESSAGE_UPDATE` whose `webhook_id` is ours;
  - on `MESSAGE_DELETE` of any part, enqueue deletion of the other parts and delete the message row;
  - fold reactions on any part into the message.

**Tests:**
- ordering;
- 1500 ms spacing (fake timers);
- the ceiling at 20/60 s;
- `unknown` → adopt, and `unknown` → resend once;
- `blocked` → no retry, and the breaker at 2/hour;
- `fatal` stops;
- edits growing and shrinking;
- delete via webhook versus bot;
- echo ignored;
- a part deleted in Discord removes the whole message;
- a real-Postgres run of the new store methods in a throwaway container, as in batch 1.

**Commit:** `feat(librarius): the outbox, which never loses a reply and never sends one twice`.

### Task 7: Uploads (`server/src/librariusUploads.js`, gated)
**Interfaces:**
- `sniff(bytes)` → `'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | null`, judged by magic bytes.
- `strip(bytes, type)` → bytes with metadata removed:
  - JPEG: drop APP1 (EXIF/XMP) and APP13 segments, and keep every other segment byte for byte;
  - PNG: drop the `tEXt`, `zTXt`, `iTXt` and `eXIf` chunks;
  - WebP: drop the `EXIF` and `XMP ` chunks and fix the RIFF size;
  - GIF: drop comment extensions (0x21 0xFE).
- Refuse malformed input (a truncated segment or chunk) with `null`.

**Tests:**
- fixtures built in code with GPS-like EXIF payloads, which are absent after stripping;
- the image data is byte-identical after stripping (compare the IDAT bytes and the JPEG scan data);
- hostile truncations;
- a property test: strip(strip(x)) = strip(x).

**Commit:** `feat(librarius): pictures leave without the phone's location in them`.

### Task 8: Who may write, the write routes, rate limits and "Delete on site"
**Files:**
- modify `server/src/discordRoles.js` (`memberOf` gains `timeoutUntil` from `communication_disabled_until`);
- `librariusAccess.js` (the verdict gains `reply`, `attach`, `manageMessages`, `manageThreads`, `timedOut`);
- create `librariusLimits.js` (gated) and `librariusCommand.js` (gated);
- modify `librariusHandler.js` (routes) and `librariusGuild.js` (AutoMod rules cached with the guild facts and
  invalidated on `AUTO_MODERATION_RULE_*`);
- the intent `AUTO_MODERATION_CONFIGURATION` (1<<20) joins `INTENTS` in `librariusGateway.js` (it is not
  privileged), so rule changes reach the cache.

**Verdict:**
- `reply = canRead && SEND_MESSAGES_IN_THREADS && !timedOut && (!locked || MANAGE_THREADS)`. `locked` is
  checked per post in the route.
- `attach = reply && ATTACH_FILES`.

**Limits (`createLimits({ now })`):** sliding windows keyed by member: `reply` 3/60 s, `edit` 20/60 s,
`upload` 30/3600 s. Over the limit → 429 "Slow down a little: try again in N seconds.".

**Routes** (write routes always use a fresh verdict; 503 while `LIBRARIUS_WEBHOOK_URL` is unset or the webhook
is fatal):
- `POST /librarius/posts/:id/messages` with JSON `{ source, replyTo?, mentions[], uploads[] }` → 202
  `{ pending: { key, state: 'sending' } }`.
- `GET /librarius/posts/:id/pending` → the caller's own outbox entries for that post, with their state and
  `error`.
- `PATCH /librarius/messages/:id` `{ source, mentions[], uploads[] }`: the author of a site message only.
- `DELETE /librarius/messages/:id`: by its author, or by anyone with `manageMessages`. A whole post is never
  deleted here.
- `POST /librarius/uploads`: multipart, one image, ≤10 MB → `{ id }`. It is held at most 1 h, and a timer
  sweeps it.
- `GET /librarius/members?q=`: name or id search over the roster, filtered to people whose `permissionsIn` can
  read the Librarius, at most 10. It reuses `searchMembers` from `deathwatchPeople.js`.
- `/librarius/me` adds `can: { reply, attach, manageMessages }` and `limits`.

**"Delete on site" (`librariusCommand.js`):**
- On READY, ensure the guild message command exists: `GET /v10/applications/:app/guilds/:guild/commands`; if no
  `Delete on site` of type 3 is found, `POST` it. Never bulk-overwrite, because other commands may exist.
- `INTERACTION_CREATE` with that command: reply with `POST /v10/interactions/:id/:token/callback`
  `{ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } }` within 3 s, and the copy from the
  spec's three cases verbatim. The jump link is `https://sm2salamanders.site/reliquarium/librarius/<post>#m-<id>`.

**Tests:**
- the verdict table (timed out, locked, attach);
- limits at the edge (3 then the 4th; window slide);
- every route's gates, statuses and copy;
- members search filtered by read permission;
- command ensure (exists → no POST; missing → one POST);
- interaction answers for all three cases, and its 3 s deadline (fake timers: a slow DB still answers with the
  fallback "Couldn't check right now; open it on the site:" plus the link).

**Commit:** `feat(librarius): members reply from the site, within Discord's rules and the server's`.

### Task 9: Wiring, env, README
- **`index.js`:** create the webhook client, outbox, limits, upload sweeper and command; start the outbox after
  the gateway; give `onDispatch` the command handler.
- **Config:** `LIBRARIUS_WEBHOOK_URL` in compose and `.env.example` (marked SECRET), plus `LIBRARIUS_FORM`
  (`v2` | `plain`, default `v2`, chosen from the probe).
- **README:**
  - setup order: run the probe → owner OK → setup CLI → paste the URL → rebuild → the live check (reply from
    the site; it shows in Discord, readable in full; edit; delete; the Apps-menu command);
  - rollback;
  - the no-strikes guarantees in plain words.
- **Commit:** `feat(librarius): wire the replies in`.

## Group C: site

### Task 10: The composer (`src/components/librarius/Composer.vue`, `src/lib/librarius/composer.js` gated)
Layout A, exactly the spec's sketch.
- **Editing:**
  - a textarea plus the toolbar `H1 H2 H3 | B I U S spoiler | ❝ {} • 1. | 🔗 🖼 ▦ ― @ 😀 | -#`. Every button
    calls a pure `apply(text, selection, action) → { text, selection }` in `composer.js`;
  - Preview and Discord view tabs, which use `parse(…, { dialect: 'extended' })` and the archive renderer, and
    `toDiscord`;
  - full screen;
  - the reply-to bar with the @-ping toggle.
- **Budget:** the meter from `budget()`, and Reply is disabled when over.
- **Drafts:** saved in `localStorage` under `lb-draft:<postId>:<replyTo|new>`, debounced 1 s, cleared on a
  successful send and on sign-out.
- **@ mentions:** a popover using `useMemberSearch` against `/librarius/members`, which inserts `<@id>` and
  shows `@Name` in the preview.
- **Emoji:** a port of the Req_bot `EmojiPicker.vue` without its stores. It takes `custom` (from
  `/librarius/emoji`) and the standard list (copy `emojis.json` to `src/data/emojis.json`).
- **Images:** upload, drag or paste → `POST /librarius/uploads` → insert `![name](upload:N)`; at most 10.
- **Errors:**
  - a 422 AutoMod refusal shows the alert with the rule name and highlights `match` in the textarea;
  - a 429 shows its copy;
  - a 403 keeps the text and shows "You can't reply here right now.".
- **Tests:**
  - `apply` for every action (gated);
  - the component: preview equality with the post page renderer; the draft round-trip; the over-budget
    disable; the AutoMod highlight; a 403 keeps the text.
- **Commit:** `feat(librarius): the composer`.

### Task 11: Replying, editing, deleting and quoting on the post page
- **Store (`stores/librarius.js`):** `reply`, `edit`, `remove`, `upload` and `pending` (polls
  `/pending` every 3 s while anything is `sending`).
- **PostPage:**
  - **Composer:** docked at the bottom, shown only when `me.can.reply`; a locked post shows "This post is
    locked."
  - **Actions:**
    - Reply (sets replyTo);
    - Quote (inserts the selected text as `> …` lines plus replyTo);
    - Edit (own site messages: opens the composer with the source);
    - Delete (own messages, or any with manageMessages; confirm "Delete this message? It goes from Discord too.").
  - **States:** a pending message shows greyed with "sending…". A blocked one shows "Blocked by the server's
    rules. Edit it or delete it.". A failed one shows "Couldn't send. Try again." with Retry.
  - **The "site" tag** shows on `origin: 'site'` messages.
- **Batch-1 parked items folded in here:**
  - a mid-read 401 → the sign-in prompt, never a silent tab loss;
  - a second reset with the same rev → one forced reopen at the 5-minute cap;
  - poll refreshes `info` (locked, title, replies) every 6th poll.
- **Tests:** each action, state and parked fix (store: gated).
- **Commit:** `feat(librarius): reply, quote, edit and delete from the post page`.

## Group D: end to end

### Task 12: The posting loop against the mock
- **Mock:**
  - webhook create, execute (JSON and multipart, V2 components stored), edit, delete and list recent;
  - an AutoMod rule list (one KEYWORD rule with an invented word), and execute answering 200000 for that word;
  - guild commands list and create;
  - interaction dispatch through the gateway hook `POST /__test/librarius/interaction`, with the callback route
    recorded;
  - THREAD_UPDATE (lock) and an intents check on IDENTIFY: refuse without bit 1<<15 with close 4014.
- **Specs (`librarius-write.spec.js` API; `librarius-compose.spec.js` browser):**
  - reply → in Discord (mock) as V2 with the footer and allowed_mentions empty → on the site with the site tag;
  - a 3-part reply spaced ≥1.5 s with markers edited in;
  - edit; delete;
  - a part deleted in Discord removes all of it;
  - AutoMod word refused on the site with 422 (nothing reached the mock);
  - rate limit 4th reply → 429;
  - a locked post → no composer;
  - the Apps-menu interaction answered ephemeral with the link;
  - an upload stripped of EXIF on arrival at the mock;
  - restore batch 1's author-name check in the live test.
- **Run:** `bun run test:e2e` twice and report. The three known layout reds may stay.
- **Commit:** `test(librarius): replies end to end`.

### Task 13: Gate and hand-off
- Full pre-push gate (mutation at concurrency 2); scrub (no live data); Fable final review of the branch; one
  fix wave; PR with the README rollout first in its body.
