/**
 * Discord's permission rules for one member in one channel, computed here so the site can say who may read the
 * Librarius forum without asking Discord about every request. Pure: no I/O.
 *
 * The order is the one Discord documents. The guild owner has everything. Everyone else starts from the
 * permissions of @everyone and of every role they hold, ORed together; Administrator in that base is everything,
 * whatever the channel says. Then the channel's overwrites apply in three stages, each taking its denies off before
 * it puts its allows on: the @everyone overwrite, then every held role's overwrite combined (all their denies, then
 * all their allows, so one role's allow beats another's deny), then the member's own overwrite. A member left
 * without View Channel can do nothing there.
 *
 * Every id is a string and is checked, and so is every permission value: Discord sends them as strings of digits,
 * and anything else counts as none. An id that cannot be read as a member or guild answers nothing.
 */

/** The permission bits the Librarius asks about. Discord's documented values. */
export const P = Object.freeze({
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MANAGE_THREADS: 1n << 34n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
})

/** Every bit there is: what the owner and an Administrator have. */
export const ALL = (1n << 64n) - 1n

const SNOWFLAKE = /^\d{17,20}$/
const isId = (v) => typeof v === 'string' && SNOWFLAKE.test(v)
// Stryker disable next-line ArrayDeclaration: a stray element is never a role, an overwrite or a role id, so every reader below drops it
const list = (v) => (Array.isArray(v) ? v : [])

// Overwrite types, as Discord numbers them.
const ROLE = 0
const MEMBER = 1

/** A permission value as bits: a string of 1 to 40 digits, or a bigint of zero or more. Anything else is none. */
export function toBits(value) {
  // Stryker disable next-line EqualityOperator: at 0n both branches give 0n, so `>` and `>=` are the same function
  if (typeof value === 'bigint') return value >= 0n ? value : 0n
  return typeof value === 'string' && /^\d{1,40}$/.test(value) ? BigInt(value) : 0n
}

// One stage of overwrites: every matching overwrite's denies come off, then every matching overwrite's allows go on.
function applyStage(bits, overwrites, matches) {
  let allow = 0n
  let deny = 0n
  for (const o of overwrites) {
    if (!matches(o)) continue
    allow |= toBits(o.allow)
    deny |= toBits(o.deny)
  }
  return (bits & ~deny) | allow
}

/**
 * What this member may do in the channel, as bits. `roles` is the guild's roles ({ id, permissions }), `overwrites`
 * the channel's ({ id, type, allow, deny }; type 0 is a role, 1 a member), `memberRoleIds` the roles they hold.
 * The guild id is also the @everyone role's id. Answers 0n when the member is left without View Channel, and when
 * the guild or member id is not a snowflake: with no one to ask about, nothing is granted.
 */
export function permissionsIn({ guildId, ownerId, roles, overwrites, memberId, memberRoleIds }) {
  if (!isId(guildId) || !isId(memberId)) return 0n
  if (ownerId === memberId) return ALL

  // @everyone is always in play and never listed twice: its overwrite is the first stage, not part of the second.
  const held = new Set(list(memberRoleIds).filter(isId))
  held.delete(guildId)
  const base = list(roles)
    .filter((r) => r?.id === guildId || held.has(r?.id))
    .reduce((acc, r) => acc | toBits(r.permissions), 0n)
  if ((base & P.ADMINISTRATOR) === P.ADMINISTRATOR) return ALL

  const all = list(overwrites)
  let bits = applyStage(base, all, (o) => o?.type === ROLE && o.id === guildId)
  bits = applyStage(bits, all, (o) => o?.type === ROLE && held.has(o.id))
  bits = applyStage(bits, all, (o) => o?.type === MEMBER && o.id === memberId)
  return (bits & P.VIEW_CHANNEL) === P.VIEW_CHANNEL ? bits : 0n
}

/** Whether these bits let a member read the channel: View Channel and Read Message History both. */
export function canRead(bits) {
  const wanted = P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY
  return (toBits(bits) & wanted) === wanted
}
