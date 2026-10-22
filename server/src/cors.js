/**
 * CORS headers for every API response. The page is served from one origin, so
 * that origin is the only one allowed. If-None-Match is allowed because the
 * Deathwatch data poll sends it, and ETag is exposed because a browser hides
 * every response header that isn't CORS-safelisted: without it the poll could
 * never read the tag and would never get a 304.
 */
export function applyCors(res, origin) {
  res.headers.set('Access-Control-Allow-Origin', origin)
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-None-Match')
  res.headers.set('Access-Control-Expose-Headers', 'ETag')
  return res
}
