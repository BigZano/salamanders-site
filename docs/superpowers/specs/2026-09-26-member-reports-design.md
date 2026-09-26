# Member Reports — design

Members of the XVIIIth Legion file incident reports on the site. Reclusiarchs
review them and either handle them or escalate to High Command through the
official "Chaplain & Officer Incident Report" Google Form
(`https://forms.gle/jnwNXYd7HyAzJmrg6`). Admins see everything but do not act.

Phase A (this spec): the site's builds server (`server/`) owns reports.
Phase C (later): port to Armory Bot, which gains a `/report` flow; the schema
here stays close to Armory's conventions (snowflakes, audit rows) so the move is
a migration, not a redesign.

## Roles (guild `1322056087792521269`, checked live against Discord)

| Who | How | May |
|---|---|---|
| Reporter | holds `1377787723976409211` (XVIIILegion) | file, list own (status only) |
| Reclusiarch | holds `1323334632904855592` | list/read all, claim, resolve, escalate |
| Admin | Administrator permission, or guild owner | list/read all, reopen |

Live guild-member lookup with the bot token on every request, never the 8-hourly
`discord-members.json` bake. Role ids overridable by env
(`REPORTER_ROLE_ID`, `RECLUSIARCH_ROLE_ID`).

## Data (permanent — nothing is ever purged)

`reports`: `id`, `reporter_discord_id`, `reporter_username`, `incident_date`
(date, null), `reported_member`, `witnesses`, `medium`
(`text|voice|dm|other`), `medium_other`, `description` (≤ 4000), `status`
(`received|under_review|resolved|escalated`), `handler_discord_id`,
`handler_username`, `resolution_note`, `created_at`, `updated_at`,
`closed_at`. Plain `text`; Postgres TOAST compresses large values.

`report_events`: `id`, `report_id`, `actor_discord_id`, `actor_username`,
`action` (`filed|claimed|resolved|escalated|reopened`), `note`, `created_at`.
Every state change writes one row in the same transaction.

## Lifecycle

```
received --claim--> under_review --resolve(note)--> resolved
                         '--escalate(note?)-------> escalated
resolved|escalated --reopen(reason, admin)--> under_review
```

Claim is allowed from `received` only; resolve/escalate only from
`under_review`, by any Reclusiarch. Escalate is two-step in the UI: open the
pre-filled form, then confirm "I submitted it" (a Google Form submit can't be
observed). Reopen is an admin failsafe, reason required.

## API (`server/src/reports.js`, deps injected, unit-tested)

| Route | Who | Returns |
|---|---|---|
| `POST /reports` | Reporter | 201 `{id}` |
| `GET /reports/mine` | Reporter | `[{id, reportedMember, status, createdAt, updatedAt}]` |
| `GET /reports/access` | signed in | `{reporter, reviewer, admin}` |
| `GET /reports` | Reclusiarch/Admin | full reports, newest first |
| `GET /reports/:id` | Reclusiarch/Admin | report + events |
| `POST /reports/:id/{claim,resolve,escalate}` | Reclusiarch | updated report |
| `POST /reports/:id/reopen` | Admin | updated report |

No token/invalid → 401; wrong role → 403; bad transition → 409; bad body →
400; Discord unreachable/config missing → 503. After a successful file, a
fire-and-forget webhook (`REPORTS_WEBHOOK_URL`, server env only) posts
"New report #id — review: <site>/reports/review" with no report content.

Role logic (member lookup + Administrator bit) moves to
`server/src/discordRoles.js`, shared with builds delete.

## UI (Vue, behind Discord sign-in)

- `/reports` — form + "My reports" status list. Status labels: Received,
  Under review, Resolved, Escalated to High Command. Checkbox "This involves a
  Reclusiarch" replaces submit with a link to the official form pre-filled from
  the typed fields; nothing is stored by us.
- `/reports/review` — Reclusiarch/Admin queue (filters: Open, Mine, All),
  detail with event history, role-appropriate actions.
- `src/lib/reportPrefill.js` — builds the pre-filled official form URL:

| Official entry | Source |
|---|---|
| `entry.1585179301` name | filer (Reclusiarch, or member on bypass) |
| `entry.1660417014` date | `incident_date` (`YYYY-MM-DD`) |
| `entry.1659452298` reported member | `reported_member` |
| `entry.2116649071` others present | `witnesses` |
| `entry.829462579` medium | Discord Text Channel / Voice Channel / Direct Message, or `__other_option__` + `entry.829462579.other_option_response` |
| `entry.1492368838` follow-up | Reclusiarch choice at escalation (Yes/No) |
| `entry.1441063800` description | description (+ "Reported by …" + Reclusiarch note) |

## Testing

Unit: handler role matrix, transitions, validation, event rows, webhook
(injected fetch/db); prefill URL; client API. E2E: mock Discord gains a
Reclusiarch token and guild endpoint; member files → reviewer sees and claims.
