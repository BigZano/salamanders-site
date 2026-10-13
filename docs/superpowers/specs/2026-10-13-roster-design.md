# Roster (ORBAT) — design

Status: approved; implemented on branch feat/roster. 2026-10-13.

An internal page showing the XVIIIth Legion as an order of battle: High
Command across the top, a row of branch heads (company Captains, Venerable
Dreadnoughts, Master of the Forge, Chief Librarian, Chief Apothecary,
Reclusiarch), and under each head a vertical rank waterfall of that branch's
members. A second, stricter area lists members holding the Infirmary role, for
command only.

This repo is public. The roster is member data, so it lives only in server
memory and is served only to signed-in Legion members. The repo holds code, a
synthetic fixture and role ids (already public in `privileges.js` and
`index.js`), never real member names.

## Scope

In:
- `GET /roster` — the order of battle, Legion members only.
- `GET /roster/infirmary` — Infirmary role holders, command only.
- Client: API module, store, `/roster` route, nav entry, synthetic dev fixture.
- Handoff doc for the frontend design pass on the Windows machine.

Out (decided):
- Deathwatch and Watch Commander — their own themed page, later.
- Chapter Champion and Chapter Ancient — no holders; added when appointed.
- Master of the Fleet / Arsenal / Marches / Relics / Recruits / Firedrakes —
  held by Captains, so the Captain rule already places them.
- Vacation role — unused (0 holders); the Infirmary is the leave marker.
- Rank or title prefixes in display names — members write these themselves.
- All visual design (done on Windows against the fixture).

## Data source

A new module, `server/src/roster.js`, with its own cache and refresh timer (the routes live in `rosterHandler.js`, the pure core in `rosterCore.js`, the helpers in `rosterMember.js`, the role table in `rosterLadder.js`).
It shares nothing with `displayNames.js` (names only) or the 8-hourly
`discord-members.json` bake (member ids only, committed). It pages the guild
member list with the existing bot token (GUILD_MEMBERS intent, already in use):
3 requests of 1000 per refresh at current size.

- Refresh every `ROSTER_TTL_MS` (default 5 min). One in-flight refresh at a
  time. Stale-while-revalidate: callers get the last good roster while a
  refresh runs; only the very first load is awaited.
- A failed or partial refresh (any non-200 page, more than `maxPages`) keeps
  the last good roster and retries after 60 s. It never replaces the roster
  with a partial one.
- `stale: true` when the roster is older than 2 × TTL. If no roster has ever
  loaded, endpoints return 503.
- Leavers: a member absent from the guild listing is absent from the next
  roster. Nothing is persisted, so there is nothing to remove.
- Nothing is written to the database, the repo or logs.

Sign-in verification reuses `createDiscordRoles` (`identify`, `rolesOf`) and
`nameOf` from `displayNames.js`.

## Access

- `GET /roster`: Discord Bearer token → `identify` → `rolesOf`. The caller must
  hold the XVIIIth Legion role (`1377787723976409211`). 401 without or with an
  invalid token, 403 without the role (including not in the guild), 503 when
  Discord is unreachable or no roster is loaded. Fails closed. `Cache-Control:
  no-store`. Role checks are live, not from a bake.
- `GET /roster/infirmary`: the above, plus a command-tier role: any High
  Command role, Captain, Master of the Forge, Chief Librarian, Chief
  Apothecary, Reclusiarch Chaplain, Legion Hierarchy, or any Company Command
  role (including the 5th and 6th "alt" roles). 403 otherwise.
- `/roster` includes `viewer.infirmary: boolean` so the page knows whether to
  offer the Infirmary tab. The server re-checks on `/roster/infirmary`; the
  flag controls only what the UI offers.
- Members without the Legion role are never on the main roster, whatever other roles
  they hold (the Infirmary list is separate). Known data issue: some Battle-Brother holders lack the Legion
  role. They are excluded by this rule until the role is granted.

## Placement

A member's placement is the first rule that matches. Roles decide everything,
and company is always taken from company roles, never from the display name.
The single exception is servitor detection, which also reads the name.

1. Pulled out before any placement, in this order, and never reaching rules
   2–10:
   - The Voice of Vulkan account (the single holder of role
     `1456339345102602425`, the admins' shared account) is never listed,
     anywhere.
   - Bot accounts and holders of the Servo-Skulls role
     (`1322056087880597521`) go to the `servitors` group (below).
   - Anyone holding The Infirmary role (`1362059023481831517`) goes to the
     Infirmary list only, whatever other roles they hold, the Legion role
     included. They never appear in the main roster.
   - No Legion role → not on the main roster.
   - An account whose display name matches the servitor pattern goes to the
     servitors, but only if it holds none of the roles rules 2–9 place by;
     otherwise it is placed by those roles like anyone else.
2. **High Command** (top banner, in this order): Lord of Drakes, Lord
   Protector of the 7 Realms, Pyre Guard, Chapter Master, Master of Sanctity
   (labelled "Lord Chaplain"). A High Command member who also holds the
   Captain role and a company (a company role, or one a rank variant implies;
   see Rank variants; the lowest-numbered company wins, as in rule 4) also heads that company: they stay in the banner and are added to
   the company's head row as a normal, unlabelled member. A High Command
   Captain with no company is in the banner only. High Command still
   wins over the Venerable Dreadnought rule; the company head row is the
   extra copy.
3. **Master of the Forge**, **Chief Librarian**, **Chief Apothecary** → head of
   the Forge, Librarius, Apothecarion branch.
4. **Captain** → head of the branch for the company they hold. A member who is
   both Captain and Venerable Dreadnought is shown here, with their company.
5. **Venerable Dreadnought** → the Venerable Dreadnoughts branch. These are
   retired Captains or Masters of the Forge, peers of the Captains. They are
   all heads of that branch and have no waterfall. Company tag shown.
6. **Dreadnought**, **Reclusiam Dreadnought**, **Chiron Pattern Saturnine
   Dreadnought** → the `aside` slot of their company branch, drawn between the
   Captain and the Lieutenants, off to the side. They hold no formal post, they
   are honorary, advisory, and revered positions.
7. **Reclusiarch Chaplain** → head of the Reclusiam branch; Company
   Chaplain (Firedrake Chaplain is a variant of it) and 
   Igniax Chaplain form its waterfall.
8. Other specialty roles → that specialty branch's waterfall, with a company
   tag from role:
   - Forge: Mechadendrite Expert, Techmarine, Tech Adept
   - Librarius: Epistolary, Codicier, Lexicanium
   - Apothecarion: Apothecary Biologis, Apothecary, Helix Adept
9. Company role → that company's waterfall.
10. Otherwise → the `unassigned` branch (Legion members with no company or
    specialty role), with the same rank waterfall.

Rules 4 and 6 need a company role. A Captain or Dreadnought without one
continues to the next rule instead of being dropped (a Captain who is also a
Venerable Dreadnought and has no company role lands in the Venerable
Dreadnoughts branch). Rule 5 does not need one; a Venerable Dreadnought
without a company role simply has no company tag.

A member who matches rule 9 or 10 but holds no ladder rank role appears in a
final "No rank role" row, so nobody vanishes silently.

**Company waterfall order** (top to bottom): Lieutenant,
Company Ancient, Company Champion, Veteran Sergeant, Sergeant, Terminator,
Company Veteran, Battle-Brother, Scout. Within a row, members sort by name 
(case-insensitive, then id), so output is deterministic.

**Rank variants.** Firedrake Sergeant, Firedrake Veteran, Firedrake Chaplain
and Scout Sergeant are variations of existing ranks within their company
(Firedrake is 1st Company, Scout is 7th). Firedrake Sergeant and Scout Sergeant
sit in the Sergeant row, Firedrake Veteran in the Company Veteran row, and
Firedrake Chaplain in the Company Chaplain row. They add no rows of their own
and count as rank roles. A holder with no company role at all takes the
variant's company (Firedrake → 1st, Scout Sergeant → 7th).

**Peers.** Roles of equal standing share a `tier` in the API, so the page can
set them side by side, best effort. The order above is the hierarchy. Peers
are Company Ancient with Company Champion, and, in the head row, Captains with
Venerable Dreadnoughts. Every other rank is its own tier. Terminator sits
above Company Veteran as a specialization of the rank and file, not a step
toward Sergeant: it is its own tier with `lateral: true`, so the page may draw
it beside the ladder instead of as a rung.

**Servitors.** The viewing accounts members run, and the guild's bots, appear
in a `servitors` group at the foot of the page, as a deliberate joke. Membership
is by bot flag, the Servo-Skulls role, or a display name containing the word
"servitor" or "servo skull" (case-insensitive, "servo-skull" too). The bot flag
and the role are explicit markers and always win, whatever other roles the
account holds (one holds all seven company roles). The name is the weakest
signal, and the one place a name decides placement: it counts only when the
account holds no High Command, head, Dreadnought, specialty, company rank or
company role. A nickname alone therefore cannot pull a ranked member off the
roster. Servitors sort by name and are excluded from the Infirmary list.

**Acting head.** A company still without a head after every placement, counting
High Command Captains (rule 2), takes as head every High Command
member, and every Captain of another company, who holds that company's Company
Command role, marked `acting: true`. Such a member also stays where they
already are: in the High Command banner, or as head of their own company. A
High Command Captain heads their company as a plain Captain, so other High
Command members holding that company's Command role are not listed as acting
heads there. When
a Captain is appointed, the Captain takes over with no change needed. A
Captain who holds the Command role of a company that has its own Captain is
simply a Captain; nothing is labelled. No role-grant timestamps are used,
since Discord does not expose them.

**Several Captains, Masters of the Forge etc.** All are heads of the branch.

**Several company roles.** The lowest-numbered company decides placement. The
rest follow in order 1–7 in `alsoCompanies`; how they are shown is a design
matter.

**Name check.** If a display name carries a company tag ("… 3rd Co.") that
differs from the member's company role, or the member has no company role, the
member gets `nameMismatch: true`. It never affects placement.

The ladder (role ids, order, heads, labels) is a constant in
`server/src/rosterLadder.js`, like `privileges.js` `ROLE_IDS`. Role ids as of
2026-10-13:

| Group | Role | Id |
|---|---|---|
| High Command | Lord of Drakes | 1322056087888859199 |
| | Lord Protector of the 7 Realms | 1322056087880597524 |
| | Pyre Guard | 1322056087880597523 |
| | Chapter Master | 1322056087867883563 |
| | Master of Sanctity (Lord Chaplain) | 1322056087867883567 |
| Heads | Master of the Forge | 1322056087867883565 |
| | Chief Librarian | 1322056087867883568 |
| | Chief Apothecary | 1322056087867883564 |
| | Venerable Dreadnought | 1354921403849244672 |
| | Legion Hierarchy (ping group, places no one) | 1322056087880597522 |
| | Captain | 1322056087867883561 |
| | Reclusiarch Chaplain | 1323334632904855592 |
| Dreadnought | Dreadnought | 1322056087859499046 |
| | Reclusiam Dreadnought | 1403430421622034547 |
| | Chiron Pattern Saturnine Dreadnought | 1498341187038482603 |
| Forge | Mechadendrite Expert | 1362522277677240521 |
| | Techmarine | 1322056087859499042 |
| | Tech Adept | 1322056087838523410 |
| Librarius | Epistolary | 1362511749382668581 |
| | Codicier | 1322056087859499049 |
| | Lexicanium | 1322056087838523408 |
| Apothecarion | Apothecary Biologis | 1362509331483857157 |
| | Apothecary | 1322056087859499043 |
| | Helix Adept | 1322056087838523409 |
| Reclusiam | Company Chaplain | 1322056087859499048 |
| | Firedrake Chaplain (variant of Company Chaplain) | 1391154164595294349 |
| | Igniax Chaplain | 1341223740897366091 |
| Company ranks | Lieutenant | 1322056087867883560 |
| | Company Ancient | 1322056087859499047 |
| | Company Champion | 1322056087850979328 |
| | Veteran Sergeant | 1322056087859499045 |
| | Sergeant | 1322056087859499044 |
| | Firedrake Sergeant (variant of Sergeant) | 1385818666871816304 |
| | Scout Sergeant (variant of Sergeant) | 1432090984233308240 |
| | Terminator | 1531689040946921522 |
| | Company Veteran | 1430744412505505845 |
| | Firedrake Veteran (variant of Company Veteran) | 1385817805219430523 |
| | Battle-Brother | 1322056087838523406 |
| | Scout | 1430743608822206504 |
| Companies | 1st Battle Company | 1322056087859499041 |
| | 2nd Battle Company | 1322056087859499040 |
| | 3rd Battle Company | 1322056087850979333 |
| | 4th Battle Company | 1322056087850979337 |
| | 5th Company | 1322056087850979331 |
| | 6th Company | 1322056087850979329 |
| | 7th Scout Company | 1322056087850979334 |
| Company Command | 1st–7th Company Command | 1323055686187356291, 1323055929981407242, 1323056001779241034, 1323056196755918981, 1323056312182902906, 1323056408379265114, 1323056498133438555 |
| | 5th and 6th Command (alt) | 1493412147294638180, 1493412321521963118 |
| Other | The Infirmary | 1362059023481831517 |

Legion Hierarchy is a ping group that gathers the heads and Captains. It
places no one, since its holders already hold a head or Captain role, but it
counts toward the Infirmary's command tier. 

## API

`GET /roster` → 200

```json
{
  "fetchedAt": "2026-10-13T12:00:00.000Z",
  "stale": false,
  "viewer": { "infirmary": true },
  "highCommand": [
    { "rank": { "key": "lord-of-drakes", "label": "Lord of Drakes", "tier": 1 }, "members": [ Member ] }
  ],
  "branches": [
    {
      "key": "company-3",
      "kind": "company",
      "label": "3rd Battle Company",
      "number": 3,
      "head": { "rank": { "key": "captain", "label": "Captain", "tier": 1 }, "members": [ Member ], "vacant": false },
      "aside": [ Member ],
      "rows": [ { "rank": { "key": "lieutenant", "label": "Lieutenant", "tier": 1 }, "members": [ Member ] } ]
    }
  ],
  "unassigned": { "rows": [ { "rank": { "key": "battle-brother", "label": "Battle-Brother", "tier": 7 }, "members": [ Member ] } ] },
  "servitors": [ Member ]
}
```

`branches` order: companies 1–7, Venerable Dreadnoughts, Forge, Librarius,
Apothecarion, Reclusiam. `kind` is `company`, `dreadnoughts` or `specialty`.
Empty rows are omitted. A head with no members has `vacant: true`; an acting
head has `acting: true` on its members. `tier` numbers a rank within its own
list, 1 first; ranks sharing a tier are peers for the page to set side by side.
A rank with `lateral: true` (Terminator) is a specialization, not a rung.

```
Member = {
  id, name,
  avatar: string | null,      // CDN url, validated hash; null → render initials
  company: number | null,     // from roles only
  alsoCompanies?: number[],
  acting?: true,
  nameMismatch?: true,
  bot?: true                  // servitors only
}
```

`name` is the server nickname, else global display name, else username, cleaned
as in `displayNames.js`.

`GET /roster/infirmary` → 200

```json
{ "fetchedAt": "…", "stale": false, "count": 2, "members": [ InfirmaryMember ] }
```

`InfirmaryMember` is `Member` plus `rank: { key, label } | null` (the member's
highest rank in the whole ladder; null when their rank roles were stripped) and
`legion: boolean` (they still hold the Legion role, which they shouldn't while
in the Infirmary, so command can see who to remind). Every holder of the
Infirmary role is listed, Legion role or not, except servitors and the Voice of
Vulkan account. Sorted by company (none last), then rank, then name.

Infirmary holders are absent from the main roster. A High Command member or
Captain in the Infirmary is therefore not in the banner or a head row, and is
not eligible as an acting head.

## Client

- `src/lib/rosterApi.js`: `getRoster(token)`, `getInfirmary(token)` via the
  shared `request` helper in `buildsApi.js`.
- `src/stores/roster.js` (Pinia): `loading | ready | signin (401) | denied (403)
  | error (503)`, the roster, the infirmary list. Reloads on a timer while the
  tab is visible, so leavers disappear without a manual refresh.
- Route `/roster` → lazy `views/Roster.vue`. Nav entry in the member-only group
  (`auth.member.isMember`), like Accolades and Ranks. The server's live check is
  the real gate; the link can lag until the next member bake.
- Dev fixture: `src/data/roster.fixture.json`, **synthetic** (invented names,
  real role structure; includes a vacant company, an acting head, a Venerable
  Dreadnought branch, aside slots, a Reclusiam branch, a long Scout waterfall,
  an Infirmary list). Loaded only when `import.meta.env.DEV &&
  import.meta.env.VITE_ROSTER_FIXTURE` is set, so it is tree-shaken from the
  production bundle.
- Handoff doc `docs/handoff/2026-10-13-roster.md` for the Windows design pass:
  contract, rules, how to run the fixture, deploy step. No secrets or names.

## Testing

Per the project's adversarial standard, driven to 100% mutation on the pure
core and the handler (both added to `stryker.config.mjs`).

- `rosterCore.js` (`buildRoster`, `buildInfirmary`, pure):
  - Properties: bots and Servo-Skulls holders appear only in `servitors`,
    whatever else they hold; a servitor-named account appears there only when it
    holds no placing role; Voice of Vulkan holders never appear anywhere;
    Infirmary holders appear only in the Infirmary list, Legion role or not;
    non-Legion never appear in the main roster; output is identical under any input
    ordering; every Legion member appears exactly once (the acting head's
    second appearance in the banner, and a High Command Captain's second appearance
    as company head, excepted); company comes from roles only;
    leavers absent.
  - Hostile inputs: unknown role ids, missing or non-array `roles`, null nick
    and global name, emoji and overlong names, duplicate ids, 2+ company roles,
    several Captains, a Captain with no company, the maximum role count,
    forged company tags in display names, and names around the servitor
    pattern (case, hyphen, substring, lookalike words).
  - Rules: each placement rule and each precedence between rules; rank
    variants merging into their base row; peer tiers.
- `roster.js` (cache) and `rosterHandler.js` (routes), with injected `fetch`: 401/403/503 fail
  closed, malformed tokens, TTL and stale flag, failed or partial refresh keeps
  the last good roster, concurrent callers share one refresh, command-tier gate.
- e2e: extend `e2e/discord-mock` with roster members and role definitions;
  cases for a Legion viewer, a non-Legion viewer, a command viewer opening the
  Infirmary, a non-command viewer refused, and a leaver dropping out after a
  short `ROSTER_TTL_MS`.

## Deploy

No new secrets: it uses the existing `DISCORD_BOT_TOKEN`, guild id and Legion
role. One step on Vulkan: `cd server && docker compose up -d --build api`.
New optional env: `ROSTER_TTL_MS` (default 300000).

## Defaults to confirm in review

- The Infirmary list shows every holder of the role, including the third or so
  who never held the Legion role (Recruits, Guests and so on), each flagged
  `legion` or not.
- The acting head also stays in the High Command banner. So does a High Command
  Captain, who appears in both the banner and their company's head row, unlabelled.
- Command-tier roles for the Infirmary are listed under Access; Administrators
  are not added separately.
- Dreadnought status outranks specialty roles (some Dreadnoughts also hold
  Codicier).
- The Venerable Dreadnoughts branch has no waterfall.
- The servitor name pattern is the word "servitor" or "servo skull". A name
  match yields to any placing role. Of the viewing accounts seen today, two hold
  a company role, so by name alone they would land in that company's "No rank
  role" row. Granting them the Servo-Skulls role, or removing the company role,
  moves them to the servitors.
- The roster refreshes every 5 minutes, so a leaver can remain up to that long.
