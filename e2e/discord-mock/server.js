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
  // In the guild (and the member bake) but without the Legion role.
  'test-norole-token': { id: '87082170719408128', username: 'norole-tester' },
  // Legion member who also holds Reclusiarch — reviews reports.
  'test-reclusiarch-token': { id: '100000000000000002', username: 'reclusiarch-tester' },
  // Techmarine — edits perks, sees history, moderates builds.
  'test-techmarine-token': { id: '100000000000000010', username: 'techmarine-tester' },
  // Master of the Forge — may revoke the Techmarine.
  'test-forge-token': { id: '100000000000000011', username: 'forge-tester' },
}
const LEGION_ROLE = '1377787723976409211'
const RECLUSIARCH_ROLE = '1323334632904855592'
const TECHMARINE_ROLE = '1322056087859499042'
const FORGE_ROLE = '1322056087867883565'
const GUILD_ID = '1322056087792521269'
// Guild membership as Discord's bot endpoint would report it.
const MEMBERS = {
  // Has a server nickname, so builds show it instead of the username.
  '75633559351595008': { roles: [LEGION_ROLE], nick: 'Brother Tester' },
  '87082170719408128': { roles: [] },
  '100000000000000002': { roles: [LEGION_ROLE, RECLUSIARCH_ROLE] },
  '100000000000000010': { roles: [LEGION_ROLE, TECHMARINE_ROLE] },
  '100000000000000011': { roles: [LEGION_ROLE, FORGE_ROLE] },
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

    // Legion Archive member list, shaped like src/data/discord-members.json.
    // Only the Legion role holder is on it (unlike the real bake, which also
    // lists the no-role tester) so the refusal path is exercised.
    if (url.pathname === '/members.json') {
      return withCors(Response.json({ fetched: new Date(0).toISOString(), guildId: GUILD_ID, roleId: LEGION_ROLE, memberIds: ['75633559351595008'] }))
    }

    // Guild role table (Administrator checks). Nobody here is an admin.
    if (url.pathname === `/v10/guilds/${GUILD_ID}`) {
      return withCors(Response.json({ owner_id: '1', roles: [{ id: GUILD_ID, permissions: '0' }, { id: RECLUSIARCH_ROLE, permissions: '0' }] }))
    }

    // Full member list (build authors' display names, see displayNames.js).
    if (url.pathname === `/v10/guilds/${GUILD_ID}/members`) {
      const byId = Object.fromEntries(Object.values(USERS).map((u) => [u.id, u]))
      const list = Object.entries(MEMBERS).map(([id, m]) => ({
        nick: m.nick ?? null,
        roles: m.roles,
        user: { id, username: byId[id]?.username ?? `user-${id}`, global_name: null },
      }))
      return withCors(Response.json(list))
    }

    // Guild member lookups (mod-role, report-role and perk-privilege checks).
    // The Techmarine and Forge testers hold mod roles; nobody else does.
    const memberMatch = url.pathname.match(/^\/v10\/guilds\/[^/]+\/members\/([^/]+)$/)
    if (memberMatch) {
      const member = MEMBERS[memberMatch[1]]
      return withCors(member ? Response.json(member) : Response.json({ message: 'Unknown Member' }, { status: 404 }))
    }

    // The wiki bake, standing in for raw.githubusercontent.com (BAKE_BASE_URL).
    const bakeMatch = url.pathname.match(/^\/bake\/(weapon-trees|perk-details)\.json$/)
    if (bakeMatch) return withCors(new Response(Bun.file(`/bake/${bakeMatch[1]}.json`), { headers: { 'Content-Type': 'application/json' } }))

    return withCors(new Response('Not found', { status: 404 }))
  },
})

console.log(`Discord mock listening on :${PORT}`)
