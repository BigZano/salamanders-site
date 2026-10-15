/**
 * The public roster's view model: the snapshot from GET /roster/public (leaders
 * by name, every other rank a count) shaped like what buildRosterView gives the
 * members' page, so the same bar, banner and chips render it. Pure, and the
 * input is never mutated.
 *
 * What differs from the member view: a branch has `shape` (counted rank rows,
 * with the ladder's heat colours) where the member view has `ladder`, and
 * `extraHeads` (head holders beyond the two the bar shows, still named). People
 * carry a local key `pub-…` in place of a Discord id: the server sends none, and
 * the chips only need something to key on.
 */
import { SIGILS, heatAt } from './rosterView'

const HONOURED = 'Honoured Dreadnoughts'

const peopleOf = (scope, rankKey, members) =>
  members.map((m, i) => ({ id: `pub-${scope}-${rankKey}-${i}`, name: m.name, ...(m.acting ? { acting: true } : {}) }))

/** Counted rows in ladder order (honoured Dreadnoughts first), each with the heat of its place on the ramp. */
function shapeOf(aside, rows) {
  const raw = [
    ...(aside > 0 ? [{ key: 'aside', label: HONOURED, count: aside, aside: true }] : []),
    ...rows.map((r) => ({ key: r.rank.key, label: r.rank.label, count: r.count, tier: r.rank.tier, ...(r.rank.lateral ? { lateral: true } : {}) })),
  ]
  const n = Math.max(1, raw.filter((item) => !item.aside && !item.lateral).length)
  let order = 0
  return raw.map((item, s) => {
    if (item.aside || item.lateral) {
      return { ...item, s, heat: { h: heatAt((order + 0.5) / n), hp: heatAt(order / n), hn: heatAt(Math.min(1, (order + 1) / n)) } }
    }
    order++
    return { ...item, s, heat: { h: heatAt(order / n), hp: heatAt((order - 1) / n), hn: heatAt(Math.min(1, (order + 1) / n)) } }
  })
}

function branchOf(b) {
  const members = peopleOf(b.key, b.head.rank.key, b.head.members)
  const extraHeads = !b.head.vacant && members.length > 2 ? { rank: b.head.rank, members: members.slice(2) } : null
  const shape = shapeOf(b.aside, b.rows)
  return {
    key: b.key,
    kind: b.kind,
    label: b.label,
    number: b.number ?? null,
    sigil: SIGILS[b.key] ?? '',
    // the same sum buildRosterView makes
    count: (b.head.vacant ? 0 : members.length) + b.aside + b.rows.reduce((n, r) => n + r.count, 0),
    openable: shape.length > 0 || extraHeads !== null,
    head: { rank: b.head.rank, vacant: b.head.vacant, members, shown: members.slice(0, 2), more: Math.max(0, members.length - 2) },
    ladder: [],
    shape,
    extraHeads,
  }
}

function bannerOf(highCommand) {
  const [first, ...rest] = highCommand.filter((r) => r.members.length)
  if (!first) return { hero: null, court: [] }
  const named = (r) => peopleOf('high-command', r.rank.key, r.members)
  const [hero, ...others] = named(first)
  return {
    hero: { rank: first.rank, member: hero },
    court: [...(others.length ? [{ rank: first.rank, members: others }] : []), ...rest.map((r) => ({ rank: r.rank, members: named(r) }))],
  }
}

/** → { fetchedAt, stale, banner, branches, openableKeys } from a GET /roster/public snapshot. */
export function buildPublicView(snapshot) {
  const branches = snapshot.branches.map(branchOf)
  return {
    fetchedAt: snapshot.fetchedAt,
    stale: snapshot.stale,
    banner: bannerOf(snapshot.highCommand),
    branches,
    openableKeys: branches.filter((b) => b.openable).map((b) => b.key),
  }
}
