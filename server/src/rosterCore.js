/**
 * The roster as data. Pure: raw Discord guild-member objects in, the order of
 * battle out; no I/O, no clock. Placement is by role; the one place a name
 * decides is servitor detection (routeOf). Rules and ladder:
 * docs/superpowers/specs/2026-10-13-roster-design.md and rosterLadder.js.
 */
import {
  ALL_RANKS,
  BRANCHES,
  CAPTAIN,
  COMMAND_TIER_ROLES,
  COMPANIES,
  COMPANY_RANKS,
  DREADNOUGHTS,
  HIGH_COMMAND,
  INFIRMARY_ROLE,
  LEGION_ROLE,
  NO_RANK,
  PLACING_ROLES,
  SERVO_SKULLS_ROLE,
  SPECIALTIES,
  VENERABLE_DREADNOUGHT,
  VOICE_OF_VULKAN_ROLE,
} from './rosterLadder.js'
import { companiesInName, isServitorName, memberFacts } from './rosterMember.js'

/** May this caller (their held role ids) open the Infirmary area? */
export const commandTier = (roleIds) => roleIds.some((id) => COMMAND_TIER_ROLES.has(id))

/**
 * Where a member goes before any placement: 'hidden' (listed nowhere),
 * 'servitor', 'infirmary' or 'roster'. First match wins, in this order.
 */
export function routeOf(f) {
  if (f.roles.has(VOICE_OF_VULKAN_ROLE)) return 'hidden'
  if (f.bot || f.roles.has(SERVO_SKULLS_ROLE)) return 'servitor'
  if (f.roles.has(INFIRMARY_ROLE)) return 'infirmary'
  if (!f.roles.has(LEGION_ROLE)) return 'hidden'
  // The name is the weakest signal: it counts only when no placing role does.
  if (isServitorName(f.name) && ![...PLACING_ROLES].some((id) => f.roles.has(id))) return 'servitor'
  return 'roster'
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
/** Name, case-insensitive, then id: a total order, so output never depends on input order. */
const byName = (a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.id, b.id)

/** A member's highest rank within `ranks`, counting a variant role as its owner's rank. */
const heldRank = (roles, ranks) => ranks.find((r) => roles.has(r.id) || r.variants?.some((v) => roles.has(v.id)))
const rankView = ({ key, label, tier, lateral }) => ({ key, label, tier, ...(lateral ? { lateral: true } : {}) })

const VARIANT_OWNERS = [...COMPANY_RANKS, ...SPECIALTIES.flatMap((s) => s.ranks)]

/** Company from roles only: the lowest-numbered company role, else the company a variant role implies. */
function companyOf(roles) {
  const held = COMPANIES.filter((c) => roles.has(c.roleId)).map((c) => c.number)
  if (held.length > 0) return { company: held[0], also: held.slice(1) }
  for (const owner of VARIANT_OWNERS) {
    const v = owner.variants?.find((x) => roles.has(x.id))
    if (v) return { company: v.company, also: [] }
  }
  return { company: null, also: [] }
}

/** The public view of one member. */
function member(f, { acting = false } = {}) {
  const { company, also } = companyOf(f.roles)
  const claimed = new Set([company, ...also]) // a null company never matches a number in a name
  return {
    id: f.id,
    name: f.name,
    avatar: f.avatar,
    company,
    ...(also.length > 0 ? { alsoCompanies: also } : {}),
    ...(acting ? { acting: true } : {}),
    ...(companiesInName(f.name).some((n) => !claimed.has(n)) ? { nameMismatch: true } : {}),
  }
}

/** Rules 2-10 of the spec, first match wins. */
function place(f, company) {
  const { roles } = f
  const hc = heldRank(roles, HIGH_COMMAND)
  if (hc) return { to: 'highCommand', rank: hc }
  const early = SPECIALTIES.find((s) => s.headFirst && roles.has(s.head.id))
  if (early) return { to: early.key, head: true }
  const home = company === null ? null : `company-${company}`
  // A Captain who is also a Venerable Dreadnought is shown with their company.
  if (home && roles.has(CAPTAIN.id)) return { to: home, head: true }
  if (roles.has(VENERABLE_DREADNOUGHT.id)) return { to: 'venerable-dreadnoughts', head: true }
  if (home && heldRank(roles, DREADNOUGHTS)) return { to: home, aside: true }
  const late = SPECIALTIES.find((s) => !s.headFirst && roles.has(s.head.id))
  if (late) return { to: late.key, head: true }
  for (const s of SPECIALTIES) {
    const rank = heldRank(roles, s.ranks)
    if (rank) return { to: s.key, rank }
  }
  return { to: home ?? 'unassigned', rank: heldRank(roles, COMPANY_RANKS) ?? null }
}

/** Well-formed, de-duplicated members (the first of a duplicate id wins). */
function people(rawMembers, guildId) {
  const seen = new Set()
  const out = []
  // Stryker disable next-line ArrayDeclaration: a stray element is a non-member, which memberFacts skips
  for (const raw of Array.isArray(rawMembers) ? rawMembers : []) {
    const f = memberFacts(raw, guildId)
    if (!f || seen.has(f.id)) continue
    seen.add(f.id)
    out.push(f)
  }
  return out
}

const rowsOf = (byKey, ranks) =>
  ranks.filter((r) => byKey.get(r.key).length > 0).map((r) => ({ rank: rankView(r), members: byKey.get(r.key).sort(byName) }))

/**
 * The order of battle: { highCommand, branches, unassigned, servitors }.
 * `rawMembers` are Discord guild-member objects; `guildId` builds avatar urls.
 */
export function buildRoster(rawMembers, { guildId } = {}) {
  const highCommand = new Map(HIGH_COMMAND.map((r) => [r.key, []]))
  const unassigned = new Map([...COMPANY_RANKS, NO_RANK].map((r) => [r.key, []]))
  const slots = new Map(BRANCHES.map((b) => [b.key, { head: [], aside: [], rows: new Map(b.ranks.map((r) => [r.key, []])) }]))
  const servitors = []
  const eligible = [] // roster members who may stand in as an acting head

  for (const f of people(rawMembers, guildId)) {
    const to = routeOf(f)
    if (to === 'servitor') {
      servitors.push({ id: f.id, name: f.name, avatar: f.avatar, company: null, ...(f.bot ? { bot: true } : {}) })
    }
    if (to !== 'roster') continue

    const placed = place(f, companyOf(f.roles).company)
    const m = member(f)
    if (placed.to === 'highCommand') highCommand.get(placed.rank.key).push(m)
    else if (placed.to === 'unassigned') unassigned.get((placed.rank ?? NO_RANK).key).push(m)
    else {
      const slot = slots.get(placed.to)
      if (placed.head) slot.head.push(m)
      else if (placed.aside) slot.aside.push(m)
      else slot.rows.get((placed.rank ?? NO_RANK).key).push(m)
    }
    if (placed.to === 'highCommand' || f.roles.has(CAPTAIN.id)) eligible.push(f)
  }

  // A company with no Captain is headed, as acting, by High Command and other
  // Captains holding its Company Command role.
  for (const b of BRANCHES) {
    const slot = slots.get(b.key)
    if (slot.head.length > 0) continue
    slot.head = eligible.filter((f) => b.commandRoleIds.some((id) => f.roles.has(id))).map((f) => member(f, { acting: true }))
  }

  return {
    highCommand: rowsOf(highCommand, HIGH_COMMAND),
    branches: BRANCHES.map((b) => {
      const slot = slots.get(b.key)
      return {
        key: b.key,
        kind: b.kind,
        label: b.label,
        ...(b.kind === 'company' ? { number: b.number } : {}),
        head: { rank: rankView(b.head), members: slot.head.sort(byName), vacant: slot.head.length === 0 },
        aside: slot.aside.sort(byName),
        rows: rowsOf(slot.rows, b.ranks),
      }
    }),
    unassigned: { rows: rowsOf(unassigned, [...COMPANY_RANKS, NO_RANK]) },
    servitors: servitors.sort(byName),
  }
}

/**
 * Everyone holding the Infirmary role (Legion role or not), for command to
 * review. `legion` says whether they still carry the Legion role, which they
 * shouldn't while on leave. Sorted by company (none last), rank, name.
 */
export function buildInfirmary(rawMembers, { guildId } = {}) {
  return people(rawMembers, guildId)
    .filter((f) => routeOf(f) === 'infirmary')
    .map((f) => {
      const view = member(f)
      const rank = heldRank(f.roles, ALL_RANKS)
      return {
        view: { ...view, rank: rank ? { key: rank.key, label: rank.label } : null, legion: f.roles.has(LEGION_ROLE) },
        company: view.company ?? Infinity,
        order: rank ? ALL_RANKS.indexOf(rank) : Infinity,
      }
    })
    .sort((a, z) => cmp(a.company, z.company) || cmp(a.order, z.order) || byName(a.view, z.view))
    .map((e) => e.view)
}
