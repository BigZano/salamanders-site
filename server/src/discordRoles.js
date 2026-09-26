/**
 * Live Discord identity and role lookups, shared by builds (moderator delete)
 * and reports. Answers come straight from Discord on every call — never from
 * the 8-hourly discord-members.json bake — so a role granted or removed takes
 * effect immediately.
 *
 * identify()  → {id, username} | null (no/invalid token). Throws Upstream.
 * rolesOf()   → role id[] | null (not in the guild). Throws Upstream.
 * isAdmin()   → guild owner, or a held role (incl. @everyone) grants
 *               Administrator. Throws Upstream.
 * Upstream = Discord unreachable, misconfigured, or answering oddly; callers
 * fail closed on it.
 */
const TOKEN = /^Bearer ([A-Za-z0-9._~+/-]{1,512}=*)$/
const SNOWFLAKE = /^\d{17,20}$/
const ADMINISTRATOR = 0x8n

export class Upstream extends Error {}

export function createDiscordRoles({ fetchImpl = fetch, apiBase, guildId, botToken, timeoutMs = 5000 }) {
  const configured = [apiBase, guildId, botToken].every((v) => typeof v === 'string' && v !== '')

  async function get(path, authorization) {
    if (!configured) throw new Upstream('Discord lookups are not configured.')
    const res = await fetchImpl(`${apiBase}${path}`, {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const bot = (path) => get(path, `Bot ${botToken}`)

  async function identify(request) {
    const m = TOKEN.exec(request.headers.get('Authorization'))
    if (!m) return null
    const me = await get('/users/@me', `Bearer ${m[1]}`)
    if (me.status === 401 || me.status === 403) return null
    if (me.status !== 200 || !SNOWFLAKE.test(String(me.body?.id))) throw new Upstream()
    return { id: me.body.id, username: String(me.body.username || me.body.id) }
  }

  async function rolesOf(userId) {
    const member = await bot(`/v10/guilds/${guildId}/members/${userId}`)
    if (member.status === 404) return null
    if (member.status !== 200 || !Array.isArray(member.body?.roles)) throw new Upstream()
    return member.body.roles
  }

  async function isAdmin(userId, roles) {
    const guild = await bot(`/v10/guilds/${guildId}`)
    if (guild.status !== 200 || !Array.isArray(guild.body?.roles)) throw new Upstream()
    if (guild.body.owner_id === userId) return true
    // @everyone's role id is the guild id; its permissions apply to everyone.
    const held = new Set([...(roles || []), guildId])
    const perms = (r) => BigInt(/^\d{1,40}$/.test(r.permissions) ? r.permissions : 0)
    return guild.body.roles.some((r) => held.has(r.id) && (perms(r) & ADMINISTRATOR) === ADMINISTRATOR)
  }

  return { identify, rolesOf, isAdmin }
}
