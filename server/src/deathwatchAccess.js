/**
 * Who may use the Deathwatch area, asked of Discord live (discordRoles.js) and
 * of the grants table. Access is the Watch Commander role, any one of the
 * Deathwatch roles, an active grant, or being the guild owner or an
 * Administrator (discordRoles.isAdmin). Watch Commander status comes only from
 * the Commander role, never from a grant and never from being an administrator.
 * Someone who is not in the guild holds no roles, and can still have a grant.
 * Any Discord failure throws Upstream: callers fail closed.
 *
 * Reads may reuse a verdict for a short while, keyed by a hash of the whole
 * Authorization header, so a polling page does not cost two Discord calls per
 * viewer per poll. `fresh` skips the cache entirely (writes and grant changes),
 * and forget() empties it (a grant changed, so nobody should keep a stale verdict).
 * Only successful lookups are cached: not a missing identity, not a failure.
 */
import { createHash } from 'node:crypto'

const SNOWFLAKE = /^\d{17,20}$/
const isSnowflake = (v) => typeof v === 'string' && SNOWFLAKE.test(v)

// The Deathwatch roles come as one comma-separated string (no spaces). A list with any bad item, or nothing, is
// [] so that it opens nothing: half a list is never used.
function parseRoleIds(value) {
  if (typeof value !== 'string') return []
  const ids = value.split(',')
  return ids.every(isSnowflake) ? ids : []
}

export function createDeathwatchAccess({
  roles,
  store,
  deathwatchRoleId,
  commanderRoleId,
  ttlMs = 30_000,
  maxEntries = 1000,
  now = Date.now,
}) {
  // No defaults for the ids: until both are set the handler answers 503.
  const deathwatchRoleIds = parseRoleIds(deathwatchRoleId)
  const configured = deathwatchRoleIds.length > 0 && isSnowflake(commanderRoleId)
  const cache = new Map() // sha256 of the Authorization header -> { verdict, until }
  // Replaced by forget(). A lookup that began under an earlier epoch may be telling a story forget() has
  // since made false (a grant revoked mid-lookup), so its verdict is returned but not remembered.
  let epoch = {}

  async function lookup(request) {
    const user = await roles.identify(request)
    if (!user) return null
    // Stryker disable next-line ArrayDeclaration: a stray element is never a role id, so it grants nothing
    const held = (await roles.rolesOf(user.id)) ?? []
    const watchCommander = held.includes(commanderRoleId)
    // Cheapest first: the guild lookup is only made for someone nothing else admits.
    const access =
      watchCommander ||
      deathwatchRoleIds.some((id) => held.includes(id)) ||
      (await store.isGranted(user.id)) ||
      (await roles.isAdmin(user.id, held))
    return { user, access, watchCommander }
  }

  function remember(key, verdict) {
    if (!cache.has(key) && cache.size >= maxEntries) cache.delete(cache.keys().next().value)
    cache.set(key, { verdict, until: now() + ttlMs })
  }

  /** → { user, access, watchCommander }, or null when there is no valid Discord identity. */
  async function resolve(request, { fresh = false } = {}) {
    const header = request.headers.get('Authorization')
    if (fresh || !header) return lookup(request)
    const key = createHash('sha256').update(header).digest('hex')
    const hit = cache.get(key)
    if (hit && now() < hit.until) return hit.verdict
    const began = epoch
    const verdict = await lookup(request)
    if (verdict && began === epoch) remember(key, verdict)
    return verdict
  }

  function forget() {
    cache.clear()
    epoch = {}
  }

  return { configured, resolve, forget }
}
