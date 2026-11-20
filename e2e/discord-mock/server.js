/**
 * Stand-in for Discord's API in E2E tests. Both server/src/index.js
 * (verifyCaller) and src/lib/discordAuth.js (finishSignIn) identify a caller
 * by POSTing their bearer token to Discord's own /users/@me — this returns
 * canned identities for a fixed set of test tokens so the whole sign-in →
 * save → see-it-listed flow can be driven without a real Discord account.
 * Membership (member vs. non-member) is decided by the role table below
 * (MEMBERS), checked against the API's configured member role
 * (ARCHIVE_ROLE_ID), same as prod, which asks Discord. The API reads it two
 * ways: a caller's own roles (/membership) and the guild member directory
 * (/v10/guilds/:id/members), which flags each author on the builds list.
 *
 * It also stands in for the Reliquarium's three outside services (e2e/tests/gallery*.spec.js): the Discord
 * clips channel the api polls, Discord's CDN its attachments download from, and the R2 bucket they are copied
 * into (path-style, at /<bucket>/<key>, which is where server/src/r2.js puts an object for R2_ENDPOINT
 * http://discord-mock:4400).
 *
 * And it stands in for the Librarius's one outside service, Discord itself (e2e/tests/librarius*.spec.js): the guild's forum
 * (its permission overwrites and tags), its posts and their messages, the guild's emoji, the attachment refresh, and a live
 * gateway WebSocket at /gateway that the api's connection reads. Test hooks under /__test/librarius change the forum the way
 * Discord would, and tell the gateway's listeners.
 *
 * For the replies from the site (batch 2) it is also the Librarius's webhook (make, list, execute in JSON or multipart with Components
 * V2, edit and delete), the bot's calls that go with it (a post archived or opened again, a message deleted), the server's AutoMod
 * rules, the guild's commands and the "Delete on site" interaction, sent down the gateway with its answer kept. What reached the
 * webhook and the answers are read back through /__test/librarius hooks, and so is every IDENTIFY's intents: the gateway refuses one
 * without Message Content (close 4014), as Discord refuses an intent the bot was not given.
 */
const PORT = Number(process.env.PORT || 4400)
// How the api and the browser reach this mock: the address an attachment's CDN link names.
const SELF = process.env.MOCK_BASE_URL || `http://discord-mock:${PORT}`

const USERS = {
  // In MEMBERS with the Legion role, so the API reports a member.
  'test-member-token': { id: '300000000000000010', username: 'member-tester' },
  // Well-formed but deliberately absent from MEMBERS: not in the guild at all.
  'test-nonmember-token': { id: '999999999999999999', username: 'nonmember-tester' },
  // In the guild (in MEMBERS) but without the Legion role.
  'test-norole-token': { id: '300000000000000014', username: 'norole-tester' },
  // Legion member who also holds Reclusiarch — reviews reports.
  'test-reclusiarch-token': { id: '100000000000000002', username: 'reclusiarch-tester' },
  // Techmarine — edits perks, sees history, moderates builds.
  'test-techmarine-token': { id: '100000000000000010', username: 'techmarine-tester' },
  // Master of the Forge — may revoke the Techmarine.
  'test-forge-token': { id: '100000000000000011', username: 'forge-tester' },
  // Company command (Captain of the 3rd) — may open the Infirmary list.
  'test-captain-token': { id: '100000000000000020', username: 'captain-tester' },
  // Deathwatch area (e2e/tests/deathwatch-api.spec.js): invented ids, here and in DEATHWATCH_MEMBERS.
  'test-deathwatch-token': { id: '200000000000000001', username: 'deathwatch-tester' },
  'test-commander-token': { id: '200000000000000002', username: 'commander-tester' },
  // Holds the second of the two Deathwatch roles the api is given as a list.
  'test-deathwatch-second-token': { id: '200000000000000004', username: 'deathwatch-second-tester' },
  // The guild owner and a holder of an Administrator role: both open the Deathwatch area, neither is a Commander.
  'test-owner-token': { id: '200000000000000005', username: 'owner-tester' },
  'test-admin-token': { id: '200000000000000006', username: 'admin-tester' },
  // The Deathwatch Command role: with a Deathwatch role, and on its own (deployed all the same).
  'test-command-token': { id: '200000000000000007', username: 'command-tester' },
  'test-command-only-token': { id: '200000000000000008', username: 'command-only-tester' },
  // In the guild with no role (in MEMBERS, so the Watch Commander's search finds them): the spec gives them the
  // desk, then they leave the guild and come back, which ends it for good.
  'test-granted-token': { id: '200000000000000003', username: 'granted-tester' },
  // Reliquarium curator (e2e/tests/gallery-api.spec.js): an invented id, here and in GALLERY_MEMBERS.
  'test-curator-token': { id: '200000000000000302', username: 'curator-tester' },
  // The Librarius (e2e/tests/librarius-api.spec.js): invented ids, here and in LIBRARIUS_MEMBERS. The librarian holds the
  // reader role and no Legion role; the shut-out one holds it too, but a member overwrite on the forum denies them View.
  'test-librarian-token': { id: '200000000000000402', username: 'librarian-tester' },
  'test-shut-out-token': { id: '200000000000000403', username: 'shut-out-tester' },
  // The Librarius's writers (e2e/tests/librarius-write.spec.js, e2e/tests/librarius-compose.spec.js): readers too, each with a spec's
  // replies of their own, since a member may send 3 replies a minute and the specs run side by side.
  'test-scrivener-token': { id: '200000000000000404', username: 'scrivener-tester' },
  'test-rubricator-token': { id: '200000000000000405', username: 'rubricator-tester' },
  'test-copyist-token': { id: '200000000000000406', username: 'copyist-tester' },
  'test-illuminator-token': { id: '200000000000000407', username: 'illuminator-tester' },
  // The site bar (e2e/tests/layout.spec.js): a Techmarine nothing revokes, here and in LAYOUT_MEMBERS. perks.spec.js ends by
  // revoking test-techmarine-token, and a spec that signed in as him would pass or fail by when the two happen to run.
  'test-layout-token': { id: '200000000000000510', username: 'layout-tester' },
}
const LEGION_ROLE = '1377787723976409211'
const RECLUSIARCH_ROLE = '1323334632904855592'
const TECHMARINE_ROLE = '1322056087859499042'
const FORGE_ROLE = '1322056087867883565'
const CAPTAIN_ROLE = '1322056087867883561'
const THIRD_COMPANY_ROLE = '1322056087850979333'
const THIRD_COMMAND_ROLE = '1323056001779241034'
const SERGEANT_ROLE = '1322056087859499044'
const LORD_OF_DRAKES_ROLE = '1322056087888859199'
const SCOUT_ROLE = '1430743608822206504'
const INFIRMARY_ROLE = '1362059023481831517'
const GUILD_ID = '1322056087792521269'
// Invented ids; e2e/docker-compose.yml hands the same ones to the api (DEATHWATCH_ROLE_ID is a list of two,
// WATCH_COMMANDER_ROLE_ID and DEATHWATCH_COMMAND_ROLE_ID single ids).
const DEATHWATCH_ROLE = '200000000000000101'
const DEATHWATCH_SECOND_ROLE = '200000000000000103'
const ADMINISTRATOR_ROLE = '200000000000000104'
const GUILD_OWNER_ID = '200000000000000005'
const WATCH_COMMANDER_ROLE = '200000000000000102'
const DEATHWATCH_COMMAND_ROLE = '200000000000000110'
// Deathwatch members answer the single-member lookup only. They stay out of MEMBERS, which feeds the
// full member list, so the roster specs' counts do not change.
const DEATHWATCH_MEMBERS = {
  '200000000000000001': { roles: [DEATHWATCH_ROLE] },
  '200000000000000002': { roles: [WATCH_COMMANDER_ROLE] },
  '200000000000000004': { roles: [DEATHWATCH_SECOND_ROLE] },
  '200000000000000005': { roles: [] },
  '200000000000000006': { roles: [ADMINISTRATOR_ROLE] },
  '200000000000000007': { roles: [DEATHWATCH_ROLE, DEATHWATCH_COMMAND_ROLE] },
  '200000000000000008': { roles: [DEATHWATCH_COMMAND_ROLE] },
}
// The Reliquarium curator role (GALLERY_CURATOR_ROLE_ID) and its holder, a Legion member. Kept out of MEMBERS for
// the same reason as the Deathwatch testers: a Legion member there would join the roster the other specs read.
const CURATOR_ROLE = '200000000000000301'
const GALLERY_MEMBERS = {
  '200000000000000302': { roles: [LEGION_ROLE, CURATOR_ROLE] },
}
// The layout spec's Techmarine: the Legion role and the Techmarine's, so the bar shows every member link and Version History. Like
// the Deathwatch testers, kept out of MEMBERS (the roster specs count that list) and answering the single-member lookup only.
const LAYOUT_MEMBERS = {
  '200000000000000510': { roles: [LEGION_ROLE, TECHMARINE_ROLE] },
}
// The Librarius reader role (the forum's overwrites let it in) and its two holders, neither a Legion member. Kept out of
// MEMBERS for the same reason as the Deathwatch testers. A Legion member such as test-member-token holds no reader role,
// so the forum is shut to them as it is to everyone else.
const READER_ROLE = '200000000000000401'
const LIBRARIUS_MEMBERS = {
  '200000000000000402': { roles: [READER_ROLE] },
  '200000000000000403': { roles: [READER_ROLE] },
  '200000000000000404': { roles: [READER_ROLE] },
  '200000000000000405': { roles: [READER_ROLE] },
  '200000000000000406': { roles: [READER_ROLE] },
  '200000000000000407': { roles: [READER_ROLE] },
}
// Guild membership as Discord's bot endpoint would report it.
const MEMBERS = {
  // Has a server nickname, so builds show it instead of the username.
  '300000000000000010': { roles: [LEGION_ROLE], nick: 'Brother Tester' },
  '300000000000000014': { roles: [] },
  '100000000000000002': { roles: [LEGION_ROLE, RECLUSIARCH_ROLE] },
  '100000000000000010': { roles: [LEGION_ROLE, TECHMARINE_ROLE] },
  '100000000000000011': { roles: [LEGION_ROLE, FORGE_ROLE] },
  '100000000000000020': { roles: [LEGION_ROLE, CAPTAIN_ROLE, THIRD_COMPANY_ROLE, THIRD_COMMAND_ROLE], nick: 'E2E Captain' },
  '100000000000000021': { roles: [LEGION_ROLE, SERGEANT_ROLE, THIRD_COMPANY_ROLE], nick: 'E2E Sergeant' },
  '100000000000000022': { roles: [LEGION_ROLE, INFIRMARY_ROLE, SCOUT_ROLE], nick: 'E2E Convalescent' },
  '100000000000000023': { roles: [INFIRMARY_ROLE], nick: 'E2E Recruit On Leave' },
  '100000000000000024': { roles: [LEGION_ROLE, SCOUT_ROLE, THIRD_COMPANY_ROLE], nick: 'E2E Leaver' },
  '100000000000000025': { roles: [LEGION_ROLE], nick: 'E2E Servitor', bot: true },
  '100000000000000026': { roles: [LEGION_ROLE, LORD_OF_DRAKES_ROLE], nick: 'E2E Lord' },
  // No role at all, so no roster or count can show them: the Deathwatch spec's delegate (test-granted-token).
  '200000000000000003': { roles: [], nick: 'E2E Delegate' },
}
// When every member joined, unless a rejoin (below) says otherwise: long before anything the specs give them.
const JOINED = '2025-01-01T00:00:00.000000+00:00'
// Who left by the leave hook, so the rejoin hook can bring them back as they were.
const LEFT = {}

// --- The Reliquarium: the clips channel, the CDN and R2, all in memory ---

// The same ids e2e/docker-compose.yml hands the api (GALLERY_CHANNEL_ID, R2_BUCKET).
const GALLERY_CHANNEL = '200000000000000300'
const R2_BUCKET = 'e2e-bucket'

// What an attachment can be: the files in ./fixtures, read once. clip.webm is the one a browser test plays
// (Playwright's open-source Chromium may not decode H.264); clip.mp4 is what the api spec checks byte for byte.
const FIXTURE_TYPES = { 'clip.mp4': 'video/mp4', 'clip.webm': 'video/webm', 'art.png': 'image/png' }
const FIXTURES = {}
for (const [name, type] of Object.entries(FIXTURE_TYPES)) {
  FIXTURES[name] = { type, bytes: new Uint8Array(await Bun.file(`${import.meta.dir}/fixtures/${name}`).arrayBuffer()) }
}

// Discord ids: milliseconds since Discord's epoch in the top bits, so a later message has a larger id. The
// counter keeps two ids made in the same millisecond apart and in order.
const DISCORD_EPOCH = 1420070400000n
let lastSnowflake = 0n
function snowflake() {
  let id = (BigInt(Date.now()) - DISCORD_EPOCH) << 22n
  if (id <= lastSnowflake) id = lastSnowflake + 1n
  lastSnowflake = id
  return String(id)
}

// The channel's messages, oldest first (ids only grow, so this is also id order).
const channel = []
function postMessage(user, content, names) {
  const message = {
    id: snowflake(),
    channel_id: GALLERY_CHANNEL,
    type: 0,
    content,
    timestamp: new Date().toISOString(),
    author: { id: user.id, username: user.username, global_name: null },
    attachments: names.map((name) => ({
      id: snowflake(),
      filename: name,
      size: FIXTURES[name].bytes.length,
      content_type: FIXTURES[name].type,
      url: `${SELF}/cdn/${name}`,
      proxy_url: `${SELF}/cdn/${name}`,
    })),
  }
  channel.push(message)
  return message
}
// Already in the channel when the api starts, so its first poll pass takes this as the newest message and
// stores nothing (e2e/tests/gallery-api.spec.js checks, by this title, that it never appears).
const PRE_LAUNCH_TITLE = 'E2E posted before launch'
postMessage(USERS['test-member-token'], PRE_LAUNCH_TITLE, ['clip.mp4'])

// Discord's answer to GET /channels/:id/messages for a channel whose messages are `list`, oldest first: at most `limit`
// (1 to 100, default 50), newest first. With `after`, the `limit` messages just after that id (the oldest ones past it),
// still newest first.
function messagesPage(list, params) {
  const limit = Math.min(Math.max(Number.parseInt(params.get('limit') ?? '50', 10) || 50, 1), 100)
  const after = params.get('after')
  if (after !== null && !/^\d{1,20}$/.test(after)) return null
  const picked = after === null ? list.slice(-limit) : list.filter((m) => BigInt(m.id) > BigInt(after)).slice(0, limit)
  return picked.reverse()
}

// R2: key → { type, bytes }. Nothing checks a signature; the mock only insists on the headers r2.js always sends.
const objects = new Map()
const s3Error = (status, code) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code></Error>`, {
    status,
    headers: { 'Content-Type': 'application/xml' },
  })

// One `bytes=` range of an object `total` bytes long → { start, end } (inclusive), 'unsatisfiable', or null to
// ignore the header and send the whole object (no header, several ranges, or one that does not parse).
function byteRange(header, total) {
  const m = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  if (m[1] === '') {
    const suffix = Number(m[2])
    return suffix === 0 || total === 0 ? 'unsatisfiable' : { start: Math.max(0, total - suffix), end: total - 1 }
  }
  const start = Number(m[1])
  const end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1)
  if (m[2] !== '' && Number(m[2]) < start) return null
  return start >= total ? 'unsatisfiable' : { start, end }
}

async function r2(request, key) {
  if (request.method === 'PUT') {
    const auth = request.headers.get('Authorization') || ''
    if (
      !auth.startsWith('AWS4-HMAC-SHA256 Credential=') ||
      request.headers.get('x-amz-content-sha256') !== 'UNSIGNED-PAYLOAD' ||
      !request.headers.get('x-amz-date')
    ) {
      return s3Error(403, 'AccessDenied')
    }
    // Real R2 refuses a chunked upload (no Content-Length), so the streamed copy must send the length it signed.
    const declared = request.headers.get('Content-Length')
    if (declared === null) return s3Error(411, 'MissingContentLength')
    const bytes = new Uint8Array(await request.arrayBuffer())
    if (Number(declared) !== bytes.length) return s3Error(400, 'IncompleteBody')
    objects.set(key, { type: request.headers.get('Content-Type') || 'application/octet-stream', bytes })
    return new Response(null, { status: 200, headers: { ETag: `"${Bun.hash(bytes).toString(16)}"` } })
  }
  // A DELETE, signed as r2.js signs one; real R2 answers 204 whether or not the object was there.
  if (request.method === 'DELETE') {
    const auth = request.headers.get('Authorization') || ''
    if (!auth.startsWith('AWS4-HMAC-SHA256 Credential=') || !request.headers.get('x-amz-date')) return s3Error(403, 'AccessDenied')
    objects.delete(key)
    return new Response(null, { status: 204 })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return s3Error(405, 'MethodNotAllowed')
  // A presigned GET: its X-Amz-* query is ignored.
  const object = objects.get(key)
  if (!object) return s3Error(404, 'NoSuchKey')
  const total = object.bytes.length
  const headers = { 'Content-Type': object.type, 'Accept-Ranges': 'bytes' }
  const range = byteRange(request.headers.get('Range'), total)
  if (range === 'unsatisfiable') {
    const refused = s3Error(416, 'InvalidRange')
    refused.headers.set('Content-Range', `bytes */${total}`)
    return refused
  }
  const body = range ? object.bytes.slice(range.start, range.end + 1) : object.bytes
  if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${total}`
  headers['Content-Length'] = String(body.length)
  return new Response(request.method === 'HEAD' ? null : body, { status: range ? 206 : 200, headers })
}

// --- The Librarius: the guild's forum, its posts and a live gateway, all in memory ---

// Invented ids, in the range the Librarius's fixtures use. e2e/docker-compose.yml hands the api the forum's
// (LIBRARIUS_CHANNEL_ID); the reader role and the two members are in the tables above. A post's id is fixed, and is the id of
// its opening message; every other message gets an id from snowflake(), as the clips channel's do.
const FORUM = '200000000000000400'
const SHUT_OUT_ID = '200000000000000403'
const ACTIVE_POST = '200000000000000410'
const ARCHIVED_POST = '200000000000000411'
// The posts the replies of the site go into (batch 2): one for the api spec, one for the browser's, and one that the specs lock.
// librarius-api.spec.js and librarius.spec.js never read them, so the replies change nothing those two count.
const WRITE_POST = '200000000000000412'
const COMPOSE_POST = '200000000000000413'
const LOCKED_POST = '200000000000000414'
const FORUM_TAG = '200000000000000420'
const CUSTOM_EMOJI = '200000000000000430'
// Two authors who are not in the guild's member list, so a page names them by the name their messages carry.
const SCRIBE_ID = '200000000000000440'
const ARCHIVIST_ID = '200000000000000441'
// The user the gateway's READY names: the bot the api connects as. Its application has the same id, as a bot's does in Discord.
const BOT_ID = '200000000000000499'
const BOT_USER = { id: BOT_ID, username: 'e2e-librarius-bot', bot: true }
// The token e2e/docker-compose.yml gives the api (DISCORD_BOT_TOKEN): the bot's own routes below ask for it.
const BOT_AUTHORIZATION = 'Bot unused-in-e2e'
const READER_COLOR = 0x3a5246
// What @everyone holds in the guild: View Channel, Send Messages, Read Message History, Send Messages in Threads and
// Add Reactions. The forum's overwrites then take View away from everyone but the reader role, which they also let attach files.
const EVERYONE_PERMISSIONS = '274877975616'
const VIEW_CHANNEL = String(1n << 10n)
const VIEW_AND_ATTACH = String((1n << 10n) | (1n << 15n))
// The Librarius's two seeded posts: how many messages the active one holds (its first is the post itself, as in Discord,
// where a forum post's id is the id of its opening message), and the numbered replies that are not plain text.
const ACTIVE_MESSAGES = 230
const ATTACHMENT_REPLY = 227
const EXPIRING_REPLY = 226
const QUOTING_REPLY = 228
const QUOTED_REPLY = 3
const SNOWFLAKE = /^\d{17,20}$/

const LIBRARIUS_PEOPLE = {
  [SCRIBE_ID]: { id: SCRIBE_ID, username: 'e2e-scribe', global_name: 'E2E Scribe' },
  [ARCHIVIST_ID]: { id: ARCHIVIST_ID, username: 'e2e-archivist', global_name: 'E2E Archivist' },
}

// The author object of a message: a test token's user, one of the two above, or an unknown id made up a name.
function authorOf(id) {
  const user = Object.values(USERS).find((u) => u.id === id)
  if (user) return { id, username: user.username, global_name: null }
  return LIBRARIUS_PEOPLE[id] ?? { id, username: `user-${id}`, global_name: null }
}

// post id → the thread as Discord describes it, and post id → its messages, oldest first.
const forumPosts = new Map()
const forumMessages = new Map()

function addPost({ id, title, archived, tags, createdAt, archivedAt }) {
  forumPosts.set(id, {
    id,
    type: 11,
    guild_id: GUILD_ID,
    parent_id: FORUM,
    owner_id: SCRIBE_ID,
    name: title,
    flags: 0,
    applied_tags: tags,
    thread_metadata: {
      archived,
      locked: false,
      auto_archive_duration: 10080,
      create_timestamp: createdAt.toISOString(),
      archive_timestamp: archivedAt.toISOString(),
    },
  })
  forumMessages.set(id, [])
}

/**
 * An attachment as Discord's CDN would have it, its signed link lapsing in two minutes: the api renews any link that lapses within
 * five when it reads one, asking /v10/attachments/refresh-urls, so this one is renewed the first time a reader sees it.
 */
function expiringCdnAttachment(filename) {
  const id = snowflake()
  const ex = Math.floor((Date.now() + 120_000) / 1000).toString(16)
  return {
    id,
    filename,
    size: FIXTURES['art.png'].bytes.length,
    content_type: FIXTURES['art.png'].type,
    url: `https://cdn.discordapp.com/attachments/200000000000000450/${id}/${filename}?ex=${ex}&is=e2e&hm=e2e`,
  }
}

/**
 * Stores a message in a post, as Discord would hold it, and → the message. A later one always has a larger id. An attachment is
 * the name of a file in ./fixtures, which is then at the mock's own address (not Discord's CDN, so the api must leave it out of
 * what it keeps), or an attachment made as Discord would.
 */
function storeForumMessage(postId, { id = snowflake(), authorId, content, replyTo = null, attachments = [], at = new Date() }) {
  const message = {
    id,
    channel_id: postId,
    type: replyTo === null ? 0 : 19,
    content,
    timestamp: at.toISOString(),
    edited_timestamp: null,
    author: authorOf(authorId),
    attachments: attachments.map((a) =>
      typeof a !== 'string'
        ? a
        : {
            id: snowflake(),
            filename: a,
            size: FIXTURES[a].bytes.length,
            content_type: FIXTURES[a].type,
            url: `${SELF}/cdn/${a}`,
            proxy_url: `${SELF}/cdn/${a}`,
          },
    ),
    embeds: [],
    reactions: [],
    ...(replyTo === null ? {} : { message_reference: { message_id: replyTo, channel_id: postId } }),
  }
  forumMessages.get(postId).push(message)
  return message
}

// The active post: 230 messages (its own, then 229 replies), a day or so old, one a minute. Reply 3 is quoted by reply 228,
// which is on the newest page while its target is far off it, reply 227 carries an attachment of the mock's own host (which the
// api leaves out) and reply 226 one of Discord's CDN whose link is about to lapse (which the api keeps, and renews).
{
  const MINUTE = 60_000
  const first = Date.now() - ACTIVE_MESSAGES * MINUTE
  addPost({
    id: ACTIVE_POST,
    title: 'E2E Active Post',
    archived: false,
    tags: [FORUM_TAG],
    createdAt: new Date(first),
    archivedAt: new Date(first),
  })
  const byNumber = []
  for (let n = 0; n < ACTIVE_MESSAGES; n++) {
    const at = new Date(first + n * MINUTE)
    const authorId = n % 2 === 0 ? SCRIBE_ID : ARCHIVIST_ID
    const made =
      n === 0
        ? { id: ACTIVE_POST, authorId, content: 'E2E opening message', at }
        : n === ATTACHMENT_REPLY
          ? { authorId, content: `E2E message ${n} with an attachment on the mock's own host`, attachments: ['art.png'], at }
          : n === EXPIRING_REPLY
            ? { authorId, content: `E2E message ${n} with an attachment on Discord's CDN`, attachments: [expiringCdnAttachment('e2e-expiring.png')], at }
            : n === QUOTING_REPLY
              ? { authorId, content: `E2E message ${n} quoting message ${QUOTED_REPLY}`, replyTo: byNumber[QUOTED_REPLY].id, at }
              : { authorId, content: `E2E message ${n}`, at }
    byNumber.push(storeForumMessage(ACTIVE_POST, made))
  }
  // The archived post: its own message and two replies, the last with a picture of Discord's CDN whose link is about to lapse, which
  // the topic list shows as the post's thumbnail (and renews).
  const archivedAt = new Date(Date.now() - 86_400_000)
  addPost({
    id: ARCHIVED_POST,
    title: 'E2E Archived Post',
    archived: true,
    tags: [],
    createdAt: new Date(archivedAt.getTime() - 3 * MINUTE),
    archivedAt,
  })
  storeForumMessage(ARCHIVED_POST, {
    id: ARCHIVED_POST,
    authorId: SCRIBE_ID,
    content: 'E2E archived opening message',
    at: new Date(archivedAt.getTime() - 3 * MINUTE),
  })
  for (const n of [1, 2]) {
    storeForumMessage(ARCHIVED_POST, {
      authorId: ARCHIVIST_ID,
      content: `E2E archived reply ${n}`,
      attachments: n === 2 ? [expiringCdnAttachment('e2e-thumbnail.png')] : [],
      at: new Date(archivedAt.getTime() - (3 - n) * MINUTE),
    })
  }
  // The three posts the site replies in, an hour old, each with its opening message; the api spec's has a reply written in Discord too.
  const hourAgo = new Date(Date.now() - 60 * MINUTE)
  for (const [id, title] of [
    [WRITE_POST, 'E2E Write Post'],
    [COMPOSE_POST, 'E2E Compose Post'],
    [LOCKED_POST, 'E2E Locked Post'],
  ]) {
    addPost({ id, title, archived: false, tags: [], createdAt: hourAgo, archivedAt: hourAgo })
    storeForumMessage(id, { id, authorId: SCRIBE_ID, content: `${title}: the opening message`, at: hourAgo })
  }
  storeForumMessage(WRITE_POST, { authorId: ARCHIVIST_ID, content: 'E2E Write Post: a reply written in Discord', at: new Date(hourAgo.getTime() + MINUTE) })
}

// The forum as Discord describes it to the bot: View Channel is denied to @everyone, given back to the reader role (with Attach
// Files, so the writers may send pictures), and denied to the shut-out member again, whatever their role says.
const FORUM_OBJECT = {
  id: FORUM,
  guild_id: GUILD_ID,
  type: 15,
  name: 'e2e-librarius',
  permission_overwrites: [
    { id: GUILD_ID, type: 0, allow: '0', deny: VIEW_CHANNEL },
    { id: READER_ROLE, type: 0, allow: VIEW_AND_ATTACH, deny: '0' },
    { id: SHUT_OUT_ID, type: 1, allow: '0', deny: VIEW_CHANNEL },
  ],
  available_tags: [{ id: FORUM_TAG, name: 'E2E Tag', moderated: false, emoji_id: null, emoji_name: null }],
}

// The links the api has asked to have signed again (POST /v10/attachments/refresh-urls), in the order asked.
const refreshesAsked = []

const GUILD_EMOJI = [{ id: CUSTOM_EMOJI, name: 'e2e_aquila', animated: false, available: true }]

// The posts of the forum that are archived (or not), as the threads endpoints list them: newest archive first.
const threadsWhere = (archived) =>
  [...forumPosts.values()]
    .filter((t) => t.thread_metadata.archived === archived)
    .sort((a, b) => Date.parse(b.thread_metadata.archive_timestamp) - Date.parse(a.thread_metadata.archive_timestamp))

// One page of GET /channels/:forum/threads/archived/public: `limit` threads archived before `before`, and whether more follow.
function archivedPage(params) {
  const limit = Math.min(Math.max(Number.parseInt(params.get('limit') ?? '50', 10) || 50, 1), 100)
  const before = params.get('before')
  if (before !== null && Number.isNaN(Date.parse(before))) return null
  const older = threadsWhere(true).filter((t) => before === null || Date.parse(t.thread_metadata.archive_timestamp) < Date.parse(before))
  return { threads: older.slice(0, limit), members: [], has_more: older.length > limit }
}

// A signed attachment link, asked to be signed again: the same address with an `ex` a day from now.
function refreshedLink(link) {
  try {
    const url = new URL(link)
    url.searchParams.set('ex', Math.floor((Date.now() + 86_400_000) / 1000).toString(16))
    return url.href
  } catch {
    return null
  }
}

function findForumMessage(id) {
  for (const [postId, list] of forumMessages) {
    const message = list.find((m) => m.id === id)
    if (message) return { postId, list, message }
  }
  return null
}

// --- The Librarius's replies from the site (batch 2): its webhook, the server's AutoMod rules and the "Delete on site" command ---

// The forum's webhooks, by id, as the bot that made them sees them (with their tokens). The one e2e/docker-compose.yml gives the api
// (LIBRARIUS_WEBHOOK_URL) is there from the start, as if the owner had run the setup (server/src/librariusWebhookSetupRun.js), which
// lists and makes them through the two routes below. An invented id and a throwaway token, for this mock only.
const WEBHOOK_ID = '200000000000000460'
const WEBHOOK_TOKEN = 'e2e-throwaway-webhook-token'
const webhooks = new Map()
function makeWebhook(id, token, name = 'Librarius') {
  const hook = { id, type: 1, guild_id: GUILD_ID, channel_id: FORUM, name, avatar: null, application_id: BOT_ID, token, user: BOT_USER }
  webhooks.set(id, hook)
  return hook
}
makeWebhook(WEBHOOK_ID, WEBHOOK_TOKEN)

// The server's AutoMod rules (GET /guilds/<id>/auto-moderation/rules): one keyword rule with an invented word, and one with a regular
// expression against links to an invented host. A webhook execute that holds the word is refused as Discord's AutoMod refuses a
// message, with code 200000; the site must refuse it first, so that the refusal is never reached.
const AUTOMOD_WORD = 'grimbleflax'
const AUTOMOD_RULES = [
  {
    id: '200000000000000470',
    guild_id: GUILD_ID,
    name: 'E2E Banned Word',
    creator_id: SCRIBE_ID,
    event_type: 1,
    trigger_type: 1,
    trigger_metadata: { keyword_filter: [AUTOMOD_WORD], regex_patterns: [], allow_list: [] },
    actions: [{ type: 1, metadata: {} }],
    enabled: true,
    exempt_roles: [],
    exempt_channels: [],
  },
  {
    id: '200000000000000471',
    guild_id: GUILD_ID,
    name: 'E2E Shady Links',
    creator_id: SCRIBE_ID,
    event_type: 1,
    trigger_type: 1,
    trigger_metadata: { keyword_filter: [], regex_patterns: [String.raw`https?://\S*e2e-shady\.invalid`], allow_list: [] },
    actions: [{ type: 1, metadata: {} }],
    enabled: true,
    exempt_roles: [],
    exempt_channels: [],
  },
]

// What reached the webhook, oldest first, for the specs to read (GET /__test/librarius/webhook): every message made (`executes`),
// every one refused (`refused`), every edit and every delete. Each says when it came (`at`, in ms) and the thread it was for.
const webhookLog = { executes: [], refused: [], edits: [], deletes: [] }
// What the bot did to the forum through its own token: the posts it archived or opened again, and the messages it deleted.
const botLog = { threadChanges: [], deletes: [] }

// The guild's application commands, by the application that made them (the bot's), and how many times one was made.
const commands = []
let commandsMade = 0
// The answers the api gave to interactions (POST /interactions/<id>/<token>/callback), oldest first.
const interactionAnswers = []
let interactions = 0

/** → whether the request carries the bot's token, as the bot's own routes need. */
const asBot = (request) => request.headers.get('Authorization') === BOT_AUTHORIZATION

/** The texts a message shows: its content, and the Text Displays of its components, at any depth. */
function textsOf(body) {
  const texts = typeof body?.content === 'string' ? [body.content] : []
  const walk = (list) => {
    for (const c of Array.isArray(list) ? list : []) {
      if (c?.type === 10 && typeof c.content === 'string') texts.push(c.content)
      walk(c?.components)
    }
  }
  walk(body?.components)
  return texts
}

const discordError = (status, code, message) => withCors(Response.json({ message, code }, { status }))

/**
 * The webhook a request names, by the id and token in its path: → the webhook, or the Response Discord gives for one it does not know
 * (404, Unknown Webhook) or a token that is not its (401, Invalid Webhook Token).
 */
function webhookOf(id, token) {
  const hook = webhooks.get(id)
  if (hook === undefined) return discordError(404, 10015, 'Unknown Webhook')
  if (hook.token !== token) return discordError(401, 50027, 'Invalid Webhook Token')
  return hook
}

/** → { body, files } of an execute, JSON or multipart (`payload_json` and `files[n]`), or null for a body that is neither. */
async function executeBody(request) {
  const type = request.headers.get('Content-Type') || ''
  if (type.startsWith('application/json')) return { body: await request.json().catch(() => null), files: [], multipart: false }
  if (!type.startsWith('multipart/form-data')) return null
  const form = await request.formData().catch(() => null)
  const payload = form?.get('payload_json')
  if (typeof payload !== 'string') return null
  const files = []
  for (const [field, value] of form.entries()) {
    if (!/^files\[\d+\]$/.test(field) || typeof value === 'string') continue
    files.push({ field, name: value.name, type: value.type, bytes: new Uint8Array(await value.arrayBuffer()) })
  }
  let body = null
  try {
    body = JSON.parse(payload)
  } catch {
    // no body: refused below
  }
  return { body, files, multipart: true }
}

/** An attachment of a message the webhook made: on Discord's CDN, as Discord would have it, with a link that lapses in a day. */
function webhookAttachment(threadId, file) {
  const id = snowflake()
  const ex = Math.floor((Date.now() + 86_400_000) / 1000).toString(16)
  return {
    id,
    filename: file.name,
    size: file.bytes.length,
    content_type: file.type,
    url: `https://cdn.discordapp.com/attachments/${threadId}/${id}/${file.name}?ex=${ex}&is=e2e&hm=e2e`,
    proxy_url: `https://media.discordapp.net/attachments/${threadId}/${id}/${file.name}?ex=${ex}&is=e2e&hm=e2e`,
  }
}

/** The thread a webhook call names in `thread_id`: → the post, or the Response Discord gives for it. */
function threadOf(url) {
  const threadId = url.searchParams.get('thread_id')
  const post = threadId === null ? undefined : forumPosts.get(threadId)
  if (post === undefined) return discordError(404, 10003, 'Unknown Channel')
  return post
}

/** POST /webhooks/<id>/<token>?wait=true&thread_id=&with_components=true: a message in a post, made as Discord makes one. */
async function executeWebhook(request, url, hook) {
  const post = threadOf(url)
  if (post instanceof Response) return post
  const read = await executeBody(request)
  const body = read?.body
  if (body === null || body === undefined || typeof body !== 'object') return discordError(400, 50109, 'The request body contains invalid JSON.')
  const at = Date.now()
  const refuse = (status, code, message) => {
    webhookLog.refused.push({ at, threadId: post.id, status, code, body })
    return discordError(status, code, message)
  }
  // A webhook that is not the application's own may send components only when it is asked to (with_components), and a post that is
  // archived or locked takes no message from it.
  if (Array.isArray(body.components) && url.searchParams.get('with_components') !== 'true') return refuse(400, 50035, 'Invalid Form Body')
  if (post.thread_metadata.locked) return refuse(403, 50001, 'Missing Access')
  if (post.thread_metadata.archived) return refuse(400, 50083, 'Thread is archived')
  if (textsOf(body).some((text) => text.toLowerCase().includes(AUTOMOD_WORD))) return refuse(400, 200000, 'Message was blocked by automatic moderation')

  const message = {
    id: snowflake(),
    channel_id: post.id,
    type: 0,
    content: typeof body.content === 'string' ? body.content : '',
    components: Array.isArray(body.components) ? body.components : [],
    flags: Number.isInteger(body.flags) ? body.flags : 0,
    timestamp: new Date(at).toISOString(),
    edited_timestamp: null,
    author: { id: hook.id, username: body.username ?? hook.name, avatar: null, global_name: null, bot: true },
    webhook_id: hook.id,
    application_id: hook.application_id,
    attachments: read.files.map((file) => webhookAttachment(post.id, file)),
    embeds: [],
    reactions: [],
    mentions: [],
  }
  forumMessages.get(post.id).push(message)
  webhookLog.executes.push({
    at,
    threadId: post.id,
    messageId: message.id,
    webhookId: hook.id,
    query: Object.fromEntries(url.searchParams),
    multipart: read.multipart,
    body,
    files: read.files.map(({ field, name, type, bytes }) => ({ field, name, type, base64: Buffer.from(bytes).toString('base64') })),
  })
  broadcast('MESSAGE_CREATE', { ...message, guild_id: GUILD_ID })
  if (url.searchParams.get('wait') !== 'true') return withCors(new Response(null, { status: 204 }))
  return withCors(Response.json(message))
}

/** PATCH and DELETE /webhooks/<id>/<token>/messages/<message>?thread_id=: an edit or a delete of a message this webhook made. */
async function webhookMessage(request, url, hook, messageId) {
  const post = threadOf(url)
  if (post instanceof Response) return post
  const list = forumMessages.get(post.id)
  const message = list.find((m) => m.id === messageId && m.webhook_id === hook.id)
  const at = Date.now()
  if (request.method === 'DELETE') {
    webhookLog.deletes.push({ at, threadId: post.id, messageId, found: message !== undefined })
    if (message === undefined) return discordError(404, 10008, 'Unknown Message')
    list.splice(list.indexOf(message), 1)
    broadcast('MESSAGE_DELETE', { id: messageId, channel_id: post.id, guild_id: GUILD_ID })
    return withCors(new Response(null, { status: 204 }))
  }
  const body = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') return discordError(400, 50109, 'The request body contains invalid JSON.')
  if (message === undefined) return discordError(404, 10008, 'Unknown Message')
  if (Array.isArray(body.components) && url.searchParams.get('with_components') !== 'true') return discordError(400, 50035, 'Invalid Form Body')
  webhookLog.edits.push({ at, threadId: post.id, messageId, body })
  if (typeof body.content === 'string') message.content = body.content
  if (Array.isArray(body.components)) message.components = body.components
  message.edited_timestamp = new Date(at).toISOString()
  broadcast('MESSAGE_UPDATE', { ...message, guild_id: GUILD_ID })
  return withCors(Response.json(message))
}

/** The webhook routes: → a Response, or null for a path that is none of them. */
async function webhookRoute(request, url) {
  const found = url.pathname.match(/^\/v10\/webhooks\/(\d+)\/([^/]+)(?:\/messages\/(\d+))?$/)
  if (found === null) return null
  const hook = webhookOf(found[1], found[2])
  if (hook instanceof Response) return hook
  if (found[3] === undefined && request.method === 'POST') return executeWebhook(request, url, hook)
  if (found[3] !== undefined && (request.method === 'PATCH' || request.method === 'DELETE')) return webhookMessage(request, url, hook, found[3])
  return discordError(405, 0, '405: Method Not Allowed')
}

/**
 * The bot's own calls for the replies, each with the bot's token (else 401): the forum's webhooks (list and make), a post archived or
 * opened again (PATCH /channels/<post>), a message deleted (DELETE /channels/<post>/messages/<id>), the server's AutoMod rules, and the
 * guild's commands (list and make). → a Response, or null for a path that is none of them.
 */
async function botRoute(request, url) {
  const { pathname } = url
  const method = request.method
  const hooksPath = pathname === `/v10/channels/${FORUM}/webhooks`
  const thread = pathname.match(/^\/v10\/channels\/(\d+)$/)
  const message = pathname.match(/^\/v10\/channels\/(\d+)\/messages\/(\d+)$/)
  const commandsPath = pathname === `/v10/applications/${BOT_ID}/guilds/${GUILD_ID}/commands`
  const ours =
    pathname === '/v10/users/@me' ||
    (hooksPath && (method === 'GET' || method === 'POST')) ||
    (thread && method === 'PATCH') ||
    (message && method === 'DELETE') ||
    (pathname === `/v10/guilds/${GUILD_ID}/auto-moderation/rules` && method === 'GET') ||
    (commandsPath && (method === 'GET' || method === 'POST'))
  if (!ours) return null
  if (!asBot(request)) return discordError(401, 0, '401: Unauthorized')

  if (pathname === '/v10/users/@me') return withCors(Response.json(BOT_USER))
  if (hooksPath && method === 'GET') return withCors(Response.json([...webhooks.values()]))
  if (hooksPath) {
    const body = await request.json().catch(() => null)
    if (typeof body?.name !== 'string' || body.name.length < 1 || body.name.length > 80) return discordError(400, 50035, 'Invalid Form Body')
    return withCors(Response.json(makeWebhook(snowflake(), `e2e-made-${crypto.randomUUID()}`, body.name)))
  }
  if (pathname.endsWith('/auto-moderation/rules')) return withCors(Response.json(AUTOMOD_RULES))
  if (commandsPath && method === 'GET') return withCors(Response.json(commands))
  if (commandsPath) {
    const body = await request.json().catch(() => null)
    if (typeof body?.name !== 'string' || body.type !== 3) return discordError(400, 50035, 'Invalid Form Body')
    commandsMade += 1
    const made = { id: snowflake(), application_id: BOT_ID, guild_id: GUILD_ID, name: body.name, type: body.type, version: snowflake() }
    commands.push(made)
    return withCors(Response.json(made, { status: 201 }))
  }
  if (thread) {
    const post = forumPosts.get(thread[1])
    if (post === undefined) return discordError(404, 10003, 'Unknown Channel')
    const body = await request.json().catch(() => null)
    if (typeof body?.archived !== 'boolean') return discordError(400, 50035, 'Invalid Form Body')
    botLog.threadChanges.push({ at: Date.now(), threadId: post.id, archived: body.archived })
    post.thread_metadata.archived = body.archived
    post.thread_metadata.archive_timestamp = new Date().toISOString()
    broadcast('THREAD_UPDATE', { ...post, guild_id: GUILD_ID })
    return withCors(Response.json(post))
  }
  // A message deleted by the bot, in a post.
  const list = forumMessages.get(message[1])
  if (list === undefined) return discordError(404, 10003, 'Unknown Channel')
  const at = list.findIndex((m) => m.id === message[2])
  botLog.deletes.push({ at: Date.now(), threadId: message[1], messageId: message[2], found: at !== -1 })
  if (at === -1) return discordError(404, 10008, 'Unknown Message')
  list.splice(at, 1)
  broadcast('MESSAGE_DELETE', { id: message[2], channel_id: message[1], guild_id: GUILD_ID })
  return withCors(new Response(null, { status: 204 }))
}

/** POST /interactions/<id>/<token>/callback: the api's answer to an interaction, kept for the specs to read. */
async function interactionCallback(request, url) {
  const found = url.pathname.match(/^\/v10\/interactions\/(\d+)\/([^/]+)\/callback$/)
  if (found === null || request.method !== 'POST') return null
  const body = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') return discordError(400, 50109, 'The request body contains invalid JSON.')
  // The interaction's token is its credential: an answer needs no Authorization, and the spec checks that the bot's was not sent.
  interactionAnswers.push({ at: Date.now(), id: found[1], token: found[2], authorized: request.headers.has('Authorization'), body })
  return withCors(new Response(null, { status: 204 }))
}

// --- The gateway: every connection of the api, and what is sent down them ---

// Until this time the gateway refuses a connection (the drop hook).
let gatewayDownUntil = 0
// How many times the gateway has been dropped (the drop hook): a spec that waits for a message to come down it can tell that a
// drop in the meantime was the reason the message did not.
let gatewayDrops = 0
// The intents of every IDENTIFY, in the order they came, and the one bit without which the gateway refuses it.
const identified = []
const MESSAGE_CONTENT_INTENT = 1 << 15
const sockets = new Set()
const send = (socket, frame) => socket.send(JSON.stringify(frame))
// Each socket numbers its own dispatches, from 1, as Discord's sequence does for a session.
function dispatchTo(socket, t, d) {
  socket.data.seq += 1
  send(socket, { op: 0, t, s: socket.data.seq, d })
}
// Only a socket that has been identified, or has resumed, hears of the forum.
function broadcast(t, d) {
  for (const socket of sockets) if (socket.data.ready) dispatchTo(socket, t, d)
}
const readySockets = () => [...sockets].filter((socket) => socket.data.ready).length

const gateway = {
  open(socket) {
    sockets.add(socket)
    send(socket, { op: 10, d: { heartbeat_interval: 1000 } })
  },
  message(socket, data) {
    let frame
    try {
      frame = JSON.parse(String(data))
    } catch {
      return
    }
    if (frame?.op === 1) {
      send(socket, { op: 11 })
    } else if (frame?.op === 2 || frame?.op === 6) {
      // An IDENTIFY without the Message Content intent is refused as Discord refuses an intent the bot has not been given, with 4014:
      // without it every message would come with no text. The intents of each IDENTIFY are kept for the specs.
      if (frame.op === 2) {
        const intents = frame.d?.intents
        identified.push(intents)
        if (!Number.isSafeInteger(intents) || (intents & MESSAGE_CONTENT_INTENT) === 0) {
          socket.close(4014, 'Disallowed intent(s).')
          return
        }
      }
      // A resume is answered with READY too, not Discord's RESUMED, so that the api catches up on what it missed. READY names the
      // application, which the api makes its "Delete on site" command for.
      socket.data.ready = true
      dispatchTo(socket, 'READY', {
        v: 10,
        session_id: crypto.randomUUID(),
        resume_gateway_url: `${SELF.replace(/^http/, 'ws')}/gateway`,
        user: BOT_USER,
        application: { id: BOT_ID, flags: 0 },
        guilds: [],
      })
    }
  },
  close(socket) {
    sockets.delete(socket)
  },
}

// The body of a hook that makes a message → { post, content, authorId, attachments } or null when it is not one.
function newMessage(body) {
  const names = body?.attachments ?? []
  const ok =
    body !== null &&
    typeof body === 'object' &&
    forumMessages.has(body.post) &&
    typeof body.content === 'string' &&
    typeof body.authorId === 'string' &&
    SNOWFLAKE.test(body.authorId) &&
    Array.isArray(names) &&
    names.every((n) => Object.hasOwn(FIXTURES, n))
  return ok ? { post: body.post, content: body.content, authorId: body.authorId, attachments: names } : null
}

const bad = (why) => withCors(Response.json({ error: why }, { status: 400 }))

// The Librarius's test hooks, which change the forum as Discord would and tell the gateway's listeners. → a Response, or null
// for a path that is none of them.
async function librariusHook(request, url) {
  const { pathname } = url
  if (!pathname.startsWith('/__test/librarius/')) return null

  if (pathname === '/__test/librarius/gateway' && request.method === 'GET') {
    return withCors(Response.json({ ready: readySockets(), drops: gatewayDrops, identified }))
  }
  // Every link the api has asked to have signed again, in the order asked.
  if (pathname === '/__test/librarius/refreshes' && request.method === 'GET') {
    return withCors(Response.json({ asked: refreshesAsked }))
  }
  // What reached the webhook, and what the bot did to the forum (see webhookLog and botLog).
  if (pathname === '/__test/librarius/webhook' && request.method === 'GET') return withCors(Response.json({ ...webhookLog, bot: botLog }))
  // The guild's commands, and how many times the api made one.
  if (pathname === '/__test/librarius/commands' && request.method === 'GET') return withCors(Response.json({ commands, made: commandsMade }))
  // The answers the api gave to interactions.
  if (pathname === '/__test/librarius/interactions' && request.method === 'GET') return withCors(Response.json({ answers: interactionAnswers }))
  if (request.method !== 'POST') return null
  const body = await request.json().catch(() => null)

  // A member picks "Delete on site" in the Apps menu of a message: INTERACTION_CREATE is sent down the gateway, as Discord sends a message
  // command of a bot whose application has no Interactions Endpoint URL. Body { targetId, userId }; → { id, token, heard }, `heard`
  // being how many of the api's connections it went to (none while the gateway is down: it is then lost, as it would be).
  if (pathname === '/__test/librarius/interaction') {
    const target = typeof body?.targetId === 'string' ? findForumMessage(body.targetId) : null
    if (typeof body?.targetId !== 'string' || typeof body.userId !== 'string' || !SNOWFLAKE.test(body.userId)) return bad('Need a targetId and a userId.')
    interactions += 1
    const command = commands.find((c) => c.name === 'Delete on site')
    const d = {
      id: snowflake(),
      application_id: BOT_ID,
      type: 2,
      token: `e2e-interaction-token-${interactions}`,
      version: 1,
      guild_id: GUILD_ID,
      channel_id: target?.postId ?? FORUM,
      member: { user: authorOf(body.userId), roles: LIBRARIUS_MEMBERS[body.userId]?.roles ?? [] },
      data: {
        id: command?.id ?? snowflake(),
        name: 'Delete on site',
        type: 3,
        target_id: body.targetId,
        resolved: target === null ? {} : { messages: { [body.targetId]: target.message } },
      },
    }
    const heard = readySockets()
    broadcast('INTERACTION_CREATE', d)
    return withCors(Response.json({ id: d.id, token: d.token, heard }))
  }

  // A post is locked in Discord (or opened again, with { locked: false }): stored, and THREAD_UPDATE sent.
  const lock = pathname.match(/^\/__test\/librarius\/lock\/(\d+)$/)
  if (lock) {
    const post = forumPosts.get(lock[1])
    if (post === undefined) return withCors(Response.json({ error: 'No such post.' }, { status: 404 }))
    post.thread_metadata.locked = body?.locked !== false
    broadcast('THREAD_UPDATE', { ...post, guild_id: GUILD_ID })
    return withCors(Response.json({ locked: post.thread_metadata.locked }))
  }

  // A message is posted in a post: stored, and MESSAGE_CREATE sent. `quiet-message` stores it and sends nothing: what a
  // gateway that was down never heard.
  if (pathname === '/__test/librarius/message' || pathname === '/__test/librarius/quiet-message') {
    const made = newMessage(body)
    if (made === null) return bad('Need a known post, content, an authorId, and attachments named from ./fixtures.')
    const message = storeForumMessage(made.post, made)
    if (pathname.endsWith('/message')) broadcast('MESSAGE_CREATE', { ...message, guild_id: GUILD_ID })
    return withCors(Response.json({ id: message.id }))
  }

  const edit = pathname.match(/^\/__test\/librarius\/edit\/(\d+)$/)
  if (edit) {
    const found = findForumMessage(edit[1])
    if (found === null) return withCors(Response.json({ error: 'No such message.' }, { status: 404 }))
    if (typeof body?.content !== 'string') return bad('Need content.')
    found.message.content = body.content
    found.message.edited_timestamp = new Date().toISOString()
    broadcast('MESSAGE_UPDATE', { ...found.message, guild_id: GUILD_ID })
    return withCors(Response.json({ edited: found.message.id }))
  }

  const remove = pathname.match(/^\/__test\/librarius\/delete\/(\d+)$/)
  if (remove) {
    const found = findForumMessage(remove[1])
    if (found === null) return withCors(Response.json({ error: 'No such message.' }, { status: 404 }))
    found.list.splice(found.list.indexOf(found.message), 1)
    broadcast('MESSAGE_DELETE', { id: found.message.id, channel_id: found.postId, guild_id: GUILD_ID })
    return withCors(Response.json({ deleted: found.message.id }))
  }

  const react = pathname.match(/^\/__test\/librarius\/react\/(\d+)$/)
  if (react) {
    const found = findForumMessage(react[1])
    if (found === null) return withCors(Response.json({ error: 'No such message.' }, { status: 404 }))
    // An emoji is its name (a unicode one) or { id, name } (a custom one), as Discord names it.
    const emoji = typeof body?.emoji === 'string' ? { id: null, name: body.emoji } : body?.emoji
    const valid =
      typeof emoji === 'object' &&
      emoji !== null &&
      typeof emoji.name === 'string' &&
      (emoji.id === undefined || emoji.id === null || (typeof emoji.id === 'string' && SNOWFLAKE.test(emoji.id))) &&
      typeof body.userId === 'string' &&
      SNOWFLAKE.test(body.userId)
    if (!valid) return bad('Need an emoji (a name, or { id, name }) and a userId.')
    const named = { id: emoji.id ?? null, name: emoji.name }
    const same = (r) => (named.id === null ? r.emoji.id === null && r.emoji.name === named.name : r.emoji.id === named.id)
    const held = found.message.reactions.find(same)
    const mine = body.userId === BOT_ID
    if (held) {
      held.count += 1
      held.me ||= mine
    } else {
      found.message.reactions.push({ emoji: named, count: 1, me: mine })
    }
    broadcast('MESSAGE_REACTION_ADD', {
      user_id: body.userId,
      channel_id: found.postId,
      message_id: found.message.id,
      guild_id: GUILD_ID,
      emoji: named,
    })
    return withCors(Response.json({ reacted: found.message.id }))
  }

  // The gateway goes down: every socket is closed with 4000, which a client may resume from, and none is let in for downMs.
  if (pathname === '/__test/librarius/drop') {
    const downMs = body?.downMs
    if (!Number.isSafeInteger(downMs) || downMs < 0) return bad('Need downMs, a whole number of milliseconds.')
    gatewayDownUntil = Date.now() + downMs
    gatewayDrops += 1
    const closing = [...sockets]
    sockets.clear()
    for (const socket of closing) socket.close(4000, 'e2e drop')
    return withCors(Response.json({ closed: closing.length }))
  }

  return null
}

// The browser calls this cross-origin (from wherever "web" is served), unlike
// the real discord.com/api which already sends permissive CORS headers for
// exactly this kind of client-side OAuth flow — this mock has to do the same.
function withCors(res) {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  return res
}

Bun.serve({
  port: PORT,
  async fetch(request, server) {
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }))

    const url = new URL(request.url)

    // The Librarius's live feed. The api asks for it at /gateway/?v=10&encoding=json. A client that is let in speaks the
    // gateway's protocol (see `gateway` above); during a drop (the hook) it is refused, as a gateway that is down would.
    if (url.pathname === '/gateway' || url.pathname === '/gateway/') {
      if (Date.now() < gatewayDownUntil) return new Response('The gateway is down.', { status: 503 })
      if (server.upgrade(request, { data: { seq: 0, ready: false } })) return undefined
      return new Response('Expected a WebSocket.', { status: 426 })
    }

    if (url.pathname === '/users/@me') {
      const auth = request.headers.get('Authorization') || ''
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
      const user = token && USERS[token]
      if (!user) {
        return withCors(Response.json({ message: '401: Unauthorized', code: 0 }, { status: 401 }))
      }
      return withCors(Response.json(user))
    }

    // Guild role table (Administrator checks, and the Librarius's reading of who may open the forum). Nobody is an admin
    // except the Deathwatch-area owner and Administrator testers; everyone else, the Legion testers included, is not.
    // @everyone (whose id is the guild's) may look and read, which the forum's overwrites then take away.
    if (url.pathname === `/v10/guilds/${GUILD_ID}`) {
      return withCors(
        Response.json({
          id: GUILD_ID,
          owner_id: GUILD_OWNER_ID,
          roles: [
            { id: GUILD_ID, name: '@everyone', color: 0, permissions: EVERYONE_PERMISSIONS },
            { id: RECLUSIARCH_ROLE, name: 'E2E Reclusiarch', color: 0, permissions: '0' },
            { id: ADMINISTRATOR_ROLE, name: 'E2E Administrator', color: 0, permissions: '8' },
            { id: READER_ROLE, name: 'E2E Reader', color: READER_COLOR, permissions: '0' },
          ],
        }),
      )
    }

    // Full member list (build authors' display names, see displayNames.js).
    if (url.pathname === `/v10/guilds/${GUILD_ID}/members`) {
      const byId = Object.fromEntries(Object.values(USERS).map((u) => [u.id, u]))
      const list = Object.entries(MEMBERS).map(([id, m]) => ({
        nick: m.nick ?? null,
        roles: m.roles,
        joined_at: m.joined_at ?? JOINED,
        user: { id, username: byId[id]?.username ?? `user-${id}`, global_name: null, ...(m.bot ? { bot: true } : {}) },
      }))
      return withCors(Response.json(list))
    }

    // Guild member lookups (mod-role, report-role and perk-privilege checks).
    // The Techmarine and Forge testers hold mod roles; nobody else does.
    const memberMatch = url.pathname.match(/^\/v10\/guilds\/[^/]+\/members\/([^/]+)$/)
    if (memberMatch) {
      const member = MEMBERS[memberMatch[1]] ??
        DEATHWATCH_MEMBERS[memberMatch[1]] ??
        GALLERY_MEMBERS[memberMatch[1]] ??
        LIBRARIUS_MEMBERS[memberMatch[1]] ??
        LAYOUT_MEMBERS[memberMatch[1]]
      return withCors(member ? Response.json({ joined_at: JOINED, ...member }) : Response.json({ message: 'Unknown Member' }, { status: 404 }))
    }

    // The wiki bake, standing in for raw.githubusercontent.com (BAKE_BASE_URL).
    const bakeMatch = url.pathname.match(/^\/bake\/(weapon-trees|perk-details)\.json$/)
    if (bakeMatch) return withCors(new Response(Bun.file(`/bake/${bakeMatch[1]}.json`), { headers: { 'Content-Type': 'application/json' } }))

    // Test hook: a member leaves the guild (the leaver spec).
    const leave = url.pathname.match(/^\/__test\/leave\/(\d+)$/)
    if (leave && request.method === 'POST') {
      LEFT[leave[1]] = MEMBERS[leave[1]]
      delete MEMBERS[leave[1]]
      return withCors(Response.json({ left: leave[1] }))
    }

    // Test hook: a member who left comes back, joining now (the Deathwatch spec: leaving ends what was given).
    const rejoin = url.pathname.match(/^\/__test\/rejoin\/(\d+)$/)
    if (rejoin && request.method === 'POST' && LEFT[rejoin[1]]) {
      MEMBERS[rejoin[1]] = { ...LEFT[rejoin[1]], joined_at: new Date().toISOString() }
      delete LEFT[rejoin[1]]
      return withCors(Response.json({ rejoined: rejoin[1] }))
    }

    // The channels the bot reads the messages of: the clips channel (server/src/galleryDiscord.js) and the Librarius's
    // posts (server/src/librariusDiscord.js). Any other channel is unknown.
    const channelMatch = url.pathname.match(/^\/v10\/channels\/(\d+)\/messages(?:\/(\d+))?$/)
    if (channelMatch && request.method === 'GET') {
      const list = channelMatch[1] === GALLERY_CHANNEL ? channel : forumMessages.get(channelMatch[1])
      if (list === undefined) return withCors(Response.json({ message: 'Unknown Channel', code: 10003 }, { status: 404 }))
      if (channelMatch[2] !== undefined) {
        const message = list.find((m) => m.id === channelMatch[2])
        return withCors(message ? Response.json(message) : Response.json({ message: 'Unknown Message', code: 10008 }, { status: 404 }))
      }
      const page = messagesPage(list, url.searchParams)
      return withCors(page ? Response.json(page) : Response.json({ message: 'Invalid Form Body', code: 50035 }, { status: 400 }))
    }

    // The Librarius, as the bot reads it: the forum itself, its threads and the guild's emoji.
    if (request.method === 'GET') {
      if (url.pathname === `/v10/channels/${FORUM}`) return withCors(Response.json(FORUM_OBJECT))
      // A post, read on its own: the thread as the lists give it, or Unknown Channel.
      const threadMatch = url.pathname.match(/^\/v10\/channels\/(\d+)$/)
      if (threadMatch) {
        const post = forumPosts.get(threadMatch[1])
        return post ? withCors(Response.json(post)) : discordError(404, 10003, 'Unknown Channel')
      }
      if (url.pathname === `/v10/guilds/${GUILD_ID}/threads/active`) {
        return withCors(Response.json({ threads: threadsWhere(false), members: [] }))
      }
      if (url.pathname === `/v10/channels/${FORUM}/threads/archived/public`) {
        const page = archivedPage(url.searchParams)
        return withCors(page ? Response.json(page) : Response.json({ message: 'Invalid Form Body', code: 50035 }, { status: 400 }))
      }
      if (url.pathname === `/v10/guilds/${GUILD_ID}/emojis`) return withCors(Response.json(GUILD_EMOJI))
      // Where to connect to the live feed, and how many sessions are left to start.
      if (url.pathname === '/v10/gateway/bot') {
        return withCors(
          Response.json({
            url: `${SELF.replace(/^http/, 'ws')}/gateway`,
            shards: 1,
            session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
          }),
        )
      }
    }

    // Asks Discord to sign attachment links again: each comes back with a later `ex`.
    if (url.pathname === '/v10/attachments/refresh-urls' && request.method === 'POST') {
      const body = await request.json().catch(() => null)
      if (!Array.isArray(body?.attachment_urls) || !body.attachment_urls.every((u) => typeof u === 'string')) {
        return withCors(Response.json({ message: 'Invalid Form Body', code: 50035 }, { status: 400 }))
      }
      refreshesAsked.push(...body.attachment_urls)
      const pairs = body.attachment_urls.flatMap((original) => {
        const refreshed = refreshedLink(original)
        return refreshed === null ? [] : [{ original, refreshed }]
      })
      return withCors(Response.json({ refreshed_urls: pairs }))
    }

    // Discord's CDN: an attachment's download link.
    const cdnMatch = url.pathname.match(/^\/cdn\/([^/]+)$/)
    if (cdnMatch && request.method === 'GET') {
      const file = Object.hasOwn(FIXTURES, cdnMatch[1]) ? FIXTURES[cdnMatch[1]] : null
      if (!file) return withCors(new Response('Not found', { status: 404 }))
      return withCors(new Response(file.bytes, { headers: { 'Content-Type': file.type, 'Content-Length': String(file.bytes.length) } }))
    }

    // R2, path-style: /<bucket>/<key>. The browser loads these links too (a <video> or <img> src), hence the CORS.
    if (url.pathname.startsWith(`/${R2_BUCKET}/`)) return withCors(await r2(request, url.pathname.slice(R2_BUCKET.length + 2)))

    // Test hook: someone posts in the clips channel. Body { token, content, attachments: ['clip.mp4', ...] } → { id }.
    if (url.pathname === '/__test/channel/post' && request.method === 'POST') {
      const body = await request.json().catch(() => null)
      const user = body && USERS[body.token]
      const names = Array.isArray(body?.attachments) ? body.attachments : []
      if (!user || typeof body.content !== 'string' || !names.every((n) => Object.hasOwn(FIXTURES, n))) {
        return withCors(Response.json({ error: 'Need a known token, content, and attachments named from ./fixtures.' }, { status: 400 }))
      }
      return withCors(Response.json({ id: postMessage(user, body.content, names).id }))
    }

    // Test hook: a clips channel message is deleted in Discord. → { deleted: whether it was there }.
    const deleteMatch = url.pathname.match(/^\/__test\/channel\/delete\/(\d+)$/)
    if (deleteMatch && request.method === 'POST') {
      const at = channel.findIndex((m) => m.id === deleteMatch[1])
      if (at !== -1) channel.splice(at, 1)
      return withCors(Response.json({ deleted: at !== -1 }))
    }

    // The replies from the site: the webhook, the bot's calls for them, and the answers to interactions.
    const replied = (await webhookRoute(request, url)) ?? (await botRoute(request, url)) ?? (await interactionCallback(request, url))
    if (replied) return replied

    const hooked = await librariusHook(request, url)
    if (hooked) return hooked

    return withCors(new Response('Not found', { status: 404 }))
  },
  websocket: gateway,
})

console.log(`Discord mock listening on :${PORT}`)
