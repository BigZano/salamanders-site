/**
 * Stand-in for Discord's API in E2E tests. Both server/src/index.js
 * (verifyCaller) and src/lib/discordAuth.js (finishSignIn) identify a caller
 * by POSTing their bearer token to Discord's own /users/@me — this returns
 * canned identities for a fixed set of test tokens so the whole sign-in →
 * save → see-it-listed flow can be driven without a real Discord account.
 * Membership (member vs. non-member) isn't decided here — that's read from
 * the real, unmodified src/data/discord-members.json bake, same as prod.
 */
const PORT = Number(process.env.PORT || 4400)

const USERS = {
  // Real id from src/data/discord-members.json's memberIds.
  'test-member-token': { id: '75633559351595008', username: 'member-tester' },
  // Well-formed but deliberately absent from that list.
  'test-nonmember-token': { id: '999999999999999999', username: 'nonmember-tester' },
}

// The browser calls this cross-origin (from wherever "web" is served), unlike
// the real discord.com/api which already sends permissive CORS headers for
// exactly this kind of client-side OAuth flow — this mock has to do the same.
function withCors(res) {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  return res
}

Bun.serve({
  port: PORT,
  fetch(request) {
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }))

    const url = new URL(request.url)

    if (url.pathname === '/users/@me') {
      const auth = request.headers.get('Authorization') || ''
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
      const user = token && USERS[token]
      if (!user) {
        return withCors(Response.json({ message: '401: Unauthorized', code: 0 }, { status: 401 }))
      }
      return withCors(Response.json(user))
    }

    // Mod-role lookups: no moderator scenario exercised yet, so nobody has it.
    if (/^\/v10\/guilds\/[^/]+\/members\/[^/]+$/.test(url.pathname)) {
      return withCors(Response.json({ roles: [] }))
    }

    return withCors(new Response('Not found', { status: 404 }))
  },
})

console.log(`Discord mock listening on :${PORT}`)
