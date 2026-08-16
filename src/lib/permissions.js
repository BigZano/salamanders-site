/**
 * Client-side mirror of the server's poster-only delete rule (see
 * server/src/index.js deleteBuild) — controls what the UI offers, not what's
 * actually allowed. The server re-checks identity against Discord on every
 * delete regardless of what this returns, so getting this wrong only ever
 * costs a rejected request, never a real permission bypass.
 */
export function canDeleteBuild(member, build) {
  const memberId = member?.id
  const authorId = build?.author?.id
  if (!isId(memberId) || !isId(authorId)) return false
  return String(memberId) === String(authorId)
}

// Discord snowflake ids are non-empty strings. Restricting the comparison to
// string/number primitives (rather than just truthiness) stops two malformed
// ids of the same shape — e.g. both {} — from string-coercing to the same
// "[object Object]" and matching by accident.
function isId(v) {
  return (typeof v === 'string' && v !== '') || (typeof v === 'number' && v !== 0)
}
