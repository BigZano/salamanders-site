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
3. Rebuild the API, keeping the rollback tag:

   ```sh
   docker tag server-api:latest server-api:pre-librarius
   docker compose up -d --build api
   ```

   To go back:

   ```sh
   docker tag server-api:pre-librarius server-api:latest
   docker compose up -d --no-build --force-recreate api
   ```

   Once the site has been merged, going back is not so simple: see "Rolling back" below.
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

`GET /librarius/me` adds, for a reader, `form` (`v2` or `plain`: the form a reply is checked in now), `can: { reply, attach,
manageMessages, manageThreads }`, the member's `limits` and what is left of each, and, for someone who can manage messages,
`sendingPausedUntil`, `sendingFatal` (why replies are not going out) and `automodUnchecked`: the names of the server's AutoMod
rules that the site cannot check, which are the enabled keyword rules that have a regular expression the site cannot read the
same way Discord does (one that uses `\b`, `\w`, `\d`, a POSIX class or anything else JavaScript reads differently). An empty
list `[]` means that the site checks every rule there is. A name in the list means that replies are not checked against that
rule's patterns on the site, and Discord's own AutoMod does not look at what a webhook posts, so those patterns are not applied
to replies at all: rewrite the pattern or accept that. `null` means that the rules could not be read from Discord just now (the
rest of `/me` still answers); every write answers 503 while that lasts. A member may reply when Discord would let them: Send
Messages in Threads on the post, worked out from the guild's roles and the forum's overwrites as for reading, and not timed out
in the server (a timeout takes every right but reading, so a timed-out member can only delete their own replies; the owner and
Administrators are not held back by one, as in Discord). A member still in the server's screening cannot write. Pictures need
Attach Files too, and in a locked post only someone who can manage threads may write or delete. Every write route asks for a
verdict that is at most 3 seconds old, never the 30-second one that reads use, so a role taken away or a timeout that has begun
stops a write within seconds.

A reply is a row of `librarius_outbox` before anything is sent, and the outbox (`librariusOutbox.js`) sends it, one at a
time, and takes up what a stop or a crash left half-done. The reply then shows on the site greyed, as sending, until Discord
has all of it. A part is sent again only when Discord certainly did not take it: after a timeout or a restart the outbox
looks in the post for what may already be there first, so no part is ever sent twice. A 429 waits as long as Discord says. Any
other failure of Discord's is tried again after 5 seconds, 30 seconds, 2 minutes and 10 minutes, and then the reply is
marked failed. A reply or an edit that ends for good, failed or blocked, leaves nothing of itself in Discord: the parts it
had sent are deleted, and an edit that had changed some parts puts them back as the site holds them. The pause that two
blocks bring, a 429 that Discord calls global, and the number of sends in the last minute all survive a restart. A reply goes
out in the form that it was checked in, which its entry keeps, so a change of `LIBRARIUS_FORM` applies only to the replies
queued after it. After any failure of the database, the outbox reads again the entries it had left `sending`, so one whose
claim went through but whose answer was lost is taken up without a restart.

**An edit that makes a reply shorter** removes the parts it no longer needs last, once the edit is stored: by a delete queued
with it, in the member's name, as an entry of its own (kind `delete`, keyed by the first part it drops, so its `delete` row in
`librarius_events` names that part, not the reply). Until that delete has run, Discord shows the edited reply and, after it,
the old parts, which still say `k/N` of the old count and link back to part 1: 1.5 seconds a part, and longer when the delete
has to wait (behind other entries, for its retries, or through the pause that two blocks bring). If the delete ends for good
(the post is locked, or Discord refuses it through every retry), the edit stays done, and the old parts stay in Discord. The
site shows that delete on no reply, so it is told once, in two places. The API logs one line: `Librarius outbox: the delete
<entry id> ended for good (<why>), so these parts of the reply <reply id> in post <post id> may still be in Discord, for a
moderator to remove: <part ids>.` And the moderators are told in the channel of the reports webhook (`REPORTS_WEBHOOK_URL`,
leadership's), when it is set: `Librarius: the site could not remove 2 messages of a reply from Discord, because the post is
locked in Discord. They may still be in https://discord.com/channels/<guild id>/<post id>, for a moderator to delete: <part
ids>.` That message names the post as a link and the parts by their ids, and says why in a few words (the post is locked,
Discord blocked the delete, Discord did not take it at any of its tries, or the site could not finish it); it carries no word
or name of a member's. The parts in both are the ones the delete had not removed yet: one that removed them all, and failed
only after, tells nothing. The same is told, without `of the reply <reply id>` in the line, when the delete of what a reply
or an edit that ended for good had left in Discord ends for good as well, and when the delete of what was left of a reply
after a part of it was deleted in Discord does. A moderator deletes those parts in Discord, and nothing else is needed; the
commands that find them are after the live checks. If the message to the moderators cannot be posted, the API logs one line
that starts `Librarius outbox: the moderators could not be told` (with no link in it), the message is not posted again, and
the line above is in the log all the same.

There is one way for a part to stay in Discord without the site knowing of it. Discord took the part, but its answer was lost
(a timeout, say), or the API stopped or lost the outbox's lock before the database had noted the part; and then every look for
it in the post failed, up to the last try. The reply ends failed, and that part stays in the post: a moderator deletes it in
Discord.

| Variable | Value |
|---|---|
| `LIBRARIUS_WEBHOOK_URL` | the address of the Librarius's webhook, printed by the setup command below. **A secret**: whoever has it can post as the Librarius. `server/.env` only, never git, never a chat. The e2e stack gives it an invented address on its Discord mock (`http://discord-mock:4400/api/webhooks/<id>/<token>`), which the API takes only because `DISCORD_API_BASE` is the mock's `http://` address there; `LIBRARIUS_FORM` is unset there, so its replies go out as `v2` |
| `LIBRARIUS_FORM` | `v2` (Components V2, the default) or `plain` (a message of text). Empty is `v2`; anything else is a startup warning and also `v2`. A queued reply keeps the form it was checked in |
| `DISCORD_GUILD_ID`, `DISCORD_BOT_TOKEN`, `LIBRARIUS_CHANNEL_ID` | as for the Librarius above, all required |
| `REPORTS_WEBHOOK_URL` | optional here: the reports webhook of "Member reports" above. When it is set, the moderators are told in its channel of the parts of a reply that a delete of the site's could not remove from Discord ("An edit that makes a reply shorter", above); unset, only the API's log has them |

**When replies are off.** `LIBRARIUS_WEBHOOK_URL` unset, or not an address the client takes
(`https://discord.com/api/webhooks/<id>/<token>`): the read side is as it was. Every write route answers 503 "Replying from
the site isn't switched on yet.", `/librarius/me` says `can.reply` is false, and the outbox and the upload sweeper do not
start. The API logs one warning at startup that says which setting, never its value. "Delete on site" is not made in the
server while the replies are off, but one made while they were on stays in the Apps menu (nothing here takes a command away
from Discord), and it still answers within the three seconds: "Written in Discord: use Discord's own Delete." for a message
written in Discord, and "Deleting from the site is switched off right now. A moderator can delete this in Discord." for a
reply of the site, whoever asks. A reply that was queued but not yet sent stays in `librarius_outbox` and goes out when they
are switched on again.

**What starts, in this order**, after the API is listening. Nothing here can keep it from listening: each step that fails is
logged as `Librarius: ...` (the step's name and what failed, with no token and no link in it), and the rest go on.

1. The repair of the replies of the site, replies on or off (below).
2. The roster warm-up (not waited for), the posts load, the import (in the background), the import's timer, the link
   refresh timer, and the gateway connection: as for the Librarius above.
3. With the webhook only: the outbox. It first takes a Postgres advisory lock (key 19000001) so that one process only sends. If
   another API holds it (a second compose project on the same database, say), this one logs "another worker holds the outbox,
   so this one does not send." once and asks again every 30 seconds. Then it reads the pause, the last minute's sends and the
   blocks it was left, and takes up what a stop left half-done. The lock is held by one connection to the database, and the
   outbox makes sure it still holds it before every call to Discord and before each entry. If that connection has died, it
   sends nothing more: it leaves the entry for whoever holds the lock, takes the lock again (at once if it is free, and every
   30 seconds if not, as at the start), and reads again what the database keeps. Before it reads, it writes what it had
   decided and could not write while the database was failing (a block, a step of the retries, the note of a part that
   landed), as it was decided, and a start after a stop does the same: a part that Discord blocked is never sent again, and
   its block counts towards the pause that two blocks bring.
4. With the webhook only: the upload sweeper. It deletes the pictures held for replies that were never sent, and those of a
   reply that failed or was blocked, once they are an hour old or the reply has ended (never a picture a queued reply names).
   On the same timer, at its first sweep and then once an hour, it prunes the `librarius_outbox` entries that are `sent` and
   more than a day old (they hold the whole text of replies that may be deleted since). A prune that fails is logged and tried
   at the next sweep. Entries that are `failed` or `blocked` are kept, with the whole text of their reply, and so is every row
   of `librarius_events`: it is the Librarians' record of what was done from the site and by whom, and it is never pruned.

The "Delete on site" command is made in the server when the gateway says READY, with the replies on, and it answers beside the
live feed, never in front of it. Discord wants an answer within 3 seconds: the command gives the database at most 1.5 seconds,
and sends its answer with what is left of 2.8 seconds since the interaction came, never less than one second. The API gives
the live feed and the import the webhook's id, and each reply's parts are stored with theirs, so that a catch-up does not read
the parts of a reply as messages of their own, whichever webhook sent them.

**The AutoMod patterns run in a child process.** AutoMod's regular expressions run in one child process
(`server/src/librariusRegexWorker.js`), started with the runtime the API runs on (Bun, in the image) and with none of its
environment, so it holds no secret. It starts the first time a reply is checked against a rule that has a pattern, not as a
step of the start, and it checks one reply at a time; 8 more may wait, and a reply past those is refused at once. A pattern
gets 250 ms from the moment the child is ready. Past that the child is killed (SIGKILL: on Bun, nothing else stops a regular
expression that has begun) and the reply is refused, and the next reply starts a new child. A child takes about 26 MB of
memory on Bun, and there is one at a time. If it cannot run, the API logs "Librarius: the process that checks AutoMod patterns
failed" once, and a reply that needs it is refused ("This reply couldn't be checked against the server's rules. Try a shorter
one."), never sent unchecked. `server/src/librariusRegexSmoke.js` proves on Bun, in about 2 seconds, that a job over the budget
is refused and leaves no child running and no core busy: its last line is `smoke check passed`, and it exits 1 after a line
that starts with `FAIL`. The pre-push hook (`.husky/pre-push`) runs it with the repository's Bun before every push, and step 6
of the setup runs it in the API's own image.

**The repair.** An image from before the replies (see "Rolling back the replies") writes over what the database holds for a
reply of the site: the author of part 1 becomes the webhook, a `v2` reply loses its text, and parts 2 and 3 are stored as
messages of their own. The first thing the API does at each start is put that right, from what the site kept of the reply. The
author is the one the reply's layout names, which is written when the reply is sent; for a reply sent before the layout named
it, the author is taken from the outbox entry or the event that noted the send, and the events are never pruned, so every
reply's author can be found. The rest comes from the reply's own source and layout. It gives the reply its author, text, name,
picture and reply link back, and deletes the rows that were parts. It does nothing, and takes no revision number, when there is
nothing to put right, and logs one line, `Librarius: repaired the replies of the site: N put right, M parts that had been
stored as messages removed.`, when it did something. It cannot bring back what the site did not keep, which is listed under
"Rolling back the replies".

**Deletions in Discord.** A part of a reply that is deleted in Discord takes the whole reply with it: the reply leaves the site,
and the deletion of its other parts from Discord is queued. The live feed, or the catch-up for a deletion it finds, wakes the
outbox for it at once, so the other parts go from Discord within seconds. While a reply has an edit pending or under way, a
deletion of one of its parts waits for the edit. If the edit makes the reply shorter and drops that part, the reply stays, with
its new parts, and the delete that the edit queues for the parts it dropped finds that one gone already. If the edit keeps that
part (a moderator deleted it), the whole reply leaves the site, and its other parts are removed from Discord when the edit
ends. A deletion made while the API or the gateway was down is found by the next catch-up (every 6 hours, and after every
gateway READY), for every part of a reply that is in reach of it: among the newest 100 messages of its post, or newer than
those. Discord is asked about the newer ones, and about any made less than 5 seconds before the catch-up read the post (Discord
may not show a message that new yet, so it is not judged gone for missing from the page), at most 10 questions a post and 50 a
run, and a part past those is judged at a later run. A reply older than the newest 100 messages is not checked, nor one with an
edit or a delete on its way until that settles, and a Discord error on any question ends the run with nothing of that post
deleted, for the next run to try again.

### Bot permissions the replies need, beyond the Librarius's

Each permission below is the one that Discord's documentation (`docs.discord.com/developers`, read 2026-11-18) names for
the call that the code makes with it.

| Permission | Call | Why |
|---|---|---|
| Manage Webhooks, on the forum | `GET /channels/{channel.id}/webhooks` and `POST /channels/{channel.id}/webhooks`: "Requires the `MANAGE_WEBHOOKS` permission" | the setup command only: it looks for a webhook it made before, and makes one when there is none. The running API never makes or lists webhooks, so the permission can be taken away again once the webhook exists. The webhook's own calls (`POST /webhooks/{id}/{token}` to send, and to edit and delete its own messages) need no bot and no permission: the address is the credential |
| Send Messages in Threads, on the forum | `PATCH /channels/{thread.id}` with `{ archived: false }`, which the outbox makes when Discord says a post is archived and an **edit** has to be made in it, or a delete through the bot (of a message a person wrote, or of a reply that an older webhook sent). Discord's two pages disagree on what that call needs: the endpoint's says "When setting `archived` to `false`, when `locked` is also `false`, only the `SEND_MESSAGES` permission is required", and the Threads topic says "Editing a thread to set `archived` to `false` only requires the current user has already been added to the thread". The bot is usually not a member of a post, and "Users cannot edit messages, add reactions, use application commands, or join archived threads". `SEND_MESSAGES` "has no effect in threads; users must have `SEND_MESSAGES_IN_THREADS` to talk in a thread" | opening an archived post so that an edit or a delete can land in it. A **reply** needs none of this: the webhook sends with the post's id (`thread_id`), and for that call Discord says "The thread will automatically be unarchived", so the reply reopens the post by itself. Without this permission, if Discord still refuses the edit, the edit fails with "This post is locked in Discord." and the message keeps its old text. A post that is locked can be opened only by someone with Manage Threads, which the bot is not given, so a reply, an edit or a delete there fails with the same text. Whether Send Messages in Threads is enough for an edit is not settled by the documentation: live check 18 settles it, and says what to grant if it is not |
| Manage Messages, on the forum | `DELETE /channels/{channel.id}/messages/{message.id}`: for a message "not sent by the current user", "requires the `MANAGE_MESSAGES` permission" | a moderator's delete, from the site, of a message that a person wrote in Discord, and the delete of a reply that an older webhook sent. A reply written on the site is deleted through its own webhook, without it. Without it those deletes fail |
| Manage Server (guild-wide, on the bot's role: a forum cannot grant it) | `GET /guilds/{guild.id}/auto-moderation/rules`: "This endpoint requires the `MANAGE_GUILD` permission". "All Auto Moderation related events are only sent to bot users which have the `MANAGE_GUILD` permission" | the site checks every reply against the guild's AutoMod rules before it is queued, because AutoMod does not look at webhook posts (the probe). Without it the rules cannot be read, so every write answers 503 and nothing is let through unchecked. The events (`AUTO_MODERATION_RULE_CREATE`, `_UPDATE` and `_DELETE`, intent `1 << 20`, which the gateway now asks for) make a change to a rule count at once; without them it counts within 5 minutes. It is a broad permission (whoever holds the bot's token can also change the server's settings and manage its invites with it), so it widens what a leaked bot token can do: keep that token in `server/.env` only, and live checks 19 and 23 look for it in the logs |
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

The bot is not given Manage Threads. It could archive a post again after an edit or a delete ("Otherwise, requires the
`MANAGE_THREADS` permission"), but without it nothing fails: a post that the bot opened stays open until Discord's own
auto-archive closes it. If live check 18 finds that Send Messages in Threads is not enough to open a post for an edit, grant
Manage Threads on the forum: every page of Discord's documentation agrees that it is enough, and with it the bot can archive
the post again too.

### What the site does so that Discord has nothing to act on

- **Per member:** 3 replies a minute, 20 edits a minute (a delete counts as an edit) and 30 pictures an hour. Besides those,
  each try is counted before the request is read, whether or not it goes through: at most 20 writes (a reply, an edit or a
  delete) a minute, 10 picture uploads a minute and 30 member searches a minute, so a request that is refused later has still
  used up a try. A request over a limit is refused with 429 and "Slow down a little: try again in N seconds.". At most 2
  pictures per member are on their way or being worked at one time (429 "One picture at a time, please.", which costs no try),
  and at most 4 in all are worked at once after they have arrived (503 "The site is busy with pictures; try again in a
  moment.", and the try is given back). A picture has 30 seconds from the start of its request to arrive (408 "That picture
  took too long to arrive."): 10 MB in 30 seconds needs about 2.8 Mbit/s, so a member on a slower uplink gets the 408 for their
  biggest pictures. Bun itself already ends a request that stops sending for about 12 seconds. A member may hold
  100 MiB of pictures that are not sent yet (413 "You're holding too many pictures; send or remove some first.").
- **Across everyone:** every call to the webhook, a reply's parts, edits and deletes, whoever it is for, goes out at least
  1500 ms after the end of the one before, one at a time, and at most 20 messages are sent in any minute. Over that, replies
  wait in the outbox; they are not refused. The first call after the API starts waits 1500 ms too.
- **Mentions:** at most 10 people in a reply (fewer when the server's mention rule is lower: the cap is the lesser of 10 and
  the rule's total limit less one), and only people picked from the member search who may read the forum. Every message is
  sent with `allowed_mentions: { parse: [] }` and exactly those people, so `@everyone`, `@here`, a role, or an id typed by
  hand never pings: a typed `<@id>` is refused on the site with "Pick people to mention from the list (N at most).", N being
  that cap. A reply to a message pings its author only when they may read the forum.
- **AutoMod:** the site matches a reply against the guild's AutoMod keyword rules (the keywords, the allow list and the
  regular expressions) and its mention limit before it is queued, and refuses a match with the rule's name. Those are all it
  can check. A server can also have **preset** rules (Discord's Commonly Flagged Words lists, which are often set to alert
  only) and the **spam-content** rule, and Discord publishes neither the preset word lists nor how its spam filter decides,
  so the site cannot check a reply against them: they never refuse a reply, and `automodUnchecked` never names them. Discord
  does not apply them to a reply from the site either: its AutoMod skips what a webhook posts altogether (the probe,
  2026-11-18). So a reply from the site with a word on a preset list is posted, and the moderators get no alert of it, and
  the spam filter never sees a reply from the site. A word that must never reach the forum from the site belongs in a keyword
  rule. The site matches what is sent as well as what was written, so a picture put inside a word does not split a keyword
  past the check. An allow-list entry with two or more `*` inside it, not only at its ends, is read more strictly than a
  keyword, so the site may refuse a little more than Discord would. A rule that only alerts counts too; a rule that is switched off, or that
  exempts the member's role or the forum or the post, does not; and Administrators and members with Manage Server are exempt,
  as in Discord. A regular expression that takes more than 250 ms for all of a reply, or a text over 10,000 characters when
  a rule has a pattern, refuses the reply ("This reply couldn't be checked against the server's rules. Try a shorter one.").
  The regular expressions read the messages that are sent, each on its own, as Discord reads them: a phrase that a cut splits
  between two messages (`free` at the end of one, `nitro` at the start of the next) is not found by a pattern like
  `free\s+nitro`, as Discord would not find it in two messages, while the keywords, which read what was written too, still
  find it. Each message is also read as the member typed it: with the escapes that the site writes taken out (`z\*rp` is read
  as `z*rp`), its links out of their angle brackets, and every zero-width space removed, the member's own as well; and once
  more with each italic as `_`, which the site sends as `*` (`_free_` goes out as `*free*`). So a pattern refuses a little
  more than Discord would: a rule against `free[\s_.-]*nitro` refuses `*free* nitro` too. A bold round an italic, which the
  site sends as three stars (`**_x_**` goes out as `***x***`), is read both ways: as it is sent, and with the italic as `_`
  inside the bold (`**_x_**`). An italic round a bold (`_**x**_`) and three stars that the member typed are sent the same, so
  they are read as `**_x_**` too, which refuses a little more than Discord would. What the site's form rewrites in a way that
  cannot be undone is read only as it is sent: two italics that touch (`_free__nitro_` is sent as `*freenitro*`), an italic
  inside an italic, a mark that holds only spaces, and the links in the cells of a table or with no text (sent without their
  `](`; a link with no text is read as its bare address). Only a pattern written against the marks themselves can miss those,
  or the order of a bold and an italic; one against what stands between words does not. If Discord blocks a message all the
  same (code 200000, 200001 or 240000, the harmful-links filter), the reply is marked blocked and is never sent again: the
  member is told to edit or delete it. Two blocks within an hour stop all sending for an hour; replies wait, and a restart
  does not clear it (it is kept in `librarius_outbox_state`, and built again from `librarius_events`).
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
own rollout (above) comes before all of this. The live checks that use the composer need the site that has it, which is the
merge of the site's half; the start-up, command and log checks can run as soon as step 6 is done.

1. **The probe has been run.** It was, on 2026-11-18 (the "Batch 2 probe" section above). What it settled: the `v2` form
   works and takes exactly 4000 characters of displayable text a message; three sends 1500 ms apart are taken; AutoMod
   does not filter webhook posts in either form, so the site's own check is the only filter. `LIBRARIUS_FORM` is `v2`
   unless the probe's open question (whether Discord's search finds the words inside a `v2` message) says otherwise: then
   set `plain`.
2. **Grant the permissions** in the table above: Manage Webhooks, Send Messages in Threads and Manage Messages on the
   forum (Edit Channel → Permissions, the bot's role), and Manage Server on the bot's role (Server Settings → Roles). Check
   that the application has no Interactions Endpoint URL.
3. **Run the setup command, yourself.** Run it in your own terminal on the host, and not through an assistant or a script
   that keeps what it prints: what it prints is the secret. Run it from the `server/` folder of the checkout that holds
   `server/.env` (`<main checkout>`; Bun reads `.env` from the working directory, and a worktree has none). While batch 2 is
   still in its own worktree (`<worktree>`), give the path of the command from there, as below; once batch 2 is on `main`, the
   path is `src/librariusWebhookSetupRun.js`. First a dry run, which says on the screen what it would call, and calls nothing:

   ```sh
   cd <main checkout>/server && ../node_modules/.bin/bun <worktree>/server/src/librariusWebhookSetupRun.js --dry-run
   ```

   To see a run that calls something, without Discord, it can be tried against the e2e stack's Discord mock (optional). The
   mock holds a Librarius webhook already, so this tries `--print-existing`. Run it from an empty folder, so that no `.env` is
   read, with the guild and forum ids that `e2e/docker-compose.yml` gives the api (`DISCORD_GUILD_ID`,
   `LIBRARIUS_CHANNEL_ID`) in place of `<e2e guild id>` and `<e2e forum id>`; the bot token is the mock's own, not a secret:

   ```sh
   cd "$(mktemp -d)"
   <main checkout>/node_modules/.bin/bun <worktree>/e2e/discord-mock/server.js &
   sleep 2
   DISCORD_API_BASE=http://localhost:4400 DISCORD_BOT_TOKEN=unused-in-e2e DISCORD_GUILD_ID=<e2e guild id> LIBRARIUS_CHANNEL_ID=<e2e forum id> <main checkout>/node_modules/.bin/bun <worktree>/server/src/librariusWebhookSetupRun.js --print-existing
   kill %1
   ```

   Pass: one line `LIBRARIUS_WEBHOOK_URL=http://localhost:4400/api/webhooks/` and the mock's invented id and token, and on
   the screen that a webhook named "Librarius" that this bot made is already there, so none was made.

   Then the real run. What it prints on its standard output is one line, `LIBRARIUS_WEBHOOK_URL=` and the address, and
   everything else it says goes to the screen, so these commands put that line straight into `.env`, and the address never
   shows. The first command after the `cd` removes the empty `LIBRARIUS_WEBHOOK_URL=` line that `.env.example` has; the second
   makes sure that `.env` ends with a new line, so that the line added does not run on from the last one; the fourth counts
   the lines that set the address:

   ```sh
   cd <main checkout>/server
   sed -i '/^LIBRARIUS_WEBHOOK_URL=$/d' .env
   [ -z "$(tail -c 1 .env)" ] || echo >> .env
   ../node_modules/.bin/bun <worktree>/server/src/librariusWebhookSetupRun.js >> .env
   grep -c '^LIBRARIUS_WEBHOOK_URL=' .env
   ```

   Pass: it says "The webhook is made.", and the count is `1`. When a key is in `.env` twice, Bun and docker compose both
   take the last one, but one line keeps the switches below simple.

   It makes a webhook called "Librarius" on the forum as the bot, and only when there is none. When a webhook called
   "Librarius" that this bot made is there already, it makes none beside it: it says "A Librarius webhook is there (id N).
   Run again with --print-existing to print its address.", adds nothing to `.env`, and exits 0. If `.env` does not have the
   address then (the count is `0`), run the same command with `--print-existing` before the `>> .env`: it adds the address of
   that webhook, the same one as ever, and makes nothing. Edit Channel → Integrations → Webhooks → Librarius → Copy Webhook
   URL gives it too. **Never delete the webhook, and never make a new one in its place, while the site has replies**: a
   webhook can edit and delete only its own messages, so a new one is another sender that cannot touch a reply the old one
   sent (see "Rolling back the replies").

   It exits 2 for a bad setting or argument (before any call) and when `LIBRARIUS_CHANNEL_ID` is not a forum of the guild. It
   exits 1 when Discord refuses or does not answer; when two or more webhooks called "Librarius" that this bot made are on
   the forum (it lists their ids and prints no address: the site uses the one whose id is in `LIBRARIUS_WEBHOOK_URL`,
   `…/webhooks/<id>/…`); and, with `--print-existing`, when Discord gives no usable address for the webhook that is there (it
   then says to copy it from Discord). A run that fails adds nothing to `.env`. If an answer was lost, a webhook may exist
   anyway: run the command again with `--print-existing`, and it finds that webhook. The bot's token is never printed.
4. **The form.** If it is to be `plain` (step 1), set `LIBRARIUS_FORM=plain` in `server/.env`; it is not a secret, so an
   editor will do. Do not save the address anywhere but `.env`.
5. **Apply the schema** (idempotent, the command in the reports section above) **before** starting the new image. The
   replies add `librarius_outbox`, `librarius_outbox_state`, `librarius_parts`, `librarius_uploads` and `librarius_events`,
   four columns on `librarius_messages` (`origin`, `source`, `state`, `layout`) and one on `librarius_parts` (`webhook_id`).
   A reply's parts are tied to its message (deleted with it, and never more than three), and the schema adds that after it
   deletes any part row that has no message or a place outside 0 to 2, which only a database that has not run the replies'
   code could have. The tables need no grant: `app-role.sql`'s default privileges cover them.
6. **Rebuild the API, keeping the rollback tag, and check the new image before it starts.** From `server/`:

   ```sh
   docker tag server-api:latest server-api:pre-librarius-replies &&
     docker compose build api &&
     docker run --rm --network none server-api:latest bun src/librariusRegexSmoke.js &&
     docker compose up -d api
   ```

   The four commands are joined with `&&`, so each runs only when the one before it passed: pasted whole, a build or a smoke
   check that fails stops there, and the new image never starts.
   The first keeps the image before the replies under a tag; read "Rolling back the replies" before you ever use it. The
   second builds the new image. The third runs the smoke check of the AutoMod patterns (above) in a throwaway container of the
   new image, with no network and nothing of `.env`, and removes the container after. Do not skip it: the pre-push hook runs
   the smoke check on the repository's Bun, and only this runs it on the Bun and the Alpine of the image itself, which is
   what the API runs on. Pass: its last line is `smoke check passed`. The fourth starts the new image. The API reads `.env`
   when its container is made, so an edit of `.env` needs `docker compose up -d api`, not `docker compose restart api`. That
   makes the container again, and its log goes with it: see live check 19.

   If a line of the smoke check starts with `FAIL` instead, the check exits 1 and the fourth command does not run. This puts the tag
   back on the image that is running, and nothing has changed:

   ```sh
   docker tag server-api:pre-librarius-replies server-api:latest
   ```
7. **The live checks**, below, run once.

### The live checks

One checklist, run once, in this order, after step 6. **The site posts only into the Librarius**: the API reads and writes
one forum, and the webhook belongs to it, so the probe's private forum cannot stand in for it (and pointing the API at that
forum would have the import rewrite what the database holds of the real one). Make one post in the Librarius for this (a
title like "test, delete me") and use it for every step, with invented text only; delete the post in Discord at the end, and
the site follows. Use a second account of your own for the mention and the reply. Run the AutoMod step as a member who is
**not** an Administrator and does not hold Manage Server (they are exempt from AutoMod, as in Discord). Commands start from
`server/`, in the checkout that holds `.env`, in bash. `TOKEN` is a signed-in member's Discord token, got as in step 4 of
"Rollout" under "Librarius" above.

1. **A clean start.** In `docker compose logs api` after the rebuild: "Builds API listening", and none of "Replying from the
   site is off", `Librarius: replying from the site could not be set up`, `Librarius: the "Delete on site" command could not
   be set up`, `Librarius: the replies of the site could not be repaired`, "another worker holds the outbox". The API holds
   the outbox's lock, so this prints one row:

   ```sh
   docker compose exec -T db psql -U salamanders salamanders_builds -c "select objid, pid from pg_locks where locktype = 'advisory' and objid = 19000001;"
   ```

   Pass: the five lines are not there, and there is one row.
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
   curl -s -H @- "https://discord.com/api/v10/channels/<post id>/messages/<discord id>" <<<"Authorization: Bot $(grep '^DISCORD_BOT_TOKEN=' .env | tail -n 1 | cut -d= -f2- | tr -d "\"'\r")" | jq -r '[.. | objects | select(.type == 10) | .content] | join("\n")'
   ```

   With `LIBRARIUS_FORM=plain`, put `jq -r .content` in place of the last `jq`. Pass, in `v2`: it prints exactly `a short
   test`, then a line `-# <@` and the writer's Discord id and `>`, and nothing else: no extra space, no escaped character, no
   change. In `plain`, the second line goes on after the `>` with ` · [Open On Site](<` and the reply's address on the site,
   and ends `>)`.
3. **A reply of three parts**, about 9,000 characters of invented text (several paragraphs, so that it has places to be
   cut; `yes 'invented words in a row' | head -n 375 | paste -sd ' ' -` prints 8,999 characters of words, to cut into
   paragraphs by hand). In Discord it is three messages, each starting `1/3`, `2/3` and `3/3`, the later ones with a link back
   (`↑ from 1/3`), the first with links forward (`continues: 2/3 · 3/3`), and the last with the "Open On Site" footer. Read in
   Discord from the first to the last, nothing is missing: its last words are the text's last words. On the site it is one
   message with the whole text. With the message's id in place of `<message id>`, this gives three rows, in order, each made
   at least 1.5 seconds after the one before (the spacing, as Discord timed it):

   ```sh
   docker compose exec -T db psql -U salamanders salamanders_builds -c "select part_index, discord_id, to_timestamp(((discord_id >> 22) + 1420070400000) / 1000.0) as made_at from librarius_parts where message_id = <message id> order by part_index;"
   ```
4. **A reply to a message.** With the second account, write a message in the test post in Discord, and reply to it from the
   site (a message of the second account, so that nobody else is pinged). In Discord the first line of the reply is `↪`, that
   account's name and a "jump" link to the message.
5. **Mentions.** Pick the second account from the @ list and send. In Discord the name shows as a mention, and that account
   gets the ping. Then write `<@` and an id by hand, and send: the site refuses it with "Pick people to mention from the list
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
7. **A mark cut across parts.** Make about 4,800 characters of words
   (`yes 'invented words in a row' | head -n 200 | paste -sd ' ' -`). Send a reply that is a bar `||`, those words, a bar
   `||`; then another that is `**`, the same words, `**`. Each is two messages (three in the `plain` form). Pass: in Discord
   every message of the spoiler reply is wholly hidden behind a bar, and no `||` shows as text; every message of the bold
   reply is bold from its first word to its last, and no `**` shows as text. The first message of each ends right after a
   word, with the mark closed there (no space before it). Then a third reply, of a shape that only hostile text has: a
   backtick, 5,000 spaces, `w` and a backtick, which this prints:

   ```sh
   printf '`%5000sw`\n' ''
   ```

   Pass: two messages (three in `plain`); each but the last shows nothing after its mark but a tiny empty code pill, and the
   last shows `w` as code. A run of spaces that long leaves a cut no better place than right after the backtick, so the site
   gives the code a zero-width space to hold (and a spoiler a space, which shows as the small empty bar of step 9). That
   looks odd and is harmless, and only text like this brings it. If the reply arrives as one message, the copy lost the
   spaces: skip this one.
8. **Marks that touch.** Send this reply, as it is:

   ```
   I was *so***very** moved. Later: ||the **captain** dies||
   ```

   Pass: in Discord "so" is in italics and "very" in bold right after it, with nothing to be seen between them (the site puts
   a zero-width space there: no gap, no box), and "the captain dies" is hidden behind one bar until it is clicked. Then two
   more, each a spoiler right after other marks. The first, as it is:

   ```
   ***||**A**||***
   ```

   For the second, type `*a ` (a star, `a` and a space), attach a picture so that it goes in at that place, and type
   `*||*SECRET*||` right after it, so that the text reads `*a ![…](upload:1)*||*SECRET*||`. Pass: `A` and `SECRET` are each
   hidden behind a bar until clicked, and no `||` shows as text.
9. **How Discord pairs bars, by hand.** In the probe's private forum (not the Librarius: these are typed in Discord, and the
   site has no part in them), post these three messages, each exactly as it is:

   ```
   **2/3** |||| a || b ||
   ```

   ```
   **3/3** || || then ||SECRET|| and ||OTHER|| end
   ```

   ```
   ||ALPHA

   BRAVO||
   ```

   Pass: in the first, `a` is hidden and `b` can be read, with the last `||` shown as text; in the second, an empty spoiler
   shows, and `SECRET` and `OTHER` are hidden. Anything else in those two (in the first, everything hidden, or `||||` shown
   as text with `a` and `b` both hidden) means Discord pairs the bars otherwise than the site expects when it cuts a reply:
   stop, and say so. The third settles what was never checked in Discord, whether a blank line ends a spoiler; either answer
   is safe for what the site sends, which never has a blank line inside a spoiler, but say which it was. Both words shown,
   with the bars as text: Discord ends a spoiler at a blank line, as the site does. Both hidden: Discord does not, and the
   site differs there. It reads such a text with its bars as text, so a reply written so on the site shows unhidden in the
   preview and goes out unhidden, and a message written so in Discord, which Discord hides, is shown unhidden on the site:
   that is the one to say.
10. **An edit.** Edit the first reply's text. In Discord the same message changes and is marked edited, and the site shows the
    new text. Then send a reply with a picture and edit its text: **the picture stays**, in the same place, and the text is
    the new one. (Discord keeping a picture through a `v2` edit was never probed: this is where it is found out. If the
    picture goes, stop and say so: that edit is the thing to fix.)
11. **A phone's photo.** Take a portrait photo, upright, somewhere that does not matter (not at home: if the strip ever
    failed, the place would be in the forum for its readers to see), and send it straight from the phone. It shows upright in
    Discord and on the site. Download it from Discord and look at its details on a computer: no location, no camera or
    software data, and it still shows the right way up.
12. **A delete from the site.** Delete a reply of one part, and the reply of three parts from step 3, from the site. Each goes
    from Discord, every part of it, and from the site. A member who cannot manage messages has no Delete on someone else's
    reply.
13. **A part deleted in Discord.** Send a new reply of three parts, as in step 3 (step 12 deleted that one). Delete its second
    part in Discord. Within about 10 seconds the other parts go from Discord too, and the whole reply goes from the site.
14. **"Delete on site".** In an active post (not an archived one: Discord does not run application commands there), in
    Discord, on a message, open Apps → "Delete on site". Only you see the answer, and it is one of three:
    - for a reply you wrote on the site, "This was written on the site. Delete it there:" and a link to it;
    - for a message anyone wrote in Discord, "Written in Discord: use Discord's own Delete.";
    - for someone else's reply of the site, or a message the Librarius does not hold, "Only the author can delete this, on the
      site."
15. **The limits, and the command right after a burst.** Send 4 short replies within a minute. The first three go, and the 4th
    is refused with "Slow down a little: try again in N seconds.". As soon as the 4th is refused, run Apps → "Delete on site"
    on one of those replies. Pass: the answer comes at once, as in step 14 (never "The application did not respond", which is
    Discord giving up after 3 seconds). "Couldn't check right now; open it on the site:" and a link also came in time, but
    means that the database was slow to answer: run the step again, and look at the API's logs if it stays. The three sends
    were at least 1.5 seconds apart, which this shows (the three newest `send` rows, their times):

    ```sh
    docker compose exec -T db psql -U salamanders salamanders_builds -c "select at, action, post_id, message_id, note from librarius_events where action = 'send' order by id desc limit 3;"
    ```
16. **AutoMod.** Take one of the guild's AutoMod keyword rules that is switched on, blocks messages, and applies to the
    Librarius forum and to the member who tests: it does not exempt the forum, the post or any role that member has. Put its
    keyword in a reply. The site refuses it with `Blocked by the server's AutoMod rule "<the rule's name>".`, and nothing
    reaches Discord.
17. **What the site cannot check.** As someone who can manage messages:

    ```sh
    curl -s -H "Authorization: Bearer $TOKEN" localhost:8787/librarius/me
    ```

    Pass: it has `"automodUnchecked":[...]`. `[]` means the site checks every rule; names mean the patterns of those rules
    cannot be checked on the site (see "Librarius replies" above), so look at those rules; `null` means the rules could not be
    read just now, so try again, and look at the API's logs if it stays. Someone who cannot manage messages gets no such field.
    The list names keyword rules only. Then, in Discord (Server Settings → AutoMod), note which preset rules (Commonly Flagged
    Words) and whether the spam-content rule are switched on: the site checks none of them, and Discord does not check a
    webhook's posts, so a reply from the site goes past each of them with no alert (the AutoMod bullet above). Pass: the
    moderators know that, and any word that matters to them is in a keyword rule too, which the site does check.
18. **An archived post: a reply, then an edit.** Close the test post in Discord (its menu → Close Post), then:
    - (a) send a reply from the site. Pass: the reply lands, and the post is open again. This needs no permission of the bot's:
      Discord says a send with the post's id "will automatically be unarchived".
    - (b) close the post again, and edit one of the site's replies in it. Pass: the edit lands (Discord shows it edited, and
      the site the new text). This is the one that needs the bot to open the post. If it fails, the edit ends `failed` ("This
      post is locked in Discord.", in `librarius_outbox`, and in the member's list) and the message keeps its old text: grant the
      bot Manage Threads on the forum (see the permissions above), close the post again, and edit again. Say so if (a) fails
      too: the reply then needs the bot as well, and the same grant is the answer.
    After (b) the post may stay open: without Manage Threads the bot cannot close it again, which is harmless.
19. **No secret in the logs.** Run this now, before anything makes the container again: `docker compose up -d api` (in the
    optional steps below, and after any edit of `.env`) deletes the log of the container it replaces. It prints how many lines
    of the API's log say "Builds API listening", and then, for each of the webhook's address and the bot's token that is set
    in `.env`, how many lines hold the first 20 characters of its secret part. That part is the last segment of the address,
    the token (the API logs the address of a call as `/v10/webhooks/<id>/<token>`, and a token on its own has no prefix at
    all), and the bot's token whole. Only the first 20 characters are looked for because a log line is cut at 200 characters,
    which can cut a token short. Nothing of a secret is printed, and a variable that is not set prints no line:

    ```sh
    echo "listening: $(docker compose logs api | grep -c 'Builds API listening')"
    for name in LIBRARIUS_WEBHOOK_URL DISCORD_BOT_TOKEN; do
      value=$(grep "^$name=" .env | tail -n 1 | cut -d= -f2- | tr -d "\"'\r")
      secret=${value##*/}
      [ -n "$secret" ] && echo "$name: $(docker compose logs api | grep -c -F -- "${secret:0:20}")"
    done
    ```

    Pass: `listening:` is `1` or more, and every other number is `0`. A `listening:` of `0` means that no log was read (the
    wrong folder, say), and the zeros after it mean nothing: run it again from `server/`.
20. **The replies switched off (optional).** This tries the safe switch of "Rolling back the replies", and the answer of
    "Delete on site" while the replies are off. Run step 19's check first. Then switch them off: the address stays in `.env`,
    commented out.

    ```sh
    sed -i 's/^LIBRARIUS_WEBHOOK_URL=/# LIBRARIUS_WEBHOOK_URL=/' .env
    docker compose up -d api
    ```

    Pass: `docker compose logs api` says "Replying from the site is off, so its write routes answer 503:
    LIBRARIUS_WEBHOOK_URL is not set."; with the post's id in place of `<post id>`, this answers `{"error":"Replying from the
    site isn't switched on yet."}`:

    ```sh
    curl -s -X POST -H "Authorization: Bearer $TOKEN" localhost:8787/librarius/posts/<post id>/messages
    ```

    and in Discord, Apps → "Delete on site" answers at once, on a reply of the site, "Deleting from the site is switched off
    right now. A moderator can delete this in Discord.", and on a message written in Discord, "Written in Discord: use
    Discord's own Delete.". Then run step 19's check again, and switch the replies back on:

    ```sh
    sed -i 's/^# LIBRARIUS_WEBHOOK_URL=/LIBRARIUS_WEBHOOK_URL=/' .env
    grep -c '^LIBRARIUS_WEBHOOK_URL=' .env
    docker compose up -d api
    ```

    Pass: the count is `1`, and step 1 passes again.
21. **A reply of another webhook (optional, at a quiet hour).** This makes the API send through a second webhook for a while,
    so that the replies sent so far are another webhook's. A member's reply sent in that while would go through the second
    webhook, so run it when nobody is replying, and only when nothing is waiting to be sent. This must print `0`:

    ```sh
    docker compose exec -T db psql -U salamanders salamanders_builds -c "select count(*) from librarius_outbox where state in ('pending', 'sending');"
    ```

    In Discord, make a second webhook on the Librarius forum by hand (Edit Channel → Integrations → New Webhook, named
    "Librarius check"), and copy its address. Run step 19's check. Then put the check webhook's address in `.env`, with the
    first one kept there, commented out: the first command comments it out, the `read` waits for the check webhook's address
    (paste it, and press Enter: it does not show), and the count must be `1`:

    ```sh
    sed -i 's/^LIBRARIUS_WEBHOOK_URL=/# LIBRARIUS_WEBHOOK_URL=/' .env
    [ -z "$(tail -c 1 .env)" ] || echo >> .env
    read -rs hook && echo "LIBRARIUS_WEBHOOK_URL=$hook" >> .env && unset hook
    grep -c '^LIBRARIUS_WEBHOOK_URL=' .env
    docker compose up -d api
    ```

    Send nothing through it. The replies of the steps above that are left were sent by another webhook than the one the API
    holds now. On one of them, from the site:
    - edit it. Pass: refused with "This reply was sent through an older webhook, so it can't be edited from the site. Delete it
      and post it again.";
    - delete it. Pass: it goes from Discord and from the site (the bot deletes it, which needs Manage Messages);
    - then restart the API, and wait for the catch-up that follows the restart to finish. The first command notes the time and
      restarts; run the second every minute until `caught_up` is `t`:

      ```sh
      restarted=$(date -u +%FT%TZ) && docker compose restart api
      docker compose exec -T db psql -U salamanders salamanders_builds -c "select last_ok_at > '$restarted' as caught_up, last_error from librarius_sync;"
      ```

      Pass: the replies that are left show as they did, in one piece, by the member who wrote them, and tagged "site".

    Then run step 19's check, and note the check webhook's id (an id, not a secret), which this prints:

    ```sh
    grep '^LIBRARIUS_WEBHOOK_URL=' .env | tail -n 1 | cut -d/ -f6
    ```

    Put the first address back: this deletes the check webhook's line and takes the comment off the first one, and the count
    must be `1`:

    ```sh
    sed -i '/^LIBRARIUS_WEBHOOK_URL=/d; s/^# LIBRARIUS_WEBHOOK_URL=/LIBRARIUS_WEBHOOK_URL=/' .env
    grep -c '^LIBRARIUS_WEBHOOK_URL=' .env
    docker compose up -d api
    ```

    Last, with the check webhook's id in place of `<check webhook id>`, this must print `0` before the check webhook is
    deleted in Discord:

    ```sh
    docker compose exec -T db psql -U salamanders salamanders_builds -c "select count(*) from librarius_parts where webhook_id = <check webhook id>;"
    ```

    If it is `0`, delete the check webhook (Edit Channel → Integrations → Webhooks → Librarius check → Delete Webhook). If it
    is not, a reply went out through the check webhook after all: keep that webhook, and say so. It is the only one that can
    ever edit that reply, and a webhook deleted in Discord cannot be brought back.
22. **A harmful link (optional).** Discord's own filter for harmful links answers 240000, and the site must treat it as a
    block: the reply is marked blocked, never sent again, and not retried. Do this only if you know of a link that Discord's
    filter refuses, and only once (two blocks within an hour stop all sending for an hour). First ask Discord where nobody
    else sees it, in the probe's private forum, whether it refuses that link from a webhook at all. There, make a webhook by
    hand (Edit Channel → Integrations → New Webhook) and copy its address. In the commands below, put the id of a post in the
    probe forum (the probe's own post will do) in place of `<probe post id>`, and the link in place of `<the link>`. The
    `read` waits for the webhook's address: paste it, and press Enter (it does not show).

    ```sh
    read -rs hook
    curl -s -K - -H 'Content-Type: application/json' -d '{"content": "<the link>"}' <<<"url = \"$hook?wait=true&thread_id=<probe post id>\"" | jq -r 'if .id then "posted" else "refused: \(.code) \(.message)" end'
    unset hook
    ```

    Then delete that webhook in the probe forum (and its message, if there is one). `refused: 240000` and Discord's text: the
    filter does act on what a webhook posts, so go on. `posted`: it does not, and a reply with that link would land in the
    Librarius, so stop here. To go on, put the link in a reply in the Librarius test post. Pass: the reply shows as blocked on
    the site at once, and this shows one `blocked` row for it, and one only:

    ```sh
    docker compose exec -T db psql -U salamanders salamanders_builds -c "select at, action, post_id, message_id, note from librarius_events where action = 'blocked' order by id desc limit 3;"
    ```

    If the link lands in Discord instead, delete the reply from the site at once. That answers the question too: Discord's
    filter does not stop what the webhook posts.
23. **No secret in the logs, again**, last: step 19's check, once more. Pass as there.

If a reply never leaves, look at the outbox and at what the site noted, from `server/`:

```sh
docker compose exec -T db psql -U salamanders salamanders_builds -c "select id, kind, state, attempts, last_error, next_at from librarius_outbox order by id desc limit 10;"
docker compose exec -T db psql -U salamanders salamanders_builds -c "select at, action, post_id, message_id, note from librarius_events order by id desc limit 10;"
```

`blocked` and `failed` entries are final; the member is shown why and can edit or delete the reply. A `last_error` for an entry
that is still `pending` is the last attempt's technical text.

A delete that the site queued itself (of the parts an edit dropped, of what a reply or an edit that ended for good left, or of
what was left of a reply after a part of it was deleted in Discord) is shown on no reply. One that ended for good is told once
in the API's log, and to the moderators in the reports channel when `REPORTS_WEBHOOK_URL` is set (see "An edit that makes a
reply shorter", above). The log goes when the container is made again; the entry stays in `librarius_outbox`. These find them,
from `server/`:

```sh
docker compose logs api | grep 'Librarius outbox: the delete'
docker compose exec -T db psql -U salamanders salamanders_builds -c "select id, state, last_error, payload->>'postId' as post_id, payload->>'replyId' as reply_id, payload->'partIds' as part_ids from librarius_outbox where kind = 'delete' and payload ? 'partIds' and state in ('failed', 'blocked') order by id desc limit 10;"
```

Each of `part_ids` that is still in the post `post_id` is a message for a moderator to delete in Discord; `reply_id` is empty
for a delete that names no reply.

### Rolling back the replies

Commands start from `server/`, in the checkout that holds `.env`.

- **Switching the replies off is the safe switch.** It comments out `LIBRARIUS_WEBHOOK_URL` in `.env`, so that the address
  stays there for later, and makes the container again, on the image you are running:

  ```sh
  sed -i 's/^LIBRARIUS_WEBHOOK_URL=/# LIBRARIUS_WEBHOOK_URL=/' .env
  docker compose up -d api
  ```

  The read side goes on, writes answer 503 (see "When replies are off"), and the outbox and the sweeper do not start. The
  replies already sent are still the site's: the import and the live feed know a message of the site by the webhook and the
  parts stored with it, and not by the address in `.env`, so a catch-up reads none of them as a message of its own. A reply
  that was queued but not sent waits in `librarius_outbox` for the address. To switch them on again:

  ```sh
  sed -i 's/^# LIBRARIUS_WEBHOOK_URL=/LIBRARIUS_WEBHOOK_URL=/' .env
  docker compose up -d api
  ```

- **The image before the replies.** The `pre-librarius-replies` tag of step 6 is the image from before the replies, and it does
  not know them. While no reply has been sent (between step 6 and the first live check), going back to it is safe, and that is
  what it is for. Once a reply has been sent, there are two ways back, and the first does no damage. The schema stays as it is
  in both: the new tables and columns are additive, and the old image ignores them.

  1. **Back with the Librarius off: the first choice.** For the old image's run, `LIBRARIUS_CHANNEL_ID` is commented out too.
     That image then answers 503 on every `/librarius` route and starts no gateway, import or link refresh, so it writes
     nothing over the replies. The cost: the Librarius is down on the site while it runs ("The Librarius couldn't be
     reached."), and "Delete on site" does not answer. The first command tags the image you leave, so that coming back needs
     no rebuild:

     ```sh
     docker tag server-api:latest server-api:librarius-replies
     sed -i 's/^LIBRARIUS_CHANNEL_ID=/# LIBRARIUS_CHANNEL_ID=/' .env
     docker tag server-api:pre-librarius-replies server-api:latest
     docker compose up -d --no-build --force-recreate api
     ```

     Pass: this answers 503:

     ```sh
     curl -s -o /dev/null -w '%{http_code}' localhost:8787/librarius/me
     ```

     To come forward again, to the image with the replies:

     ```sh
     sed -i 's/^# LIBRARIUS_CHANNEL_ID=/LIBRARIUS_CHANNEL_ID=/' .env
     docker tag server-api:librarius-replies server-api:latest
     docker compose up -d --no-build --force-recreate api
     ```

     Pass: the first of these prints `1`, the second answers 401, and live check 1 passes:

     ```sh
     grep -c '^LIBRARIUS_CHANNEL_ID=' .env
     curl -s -o /dev/null -w '%{http_code}' localhost:8787/librarius/me
     ```

     The catch-up then takes up what happened in Discord while the Librarius was off, as after any time the API was down.
  2. **Back with the Librarius on**, when it must stay readable: the same commands, back and forward, without their `sed`
     lines. Then, at its first catch-up (when it starts, after every gateway READY, and every 6 hours), the old image reads
     the forum again and writes over what the database holds of each reply of the site: part 1's row gets the webhook as its
     author, a `v2` reply shows no text (that image reads only a message's plain text), and parts 2 and 3 are stored as
     messages of their own. Discord is untouched, and the damage stays in the database after its cause has gone. The repair
     puts most of it right when the image with the replies is back ("The repair", above): the author (from the reply's
     layout, however old the reply), the text, the name, the picture and the reply link, and it removes the parts that were
     stored as messages. It cannot put right:
     - `edited_at`, the embeds and the stickers that the old image stored, so a repaired reply can show "(edited)" and link
       previews;
     - the pictures: part 1's stay as the old image stored them, and the pictures of parts 2 and 3 are not on the site any
       more (Discord still has them);
     - a reply whose part 1 was deleted in Discord while the old image ran. That image deletes the message, which takes the
       rows of its parts with it, and parts 2 and 3 stay in Discord and are stored as messages of their own, by the webhook
       (that image does not check parts 2 and 3 at a catch-up either). Back on the image with the replies, the repair cannot
       tell that they were parts, and nothing deletes them: a moderator deletes them in Discord, and the site follows.

     So come back to the image with the replies as soon as you can.
- **A webhook deleted in Discord:** the next call to it is refused for good, the outbox stops (the reply it held goes back to
  waiting), `sendingFatal` in `/librarius/me` says "The Librarius webhook was refused (status N): run
  librariusWebhookSetupRun to check it.", and every write answers 503 "Replying from the site is paused. Try again later."
  until the API is started again. Run the setup command as in step 3 of the setup, with one change: the first `sed` there is
  `sed -i '/^LIBRARIUS_WEBHOOK_URL=/d' .env`, which deletes the dead address. With the webhook gone it makes a new one. Then
  `docker compose up -d api`. The replies the old webhook sent are the old webhook's: see below. Do not delete the webhook for
  any other reason.
- **What stays.** Replies already sent stay in Discord and in the database. A webhook can change only its own messages, so a
  new webhook cannot edit or delete the replies of the old one: the site refuses an edit of such a reply ("This reply was sent
  through an older webhook, so it can't be edited from the site. Delete it and post it again."), and its delete goes through
  the bot, which needs Manage Messages. These replies are still known to the site, by the webhook that is stored with each
  part, so a catch-up does not show them in pieces, with the address unset, with a new webhook, or with the image current.
