/**
 * Shared builds API. Small enough to stay one file: five routes, one table.
 *
 * The client never gets to say who it is — every mutating request carries a
 * Discord access token (the same implicit-grant token src/lib/discordAuth.js
 * already gets), and this server calls Discord's own /users/@me with it to
 * find out who's actually asking. That's what makes delete permissions real
 * instead of "whoever knows the id can delete it": a poster can only delete
 * their own build, and a moderator (Administrator permission, or one of the
 * MOD_ROLE_IDS below) can delete anyone's, both checked against Discord
 * directly, not trusted from the request body.
 */
import { Pool } from 'pg'
import { createArchiveKeyHandler } from './archiveKey.js'
import { createDiscordRoles } from './discordRoles.js'
import { createReportsHandler } from './reports.js'
import { createReportsStore } from './reportsStore.js'

const PORT = Number(process.env.PORT || 8787)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173'
const GUILD_ID = process.env.DISCORD_GUILD_ID
// Roles whose holders may delete any build. Defaults to Master of the Forge
// and Mechadendrite Expert — builds are their domain. DISCORD_MOD_ROLE_ID
// (comma-separated) overrides; an empty value keeps the defaults.
const MOD_ROLE_IDS = (process.env.DISCORD_MOD_ROLE_ID || '1322056087867883565,1362522277677240521')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
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

/**
 * Can this Discord user moderate builds? True for a holder of any
 * MOD_ROLE_IDS role, or an Administrator (see discordRoles.js). Any lookup
 * failure means no — deletion falls back to poster-only.
 */
async function isModerator(discordUserId) {
  try {
    const held = await roles.rolesOf(discordUserId)
    if (!held) return false
    if (held.some((r) => MOD_ROLE_IDS.includes(r))) return true
    return await roles.isAdmin(discordUserId, held)
  } catch {
    return false
  }
}

/** Lets the UI decide whether to offer delete on other people's builds. */
async function moderatorStatus(request) {
  const caller = await verifyCaller(request)
  return json({ moderator: caller ? await isModerator(caller.id) : false })
}

const rowToBuild = (r) => ({
  id: r.id,
  title: r.title,
  role: r.role,
  notes: r.notes,
  className: r.class_name,
  level: r.level,
  prestige: r.prestige,
  prestigePicks: r.prestige_picks,
  perks: r.perks,
  perkIds: r.perk_ids,
  justifications: r.justifications,
  weapons: r.weapons,
  weaponPerks: r.weapon_perks,
  author: { id: r.author_discord_id, username: r.author_discord_username },
  createdAt: r.created_at,
})

async function listBuilds(request) {
  const url = new URL(request.url)
  const className = url.searchParams.get('class')
  const { rows } = className
    ? await pool.query('select * from builds where class_name = $1 order by created_at desc', [className])
    : await pool.query('select * from builds order by created_at desc')
  return json(rows.map(rowToBuild))
}

async function createBuild(request) {
  const caller = await verifyCaller(request)
  if (!caller) return json({ error: 'Sign in with Discord to save a build.' }, 401)

  const b = await request.json().catch(() => null)
  if (!b || typeof b.title !== 'string' || typeof b.className !== 'string') {
    return json({ error: 'Malformed build.' }, 400)
  }

  const { rows } = await pool.query(
    `insert into builds
       (title, role, notes, class_name, level, prestige, prestige_picks,
        perks, perk_ids, justifications, weapons, weapon_perks,
        author_discord_id, author_discord_username)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     returning *`,
    [
      String(b.title || '').slice(0, 200),
      String(b.role || '').slice(0, 200),
      String(b.notes || '').slice(0, 2000),
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

async function deleteBuild(request, id) {
  const caller = await verifyCaller(request)
  if (!caller) return json({ error: 'Sign in with Discord to delete a build.' }, 401)

  const { rows } = await pool.query('select author_discord_id from builds where id = $1', [id])
  if (!rows.length) return json({ error: 'Not found.' }, 404)

  const isOwner = rows[0].author_discord_id === caller.id
  if (!isOwner && !(await isModerator(caller.id))) {
    return json({ error: 'Only the poster or a moderator can delete this build.' }, 403)
  }

  await pool.query('delete from builds where id = $1', [id])
  return cors(new Response(null, { status: 204 }))
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
      if (url.pathname === '/health') return json({ ok: true })
      if (url.pathname === '/archive/key' && request.method === 'GET') return cors(await archiveKey(request))
      if (url.pathname === '/builds/moderator' && request.method === 'GET') return await moderatorStatus(request)
      if (url.pathname === '/builds' && request.method === 'GET') return await listBuilds(request)
      if (url.pathname === '/builds' && request.method === 'POST') return await createBuild(request)
      if (idMatch && request.method === 'DELETE') return await deleteBuild(request, idMatch[1])
      return json({ error: 'Not found.' }, 404)
    } catch (err) {
      console.error(err)
      return json({ error: 'Internal error.' }, 500)
    }
  },
})

console.log(`Builds API listening on :${PORT}`)
