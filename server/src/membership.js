/**
 * Who is calling, and are they a guild member? Answered live from Discord on
 * every call, never from a committed list, so a role granted or removed takes
 * effect immediately. Shared by GET /membership and the sealed-archive key
 * gate, which must fail closed.
 *
 * check(request) → { id, member } | null
 *   null = no or invalid token. member is true only when Discord's role list
 *   for the caller holds roleId exactly (string compare); not in the guild, or
 *   any answer that is not a role list, is member:false.
 * Throws Upstream when Discord cannot answer, or when roleId is not a
 * non-empty string (checked before Discord is asked anything). Errors from
 * the roles seam propagate unchanged.
 */
import { Upstream } from './discordRoles.js'

export function createMembership({ roles, roleId }) {
  async function check(request) {
    if (typeof roleId !== 'string' || roleId === '') throw new Upstream('Membership is not configured.')
    const caller = await roles.identify(request)
    if (!caller) return null
    const held = await roles.rolesOf(caller.id)
    return { id: caller.id, member: Array.isArray(held) && held.includes(roleId) }
  }
  return { check }
}
