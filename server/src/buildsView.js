/**
 * How the builds list is shown to whoever asked for it. Anyone may read the
 * list; only a viewer with a valid Discord token also learns which authors are
 * guild members (the member flag), so the flag is not public data.
 *
 * view(request) → { nameFor, isMember, headers }
 *   nameFor   (id) → display name: always the directory's own resolver.
 *   isMember  (id) → boolean for a signed-in viewer; null when signed out.
 *   headers   what the response must carry. Vary: Authorization always (the
 *             body differs by token). A flagged response is also
 *             Cache-Control: private, no-store, so no shared cache can hand one
 *             viewer's flagged list to another or to a signed-out one.
 * Signed out means no token, an invalid or expired one, Discord unable to
 * answer (any error from identify), or Discord slower than identifyWaitMs: the
 * plain list is still public, so the view falls back to it, unflagged, rather
 * than failing or keeping the page waiting. Only identify is forgiven; a
 * failure of the directory itself is not hidden.
 */
export function createBuildsView({ roles, displayNames, identifyWaitMs = 1500 }) {
  async function view(request) {
    const nameFor = await displayNames.resolver()
    let caller = null // stays null when identify fails or is slow: signed out
    let timer
    try {
      const tooSlow = new Promise((resolve) => {
        timer = setTimeout(resolve, identifyWaitMs, null)
      })
      // The race keeps listening to the lookup, so a rejection after the timer
      // has won is handled, not an unhandled rejection.
      caller = await Promise.race([roles.identify(request), tooSlow])
    } catch {
      // Discord down or anything else: the public list is still served, unflagged.
    } finally {
      clearTimeout(timer) // a fast lookup leaves nothing pending
    }
    if (!caller) return { nameFor, isMember: null, headers: { Vary: 'Authorization' } }
    return {
      nameFor,
      isMember: await displayNames.memberResolver(),
      headers: { Vary: 'Authorization', 'Cache-Control': 'private, no-store' },
    }
  }
  return { view }
}
