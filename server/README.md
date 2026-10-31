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

To put the entries in, apply the new table once (the command under "Existing databases" above), then, from this
folder, seed from the Companies data while it still holds them:

```sh
docker compose exec -T api bun run src/seedNotables.js < ../src/data/companies.json
```

It prints counts only, never a name, and is safe to re-run: each company in the file gets its entries replaced.
The file may instead be a JSON object of `companyId` → `[[name, ...lines], ...]`, which is how the entries are
changed later. A document it cannot store is refused with the position of the fault (`company 3, entry 2`),
not the text.

## Deathwatch (`/deathwatch/*`)

The Discord-role-gated Deathwatch area ("Watch Fortress Ebonhold"). Design:
`docs/superpowers/specs/2026-10-20-deathwatch-design.md`. Access is the Watch
Commander role, or a Deathwatch role, or a user id the Watch Commander has
granted, or being the guild owner or an Administrator; Commander status comes
only from the Commander role, never from a grant or from being an admin. Roles
are asked of Discord live. Reads (`/me`, `/data`) reuse a verdict for 30 seconds;
every write and grant change checks Discord afresh and drops the cached verdicts.
Any Discord failure answers 503: the area fails closed.

| Endpoint | Who | Notes |
|---|---|---|
| `GET /deathwatch/me` | any signed-in user | `{ access, watchCommander, deathwatchCommand }`; never 403 |
| `GET /deathwatch/data` | access | `{ teams, cfg, archive }`; `ETag`, 304 on `If-None-Match`; 403 without access |
| `POST /deathwatch/doc` | Watch Commander | `{ col, id, op: 'set' \| 'delete', doc }`; JSON content type required |
| `GET /deathwatch/grants` | Watch Commander | active grants |
| `POST /deathwatch/grants` | Watch Commander | `{ discordId }`; 201 new, 200 if already active, 409 at 200 active |
| `DELETE /deathwatch/grants/:discordId` | Watch Commander | revokes; 404 if none is active |

Limits: collections `teams`, `cfg`, `archive`; ids match `^[A-Za-z0-9_-]{1,64}$`; a
document is a JSON object of at most 1 MB with no U+0000 or lone surrogate (Postgres
`jsonb` cannot store them); a request body is at most 2 MB (the server refuses more than
4 MB outright); `discordId` is 17 to 20 digits. Document edits and grant changes are
recorded in `deathwatch_doc_history` and `deathwatch_grant_events`, in the same
transaction as the change.

| Variable | Value |
|---|---|
| `DEATHWATCH_ROLE_ID` | the Deathwatch role id, or several separated by commas with no spaces (a holder of any one gets in) — no default, required |
| `WATCH_COMMANDER_ROLE_ID` | the Watch Commander role id — no default, required |
| `DEATHWATCH_COMMAND_ROLE_ID` | the Deathwatch Command role id (one id, not the Watch Commander's) — optional. Its holders who also have access get `deathwatchCommand: true` from `/deathwatch/me`; it opens no route. Unset or not a single id, nobody holds it and nothing else changes |

Until **both** are set every `/deathwatch/*` route answers 503 "not configured". The role
ids are supplied at deploy time and never committed. To deploy: set both in `server/.env`,
apply the schema (idempotent, command in the reports section above) before starting the new
image, then restart the API. The one-time import of the old site's data is a separate job.
