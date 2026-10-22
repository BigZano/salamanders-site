# Handoff: Deathwatch backend — run it on Vulkan, then deploy (2026-10-21)

Branch `feat/dw-backend` (PR into `feat/deathwatch`). Plan:
`docs/superpowers/plans/2026-10-21-deathwatch-backend.md`. Everything here runs on the
Linux host **Vulkan** over SSH; there is no local Docker. The unit tests (2157) and the
100% coverage and mutation gate already pass on the Windows machine. What has **never
run** is the SQL against real Postgres and `e2e/tests/deathwatch-api.spec.js`, so do
steps 1 to 3 before anything else.

## 1. Pull the branch on Vulkan

```bash
cd ~/Documents/salamanders-site
git fetch origin
git switch feat/dw-backend
git pull
bun install --frozen-lockfile
```
Expect: `git log -1 --oneline` shows the branch head.

## 2. Run the e2e suite (this also proves the schema)

The e2e database starts empty and runs `server/schema.sql`, so a pass proves the new
DDL is valid. The new spec is `e2e/tests/deathwatch-api.spec.js` (7 tests, serial).
```bash
bun run test:e2e
```
Expect: every spec passes, the existing ones included (the mock gained users but the
roster counts must not change). Afterwards fix the root-owned leftovers:
```bash
docker run --rm -v "$PWD":/app alpine chown -R $(id -u):$(id -g) \
  /app/node_modules/.vite /app/public/archive-e2e /app/e2e/.archive /app/e2e/test-results
```
If anything fails, stop and bring the output back to a Claude session. Don't deploy on red.

## 3. Check the schema re-runs cleanly on a throwaway database

Production already has the older tables; the new DDL only adds four. Prove a second
run is a no-op before touching the real database:
```bash
docker run -d --name dw-check -e POSTGRES_PASSWORD=x -e POSTGRES_DB=t postgres:16-alpine
until docker exec dw-check pg_isready -U postgres -d t -h 127.0.0.1; do sleep 1; done
docker exec -i dw-check psql -v ON_ERROR_STOP=1 -U postgres -d t < server/schema.sql
docker exec -i dw-check psql -v ON_ERROR_STOP=1 -U postgres -d t < server/schema.sql
docker exec dw-check psql -U postgres -d t -c '\dt deathwatch_*'
docker rm -f dw-check
```
Expect: both runs print only `CREATE TABLE`/`NOTICE ... already exists, skipping`, no
`ERROR`; the listing shows `deathwatch_docs`, `deathwatch_doc_history`,
`deathwatch_grants`, `deathwatch_grant_events`.

## 4. One thing the e2e suite does not cover: the 4 MB server limit

`index.js` sets `maxRequestBodySize` to 4 MB, so Bun should refuse a bigger body before
any handler reads it, chunked or not. The reviewer could not confirm Bun enforces it on
chunked uploads. Against the running e2e or real API (any token; Bun answers before auth):
```bash
head -c 5000000 /dev/zero | curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' --data-binary @- http://localhost:8787/deathwatch/doc
head -c 5000000 /dev/zero | curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' -H 'Transfer-Encoding: chunked' --data-binary @- \
  http://localhost:8787/deathwatch/doc
```
Expect: `413` both times. Anything else (a 401, or a long pause) means Bun is not capping
chunked bodies; tell a Claude session, it is a small fix in `readJson`.

## 5. Deploy (when 1 to 4 are green and the PR is merged)

No role ids are in the repo; the area answers 503 "not configured" until both are set.
1. Apply the schema to the real database (idempotent): from `server/`,
   `docker compose exec -T db psql -v ON_ERROR_STOP=1 -U salamanders salamanders_builds < schema.sql`
2. Put the two role ids in `server/.env`: `DEATHWATCH_ROLE_ID=` and `WATCH_COMMANDER_ROLE_ID=`
   (the Discord role ids of the Deathwatch and the Watch Commander roles).
3. `docker compose up -d --build api`.
4. Check: `curl -s -H 'Authorization: Bearer x' https://builds-api.armorybot.win/deathwatch/me`
   gives `401 {"error":"Sign in with Discord."}` once the ids are set (and 503 "not
   configured" before). With a real Discord token it gives `{"access":…,"watchCommander":…}`.

The one-time import of the old site's data is a later job (cutover chunk); the area opens
empty until then.
