# Builds API

## Archive key (`GET /archive/key`)

Hands the Legion Archive decryption key to a caller whose Discord token is
valid and who is on the XVIIIth Legion member list — the same
`src/data/discord-members.json` that ranks builds, kept current by the
`discord-members.yml` workflow (every 8 hours and on build submission). The
server reads it from `main` and caches it for 5 minutes. Anything uncertain
fails closed: 401 (sign in), 403 (not on the list), 503 (misconfigured, list
for another guild/role, or upstream unreachable).

| Variable | Value |
|---|---|
| `ARCHIVE_KEY` | base64 key from `archive-export/.env` (also stored in a password manager) |
| `ARCHIVE_ROLE_ID` | `1377787723976409211` (XVIIIth Legion) |
| `DISCORD_GUILD_ID` | required — must match the member list's `guildId` |
| `ARCHIVE_MEMBERS_URL` | optional — defaults to the raw `discord-members.json` on `main` |

No bot token is needed. Until the required values are set the endpoint answers 503 and the site shows
"couldn't be reached". Rotating the key (`bun run archive keygen --rotate`,
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

## Deathwatch (`/deathwatch/*`)

The Discord-role-gated Deathwatch area ("Watch Fortress Ebonhold"). Design:
`docs/superpowers/specs/2026-10-20-deathwatch-design.md`. Access is the Watch
Commander role, or the Deathwatch role, or a user id the Watch Commander has
granted; Commander status comes only from the role, never from a grant. Roles
are asked of Discord live. Reads (`/me`, `/data`) reuse a verdict for 30 seconds;
every write and grant change checks Discord afresh and drops the cached verdicts.
Any Discord failure answers 503: the area fails closed.

| Endpoint | Who | Notes |
|---|---|---|
| `GET /deathwatch/me` | any signed-in user | `{ access, watchCommander }`; never 403 |
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

Until **both** are set every `/deathwatch/*` route answers 503 "not configured". The role
ids are supplied at deploy time and never committed. To deploy: set both in `server/.env`,
apply the schema (idempotent, command in the reports section above) before starting the new
image, then restart the API. The one-time import of the old site's data is a separate job.
