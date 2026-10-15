# Companies and Roster merge — design

Status: shipped. 2026-10-15. PR 1 (the server endpoint, #5) and PR 2 (the page, #10) are merged and live. History points
(rollback tags, what the reviews caught, open items): docs/handoff/2026-10-15-companies-roster-merge.md.

Fold the members-only `/roster` page into the public `/companies` page. Each
company gets a collapsed **Ranks** bar under its header. Signed-out visitors see
who leads each company and how big it is; signed-in Legion members see the full
ladder. This amends the Access section of
`docs/superpowers/specs/2026-10-13-roster-design.md`, which said the roster is
served only to signed-in Legion members: that stays true for the full roster;
a new, much smaller public projection is added beside it.

This repo is public. Like the roster spec, this one holds no member names, ids or
real roster data. Tests and the dev fixture use synthetic members only.

## Intent and success criteria

What Bret asked for, in his words: the roster should be "public"; it is mostly for
display, an easier layout for Captains to see who is in which company, RP and fun,
and a recruiting tool for both members and recruits. Collapsed ranks next to each
company, "folks are really only going to be looking at their own company", and jump
links at the top.

Success looks like:

1. A recruit opens `/companies` with no sign-in. The story reads exactly as today.
   Under each company header is a collapsed Ranks bar naming the head (Captain,
   Master of the Forge, and so on) and the headcount. Opening it shows how many
   hold each rank, with no names below the head.
2. A signed-in Legion member sees the same bars, but they open to the full ladder
   (names and avatars), plus Find me, Expand all, the Infirmary button (command
   only), and a Muster section at the foot (Unassigned, Servitors).
3. No Discord id, avatar URL, role id or non-leader name appears in anything the
   public endpoint returns. A test enforces it.
4. Old links work: `/roster` and `/roster#company-3` land on the right company.
   The Roster nav item is gone.
5. Everything loads collapsed, so page length barely changes. The story paints
   first; roster code loads after.

## Decisions (all confirmed with Bret in conversation)

| # | Decision |
|---|---|
| 1 | Ranks bar sits under each company header, above the story, full width of the article, collapsed by default. |
| 2 | Signed out: head by name plus per-rank headcounts. Signed in as Legion: the full ladder. |
| 3 | New unauthenticated `GET /roster/public` returns an allowlisted projection. No ids, avatars or role ids. |
| 4 | High Command is the first entry, above the chip row, fully public (all leadership), with its own chip. No story text. |
| 5 | Venerable Dreadnoughts gets a full Companies entry with a short neutral placeholder story that Bret rewrites. |
| 6 | Unassigned and Servitors live in a members-only **Muster** section at the foot. |
| 7 | The top toolbar (members) holds Find me, Expand all, Infirmary and the status line, beside the jump chips. |
| 8 | Infirmary swaps the page for its list, as it does today. Command only. |
| 9 | Jump links: the existing chip row, extended; a small "↑ Index" link on each company. Not sticky. |
| 10 | Search stays company text only. |
| 11 | Leaders are named publicly with no opt-out (already named in-game and in the Notable Members cards). |
| 12 | Styling is scoped CSS on the existing `@theme` tokens. No Tailwind utility rewrite. |
| 13 | `/roster` redirects to `/companies`, deep links are mapped, the Roster nav item is removed. |
| 14 | Two PRs: the server endpoint first (deployed and checked on Vulkan), then the page merge. |

Assumptions Bret confirmed: the public view fetches once and never polls (members
still poll every minute); a failed public fetch hides the bars and leaves the story
page working; public head chips show initials, not avatars; a signed-in user who
lacks the Legion role gets the public view; High Command has no story text.

## Out of scope

- Searching for brothers by name (a later spec).
- Public avatars, public rank-and-file names, an opt-out list.
- A sticky chip bar or a members' side panel.
- Writing the Venerable Dreadnoughts lore (placeholder only).
- Restyling roster components to Tailwind utilities.
- The sky-dragons work (separate branch; its uncommitted files are untouched).

## Page, top to bottom

```
PageHeader   eyebrow The Chapter · Companies & Sections · lede · search
[members]    status line · [Find me] [Expand all] ...... [Infirmary*]
HIGH COMMAND panel (banner: hero + court)
chip row     HC · 1st ... 7th · Dreadnoughts · Apothecarion · Librarius · Armoury · Reclusiam · [Muster]
for each company:
  header     sigil · title · subtitle           ↑ Index
  RANKS bar  ▸ Ranks · head chips · count · chevron
  story      existing blocks (prose, lists, Notable Members cards)
[members]    MUSTER: Unassigned, Servitors
```

`*` the Infirmary button shows only for command-tier members.

### The Ranks bar (shared chrome, two bodies)

One bar, one open/close behaviour, two bodies. It reuses the existing `RosterBranch`
bar with an `embedded` variant: no sigil or title column (the article header
already has them), a "Ranks" label, then the head chips, the count and the chevron.
The body is a slot:

- **Member body:** the existing `RosterLadder`, unchanged.
- **Public body:** a short list, one row per rank in ladder order: rank label and
  count (`Sergeants ×6`), with the same heat markers as the ladder, plus a closing
  line "Legion member? Sign in with Discord to see everyone" with a sign-in button.

Head chips use the existing `RosterMember`. It already copes with a member that has
only a name: initials show when there is no avatar, and the "you" match never fires
without an id. Public mode passes `{ name, acting? }` plus a client-made local key.
The collapsed bar still shows two head chips and "+n"; the rest go in the opened body
(public: the head row of the shape list).

Bars are CSS-collapsed, never `v-if`'d, and `inert` while shut (existing behaviour),
so text stays findable and keyboard focus stays out.

### High Command

The existing `RosterBanner` (hero plus court), driven from `highCommand` in either
mode. In public mode every holder is named, because it is all leadership. It sits
before the chip row, carries `id="high-command"` and `data-jump="high-command"`,
and has its own chip ("HC"). It matches search through a constant entry
(`high command`, `lord`, `chapter master`, `pyre guard`, `chaplain`).

### Venerable Dreadnoughts

A normal `companies.json` entry (`id: "dreadnoughts"`, sigil `VD`, branch
`venerable-dreadnoughts`) placed after the 7th, matching roster order. Its story is
two short neutral lines from 40K lore, no named members, no invented Legion
history, flagged as a placeholder in the PR so Bret can rewrite it.

### Muster (members only)

After the last company: Unassigned (`RosterBranch variant="unassigned"`) and
Servitors (the existing grey chip list). Absent for the public, with no chip and no
hint it exists. Hidden while a search is active.

### Toolbar, jump links and deep links

- The status line and buttons are the existing `RosterStatus`, shown to members
  only, directly under the header and above the chips.
- Chips are the existing buttons calling `scrollIntoView`. Plain `#` anchors are not
  used (the page's own comment says so; verify at plan time whether that still
  holds on `createWebHistory`, but buttons work either way). Scrolling goes through
  `scrollBehavior()` from `src/lib/motion`, so reduced motion is honoured.
- "↑ Index" is a button styled as a link that scrolls to the chip row and moves
  focus to it.
- `/companies#<id>` (`first`, `third`, `high-command`, `muster`, …) scrolls to that
  article and opens its Ranks bar once data arrives, in both modes.
- Legacy: `/roster` redirects to `/companies`, keeping the query. A legacy hash is
  mapped through each entry's `branch` field: `company-3` → `third`, `forge` →
  `armoury`, `venerable-dreadnoughts` → `dreadnoughts`, `high-command` and
  `unassigned` → `high-command` and `muster`. An unknown hash is dropped. The OAuth
  `#access_token=` callback is scrubbed before the router runs, so it never reaches
  the redirect (`scrubCallbackHash`; sign-in returns to the page it started from).

### Modes and states

| Viewer | View | Toolbar | Muster | Polls |
|---|---|---|---|---|
| Signed out | public | no | no | no (fetch once) |
| Signed in, no Legion role (403) | public | no | no | no |
| Legion member | full | yes | yes | every minute, as today |
| Legion member, first load fails | public, plus a "live roster unavailable" note | no | no | retry as today |
| Public fetch fails | no bars; story page unaffected | no | no | no |

A static placeholder bar of the same height holds the slot while data loads, so the
page does not jump. Signing in or out switches mode without a reload. While the
Infirmary shows, the stories, High Command and Muster are hidden and the chips stay;
a chip click closes the Infirmary first, then jumps (existing `showOrder`).

### Search

Unchanged: it filters company articles and chips by title, subtitle and keywords.
High Command takes part through its constant entry. Muster hides while a query is
active. Empty results show the existing "No companies match" line.

## Server: `GET /roster/public`

New module `server/src/rosterPublic.js` (pure projection) and handler
`server/src/rosterPublicHandler.js`, wired in `index.js` next to `rosterRoutes`.
The existing handler matches only `/roster` and `/roster/infirmary`, so the new
path falls through to the new one; its "does not own" tests stay valid.

Behaviour:

- `GET` only. Any other method is not owned (404 JSON, as for unknown paths).
- No `Authorization` header is read. A token, if sent, is ignored.
- Reads `roster.current()` only. The snapshot is TTL-bounded (5 min,
  stale-while-revalidate; a failed load retries after 60 s), so anonymous traffic
  cannot cause more than one Discord sweep at a time, or more than one per TTL (per
  retry interval after a failure), however many requests arrive.
- 200 with the projection. 503 `{ error }` if no roster has ever loaded.
- `Cache-Control: public, max-age=60`. CORS through the existing `cors()` wrapper.
- The projection is computed once per refresh (memoized on the snapshot's roster
  object, which the roster module replaces on every refresh), not per request.

Response (allowlist; anything not listed is dropped):

```
{
  fetchedAt, stale,
  highCommand: [ { rank: {key, label, tier}, members: [ {name} ] } ],
  branches: [ {
    key, kind, label, number?,
    head: { rank: {key, label, tier}, vacant, members: [ {name, acting?} ] },
    aside: <count>,
    rows: [ { rank: {key, label, tier, lateral?}, count } ]
  } ]
}
```

Never included: member `id`, `avatar`, `company`, `alsoCompanies`, `nameMismatch`,
`bot`, the Unassigned list, Servitors, the Infirmary, `viewer` flags, role ids.
The branch headcount is derived client-side (head members unless vacant, plus
`aside`, plus the row counts), the same formula as `branchOf` in `rosterView.js`.

Members that `routeOf` sends elsewhere (hidden, Infirmary holders, Servitors, bots)
are already left out of the branches by `buildRoster`, so the projection inherits that.

## Client structure

Route view stays thin (composition only), per `vue-best-practices`.

| Unit | Responsibility |
|---|---|
| `views/Companies.vue` | Header, search, chips, toolbar, High Command, article list, Muster. Composes; owns no roster logic. |
| `components/company/CompanyArticle.vue` | Header (sigil, title, subtitle, ↑ Index), the ranks slot, the story blocks. The story markup and CSS move here from `Companies.vue` unchanged. |
| `components/company/CompanyRanks.vue` | The ranks slot: picks the member or public body, handles the placeholder. Loaded with `defineAsyncComponent` so the roster code and CSS stay off the first paint. |
| `components/roster/RosterBranch.vue` | Gains `variant="embedded"` and a `body` slot. Member pages keep the default slot content. |
| `components/roster/PublicShape.vue` | The public body: rank rows, counts, sign-in line. |
| `lib/useCompanyRoster.js` | Mode, status, view model, polling start/stop, mode switch on sign-in/out. |
| `lib/useRosterActions.js` | Find me, Expand all, jump, deep link, Infirmary toggle (moved out of `Roster.vue`). |
| `lib/rosterPublicView.js` | Pure: public snapshot → the same `{ banner, branches }` shape `buildRosterView` produces, with local keys and no ladder. |
| `lib/rosterApi.js` | Adds `getPublicRoster()` (`cache: 'default'`; no token). |
| `stores/rosterPublic.js` | Small store: status and snapshot for the public fetch. The member store is untouched. |
| `data/companies.json` | Each entry gains `"branch"`; one new entry for the Dreadnoughts. |
| `router.js`, `lib/useNavLinks.js` | `/roster` redirect; Roster link removed. |

`views/Roster.vue` and its test are deleted once their behaviour lives in the units
above. `RosterStatus`, `RosterBanner`, `RosterLadder`, `RosterRank`, `RosterMember`
and `RosterInfirmary` are reused as they are.

The dev fixture: `src/lib/rosterFixture.js` derives the public fixture at runtime by
calling the server projection on the synthetic roster, so `VITE_ROSTER_FIXTURE=1`
shows both modes against synthetic members. No second committed JSON file.

## Privacy and security

- The public view exists because Bret decided to open it. The line it draws:
  leadership by name, everyone else by count.
- The allowlist test builds a snapshot full of synthetic ids, avatar URLs and role
  ids, then asserts that the serialized response contains none of them and that
  every key is on the allowlist. A new field on the member object fails the test
  until someone adds it on purpose.
- The endpoint is read-only, unauthenticated, cache-backed, and never touches
  Discord itself.
- An Opus security review is part of PR 1 before it merges (memory rule: Opus for
  security and the final review).
- Names are Discord display names. Leaders accept that; no opt-out in this release.

## Testing

Server: projection unit tests (shape, allowlist, no-leak, vacant, acting,
Dreadnought `aside`, empty branch); handler tests (200, 503, method, ignores
`Authorization`, headers, memoization); the existing roster handler tests unchanged.

Client: `rosterPublicView` unit tests; `useCompanyRoster` mode switching; component
tests for `CompanyArticle`, `CompanyRanks`, `PublicShape` and the embedded
`RosterBranch`; router redirect and hash mapping tests; `useNavLinks` and footer
tests updated; `Companies.test.js` kept (the scrim contrast numbers) and extended
for the new bars. Tests run with `env -u VITE_ROSTER_FIXTURE
NODE_OPTIONS=--no-experimental-webstorage`.

E2E: `e2e/tests/roster.spec.js` re-pointed at `/companies` (Vulkan only, no local
Docker); plus a public-mode spec. Visual check in Chrome against both fixtures, on a
wide window and a phone width.

## Risks to measure at plan time

1. **Width.** Ladders were designed for the 72rem roster page; Companies is 60rem.
   Measure an opened ladder at 60rem. Fallback: widen the page container for
   articles, or adjust ladder columns.
2. **Over the volcano.** The Ranks bar spans the article like the Notable cards do,
   so it uses the `.surface` panel. Check contrast and that the mountain still reads.
3. **Page weight.** 12 bars plus ladders mounted closed. The old roster page already
   did this; confirm no regression on a phone.
4. **Old tab with a stale hash.** A bookmarked `/roster#something-unknown` lands at
   the top of `/companies`; acceptable.

## Delivery

PR 1 (`GET /roster/public`): projection, handler, wiring, tests,
Opus security review. Deploy to Vulkan and check with `curl` that the body has no
ids or avatar URLs and that `/roster` still answers 401 without a token. Nothing
user-visible changes. This spec and the plan ride along.

PR 2 (page merge): everything under "Page" and "Client structure", the redirect and
the nav change. Branch from `main` after PR 1 merges. Bret merges both himself;
nothing is pushed without his say-so.

Next step after Bret approves this spec: `writing-plans`.
