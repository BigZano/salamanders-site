/**
 * GET /company-notables: the Companies page's Notable Server Members (real names and write-ups), for signed-in
 * guild members only. Who is asking is checked live against Discord on every call (membership.js), and every
 * uncertain path fails closed: a caller who is not exactly a member never reaches the store.
 *
 *   200 { companies: { companyId: [[name, ...lines], ...] } }   a member; empty when nothing is stored
 *   401                                                         no or invalid token
 *   403                                                         signed in, not a guild member
 *   503                                                         Discord could not answer, whatever the cause
 * Every answer is private and no-store: it names members, so it must never sit in a shared cache. A store failure
 * is not caught here; the server's catch-all logs it and answers 500.
 */

const reply = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  })

export function createCompanyNotablesHandler({ membership, store }) {
  return async function handle(request, url) {
    if (request.method !== 'GET' || url.pathname !== '/company-notables') return null
    let caller
    try {
      caller = await membership.check(request)
    } catch {
      return reply(503, { error: 'Discord could not be reached. Try again.' })
    }
    if (!caller) return reply(401, { error: 'Sign in with Discord.' })
    if (caller.member !== true) return reply(403, { error: 'Notable members are shown to guild members.' })
    return reply(200, { companies: await store.all() })
  }
}
