/**
 * Splits the shared builds gallery into verified-member and other sections,
 * each independently paginated. Who counts as a member is the server's call,
 * made per viewer: GET /builds marks each build's author `member: true|false`
 * only when the request carries a valid token, and leaves the field out for
 * a signed-out visitor. Nothing here knows who the members are, so a
 * signed-out page has no member section to show.
 */
export const PAGE_SIZE = 10

/** True only for the boolean `true`: 'true', 1, a missing flag or a missing build are all "not a member". */
export function isMemberAuthor(build) {
  return build?.author?.member === true
}

export function splitByMembership(builds) {
  const member = []
  const other = []
  for (const b of builds) {
    ;(isMemberAuthor(b) ? member : other).push(b)
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
