# Legacy Accolades — retired Discord roles, etched on the site

Date: 2026-10-16
Status: draft, awaiting review

> This repo is public. This document describes mechanism only. It must never
> contain role names, blurbs, member names or Discord user ids. Those live
> exclusively in the sealed bundle (and the gitignored `archive-export/`).

## Goal

A set of old Discord accolade roles is being deleted from the guild. Their
holders must stay on record: one **Legacy Accolades** page lists every retired
accolade with a short blurb about what it was and the members who held it,
permanently. Readable only by signed-in Legion members, exactly like the
existing Accolades and Ranks archive.

## Scope

- **One page, eight accolades**: the six oldest roles marked "Move to website"
  in the role audit, plus the two lethal-variant roles. (A ninth either-or role
  was already removed in Discord.) The role list is the snapshot script's
  input, not a constant in the code, so the count is not hard-coded anywhere.
- Blurbs for the oldest six are written together with the owner, after the
  snapshot, with real role names in front of us.

Non-goals: public listing of names, avatars, a consent/opt-out flow, editing UI,
any change to the Accolades table of contents (it renders as authored), the
Promethean-accolades vote, deleting the Discord roles (the owner does that,
last).

## Hard constraints

1. **Names never reach git or the public build in plaintext.** Same bar as the
   Legion Archive: ciphertext in the release, lock in git, plaintext only in
   `archive-export/` (gitignored) and in an authorized browser session.
2. **The etch cannot be wiped by accident.** Deleting the roles in Discord
   must not be able to empty the data on a later re-run or re-seal.
3. **Reuse the archive.** Same gate, key endpoint, lock, release flow, deploy
   and leak scans. No second key, bundle or auth path.
4. Names render as plain text. No markdown, HTML or links come from the data.

## Data — `archive-export/legacy-accolades.json`

```
{
  "snapshot": "<ISO-8601 instant>",
  "accolades": [
    {
      "roleId": "<snowflake>",
      "name":   "<role name at snapshot>",
      "color":  "#rrggbb" | null,
      "blurb":  "<plain text, hand-written>",
      "holders": [ { "id": "<snowflake>", "name": "<display name at snapshot>" } ]
    }
  ]
}
```

File order is display order (the snapshot script seeds it oldest-first by role
snowflake; the owner may reorder). Gitignored already (`archive-export*/`) and
blocked from commits by `scripts/archive-leak-guard.mjs`.

## Capture — `scripts/snapshot-legacy-accolades.mjs`

Read-only against Discord. Needs `DISCORD_BOT_TOKEN` with the GUILD_MEMBERS
intent, the same prerequisites as `scripts/fetch-discord-members.mjs`.

- `--roles <id,id,...>` (the audit's role ids), `--out` (default the path above).
- Pulls `GET /guilds/{id}/roles` (name, colour int → `#rrggbb`) and the full
  member list, keeping members whose `roles` contain a requested id.
- Holder name = what the guild shows: nickname, else global display name, else
  username, cleaned and capped at 32 characters.
- **Merge, never replace.** Existing blurbs and order are kept. Holders merge
  by id (latest name wins). A holder missing from the new pull is **kept**;
  dropping anyone needs an explicit `--prune`. A role that no longer exists in
  the guild keeps its stored entry untouched and is reported, not erased.
- A role first seen by the script gets an empty blurb, which the audit rejects:
  sealing is blocked until every blurb is written. A requested role that is
  gone from the guild and has no stored entry is reported and not created.
- A member with no usable display name keeps their entry, named by their id,
  so nobody is dropped; the owner can fix the name by hand in the file.
- The `snapshot` instant moves only when at least one requested role was
  pulled live, so a later run against deleted roles cannot re-date the data.
- Output lists only ids and counts on the terminal, never names.
- Only current holders are capturable. Members who left the guild before the
  snapshot cannot be recovered.

**Reuse:** lift `discordFetch` and `fetchAllMembers` out of
`fetch-discord-members.mjs` into `scripts/lib/discord.mjs` (that script then
imports them), and import `nameOf` from `server/src/displayNames.js` for the
name policy so the site has one definition of "display name". Role/merge
logic is pure functions, tested without network.

## Seal — extend the existing pipeline

- `readExport` loads `legacy-accolades.json` **if present** into
  `index.legacy`, beside `index.collections`. `index.format` stays `1`;
  the field is additive, so an older sealed bundle without it still loads.
- `createArchive` exposes `archive.legacy` (`null` when absent).
- New pure module `src/lib/archive/legacy.js`: `auditLegacy(legacy)` and
  `legacyView(legacy)`. `auditArchive` runs `auditLegacy` when `archive.legacy`
  is set, so `seal` refuses to publish a bad file. Rules: valid snapshot
  instant; at least one accolade; role ids and holder ids are snowflakes;
  role ids unique; holder ids unique within a role; role name non-empty;
  colour `#rrggbb` or null; blurb non-empty plain text of bounded length;
  holder names non-empty, at most 32 characters, no control characters.
  A member may hold several accolades. A role with no holders is valid (the
  page says "No holders on record"). Unknown fields anywhere are rejected, so
  nothing extra (an avatar, an email) can ride into the bundle.
- **Permanence guard.** The lock gains `legacy: true` once a bundle containing
  it is published. `seal` then refuses to run without the file unless
  `--drop-legacy` is passed. The lock records only the boolean, no content.
- `unseal` writes `legacy-accolades.json` back out as canonical JSON (two-space
  indent, trailing newline). The snapshot script writes the same format, so an
  untouched file round-trips byte for byte; a hand-edited one comes back
  semantically identical. The release plus `ARCHIVE_KEY` is the backup, as for
  the rest of the archive.
- Published as the next release (`archive-v5`). Server and key endpoint are
  untouched.

## Page — `/accolades/legacy`

- Route `legacy-accolades` → `src/views/LegacyAccolades.vue`, inside
  `ArchiveGate` and `ArchivePlaque` (same plaque, same gate states, `ashOver`).
  The existing `/accolades/:threadId(\d{17,20})?` route cannot match
  `legacy`, so no ordering conflict.
- Per accolade, in file order: role name tinted with its colour (falling
  back to the bone text colour when the colour would not read on the dark
  inlay), the blurb, a holder count, and the holders alphabetically
  (case-insensitive) as chips.
- Holder chips reuse `RosterMember.vue` with `{ id, name }` and
  `image-ready=false`, which renders the initials badge and name; no new chip
  styling. (Verify in the plan that its styles are global, not scoped to the
  Companies page; if they are, fall back to a minimal local chip.)
- Header notes the snapshot date and that the roles are retired.
- If `archive.legacy` is `null` (a bundle sealed before this feature), the
  route shows the existing "isn't in the archive" plaque.
- Nav: `useNavLinks` adds a members-only "Legacy Accolades" entry beside
  Accolades. The Accolades ToC is not touched.

## Leak defence — reuse

- Commit side: `archive-export*/` is already blocked by path in
  `archive-leak-guard.mjs`; add an assertion that the new file's path is.
- Build side: `scan-dist`'s `sentinelsFrom` also collects legacy sentinels
  from `archive-export/legacy-accolades.json`: blurbs, role names, holder ids
  and holder names of at least six characters (shorter names would collide
  with minified code), minus anything already in tracked public text. The
  pre-push gate then fails if any appear in `dist/`.

## Testing (adversarial-tdd; mutation → 100% on the new pure modules)

- `legacy.js`: hostile battery for `auditLegacy` (empty, duplicate, non-
  snowflake, over-long, control characters, markup in names and blurbs, huge
  holder lists, wrong types, `__proto__` keys) and properties for
  `legacyView` (sorted, count equals length, input never mutated, order of
  accolades preserved).
- Snapshot merge logic: never loses a holder or blurb without `--prune`;
  idempotent; a vanished role keeps its entry; names update by id.
- Seal pipeline: seal → unseal round trip is byte-identical; an old index with
  no `legacy` still builds an archive; permanence guard refuses a silent
  drop; tampering with the sealed index is rejected (existing AAD).
- Page: synthetic accolades render in file order with correct counts; text
  is escaped; empty `legacy` shows the missing plaque. The archive e2e fixture
  gains a synthetic legacy payload so signed-out and non-member sessions are
  shown to receive no holder text.
- All fixtures use invented names and synthetic ids. Nothing from live
  Discord enters a test, fixture or doc.

## Order of operations (time-critical)

1. Land code and tests (no live data needed).
2. Run the snapshot while the roles **still exist** in Discord.
3. Owner reviews the file; blurbs are written together.
4. `seal --publish`, commit the new lock, deploy, verify the page signed in
   and signed out.
5. Only then does the owner delete the roles in Discord.

Rollback: redeploy from the previous lock. The page falls back to the missing
plaque; nothing else depends on the new field.

## Decisions

- Display name policy (owner, 2026-10-16): the guild-shown name at export time,
  as above. These accolades are no longer awarded, so the name is frozen.
- The role audit file (`roles_list.txt`, untracked, contained member mentions)
  is deleted; the role ids it carried were recorded outside the repo.

## Open items for the owner

- Blurbs for all eight.

## Amendment 2026-10-17: a page of the Accolades tab

The members-only "Legacy Accolades" nav entry in the Page section is replaced. The Accolades tab has two sibling
pages, Accolades and Legacy Accolades, joined by a small switcher (`AccoladesSwitch.vue`) at the top of each. It is
shown on the Accolades landing page only when the sealed bundle carries the legacy data, and always on the legacy
page. Individual accolade threads and the Ranks tab are unchanged. The route (`/accolades/legacy`), the data and
the sealed release are untouched; the Accolades table of contents is still rendered as authored.

