# Builds API

## Archive key (`GET /archive/key`)

Hands the Legion Archive decryption key to a caller whose Discord token is
valid and who currently holds the archive role in the guild. Anything
uncertain fails closed: 401 (sign in), 403 (no role), 503 (misconfigured or
Discord unreachable).

| Variable | Value |
|---|---|
| `ARCHIVE_KEY` | base64 key from `archive-export/.env` (also stored in a password manager) |
| `ARCHIVE_ROLE_ID` | `1377787723976409211` (XVIIIth Legion) |
| `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` | required — the role check is a bot guild-member lookup |

Until all four are set the endpoint answers 503 and the site shows
"couldn't be reached". Rotating the key (`bun run archive keygen --rotate`,
then `seal --publish`) requires updating `ARCHIVE_KEY` here and redeploying.
