/**
 * Discord sign-in: Implicit Grant only. GitHub Pages is pure static
 * hosting — no server-side compute — so there's nowhere to hold a
 * client_secret to do an Authorization Code exchange without shipping that
 * secret in the public JS bundle. Implicit grant is the only flow that
 * doesn't need one. Swap to Authorization Code (secret held in a Cloudflare
 * Pages Function) once migrated off GitHub Pages.
 */
import { getMembership } from './buildsApi'

const CLIENT_ID = '1538255597810483210'
const STORAGE_KEY = 'salamanders-discord-member'
const RETURN_PATH_KEY = 'salamanders-discord-return-path'
// A second copy of the return path, in localStorage. On a phone the Discord app can take the authorize step and
// hand the redirect to a different browser context, where sessionStorage is empty and the visitor would land on
// "/". It is honoured for ten minutes: long enough to authorize and come back, short enough that an old one
// never sends a later sign-in somewhere unexpected.
const RETURN_FALLBACK_KEY = 'salamanders-discord-return-fallback'
export const RETURN_FALLBACK_MS = 10 * 60 * 1000
const RETURN_PATH_MAX = 512
// How long sign-in waits to learn whether the person is a member. The answer only decides a display hint (nav
// links, the Join / Open Discord button); the server enforces every real gate itself. So a slow answer is
// treated like a failed one (not a member) instead of holding sign-in open.
const MEMBERSHIP_WAIT_MS = 3000
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

/**
 * `p` if it is a path on this site ("/" then neither "/" nor "\", no whitespace, at most 512 characters),
 * else null. The return path is replayed into the address bar after sign-in, so anything that could name
 * another origin ("//host", "https://…", a backslash, or a tab or newline the URL parser would strip) must
 * never pass, whether it came from a caller, from sessionStorage or from localStorage.
 */
export function sanitizeReturnPath(p) {
  if (typeof p !== 'string' || p.length > RETURN_PATH_MAX) return null
  return /^\/(?!\/)[^\s\\]*$/.test(p) ? p : null
}

// Best effort: storage can be full or blocked (a private tab), and that must never stop sign-in itself.
function writeFallback(path) {
  try {
    localStorage.setItem(RETURN_FALLBACK_KEY, JSON.stringify({ path, at: Date.now() }))
  } catch {
    // The session copy still works wherever the redirect comes back to the same tab.
  }
}

/** The fallback path if there is one that is recent and sane (a string stamp, never from the future), else null. */
function readFallback() {
  try {
    const { path, at } = JSON.parse(localStorage.getItem(RETURN_FALLBACK_KEY))
    const age = Date.now() - at
    return typeof at === 'number' && age >= 0 && age <= RETURN_FALLBACK_MS ? sanitizeReturnPath(path) : null
  } catch {
    return null
  }
}

/** options.returnTo: the page to come back to, if it is a path on this site; otherwise the page sign-in started from. */
export function beginSignIn(options) {
  const path = sanitizeReturnPath(options?.returnTo) ?? window.location.pathname + window.location.search
  sessionStorage.setItem(RETURN_PATH_KEY, path)
  writeFallback(path)
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
  // The session copy if it is sane, else the fallback; both are cleared whether or not they were used.
  const returnPath = sanitizeReturnPath(sessionStorage.getItem(RETURN_PATH_KEY)) ?? readFallback()
  sessionStorage.removeItem(RETURN_PATH_KEY)
  localStorage.removeItem(RETURN_FALLBACK_KEY)
  history.replaceState(null, '', returnPath || window.location.pathname + window.location.search)
}

/**
 * Whether the server says this token's owner is a chapter member: true or false, never a throw. A failed answer
 * (refused token, Discord unreachable, network down) and one that takes longer than MEMBERSHIP_WAIT_MS both read
 * as false. A late answer is ignored; Promise.race has already subscribed to the call, so a late failure is
 * handled too.
 */
async function askMembership(token) {
  let timer
  const tooSlow = new Promise((resolve) => {
    timer = setTimeout(resolve, MEMBERSHIP_WAIT_MS, false)
  })
  try {
    return await Promise.race([getMembership(token), tooSlow])
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
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
    const isMember = await askMembership(token)
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        id: user.id,
        username: user.username,
        isMember,
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
