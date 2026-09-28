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
import { createBakeLoader } from './bake.js'
import { rowToBuild } from './buildRow.js'
import { createBuildModeration } from './buildModeration.js'
import { validateBuildText } from './buildText.js'
import { createDiscordRoles } from './discordRoles.js'
import { createHistoryStore } from './historyStore.js'
import { createPerksHandler } from './perks.js'
import { createPrivileges } from './privileges.js'
import { createReportsHandler } from './reports.js'
import { createReportsStore } from './reportsStore.js'
import { createNotifier } from './webhook.js'

const PORT = Number(process.env.PORT || 8787)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173'
const GUILD_ID = process.env.DISCORD_GUILD_ID
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN
// Overridable so E2E runs can point both identity checks at a local fixture
// instead of the real Discord API — see e2e/discord-mock.
const DISCORD_API_BASE = process.env.DISCORD_API_BASE || 'https://discord.com/api'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// Legion Archive key: fail-closed, gated on the same synced member list that
// ranks builds (src/data/discord-members.json on main). See archiveKey.js.
const archiveKey = createArchiveKeyHandler({
  discordApiBase: DISCORD_API_BASE,
  guildId: GUILD_ID,
  roleId: process.env.ARCHIVE_ROLE_ID,
  membersUrl:
    process.env.ARCHIVE_MEMBERS_URL ||
    'https://raw.githubusercontent.com/BigZano/salamanders-site/main/src/data/discord-members.json',
  archiveKey: process.env.ARCHIVE_KEY,
})

const roles = createDiscordRoles({ apiBase: DISCORD_API_BASE, guildId: GUILD_ID, botToken: BOT_TOKEN })

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
    baseUrl: process.env.BAKE_BASE_URL || 'https://raw.githubusercontent.com/BigZano/salamanders-site/main/src/data/',
  }),
})
const moderation = createBuildModeration({ roles, privileges, store: history, notify })

function cors(res) {
  res.headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  return res
}

function json(body, status = 200) {
  return cors(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
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
  return json(rows.map(rowToBuild))
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
      b.className,
      Number(b.level) || 1,
      Number(b.prestige) || 0,
      JSON.stringify(b.prestigePicks || []),
      JSON.stringify(b.perks || []),
      JSON.stringify(b.perkIds || {}),
      JSON.stringify(b.justifications || {}),
      JSON.stringify(b.weapons || {}),
      JSON.stringify(b.weaponPerks || {}),
      caller.id,
      caller.username,
    ],
  )
  return json(rowToBuild(rows[0]), 201)
}

Bun.serve({
  port: PORT,
  async fetch(request) {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }))

    const url = new URL(request.url)
    const idMatch = url.pathname.match(/^\/builds\/(\d+)$/)

    try {
      const reportsRes = await reports(request, url)
      if (reportsRes) return cors(reportsRes)
      const perksRes = await perks(request, url)
      if (perksRes) return cors(perksRes)
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
