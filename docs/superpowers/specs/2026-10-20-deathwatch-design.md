# Deathwatch area — "Watch Fortress Ebonhold" on the Salamanders site

Date: 2026-10-20
Status: draft, awaiting review

> This repo is public. This document describes mechanism only. It must never
> contain member names, Discord user ids, role ids, passwords or real event
> data. Real data lives only in the Postgres database on the deployment server.

## Goal

The Deathwatch community branch (headed by the Watch Commander) runs a site,
`watchfortress-ebonhold.com`, on PHP webspace behind two shared passwords. Bring
it onto the Salamanders site as a **Discord-role-gated area at `/deathwatch`**,
rebuilt in Vue, phone-first, in a scoped sub-theme. The Watch Commander keeps
developing it through pull requests, and can grant individual people access by
Discord UserID from an admin dashboard.

## Scope and non-goals

In scope (the **archive build**, `dist.7z`, is the baseline):

- Hub: Event Tracker, Armouring Hall, Chronicles of Valor, and a link back to the
  Salamanders site.
- Event Tracker: Standings, Kill Teams, Players, Honour Roll, Game Stats, Scoring,
  Archive.
- Manage: the Watch Commander's dashboard (edit documents, grant and revoke access).
- A "REDACTED" banner on `/companies` that leads in.

Non-goals:

- The live site is newer than the archive. Its extra tiles (Accolades, Battlemap,
  an "Enlist" poster) are **not** ported by us; they are the Watch Commander's
  first pull request once the baseline exists.
- Hall of Relics is a Discord forum channel. A later, Legion-Archive-style job.
- A light theme. The area is dark only, like the rest of the site.
- Secrecy of content. Lore and mission text may live in the repo. Names may not.

## What exists today (archive findings)

- Vanilla JavaScript, not a framework: about 110 KB of readable logic (functions
  such as `calc`, `setArea`, `podium`), HTML built with `innerHTML` template
  strings (66 places), plus ~4 MB of inline base64 images and CSS. One HTML file.
- Data is three collections of documents (`teams`, `cfg`, `archive`), each a map
  of id to a JSON object. `cfg.s` holds 13 scoring weights. An archived tour holds
  its name, date, a snapshot of the scoring weights, its teams and a summary.
- The old API: a viewer reads everything once past the entry password; an admin
  password allows `set` and `delete` of one document; one backup per day. Pages
  poll for changes every few seconds with an ETag.
- Auth today is two shared passwords. Both are retired by this work.
- Look: dark green-black, accent `#7fd35c`, a serif display face (Cinzel), a
  condensed sans (Barlow Condensed and Teko), a blackletter accent, painted
  full-bleed backdrops, and a light theme.

## Decisions

| Area | Decision |
| --- | --- |
| Access | Deathwatch role (one or several), or Watch Commander role, or a UserID the Watch Commander has granted, or the guild owner or anyone holding an Administrator role. The Legion role alone never opens it, and is not required. Owner and Administrator open the area but are not the Commander. Checked live on the server; fails closed. |
| Grants | View-only. Watch Commander status only ever comes from the Discord role, never from a grant. |
| Banner | Shown to everyone. Signed out: one click starts Discord sign-in and returns to `/deathwatch`. Signed in: goes to `/deathwatch`. No role lookup on `/companies`. |
| Secrecy | Thematic. Names never in the repo; fixtures use invented names. |
| Look | Scoped dark sub-theme on the site tokens, painted backdrops as optimized files, Cinzel for titles, light rising sparks. |
| Mobile | Site-wide baseline first. Event Tracker navigation is the banner, which opens a bottom sheet. Real-phone checked. |
| Data | Postgres JSON document store plus grants and audit tables. |
| Source | Port from the archive build by reading its code and the live pages. |
| Repo | Fork flow into `feat/deathwatch`; `main` is protected from force-push and deletion. |

## Architecture

### Routes and views

- `/deathwatch` (hub) and `/deathwatch/eventtracker/:view?`, `/deathwatch/armouringhall`,
  `/deathwatch/chronicles`, `/deathwatch/manage`, added to `src/router.js` as lazy
  imports so none of it loads for other pages. The old URL shapes (`/eventtracker/...`)
  are kept as the paths beneath `/deathwatch` so existing links can be redirected.
- Code lives under `src/views/deathwatch/`, `src/components/deathwatch/` and
  `src/lib/deathwatch/`. The pure logic (scoring, standings, podium) is separate
  from components so it can be tested hard.

### Access and the gate

One gate component wraps every `/deathwatch/*` view. It does not use the client
`isMember` hint (that is the Legion list, and a Deathwatch member need not be on
it). It asks the server (`GET /deathwatch/me`) and shows one of five states:

| State | When | Shown |
| --- | --- | --- |
| signed-out | no Discord session, or the server answers 401 | themed gate with the Discord sign-in button |
| checking | `/me` in flight | short "verifying" state, reserves the layout |
| allowed | `access: true` | the page |
| denied | `access: false` | themed restricted notice, no data requested |
| unavailable | network error or 5xx | retry button |

The client check only decides what to show. Every data and write request is
enforced again on the server.

### Banner on `/companies`

A small `DeathwatchBanner.vue`, inserted in `src/views/Companies.vue` with a tiny
diff so the Watch Commander's work does not collide with that shared file. It is an
anchor to `/deathwatch` whose click handler, when signed out, prevents the default
and calls `auth.signIn({ returnTo: '/deathwatch' })`; when signed in the router
navigates normally. The label is "REDACTED". It fetches nothing.

### Sign-in return path

`discordAuth.beginSignIn` stores the return path in `sessionStorage`. On phones the
Discord authorize step may be handed to the Discord app and return in a different
browser context, where `sessionStorage` is empty and the user would land on `/`.
`signIn` therefore also writes the return path to `localStorage` with a timestamp
(honoured for ten minutes), and `scrubCallbackHash` falls back to it. Whether this
is sufficient is checked on real phones.

### Sub-theme and motion

- A wrapper class sets Deathwatch tokens on top of the site tokens (accent near
  `--color-drake`, deeper blacks, gold for honours). Body text stays on the site's
  fonts; Cinzel (600 and 700) is self-hosted through `@fontsource` for titles. The
  blackletter face and Barlow/Teko are adopted only if a ported view demonstrably
  needs them; otherwise they map to Oswald and the system sans. No Google Fonts
  requests.
- Painted backdrops are real files: AVIF/WebP at two or three widths,
  `loading="lazy"` except the first view, dimensioned to avoid layout shift.
- Sparks: add a low-density Deathwatch profile to `src/lib/fireTuning.js` for
  `MountDeathfire.vue` and use the route's `ashOver` flag, so there is one fire
  system. If the painted backdrop hides it, fall back to a small CSS spark layer.
  Both are off under `prefers-reduced-motion`.

### Navigation on phones: the banner opens a bottom sheet

On the Event Tracker the header banner (crest image, current view name, a chevron)
is the menu button. Tapping it opens a **bottom sheet** listing the seven views and
"Back to the Fortress". The same list renders as the always-visible sidebar on wide
screens, so it is one component with two layouts.

The sheet must have: drag-to-dismiss with a velocity threshold, a scrim, focus
trapped inside while open and returned on close, `Escape` to close, scroll lock on
the page with `overscroll-behavior: contain` inside, `100dvh` and
`env(safe-area-inset-bottom)` padding, `touch-action` on the drag handle, and
transitions on `transform` and `opacity` only (under 300 ms, `ease-out`), with a
reduced-motion variant. A bottom sheet is used rather than a left drawer because
iOS Safari reserves the left-edge swipe for browser Back. The hub tiles stack as
full-width cards on phones.

### Data layer (frontend)

A store (modeled on `src/stores/roster.js`) holds `{ teams, cfg, archive }`. It
polls `GET /deathwatch/data` with `If-None-Match` every 15 seconds while the tab is
visible and not at all while hidden. The Watch Commander's edits write one document
at a time through `POST /deathwatch/doc` and the store refetches. All text from
documents is rendered through Vue interpolation. **`v-html` is forbidden in this
area** (the archive's `innerHTML` templating would turn entered text into markup);
a test asserts none is used.

### Backend (`server/`)

Modeled on the reports feature (`reports.js`, `reportsStore.js`, audit table) and
the live Discord helpers in `discordRoles.js` (`identify`, `rolesOf`). A
`createDeathwatchHandler` is wired into `server/src/index.js` the same way the
reports handler is.

Access verdict for a bearer token:

1. `identify(request)` gives the Discord user, or null (401).
2. `rolesOf(user.id)` gives the held roles (null = not in the guild).
3. `watchCommander` = holds the Watch Commander role.
4. `access` = `watchCommander` or holds a Deathwatch role or has an active grant or is the guild owner or holds an Administrator role (`discordRoles.isAdmin`, asked last and only of someone nothing else admits). Administrators never get `watchCommander`.
5. `deathwatchCommand` = `access` and holds the Deathwatch Command role (`DEATHWATCH_COMMAND_ROLE_ID`, one id, a different role from the Watch Commander). From the role only: never from a grant, from being the owner or an Administrator, or from the Watch Commander role. It opens no route and no data; the front end uses it to show the Watch Command tab. Optional: unset or malformed, nobody holds it and the area is unaffected.
6. Any Discord failure (`Upstream`) fails closed (503).

`discordRoles.js` asks Discord on every call and has no cache. Reads (`/me`,
`/data`) therefore use a short in-memory verdict cache keyed by a hash of the token
(30 seconds), so polling does not spend two Discord calls per viewer per poll.
**Writes and grant changes never use the cache**: they re-check live every time.

| Endpoint | Who | Notes |
| --- | --- | --- |
| `GET /deathwatch/me` | any signed-in user | `{ access, watchCommander, deathwatchCommand }`; never 403 |
| `GET /deathwatch/data` | access | `{ teams, cfg, archive }`; ETag, 304 on match; 403 if no access |
| `POST /deathwatch/doc` | Watch Commander | `{ col, id, op: 'set' \| 'delete', doc }`; JSON content type required |
| `GET /deathwatch/grants` | Watch Commander | active grants |
| `POST /deathwatch/grants` | Watch Commander | `{ discordId }`; idempotent |
| `DELETE /deathwatch/grants/:discordId` | Watch Commander | sets `revoked_at` |

Limits and validation: collection whitelist (`teams`, `cfg`, `archive`); id matches
`^[A-Za-z0-9_-]{1,64}$`; a document must be a JSON object, at most 1 MB (the archive's
whole data file is about 160 KB); request body at most 2 MB; `discordId` matches
`^\d{17,20}$`; at most 200 active grants. Same CORS origin rule as the other routes.
Authentication is a bearer header, not a cookie, so there is no CSRF surface.

Schema shape (final DDL in the plan; applied with `schema.sql` on the deployment
server, idempotent like the existing tables):

```sql
deathwatch_docs(col, id, doc jsonb, updated_at, updated_by, primary key (col, id))
deathwatch_doc_history(id, col, doc_id, op, doc, actor_discord_id, created_at)   -- replaces the old daily file backup
deathwatch_grants(discord_id primary key, granted_by, granted_at, revoked_at, revoked_by)
deathwatch_grant_events(id, discord_id, actor_discord_id, action 'granted'|'revoked', created_at)
```

History and grant events are written in the same transaction as the change.
Environment: `DEATHWATCH_ROLE_ID`, `WATCH_COMMANDER_ROLE_ID` (no defaults in code), and the optional
`DEATHWATCH_COMMAND_ROLE_ID`, documented in `server/README.md` and `docker-compose.yml`.

### Fixtures and local development

The frontend is built on the dev machine against a fixture adapter (as the roster
does with `src/lib/rosterFixture.js`): `VITE_DEATHWATCH_FIXTURE=1` serves invented
data, and `?scene=` selects `signed-out`, `checking`, `allowed`, `denied`,
`unavailable`, plus data scenes such as `empty` and `active-event`. The backend is
written and unit-tested here and deployed and end-to-end tested on the deployment
server only (there is no local Docker).

## Mobile requirements

Site-wide baseline (its own pull request to `main`, before the area):

- `viewport-fit=cover` in the viewport meta.
- `-webkit-tap-highlight-color: transparent`, `-webkit-text-size-adjust: 100%`.
- `touch-action: manipulation` on buttons, links and `[role="button"]`.
- Inputs at 16 px.
- The shared `.btn-ember` and `.btn-drake` hovers gated behind
  `(hover: hover) and (pointer: fine)`; every control keeps an `:active` state.
- The dev server reachable on the LAN for phone testing.
- Deliberately **not** `overscroll-behavior: none` (the site is mostly scrolling
  documents where pull-to-refresh should stay) and not `user-select: none` on the body.
- The ~36 per-component `:hover` rules (21 files) are a separate, later sweep.

Deathwatch area: one nav system; sheet as above; tables that fit a phone (a
horizontal scroll container with `overscroll-behavior-x: contain`, or stacked rows,
decided per view while porting); no `100vh` for app shells; safe-area padding on
anything fixed to the bottom; images sized for the viewport.

Needs a real phone (cannot be verified from code or desktop emulation): sticky
hover, tap flash, URL-bar behaviour with `dvh`, input zoom, sheet drag and
rubber-band, safe areas, the iOS left-edge swipe, the sign-in return path through
the Discord app, and first-load time.

## Security and hygiene

- The client gate is cosmetic. The server enforces access on every read and write.
- Watch Commander-only operations re-verify the role live, uncached.
- Document text is rendered by interpolation only; never `v-html`.
- Names and ids stay out of git: fixtures are invented, real data is imported once
  by a script run on the deployment server, screenshots with real data stay out of
  the repo, and the existing leak guard and build scan must still pass.
- `src/data/discord-members.json` publishes the Legion list in the repo. Deathwatch
  deliberately does **not** follow that pattern; its checks are live.
- The two shared passwords are retired with the old site.
- The grants and document writes are audited (who, what, when).

## Repository workflow

- Long-lived integration branch `feat/deathwatch`. The Watch Commander forks, works
  on branches in the fork, and opens pull requests into `feat/deathwatch`. Bret
  merges `feat/deathwatch` into `main` at milestones.
- The repo is owned by a personal account, so only owner and collaborator-with-Write
  exist (no Triage). Write would let a collaborator push to the auto-deploying
  `main` and run workflows on a branch with the repo's secrets, so contributors use
  forks and have no collaborator access. Fork pull requests get no secrets.
- `main` carries a ruleset: no force-push, no deletion, admin bypass. Requiring
  pull requests is not possible: the role-sync workflow pushes directly to `main`
  and the Actions bot cannot be a bypass actor on a personal repo.
- A new `pull_request` workflow runs the tests and a build, so a first-time
  contributor sees a result without installing anything.
- An onboarding doc covers forking, `bun install`, the fixture dev loop, the branch
  naming, how to open a pull request into `feat/deathwatch`, and the name rule.

## Testing

- Pure logic (scoring, standings, podium) is ported with tests written from the
  archive's behavior and joins the 100% coverage and mutation gate.
- Components use Vue Test Utils; the gate and the banner are tested against the
  fixture states; a test asserts no `v-html`.
- Server: unit tests with a fake Discord, like `archiveKey.test.js`, covering each
  access combination, fail-closed behavior, limits, grants and audit rows.
- End to end (Playwright on the deployment server only): the gate states, the banner
  flow, a Watch Commander write, a grant and its revocation.
- Mutation runs use `node_modules/.bin/stryker run`, not `npx stryker`. Tests and
  the pre-commit hook need `NODE_OPTIONS=--no-experimental-webstorage` on Node v26.

## Chunks

| # | Chunk | Depends on | Target |
| --- | --- | --- | --- |
| 0 | Mobile baseline, site-wide | none | `main` |
| 1 | Contributor setup: `feat/deathwatch`, PR workflow, onboarding doc, PRODUCT.md and DESIGN.md | none | `main` |
| 2 | Shell and gate on fixtures: routes, theme, banner, hub, bottom sheet, sparks | 0, 1 | `feat/deathwatch` |
| 3 | Backend: schema, access, endpoints, tests, deploy | role ids | `feat/deathwatch` |
| 4 | Event Tracker, read-only | 2 | `feat/deathwatch` |
| 5 | Manage: documents and grants | 3, 4 | `feat/deathwatch` |
| 6 | Armouring Hall and Chronicles of Valor | 2 | `feat/deathwatch` |
| 7 | Image pipeline | 2, images from Bret | `feat/deathwatch` |
| 8 | The Watch Commander's first PR (live-site delta), then cutover | all | `feat/deathwatch`, then `main` |

Chunks 0 and 1 first; 2 and 3 in parallel (disjoint files, shared contract is the
endpoint shapes); 4 then 5, with 6 and 7 alongside.

## Open items (dependencies, not undecided design)

- Role ids for Deathwatch and Watch Commander: supplied by Bret before chunk 3 deploys.
- The Watch Commander's banners and other images: supplied by Bret before chunk 7.
- What happens to `watchfortress-ebonhold.com` after cutover (redirect or retire):
  decided before chunk 8.
- Whether the blackletter and Barlow/Teko faces are needed: decided during the port.
- Verify in chunk 2 that a Discord user outside the Legion list still ends sign-in
  as signed in (the gate must not depend on `isMember`).

## Cleanup (end of the work)

Delete the local scratch extract of the old site's export (it holds its real
configuration file) and remove the untracked `dist.7z` from the repo root.
