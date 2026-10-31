import { ref, shallowRef, watch } from 'vue'
import { useAuth } from '../stores/auth'
import { getCompanyNotables } from './buildsApi'

/**
 * The Companies page's Notable Server Members. They are real members' names, so they are not in the site: the
 * server sends them to a signed-in guild member and to nobody else. They are held in memory only (never in
 * localStorage or sessionStorage) and dropped the moment the member signs out.
 *
 * state: 'denied'  signed out (nothing is asked), or the server says this person is not a guild member (403)
 *        'expired' still looks signed in, but the Discord token has run out (nothing is asked) or the server no
 *                  longer takes it (401): only signing in again helps
 *        'loading' asking the server
 *        'ready'   the answer is in; entriesFor(id) gives a company's cards
 *        'error'   the server could not be reached or failed
 * The membership flag stored at sign-in decides nothing here: it can be days old, and a slow answer at sign-in stores
 * false. Anyone with a live token is asked about, and the server's live check is the only gate.
 */
export function useCompanyNotables() {
  const auth = useAuth()
  const state = ref(null) // undecided: the immediate watch below decides it before anything can read it
  const byCompany = shallowRef(null)
  let current // the load that may still answer: a slow one must not overwrite a newer decision (signing out)

  async function load() {
    const mine = (current = Symbol())
    byCompany.value = null
    if (!auth.member) {
      state.value = 'denied'
      return
    }
    if (!auth.token) {
      state.value = 'expired'
      return
    }
    state.value = 'loading'
    try {
      const companies = await getCompanyNotables(auth.token)
      if (mine !== current) return
      byCompany.value = companies
      state.value = 'ready'
    } catch (err) {
      if (mine !== current) return
      const status = err?.status
      state.value = status === 401 ? 'expired' : status === 403 ? 'denied' : 'error'
    }
  }

  // Signing in is a full-page redirect, so this runs once on load; signing out is the same-page change.
  watch(() => [auth.token, auth.member], load, { immediate: true })

  /** A company's cards as [name, ...lines] lists, or null when there are none to show. */
  function entriesFor(id) {
    const map = byCompany.value // set only together with state 'ready', and cleared at the start of every load
    if (map === null || !Object.hasOwn(map, id) || !Array.isArray(map[id])) return null
    const entries = map[id].filter((m) => Array.isArray(m) && typeof m[0] === 'string')
    return entries.length ? entries : null
  }

  return { state, entriesFor }
}
