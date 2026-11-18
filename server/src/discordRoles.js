/**
 * Live Discord identity and role lookups, shared by builds (moderator delete)
 * and reports. Answers come straight from Discord on every call, so a role
 * granted or removed takes effect immediately.
 *
 * identify()  → {id, username} | null (no/invalid token). Throws Upstream.
 * rolesOf()   → role id[] | null (not in the guild). Throws Upstream.
 * memberOf()  → { roles, joinedAt, timeoutUntil, pending } | null: the same lookup, with when the present membership began (or null),
 *               until when the member is timed out (`communication_disabled_until`, as Discord's ISO time; null for none) and
 *               whether they are still in Membership Screening (`pending`, true or false: only Discord's own true is true).
 *               When Discord answers 429 it is Upstream like any other failure, and for as long as Discord says to wait
 *               (Retry-After, a second when it says nothing usable, a minute at most) memberOf makes no call at all and is
 *               Upstream at once, so that a burst of members does not make Discord's invalid-request count (which bans an
 *               address) climb. Only memberOf waits: no other lookup here does.
 * guildAdmins() → { ownerId, adminRoleIds, everyoneAdmin }: whom the guild makes an admin. Throws Upstream.
 * isAdmin()   → guild owner, or a held role (incl. @everyone) grants
 *               Administrator. Throws Upstream.
 * Upstream = Discord unreachable, misconfigured, or answering oddly; callers
 * fail closed on it.
 */
const TOKEN = /^Bearer ([A-Za-z0-9._~+/-]{1,512}=*)$/
const SNOWFLAKE = /^\d{17,20}$/
const ADMINISTRATOR = 0x8n
// How long Discord is not asked again for a member after a 429 that says nothing usable, and the longest it is not asked.
const DEFAULT_WAIT_S = 1
const MAX_WAIT_S = 60
// A role's permissions as a bigint; anything that is not digits is none.
const perms = (r) => BigInt(/^\d{1,40}$/.test(r.permissions) ? r.permissions : 0)
const carriesAdmin = (r) => (perms(r) & ADMINISTRATOR) === ADMINISTRATOR
// The wait a Retry-After header asks for, in ms: seconds, possibly fractional; a missing or odd one is a second, and no wait is past a minute.
const waitMs = (header) => {
  const s = Number.parseFloat(header)
  return Math.min(Number.isFinite(s) && s >= 0 ? s : DEFAULT_WAIT_S, MAX_WAIT_S) * 1000
}

export class Upstream extends Error {}

export function createDiscordRoles({ fetchImpl = fetch, apiBase, guildId, botToken, timeoutMs = 5000, now = Date.now }) {
  const configured = [apiBase, guildId, botToken].every((v) => typeof v === 'string' && v !== '')

  async function get(path, authorization) {
    if (!configured) throw new Upstream('Discord lookups are not configured.')
    try {
      const res = await fetchImpl(`${apiBase}${path}`, {
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(timeoutMs),
      })
      return { status: res.status, retryAfter: res.headers.get('Retry-After'), body: await res.json().catch(() => null) }
    } catch {
      // Network error, abort or timeout. Drop the original: its message can carry the request url, and with it a user id.
      throw new Upstream('Discord is unreachable.')
    }
  }
  const bot = (path) => get(path, `Bot ${botToken}`)

  async function identify(request) {
    const m = TOKEN.exec(request.headers.get('Authorization'))
    if (!m) return null
    const me = await get('/users/@me', `Bearer ${m[1]}`)
    if (me.status === 401 || me.status === 403) return null
    // A string only: JavaScript rounds an 18-digit JSON number, and the digits left would name someone else.
    if (me.status !== 200 || typeof me.body?.id !== 'string' || !SNOWFLAKE.test(me.body.id)) throw new Upstream()
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
    return guild.body.roles.some((r) => held.has(r.id) && carriesAdmin(r))
  }

  // When Discord lets memberOf ask again after a 429, on the clock `now` reads.
  let heldUntil = 0

  async function memberOf(userId) {
    if (now() < heldUntil) throw new Upstream('Discord asked for a wait.')
    const member = await bot(`/v10/guilds/${guildId}/members/${userId}`)
    if (member.status === 429) {
      heldUntil = now() + waitMs(member.retryAfter)
      throw new Upstream()
    }
    if (member.status === 404) return null
    if (member.status !== 200 || !Array.isArray(member.body?.roles)) throw new Upstream()
    const until = member.body.communication_disabled_until
    return {
      roles: member.body.roles,
      joinedAt: typeof member.body.joined_at === 'string' ? member.body.joined_at : null,
      // A time Discord gave, or none: a value that is no time is no timeout, since Discord only sends a time or null.
      timeoutUntil: typeof until === 'string' && !Number.isNaN(Date.parse(until)) ? until : null,
      pending: member.body.pending === true,
    }
  }

  async function guildAdmins() {
    const guild = await bot(`/v10/guilds/${guildId}`)
    if (guild.status !== 200 || !Array.isArray(guild.body?.roles)) throw new Upstream()
    const roles = guild.body.roles.filter((r) => typeof r?.id === 'string')
    return {
      ownerId: typeof guild.body.owner_id === 'string' ? guild.body.owner_id : null,
      adminRoleIds: roles.filter((r) => r.id !== guildId && carriesAdmin(r)).map((r) => r.id),
      // @everyone's role id is the guild id; its permissions apply to everyone.
      everyoneAdmin: roles.some((r) => r.id === guildId && carriesAdmin(r)),
    }
  }

  return { identify, rolesOf, isAdmin, memberOf, guildAdmins }
}
