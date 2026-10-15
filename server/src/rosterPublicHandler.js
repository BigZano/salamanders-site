/**
 * GET /roster/public: the public projection of the order of battle (see
 * rosterPublic.js). No sign-in and no Authorization header is read: this route
 * answers the same for everyone. It only ever reads the roster cache, which
 * refreshes at most once per TTL however many requests arrive, so anonymous
 * traffic cannot make more Discord calls than the members' page does.
 * The full roster stays behind rosterHandler.js.
 */
import { publicRoster } from './rosterPublic.js'

const reply = (status, body, cache) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache },
  })

export function createRosterPublicHandler({ roster, project = publicRoster }) {
  // The projection depends only on the snapshot's roster object, which the
  // roster module replaces wholesale on each refresh.
  const projected = new WeakMap()
  const projection = (r) => {
    if (!projected.has(r)) projected.set(r, project(r))
    return projected.get(r)
  }

  return async function handle(request, url) {
    if (request.method !== 'GET' || url.pathname !== '/roster/public') return null
    const snap = await roster.current()
    if (!snap) return reply(503, { error: 'The roster is not available yet. Try again.' }, 'no-store')
    return reply(200, { fetchedAt: snap.fetchedAt, stale: snap.stale, ...projection(snap.roster) }, 'public, max-age=60')
  }
}
