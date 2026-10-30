/**
 * GET /membership: is the signed-in caller a guild member? The site asks this
 * after Discord sign-in instead of reading a committed member list. The answer
 * comes live from membership.check (see membership.js), so a role granted or
 * removed takes effect on the next call.
 *
 *   200 { member: boolean }  member is true only when check said exactly true;
 *                            anything else a faulty check hands back is false.
 *                            The caller's id is never echoed.
 *   401                      no or invalid token
 *   503                      Discord could not answer, whatever the cause
 * Every answer is no-store: it is per caller and must never be shared or kept.
 */

const reply = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

export function createMembershipHandler({ membership }) {
  return async function handle(request, url) {
    if (request.method !== 'GET' || url.pathname !== '/membership') return null
    let caller
    try {
      caller = await membership.check(request)
    } catch {
      return reply(503, { error: 'Discord could not be reached. Try again.' })
    }
    if (!caller) return reply(401, { error: 'Sign in with Discord.' })
    return reply(200, { member: caller.member === true })
  }
}
