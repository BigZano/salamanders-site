/**
 * Discord sign-in: Implicit Grant only. GitHub Pages is pure static
 * hosting — no server-side compute — so there's nowhere to hold a
 * client_secret to do an Authorization Code exchange without shipping that
 * secret in the public JS bundle. Implicit grant is the only flow that
 * doesn't need one. Swap to Authorization Code (secret held in a Cloudflare
 * Pages Function) once migrated off GitHub Pages.
 */
import members from '../data/discord-members.json'

const CLIENT_ID = '1538255597810483210'
const STORAGE_KEY = 'salamanders-discord-member'
const RETURN_PATH_KEY = 'salamanders-discord-return-path'
// Overridable so E2E runs can point identify checks at a local fixture
// instead of the real Discord API — see e2e/discord-mock.
const DISCORD_API_BASE = import.meta.env.VITE_DISCORD_API_BASE || 'https://discord.com/api'

// Fixed and route-independent. Discord's dashboard requires an exact string
// match for every redirect_uri it's asked to send a token to, and sign-in is
// reachable from every route (the nav bar) plus the wildcard 404 route — so
// per-page whitelist entries can never be fully enumerated there. The page
// sign-in actually started from is stashed below and restored by
// scrubCallbackHash once the token is back.
function redirectUri() {
  return window.location.origin + '/'
}

export function beginSignIn() {
  sessionStorage.setItem(RETURN_PATH_KEY, window.location.pathname + window.location.search)
  const url = new URL('https://discord.com/oauth2/authorize')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'token')
  url.searchParams.set('scope', 'identify')
  url.searchParams.set('redirect_uri', redirectUri())
  window.location.href = url.toString()
}

/** Member identity only — never the access token. Use getAccessToken() for that. */
export function currentMember() {
  const raw = readStored()
  if (!raw) return null
  const { id, username, isMember, checkedAt } = raw
  return { id, username, isMember, checkedAt }
}

/**
 * The live bearer token for authenticated API calls (see src/lib/buildsApi.js),
 * or null if there isn't a valid one. Implicit-grant tokens expire — Discord
 * sends expires_in on the callback, stored alongside so a stale token doesn't
 * get sent as if it still worked; the caller just sees "not signed in".
 */
export function getAccessToken() {
  const raw = readStored()
  if (!raw?.accessToken || !raw?.expiresAt) return null
  if (Date.now() >= raw.expiresAt) return null
  return raw.accessToken
}

function readStored() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY))
  } catch {
    return null
  }
}

export function signOut() {
  localStorage.removeItem(STORAGE_KEY)
}

let pendingToken = null
let pendingExpiresIn = null

/**
 * Must run before Vue Router's history mode is constructed — createRouter()
 * reads location.pathname at construction time (evaluated as a static
 * import, before anything in main.js's own body runs), so restoring the
 * pre-sign-in path afterward is too late: the router has already latched
 * onto "/" (Discord's fixed redirect_uri, see beginSignIn) as the route.
 * Called synchronously from router.js, before createRouter().
 */
export function scrubCallbackHash() {
  const hash = window.location.hash
  // Discord doesn't guarantee param order in the fragment — token_type
  // often comes first — so check by substring, not prefix.
  if (!hash.includes('access_token=')) return
  const params = new URLSearchParams(hash.slice(1))
  pendingToken = params.get('access_token')
  pendingExpiresIn = Number(params.get('expires_in')) || null
  const returnPath = sessionStorage.getItem(RETURN_PATH_KEY)
  sessionStorage.removeItem(RETURN_PATH_KEY)
  history.replaceState(null, '', returnPath || window.location.pathname + window.location.search)
}

/** Runs after scrubCallbackHash — does the actual identify + membership check. */
export async function finishSignIn() {
  if (!pendingToken) return
  const token = pendingToken
  const expiresIn = pendingExpiresIn
  pendingToken = null
  pendingExpiresIn = null

  try {
    const res = await fetch(`${DISCORD_API_BASE}/users/@me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return
    const user = await res.json()
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        id: user.id,
        username: user.username,
        isMember: members.memberIds.includes(user.id),
        checkedAt: Date.now(),
        accessToken: token,
        // Discord always sends expires_in on an implicit-grant callback; the
        // fallback here only covers a malformed/missing param, not the normal
        // path, so it stays short rather than pretending the token is fresh.
        expiresAt: Date.now() + (expiresIn || 3600) * 1000,
      }),
    )
  } catch {
    // Network hiccup — sign-in silently fails, user can retry.
  }
}
