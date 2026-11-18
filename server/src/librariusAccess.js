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
 * What a member may write (batch 2), by Discord's rules: `reply` is read and Send Messages in Threads and not timed out.
 * It leaves out whether a post is locked, which is per post: the route lets a locked post through only for `manageThreads`.
 * `attach` is `reply` and Attach Files. `manageMessages` and `manageThreads` are those permissions in a member who can
 * read and is not timed out, since a timeout takes every right of a member's but reading. `timedOut` is whether a timeout
 * is running now, and `timeoutUntil` the ISO time it ends, or null. `admin` is Administrator or Manage Server, the two that
 * Discord's own AutoMod does not apply its rules to. `roleIds` are the roles the member holds. Someone who is not in the
 * guild, or cannot read, has none of these.
 *
 * Reads may reuse a verdict for `ttlMs` (30 seconds unless given), as galleryAccess.js does, and `fresh` skips the
 * cache entirely. Any Discord failure throws Upstream, which is neither stored nor answered from an earlier verdict:
 * callers fail closed. The cache itself is verdictCache.js.
 */
import { isId } from './librariusText.js'
import { createVerdictCache } from './verdictCache.js'
import { P, canRead, permissionsIn } from './librariusPerms.js'

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
    // Strictly in the future: at the very millisecond a timeout ends, it has ended. No timeout is null, which reads as no time.
    const timedOut = Date.parse(member.timeoutUntil) > now()
    const active = read && !timedOut
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

  /**
   * resolve(request, { fresh }) → { user, read, perms }, or null when there is no valid Discord identity.
   * forget() drops every cached verdict.
   */
  const { resolve, forget } = createVerdictCache({ lookup, ttlMs, maxEntries, now })

  return { resolve, forget }
}
