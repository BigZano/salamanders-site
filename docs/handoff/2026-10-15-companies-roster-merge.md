# Handoff: Companies and Roster merge — shipped (2026-10-15)

The members-only Roster page was folded into the public Companies page. This
document is the record of what shipped, where its history points are, how to
roll it back, and what is still open. The repo is public, so it holds no
secrets and no member names.

## What shipped

- **PR #5** (merge `54925d8`, branch `feat/companies-roster-merge`, tip `78efa28`):
  `GET /roster/public`, an unauthenticated, cache-backed endpoint. It serves
  leaders by name (High Command and each branch's head) and every other rank as
  a count: no Discord ids, avatars, role ids, Unassigned, Servitors or
  Infirmary. Spec section "Server".
- **PR #10** (merge `df10685`, branch `feat/companies-roster-page`, tip `1373b42`):
  every company gets a collapsed Ranks bar under its header. A visitor who is
  not signed in sees the head and the counts; a signed-in Legion member sees the
  full ladder, plus a toolbar (status line, Find me, Expand all, the
  command-only Infirmary) and a Muster section (Unassigned, Servitors) at the
  foot. High Command is the first entry. `/roster` redirects to `/companies`
  (old `#company-3` links are mapped) and the Roster nav link is gone.
- **The follow-up PR** (branch `fix/auth-token-and-hc-placeholder`): the auth store's
  `token` getter, and the High Command placeholder and deep-link scroll.

Design: `docs/superpowers/specs/2026-10-14-companies-roster-merge-design.md`.
Plan: `docs/superpowers/plans/2026-10-14-companies-roster-merge.md`.

## History points

Annotated tags in the repo's usual `rollback/` shape. The two merged branches'
commits are also all reachable from `main` through their merge commits (the
branch tips are the second parent of each merge), so deleting the branches
loses nothing.

| Tag | Commit | What it is |
| --- | --- | --- |
| `rollback/2026-10-15-pre-roster-endpoint` | `f47dfa1` | main before the public endpoint |
| `rollback/2026-10-15-roster-endpoint` | `54925d8` | main with the endpoint; also main before the Companies merge |
| `rollback/2026-10-15-companies-roster` | `df10685` | main with the Companies and Roster merge |

## Rolling back

The endpoint is additive: nothing in the database, no new environment
variables. To undo the page, redeploy the site from `rollback/2026-10-15-roster-endpoint`
(the separate Roster page and its nav link come back); the API can stay. To
undo the endpoint as well, rebuild the API from `rollback/2026-10-15-pre-roster-endpoint`
(`docker compose up -d --build api`). If the API alone is rolled back, the
Companies page keeps working but loses its public Ranks bars (the stories,
chips and member tools are unaffected), because a failed public fetch hides the
bars and nothing else.

## Decisions

- Ranks bar under each company header, collapsed; public = head by name plus
  counts, Legion sign-in = full ladder.
- Leaders are named publicly with no opt-out (they are already named in the
  client and in the Notable Members cards). Everyone who holds the Venerable
  Dreadnought role is the head of that branch, so all of them are named.
- High Command first, above the chips. Muster and the toolbar are members only.
  The Infirmary still swaps the page for its list (command only).
- Search stays company text only. No sticky chip bar.
- Scoped CSS on the existing `@theme` tokens; no Tailwind utility rewrite.
- Two PRs: the server first, then the page.

## What the reviews caught

An Opus review of the whole branch, a mutation run, and checks in a real
browser found things the unit tests had passed over. Worth knowing next time:

- **A cached store getter outlived the sign-in.** `stores/auth.js` read the
  storage inside a getter with nothing reactive in it, so it cached its first
  value; after `signOut()` it still handed back the old token and a page that
  re-asked came back signed in. Every test had mocked the store as a plain
  object, so none could see it. Fixed in the follow-up PR: the getter depends on
  `member`. Test over the real store: `src/stores/auth.test.js`,
  `src/lib/useCompanyRoster.auth.test.js`.
- **Waiting on `requestAnimationFrame` stalls in a hidden tab.** Deep links to
  `#muster` and `#high-command` waited on frames and never scrolled in an
  automation tab (or a background one). Wait on timers.
- **Placeholders sized from synthetic data under-reserved on live data.** The
  fixture's High Command panel is 229px, the live one 309-316px, so the page
  jumped 80px and a deep link landed off target. Measure the live site, and
  make the deep link's last scroll wait for the placeholders to go
  (`src/lib/useRosterActions.js`).
- **A dev-only dynamic import broke the mutation gate.** The fixture loader
  imports the server's projection on demand; a test that first runs it inside a
  test makes Stryker count module-level code as covered by tests that do not
  test it (52 survivors). Import it statically at the top of such tests
  (`src/stores/roster.test.js`).
- The router scrolled `/companies#…` back to the top after the page's own
  scroll; `scrollBehavior` now leaves that to the page.

## Open items

- Issues #6 (headcount and a vacant mark on the company chips), #7 (highlight
  the signed-in member's own company), #8 (Ctrl+F finds names inside closed
  Ranks bars with `hidden="until-found"`), #9 (a floating back-to-index button on
  phones).
- The Venerable Dreadnoughts story (`src/data/companies.json`, id `dreadnoughts`)
  is placeholder text and should be rewritten.
- Deferred minors from the final review: the embedded bar's "Ranks" heading is an
  h3 beside other h3s; Find me and the vacant-post link do nothing, silently,
  while a search hides their target; the "live roster unavailable" note
  disappears and returns on every retry and, being `role="status"`, is
  re-announced to screen readers.

## Running it locally

`VITE_ROSTER_FIXTURE=1 bun run dev` serves a synthetic roster (invented names).
The member view is the default at `/companies`; `?scene=signin` is the public
view, and `denied`, `stale`, `empty`, `loading` and `error` are the other
states. To act signed in under the fixture, store a fake member in
`localStorage` under `salamanders-discord-member` (`id`, `username`,
`isMember: true`, `checkedAt`, `accessToken`, `expiresAt`). The e2e specs
(`e2e/tests/roster.spec.js`, `companies-public.spec.js`, `roster-public.spec.js`)
run on Vulkan only: there is no local Docker. Mutation testing: run
`node_modules/.bin/stryker run`, not `npx stryker` (which fetches an unrelated
package).
