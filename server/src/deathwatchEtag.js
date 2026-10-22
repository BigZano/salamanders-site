/**
 * ETags for GET /deathwatch/data. The tag is a hash of the exact body served, so
 * any change to the data changes it. Pure.
 */
import { createHash } from 'node:crypto'

/** A strong ETag: the first 32 hex characters of the SHA-256 of `text`, in quotes. */
export const etagOf = (text) => `"${createHash('sha256').update(text).digest('hex').slice(0, 32)}"`

/** Does an If-None-Match header (`*`, or a comma list of strong or weak tags) include `etag`? */
export function ifNoneMatches(header, etag) {
  if (!header) return false
  return header.split(',').some((part) => {
    const tag = part.trim()
    return tag === '*' || (tag.startsWith('W/') ? tag.slice(2) : tag) === etag
  })
}
