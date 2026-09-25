/**
 * GET /archive/key — hands the Legion Archive key only to a caller whose
 * Discord token is valid *and* who is on the XVIIIth Legion member list:
 * the same discord-members.json (synced from Discord by the
 * discord-members.yml workflow) that ranks builds for signed-in members.
 * Every uncertain path fails closed (401/403/503), never the key.
 * Pure: config and fetch are injected so it's testable under Node.
 */
const KEY_B64 = /^[A-Za-z0-9+/]{43}=$/
const TOKEN = /^Bearer ([A-Za-z0-9._~+/-]{1,512}=*)$/
const SNOWFLAKE = /^\d{17,20}$/

class Upstream extends Error {}

export function createArchiveKeyHandler({
  fetchImpl = fetch,
  discordApiBase,
  guildId,
  roleId,
  membersUrl,
  archiveKey,
  timeoutMs = 5000,
  cacheMs = 5 * 60_000,
  now = Date.now,
}) {
  const configured = [discordApiBase, guildId, roleId, membersUrl].every((v) => typeof v === 'string' && v !== '') &&
    typeof archiveKey === 'string' && KEY_B64.test(archiveKey)
  const kid = configured ? kidOf(archiveKey) : null
  let cache = null // { at, ids } — only successful fetches are cached

  // Network errors and timeouts reject here and land in handle()'s catch → 503.
  async function get(url, headers) {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    // Stryker disable next-line ArrowFunction: null vs undefined body — both fail the shape checks identically
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  async function members() {
    if (cache && now() - cache.at < cacheMs) return cache.ids
    const list = await get(membersUrl, {})
    const b = list.body
    // Stryker disable next-line OptionalChaining: a null body throws inside handle()'s try, reaching the same 503
    if (list.status !== 200 || b?.guildId !== guildId || b.roleId !== roleId || !Array.isArray(b.memberIds)) throw new Upstream()
    cache = { at: now(), ids: new Set(b.memberIds) }
    return cache.ids
  }

  return async function handle(request) {
    if (!configured) return reply(503, { error: 'Archive unavailable.' })
    const m = TOKEN.exec(request.headers.get('Authorization')) // exec(null) tests "null": no match
    if (!m) return reply(401, { error: 'Sign in with Discord.' })
    try {
      const me = await get(`${discordApiBase}/users/@me`, { Authorization: `Bearer ${m[1]}` })
      if (me.status === 401 || me.status === 403) return reply(401, { error: 'Sign in with Discord.' })
      // Stryker disable next-line OptionalChaining: a null body throws inside this try, reaching the same 503
      if (me.status !== 200 || !SNOWFLAKE.test(String(me.body?.id))) throw new Upstream()
      if (!(await members()).has(me.body.id)) return reply(403, { error: 'Restricted to the XVIIIth Legion.' })
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
