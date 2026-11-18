/**
 * Who may read the Librarius: the forum's own permissions, as Discord would judge them for the member, worked out here
 * from the guild's roles and the forum's overwrites (librariusGuild.js facts()) and the roles the member holds
 * (discordRoles.js memberOf) by Discord's rules (librariusPerms.js). Someone who may open the forum in Discord may
 * open it here, and nobody else: the guild owner and an Administrator included, and a role that is shut out of the
 * forum included.
 *
 * resolve(request, { fresh }) → { user, read, perms }, or null when there is no valid Discord identity. `perms` is
 * the member's permissions in the forum as a bigint, 0n for someone who is not in the guild, and `read` is whether they
 * include View Channel and Read Message History. A guild id that is not an id leaves nobody with any: the answer is
 * always no. forget() drops every cached verdict.
 *
 * Reads may reuse a verdict for `ttlMs` (30 seconds unless given), as galleryAccess.js does, and `fresh` skips the
 * cache entirely. Any Discord failure throws Upstream, which is neither stored nor answered from an earlier verdict:
 * callers fail closed. The cache itself is verdictCache.js.
 */
import { createVerdictCache } from './verdictCache.js'
import { canRead, permissionsIn } from './librariusPerms.js'

export function createLibrariusAccess({ roles, guild, guildId, ttlMs, maxEntries, now }) {
  async function lookup(request) {
    const user = await roles.identify(request)
    if (!user) return null
    const member = await roles.memberOf(user.id)
    // Not in the guild: nothing to read with, and no need to ask what the forum allows.
    if (!member) return { user, read: false, perms: 0n }
    const { ownerId, roles: guildRoles, overwrites } = await guild.facts()
    const perms = permissionsIn({ guildId, ownerId, roles: guildRoles, overwrites, memberId: user.id, memberRoleIds: member.roles })
    return { user, read: canRead(perms), perms }
  }

  /**
   * resolve(request, { fresh }) → { user, read, perms }, or null when there is no valid Discord identity.
   * forget() drops every cached verdict.
   */
  const { resolve, forget } = createVerdictCache({ lookup, ttlMs, maxEntries, now })

  return { resolve, forget }
}
