/**
 * GET /roster and GET /roster/infirmary. The caller's identity and roles are
 * checked live against Discord on every request (discordRoles.js), and every
 * uncertain path fails closed. A caller who is refused never reaches the
 * roster cache here. The public route (rosterPublicHandler.js) reads the same
 * cache without signing in; the cache runs one sweep at a time, at most one
 * per TTL (per retry interval after a failed load), however many callers ask,
 * so that adds no Discord load beyond what the members' page already causes.
 * Responses are never cached.
 */
import { Upstream } from './discordRoles.js'
import { commandTier } from './rosterCore.js'
import { LEGION_ROLE } from './rosterLadder.js'

const reply = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

export function createRosterHandler({ roles, roster }) {
  return async function handle(request, url) {
    const { pathname } = url
    if (request.method !== 'GET' || (pathname !== '/roster' && pathname !== '/roster/infirmary')) return null
    try {
      const user = await roles.identify(request)
      if (!user) return reply(401, { error: 'Sign in with Discord.' })
      const held = await roles.rolesOf(user.id)
      if (!held || !held.includes(LEGION_ROLE)) return reply(403, { error: 'The roster is open to the XVIIIth Legion.' })
      const command = commandTier(held)
      if (pathname === '/roster/infirmary' && !command) {
        return reply(403, { error: 'The Infirmary list is open to company command and above.' })
      }
      const snap = await roster.current()
      if (!snap) return reply(503, { error: 'The roster is not available yet. Try again.' })
      if (pathname === '/roster') {
        return reply(200, { fetchedAt: snap.fetchedAt, stale: snap.stale, viewer: { infirmary: command }, ...snap.roster })
      }
      return reply(200, { fetchedAt: snap.fetchedAt, stale: snap.stale, count: snap.infirmary.length, members: snap.infirmary })
    } catch (err) {
      if (err instanceof Upstream) return reply(503, { error: 'Discord could not be reached. Try again.' })
      throw err
    }
  }
}
