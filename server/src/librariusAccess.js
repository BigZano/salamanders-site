/**
 * Who may read the Librarius: the forum's own permissions, as Discord would judge them for the member, worked out here
 * from the guild's roles and the forum's overwrites (librariusGuild.js facts()) and the roles the member holds
 * (discordRoles.js memberOf) by Discord's rules (librariusPerms.js). Someone who may open the forum in Discord may
 * open it here, and nobody else: the guild owner and an Administrator included, and a role that is shut out of the
 * forum included.
 *
 * resolve(request, { fresh }) → { user, read, perms, roleIds, admin, timedOut, timeoutUntil, reply, attach, manageMessages,
 * manageThreads }, or null when there is no valid Discord identity. `perms` is the member's permissions in the forum as a
 * bigint, 0n for someone who is not in the guild, and `read` is whether they include View Channel and Read Message History.
 * A guild id that is not an id leaves nobody with any: the answer is always no. forget() drops every cached verdict.
 *
 * What a member may write (batch 2), by Discord's rules: `reply` is read and Send Messages in Threads, not timed out and not
 * still in Membership Screening (`pending`, which memberOf says). It leaves out whether a post is locked, which is per post: the
 * route lets a locked post through only for `manageThreads`. `attach` is `reply` and Attach Files. `manageMessages` and
 * `manageThreads` are those permissions in a member who can read, is not timed out and has passed the screening, since a timeout
 * takes every right of a member's but reading. The guild owner and an Administrator are never timed out (Discord exempts them),
 * whatever their lookup says. `timedOut` is whether a timeout is running now, and `timeoutUntil` the ISO time it ends, or null.
 * `admin` is Administrator or Manage Server, the two that Discord's own AutoMod does not apply its rules to. `roleIds` are the
 * roles the member holds. Someone who is not in the guild, or cannot read, has none of these.
 *
 * Reads may reuse a verdict for `ttlMs` (30 seconds unless given), as galleryAccess.js does. A write asks with `fresh`, which
 * is a verdict of its own kept for 3 seconds (a role taken away stops a write within that), and with one lookup at a time for
 * each Authorization header: writes that come together share it, and so share its failure. A read verdict and a write verdict
 * are not each other's. Any Discord failure throws Upstream, which is neither stored nor answered from an earlier verdict:
 * callers fail closed. The caches are verdictCache.js, whose semantics are the same for every other caller.
 */
import { createHash } from 'node:crypto'
import { isId } from './librariusText.js'
import { createVerdictCache } from './verdictCache.js'
import { ALL, P, canRead, permissionsIn } from './librariusPerms.js'

// How long the verdict of a write is kept. Short, since a role taken away or a timeout begun should stop a write soon; but it is what
// keeps a script's writes, and the parts of one reply, from each costing Discord two calls.
const WRITE_TTL_MS = 3_000

const NOTHING = { roleIds: [], admin: false, timedOut: false, timeoutUntil: null, reply: false, attach: false, manageMessages: false, manageThreads: false }

export function createLibrariusAccess({ roles, guild, guildId, ttlMs, maxEntries, now = Date.now }) {
  async function lookup(request) {
    const user = await roles.identify(request)
    if (!user) return null
    const member = await roles.memberOf(user.id)
    // Not in the guild: nothing to read with, and no need to ask what the forum allows.
    if (!member) return { user, read: false, perms: 0n, ...NOTHING, roleIds: [] }
    const { ownerId, roles: guildRoles, overwrites } = await guild.facts()
    const perms = permissionsIn({ guildId, ownerId, roles: guildRoles, overwrites, memberId: user.id, memberRoleIds: member.roles })
    const read = canRead(perms)
    const has = (bit) => (perms & bit) === bit
    // Discord exempts the guild owner and an Administrator from a timeout (permissionsIn gives both every permission). For anyone else it
    // is strictly in the future: at the very millisecond a timeout ends, it has ended. No timeout is null, which reads as no time.
    const timedOut = perms !== ALL && Date.parse(member.timeoutUntil) > now()
    // A member still in Membership Screening has not been let in: nothing they hold counts until they have passed it.
    const active = read && !timedOut && member.pending !== true
    const reply = active && has(P.SEND_MESSAGES_IN_THREADS)
    return {
      user,
      read,
      perms,
      roleIds: Array.isArray(member.roles) ? member.roles.filter(isId) : [],
      admin: has(P.ADMINISTRATOR) || has(P.MANAGE_GUILD),
      timedOut,
      timeoutUntil: timedOut ? new Date(member.timeoutUntil).toISOString() : null,
      reply,
      attach: reply && has(P.ATTACH_FILES),
      manageMessages: active && has(P.MANAGE_MESSAGES),
      manageThreads: active && has(P.MANAGE_THREADS),
    }
  }

  const reads = createVerdictCache({ lookup, ttlMs, maxEntries, now })

  // The lookups of the writes now going, by a hash of the Authorization header they are for. A burst of writes by one member, whose
  // pictures go up together, say, shares one lookup: the member lookups are Discord's, and a lookup for each of them would be the
  // calls that Discord counts against us if it answers 429 or 401.
  const flights = new Map()
  function lookupOnce(request) {
    const header = request.headers.get('Authorization')
    if (!header) return lookup(request)
    const key = createHash('sha256').update(header).digest('hex')
    const going = flights.get(key)
    if (going) return going
    const flight = lookup(request).finally(() => {
      // Not the place of a lookup begun since forget(), which is another one's.
      if (flights.get(key) === flight) flights.delete(key)
    })
    flights.set(key, flight)
    return flight
  }
  const writes = createVerdictCache({ lookup: lookupOnce, ttlMs: WRITE_TTL_MS, maxEntries, now })

  return {
    /**
     * resolve(request, { fresh }) → { user, read, perms }, or null when there is no valid Discord identity. A read may be 30 seconds
     * old; `fresh` (a write) is no more than 3 seconds old, with one lookup at a time for each header, and neither takes the other's.
     */
    resolve: (request, { fresh = false } = {}) => (fresh ? writes : reads).resolve(request),

    /** Drops every cached verdict, and the lookups going now are no longer shared with. */
    forget() {
      reads.forget()
      writes.forget()
      flights.clear()
    },
  }
}
