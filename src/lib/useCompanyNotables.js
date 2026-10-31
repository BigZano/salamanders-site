import { ref, shallowRef, watch } from 'vue'
import { useAuth } from '../stores/auth'
import { getCompanyNotables } from './buildsApi'

/**
 * The Companies page's Notable Server Members. They are real members' names, so they are not in the site: the
 * server sends them to a signed-in guild member and to nobody else. They are held in memory only (never in
 * localStorage or sessionStorage) and dropped the moment the member signs out.
 *
 * state: 'denied'  signed out, or signed in but not a guild member: nothing is asked
 *        'loading' asking the server
 *        'ready'   the answer is in; entriesFor(id) gives a company's cards
 *        'error'   the server could not be reached or refused something it should not
 * A 401 or 403 is 'denied' too: the token went stale or the membership changed since the page knew.
 */
export function useCompanyNotables() {
  const auth = useAuth()
  const state = ref('denied')
  const byCompany = shallowRef(null)
  let latest = 0 // a slow answer must not overwrite a newer decision (signing out, signing in as someone else)

  async function load() {
    const mine = ++latest
    byCompany.value = null
    if (!auth.token || auth.member?.isMember !== true) {
      state.value = 'denied'
      return
    }
    state.value = 'loading'
    try {
      const companies = await getCompanyNotables(auth.token)
      if (mine !== latest) return
      byCompany.value = companies
      state.value = 'ready'
    } catch (err) {
      if (mine !== latest) return
      state.value = err?.status === 401 || err?.status === 403 ? 'denied' : 'error'
    }
  }

  // Signing in is a full-page redirect, so this runs once on load; signing out is the same-page change.
  watch(() => [auth.token, auth.member?.isMember], load, { immediate: true })

  /** A company's cards as [name, ...lines] lists, or null when there are none to show. */
  function entriesFor(id) {
    const map = byCompany.value // set only together with state 'ready', and cleared at the start of every load
    if (map === null || !Object.hasOwn(map, id) || !Array.isArray(map[id])) return null
    const entries = map[id].filter((m) => Array.isArray(m) && typeof m[0] === 'string')
    return entries.length ? entries : null
  }

  return { state, entriesFor }
}
