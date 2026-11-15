# Librarius: the Discord forum on the site, both ways

Design, 2026-11-15. A new section of the Reliquarium (`/reliquarium`) that mirrors the guild's Librarius forum
channel and lets members post to it from the site.

## Intent

The Librarius is a Discord forum channel. The site gets its own Librarius tab, the first tab of the Reliquarium:
a topic list, and one page per forum post, nested under it. The two sides stay one forum:

- a post, reply, edit, delete, rename, tag change or reaction made in Discord shows on the site within seconds;
- a reply made on the site appears in Discord under the signed-in member's server name and picture. New posts
  are started in Discord only.

Nobody is pushed to one side. Every site post links to Discord, every site-made Discord message links back to
the site, and people who never open the site lose nothing.

## Why

Parity with Discord, plus a better writing experience than the Discord client: long lore posts with headings,
inline images and a formatting toolbar. Members are vetted and the page is members-only, but every post, from
either side, is still treated as hostile and kept sandboxed. The site must not become a way to attack members,
the API or the guild.

## The Librarius today (read 2026-11-15)

Facts the build rests on. Live data stays out of git: no member names, no post titles, no channel id here.

- A forum channel (type 15). Its id goes in `server/.env` as `LIBRARIUS_CHANNEL_ID`.
- 14 posts: 8 active, 6 archived, about 16.1k messages in all. Three are busy rooms with thousands of
  messages each. The rest are long-form entries with tens of messages or fewer, and one is a pinned info post.
- 4 forum tags, none required. No post guidelines, no slowmode.
- **Who sees it:** `@everyone` is denied View Channel; about 16 roles are allowed (the companies, the
  Librarius roles and a few others) plus one per-member overwrite. The XVIIIth Legion role is **not** among
  them, so the Reliquarium's gate (the Legion role) is the wrong rule for the Librarius.
- **Who posts:** `@everyone` holds Send Messages and Send Messages in Threads guild-wide and the channel denies
  neither, so anyone who can see it can start posts and reply.
- **Moderation:** Chief Librarian holds Manage Threads, Manage Messages and Manage Channels; Codicier and
  Epistolary hold Manage Messages (guild-wide); admins hold everything.
- **The bot** (the Servo-Skulls role) holds Manage Webhooks, Manage Threads, Manage Messages and Mention
  Everyone guild-wide, and the owner gave it access to the Librarius on 2026-11-15. The Message Content intent
  is already on. The API reaches Discord by REST only today; nothing holds a gateway connection.

Code that already exists and is reused:

| Need | Existing piece |
|---|---|
| Who is asking, their roles, admin check | `server/src/discordRoles.js` (`identify`, `rolesOf`, `memberOf`, `isAdmin`) |
| Short-lived per-token verdicts | `server/src/verdictCache.js` |
| Guild member cache (names, avatars) and the member search | `server/src/roster.js`, `searchMembers` in `deathwatchPeople.js`, `src/lib/deathwatch/memberSearch.js` (`useMemberSearch`) |
| Discord-flavoured markdown → AST, rendered without `v-html` | `src/lib/archive/markdown.js`, `src/components/archive/ArchiveMarkdown.js` |
| A module the site and the server both import | the `server/src/galleryParse.js` pattern (no imports; guarded by `src/lib/gallery/sharedParser.test.js`) |
| Reply/request helpers, 503-until-configured pattern | `server/src/httpReply.js`, `galleryConfig.js`, the gallery wiring in `server/src/index.js` |
| The Reliquarium page and its tabs | `src/views/Reliquarium.vue`, `src/stores/gallery.js`, `src/router.js` |
| Emoji picker and the standard emoji list | the Req_bot dashboard repo on this host: `dashboard/src/components/ui/EmojiPicker.vue` (+ spec), `dashboard/src/data/emojis.json` (362 emoji) |

## Decided by the owner

1. **Placement.** The Librarius is the **first** Reliquarium tab: `/reliquarium/librarius` is the topic list,
   `/reliquarium/librarius/<post id>` is a post.
2. **Two-way sync.** Discord → site in the style of Answer Overflow: a live gateway connection, plus a one-time
   import of the **full history** of every post (active and archived), plus a catch-up check for anything
   missed while the API was down. A delete in Discord removes it from the site. Site → Discord in the style
   of the Matrix bridges: **one channel webhook** posting under the member's server nickname and avatar.
   **The site replies to existing posts only.** Starting a forum post stays in the Discord client.
3. **Long posts are split** into consecutive Discord messages at paragraph breaks, **at most 3 parts**, each
   numbered, with jump links between them (decision 19).
4. **Jump links both ways.** "Open in Discord" on the site; **"Open On Site"** at the foot of every
   site-made Discord message.
5. **Edits happen only where the post was written.** A site post is edited on the site; a Discord message in
   Discord. (Discord lets no bot edit someone else's message, and members cannot edit a webhook message in
   the Discord client.)
6. **Authors can delete their own posts from either side.** A message written in Discord is deleted with
   Discord's own Delete, and the site follows. A site-written message belongs to the webhook in Discord, so
   its author gets no Delete there. Instead the bot offers **"Delete on site"** in the message's Apps menu.
   It answers with an **ephemeral reply** (seen only by them) reminding them to delete it on the site, with a
   jump link to that message on the site. The delete itself always happens on the site.
7. **Images stay in Discord.** The site never copies them to R2; the API asks Discord for fresh links before
   the old ones expire, on a timer.
8. **Access follows the Librarius's own Discord permissions.** "This is the Librarians' house": they need
   full control and exact parity. Whoever can see, reply, react or moderate in Discord can do the same on
   the site, and nobody else.
9. **Markup is extended Markdown only.** No HTML, no BBCode. All the earlier security proposals are accepted.
10. **Layouts (from the mockups):** topic list **C**, post page **C** (hybrid) **with the "site" tag**,
    composer **A** (sketches below).
11. **@ mentions use the Deathwatch member search.**
12. **Reactions:** Discord reactions show on the site, and the site has its own reactions engine. A site
    reaction is **mirrored by the bot** (option B, below).
13. **Custom server emoji** are loaded through the same bot pipeline as the members, for the picker,
    rendering and reactions.
14. **The sync lives inside the existing API**, under the one tunnel. No new service.
15. **Exposure:** the owner is comfortable with the host as long as the tunnel and the secrets stay secret on
    the host. Port 8787 is only used directly for the odd local check on the host itself.
16. **AutoMod holds for site posts** (option A). The guild's 4 AutoMod rules all cover the Librarius:
    - a custom keyword filter that blocks;
    - Discord's preset lists (sexual content, slurs), which alert only;
    - a suspected-spam filter that blocks;
    - a mention-spam limit that blocks and times out.

    Webhook messages very likely skip AutoMod. The site therefore applies what can be copied when a reply is
    saved: the custom keyword rules (keywords, regex patterns, allow list and exempt roles, read live from
    Discord) and the mention limit. The preset lists and the spam detection are internal to Discord and can't
    be copied; the Librarians clean up after those.
17. **A split post is one unit.** A delete of any of its Discord parts, by anyone, deletes the whole message
    on both sides (the bot removes the remaining parts). Reactions on any part count toward the one message on
    the site. The bot mirrors site reactions onto the **last part**, the one with the footer.
18. **A post's owner is whoever created it in the guild** (Discord's thread owner). No post is ever created
    from the site.
19. **The full reply is visible in Discord.** Site replies go out in Discord's newer message layout
    (Components V2): about 4000 characters a message, images inline, dividers, and an "Open On Site" link
    button. A reply that still needs more than one message gets the same `n/N` marker on every part, plus
    jump links from part 1 to the others and back. Plain numbered messages are the fallback (see "Discord
    form").

## Goals, non-goals, anti-goals

**Goals:** the Librarius reads the same from either side, and replies, edits, deletes and reactions work from
either; long-form posts are better to write on
the site than in Discord; access matches Discord exactly; nothing hostile gets through, in either direction.

**Not in this work:** site notifications (Discord's pings cover that); search on the site (Discord's search
covers it); any channel other than the Librarius; editing Discord-written messages from the site (impossible);
polls, stickers and threads-in-threads beyond showing them read-only.

**Anti-goals (a failure even if it works):**
- anything that makes Discord worse for people who never use the site: double posts, bot spam, lost messages,
  pings nobody asked for;
- the site showing the Librarius to anyone Discord would not, or hiding it from anyone Discord would show it to;
- a bug in the Librarius taking down Builds, the roster, Deathwatch or the Reliquarium (directly, or by getting
  the bot's IP rate-banned by Discord);
- a site-made Discord message that can pass for someone it is not.

## Approaches considered

| Question | Options | Chosen | Why |
|---|---|---|---|
| Where the sync runs | A inside the API · B a separate worker container from the same image · C discord.js | **A** | Follows the Reliquarium's pattern (its poll already runs inside the API); reuses the role and member caches, the Discord client and the pool; one deploy and one rollback tag. B's isolation is not worth a second service for a few dozen members. C brings a large dependency tree into a server whose only dependency is `pg`. A's risk (a sync bug taking the API down) is fenced, see "Containment". |
| Posts longer than Discord allows (2000 per bot/webhook message) | A split · B cap the site at 2000 · C excerpt + link | **A, capped at 3 parts** | Parity: Discord readers miss nothing. |
| What a site reply looks like in Discord | A plain messages, numbered, with jump links · B Components V2 (≈4000 a message, images inline, link button) with A's markers when it splits · classic embeds (6000 a message, but only one image per box, at its foot, and gaps between boxes) | **B, falling back to A** | Closest to the site version, and the whole reply stays visible in Discord. |
| Access | A follow the channel's Discord permissions · B the Reliquarium's Legion rule | **A** | The Librarius's audience is not the Legion role; B would leak and lock out at once. |
| Markup | A extended Markdown · B + BBCode-style tags · C + an HTML subset | **A** | One parser, the smallest surface to defend; everything has a Discord form. |
| Topic list | A table · B card grid · C rows with the latest line + thumbnail | **C** | Familiar from Discord's list view; shows what is happening in each room. |
| Post page | A full cards · B compact chat · C hybrid | **C** | One page must suit a long lore post and a room of 7.9k short messages. |
| Composer | A markdown + toolbar + live preview · B word-processor (Tiptap) · C styled markdown (CodeMirror) | **A** | A plain text box gives script no way in; the preview is the post page's own renderer, so it is exact. |
| Site reactions | A site-only · B the bot mirrors · C read-only | **B** | No site reaction is invisible in Discord; the site has the full picture. Discord lets no app react as a member. |
| AutoMod and site posts | A the site applies the copyable rules on save · B no filtering, Librarians clean up | **A** | The guild's own rules still hold for what the site sends. |
| Deleting a site post from Discord | A Apps-menu command · B 🗑️ reaction · C site only | **A, as a reminder** | The command answers ephemerally with a jump link; the delete happens on the site. Nothing destructive runs from a Discord command. |
| One part of a split post touched in Discord | A the post is one unit · B keep the remaining parts | **A** | One message on the site is one message, whatever Discord needed to carry it. |
| Starting posts | from the site too · Discord only | **Discord only** | Creation stays in the client. |
| Second runtime (discord.py) for the ephemeral reply | discord.py · the API's own gateway client | **the API** | An ephemeral reply is one REST call answering an interaction, and interactions arrive on the gateway connection the API already holds. A Python bot would be a second runtime holding the same token. |

## The pages

### Reliquarium gate and navigation

The Reliquarium page asks two questions of the server: the gallery's (`GET /gallery/me`, unchanged) and the
Librarius's (`GET /librarius/me`). It shows the tabs each answer allows, Librarius first. Someone the
Librarius admits but the gallery does not (say, a holder of an allowed role without the Legion role) sees only
the Librarius tab. Neither answer → the page's existing "Restricted" state. `/reliquarium` with no tab opens
the Librarius for anyone who may see it, otherwise Clips.

The nav shows "Reliquarium" today only when `auth.member.isMember` (the Legion hint). It must also show for a
Librarius viewer. The hint is a UX hint only: the server checks every call.

### Topic list (`/reliquarium/librarius`, layout C)

```
[ Librarius ] Clips  Artwork  Submit  Mine  (Review)
(All) (tag) (tag) (tag) (tag)       Latest activity ▾   [Start a post in Discord ↗]
┌ PINNED  Info post title                      (tag)
│ First line of the opening message …
├ Busy room title            (tag)   12 new                          ┌──────┐
│ Ixen Calloway: Finally got the highlights to read at arm's …     │thumb │
│ 7,931 replies · 2m ago · (av)(av)(av)                             └──────┘
├ …
└ Show archived (6)
```

Each row: title, tags, "N new" for the reader, the newest message's author and first line (plain text, no
markup, about 120 characters), a thumbnail when the newest message carries an image, reply count, last
activity, the avatars of the last three distinct posters. The pinned post sits on top. Tag filter chips; sort
by latest activity (default) or creation date, the two orders Discord offers. Archived posts sit behind
"Show archived". Posts are started in Discord only, so the button opens the forum in Discord **(my call)**.

### Post page (`/reliquarium/librarius/<post id>`, layout C)

```
Reliquarium › Librarius › Post title
Post title                                        Open in Discord ↗   [⋯]
(tag) · 42 replies · started 8 Nov
┌ (av) Tor Mardan · 8 Nov 21:14            (always written in Discord)
│ ## Heading
│ Long text …  [inline picture]  ### Sub-heading …
│ ↩ Reply  ❝ Quote  🔗 Link  Edit  (reactions)
└
            [ Load 20 older replies ]
(av) Ixen Calloway  9 Nov 10:02                        │ Nov 8
     Short reply …                                     │  ·
     🔥 4  📜 1                                         │ ● you
──────── SINCE YOUR LAST VISIT · 3 NEW ────────        │ today
↪ replying to Ixen Calloway: Do the caravans …
(av) Tor Mardan  today 09:41 [site]
     Short reply …
[ Reply to Post title…                         Write ]   (docked composer)
```

- The **opening message** is laid out as an article: wide, headings, inline pictures.
- **Replies** are compact, consecutive messages from one person grouped as Discord groups them. A reply that is
  long, or holds a heading, table or image, gets the article layout too (the builder sets the threshold).
- A **"site" tag** marks messages written on the site.
- A **"replying to"** line with the quoted start, linking to the original.
- A **"since your last visit"** divider. The page **opens at the reader's last-read spot**.
- **"Load older"** in pages, a **date rail** to jump through the history, and Back restores the scroll
  position. No pure infinite scroll.
- Every message has its own address (`#m-<id>`, as the Legion Archive does).
- Actions: Reply, Quote (select text → quote), copy Link, Edit (own site-written messages), Delete (own, or
  any for someone who may manage messages), React.
- The **⋯ menu** holds the Librarians' tools, shown only to those whose Discord permissions grant them: pin,
  lock, archive/unarchive, edit tags, rename, delete the post.
- **The post's owner** (its creator in Discord) gets on the site what Discord gives a post's owner: rename,
  edit tags, close and reopen, carried out by the bot **(my call)**.

### Composer (layout A)

```
Replying in: Post title            ↪ replying to Ixen Calloway  [@ on]  ✕
| H1 H2 H3 | B I U S spoiler | ❝ {} • 1. | 🔗 🖼 ▦ ― @ | -# small |
┌ markdown source ───────────┬ Preview | Discord view ─────────┐
│ ## The Arridian Wastes     │ The Arridian Wastes              │
│ South of … **cool season** │ South of … cool season …         │
│ ![Ash plain map](upload:1) │ [picture]                        │
└────────────────────────────┴──────────────────────────────────┘
Posting as Tor Mardan (your server name and picture)   Draft saved
▓░░░░░░ 2,340 / 12,000 · 1 Discord message · 1 image         [Reply]
```

- **Replies only**, never a new post: no title or tag fields.
- Markdown on the left, live preview on the right (tabs on a phone). The toolbar inserts markdown, so
  nobody has to remember it. The preview is the post page's own renderer.
- A **Discord view** tab shows exactly what Discord will get: the parts, the flattened extras, which image is
  attached to which part, and the footer.
- Docked at the bottom of the post page; expands to full screen for long writing.
- **Drafts** autosave in the member's own browser, never on the server.
- **@** opens the member search (name or id), limited to people who can see the Librarius. It inserts a
  mention the site shows as `@Name`.
- **Emoji** from the picker (standard plus the guild's custom emoji).
- **Images** by upload, drag or paste only. No image links from outside.
- A live **budget meter** against the 3-part cap. The meter and the server use the same splitting code, so a
  reply the meter accepts never fails on the Discord side for its length.
- **AutoMod:** a reply the guild's copyable AutoMod rules would block is refused when saved, with the rule's
  name and the matched word marked in the editor, as Discord tells the writer **(my call)**.

## Markdown: two dialects, one parser

The parser in `src/lib/archive/markdown.js` grows into a module the site and the server both import (the
`galleryParse.js` pattern: no imports). It keeps its properties: an AST out, never markup; unknown syntax
stays literal; linear time on hostile input; a nesting cap.

- **`discord` dialect**: exactly what Discord renders, for every message written in Discord. A pipe table typed
  in Discord stays literal text on the site, as in Discord.
- **`extended` dialect**: for messages written on the site. The Discord set (bold, italic, `__underline__` with
  Discord's meaning, strike, `||spoiler||`, inline and fenced code, quotes, `#`–`###`, `-#` subtext, lists,
  masked links, mentions, custom emoji) plus: `####`–`######` headings, pipe tables, `---` dividers,
  footnotes, and inline images `![alt](upload:N)`. The `upload:` scheme is the only image source accepted.
- Links: `http` and `https` only, in both dialects.

**Discord form of an extended reply** (a pure function, shared with the composer's Discord view). The goal
(decision 19) is that **the whole reply is readable in Discord**; nobody has to open the site to read it.

*Primary form: Discord's newer message layout (Components V2, flag `IS_COMPONENTS_V2`).* Each Discord
message is one Container (accent bar) of components, rendered at full length in the chat. Nothing scrolls
or collapses inside it.
- Text goes in Text Display components (Discord markdown inside them).
- Each image is a Media Gallery item **inline, where it was written**, referencing its upload as
  `attachment://<name>`.
- `---` becomes a Separator. `####`–`######` becomes a bold line. A table becomes a fenced code block,
  aligned in monospace. Footnotes are listed at the end of the message that cites them.
- The top line is the reply line (`-# ↪ <@repliedAuthorId> [jump](<link>)`) when it is a reply.
- The bottom of the last message is `-# <@authorId>`, followed by a link button **"Open On Site"**.
  `<@authorId>` shows as the real, clickable member and, with allowed mentions empty, pings nobody. It is
  what stops a nickname passing for someone else, since a webhook message never links to the poster's
  profile.
- About 4000 characters of text per message and at most 40 components. Splitting happens only past that.

*When a reply needs more than one message:*
- Split at paragraph breaks, never inside a code block, table or list item when a break elsewhere fits.
  A single paragraph over the limit breaks at a sentence, then a word.
- **At most 3 messages.** That is about 12,000 characters in the primary form, and the meter shows the
  budget. More is refused.
- Every message is headed with the same marker, `1/3`, `2/3`, `3/3`. Message 1 carries jump links to the
  later ones. Their ids only exist once they are sent, so message 1 is edited right after them. Every later
  message carries `↑ from 1/3`. A reader can follow the reply even when someone posts in between.

*Fallback form: plain messages, for use if batch 2's check in the guild finds the primary form wanting.*
The 4000 limit is documented by the community, not by Discord. Search and notification previews also need
checking.
- The same markers and jump links, ≤2000 characters a message.
- Images are attached under the message they fall in rather than inline.
- The footer becomes the text line `-# <@authorId> · [Open On Site](<site link>)`.
- The same 3-message cap, so about 6,000 characters.

The choice between the two forms is one switch in the Discord-form module. The composer's Discord view
always shows the form in use.

## Discord → site

### The gateway connection

A gateway client written in this repo over Bun's built-in WebSocket (API v10, JSON): identify, heartbeat with
jitter and ACK checking (a missed ACK means reconnect), resume with session id and sequence at the resume URL,
reconnect with backoff, and respect for the daily identify budget. Intents: `GUILDS`, `GUILD_MESSAGES`,
`GUILD_MESSAGE_REACTIONS`, `GUILD_EMOJIS_AND_STICKERS`, `MESSAGE_CONTENT`. Only events for the Librarius are
kept: the forum itself, threads whose parent is the forum, and messages and reactions in those threads.
Others are dropped on arrival. Events used:

- `THREAD_CREATE / UPDATE / DELETE / LIST_SYNC` for posts, titles, tags, pin/lock/archive state;
- `MESSAGE_CREATE / UPDATE / DELETE / DELETE_BULK` for messages;
- `MESSAGE_REACTION_ADD / REMOVE / REMOVE_ALL / REMOVE_EMOJI` for reactions;
- `INTERACTION_CREATE` for the "Delete on site" command (batch 2);
- `CHANNEL_UPDATE` (the forum's overwrites and tags), `GUILD_ROLE_CREATE / UPDATE / DELETE` (role
  permissions) and `GUILD_EMOJIS_UPDATE`, to invalidate the caches below.

### Import and catch-up

- **First run:** every post (active from `GET /guilds/{id}/threads/active`, archived from
  `GET /channels/{forum}/threads/archived/public`, paged) and every message in each, oldest first, 100 per
  call (about 170 calls in all). Paced well inside Discord's limits; the page shows the Librarius once the
  import has finished.
- **Every start:** for each post, fetch what is newer than the last stored message, and re-read a recent window
  to catch edits and deletes made while the API was down (the builder sets the window). Also re-list threads
  for renames, tag and state changes.
- **Deletes are hard deletes** on the site: the message, its reactions and its attachment records.

### Images and attachments

The database keeps each attachment's metadata (id, filename, type, size, dimensions, the signed URL and its
expiry, read from the URL's `ex` parameter). Images are served straight from Discord's CDN with those signed
links. **A timer refreshes links before they expire**, limited to messages someone has opened recently. A
link found already expired when a page is read is refreshed then. Embed images from Discord link previews
are shown only through Discord's media proxy (`proxy_url`), so no reader's browser fetches a third-party
image. Videos and other files show as links to the CDN.

## Site → Discord

### The webhook

One webhook on the Librarius forum, created by the bot (so it belongs to our application and its messages
carry our `application_id`). Its URL is a secret: `server/.env` only (`LIBRARIUS_WEBHOOK_URL`), never logged,
never sent to a browser. A one-off command creates it and prints where to put it (the owner runs it).

- **Name** = the member's server nickname, else their global name, else username. It is cleaned to 1–80
  characters, and "discord" and "clyde" are removed because Discord refuses names containing them.
  **Avatar** = their server avatar, else their user avatar, else Discord's default, by CDN URL.
- **Reply** (the only kind of send; the site never creates a post): Execute Webhook with `thread_id` and
  `wait=true`. Every send carries `flags: IS_COMPONENTS_V2` (primary form; `SUPPRESS_EMBEDS` in the
  fallback) and an explicit
  `allowed_mentions`: `parse: []` plus only the user ids picked through the member search. One function
  builds every send, so a missing field cannot ping `@everyone` (the bot holds Mention Everyone).
- **Replies** can't be native Discord replies (webhooks have no message reference). A site reply begins with
  `-# ↪ <@repliedAuthorId> [jump](<link>)`. By Discord's default a reply pings its author, with an on/off
  toggle in the composer like Discord's **(my call)**.
- **Locked posts:** only someone with Manage Threads may reply, as in Discord. The site enforces it because
  the bot's own rights would let any webhook send through.
- **Archived posts:** a reply unarchives the post, as in Discord.

### The outbox (no lost posts)

A site post is written to Postgres first, as a pending outbox entry, before anything is sent. A worker inside
the API sends entries in order, stores the Discord message ids it gets back (one per part), and marks them
sent. It retries with backoff on failure, and the page shows "sending…" until then. Edits, deletes and
reaction mirrors go through the same outbox. If the webhook answers 401 or 404, all sending stops and the
API logs that the webhook needs recreating.

**Echo handling:** messages from our webhook are written by the outbox itself, so their `MESSAGE_CREATE` is
ignored. `MESSAGE_DELETE` of one of them still mirrors (a Librarian may delete it in Discord). Messages from
other webhooks or bots in the Librarius are ordinary Discord-written messages.

**One unit (decision 17):** every part's Discord id maps to its site message. A delete of any part, from
Discord or through a bulk delete, queues the deletion of the remaining parts and removes the message from
the site. Reactions on any part are folded into the one message. Site reactions are mirrored onto the last
part.

### Edits and deletes

- **Edit (site-written, author only):** the stored extended source is replaced, re-rendered and re-split. Parts
  that still exist are edited in place (Edit Webhook Message with `thread_id`). Surplus parts are deleted. If
  the edit needs more parts than before, the new ones are posted at the end of the post, each starting
  the next marker and `↑ from 1/N`, and message 1's jump links are updated **(my call)**. An edit in an archived post unarchives it, edits, and
  archives it again (Discord refuses edits in archived threads).
- **Delete on the site:** by the author, or by anyone with Manage Messages for any message. A site-written
  message is deleted part by part through the webhook. A Discord-written message is deleted by the bot (it
  holds Manage Messages), and only after the site has checked that the requester is its author or may
  manage messages. Deleting a whole post needs Manage Threads. Whether a post's owner may delete the whole
  post follows what Discord allows (the builder checks).
- **Delete in Discord:** a Discord-written message is deleted with Discord's own Delete, and the gateway carries
  that to the site. A Librarian (Manage Messages) can delete a site-written message in Discord too, and decision
  17 removes the rest of it. For a site-written message's own author, the bot registers a message command
  **"Delete on site"** in the guild (the Apps menu of a message). It runs no delete. It answers with an
  **ephemeral** reply, seen only by them:
  - on their own site-written message: "This was written on the site. Delete it there:" plus a jump link to
    that message on the site (`/reliquarium/librarius/<post>#m-<id>`);
  - on a Discord-written message: "Written in Discord: use Discord's own Delete.";
  - on someone else's message or outside the Librarius: "Only the author can delete this, on the site."

  Interactions arrive as `INTERACTION_CREATE` on the gateway connection the API already holds (the app must
  have no Interactions Endpoint URL set). The reply is one REST call to the interaction callback with the
  ephemeral flag, within Discord's 3-second window. No discord.py, and no second runtime. The owner can limit
  where the command shows under Server Settings → Integrations.

### Uploads

Images only (PNG, JPEG, WebP, GIF), checked by their bytes, not their name, and at most Discord's per-file
limit for the guild. At most 10 per post **(my call)**. They travel **one per request**, so the API's 12 MB
body limit stays. They are held by the API only until the post is sent, and are discarded at once afterwards,
or after an hour if never sent. Before forwarding, the API strips metadata in plain code, with no image
library: JPEG APP1/APP13 (EXIF, XMP, IPTC, where phone photos keep GPS); PNG `tEXt`, `zTXt`, `iTXt`, `eXIf`;
WebP `EXIF`, `XMP `; GIF comment extensions. Nothing relies on Discord to strip them.

## Reactions and emoji

- **Emoji:** the guild's custom emoji are read by the bot (`GET /guilds/{id}/emojis`), cached like the member
  list, and refreshed on `GUILD_EMOJIS_UPDATE`. Images come from Discord's public emoji CDN. The picker is
  ported from the Req_bot dashboard, along with its standard emoji list.
- **Discord reactions** stream in live. History arrives with the counts on each message; who reacted, for old
  messages, is fetched on demand when someone opens the list.
- **Site reactions (bot mirror):** a member reacts on the site → stored as theirs. If they are the first site
  reactor of that emoji on that message, the bot adds the same reaction in Discord. When the last one takes
  theirs back, the bot removes its own. The site shows the full who-list from both sides and counts each
  person once. Discord shows the emoji with every site reactor together as one bot reaction. The bot's own
  reactions are never counted as a person. Only unicode emoji and this guild's custom emoji can be mirrored,
  because the bot can't use other servers' emoji. Who may react follows Discord's Add Reactions rule.

## Access: Discord's permission rules, computed

A pure module computes a member's permissions in the Librarius the way Discord does:

1. The guild owner, or a held role with Administrator, has everything.
2. Base = `@everyone`'s permissions, OR'd with every held role's.
3. Channel overwrites in order: `@everyone` deny then allow; all held roles' denies, then allows; the member's
   own deny then allow.
4. No View Channel → nothing.

Threads inherit the forum's result. Reading needs View Channel and Read Message History. Replying needs Send
Messages in Threads, plus Manage Threads in a locked post. Attaching images needs Attach Files. Reacting needs
Add Reactions. Deleting others' messages needs Manage Messages. The Librarians' tools need Manage Threads. A
post's owner (Discord's `owner_id` of the thread) gets the owner's tools whatever their roles. A
member who is **timed out** (`communication_disabled_until` in the future) may read but not post, edit or
react, as in Discord. Someone not in the guild gets nothing.

Inputs: the guild's roles and the forum's overwrites, cached and invalidated by the gateway events above; the
member's roles and timeout, asked per request through `discordRoles.js` with a short verdict cache, and fresh
for every write. If Discord can't be answered, the request is refused.

## Unread tracking

Per member and post, the newest message they have seen, stored when messages scroll into view. It drives
"N new" in the topic list, the "since your last visit" divider and where a post opens.

## Security

**The main threat is script running on the site.** The Discord token sits in the browser's `localStorage`. A
script that runs can steal it and post as that member, on the site and in Discord through the webhook. The
second threat is the bot being made to misbehave in Discord. The layers:

1. **Only source text is stored**, never HTML. The API re-parses every save and refuses: more than 3 Discord
   parts; nesting past the cap; a link that isn't `http`/`https`; an image that isn't an upload sent with
   that same reply; a mention of an id not picked through the search, or more than 10 mentions; anything the guild's copyable AutoMod
   rules block (decision 16).
   - **Which rules:** keyword rules (keywords with Discord's `*` wildcards, allow list), and mention spam
     over the rule's limit.
   - **Who is exempt:** the rules' exempt roles, plus whoever Discord itself exempts (Administrator, Manage
     Server).
   - **Regex patterns** (none today) run through a matcher bounded in time and input length, so a pattern
     can't stall the API.
2. **Rendering** goes AST → Vue nodes, never `v-html`, for both dialects (the repo's `no-v-html` tests extend
   to the new components).
3. **No outside images.** Only Discord-hosted attachments and Discord's media proxy. No tracking pixels, no
   leaking readers' IPs to third parties.
4. **A site-wide Content-Security-Policy**, as a `<meta>` tag (GitHub Pages can't send headers): scripts only
   from the site (plus hashes for the inline redirect scripts in `index.html`/`404.html`), images and media
   only from the site, Discord's CDN and media proxy, `blob:` (composer previews), and what the site already
   loads (R2 for the Reliquarium, YouTube/Twitch/Medal frames); `object-src 'none'`, `base-uri 'none'`. The
   builder lists everything the site loads today, and end-to-end tests prove nothing breaks.
5. **Discord-written content is untrusted too**: the same parser, the same rules.
6. **Bot safety:** explicit `allowed_mentions` on every send; embeds suppressed; the author shown by real
   mention in the footer; per-member rate limits and a ceiling on all bot writes (below).

**Rate limits (starting values, my call; the builder tunes them):** per member, 10 replies a minute, 20 edits a minute, 30 reactions a minute, 30 uploads an hour. Over the limit → 429 with a
plain message. All Librarius writes to Discord share one ceiling (about one a second, with a small burst). The
Librarius's Discord calls go through a client that obeys Discord's rate-limit headers and backs off inside its
own share, so it can never spend the allowance the roster, membership checks, the Reliquarium and Deathwatch
need. Discord bans an IP after 10,000 refused calls in 10 minutes, and that would take every feature down.

**No member is ever struck because of the site (the owner's condition for approval, 2026-11-15).** Using the
site must never earn a member a timeout, an AutoMod alert, a strike or a record against them:
- The site's AutoMod check (decision 16) only **refuses before sending**, and tells the writer why. It never
  times anyone out, never sends an alert to the moderators' channel, never reports anyone, and keeps no
  record against the member. A refused reply never leaves the site.
- **Mentions** are capped at 10 per reply **(my call)**, far below the mention-spam rule's limit (40 today),
  so its timeout can never be reached. The API reads the rule's live limit and keeps its own cap below it.
- **What Discord sees:** site replies go out as the webhook, not as the member's account. If Discord's
  AutoMod or safety systems act on such a message at all, they act on the app's message, not on the
  member's account. Batch 2's check in the guild confirms that no AutoMod action (block, alert or timeout)
  lands on a member for a webhook message. If one would, the batch stops there and the design is revisited
  before anything ships.
- **If Discord blocks a send anyway** (AutoMod's "message blocked" error), the outbox does **not** retry it,
  because repeats would flood the moderators' alert channel and add to the refused-call count. The reply is
  marked "blocked by the server's rules" on the site, for its author to edit or delete.
- **Bot reactions and the "Delete on site" command** act as the app only and can't cause a strike.
- **The other direction is unchanged:** a member already timed out in Discord can read but not post on the
  site (Access, above). That respects a strike; it never creates one.

**Containment (approach A's risk):** the gateway, import, catch-up, timer and outbox run behind error
boundaries. Nothing they throw reaches the web server, and an unhandled rejection is caught and logged, not
fatal. Until `LIBRARIUS_CHANNEL_ID` is set, every `/librarius` route answers 503 and nothing connects, the way
the Reliquarium did.

**Exposure (owner's decision 15):** the gateway connection is outgoing, so the Librarius opens no new port.
The API container's port is published on every interface today, which skips Cloudflare for anyone who can
reach the host. Batch 1 publishes it as `127.0.0.1:8787:8787` (local checks on the host still work; the
tunnel only needs localhost).

**Stored data:** the database will hold about 16k messages of people who may never use the site. Only people
Discord already shows them to can read them on the site. They are in the weekly database backup. A delete
reaches the database at once; backups age out on their own schedule.

## Data (sketch; the builder finalises)

- `librarius_posts`: thread id, owner id, title, tag ids, pinned, locked, archived, created, last activity,
  message count.
- `librarius_messages`: id (the first Discord part's id), post, author id, author name and avatar at the time,
  origin (`discord` | `site`), Discord content, extended source (site messages only), reply-to, created,
  edited.
- `librarius_parts`: each Discord message id of a site message, with its order, so a part found anywhere
  (a delete, a reaction) leads to its message.
- `librarius_attachments`, `librarius_reactions` (message, emoji, person, side), `librarius_reads`.
- `librarius_outbox`: operation, payload, state, attempts, next try, last error.
- `librarius_uploads`: transient image bytes awaiting a send (an hour at most).
- `librarius_events`: what was done from the site and by whom. Discord's audit log shows only the bot, so this
  is the Librarians' record.
- `librarius_sync`: gateway session and sequence, import progress.

## Routes (sketch; the builder finalises)

`GET /librarius/me` (what the caller may do) · `GET /librarius/posts` · `GET /librarius/posts/:id/messages`
(`before` / `after` / `around`) · `POST /librarius/posts/:id/messages` (replies; there is no route that
creates a post) · `PATCH|DELETE /librarius/messages/:id` · `PUT|DELETE /librarius/messages/:id/reactions/:emoji` ·
`PATCH|DELETE /librarius/posts/:id` (Librarians' and owner's tools) · `PUT /librarius/posts/:id/read` ·
`GET /librarius/emoji` · `GET /librarius/members?q=` · the upload route(s).

## Rollout, in three batches

Each batch is its own PR. Deploys stay the owner's: schema, `server/.env`, API rebuild, then the site.

1. **Discord → site, read-only.** Permissions module, gateway, import and catch-up, store, read routes, topic
   list and post page, image link refresh, emoji and reaction display, unread tracking, the Reliquarium gate
   and nav change, the Content-Security-Policy, and the 8787 binding.
2. **Site → Discord.** The extended dialect and splitter, the composer, the webhook and its setup command,
   the outbox, replies and quotes, edits, deletes (with the split post as one unit), mentions, uploads with
   metadata stripping, the AutoMod check, rate limits, the footer and the "site" tag, and the "Delete on site"
   command with its ephemeral reply.
3. **Reactions and tools.** Site reactions with the bot mirror, the emoji picker, the Librarians' and owner's
   tools, and the events record.

## Testing

Per the owner's global rules: adversarial TDD, with mutation score 100% and coverage 100% on each new pure
unit, added to the repo's Stryker and coverage gate: the permission computation, both dialects, the Discord
form and splitter, save validation, the name cleaner, the metadata stripper, the rate limiter, the
event-to-store reducer (echo handling included), the outbox state machine and the gateway state machine
(against a fake socket). The e2e Discord mock (`e2e/discord-mock`) grows forum, webhook and gateway endpoints,
so the whole loop runs in the docker e2e stack. Behaviour is asserted (returned values, stored rows, what the
mock received), never logs.

## Left to the builder

- Discord behaviour the docs don't settle: whether a post's author may delete the whole post, how webhooks
  behave in a locked thread, the guild's upload limit, and the attachment-link refresh endpoint versus
  re-reading the message.
- Whether anything else holds a gateway session with this bot token (sessions coexist but share the identify
  budget).
- First thing in batch 2, check Components V2 in the guild through a test webhook, and pick the form from
  what you see:
  - the real text limit per message;
  - that a long message shows at full length on desktop and on a phone;
  - inline `attachment://` images;
  - the link button;
  - mentions rendered inside Text Displays and pinging nobody;
  - how Discord search and push-notification previews treat the message;
  - editing through the webhook.
- Verify in the guild that AutoMod really skips webhook messages. If it doesn't, the site's check still runs
  first, so a reply is refused on the site rather than failing in Discord.
- Whether the bot's install allows guild commands (`applications.commands`). If not, the owner re-authorises
  it. Also check that the app has no Interactions Endpoint URL set, so interactions come over the gateway.
- How open pages get updates (polling or a stream); a first-time visitor starts with nothing marked new;
  images follow their text into whichever part a re-split puts it; the effective upload size is the lower of
  the 12 MB request limit and Discord's; who sees the events record (Manage Messages holders and admins, my
  call).
- The catch-up window, the page size, the "long reply" threshold, the grouping interval, and the exact rate
  limits.
- The schema, the route shapes and module boundaries, how the nav hint is answered, and which of the shown
  member's name/avatar (current or at posting time) the page uses.
