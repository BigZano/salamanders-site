# Perk Corrections & Version History — design

The wiki lags the game. Trusted forge and leadership roles correct weapon and
class perks straight from the live site; corrections go live immediately,
layered over the wiki bake, which stays the source for *new* perks. Every
change — perk corrections, build deletions, privilege revocations — is kept
forever and shown to the same roles in a "View Version History" tab. Each
change also pings the reports webhook as a second, out-of-band log.

## Roles (guild `1322056087792521269`, checked live against Discord)

| Role | Id | Edit perks | History | Delete others' builds | Revoke / reinstate |
|---|---|---|---|---|---|
| Administrator | permission bit (or guild owner) | ✓ | ✓ | ✓ | everyone below |
| Master of the Forge | `1322056087867883565` | ✓ | ✓ | ✓ | Mechadendrite Expert, Techmarine |
| Legion Hierarchy | `1322056087880597522` | ✓ | ✓ | — | — |
| Mechadendrite Expert | `1362522277677240521` | ✓ | ✓ | ✓ | — |
| Techmarine | `1322056087859499042` | ✓ | ✓ | ✓ | — |

- Master of the Forge and Legion Hierarchy are on even footing: neither can
  revoke the other. Only an Administrator can revoke either.
- Techmarine joins the existing build-moderator set (Forge, Mechadendrite,
  Admin); Legion Hierarchy does not.
- A **revocation** removes every elevated power above (edit, history, build
  moderation). The person remains a normal member: browse, post and delete
  their own builds, file reports.
- Whoever may revoke someone may also reinstate them.
- Role ids overridable by env, as with reports.

## Data (Postgres; nothing is ever purged)

Postgres stays: the same server already runs it, and every change must write
its history row in the same transaction. Free-form before-states go in `jsonb`.

`perk_corrections` — current state:
`id`, `kind` (`weapon|class`), `target` (weapon or class name), `quality`
(weapon only; `Standard|Master-Crafted|Artificer|Relic|Heroic`), `op`
(`add|remove|edit`; class perks: `edit` only — the 24-perk grid is fixed),
`perk_name` (≤ 80), `description` (≤ 500, null for `remove`), `note`,
`active` (bool), `author_discord_id`, `author_username`, `created_at`,
`updated_at`. Revert sets `active = false`; the row stays.

`edit_events` — the shared history:
`id`, `subject` (`perk_correction|build|privilege`), `subject_id`, `action`
(`created|edited|reverted|deleted|revoked|reinstated`), `actor_discord_id`,
`actor_username`, `snapshot` (jsonb: full before-state; for builds the whole
build), `note`, `created_at`. One row per change, same transaction.

`builds` gains `deleted_at`, `deleted_by`. Delete becomes a soft delete; lists
hide deleted builds. Builds deleted before this ships are already gone.

`privilege_revocations`: `id`, `discord_id`, `username`, `revoked_by`,
`reason` (required), `created_at`, `lifted_by`, `lifted_at`. Revoked ⇔ an
open (unlifted) row exists.

**Backfill:** a seed migration loads `src/data/weapon-perk-overrides.json`
(the 2026-09-27 member error report) as corrections authored by
`system (error report 2026-09-27)`, each with a `created` event.

## Applying corrections

Resolution order for any perk list: wiki bake → active corrections, applied in
`created_at` order. For a weapon tier: `remove` drops one perk of that name,
`add` appends, `edit` replaces the description of one perk of that name. For a
class: `edit` replaces the perk's description (grid keyed by class + name).

The bundled `weapon-perk-overrides.json` becomes a build-time snapshot of the
API document and is the offline fallback when the API is unreachable.

## API (`server/src/perks.js`, `server/src/privileges.js`; deps injected, unit-tested)

| Route | Who | Does |
|---|---|---|
| `GET /perk-corrections` | public | `{version, weapons:{name:{quality:[…]}}, classes:{name:[…]}}`, `Cache-Control: max-age=30` |
| `GET /privileges/me` | signed in | `{id, editor, historyViewer, moderator, revoked, revoker}` — `id` is the caller's Discord id; `revoker` is `'admin'`, `'forge'` or `null` |
| `POST /perk-corrections` | editor | one add/remove/edit; returns new document |
| `POST /perk-corrections/:id/revert` | editor | deactivate + event; returns new document |
| `GET /history?subject=&q=&before=` | history viewer | paged events with snapshots, newest first |
| `POST /privileges/:discordId/revoke` | Forge (tier-1 targets) / Admin (any below) | reason required |
| `POST /privileges/:discordId/reinstate` | same as revoke | lifts the open revocation |
| `DELETE /builds/:id` | poster, or moderator not revoked | soft delete + `deleted` event |
| `GET /builds/moderator` | signed in | now also false when revoked |

Validation: `remove`/`edit` must name a perk present in that tier after
current corrections (404 otherwise), so typos can't create ghost removals.
Names/descriptions are trimmed plain text, rendered as text (no `v-html`).
Admins cannot be revoked; nobody can revoke themselves.

Errors follow reports: 401 no/invalid token, 403 wrong role or revoked, 400
bad body, 404 unknown target/perk, 409 revoke when already revoked /
reinstate when not, 503 Discord unreachable or config missing (fail closed).

**Webhook** (`REPORTS_WEBHOOK_URL`, fire-and-forget after commit): perk data
isn't sensitive, so content is included, e.g.
`Perk correction by <user>: Occulus Bolt Carbine / Relic — removed Tyranid Eliminator ("<note>") · <site>/history`
and `<admin> revoked site privileges for <user>: <reason>`. Build deletions by
a moderator on someone else's build also ping.

## UI (Vue)

- `src/lib/perkCorrections.js` fetches `GET /perk-corrections` on app start,
  falls back to the bundled snapshot; `applyPerkOverrides` generalises to
  weapons and classes and every perk view (Armoury, Perk Builder, planner)
  reads through it.
- **"Corrected" tag** on corrected perks for everyone; tooltip gives the
  source and date. Editor name only for history viewers.
- **Editing** (editors), inside the existing detail panels: weapon perk →
  *Edit text*, *Remove from this tier*; tier header → *+ Add perk* with
  autocomplete from known perk names (prefills their usual text); class perk
  → *Edit text*. Optional one-line note per save. Optimistic: the page
  updates at once, the API call follows, failure rolls back with the error.
- **`/history` — "View Version History"** (nav item, history viewers):
  filters Perks · Builds · Privileges and a weapon/class search; each entry
  shows who, when, what, and before/after; deleted builds render read-only.
  Perk entries have *Revert*. **Privileges panel** (Forge/Admin): open
  revocations with *Reinstate*; *Revoke* on any actor's name in the history,
  reason required.

Out of scope: restoring deleted builds, bulk editing, editing the wiki.

## Testing

Unit (server, injected fetch/db): role × route matrix incl. revoked editors
and the Forge/Hierarchy/Admin revoke rules; correction validation (ghost
removal → 404, lengths); every write emits exactly one event in the same
transaction; soft delete hides builds from lists; webhook payloads; seed
migration idempotent. Unit (client): apply order for weapon/class
corrections; fallback when the fetch fails; optimistic rollback. E2E: mock
Discord gains Techmarine and Forge tokens — Techmarine corrects a perk, a
member sees it on reload, history shows it, Forge revokes the Techmarine,
whose edit controls disappear.

## Amendment (2026-09-27): input sanitization

Every user-supplied text field is sanitized and normalized before validation
and storage, by one shared function (`sanitizeText` in
`server/src/perkCorrectionsCore.js`, also used by the site before optimistic
updates so the editor sees exactly what the server stores):

1. Non-strings become `''`.
2. Unicode NFC normalization.
3. Remove C0/C1 control characters (keep `\n` only for multi-line fields),
   zero-width characters (U+200B–U+200D, U+2060, U+FEFF), soft hyphen
   (U+00AD) and bidirectional controls (U+202A–U+202E, U+2066–U+2069).
4. Collapse runs of horizontal whitespace (incl. NBSP) to one space; in
   multi-line fields collapse 3+ newlines to 2; in single-line fields turn
   newlines into spaces. Trim.
5. Length limits apply after sanitizing; over-limit input is rejected (400),
   never silently truncated.

Perk names additionally may contain only letters, numbers, spaces and
`' ’ - ( ) . , & : + % /`. Sanitizing applies to: correction fields (target,
perkName, description, note), revert notes, revoke reasons, the revoked
username, the history search `q`, and build title/role/notes.

Webhook content has Discord markdown escaped (a backslash before each of
`\`, `*`, `_`, `~`, backtick, `|`, `>`, `#`, `[`, `]`, `(`, `)`) in addition
to `allowed_mentions: { parse: [] }`,
so user text can't render as links, headings or formatting. The site renders
user text only via text interpolation (never `v-html`).
