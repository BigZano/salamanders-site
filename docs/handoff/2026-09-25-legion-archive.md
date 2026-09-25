# Handoff: Legion Archive shipped; frontend design next (2026-09-25)

For the next session, on the Windows workstation. The work so far happened on
the Linux host **Vulkan** (reached over SSH), which also runs the builds API.
This repo is public, so this document holds no secrets and no archive content.

## What shipped

`/accolades` and `/ranks` (and `/<collection>/<threadId>` sub-pages) render two
Discord forum exports, readable only by members of the XVIIIth Legion role.

- Spec: `docs/superpowers/specs/2026-09-24-legion-archive-design.md`
  (including the "Display pruning" and "Membership source" amendments).
- Plan: `docs/superpowers/plans/2026-09-24-legion-archive.md`.
- Live: deploy `cf41617` onwards; release `archive-v1` holds the encrypted files.

How it fits together:

1. `archive-export/` (gitignored, local only) holds the plaintext exports, the
   key (`.env` → `ARCHIVE_KEY`), `collections.json` and `link-fixes.json`.
2. `bun run archive seal --publish` encrypts everything and uploads a GitHub
   Release, writing `archive.lock.json` (committed: file hashes, key id, tag).
3. The deploy workflow downloads the release into `public/archive/`, checks
   every file against the lock, builds, and scans `dist/` for plaintext.
4. In the browser, the page asks `GET /archive/key` on the builds API for the
   key. The API confirms the caller with Discord (their own sign-in token) and
   checks them against `src/data/discord-members.json` on `main` — the same
   member list that ranks builds (synced every 8 h and on build submission,
   by `discord-members.yml`). No bot token is involved.
5. The browser decrypts in memory and renders Discord markdown with Vue
   render functions (no `v-html`). Links resolve in-site or render as text;
   the tables of contents show only live links and their headings.

## Infrastructure on Vulkan

| Piece | Where | Notes |
|---|---|---|
| Builds API + Postgres | `server/docker-compose.yml` → containers `server-api-1` (port 8787), `server-db-1` | `cd server && docker compose up -d --build api` after server changes. Bun auto-loads `server/.env`. |
| Public API hostname | `builds-api.armorybot.win` → `localhost:8787` | Cloudflare Tunnel via systemd unit `cloudflared-salamanders-builds-api.service` (config in `~/.cloudflared/salamanders-builds-api.yml`). Another tunnel on the host (`cloudflared-api-tunnel.service`) belongs to a different project — leave it alone. |
| Site | GitHub Pages, `buildforge.armorybot.win` | Deployed by `.github/workflows/deploy.yml` on push to `main`. `VITE_BUILDS_API_URL` is a repo variable pointing at the tunnel hostname. |
| Build relay | `relay/` (Cloudflare Worker) | Unchanged; wakes the member-sync workflow on build submission. |
| e2e stack | `e2e/docker-compose.yml` (`bun run test:e2e`) | Its web container runs as root on the bind-mounted repo and leaves root-owned files (`node_modules/.vite`, `public/archive-e2e`, `e2e/.archive`, `e2e/test-results`). On Linux, fix with `docker run --rm -v "$PWD":/app alpine chown -R $(id -u):$(id -g) /app/...`. |

`server/.env` keys (names only): `POSTGRES_PASSWORD`, `ALLOWED_ORIGIN`,
`DISCORD_GUILD_ID`, `ARCHIVE_KEY`, `ARCHIVE_ROLE_ID`; `DISCORD_BOT_TOKEN`
currently holds a placeholder and is unused unless `DISCORD_MOD_ROLE_ID` is set.
Other ports on Vulkan are taken by unrelated projects (e.g. 5173 by another
dashboard), so use `ARCHIVE_DEV_PORT` there.

## Setting up the Windows checkout for design work

1. `git pull` on `main`, then `bun install`.
2. **Delete the old plaintext folders** copied over before the archive moved
   (they're gitignored, but Vite serves `public/` and copies it into `dist/`):
   `public/accolades`, `public/rank-requirements`, `src/data/accolades`,
   `src/data/rank-requirements`.
3. Copy the local-only archive folder from Vulkan (pwsh, from the repo root):
   `scp -r artellus@<vulkan>:Documents/salamanders-site/archive-export .`
   It includes the key, so keep it out of anything synced or shared.
4. Get the encrypted files: `bun run archive fetch` (needs `gh` signed in and
   `tar`), or `scp -r artellus@<vulkan>:Documents/salamanders-site/public/archive public/`.
5. `bun run archive:dev` starts Vite plus a local key server (127.0.0.1 only).
   Open `http://localhost:5173`, then fake a signed-in member once in DevTools:
   ```js
   localStorage.setItem('salamanders-discord-member', JSON.stringify({ id: '1', username: 'dev',
     isMember: true, checkedAt: Date.now(), accessToken: 'dev', expiresAt: Date.now() + 864e5 }))
   ```
   and reload `/accolades` or `/ranks`. (The fake account is only for local
   viewing; real access control is on the API.)

## Where the design lives

- `src/components/archive/ArchiveThread.vue` — thread layout and all markdown
  styles (scoped `:deep(.md-*)` rules).
- `src/components/archive/ArchiveMarkdown.js` — the element each markdown node
  becomes (headings shift down one level: `#` → `h2`).
- `src/components/archive/ArchiveGate.vue` — sign-in / restricted / error states.
- `src/components/archive/ArchiveImage.vue` — emoji and attachments (lazy).
- `src/views/ArchiveView.vue`, `src/components/AppNav.vue` (Accolades/Ranks
  entries appear only for members).
- Site-wide tokens: `src/style.css` (colours, fonts: Oswald display).

Design constraints that come from the feature, not taste:
- Text content, spelling and link targets are as exported; don't hard-code
  anything from the archive into components (the repo is public).
- Tables of contents render through `tocOnly` (live links + headings only).
- Spoilers must stay click/keyboard-to-reveal; images stay lazy with alt-text
  fallback; keep visible focus.

## Guard rails

- Pre-commit: leak guard (blocks archive paths, raw-export JSON, export image
  bytes) + unit tests. Pre-push: full suite, 100 % coverage and 100 % Stryker
  mutation on `src/lib/archive/{crypto,links,markdown,audit,prune}.js` and
  `server/src/archiveKey.js` (about 4 minutes), then a build scan.
- Changing archive content or link fixes: edit `archive-export/`, run
  `bun run archive audit`, then `bun run archive seal --publish`, commit
  `archive.lock.json`. Don't commit a lock from a plain `seal` (no
  `--publish`) — it points at files that aren't in any release.
- Rotating the key: `bun run archive keygen --rotate`, `seal --publish`, update
  `ARCHIVE_KEY` in `server/.env`, rebuild the API. Keep the key in a password
  manager.

## Open items (deferred, from the final review)

- Cold deep links can land slightly low in browsers without scroll anchoring.
- Missing WebCrypto (non-HTTPS, non-localhost origin) shows "integrity check"
  instead of an "unsupported connection" message.
- Discord-owned hosts beyond discord.com/discordapp.com/discord.gg aren't in
  the no-Discord-links check (none appear in the current data).
- A link label containing a URL renders a link inside a link.
- `__ARCHIVE_BASE__` ignores `SITE_BASE`.
- Non-snowflake thread URLs fall through to the site-wide 404.
- `/archive/key` accepts sign-in tokens issued to other Discord apps.
- Blob-URL cache is unbounded per session; no `Retry-After` handling; an image
  that decrypts but can't decode shows broken instead of its alt text.
