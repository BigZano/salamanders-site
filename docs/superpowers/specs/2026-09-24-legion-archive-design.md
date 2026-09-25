# Legion Archive — gated Discord forum exports

Date: 2026-09-24
Status: draft, awaiting review

> This repo is public. This document describes mechanism only and must never
> quote archive content (thread names, message text, link labels, dead-link
> specifics). Those live exclusively inside the sealed bundle.

## Goal

Publish two Discord forum exports, **Accolades** and **Rank Requirements**,
as pages on the site, readable only by signed-in Discord users who currently
hold the XVIIIth Legion role (`1377787723976409211`).

## Hard constraints

1. **Input exports are never mutated.** Every transformation (link rewriting,
   emoji substitution, markdown rendering) happens at render time or in a
   separate overlay file. Byte-identity of the inputs is tested.
2. **Formatting and inter-thread relations are preserved.** Content renders
   as authored, including original spelling. Every relational link resolves
   to its target *on this site*.
3. **No links to Discord.** No rendered `href` may point at `discord.com` or
   `discordapp.com`. A link either resolves to an archive page/anchor or
   renders as its authored text, unlinked.
4. **Actually enforced gating.** Plaintext never appears in git history, the
   repo, the deployed site, or any HTTP response except after decryption in
   an authorized browser session. The client-side `isMember` hint is UX only.
5. **Both collections share the same gate, pipeline, and test bar.**

## Collections and source layout

Plaintext exports move (byte-for-byte: images verified against each export's
`assets.json` sha256s, JSON files against pre-move hashes) out of `public/` and `src/` — Vite copies `public/` into `dist`
verbatim, and `src/data` is importable into the bundle — into a gitignored
directory:

```
archive-export/                 # gitignored, never committed
  accolades/
    data/        forum.json index.json links.json resolve.json assets.json threads/*.json
    assets/      emoji-*.{png,gif} att-*.{png,jpg}
  rank-requirements/
    data/  ...   (same shape)
    assets/ ...
  link-fixes.json               # overlay, see "Link resolution"
  .env                          # ARCHIVE_KEY (base64, 32 bytes) — also gitignored
```

Collection registry (committed, contains no content):

| key | route prefix | export dir |
|---|---|---|
| `accolades` | `/accolades` | `archive-export/accolades` |
| `ranks` | `/ranks` | `archive-export/rank-requirements` |

The two exports use different `links.json` schemas (`internal`/`target_thread`
vs `scope`). The site does **not** depend on either: link targets are derived
from the raw URL / mention in message content. `links.json` is used only as a
cross-check in tests.

## Sealing — `scripts/seal-archive.mjs` (run locally)

- **Cipher:** AES-256-GCM, 96-bit random nonce per file, 128-bit tag. AAD =
  `"<format-version>|<logical-path>"`, so ciphertexts cannot be swapped or
  replayed under another name.
- **Key:** 32 random bytes, `ARCHIVE_KEY` in `archive-export/.env` and in the
  server env. Key id (`kid`) = first 16 hex chars of SHA-256(key).
- **Opaque names:** each ciphertext file is named
  `HMAC-SHA256(key, logical-path)` truncated to 32 hex. Filenames leak nothing
  about content or structure.
- **Outputs:**
  - `index.bin` — sealed JSON: format version, kid, snapshot dates, and for
    each collection the full data files verbatim plus a map
    `logical asset path → opaque name`; also `link-fixes.json`.
  - one sealed file per asset (images load lazily, per page).
  - `archive.lock.json` (committed): format version, kid, release tag, and
    `{opaqueName: sha256(ciphertext)}` for every file. No content.
- **Publish:** packs ciphertexts into one tarball and uploads it as the sole
  asset of GitHub Release `archive-vN` (`gh release create`), then writes the
  lock. Also writes ciphertexts to `public/archive/` (gitignored) for local dev.
- **Pre-seal validation (refuses to seal on failure):** every input file hash
  matches its `assets.json` record; every emoji/role/user/channel mention
  resolves in its collection's `resolve.json`; every link classifies under
  "Link resolution" with zero unaccounted links.
- **`--rotate`:** new key, full re-seal, new release. Old releases remain
  decryptable only with the old key.
- **`unseal`:** recovery command — downloads the release named in the lock and
  decrypts it with `ARCHIVE_KEY` back into `archive-export/`. The release plus
  the key is the backup of the overlay; **the key must also be stored in a
  password manager.** Losing it means re-sealing from the original export.

## Deploy — `.github/workflows/deploy.yml`

Before `vite build`: `gh release download <tag from lock>` → extract into
`public/archive/` → verify every file against the lock's sha256 and that the
file set matches exactly. Any mismatch, missing, or extra file fails the build.
After build: the plaintext leak scan (see Testing) runs against `dist/`.

## Key endpoint — `GET /archive/key` on the builds API (`server/`)

Logic lives in `server/src/archiveKey.js` as a pure function with injected
`fetch`/config so it is testable under Node (no bun on the dev host).

| condition | response |
|---|---|
| missing / malformed `Authorization: Bearer` | `401` |
| Discord `/users/@me` rejects the token | `401` |
| guild member lookup 404 (not in guild) | `403` |
| member lacks `ARCHIVE_ROLE_ID` | `403` |
| Discord 5xx, network error, timeout (5 s), or non-JSON | `503` |
| config missing (`ARCHIVE_KEY`, `ARCHIVE_ROLE_ID`, bot token, guild) | `503` |
| role present | `200 {key, kid}` |

Fail closed on every uncertain path. All responses `Cache-Control: no-store`.
The key never appears in any non-200 body, header, or log line. Role is checked
live against Discord on every request (no server-side cache).

## Client

- **`archive` Pinia store:** fetches key once per page load via the existing
  implicit-grant token; holds key only in memory (never localStorage/
  sessionStorage). Verifies `kid` against the lock bundled at build → mismatch
  shows "site out of date, reload". Decrypts with WebCrypto; assets become
  blob URLs, revoked on sign-out.
- **Gate states:** signed out → Discord sign-in prompt; token expired → same;
  `403` → "Restricted to the XVIIIth Legion"; `503`/network → retryable error;
  decrypt/auth-tag failure → integrity error (never renders partial content).
- **Routes:** `/accolades`, `/accolades/:threadId`, `/ranks`, `/ranks/:threadId`.
  Landing = that collection's Table of Contents thread, rendered as authored.
  Unknown thread id → archive-scoped not-found.
- **Nav:** "Accolades" and "Ranks" entries render only for signed-in members.

## Rendering

- **Presentation:** document-style. Messages in export `position` order
  (tie-break by snowflake id); no author/timestamp chrome. Each message gets
  anchor `#<messageId>`. Thread header shows its forum tags with tag emoji.
- **Parser:** Discord-flavoured markdown → AST → Vue VNodes. No `v-html`
  anywhere. Supported: `#`/`##`/`###`, `-#` subtext, `>` quotes containing any
  block (headings, nested lists), `*`/`-` lists nested by indent, numbered
  lists, `**bold**`, `*italic*`/`_italic_`, `__underline__`, `~~strike~~`,
  `||spoiler||` (click-to-reveal), inline/fenced code, masked links, bare URLs,
  `<url>`, custom emoji `<:n:id>`/`<a:n:id>`, `<@id>`, `<@&id>`, `<#id>`.
  Unrecognised syntax (e.g. an unresolved `:shortcode:`) renders as literal
  text, exactly as Discord would.
- **Mentions:** role → pill in role colour (text, not a link); user →
  `@display_name`; channel → per "Link resolution".
- **Attachments:** images below message content, from the sealed asset map.

## Display pruning (user decision 2026-09-24)

Amends hard constraint 2 for presentation only; the exports stay untouched.
A reference is *live* when it resolves to a route or an external link;
references resolved to `text` are not.

- **Tables of contents** (each collection's landing thread): show only
  blocks that hold a live link, the headings they sit under, and list labels
  with live links beneath them. Everything else (descriptions, unlinked
  lines, attachments) is hidden; messages left empty are not rendered.
- **All other threads:** a line, list item, heading, or quote that is
  nothing but non-live references (plus emoji, punctuation, formatting) is
  hidden. Sentences that mention a non-live reference keep it as plain text.
- **Invariant:** pruning never drops, duplicates, or reorders a live link
  (property-tested; the local real-export test checks every thread).

## Link resolution

Every link — masked link, bare URL, `<url>`, and `<#channel>` mention, on
either `discord.com` or `discordapp.com` — resolves in this order:

1. **Fix overlay** (`link-fixes.json`, sealed, never committed in plaintext):
   entry keyed by `channelId[/messageId]` →
   - `{"to": "<threadId>[/<messageId>]", "why": "..."}` — redirect to an
     archive page/anchor, or
   - `{"text": true, "why": "..."}` — render authored text, unlinked.
   Every entry must carry a `why` (evidence for the mapping).
2. **Direct:** channel is a thread in any collection → `/<collection>/<thread>`;
   plus `#<messageId>` if that message exists in that thread (message id ==
   thread id means the thread's top).
3. **Otherwise:** unaccounted → the seal step refuses and tests fail.

Resulting rules:

- A direct link whose target message was deleted is unaccounted until the
  overlay maps it (to the replacement message, identified from content during
  implementation) — it never silently degrades.
- Links to channels outside both collections get an overlay entry: `to` an
  equivalent archive page where one exists, otherwise `text`.
- Two known channels outside the export are explicitly `text` by decision
  (the accolades forum is authoritative for that content).
- Fixes are discovered and added during implementation; each is listed in the
  PR description by opaque id only.

## Testing (adversarial-TDD; 100% mutation on units under test)

New dev deps: `fast-check`, `@stryker-mutator/core`,
`@stryker-mutator/vitest-runner`. Vitest `include` extends to
`server/**/*.test.js` and `scripts/**/*.test.js`.

- **Crypto (`src/lib/archiveCrypto.js`, shared by seal script and client):**
  property round-trip for arbitrary bytes and logical paths; every single-bit
  flip of nonce/ciphertext/tag rejects; wrong key, wrong AAD/path, swapped
  files, truncation, empty input, wrong format version all reject with typed
  errors; nonces never repeat across a seal run.
- **Real-export integrity (local only, skipped in CI where plaintext is
  absent):** seal → unseal reproduces every input byte-for-byte; asset hashes
  match `assets.json`; input files' mtimes and hashes unchanged after a full
  seal + test run.
- **Link resolver:** property tests over URL/mention shapes (both domains,
  with/without message, trailing slashes, angle brackets); every link in both
  exports resolves to an existing route + anchor or overlay `text`; no
  rendered `href` contains `discord`; overlay entries without `why` or
  pointing at nonexistent targets reject; cross-check against each export's
  `links.json`.
- **Renderer:** hostile-input battery (script tags, `javascript:` URLs,
  unbalanced markers, pathological nesting, 1 MB messages, zero-width chars)
  never produces executable markup or throws; for every real message,
  rendered text content == source minus markdown syntax (no content dropped
  or rewritten); snapshot per real thread (local only).
- **Key endpoint:** the full table above plus malformed JSON, header
  injection, and oversized tokens; for every non-200, assert the key bytes
  appear nowhere in status/headers/body.
- **Leak guards:** pre-commit hook rejects staged paths under
  `archive-export/`, `public/archive/`, and any file whose content matches
  export signatures (snowflake-dense JSON with `"guild_id"`, archive asset
  sha256s) — with its own tests; CI job fails if any such path is tracked;
  post-build scan of `dist/` (CI) for image magic bytes and plaintext JSON
  signatures (`"guild_id"`, `"content":`) anywhere under the build output;
  locally, pre-push additionally scans `dist/` for content sentinels and
  snowflake ids sampled from the plaintext export (unavailable in CI by
  design).
- **E2E (docker compose + discord-mock):** synthetic fixture collection
  (committed; no real content) sealed with a throwaway key at test time.
  Member-with-role sees content and in-site navigation between collections;
  member without role gets the restricted state; signed-out gets sign-in;
  every network response in all three flows is scanned for fixture plaintext.
- **Gate:** husky pre-push = whole suite (no new failures) + 100% coverage and
  mutation score on `archiveCrypto`, link resolver, markdown parser,
  `archiveKey`.

## Server configuration

New env: `ARCHIVE_KEY`, `ARCHIVE_ROLE_ID=1377787723976409211`. Reuses
`DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `ALLOWED_ORIGIN`. CORS adds nothing
new (GET already allowed).

## Known limits

- A user who fetched the key keeps it after losing the role; `--rotate` +
  redeploy revokes access to the current bundle.
- Ciphertext sizes are visible; content is not.
- The page is unavailable whenever the builds API is down (fail closed).

## Out of scope

Editing content on the site, search, author/timestamp display, importing
channels outside the two forums, re-exporting from Discord.
