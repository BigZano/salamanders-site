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
then the gateway's live events), and the site reads that copy. Reading writes nothing to Discord: replying from the site,
which does, is a separate switch with its own setup ("Librarius replies", below). Design:
`docs/superpowers/specs/2026-11-15-librarius-design.md`. Access follows the forum in Discord: a member may read it
here exactly when Discord would let them open it, worked out from the guild's roles and the forum's permission
overwrites (View Channel and Read Message History, `librariusPerms.js`). The guild owner and Administrators read it
too, as in Discord, and a role the forum shuts out does not. Every read route reuses a verdict for 30 seconds (the write
routes ask afresh), marking a post read included: it writes only the caller's own read mark. The guild and the forum that
a verdict is drawn from are kept for 5 minutes, and the gateway's role and channel events drop them at once; if such an event is lost, a change to a role or to
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

A route that is listed neither here nor under "Librarius replies" answers 404, an unconfigured Librarius 503, no identity 401 and no read permission 403
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
is refused). The replies need more of the bot: see "Librarius replies", below.

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

## Batch 2 probe (`src/librariusProbeRun.js`)

An owner-run check of how Discord treats the replies the site will send to the Librarius, run before batch 2 is
rolled out. It posts a short series of test messages, through a webhook of its own, into a private test forum that is
never the Librarius, and prints what Discord answered to each. It is not part of the API and nothing starts it.

Run it on the host, from the `server/` folder of the checkout that holds `server/.env` (`<main checkout>`: Bun reads `.env`
from the working directory, and a worktree has none), with the path of the probe after it. While batch 2 is still in its own
worktree (`<worktree>`), give the path from there. First a dry run, which prints what it would send and calls nothing:

```sh
cd <main checkout>/server && ../node_modules/.bin/bun <worktree>/server/src/librariusProbeRun.js --dry-run
```

then the real run, which is the same without `--dry-run`:

```sh
cd <main checkout>/server && ../node_modules/.bin/bun <worktree>/server/src/librariusProbeRun.js
```

and add ` --automod` to it for step 7 as well (a keyword that your moderators' AutoMod alert channel may show). Once batch 2
has landed on `main`, the path is the merged one, `cd <main checkout>/server && ../node_modules/.bin/bun src/librariusProbeRun.js`,
with the same arguments.

| Variable | Value |
|---|---|
| `LIBRARIUS_PROBE_CHANNEL_ID` | the id of the private test forum (type 15). Required |
| `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `LIBRARIUS_CHANNEL_ID` | as for the API |

It refuses to start (exit 2, before it makes or sends anything) when the probe forum's id is missing, is not a channel id
or is `LIBRARIUS_CHANNEL_ID`; when `LIBRARIUS_CHANNEL_ID` is set but is not a channel id (a stray space, say: the check
against it would pass for nothing); when the channel is not a forum, is not in `DISCORD_GUILD_ID`, or can be seen by
everyone (its permission overwrites must deny View Channel to @everyone); and on an argument it does not know.

The bot needs Manage Webhooks in the test forum, and Manage Server for `--automod` (Discord lists AutoMod rules only to
it; without it, step 7 is skipped and says so). The probe makes a webhook called "Librarius probe" there and one post by
it, sends into the post 1500 ms or more apart, and deletes the webhook at the end. The post stays, for you to look at.
The sends are:

1. a Components V2 message: a 3988-character text (with the 12 characters of the button's label, exactly 4000, whether
   or not Discord counts labels), a separator, a picture inside the box and a link button;
2. a V2 message of 4001 characters, which Discord should refuse (the row gives what it says);
3. a V2 message that mentions the guild's owner (`allowed_mentions: { parse: [] }`), which should show a name and ping nobody;
4. a reply of three V2 messages, 11,500 characters in all, then an edit of the first to add jump links to the others;
5. a plain message of exactly 2000 characters with embeds suppressed;
6. three more replies, 1500 ms apart like every other send. The site's outbox will space every webhook send at least
   1500 ms apart, not only the parts of one reply, so this is the fastest the site goes;
7. with `--automod`: the first keyword of the first AutoMod KEYWORD rule that is enabled, blocks messages and does not
   exempt the probe forum, sent twice about 2 seconds apart, as V2 text (7a) and as plain content (7b). Discord's code
   200000 is a block. Neither blocked, by a rule that blocks and does not exempt the forum: AutoMod does not filter
   webhook posts, and the site's own check is the only filter for both forms. 7b blocked and 7a not: AutoMod does not
   read V2 text, and the site's own check is the only filter on a V2 reply. Both blocked: it reads both. It also prints
   whether that rule exempts the Librarius forum; a rule that does makes a block here say nothing about the Librarius.

It prints the post's address, a table with one row for each call (status, Discord's code and text, milliseconds and the
message id), the word to search for in (d) (Discord's search index can lag a few minutes) and then a checklist, a to f, to
answer by eye. (b) assumes the person running the probe is the guild's owner: it mentions the owner, and the owner is who
should see the name and no ping. A message that Discord refuses is the result, not a failure: the run goes on and exits 0.

A 429 is never resent. The next send waits the longer of 1500 ms and what Discord asked (`retry_after`, or the
`Retry-After` header), at most 60 seconds. Asked for more, or told the limit is global, the probe sends nothing more, says
so in the rows it did not send, still deletes its webhook and exits 1: run it again later.

Exit 1 also means it could not make its webhook or post, or could not delete the webhook (it says so). Ctrl-C deletes the
webhook, if it has made one, and exits 130. If the webhook could not be made or its answer was lost, it may exist
anyway: if a webhook named "Librarius probe" exists in the probe forum, delete it under Edit Channel → Integrations →
Webhooks. A token or a webhook url is never printed, and what Discord says is cut of links.

## Librarius replies (`LIBRARIUS_WEBHOOK_URL`)

Batch 2: a member who may reply in the Librarius, by the same Discord rules as above, can reply, edit and delete from the
site. A reply is posted by neither the bot nor the member's own account. It goes through one webhook that the bot makes on
the forum, and Discord shows it under the member's name and picture, with "Open On Site" at its end. The site never
creates a post: there is no route for it. Design: `docs/superpowers/specs/2026-11-15-librarius-design.md`. Replies are off
until `LIBRARIUS_WEBHOOK_URL` is set, and the rest of the Librarius works without it.

| Endpoint | Who | Notes |
|---|---|---|
| `POST /librarius/posts/:id/messages` | a member who may reply | JSON `{ source, replyTo?, pingReply?, mentions, uploads }`, 64 KB at most. 202 `{ pending: { key, state } }`: the reply is queued, not yet in Discord |
| `PATCH /librarius/messages/:id` | the author of a reply written on the site | JSON `{ source, mentions, uploads? }`. The text and the mentions change; the pictures cannot after sending. 202. 409 for a reply that another webhook sent (see "Rolling back the replies") |
| `DELETE /librarius/messages/:id` | the author, or someone who can manage messages | any message but a post's first (a whole post is never deleted here). 202 |
| `POST /librarius/uploads` | a member who may attach | one picture as multipart, 201 `{ id }`. Held for the reply that names it, an hour at most |
| `GET /librarius/posts/:id/pending` | reader | the caller's own replies, edits and deletes that are queued, blocked or failed, from the last 24 hours (newest 20) |
| `GET /librarius/members?q=` | reader | `{ members }`: up to 10 people who may read the forum, for picking someone to mention |

`GET /librarius/me` adds, for a reader, `can: { reply, attach, manageMessages, manageThreads }`, the member's `limits` and
what is left of each, and, for someone who can manage messages, `sendingPausedUntil`, `sendingFatal` (why replies are not
going out) and `automodUnchecked`: the names of the server's AutoMod rules that the site cannot check, which are the
enabled keyword rules that have a regular expression the site cannot read the same way Discord does (one that uses `\b`,
`\w`, `\d`, a POSIX class or anything else JavaScript reads differently). An empty list `[]` means that the site checks every
rule there is. A name in the list means that replies are not checked against that rule's patterns on the site, and Discord's
own AutoMod does not look at what a webhook posts, so those patterns are not applied to replies at all: rewrite the pattern
or accept that. `null` means that the rules could not be read from Discord just now (the rest of `/me` still answers); every
write answers 503 while that lasts. A member may reply when Discord would let them: Send Messages in Threads on the post, worked
out from the guild's roles and the forum's overwrites as for reading, and not timed out in the server (a timeout takes every
right but reading, so a timed-out member can only delete their own replies; the owner and Administrators are not held back by
one, as in Discord). A member still in the server's screening cannot write. Pictures need Attach Files too, and in a locked
post only someone who can manage threads may write or delete. Every write route asks for a verdict that is at most 3 seconds
old, never the 30-second one that reads use, so a role taken away or a timeout that has begun stops a write within seconds.

A reply is a row of `librarius_outbox` before anything is sent, and the outbox (`librariusOutbox.js`) sends it, one at a
time, and takes up what a stop or a crash left half-done. The reply then shows on the site greyed, as sending, until Discord
has all of it. A part is sent again only when Discord certainly did not take it: after a timeout or a restart the outbox
looks in the post for what may already be there first, so no part is ever sent twice. A 429 waits as long as Discord says. Any
other failure of Discord's is tried again after 5 seconds, 30 seconds, 2 minutes and 10 minutes, and then the reply is
marked failed. A reply or an edit that ends for good, failed or blocked, leaves nothing of itself in Discord: the parts it
had sent are deleted, and an edit that had changed some parts puts them back as the site holds them. The pause that two
blocks bring, a 429 that Discord calls global, and the number of sends in the last minute all survive a restart.

| Variable | Value |
|---|---|
| `LIBRARIUS_WEBHOOK_URL` | the address of the Librarius's webhook, printed by the setup command below. **A secret**: whoever has it can post as the Librarius. `server/.env` only, never git, never a chat |
| `LIBRARIUS_FORM` | `v2` (Components V2, the default) or `plain` (a message of text). Empty is `v2`; anything else is a startup warning and also `v2` |
| `DISCORD_GUILD_ID`, `DISCORD_BOT_TOKEN`, `LIBRARIUS_CHANNEL_ID` | as for the Librarius above, all required |

**When replies are off.** `LIBRARIUS_WEBHOOK_URL` unset, or not an address the client takes
(`https://discord.com/api/webhooks/<id>/<token>`): the read side is as it was. Every write route answers 503 "Replying from
the site isn't switched on yet.", `/librarius/me` says `can.reply` is false, and the outbox, the upload sweeper and the
"Delete on site" command do not start. The API logs one warning at startup that says which setting, never its value.
"Delete on site" stays in the Apps menu all the same, because nothing here takes a command away from Discord, and with the
replies off nothing answers it: Discord shows "The application did not respond". It answers again when the replies are
switched on and the API has seen the gateway's READY. A reply that was queued but not yet sent stays in `librarius_outbox`
and goes out when they are switched on again.

**What starts, in this order**, after the API is listening. Nothing here can keep it from listening: each step that fails is
logged as `Librarius: ...` (the step's name and what failed, with no token and no link in it), and the rest go on.

1. The repair of the replies of the site, replies on or off (below).
2. The roster warm-up (not waited for), the posts load, the import (in the background), the import's timer, the link
   refresh timer, and the gateway connection: as for the Librarius above.
3. With the webhook only: the outbox. It first takes a Postgres advisory lock (key 19000001) so that one process only sends. If
   another API holds it (a second compose project on the same database, say), this one logs "another worker holds the outbox,
   so this one does not send." once and asks again every 30 seconds. Then it reads the pause, the last minute's sends and the
   blocks it was left, and takes up what a stop left half-done.
4. With the webhook only: the upload sweeper. It deletes the pictures held for replies that were never sent, and those of a
   reply that failed or was blocked, once they are an hour old or the reply has ended (never a picture a queued reply names).
   On the same timer, at its first sweep and then once an hour, it prunes `librarius_outbox` entries that are `sent` and more
   than a day old (they hold the whole text of replies that may be deleted since) and `librarius_events` rows more than 90
   days old. A prune that fails is logged and tried at the next sweep. Entries that are `failed` or `blocked` are kept.

The "Delete on site" command is made when the gateway says READY, and answers beside the live feed, never in front of it.
The API gives the live feed and the import the webhook's id, and each reply's parts are stored with theirs, so that a
catch-up does not read the parts of a reply as messages of their own, whichever webhook sent them. AutoMod's regular
expressions run in one worker thread, which starts the first time a reply is checked against a rule that has a pattern: it
is not a step of the start. If it cannot run, the API logs "Librarius: the thread that checks AutoMod patterns failed" once, and
the reply that needed it is refused ("This reply couldn't be checked against the server's rules. Try a shorter one."), never
sent unchecked.

**The repair.** An image from before the replies (see "Rolling back the replies") writes over what the database holds for a
reply of the site: the author of part 1 becomes the webhook, a `v2` reply loses its text, and parts 2 and 3 are stored as
messages of their own. The first thing the API does at each start is put that right, from what the site kept of the reply (its
source and layout, and, for the author, the outbox entry or the event that noted the send): it gives the reply its author,
text, name, picture and reply link back, and deletes the rows that were parts. It does nothing, and takes no revision number,
when there is nothing to put right, and logs one line, `Librarius: repaired the replies of the site: N put right, M parts that
had been stored as messages removed.`, when it did something. It cannot bring back what the site did not keep: the pictures of
a reply's parts 2 and 3 on the site (Discord still has them), and embeds.

### Bot permissions the replies need, beyond the Librarius's

Each permission below is the one that Discord's documentation (`docs.discord.com/developers`, read 2026-11-18) names for
the call that the code makes with it.

| Permission | Call | Why |
|---|---|---|
| Manage Webhooks, on the forum | `GET /channels/{channel.id}/webhooks` and `POST /channels/{channel.id}/webhooks`: "Requires the `MANAGE_WEBHOOKS` permission" | the setup command only: it looks for a webhook it made before, and makes one when there is none. The running API never makes or lists webhooks, so the permission can be taken away again once the webhook exists. The webhook's own calls (`POST /webhooks/{id}/{token}` to send, and to edit and delete its own messages) need no bot and no permission: the address is the credential |
| Send Messages in Threads, on the forum | `PATCH /channels/{thread.id}` with `{ archived: false }`, which the outbox makes when Discord says a post is archived and an **edit** has to be made in it. Discord's two pages disagree on what that call needs: the endpoint's says "When setting `archived` to `false`, when `locked` is also `false`, only the `SEND_MESSAGES` permission is required", and the Threads topic says "Editing a thread to set `archived` to `false` only requires the current user has already been added to the thread". The bot is usually not a member of a post, and "Users cannot edit messages, add reactions, use application commands, or join archived threads". `SEND_MESSAGES` "has no effect in threads; users must have `SEND_MESSAGES_IN_THREADS` to talk in a thread" | opening an archived post so that an edit can land in it. A **reply** needs none of this: the webhook sends with the post's id (`thread_id`), and for that call Discord says "The thread will automatically be unarchived", so the reply reopens the post by itself. Without this permission, if Discord still refuses the edit, the edit fails with "This post is locked in Discord." and the message keeps its old text. A post that is locked can be opened only by someone with Manage Threads, which the bot is not given, so a reply or an edit there fails with the same text. Whether Send Messages in Threads is enough for an edit is not settled by the documentation: live check 16 settles it, and says what to grant if it is not |
| Manage Messages, on the forum | `DELETE /channels/{channel.id}/messages/{message.id}`: for a message "not sent by the current user", "requires the `MANAGE_MESSAGES` permission" | a moderator's delete, from the site, of a message that a person wrote in Discord, and the delete of a reply that an older webhook sent. A reply written on the site is deleted through its own webhook, without it. Without it those deletes fail |
| Manage Server (guild-wide, on the bot's role: a forum cannot grant it) | `GET /guilds/{guild.id}/auto-moderation/rules`: "This endpoint requires the `MANAGE_GUILD` permission". "All Auto Moderation related events are only sent to bot users which have the `MANAGE_GUILD` permission" | the site checks every reply against the guild's AutoMod rules before it is queued, because AutoMod does not look at webhook posts (the probe). Without it the rules cannot be read, so every write answers 503 and nothing is let through unchecked. The events (`AUTO_MODERATION_RULE_CREATE`, `_UPDATE` and `_DELETE`, intent `1 << 20`, which the gateway now asks for) make a change to a rule count at once; without them it counts within 5 minutes. It is a broad permission (whoever holds the bot's token can also change the server's settings and manage its invites with it), so it widens what a leaked bot token can do: keep that token in `server/.env` only, and live check 19 looks for it in the logs |
| the `applications.commands` scope | `POST /applications/{application.id}/guilds/{guild.id}/commands` (and the `GET` before it) | "Delete on site" in the Apps menu. Discord's page: "your app must be authorized with the `applications.commands` scope", which "is also automatically included with the `bot` scope". The interaction's answer, `POST /interactions/{interaction.id}/{interaction.token}/callback`, needs nothing but its token |

Two more things in the Developer Portal. The application must have **no Interactions Endpoint URL**: Discord delivers
interactions either to that URL or over the gateway, "mutually exclusive" ways, and the command listens on the gateway. And
if "Delete on site" never appears in the Apps menu (after the next gateway READY, which a restart brings), there are three
things to look at:

- `docker compose logs api | grep 'Librarius command'`: `"Delete on site" could not be made: Discord does not let the bot make
  commands in this server.` means the bot was added without the scope. Add it again with the scope, through the application's
  OAuth2 URL generator with `bot` and `applications.commands` ticked, and restart the API.
- The replies are off, so the command was never made (see "When replies are off").
- The person looking cannot use application commands there: Use Application Commands denied to them, or to everyone, in the
  forum's permission overwrites (or on their role). The command is made for the whole server; whether it shows is up to
  Discord's permissions for the person in that channel. It does not work in an archived post either ("Users cannot ... use
  application commands ... in archived threads"), so open it on a post that is active.

The bot is not given Manage Threads. It could archive a post again after an edit ("Otherwise, requires the
`MANAGE_THREADS` permission"), but without it nothing fails: a post that the bot opened stays open until Discord's own
auto-archive closes it. If live check 16 finds that Send Messages in Threads is not enough to open a post for an edit, grant
Manage Threads on the forum: every page of Discord's documentation agrees that it is enough, and with it the bot can archive
the post again too.

### What the site does so that Discord has nothing to act on

- **Per member:** 3 replies a minute, 20 edits a minute (a delete counts as an edit) and 30 pictures an hour. Besides those,
  each try is counted before the request is read, whether or not it goes through: at most 20 writes (a reply, an edit or a
  delete) a minute, 10 picture uploads a minute and 30 member searches a minute, so a request that is refused later has still
  used up a try. A request over a limit is refused with 429 and "Slow down a little: try again in N seconds.". At most 2
  pictures per member (4 in all) are being received at one time ("One picture at a time, please." or 503 "The site is busy
  with pictures; try again in a moment."), and a member may hold 100 MiB of pictures that are not sent yet (413 "You're holding
  too many pictures; send or remove some first.").
- **Across everyone:** every call to the webhook, a reply's parts, edits and deletes, whoever it is for, goes out at least
  1500 ms after the end of the one before, one at a time, and at most 20 messages are sent in any minute. Over that, replies
  wait in the outbox; they are not refused. The first call after the API starts waits 1500 ms too.
- **Mentions:** at most 10 people in a reply (fewer when the server's mention rule is lower: the cap is the lesser of 10 and
  the rule's total limit less one), and only people picked from the member search who may read the forum. Every message is
  sent with `allowed_mentions: { parse: [] }` and exactly those people, so `@everyone`, `@here`, a role, or an id typed by
  hand never pings: a typed `<@id>` is refused on the site with "Pick people to mention from the list (N at most).", N being
  that cap. A reply to a message pings its author only when they may read the forum.
- **AutoMod:** the site matches a reply against the guild's AutoMod keyword rules (the keywords, the allow list and the
  regular expressions) and its mention limit before it is queued, and refuses a match with the rule's name. It matches what
  is sent as well as what was written, so a picture put inside a word does not split a keyword past the check. A rule that
  only alerts counts too; a rule that is switched off, or that exempts the member's role or the forum or the post, does not;
  and Administrators and members with Manage Server are exempt, as in Discord. A regular expression that takes more than 250 ms
  for all of a reply, or a text over 10,000 characters when a rule has a pattern, refuses the reply ("This reply couldn't be
  checked against the server's rules. Try a shorter one."). If Discord blocks a message all the same (code 200000, 200001 or
  240000, the harmful-links filter), the reply is marked blocked and is never sent again: the member is told to edit or delete
  it. Two blocks within an hour stop all sending for an hour; replies wait, and a restart does not clear it (it is kept in
  `librarius_outbox_state`, and built again from `librarius_events`).
- **Size:** at most 3 Discord messages a reply. A message holds about 4000 characters of text in the `v2` form (the probe
  measured exactly 4000 of everything Discord counts, the button's label included) and 2000 in `plain`, so a reply is about
  12,000 characters. A code block, a spoiler, bold, italic, underline, strike or inline code that a cut falls in is closed
  right after its last word and opened again where the next message starts, so that it looks the same in each. A line that
  starts like a list (`1.`) but is text is written with its dot escaped. At most 10 pictures a reply, 10 MB each. A picture is
  PNG, JPEG, WebP or GIF by its bytes, never by its name or its type, and what it keeps is what is needed to see it: the image
  itself, its colour profile, which way up it goes, and a GIF's frames and timing. Everything else is cut out (location, camera
  and software data, text, thumbnails, content credentials, comments, and anything the site does not know), and a PNG with
  an unknown critical part is refused.
- **Pictures are fixed when sent:** an edit changes the text and the mentions, and a change that would move or take away
  a picture is refused ("delete the reply and post it again").

### Setup, in this order

The API goes first, as in batch 1's rollout: the new API is additive and the old site never asks for its routes. Batch 1's
own rollout (above) comes before all of this. The checks in step 7 that use the composer need the site that has it, which
is the merge of the site's half; the start-up, command and log checks can run as soon as step 6 is done.

1. **The probe has been run.** It was, on 2026-11-18 (the "Batch 2 probe" section above). What it settled: the `v2` form
   works and takes exactly 4000 characters of displayable text a message; three sends 1500 ms apart are taken; AutoMod
   does not filter webhook posts in either form, so the site's own check is the only filter. `LIBRARIUS_FORM` is `v2`
   unless the probe's open question (whether Discord's search finds the words inside a `v2` message) says otherwise: then
   set `plain`.
2. **Grant the permissions** in the table above: Manage Webhooks, Send Messages in Threads and Manage Messages on the
   forum (Edit Channel → Permissions, the bot's role), and Manage Server on the bot's role (Server Settings → Roles). Check
   that the application has no Interactions Endpoint URL.
3. **Run the setup command**, on the host, from the `server/` folder of the checkout that holds `server/.env`
   (`<main checkout>`; Bun reads `.env` from the working directory, and a worktree has none). While batch 2 is still in its
   own worktree (`<worktree>`), give the path of the command from there. First a dry run, which prints the calls it would
   make and calls nothing:

   ```sh
   cd <main checkout>/server && ../node_modules/.bin/bun <worktree>/server/src/librariusWebhookSetupRun.js --dry-run
   ```

   then the real one, the same without `--dry-run`. Once batch 2 is on `main`, the command is
   `cd <main checkout>/server && ../node_modules/.bin/bun src/librariusWebhookSetupRun.js`. It makes a webhook called
   "Librarius" on the forum as the bot, and prints one line, `LIBRARIUS_WEBHOOK_URL=` and the address. The rest it says (what to
   do with the line) goes to the error output. When a webhook called "Librarius" that this bot made is already on the forum it
   makes none beside it: it prints that webhook's address, the same line, and says so. Discord lists the address of a
   webhook like this one to the bot that may manage webhooks, and Edit Channel → Integrations → Webhooks → Librarius → Copy
   Webhook URL gives it too, so an address that was lost is got again either way. **Never delete the webhook, and never make
   a new one in its place, while the site has replies**: a webhook can edit and delete only its own messages, so a new one is
   another sender that cannot touch a reply the old one sent (see "Rolling back the replies"). It exits 2 for a bad setting
   (before any call) and when `LIBRARIUS_CHANNEL_ID` is not a forum of the guild, and 1 when Discord refuses or does not
   answer, or when the webhook that is there is given without an address (it then says to copy it from Discord). If an
   answer was lost a webhook may exist anyway: run the command again, and it finds that webhook. The bot's token is never
   printed.
4. **Paste the line into `server/.env`**, and `LIBRARIUS_FORM=` if it is not `v2`. Do not save it anywhere else, and clear
   the terminal that printed it.
5. **Apply the schema** (idempotent, the command in the reports section above) **before** starting the new image. The
   replies add `librarius_outbox`, `librarius_outbox_state`, `librarius_parts`, `librarius_uploads` and `librarius_events`,
   four columns on `librarius_messages` (`origin`, `source`, `state`, `layout`) and one on `librarius_parts` (`webhook_id`).
   A reply's parts are tied to its message (deleted with it, and never more than three), and the schema adds that after it
   deletes any part row that has no message or a place outside 0 to 2, which only a database that has not run the replies'
   code could have. The tables need no grant: `app-role.sql`'s default privileges cover them.
6. **Rebuild the API, keeping the rollback tag**: `docker tag server-api:latest server-api:pre-librarius-replies` first,
   then `docker compose up -d --build api`. It reads `.env` when it is made, so an edit of `.env` needs
   `docker compose up -d api`, not `docker compose restart api`. The tag is the image before the replies: read "Rolling back
   the replies" before you ever use it.
7. **The live checks**, below, run once.

### The live checks

One checklist, run once, in this order, after step 6. **The site posts only into the Librarius**: the API reads and writes
one forum, and the webhook belongs to it, so the probe's private forum cannot stand in for it (and pointing the API at that
forum would have the import rewrite what the database holds of the real one). Make one post in the Librarius for this (a title like
"test, delete me") and use it for every step, with invented text only; delete the post in Discord at the end, and the site
follows. Use a second account for the mention. Run the AutoMod step as a member who is **not** an Administrator and does not
hold Manage Server (they are exempt from AutoMod, as in Discord). Commands start from `server/`, in the checkout that holds
`.env`. `TOKEN` is a signed-in member's Discord token, got as in step 4 of "Rollout" under "Librarius" above.

1. **A clean start.** In `docker compose logs api` after the rebuild: "Builds API listening", and none of "Replying from the
   site is off", `Librarius: replying from the site could not be set up`, `Librarius: the replies of the site could not be
   repaired`, "another worker holds the outbox". The API holds the outbox's lock, so this prints one row:

   ```sh
   docker compose exec -T db psql -U salamanders salamanders_builds -c "select objid, pid from pg_locks where locktype = 'advisory' and objid = 19000001;"
   ```

   Pass: the four lines are not there, and there is one row.
2. **A one-part reply, and what Discord holds of it.** Send "a short test". On the site it shows greyed, "sending…", then as
   a message tagged "site" within a few seconds. In Discord the post has a new message under that member's name and picture,
   with the text and an "Open On Site" button. In the database, with the post's id in place of `<post id>`, `origin` is `site`
   and `state` is empty:

   ```sh
   docker compose exec -T db psql -U salamanders salamanders_builds -c "select id, origin, state, left(source, 40) as source from librarius_messages where post_id = <post id> order by id desc limit 3;"
   docker compose exec -T db psql -U salamanders salamanders_builds -c "select discord_id from librarius_parts where message_id = <message id>;"
   ```

   The second gives the Discord id of the part (with the message's id from the first). Read it back from Discord, as the bot, with
   the text that Discord holds, and compare it with what was sent (the outbox finds a send that may have been lost by
   comparing exactly this, so a difference would make it send the reply twice). The token is read from `.env` into the shell and
   is in no command line:

   ```sh
   curl -s -H @- "https://discord.com/api/v10/channels/<post id>/messages/<discord id>" <<<"Authorization: Bot $(grep '^DISCORD_BOT_TOKEN=' .env | cut -d= -f2-)" | jq -r '[.. | objects | select(.type == 10) | .content] | join("\n")'
   ```

   (With `LIBRARIUS_FORM=plain` the text is `jq -r .content` instead.) Pass: it prints exactly `a short test`, then a line
   `-# <@` and the writer's Discord id and `>`, and nothing else: no extra space, no escaped character, no change.
3. **A reply of three parts**, about 9,000 characters of invented text (several paragraphs, so that it has places to be
   cut; `yes 'invented words in a row' | head -n 360 | paste -sd ' ' -` prints 9,000 characters of words, to cut into
   paragraphs by hand). In Discord it is three messages, each starting `1/3`, `2/3` and `3/3`, the later ones with a link back
   (`↑ from 1/3`), the first with links forward (`continues: 2/3 · 3/3`), and the last with the "Open On Site" footer. Read in
   Discord from the first to the last, nothing is missing: its last words are the text's last words. On the site it is one
   message with the whole text. With the message's id in place of `<message id>`, this gives three rows, in order, each made
   at least 1.5 seconds after the one before (the spacing, as Discord timed it):

   ```sh
   docker compose exec -T db psql -U salamanders salamanders_builds -c "select part_index, discord_id, to_timestamp(((discord_id >> 22) + 1420070400000) / 1000.0) as made_at from librarius_parts where message_id = <message id> order by part_index;"
   ```
4. **A reply to a message.** Reply to someone's message. In Discord the first line of the reply is `↪`, that person's name and a
   "jump" link to the message.
5. **Mentions.** Pick a member from the @ list and send. In Discord the name shows as a mention, and that member gets the
   ping. Then write `<@` and an id by hand, and send: the site refuses it with "Pick people to mention from the list
   (10 at most).", and nothing reaches Discord. The number is the cap: 10, or one less than the total limit of the server's
   mention-spam AutoMod rule when that limit is 10 or lower.
6. **A spoiler over lines, and text that looks like a list.** Send a reply whose text is these four lines (typed as shown,
   the backslash included):

   ```
   ||the first line of a spoiler
   and the second||

   1\. not a list
   2\. also not a list
   ```

   Pass: in Discord the two lines of the spoiler are under one bar, and a click shows both (not one bar for each line); the
   last two lines read `1. not a list` and `2. also not a list`, with no backslash showing and laid out as plain text, not
   as a numbered list (a list you type in Discord yourself, `1. one`, sits slightly indented: compare).
7. **A mark cut across parts.** Make 5,000 characters of words (`yes 'invented words in a row' | head -n 200 | paste -sd ' ' -`).
   Send a reply that is a bar `||`, those words, a bar `||`; then another that is `**`, the same words, `**`. Each is two
   messages (three in the `plain` form). Pass: in Discord every message of the spoiler reply is wholly hidden behind a bar, and no `||` shows as text; every
   message of the bold reply is bold from its first word to its last, and no `**` shows as text. The first message of each
   ends right after a word, with the mark closed there (no space before it).
8. **An edit.** Edit the first reply's text. In Discord the same message changes and is marked edited, and the site shows the
   new text. Then send a reply with a picture and edit its text: **the picture stays**, in the same place, and the text is the
   new one. (Discord keeping a picture through a `v2` edit was never probed: this is where it is found out. If the picture
   goes, stop and say so: that edit is the thing to fix.)
9. **A phone's photo.** Send a portrait photo straight from a phone, taken upright. It shows upright in Discord and on the
   site. Download it from Discord and look at its details on a computer: no location, no camera or software data, and it
   still shows the right way up.
10. **A delete from the site.** Delete a reply of one part, and a reply of three, from the site. Each goes from Discord, every
    part of it, and from the site. A member who cannot manage messages has no Delete on someone else's reply.
11. **A part deleted in Discord.** Delete the second part of a three-part reply in Discord. Within about 10 seconds the other
    parts go from Discord too, and the whole reply goes from the site.
12. **"Delete on site".** In an active post (not an archived one: Discord does not run application commands there), in
    Discord, on a message, open Apps → "Delete on site". Only you see the answer, and it is one of three:
    - for a reply you wrote on the site, "This was written on the site. Delete it there:" and a link to it;
    - for a message anyone wrote in Discord, "Written in Discord: use Discord's own Delete.";
    - for someone else's reply of the site, or a message the Librarius does not hold, "Only the author can delete this, on the
      site."
13. **The limits, and the command right after a burst.** Send 4 short replies within a minute. The first three go, and the 4th
    is refused with "Slow down a little: try again in N seconds.". As soon as the 4th is refused, run Apps → "Delete on site"
    on one of those replies. Pass: the answer comes at once, as in step 12 (never "The application did not respond", which is
    Discord giving up after 3 seconds). The three sends were at least 1.5 seconds apart, which this shows (the three newest
    `send` rows, their times):

    ```sh
    docker compose exec -T db psql -U salamanders salamanders_builds -c "select at, action, post_id, message_id, note from librarius_events where action = 'send' order by id desc limit 3;"
    ```
14. **AutoMod.** Take one of the guild's AutoMod keyword rules that is switched on, blocks messages, and applies to the
    Librarius forum and to the member who tests: it does not exempt the forum, the post or any role that member has. Put its
    keyword in a reply. The site refuses it with `Blocked by the server's AutoMod rule "<the rule's name>".`, and nothing
    reaches Discord.
15. **What the site cannot check.** As someone who can manage messages, `curl -s -H "Authorization: Bearer $TOKEN"
    localhost:8787/librarius/me` has `"automodUnchecked":[...]`. Pass: the field is there. `[]` means the site checks every
    rule; names mean the patterns of those rules cannot be checked on the site (see "Librarius replies" above), so look at
    those rules; `null` means the rules could not be read just now, so try again, and look at the API's logs if it stays.
    Someone who cannot manage messages gets no such field.
16. **An archived post: a reply, then an edit.** Close the test post in Discord (its menu → Close Post), then:
    - (a) send a reply from the site. Pass: the reply lands, and the post is open again. This needs no permission of the bot's:
      Discord says a send with the post's id "will automatically be unarchived".
    - (b) close the post again, and edit one of the site's replies in it. Pass: the edit lands (Discord shows it edited, and
      the site the new text). This is the one that needs the bot to open the post. If it fails, the edit ends `failed` ("This
      post is locked in Discord.", in `librarius_outbox`, and in the member's list) and the message keeps its old text: grant the
      bot Manage Threads on the forum (see the permissions above), close the post again, and edit again. Say so if (a) fails
      too: the reply then needs the bot as well, and the same grant is the answer.
    After (b) the post may stay open: without Manage Threads the bot cannot close it again, which is harmless.
17. **A reply of another webhook.** In Discord make a second webhook on the Librarius forum by hand (Edit Channel →
    Integrations → New Webhook, any name, "Librarius check"), and copy its address. Put it in `server/.env` as
    `LIBRARIUS_WEBHOOK_URL`, run `docker compose up -d api`, and send nothing through it. Now the replies of steps 2 to 16 that are
    left were sent by another webhook than the one the API holds. On one of them, from the site:
    - edit it. Pass: refused with "This reply was sent through an older webhook, so it can't be edited from the site. Delete it
      and post it again.";
    - delete it. Pass: it goes from Discord and from the site (the bot deletes it, which needs Manage Messages);
    - then `docker compose restart api` and wait for the import to finish (`ready` in `/librarius/me`). Pass: the replies that
      are left show as they did, in one piece, by the member who wrote them, and tagged "site".
    Then put the first address back in `server/.env` (Edit Channel → Integrations → Webhooks → Librarius → Copy Webhook URL),
    run `docker compose up -d api`, and delete the check webhook in Discord (nothing was sent through it).
18. **A harmful link (optional).** Discord's own filter for harmful links answers 240000, and the site must treat it as a block:
    the reply is marked blocked, never sent again, and not retried. Only if you know of a link that Discord's filter refuses,
    and only once (two blocks within an hour stop all sending for an hour): put it in a reply. Pass: the reply shows as blocked
    on the site at once, with one `blocked` row in `librarius_events` and one only. The probe forum cannot be used for this, as
    the site does not post there. Skip it if you have no such link.
19. **No secret in the logs**, last, after everything above. For each of the webhook's address and the bot's token that is set in
    `.env`, this counts the lines of the API's log that hold its secret part, the last segment of the address (the token: the
    API logs the address of a call as `/v10/webhooks/<id>/<token>`, and a token on its own has no prefix at all) and the bot's token
    whole. Both numbers must be `0`; a variable that is not set prints nothing:

    ```sh
    for name in LIBRARIUS_WEBHOOK_URL DISCORD_BOT_TOKEN; do
      value=$(grep "^$name=" .env | cut -d= -f2- | tr -d "\"'\r")
      secret=${value##*/}
      [ -n "$secret" ] && echo "$name: $(docker compose logs api | grep -c -F -- "$secret")"
    done
    ```

If a reply never leaves, look at the outbox and at what the site noted, from `server/`:

```sh
docker compose exec -T db psql -U salamanders salamanders_builds -c "select id, kind, state, attempts, last_error, next_at from librarius_outbox order by id desc limit 10;"
docker compose exec -T db psql -U salamanders salamanders_builds -c "select at, action, post_id, message_id, note from librarius_events order by id desc limit 10;"
```

`blocked` and `failed` entries are final; the member is shown why and can edit or delete the reply. A `last_error` for an entry
that is still `pending` is the last attempt's technical text.

### Rolling back the replies

- **Switching the replies off: unset `LIBRARIUS_WEBHOOK_URL` in `server/.env` and run `docker compose up -d api`, on the image
  you are running.** This is the safe switch. The read side goes on, writes answer 503 (see "When replies are off"), and the
  outbox, the sweeper and the command do not start. The replies already sent are still the site's: the import and the live
  feed know a message of the site by the webhook and the parts stored with it, and not by the address in `.env`, so a catch-up
  reads none of them as a message of its own. A reply that was queued but not sent waits in `librarius_outbox` for the address.
- **The image: do not go back to `pre-librarius-replies` once a reply has been sent.** That image is from before the replies,
  and it does not know them. At its first catch-up (when it starts, after every gateway READY, and every 6 hours) it reads the
  forum again and writes over what the database holds for each reply of the site: part 1's row gets the webhook as its author,
  so the member can no longer edit or delete it on the site and "Delete on site" says "Only the author can delete this, on the
  site."; a `v2` reply shows no text (that image reads only a message's plain text); and parts 2 and 3 are stored as messages of
  their own. Discord is untouched, and the damage stays in the database after its cause has gone. Put it right by running the
  current image again: it repairs every reply of the site at its start, before anything reads the forum ("The repair", above).
  The order that avoids all of it:
  1. To stop the replies, switch them off as above, on the current image. Do not roll the image back for that.
  2. Use the tag only while no reply has been sent: between step 6 and the first live check, which is what it is for.
  3. If the current image must be left anyway after replies exist, expect the damage at the old image's first catch-up, and
     bring the current image back before anyone uses the site: the repair then restores author, text, name, picture and
     reply link, and removes the parts that were stored as messages. It cannot restore the pictures of a reply's parts 2 and 3
     on the site (Discord still has them), nor embeds.
  The schema stays as it is: the new tables and columns are additive, and the old image ignores them.
- **A webhook deleted in Discord:** the next call to it is refused for good, the outbox stops (the reply it held goes back to
  waiting) and every write answers 503 "Replying from the site is paused. Try again later." until the API is started again.
  Run the setup command: with the webhook gone it makes a new one. Put its line in `server/.env`, and `docker compose up -d
  api`. The replies the old webhook sent are the old webhook's: see below. Do not delete the webhook for any other reason.
- **What stays.** Replies already sent stay in Discord and in the database. A webhook can change only its own messages, so a
  new webhook cannot edit or delete the replies of the old one: the site refuses an edit of such a reply ("This reply was sent
  through an older webhook, so it can't be edited from the site. Delete it and post it again."), and its delete goes through
  the bot, which needs Manage Messages. These replies are still known to the site, by the webhook that is stored with each
  part, so a catch-up does not show them in pieces, with the address unset, with a new webhook, or with the image current.
