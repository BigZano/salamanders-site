# Builds API

## Database roles

The API connects as `salamanders_app`: it can read and write the tables and
nothing else (not a superuser, cannot create roles or tables). `salamanders`
(`POSTGRES_USER`) owns the tables and is for admin work such as applying
`schema.sql`. Roles live in the cluster, not the database, so create the app role
once on a fresh volume, and do it **before** restoring a dump into one: the dump's
`GRANT`s name the role, and `pg_restore` stops at the first one if it does not exist.
Put `APP_DB_PASSWORD` in `server/.env` and export it in your shell, then:

```sh
{ printf '\\set app_password '"'"'%s'"'"'\n' "$APP_DB_PASSWORD"; cat app-role.sql; } \
  | docker compose exec -T db psql -U salamanders -d salamanders_builds -v ON_ERROR_STOP=1
```

It is idempotent. Tables added later by `schema.sql` are covered automatically.

## Archive key (`GET /archive/key`)

Hands the Legion Archive decryption key to a caller whose Discord token is
valid and who holds the `ARCHIVE_ROLE_ID` role in the guild. Both are checked
live against Discord on every request: there is no member list and no cache, so
a role granted or removed takes effect at once. Anything uncertain fails closed:
401 (no well-formed Bearer token, or Discord rejects it; sign in), 403 (signed in
but without the role), 503 (`ARCHIVE_KEY` or the role id not set, the guild id or
bot token not set, or Discord could not be reached). A request without a
well-formed Bearer token is answered 401 before the guild id or bot token is
looked at; a caller with a well-formed token gets 503 while either is unset. An
unset `ARCHIVE_KEY` or role id is 503 for every caller.

| Variable | Value |
|---|---|
| `ARCHIVE_KEY` | base64 key from `archive-export/.env` (also stored in a password manager) |
| `ARCHIVE_ROLE_ID` | `1377787723976409211` (XVIIIth Legion). The guild's member role: used for the archive key, `GET /membership` and the member flag on the builds list, so narrowing it changes who counts as a member across the site |
| `DISCORD_GUILD_ID` | required |
| `DISCORD_BOT_TOKEN` | required — the caller's roles are read with it |

Until the required values are set, a caller with a well-formed token gets 503
and the site shows "couldn't be reached" (see above for who still gets 401).
Rotating the key (`bun run archive keygen --rotate`,
then `seal --publish`) requires updating `ARCHIVE_KEY` here and redeploying.

## Member reports (`/reports/*`)

XVIIILegion members file; Reclusiarchs claim, resolve or escalate (via a
pre-filled link to High Command's official form); Administrators read and can
reopen. Roles are checked live against Discord on every request. Reports and
their `report_events` audit rows are kept permanently. Design:
`docs/superpowers/specs/2026-09-26-member-reports-design.md`.

Env: `REPORTS_WEBHOOK_URL` (secret; leadership channel ping, id + link only),
optional `REPORTER_ROLE_ID` / `RECLUSIARCH_ROLE_ID` overrides.

**Existing databases:** `schema.sql` only runs automatically on a fresh volume.
Apply the new tables once (idempotent):

```sh
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U salamanders salamanders_builds < schema.sql
```

Perk corrections (2026-09-27) added tables and two `builds` columns; re-run
`schema.sql` (idempotent, command above) **before** rebuilding or starting the
new API image — the new `listBuilds` reads `builds.deleted_at`, so the API
errors until the column exists. Then seed once with `docker compose exec -T api bun
run src/seed.js < ../src/data/perk-corrections.json`. `DISCORD_MOD_ROLE_ID` is
no longer read; moderator roles live in `src/privileges.js`.

## Notable server members (`GET /company-notables`)

The Companies page's Notable Server Members cards are real members' names and write-ups, so they are kept in
the database (`company_notables`, one row per company) and never in the repo or the site's bundle. The route
answers 200 `{ companies: { <companyId>: [[name, ...lines], ...] } }` to a signed-in guild member (the same live
check as `/membership`), 401 with no or an invalid token, 403 to a signed-in non-member and 503 when Discord
cannot answer. Every answer is `private, no-store`.

To change the entries, write a JSON object of `companyId` → `[[name, ...lines], ...]` to a file outside the repo
(it holds real names), then, from this folder:

```sh
docker compose exec -T api bun run src/seedNotables.js < /path/outside/the/repo/notables.json
```

It prints counts only, never a name, and is safe to re-run. Each company in the file gets its entries replaced, an
empty list takes that company out, and companies the file does not name are left alone. A document it cannot store
is refused with the position of the fault (`company 3, entry 2`), not the text.

## Deathwatch (`/deathwatch/*`)

The Discord-role-gated Deathwatch area ("Watch Fortress Ebonhold"). Design:
`docs/superpowers/specs/2026-10-20-deathwatch-design.md`. Access comes from Discord roles, asked live (the bot only
reads them: it never gives or removes a role), and from what the Watch Commander gives people by hand in
Administratum → Access (`deathwatch_access`). Commander status comes only from the Commander role. Reads (`/me`,
`/data`, `/deployment`, `/members`, `GET /access`) reuse a verdict for 30 seconds; every write checks Discord afresh,
and every access change drops the cached verdicts. Any Discord failure answers 503: the area fails closed.

Given by hand, per person: `deathwatch` (the general level, `deployment`), `watchcommand` (as the Deathwatch Command
role) or `desk` (runs the Administratum desk; also `deployment`). It counts only for a guild member whose present
membership began before it was given: leaving the guild ends it for good, and the server removes it (actor
`left-guild`) when it notices. Admins (the guild owner, or a role with Administrator; read every five minutes) see
the Administratum and change nothing.

| Endpoint | Who | Notes |
|---|---|---|
| `GET /deathwatch/me` | any signed-in user | `{ access, watchCommander, deathwatchCommand, roles }`; never 403 |
| `GET /deathwatch/data` | access | `{ teams, cfg, archive }`; `ETag`, 304 on `If-None-Match`; 403 without access. `teams` and `archive` only to the Watch Commander and `deployment` |
| `GET /deathwatch/deployment` | Watch Commander, `deployment` | `{ members, faces }`: who holds `DEATHWATCH_ROLE_ID`, and the Legion/Emissary members the tracker names, from the roster's member cache (no extra Discord calls); 503 until that has loaded |
| `POST /deathwatch/doc` | Watch Commander, `desk` | `{ col, id, op: 'set' \| 'delete', doc }`; JSON content type required |
| `GET /deathwatch/members?q=` | Watch Commander | `{ members: [{ id, name, avatar }] }`, at most 10: a 17–20 digit `q` is that member, otherwise 2+ characters of a display name, prefix matches first; from the roster cache; 503 until it has loaded |
| `GET /deathwatch/access` | Watch Commander, `desk`, `admin` | `{ people: [{ id, kind, name, avatar, grantedBy, grantedAt }] }`; first removes anyone who has left the guild since (not while the roster is still loading) |
| `POST /deathwatch/access` | Watch Commander | `{ discordId, kind }`; 201 new, 200 if already active, 404 "Not in the server." (asked of Discord live, so a new member is found at once), 409 at 1000 active. Anything given before the person last left the guild is removed first |
| `DELETE /deathwatch/access/:discordId/:kind` | Watch Commander | removes; 404 if none is active |

Limits: collections `teams`, `cfg`, `archive`; ids match `^[A-Za-z0-9_-]{1,64}$`; a
document is a JSON object of at most 1 MB with no U+0000 or lone surrogate (Postgres
`jsonb` cannot store them); a request body is at most 2 MB (the server refuses more than
12 MB outright); `discordId` is 17 to 20 digits. Document edits and access changes are
recorded in `deathwatch_doc_history` and `deathwatch_access_events`, in the same
transaction as the change. (`deathwatch_grants` and `deathwatch_grant_events` are the old grants, no longer used.)

| Variable | Value |
|---|---|
| `DEATHWATCH_ROLE_ID` | the Deathwatch Deployment role id, or several separated by commas with no spaces (a holder of any one is `deployment`, as is Deathwatch Command, anything given by hand, the guild owner or an Administrator) — no default, required |
| `WATCH_COMMANDER_ROLE_ID` | the Watch Commander role id: opens everything — no default, required |
| `DEATHWATCH_COMMAND_ROLE_ID` | the Deathwatch Command role id (one id, not the Watch Commander's) — optional. Its holders are `command` and `deployment` (and `deathwatchCommand: true`). Unset or not a single id, nobody holds it and nothing else changes |
| `EMISSARY_ROLE_ID` | the Emissary role id (one id) — optional; its holders are `emissary`. The Legion role (`rosterLadder.js`) gives `legion` |
| `XENOSBANE_SIGIL_ROLE_ID` | the Xenosbane Sigil award role id — optional; its holders are `xenosbane` |
| `VIGILIA_MORTIS_ROLE_ID` | the Vigilia Mortis in Aeternum award role id — optional; its holders are `vigilia` |
| `KILL_MARINE_ROLE_ID` | the Deathwatch Kill-Marine award role id — optional; its holders are `killmarine` |

`GET /deathwatch/me` answers `roles`: the standings the caller holds (`legion`, `emissary`, `deployment`,
`command`, `xenosbane`, `vigilia`, `killmarine`, `desk`, `admin`). Any standing, or the Watch Commander role, lets
them into the area; which parts open to which standings is fixed in the site's `src/lib/deathwatch/areas.js`. The
server keeps the Event Tracker's documents and every write itself; the site's locks guard only static texts.

Until **both** are set every `/deathwatch/*` route answers 503 "not configured". The role
ids are supplied at deploy time and never committed. To deploy: set both in `server/.env`,
apply the schema (idempotent, command in the reports section above) before starting the new
image, then restart the API. An image with `deathwatch_access` needs `schema.sql` applied first. The one-time import of the old site's data is a separate job.

## Reliquarium (`/gallery/*`)

Members-only galleries: gameplay clips polled from a Discord channel, and artwork
uploaded on the site and approved before anyone sees it. Design:
`docs/superpowers/specs/2026-11-02-reliquarium-design.md`. Access is the
XVIIIth Legion role (`REPORTER_ROLE_ID`), or being the guild owner or an
Administrator. An approver is someone with access who also holds the Reclusiarch,
Captain, Legion Hierarchy or curator role, or is an Administrator. Roles are asked
of Discord live. Reads reuse a verdict for 30 seconds; every approve, reject, hide,
upload and removal checks Discord afresh. Any Discord failure answers 503.

| Who | May |
|---|---|
| member | view clips and art, submit art, remove their own items, see their own submissions and why one was rejected |
| approver | also read the review queue, the poll status and the audit trail; approve, reject (with a reason) and hide anything |

| Endpoint | Who | Notes |
|---|---|---|
| `GET /gallery/me` | any signed-in user | `{ access, approver }`; never 403 |
| `GET /gallery/clips?before=<id>` | member | 24 approved clips, newest first: `{ items, next }`; `next` is the next page's `before`, or null |
| `GET /gallery/art?before=<id>` | member | the same for art |
| `GET /gallery/mine` | member | `{ items }`: the caller's own items in every status |
| `POST /gallery/art` | member | multipart form: `file`, `title`, optional `note`; 201 `{ item }`, pending review |
| `DELETE /gallery/items/:id` | the item's owner | for good: the row, its trail and its file go (R2 now, the backup tonight); 204; 404 if not theirs or gone, 409 if hidden or removed |
| `GET /gallery/review` | approver | `{ items, sync }`: the pending queue and the clips poll's `lastRunAt`, `lastOkAt`, `lastError` |
| `POST /gallery/items/:id/approve` | approver | from pending or rejected; `{ item }` |
| `POST /gallery/items/:id/reject` | approver | JSON `{ reason }`, required; from pending; `{ item }` |
| `POST /gallery/items/:id/hide` | approver | optional JSON `{ note }`; from pending, approved or rejected; `{ item }` |
| `GET /gallery/events?before=<id>` | approver | 100 audit rows, newest first: `{ events, next }` |
| `GET /gallery/takedowns` | approver | `{ items }`: rejected, hidden or removed pieces whose file R2 or the backup still holds |
| `POST /gallery/items/:id/erase` | approver | Delete for good: the file leaves R2 now and the backup tonight; the row and trail stay; 204; 409 if live or erased already |

An item carries `url`: a presigned R2 link valid 15 minutes for a stored file, or the
Medal / YouTube / Twitch link for an embed. The bucket is private; that link is the
only way to a file. A status change the item does not allow answers 409, an unknown id 404.

Limits: an upload is one JPEG, PNG, WebP or GIF of at most 10 MB, checked by its
bytes, not its name or declared type; a title is 1 to 120 characters and a note at
most 500; a rejection reason 1 to 500. A JSON body is at most 16 KB. No row is ever
deleted: every change writes a `gallery_events` row in the same transaction.

**Storage** (`galleryPolicy.js`). R2's free tier is 10 GB, so the store holds at most 9 GB,
counted from the rows' own sizes. Past 7 GB only `#gameplay` clips are copied; past 9 GB
nothing is, and an art upload answers 507. A clip that does not fit is skipped before it is
downloaded and named on the Review tab's poll line. A link holds no file and always goes in.
A file whose item has been rejected, hidden or removed for 30 days leaves R2 once the nightly
backup holds it (`galleryPurge.js`, run by `backup/salamanders-r2-backup`): the row and its
trail stay, `file_purged_at` is set, a `file_purged` event names the storage purge, and the
item can no longer be approved. The backup copy goes 60 days after the takedown. A member's own
removal, an approver's Delete for good and the owner's `salamanders-r2-backup --erase-item <id>` /
`--erase-member <discord id>` do not wait: the key goes into `gallery_erasures` (nothing else is
kept there), the file leaves R2 at once and the backup that night, and the note is dropped once
both are gone. A member's removal and the owner command also delete the row and its trail.

**The clips channel.** Posting in it is the publish step: the poll (every 2 minutes)
copies each video or image attachment into R2, and records Medal / YouTube / Twitch links
as embeds. A message tagged `#gameplay` (anywhere in its text, outside its links; the tag
is taken out of the title) goes straight on the site, files and Medal links alike. Anything
untagged, and every YouTube or Twitch link whatever its tag (nothing says the poster made
the video), waits in the review queue, its file already copied so an approver can watch
it. Attachments over 100 MB are skipped. An
attachment that cannot be copied (a dead Discord link, a file R2 refuses, a copy that cannot
finish in two minutes) is skipped too and named on the Review tab's poll line; the
back-catalogue job can pick it up later. Deleting
the message in Discord removes the clip from the site, or from the review queue (the newest
50 are checked every pass, all of them hourly); an approver can also hide one. The first pass only notes the
newest message: clips posted before launch are not imported.

| Variable | Value |
|---|---|
| `GALLERY_CHANNEL_ID` | the clips channel id — no default, required |
| `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | the private bucket and an API token scoped to it alone — no defaults, required; the secret lives in `server/.env` only |
| `GALLERY_CURATOR_ROLE_ID` | the curator role id — optional. Unset, nobody is curator and the other approver roles still work |
| `GALLERY_POLL_MS` | how often the poll runs, in ms — optional, default 120000; a value under 1000 is raised to 1000 |
| `R2_ENDPOINT` | for the e2e stack's mock R2 only; leave unset in production. Scheme and host[:port] only, no path (`http://discord-mock:4400`): a path, query or credentials make the client refuse it, and every `/gallery/*` route answers 503 |
| `REPORTER_ROLE_ID`, `RECLUSIARCH_ROLE_ID` | shared with member reports (see above); default in code |

Until the channel id and all four R2 values are set, every `/gallery/*` route answers 503
"not configured" and the poll does not start, so the image may ship first. When some of
these variables are set but they do not make a working gallery, the API logs one warning at
startup naming each one missing or refused (never its value).

**Bot permissions, once:** View Channel and Read Message History on the clips channel,
and the Message Content intent toggle on the bot's page in the Discord Developer Portal
(without it, messages come back with no attachments or text).

Rollout:

1. Create the private R2 bucket (no public access, no custom domain) and an API token
   scoped to that bucket alone. Put the R2 values, `GALLERY_CHANNEL_ID` and (if wanted)
   `GALLERY_CURATOR_ROLE_ID` in `server/.env`.
2. Apply `schema.sql` (idempotent, command in the reports section above), then start the
   new API image. The storage purge (2026-11-07) added `gallery_items.file_purged_at` and the
   `file_purged` event: apply `schema.sql` **before** starting an image that has it, since
   every approval reads that column.
3. Grant the bot the permissions above. The first pass seeds the cursor; watch the
   Review tab's poll status for `lastOkAt` and an empty `lastError`.
4. Merge the site; the Reliquarium nav entry appears for members only.
5. Back the bucket up and run the purge: `backup/salamanders-r2-backup` nightly (see
   `backup/README.md`). It copies, never syncs: the backup keeps the files the purge takes out.

The one-time import of the channel's back catalogue is a separate job.

## Librarius (`/librarius/*`)

The guild's Discord forum, read on the site: the posts and their messages are copied into Postgres (the import,
then the gateway's live events), and the site reads that copy. Nothing here writes to Discord. Design:
`docs/superpowers/specs/2026-11-15-librarius-design.md`. Access follows the forum in Discord: a member may read it
here exactly when Discord would let them open it, worked out from the guild's roles and the forum's permission
overwrites (View Channel and Read Message History, `librariusPerms.js`). The guild owner and Administrators read it
too, as in Discord, and a role the forum shuts out does not. Every route reuses a verdict for 30 seconds, marking a post
read included: it writes only the caller's own read mark. The guild and the forum that a verdict is drawn from are kept for
5 minutes, and the gateway's role and channel events drop them at once; if such an event is lost, a change to a role or to
the forum's overwrites takes effect within about 5.5 minutes (the 5 minutes of the cache and the 30 seconds of the verdict).
Any Discord failure answers 503, and responses are never cached.

| Endpoint | Who | Notes |
|---|---|---|
| `GET /librarius/me` | any signed-in user | `{ access }` for someone who may not read the forum; for a reader also `ready` (the import has finished), `tags`, `roles`, `guildId`, `forumId`; never 403 |
| `GET /librarius/emoji` | reader | `{ emoji }`: the guild's custom emoji |
| `GET /librarius/posts` | reader | `{ posts, people }`: every post with its tag ids, its latest message, its posters and the caller's unread count |
| `GET /librarius/posts/:id` | reader | `{ post, lastRead, rev }`; opening a post marks it viewed, which keeps its attachment links fresh |
| `GET /librarius/posts/:id/messages` | reader | one page: `?limit=` (1 to 100, default 50) and at most one of `before`, `after` or `around` (a message id); `{ messages, hasOlder, hasNewer, people, rev }` |
| `GET /librarius/posts/:id/changes?since=<rev>` | reader | what changed after `rev`: `{ messages, deleted, rev, people }`, or `{ reset: true }` when too much did and the page must be read again; 404 once the post is gone (deleted in Discord), which is how a page left open learns it |
| `PUT /librarius/posts/:id/read` | reader | JSON `{ messageId }` (at most 1 KB): how far the caller has read; 204 |

A route that is not listed answers 404, an unconfigured Librarius 503, no identity 401 and no read permission 403
(except `/librarius/me`). A post or message id that is not a snowflake never reaches the database: a post is 404, a
cursor 400. Attachment links are signed by Discord and lapse. The link refresh (every 10 minutes) renews, up to 200 a
pass, those that lapse within two hours of posts viewed in the last day. A read renews the first 50 links on its page that
lapse within five minutes; any beyond those wait for the next pass, which is at most 10 minutes away. A link Discord
cannot be reached to renew stays as it is until it can, so a reader may be shown one that has lapsed for as long as
Discord is down.

| Variable | Value |
|---|---|
| `LIBRARIUS_CHANNEL_ID` | the forum channel's id (17 to 20 digits) — no default, required. Not a secret, but live data: `server/.env` only |
| `DISCORD_GUILD_ID`, `DISCORD_BOT_TOKEN` | shared with the rest of the API — required |

The Librarius is on only when all three are set (and the forum id is a channel id). Otherwise every `/librarius`
route answers 503 "not configured" and nothing starts (no gateway connection, no timer, no import), so the image may
ship first. The API logs one warning at startup saying which, never a value. When it is on, the API starts, after it is
listening: the roster warm-up, the posts load, the import (in the background), the import's timer, the link refresh
timer and the gateway connection. The import comes round on its own: once after start, again after every gateway READY,
and 6 hours after the last run ended whoever started it. A run that fails is tried again after 5, 10 and 20 minutes, then
every 30 minutes, and a run that finishes starts the steps over. A step that fails to start is logged as `Librarius: ...`
(never the token or a link) and the rest go on; none of it can keep the API from listening. Once the API is listening, a rejection or
exception that nothing handles is logged the same way and no longer ends the process; a failure while it is starting (the
port taken, say) still does, so that docker restarts it.

**Bot permissions:** View Channel and Read Message History on the forum (granted 2026-11-15), and the Message Content
intent toggle on the bot's page in the Discord Developer Portal, already on for the Reliquarium (without it the gateway
is refused).

**The port.** `docker-compose.yml` publishes the API as `127.0.0.1:8787:8787`: on the host's loopback only. The Cloudflare
tunnel runs on the host and reaches it there; nothing else on the LAN can. `src/composePorts.test.js` pins this. The
tunnel's ingress may still say `localhost`, which can resolve to `::1`, where a bind to `127.0.0.1` does not answer: set
`http://127.0.0.1:8787` in the cloudflared config. The public `/health` check below proves that the tunnel reaches the API
either way. Beware of any other checkout of this repository on the host that has an older `server/` compose file (the same
compose project name, publishing `'8787:8787'`): running `docker compose up` there would replace the live API and open the
LAN port again. Do not run it from anywhere but the checkout the API is deployed from.

**Rollout order: the API first, the merge to `main` after.** Rebuild and configure the API from the `feat/librarius` branch
(steps 1 to 4 below), and wait for `import_done`, **before** merging the branch to `main`: the site deploys the moment it
merges. The new API is additive and safe for the old site, which never asks for it. The new site against the old API is not:
it shows every Legion member "The Librarius couldn't be reached." until the API is rebuilt.

Rollout:

1. Apply `schema.sql` (idempotent, command in the reports section above) **before** starting the new image: the tables
   are `librarius_*`.
2. Set `LIBRARIUS_CHANNEL_ID` in `server/.env`.
3. Rebuild the API, keeping the rollback tag: `docker tag server-api:latest server-api:pre-librarius` first, then
   `docker compose up -d --build api`. To go back: `docker tag server-api:pre-librarius server-api:latest && docker
   compose up -d --no-build --force-recreate api`. Once the site has been merged, going back is not so simple: see
   "Rolling back" below.
4. Check, **before the merge**. The site has no Librarius yet, so these go to the API and the database directly. A call
   that needs a reader takes the Discord token of someone who may read the forum: sign in to the site as that person, and
   in the browser console run `JSON.parse(localStorage.getItem('salamanders-discord-member')).accessToken`. Put it in
   `TOKEN` in the shell that runs the checks, and nowhere else (it is as good as the sign-in, until it expires).
   - `curl -s -o /dev/null -w '%{http_code}' localhost:8787/librarius/me` answers 401;
   - `curl -s <the API's public address>/health` (the address `VITE_BUILDS_API_URL` names) answers `{"ok":true}`: the tunnel
     still reaches the API now that the port is bound to the loopback;
   - `docker compose logs api` shows no "Librarius is not configured";
   - `docker compose logs api` shows no "The Librarius gateway closed with code" for 4004 or 4010 to 4014. Those stop the
     gateway for good, and the forum then goes stale until the cause is fixed and the API is restarted: 4014 means the
     Message Content intent is off for the bot. The other codes (4000 and 4007 to 4009 among them) are reconnects that the
     client makes by itself, and are normal;
   - the import finishes: the first command shows `import_done` true and an empty `last_error`, and the second says
     `"ready":true`:

     ```sh
     docker compose exec -T db psql -U salamanders salamanders_builds -c 'select import_done, last_error from librarius_sync;'
     curl -s -H "Authorization: Bearer $TOKEN" localhost:8787/librarius/me
     ```
   - the live feed works. In a post of the forum, in Discord, post a message, edit it, react to it, and delete a message
     (one you posted for this). Then run the query below, with the post's id in place of `<post id>`: within about 10
     seconds the new message is there, the edit shows in `edited_at` and `content`, the reaction in `reactions`, and the
     deleted one is gone.

     ```sh
     docker compose exec -T db psql -U salamanders salamanders_builds -c "select id, left(content, 40), edited_at, reactions from librarius_messages where post_id = <post id> order by id desc limit 5;"
     ```

   - port 8787 is no longer reachable from another machine on the LAN;
   - a link refresh moved links forward. Pick one post whose files were imported a day or more ago, so that their links
     have lapsed or lapse within two hours (a link further off is left alone, by design). Note their `expires_at` with
     the query below (its post id in place of `<post id>`). Then have the API read that post, as a reader would:
     `curl -s -H "Authorization: Bearer $TOKEN" localhost:8787/librarius/posts/<post id>` (which opens it, and so marks it
     viewed) and `curl -s -H "Authorization: Bearer $TOKEN" localhost:8787/librarius/posts/<post id>/messages`. Run the
     query again 10 minutes or more later: they should be later than before, and more than an hour away. Look at that one
     post, not at the whole table: a link sits between 1 hour 50 minutes and 2 hours from lapsing for up to one pass before
     it is renewed, and a link Discord will not renew (its message is gone there) stays in the past.

     ```sh
     docker compose exec -T db psql -U salamanders salamanders_builds -c "select a.id, a.expires_at from librarius_attachments a join librarius_messages m on m.id = a.message_id where m.post_id = <post id> order by a.expires_at limit 5;"
     ```

5. Merge the branch to `main`. The site deploys, and the Librarius appears in the Reliquarium.
6. Check again, **on the site**. Sign in and open Reliquarium, then Librarius: the topic list and a post load. In a post,
   in Discord, post a message, edit it, react to it and delete one: each shows on the site within about 10 seconds (the
   page asks for changes every 10), and a post deleted in Discord says "This post was removed in Discord." on a page left
   open. A post's pictures load.
7. Share `/reliquarium/librarius` with readers who are not in the Legion but may read the forum: their nav link appears
   only after they sign in again or visit that page once.

If the import never finishes (`import_done` stays false), read `last_error` in the same table: the import retries by itself
(after 5, 10 and 20 minutes, then every 30), and `docker compose restart api` forces a run at once. A run that stopped
resumes from the cursor each post kept, so a long import is not started over. A `last_error` of "Error: Discord answered 403 for
a thread." means the bot cannot see a post that the Librarius holds and Discord no longer lists: before it deletes
anything, the import asks Discord about each such post, and that answer ends every run, with nothing deleted, until the
bot's permissions on that thread (or on the forum) let it see the thread again.

**Rolling back.** Before the merge, the rollback tag above is the whole of it. After the merge, rolling back the API alone
leaves the new site against the old API, and every Legion member sees "The Librarius couldn't be reached." A full rollback
also needs a revert of the merge on `main`, so that the site goes back too.
