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
