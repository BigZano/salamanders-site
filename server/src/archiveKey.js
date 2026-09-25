/**
 * GET /archive/key — hands the Legion Archive key only to a caller whose
 * Discord token is valid *and* who holds ARCHIVE_ROLE_ID in the guild right
 * now. Every uncertain path fails closed (401/403/503), never the key.
 * Pure: config and fetch are injected so it's testable under Node.
 */
const KEY_B64 = /^[A-Za-z0-9+/]{43}=$/
const TOKEN = /^Bearer ([A-Za-z0-9._~+/-]{1,512}=*)$/
const SNOWFLAKE = /^\d{17,20}$/

class Upstream extends Error {}

export function createArchiveKeyHandler({ fetchImpl = fetch, discordApiBase, guildId, roleId, botToken, archiveKey, timeoutMs = 5000 }) {
  const configured = [discordApiBase, guildId, roleId, botToken].every((v) => typeof v === 'string' && v !== '') &&
    typeof archiveKey === 'string' && KEY_B64.test(archiveKey)
  const kid = configured ? kidOf(archiveKey) : null

  // Network errors and timeouts reject here and land in handle()'s catch → 503.
  async function get(url, auth) {
    const res = await fetchImpl(url, { headers: { Authorization: auth }, signal: AbortSignal.timeout(timeoutMs) })
    // Stryker disable next-line ArrowFunction: null vs undefined body — both fail the id/roles checks identically
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  return async function handle(request) {
    if (!configured) return reply(503, { error: 'Archive unavailable.' })
    const m = TOKEN.exec(request.headers.get('Authorization')) // exec(null) tests "null": no match
    if (!m) return reply(401, { error: 'Sign in with Discord.' })
    try {
      const me = await get(`${discordApiBase}/users/@me`, `Bearer ${m[1]}`)
      if (me.status === 401 || me.status === 403) return reply(401, { error: 'Sign in with Discord.' })
      // Stryker disable next-line OptionalChaining: a null body throws inside this try, reaching the same 503
      if (me.status !== 200 || !SNOWFLAKE.test(String(me.body?.id))) throw new Upstream()
      const member = await get(`${discordApiBase}/v10/guilds/${guildId}/members/${me.body.id}`, `Bot ${botToken}`)
      if (member.status === 404) return reply(403, { error: 'Restricted to the XVIIIth Legion.' })
      // Stryker disable next-line OptionalChaining: a null body throws inside this try, reaching the same 503
      if (member.status !== 200 || !Array.isArray(member.body?.roles)) throw new Upstream()
      if (!member.body.roles.includes(roleId)) return reply(403, { error: 'Restricted to the XVIIIth Legion.' })
      return reply(200, { key: archiveKey, kid: await kid })
    } catch {
      return reply(503, { error: 'Discord could not be reached. Try again.' })
    }
  }
}

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

async function kidOf(b64) {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}
