/**
 * Pure core of scripts/snapshot-legacy-accolades.mjs: Discord's roles and members in, the
 * legacy-accolades payload out. No I/O, so the permanence rules can be tested: holders only
 * accumulate (unless pruned), blurbs and order survive, and a role that has already left the
 * guild keeps whatever was stored for it. Reports carry ids and counts, never names.
 */
import { nameOf } from '../../server/src/displayNames.js'

const SNOWFLAKE = /^\d{17,20}$/
// Snowflakes in numeric order (they outgrow Number's exact range, hence BigInt); only the sign of the result matters.
const compareIds = (a, b) => Number(BigInt(a) - BigInt(b))

/** Discord's integer role colour as "#rrggbb"; 0 means "no colour" and, like anything out of range, is null. */
export function colorHex(int) {
  return Number.isInteger(int) && int > 0 && int <= 0xffffff ? `#${int.toString(16).padStart(6, '0')}` : null
}

/**
 * @param existing the payload already on disk, or null
 * @param roles    GET /guilds/{id}/roles
 * @param members  every guild member (GET /guilds/{id}/members, all pages)
 * @param roleIds  the retired roles to capture
 * @param prune    drop recorded holders the new pull does not show (default: keep them)
 */
export function buildSnapshot({ existing = null, roles, members, roleIds, now, prune = false }) {
  if (!Array.isArray(roleIds) || !roleIds.every((id) => typeof id === 'string' && SNOWFLAKE.test(id))) {
    throw new TypeError('roleIds must be an array of snowflake strings')
  }
  const wanted = [...new Set(roleIds)]
  const live = new Map(roles.map((r) => [r.id, r]))
  // Insertion order is output order: stored accolades keep their place, new ones are appended.
  const entries = new Map((existing?.accolades ?? []).map((a) => [a.roleId, a]))
  const report = { missingRoles: [], unknownRoles: [], keptAbsent: {} }
  const nameless = new Set()
  let pulled = false

  for (const id of wanted.sort(compareIds)) {
    const role = live.get(id)
    const kept = entries.get(id)
    if (!role) {
      report.missingRoles.push(id)
      if (!kept) report.unknownRoles.push(id)
      continue
    }
    pulled = true
    const holders = new Map((prune ? [] : kept?.holders ?? []).map((h) => [h.id, h]))
    const current = new Set()
    for (const m of members) {
      if (!m.roles?.includes(id)) continue
      const name = nameOf(m)
      if (name === null) nameless.add(m.user.id)
      current.add(m.user.id)
      // A member with no usable name keeps their place, named by id; the owner can fix it by hand.
      holders.set(m.user.id, { id: m.user.id, name: name ?? m.user.id })
    }
    report.keptAbsent[id] = [...holders.keys()].filter((h) => !current.has(h)).length
    entries.set(id, {
      roleId: id,
      name: role.name,
      color: colorHex(role.color),
      blurb: kept?.blurb ?? '',
      holders: [...holders.values()].sort((a, b) => compareIds(a.id, b.id)),
    })
  }

  report.nameless = [...nameless]
  // The date only moves when something was actually pulled: a later run against deleted roles cannot re-date the data.
  const snapshot = pulled || !existing ? now.toISOString() : existing.snapshot
  return { legacy: { snapshot, accolades: [...entries.values()] }, report }
}
