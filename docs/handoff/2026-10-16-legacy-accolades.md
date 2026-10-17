# Handoff: Legacy Accolades (2026-10-16)

One Legion-only page, `/accolades/legacy`, listing the retired Discord accolade roles with a short blurb
and the members who held each. The repo is public: this note holds no names, blurbs or role ids.
Design and mechanism: `docs/superpowers/specs/2026-10-16-legacy-accolades-design.md`;
the plan that built it: `docs/superpowers/plans/2026-10-16-legacy-accolades.md`.

## What exists

- The data is sealed inside the Legion Archive bundle (`index.legacy`), release `archive-v5`, pinned by
  `archive.lock.json` (`"legacy": true`). Plaintext lives only in `archive-export/legacy-accolades.json` on the
  maintainer's machine (gitignored, mode 0600). The release plus the archive key (`archive-export/.env`,
  also in the maintainer's password manager) is the backup: `bun scripts/seal-archive.mjs unseal`.
- The page is `src/views/LegacyAccolades.vue`, inside `ArchiveGate` and `ArchivePlaque`, with holders as
  `RosterMember` chips (initials badge and name; no avatars are stored). Nav entry in `src/lib/useNavLinks.js`.
- Pure logic, gated at 100% coverage and mutation: `src/lib/archive/legacy.js` (`legacyView` is the page's
  view model: `snapshotDate`, and per accolade `name`, `color`, `paragraphs`, `countLabel`, `holders`).

## Working on the front end (any machine, no secrets)

```
bun install
bun run archive:dev:fixture      # then open http://localhost:5173
```

It seals the invented fixture (three accolades: one member under two of them, an empty one, a dark role
colour, a two-paragraph blurb) under a throwaway key and serves that key locally. Sign in by faking a member
in the browser console, then visit `/accolades/legacy`:

```js
localStorage.setItem('salamanders-discord-member', JSON.stringify({ id: '1', username: 'dev',
  isMember: true, checkedAt: Date.now(), accessToken: 'dev', expiresAt: Date.now() + 864e5 }))
```

To see the real data instead (counts are larger: up to a dozen chips under one accolade), copy
`archive-export/.env` from the maintainer's Linux host, run `bun run archive fetch`, then `bun run archive:dev`.
That shows real names on that machine only; nothing from it may enter a test, fixture, screenshot in the repo, or commit.

Notes: on the Linux host `bun` is not on PATH (`PATH="$PWD/node_modules/.bin:$PATH" bun run …`). If the docker
e2e stack has run there, `e2e/.archive` and `public/archive-e2e` are root-owned and the fixture preview cannot
replace them; clear them with `docker run --rm -v "$PWD":/w alpine rm -rf /w/e2e/.archive /w/public/archive-e2e`.

## Design notes for the pass

Keep the page in the family of the other archive pages (plaque, brass rule, Oswald headings, bone/smoke/averland tokens).

- The title, eyebrow, back link and rule are copied into the page's own scoped CSS from `ArchiveThread.vue`, whose
  styles are scoped to that component. If the two should share one look, extracting those rules is the clean move.
- `ArchiveThread` cools its headings in with `brand-cool` and a per-heading stagger; the legacy page does not.
- Role colours are used only when readable on the dark inlay (`readableColor`, 3:1 for large text); otherwise the
  heading stays bone. The colours come from the Discord roles and may be grey or absent.
- A holder chip is the roster chip; its look is shared with the Companies page.
- On `/accolades/legacy` both the Accolades and Legacy Accolades nav links show as active (prefix match).

Keep these hooks: unit and e2e tests use `.leg`, `.leg-name`, `.leg-blurb`, `.leg-count`, `.leg-holders`, `.rs-name`
(`src/views/LegacyAccolades.test.js`, `e2e/tests/archive.spec.js`). Names, blurbs and role names must stay plain
text (Vue interpolation, never `v-html`).

## Still to do

Verify the live page signed in (all accolades, blurbs and chips), signed out (prompt only) and without the role
(restricted notice). Only then does the maintainer delete the Discord roles; the snapshot is already taken and sealed.
A later snapshot run refuses to start from nothing once the lock says legacy was published (restore with `unseal`,
or pass `--fresh`).
