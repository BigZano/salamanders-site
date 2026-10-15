/**
 * The public face of the order of battle: who leads what, and how big each
 * branch is. Pure, no I/O. Heads (and High Command) are named; everyone below
 * a head is a count. An allowlist, not a filter: every output object is built
 * from named fields, so a field added to the member object later can never
 * ride along. Never included: member id, avatar, company, flags, the
 * Unassigned list, Servitors, the Infirmary. Spec:
 * docs/superpowers/specs/2026-10-14-companies-roster-merge-design.md.
 */
import { rankView } from './rosterCore.js'

// `lateral` marks a rank row on the ladder; a post (head, High Command) never carries it.
const postRank = ({ key, label, tier }) => ({ key, label, tier })
const nameOnly = (m) => ({ name: m.name })
const headMember = (m) => ({ name: m.name, ...(m.acting ? { acting: true } : {}) })

/** → { highCommand, branches } from a buildRoster() result. The caller adds fetchedAt and stale. */
export function publicRoster(roster) {
  return {
    highCommand: roster.highCommand.map((r) => ({ rank: postRank(r.rank), members: r.members.map(nameOnly) })),
    branches: roster.branches.map((b) => ({
      key: b.key,
      kind: b.kind,
      label: b.label,
      ...(b.number !== undefined ? { number: b.number } : {}),
      head: { rank: postRank(b.head.rank), vacant: b.head.vacant, members: b.head.members.map(headMember) },
      aside: b.aside.length,
      rows: b.rows.map((r) => ({ rank: rankView(r.rank), count: r.members.length })),
    })),
  }
}
