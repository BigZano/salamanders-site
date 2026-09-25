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

Run these in **PowerShell 7 from the repo root** on the Windows machine.
`<vulkan>` is the Linux host you normally SSH into (same user/host as your
`ssh` command). Do the steps in order and check each "Expect" before moving on.

**1. Update the checkout.**
```pwsh
git switch main
git pull
bun install
```
Expect: `git log -1 --oneline` shows the handoff commit or later.

**2. Delete the pre-move plaintext copies.** An earlier session copied the
exports into `public/` and `src/data/` before they moved to `archive-export/`.
They're gitignored, but Vite serves everything in `public/` and copies it into
`dist/`, so they must go.
```pwsh
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue `
  public/accolades, public/rank-requirements, src/data/accolades, src/data/rank-requirements
```
Expect: `Test-Path public/accolades, public/rank-requirements, src/data/accolades, src/data/rank-requirements`
prints `False` four times.

**3. Copy the local-only archive folder from Vulkan.** It holds the plaintext
exports, `collections.json`, `link-fixes.json` and the key (`.env`). Never
commit it, sync it to cloud storage, or paste its contents anywhere.
```pwsh
scp -r artellus@<vulkan>:Documents/salamanders-site/archive-export .
```
Expect: `Test-Path archive-export/.env, archive-export/link-fixes.json` prints
`True` twice, and `git check-ignore archive-export/.env` prints the path
(meaning it's ignored).

**4. Copy the encrypted files** (the same ones the release and live site use):
```pwsh
scp -r artellus@<vulkan>:Documents/salamanders-site/public/archive public/
```
Expect: `(Get-ChildItem public/archive -File).Count` is `257`, matching the
file count in `archive.lock.json`. (Alternative: `bun run archive fetch`, which
needs `gh` signed in and `tar`.)

**5. Confirm nothing archive-related is visible to git, then run the tests.**
```pwsh
git status --short
bun run test
```
Expect: `git status` lists nothing under `archive-export`, `public/archive`,
`public/accolades`, `public/rank-requirements` or `src/data/`. The tests all
pass, including the local-only ones that read `archive-export/` (they'd say
"skipped" if step 3 was missed). The e2e suite needs Docker and runs on Vulkan;
skip it here.

**6. Start the local preview.**
```pwsh
bun run archive:dev
```
Expect: `archive dev key server on http://127.0.0.1:8799 (local only)` followed
by Vite's `http://localhost:5173/` line. If it says the key doesn't match
`archive.lock.json`, step 3 or 4 copied from a different seal; redo both.
If 5173 is taken, set another port first:
`$env:ARCHIVE_DEV_PORT = 5175; bun run archive:dev`.

**7. Sign in as a fake member (local only)** and open the pages. In Chrome,
open `http://localhost:5173`, then in DevTools → Console:
```js
localStorage.setItem('salamanders-discord-member', JSON.stringify({ id: '1', username: 'dev',
  isMember: true, checkedAt: Date.now(), accessToken: 'dev', expiresAt: Date.now() + 864e5 }))
```
Reload, then visit `/accolades` and `/ranks`. Expect: the tables of contents
render (headings plus links only), links open thread sub-pages, and the nav
shows Accolades and Ranks. This fake account only works against the local key
server; the real site checks Discord.

**Before committing design work:** the pre-commit hook runs the leak guard and
tests; the pre-push hook runs the full gate (about 4 minutes). Don't bypass them
with `--no-verify`.

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
