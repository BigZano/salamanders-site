/**
 * GET /archive/key — hands the Legion Archive key only to a caller whose
 * Discord token is valid *and* who holds the guild member role, asked of
 * Discord live through membership.check on every call (no list, no cache).
 * Fails closed: the key is never returned on doubt.
 *   no usable ARCHIVE_KEY → 503, before anyone is asked
 *   no or invalid token   → 401
 *   not a member          → 403 (only the boolean true is a member)
 *   Discord cannot answer → 503 (whatever the failure was)
 */
const KEY_B64 = /^[A-Za-z0-9+/]{43}=$/

export function createArchiveKeyHandler({ membership, archiveKey }) {
  if (typeof archiveKey !== 'string' || !KEY_B64.test(archiveKey)) {
    return async () => reply(503, { error: 'Archive unavailable.' })
  }
  const kid = kidOf(archiveKey)

  return async function handle(request) {
    let caller
    try {
      caller = await membership.check(request)
    } catch {
      return reply(503, { error: 'Discord could not be reached. Try again.' })
    }
    if (caller === null) return reply(401, { error: 'Sign in with Discord.' })
    if (caller?.member !== true) return reply(403, { error: 'Restricted to the XVIIIth Legion.' })
    return reply(200, { key: archiveKey, kid: await kid })
  }
}

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

async function kidOf(b64) {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}
