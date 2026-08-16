/**
 * Splits the shared builds gallery into verified-member and other sections,
 * each independently paginated. Membership is read from the guild's baked
 * role list (src/data/discord-members.json) — the same static, no-live-check
 * source discordAuth.js uses for the signed-in user's own badge — so an
 * arbitrary build's author can be classified without a server round trip.
 */
export const PAGE_SIZE = 10

export function isMemberAuthor(build, memberIds) {
  return !!build?.author?.id && memberIds.includes(build.author.id)
}

export function splitByMembership(builds, memberIds) {
  const member = []
  const other = []
  for (const b of builds) {
    ;(isMemberAuthor(b, memberIds) ? member : other).push(b)
  }
  return { member, other }
}

/** Clamps page into [1, pageCount] rather than returning an empty slice for an out-of-range page. */
export function paginate(items, page, pageSize = PAGE_SIZE) {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize))
  const requested = Math.trunc(page)
  const clampedPage = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), pageCount) : 1
  const start = (clampedPage - 1) * pageSize
  return { items: items.slice(start, start + pageSize), page: clampedPage, pageCount }
}
