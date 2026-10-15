import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { useAuth } from '../stores/auth'
import { useRoster } from '../stores/roster'
import { useRosterPublic } from '../stores/rosterPublic'
import { useRosterPolling } from './useRosterPolling'

const UNAVAILABLE = 'The live roster is unavailable. Showing the public view.'

/**
 * Which roster the Companies page shows, and keeping it fresh.
 *
 * A signed-in Legion member gets the full roster (member store), refreshed every
 * minute. Everyone else, and a member whose load is refused or has failed with
 * nothing on screen, gets the public view (public store), fetched once and never
 * polled. A refusal (signed out, 401, 403) stops the polling: there is nothing
 * to retry, and the page is public now, so it must not ask every minute. A server
 * hiccup keeps polling, so the full view takes over when the server is back.
 *
 * `infirmaryOpen` is a ref the page owns; the Infirmary list is refreshed with
 * the roster while it is true. The page calls start() once mounted. The polling
 * also ends when the host component goes away.
 */
export function useCompanyRoster({ infirmaryOpen }) {
  const auth = useAuth()
  const store = useRoster()
  const pub = useRosterPublic()
  const decided = shallowRef(false)
  let started = false

  const mode = computed(() => (store.roster ? 'full' : pub.snapshot ? 'public' : 'none'))
  // nothing to show yet, and still working out what to show
  const loading = computed(() => mode.value === 'none' && !decided.value)
  const view = computed(() => (mode.value === 'full' ? store.view : mode.value === 'public' ? pub.view : null))
  const note = computed(() => (!store.roster && store.status === 'error' && pub.snapshot ? UNAVAILABLE : ''))
  const updated = computed(() => (store.roster ? new Date(store.roster.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''))
  const stale = computed(() => Boolean(store.roster?.stale))

  // The token to send, or none when signed out. Not just auth.token: that store getter has nothing reactive
  // in it, so it caches its first value and after signOut() still hands back the old, still valid token,
  // which would bring the full roster back for someone who just signed out.
  const tokenNow = () => (auth.member ? auth.token : null)
  const loadInfirmary = () => store.loadInfirmary(tokenNow())

  // Returned, so the polling chain waits for the requests: a slow one must not be overtaken by the next tick.
  const loadMember = () => Promise.all([store.load(tokenNow()), infirmaryOpen.value ? loadInfirmary() : null]).then(() => {})

  async function tick() {
    await loadMember()
    if (!store.roster) {
      if (store.status !== 'error') polling.stop() // refused: nothing to retry
      if (!pub.snapshot) await pub.load()
    }
    decided.value = true
  }
  const polling = useRosterPolling({ load: tick })

  function start() {
    started = true
    polling.start()
  }
  function stop() {
    started = false
    polling.stop()
  }

  // Signing out is the one same-page change (signing in is a full-page redirect): decide again.
  watch(
    () => auth.member,
    () => {
      if (!started) return
      decided.value = false
      polling.stop()
      polling.start()
    },
  )
  onScopeDispose(stop, true)

  return { mode, loading, view, store, note, updated, stale, start, stop, loadMember, loadInfirmary }
}
