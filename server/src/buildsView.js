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
 * Signed out means no token, an invalid or expired one, or Discord unable to
 * answer (any error from identify): the plain list is still public, so the
 * view falls back to it, unflagged, rather than failing. Only identify is
 * forgiven; a failure of the directory itself is not hidden.
 */
export function createBuildsView({ roles, displayNames }) {
  async function view(request) {
    const nameFor = await displayNames.resolver()
    let caller = null // stays null when identify fails: signed out
    try {
      caller = await roles.identify(request)
    } catch {
      // Discord down or anything else: the public list is still served, unflagged.
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
