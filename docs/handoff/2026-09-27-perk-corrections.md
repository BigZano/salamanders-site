# Handoff: Perk corrections — run on Vulkan, then go live (2026-09-27)

Everything here runs on the Linux host **Vulkan** over SSH. The Windows
workstation has no Docker, so the two checks that need it have not run yet:
the e2e suite and the schema SQL. This repo is public, so this document holds
no secrets.

## What's on the branch

Branch `feat/perk-corrections`. Design:
`docs/superpowers/specs/2026-09-27-perk-corrections-design.md` (including the
input-sanitization amendment). Plan:
`docs/superpowers/plans/2026-09-27-perk-corrections.md`.

- Techmarine, Mechadendrite Expert, Master of the Forge, Legion Hierarchy and
  Administrators correct weapon and class perks from the live site. Edits go
  live at once, layered over the wiki bake; each one pings `REPORTS_WEBHOOK_URL`.
- The **Version History** page (`/history`) lists every perk correction,
  deleted build and privilege change. Nothing is ever purged.
- Master of the Forge can revoke Techmarines and Mechadendrite Experts;
  Administrators can revoke anyone below them. Revoked means normal member.
- Techmarines can now delete other people's builds. Deletes are soft deletes
  and show up in the history.
- All user-typed text is sanitized (NFC, invisible characters stripped,
  whitespace collapsed; limits checked after cleaning). Webhook text has Discord
  markdown escaped.

The unit suite passes on Windows; only the four archive tests that need the
local-only export are skipped.

## Before you start

The branch is on GitHub (`origin/feat/perk-corrections`). Any later fixes get
pushed to the same branch, so run `git pull` in step 1 even if you checked it
out before.

## 1. Pull the branch on Vulkan

```bash
cd ~/Documents/salamanders-site
git fetch origin
git switch feat/perk-corrections
git pull
bun install --frozen-lockfile
```
Expect: `git log -1 --oneline` shows the branch head.

## 2. Run the e2e suite (also proves the schema)

The e2e database starts empty and runs `server/schema.sql`, so a pass here
also proves the new SQL is valid.
```bash
bun run test:e2e
```
Expect: every spec passes, including `e2e/tests/perks.spec.js` ("a Techmarine
corrects a perk, members see it, the Forge revokes the Techmarine").

Afterwards, fix root-owned leftovers from the web container, as before:
```bash
docker run --rm -v "$PWD":/app alpine chown -R $(id -u):$(id -g) \
  /app/node_modules/.vite /app/public/archive-e2e /app/e2e/.archive /app/e2e/test-results
```
If the perks spec fails, stop here and bring the output back to a Claude
session. Don't go live on a red run.

## 3. Check the schema re-runs cleanly on a throwaway database

Production already has the `builds` and `reports` tables, and the new schema
only adds to them. Prove a second run is a no-op before touching the real
database:
```bash
docker run -d --name pc-check -e POSTGRES_PASSWORD=x -e POSTGRES_DB=t postgres:16-alpine
until docker exec pc-check pg_isready -U postgres -d t -h 127.0.0.1; do sleep 1; done
docker exec -i pc-check psql -v ON_ERROR_STOP=1 -U postgres -d t < server/schema.sql
docker exec -i pc-check psql -v ON_ERROR_STOP=1 -U postgres -d t < server/schema.sql
docker rm -f pc-check
```
Expect: both runs finish with no `ERROR`.

## 4. Merge to main

Open a PR from `feat/perk-corrections`, or merge locally and push `main`. The
deploy workflow runs on the push to `main`. Until step 5 is done, its snapshot
step logs "Keeping the committed perk corrections snapshot". That's expected.

## 5. Update the live API and database

```bash
cd ~/Documents/salamanders-site
git switch main && git pull
cd server
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U salamanders salamanders_builds < schema.sql
docker compose up -d --build api
docker compose exec -T api bun run src/seed.js < ../src/data/perk-corrections.json
curl -s localhost:8787/perk-corrections | head -c 300; echo
```
Expect:
- the schema run ends with no `ERROR`
- the seed prints `Seeded 45 perk corrections.` (a second run prints
  `Already seeded — nothing to do.`). The seed reads the wiki bake from GitHub
  to record what each correction replaced. If it prints a warning that the bake
  couldn't be loaded, the rows still go in, just without before/after in the
  history.
- the curl output starts with `{"version":` and mentions `Occulus Bolt Carbine`

New, optional environment variables. Empty means the built-in defaults, which
are the live guild's ids and GitHub `main`:
`BAKE_BASE_URL`, `TECHMARINE_ROLE_ID`, `MECHADENDRITE_ROLE_ID`,
`FORGE_ROLE_ID`, `HIERARCHY_ROLE_ID`. `DISCORD_MOD_ROLE_ID` is no longer read.
If `server/.env` still sets it, delete the line.

## 6. Redeploy the site

This makes the bundled snapshot pick up the real correction ids. The deploy
reads the API address from the repo variable `VITE_BUILDS_API_URL` (currently
`https://builds-api.armorybot.win`). If that variable is ever unset, the live
site can't reach the API and the whole feature disappears.
```bash
gh variable list | grep VITE_BUILDS_API_URL
gh workflow run "Deploy to GitHub Pages"
```

## 7. Smoke test on the live site (signed in as an Administrator)

1. The nav shows **Version History**. Open it: the 45 seeded rows are there,
   by `system (error report 2026-09-27)`.
2. Armoury → Occulus Bolt Carbine: the Standard tier shows Great Might and
   Remote Threat, and Remote Threat's detail panel shows "Corrected in game".
3. Click a perk to pin its detail panel, choose **Edit text**, change a word,
   add a note, save. The page updates at once, and the webhook channel gets
   the message.
4. In Version History, open that entry. It shows Before and After. **Revert**
   it.
5. Signed out, or as a plain member: no edit buttons, no Version History link.

## Rolling back

The schema only adds tables and columns, so rolling back is just redeploying
the previous API image and site (`git switch` to the previous `main` commit,
`docker compose up -d --build api`, redeploy the site). The new tables stay
behind, unused, and nothing in the database needs reverting.

## Release note for members

Perk picks on the corrected weapons (Occulus Bolt Carbine, Bolt Rifle and the
others in the error report) that were saved after the 2026-09-27 perk fix went
live may not reload. Before this release, those weapons' perks were numbered
by position, and the numbering changed. The window was a few hours. Re-pick
them if a tree looks short. Corrections from now on never shift saved picks.

## Open items (deferred, from the reviews)

Carried over from the task reviews. None blocks go-live. Worth a follow-up
session:
- Each signed-in page load asks Discord three times who the caller is (bot
  token, shared with reports and the archive). If Discord rate-limits it, the
  edit controls hide until the next load. It's uncached on purpose so
  revocations take effect immediately; add a short cache if 429s show up.
- Class perks can only be corrected from the Perk Builder's "Why this pick?"
  box. That means the editor has to pick the perk into their own build first,
  and can't reach perks above their build's level. A dedicated class-perk edit
  view would fix it. This is a UX decision for Bret.
- The "Corrected" tag shows the date, not who made the correction. The name is
  one click away in Version History.
- A build save accepts at most 40 stored picks per weapon. Orphaned picks are
  kept on purpose, so a member who re-picks a big tree after several re-bakes
  could hit that and get a save error. Raise the cap, or save only live picks.
- Justifications are capped per entry (1000 characters) but not in how many
  entries a build can carry.
- The weapon slot's "points spent" summary can read one higher than the tree
  after a correction removes a picked perk.
- History search treats `%` and `_` as wildcards.
- The revoked member's name comes from the request, not from Discord.
- Revoke and Revert buttons are offered even where the server will refuse
  (the server's message is shown).
- `docs/handoff/2026-09-25-legion-archive.md` still mentions
  `DISCORD_MOD_ROLE_ID`.
