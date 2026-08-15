/**
 * Shared builds API. Small enough to stay one file: four routes, one table.
 *
 * The client never gets to say who it is — every mutating request carries a
 * Discord access token (the same implicit-grant token src/lib/discordAuth.js
 * already gets), and this server calls Discord's own /users/@me with it to
 * find out who's actually asking. That's what makes delete permissions real
 * instead of "whoever knows the id can delete it": a poster can only delete
 * their own build, and a moderator role (once DISCORD_MOD_ROLE_ID is set)
 * can delete anyone's, both checked against Discord directly, not trusted
 * from the request body.
 */
import { Pool } from 'pg'

const PORT = Number(process.env.PORT || 8787)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173'
const GUILD_ID = process.env.DISCORD_GUILD_ID
// Unset until a role is actually designated — see the delete handler below.
// Not an error state: "no mod role yet" just means only the poster can delete.
const MOD_ROLE_ID = process.env.DISCORD_MOD_ROLE_ID || null
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

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
  const res = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  const user = await res.json()
  return { id: user.id, username: user.username }
}

/** Does this Discord user currently hold the designated moderator role? */
async function hasModRole(discordUserId) {
  if (!MOD_ROLE_ID || !GUILD_ID || !BOT_TOKEN) return false
  const res = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${discordUserId}`, {
    headers: { Authorization: `Bot ${BOT_TOKEN}` },
  })
  if (!res.ok) return false
  const member = await res.json()
  return Array.isArray(member.roles) && member.roles.includes(MOD_ROLE_ID)
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
  if (!isOwner && !(await hasModRole(caller.id))) {
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
      if (url.pathname === '/health') return json({ ok: true })
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
