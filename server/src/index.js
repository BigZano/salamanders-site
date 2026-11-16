/**
 * Shared builds API. builds routes here; reports, perks and moderation live
 * in their own modules.
 *
 * The client never gets to say who it is — every mutating request carries a
 * Discord access token (the same implicit-grant token src/lib/discordAuth.js
 * already gets), and this server calls Discord's own /users/@me with it to
 * find out who's actually asking. That's what makes delete permissions real
 * instead of "whoever knows the id can delete it": a poster can only delete
 * their own build, and a moderator (see privileges.js) can delete anyone's,
 * both checked against Discord directly, not trusted from the request body.
 */
import { Pool } from 'pg'
import { createArchiveKeyHandler } from './archiveKey.js'
import { createBakeLoader, DEFAULT_BAKE_BASE_URL } from './bake.js'
import { rowToBuild, publicBuild } from './buildRow.js'
import { createBuildModeration } from './buildModeration.js'
import { createBuildsView } from './buildsView.js'
import { validateBuildText } from './buildText.js'
import { createCompanyNotablesHandler } from './companyNotablesHandler.js'
import { createCompanyNotablesStore } from './companyNotablesStore.js'
import { applyCors } from './cors.js'
import { createDeathwatchAccess } from './deathwatchAccess.js'
import { createDeathwatchHandler } from './deathwatchHandler.js'
import { createDeathwatchStore } from './deathwatchStore.js'
import { createDiscordRoles } from './discordRoles.js'
import { createDisplayNames } from './displayNames.js'
import { createGalleryAccess } from './galleryAccess.js'
import { CHANNEL_ID, galleryConfigReport, pollIntervalMs } from './galleryConfig.js'
import { createGalleryDiscord } from './galleryDiscord.js'
import { createGalleryHandler } from './galleryHandler.js'
import { createGalleryPoll } from './galleryPoll.js'
import { createGalleryStore } from './galleryStore.js'
import { createHistoryStore } from './historyStore.js'
import { createLibrariusAccess } from './librariusAccess.js'
import { librariusConfig } from './librariusConfig.js'
import { createLibrariusDiscord } from './librariusDiscord.js'
import { createGateway } from './librariusGateway.js'
import { createLibrariusGuild } from './librariusGuild.js'
import { createLibrariusHandler } from './librariusHandler.js'
import { createImport } from './librariusImport.js'
import { createIngest } from './librariusIngest.js'
import { createLinkRefresh } from './librariusLinks.js'
import { createLibrariusStore } from './librariusStore.js'
import { describe as describeFailure } from './librariusText.js'
import { createMembership } from './membership.js'
import { createMembershipHandler } from './membershipHandler.js'
import { createPerksHandler } from './perks.js'
import { createPrivileges } from './privileges.js'
import { createReportsHandler } from './reports.js'
import { createRoster } from './roster.js'
import { createAdminCheck } from './deathwatchAdmins.js'
import { LEGION_ROLE } from './rosterLadder.js'
import { createRosterHandler } from './rosterHandler.js'
import { createRosterPublicHandler } from './rosterPublicHandler.js'
import { createReportsStore } from './reportsStore.js'
import { createR2 } from './r2.js'
import { CAPTAIN, LEGION_HIERARCHY_ROLE } from './rosterLadder.js'
import { createNotifier } from './webhook.js'

const PORT = Number(process.env.PORT || 8787)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173'
const GUILD_ID = process.env.DISCORD_GUILD_ID
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN
// Overridable so E2E runs can point both identity checks at a local fixture
// instead of the real Discord API — see e2e/discord-mock.
const DISCORD_API_BASE = process.env.DISCORD_API_BASE || 'https://discord.com/api'

/** What a log may say of a failure: its name and message, with the bot token and every link cut out, in 200 characters. */
const describeForLog = (err) => describeFailure(err, { secret: BOT_TOKEN })

// A rejection nobody waited for, or an exception nobody caught, must not take the whole API down: Bun exits on either
// unless something is listening. Both are logged the way every other failure is (no token, no link) and never thrown
// again, and the log line itself is guarded, since a handler that throws ends the process all the same.
function logUnhandled(kind, err) {
  try {
    console.error(`${kind}: ${describeForLog(err)}`)
  } catch {
    // The log is gone (a closed stderr, say): there is nowhere left to say it.
  }
}
process.on('unhandledRejection', (reason) => logUnhandled('Unhandled rejection', reason))
process.on('uncaughtException', (err) => logUnhandled('Uncaught exception', err))

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const roles = createDiscordRoles({ apiBase: DISCORD_API_BASE, guildId: GUILD_ID, botToken: BOT_TOKEN })
// GET /membership: is the caller a guild member? Answered live from Discord
// against the member role — see membership.js and membershipHandler.js.
const membership = createMembership({ roles, roleId: process.env.ARCHIVE_ROLE_ID })
const membershipRoutes = createMembershipHandler({ membership })
// GET /company-notables: the Companies page's notable members (real names), guild members only — see
// companyNotablesHandler.js. They are stored in the database and filled by src/seedNotables.js.
const companyNotablesRoutes = createCompanyNotablesHandler({ membership, store: createCompanyNotablesStore(pool) })
// Legion Archive key: fail-closed, gated on the same live membership check
// (the member role, asked of Discord on every call). See archiveKey.js.
const archiveKey = createArchiveKeyHandler({ membership, archiveKey: process.env.ARCHIVE_KEY })
// Build authors are shown by Discord display name, from an in-memory
// directory of the guild — see displayNames.js. The same directory knows who
// holds the member role, so the builds list can flag members.
const displayNames = createDisplayNames({
  apiBase: DISCORD_API_BASE,
  guildId: GUILD_ID,
  botToken: BOT_TOKEN,
  memberRoleId: process.env.ARCHIVE_ROLE_ID,
  ttlMs: 5 * 60_000,
})
// GET /builds: names for everyone, the member flag only for a signed-in viewer — see buildsView.js.
const buildsView = createBuildsView({ roles, displayNames })

// The Legion roster and Infirmary list — see roster.js and rosterHandler.js.
// Its own guild-member cache, never written to disk.
const roster = createRoster({
  apiBase: DISCORD_API_BASE,
  guildId: GUILD_ID,
  botToken: BOT_TOKEN,
  ttlMs: Number(process.env.ROSTER_TTL_MS) || undefined,
})
const rosterRoutes = createRosterHandler({ roles, roster })
// Public and unauthenticated: the same cache, projected to leaders by name and everyone else as counts.
const rosterPublicRoutes = createRosterPublicHandler({ roster })

// Member reports — see reports.js. Role ids default to XVIIILegion (files)
// and Reclusiarch (reviews); the webhook pings leadership with an id only.
const reports = createReportsHandler({
  roles,
  store: createReportsStore(pool),
  reporterRoleId: process.env.REPORTER_ROLE_ID || '1377787723976409211',
  reviewerRoleId: process.env.RECLUSIARCH_ROLE_ID || '1323334632904855592',
  webhookUrl: process.env.REPORTS_WEBHOOK_URL || null,
  siteUrl: ALLOWED_ORIGIN,
})

// The Deathwatch area — see deathwatchHandler.js. Its two role ids have no
// defaults: until both are set in the environment every route answers 503.
// DEATHWATCH_ROLE_ID is Deathwatch Deployment. The Deathwatch Command, Emissary and award role ids are
// optional: unset, nobody holds that standing (deathwatchAccess.js).
const deathwatchStore = createDeathwatchStore(pool)
const deathwatch = createDeathwatchHandler({
  access: createDeathwatchAccess({
    roles,
    store: deathwatchStore,
    // The guild's admins, read once every five minutes: they see the Administratum, read only.
    admins: createAdminCheck({ roles }),
    deathwatchRoleId: process.env.DEATHWATCH_ROLE_ID,
    commanderRoleId: process.env.WATCH_COMMANDER_ROLE_ID,
    deathwatchCommandRoleId: process.env.DEATHWATCH_COMMAND_ROLE_ID,
    legionRoleId: LEGION_ROLE,
    emissaryRoleId: process.env.EMISSARY_ROLE_ID,
    xenosbaneRoleId: process.env.XENOSBANE_SIGIL_ROLE_ID,
    vigiliaRoleId: process.env.VIGILIA_MORTIS_ROLE_ID,
    killMarineRoleId: process.env.KILL_MARINE_ROLE_ID,
  }),
  store: deathwatchStore,
  // The Deployment list: members holding DEATHWATCH_ROLE_ID, from the roster's cache (no extra Discord calls).
  roster,
  // Access → add: whether the person is in the guild, and since when, asked live.
  memberOf: (id) => roles.memberOf(id),
  deploymentRoleIds: (process.env.DEATHWATCH_ROLE_ID || '').split(',').filter(Boolean),
  // The faces: Legion and Emissary members the Event Tracker names, for their pictures there.
  faceRoleIds: [LEGION_ROLE, process.env.EMISSARY_ROLE_ID].filter(Boolean),
})

// The Reliquarium, members-only art and clips galleries — see galleryHandler.js. Until the clips channel
// and all four R2 values are set, every /gallery route answers 503 and the clips poll does not start.
// R2_ENDPOINT is for the e2e stack's mock only; an empty one must not replace Cloudflare's.
const r2 = createR2({
  accountId: process.env.R2_ACCOUNT_ID,
  bucket: process.env.R2_BUCKET,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  endpoint: process.env.R2_ENDPOINT || undefined,
})
const galleryStore = createGalleryStore(pool)
const GALLERY_CHANNEL_ID = process.env.GALLERY_CHANNEL_ID || ''
const galleryConfigured = r2.configured && CHANNEL_ID.test(GALLERY_CHANNEL_ID)
// Some gallery variables set but not a working gallery: say which, by name only, so the 503s are not a mystery.
const galleryReport = galleryConfigReport(process.env)
if (galleryReport) console.warn(galleryReport)
// Not created unconfigured (its constructor refuses bad options); the Review tab then shows no runs.
let galleryPoll = { status: async () => ({ lastRunAt: null, lastOkAt: null, lastError: null }) }
if (galleryConfigured) {
  galleryPoll = createGalleryPoll({
    discord: createGalleryDiscord({ apiBase: DISCORD_API_BASE, botToken: BOT_TOKEN }),
    r2,
    store: galleryStore,
    channelId: GALLERY_CHANNEL_ID,
    // At least a second and at most setInterval's ceiling; unset or not above 0, two minutes (galleryConfig.js).
    intervalMs: pollIntervalMs(process.env),
  })
  galleryPoll.start()
}
const gallery = createGalleryHandler({
  access: createGalleryAccess({
    roles,
    memberRoleId: process.env.REPORTER_ROLE_ID || '1377787723976409211',
    // The curator role is optional: unset, nobody is curator and the other approver roles still work.
    approverRoleIds: [
      process.env.RECLUSIARCH_ROLE_ID || '1323334632904855592',
      CAPTAIN.id,
      LEGION_HIERARCHY_ROLE,
      process.env.GALLERY_CURATOR_ROLE_ID,
    ],
  }),
  store: galleryStore,
  r2,
  poll: galleryPoll,
  displayNames,
  configured: galleryConfigured,
})

// The Librarius, the guild's Discord forum read on the site — see librariusHandler.js. It is on only when the forum id
// is a channel id AND the guild id and bot token are set: otherwise every /librarius route answers 503, and nothing of
// it starts (no gateway connection, no timer, no import). Its roster is the one above.
const librarius = librariusConfig(process.env)
const librariusConfigured = librarius.configured && Boolean(GUILD_ID) && Boolean(BOT_TOKEN)
if (librarius.report) console.warn(librarius.report)
else if (librarius.configured && !librariusConfigured) {
  console.warn(
    'Librarius is not configured, so every /librarius route answers 503 and the gateway stays off: DISCORD_GUILD_ID and DISCORD_BOT_TOKEN are both needed.',
  )
}

/** Do one startup step, and log it when it fails: nothing a step throws may reach the server. */
async function librariusStep(what, run) {
  try {
    await run()
  } catch (err) {
    console.error(`Librarius: ${what}: ${describeForLog(err)}`)
  }
}

// What stays when the Librarius is off, or when building it failed: a handler that answers 503 and touches nothing.
let librariusRoutes = createLibrariusHandler({ roster, guildId: GUILD_ID, forumId: null, configured: false })
let startLibrarius = async () => {}
if (librariusConfigured) {
  try {
    const discord = createLibrariusDiscord({ apiBase: DISCORD_API_BASE, botToken: BOT_TOKEN, guildId: GUILD_ID })
    const guild = createLibrariusGuild({ discord, forumId: librarius.forumId })
    const access = createLibrariusAccess({ roles, guild, guildId: GUILD_ID })
    const store = createLibrariusStore(pool)
    // The import may queue for Discord longer than a reader's request may: it is given a view of the REST client that
    // waits up to a minute for its turn. Everything else keeps the five seconds.
    const importer = createImport({
      discord: discord.withMaxWait(60_000),
      store,
      forumId: librarius.forumId,
      // Once the posts are listed, before the long read of their messages: the live feed takes in the posts it has just
      // been told of. `ingest` is made below, and is only called once the import runs.
      onPostsListed: () => ingest.load(),
    })
    const links = createLinkRefresh({ discord, store })
    const ingest = createIngest({
      store,
      guild,
      access,
      forumId: librarius.forumId,
      fetchMessage: discord.message,
      // The gateway's READY starts the catch-up: the same run as the one at boot, if that is still going.
      onReady: () => importer.run(),
    })
    const gateway = createGateway({ discord, botToken: BOT_TOKEN, onDispatch: ingest.dispatch })
    librariusRoutes = createLibrariusHandler({
      access,
      store,
      guild,
      links,
      importer,
      roster,
      guildId: GUILD_ID,
      forumId: librarius.forumId,
      configured: true,
    })
    // Run once the server is listening, and in this order: the posts it listens to, the import (not waited for: it can
    // take minutes), the import's timer (its first run is the one just started), the link timer, the gateway. A step
    // that fails is logged and the rest go on: the catch-up that follows READY loads the posts again, so a failed load
    // only delays the live feed, and the import's timer tries a failed import again.
    startLibrarius = async () => {
      // The roster supplies the names and avatars on a page: warm it now (not waited for), so that a reader's first
      // request does not wait on it.
      librariusStep('the roster could not be warmed', () => roster.current())
      await librariusStep('the posts could not be loaded', () => ingest.load())
      librariusStep('the import could not start', () => importer.run())
      await librariusStep('the import timer could not start', () => importer.start())
      await librariusStep('the link refresh could not start', () => links.start())
      await librariusStep('the gateway could not start', () => gateway.start())
    }
  } catch (err) {
    console.error(`Librarius: could not be set up, so every /librarius route answers 503: ${describeForLog(err)}`)
  }
}

// Perk corrections, version history, privilege revocation — see perks.js.
// The webhook is the reports one: leadership watches a single channel.
const history = createHistoryStore(pool)
const privileges = createPrivileges({ roles, store: history })
const notify = createNotifier({ url: process.env.REPORTS_WEBHOOK_URL || null, suffix: ` · ${ALLOWED_ORIGIN}/history` })
const perks = createPerksHandler({
  roles,
  privileges,
  store: history,
  notify,
  loadBake: createBakeLoader({
    baseUrl: process.env.BAKE_BASE_URL || DEFAULT_BAKE_BASE_URL,
  }),
})
const moderation = createBuildModeration({ roles, privileges, store: history, notify })

function cors(res) {
  return applyCors(res, ALLOWED_ORIGIN)
}

function json(body, status = 200, headers = {}) {
  return cors(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } }),
  )
}

/** Who is this, really? Never trust an id the client hands us directly. */
async function verifyCaller(request) {
  const auth = request.headers.get('Authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return null
  const res = await fetch(`${DISCORD_API_BASE}/users/@me`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  const user = await res.json()
  return { id: user.id, username: user.username }
}

async function listBuilds(request) {
  const url = new URL(request.url)
  const className = url.searchParams.get('class')
  const { rows } = className
    ? await pool.query('select * from builds where deleted_at is null and class_name = $1 order by created_at desc', [className])
    : await pool.query('select * from builds where deleted_at is null order by created_at desc')
  const { nameFor, isMember, headers } = await buildsView.view(request)
  return json(
    rows.map((r) => publicBuild(rowToBuild(r), nameFor, isMember)),
    200,
    headers,
  )
}

async function createBuild(request) {
  const caller = await verifyCaller(request)
  if (!caller) return json({ error: 'Sign in with Discord to save a build.' }, 401)

  const b = await request.json().catch(() => null)
  if (!b || typeof b.title !== 'string' || typeof b.className !== 'string') {
    return json({ error: 'Malformed build.' }, 400)
  }

  const text = validateBuildText(b)
  if (typeof text === 'string') return json({ error: text }, 400)

  const { rows } = await pool.query(
    `insert into builds
       (title, role, notes, class_name, level, prestige, prestige_picks,
        perks, perk_ids, justifications, weapons, weapon_perks,
        author_discord_id, author_discord_username)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     returning *`,
    [
      text.title,
      text.role,
      text.notes,
      text.className,
      text.level,
      text.prestige,
      JSON.stringify(text.prestigePicks),
      JSON.stringify(text.perks),
      JSON.stringify(text.perkIds),
      JSON.stringify(text.justifications),
      JSON.stringify(text.weapons),
      JSON.stringify(text.weaponPerks),
      caller.id,
      caller.username,
    ],
  )
  return json(publicBuild(rowToBuild(rows[0]), await displayNames.resolver()), 201)
}

Bun.serve({
  port: PORT,
  // Bun's default is 128 MB. The largest legitimate body is a Reliquarium art upload (a 10 MB file plus its
  // form fields); this refuses anything bigger (a chunked body included) before a handler reads it into memory.
  maxRequestBodySize: 12 * 1024 * 1024,
  async fetch(request) {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }))

    const url = new URL(request.url)
    const idMatch = url.pathname.match(/^\/builds\/(\d+)$/)

    try {
      const reportsRes = await reports(request, url)
      if (reportsRes) return cors(reportsRes)
      const deathwatchRes = await deathwatch(request, url)
      if (deathwatchRes) return cors(deathwatchRes)
      const galleryRes = await gallery(request, url)
      if (galleryRes) return cors(galleryRes)
      const librariusRes = await librariusRoutes(request, url)
      if (librariusRes) return cors(librariusRes)
      const perksRes = await perks(request, url)
      if (perksRes) return cors(perksRes)
      const rosterPublicRes = await rosterPublicRoutes(request, url)
      if (rosterPublicRes) return cors(rosterPublicRes)
      const rosterRes = await rosterRoutes(request, url)
      if (rosterRes) return cors(rosterRes)
      const membershipRes = await membershipRoutes(request, url)
      if (membershipRes) return cors(membershipRes)
      const companyNotablesRes = await companyNotablesRoutes(request, url)
      if (companyNotablesRes) return cors(companyNotablesRes)
      if (url.pathname === '/health') return json({ ok: true })
      if (url.pathname === '/archive/key' && request.method === 'GET') return cors(await archiveKey(request))
      if (url.pathname === '/builds/moderator' && request.method === 'GET') return cors(await moderation.status(request))
      if (url.pathname === '/builds' && request.method === 'GET') return await listBuilds(request)
      if (url.pathname === '/builds' && request.method === 'POST') return await createBuild(request)
      if (idMatch && request.method === 'DELETE') return cors(await moderation.remove(request, idMatch[1]))
      return json({ error: 'Not found.' }, 404)
    } catch (err) {
      console.error(err)
      return json({ error: 'Internal error.' }, 500)
    }
  },
})

console.log(`Builds API listening on :${PORT}`)

// Not waited for, and after Bun.serve: a slow database or a failing step must never keep the server from listening.
startLibrarius().catch((err) => console.error(`Librarius: startup failed: ${describeForLog(err)}`))
