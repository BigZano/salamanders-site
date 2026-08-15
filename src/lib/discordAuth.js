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

function redirectUri() {
  return window.location.origin + window.location.pathname
}

export function beginSignIn() {
  const url = new URL('https://discord.com/oauth2/authorize')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'token')
  url.searchParams.set('scope', 'identify')
  url.searchParams.set('redirect_uri', redirectUri())
  window.location.href = url.toString()
}

export function currentMember() {
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

/**
 * Must run before Vue Router's hash history is constructed — createRouter()
 * reads location.hash at construction time (evaluated as a static import,
 * before anything in main.js's own body runs), so scrubbing the fragment
 * afterward is too late: the router has already latched onto the OAuth
 * token as a "route", failed to match it, and rendered the 404 with the
 * live token sitting in both the address bar and the page's own text.
 * Called synchronously from router.js, before createRouter().
 */
export function scrubCallbackHash() {
  const hash = window.location.hash
  // Discord doesn't guarantee param order in the fragment — token_type
  // often comes first — so check by substring, not prefix.
  if (!hash.includes('access_token=')) return
  pendingToken = new URLSearchParams(hash.slice(1)).get('access_token')
  history.replaceState(null, '', window.location.pathname + window.location.search)
}

/** Runs after scrubCallbackHash — does the actual identify + membership check. */
export async function finishSignIn() {
  if (!pendingToken) return
  const token = pendingToken
  pendingToken = null

  try {
    const res = await fetch('https://discord.com/api/users/@me', {
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
      }),
    )
  } catch {
    // Network hiccup — sign-in silently fails, user can retry.
  }
}
