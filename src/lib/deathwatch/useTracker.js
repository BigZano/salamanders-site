// What every Event Tracker and Manage view needs: the data (polled every 15 seconds while the view is open and the
// tab is visible), the event worked out from it, the current weights, and links between the views that keep a dev
// ?scene= on the address.
import { computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { useAuth } from '../../stores/auth'
import { useDeathwatchData } from '../../stores/deathwatchData'
import { useRosterPolling } from '../useRosterPolling'
import { DEFAULT_EVENT_NAME, calc, weightsOf } from './tracker'

const BASE = '/deathwatch/eventtracker'
export const POLL_MS = 15_000

export function useTracker() {
  const auth = useAuth()
  const data = useDeathwatchData()
  const route = useRoute()
  // The roster's loop: one timer chain, skipped while the tab is hidden, and a refresh on return if it is due.
  const poll = useRosterPolling({ load: () => data.load(auth.token), intervalMs: POLL_MS })
  onMounted(poll.start)
  onUnmounted(poll.stop)

  const scene = () => (route.query.scene ? { scene: route.query.scene } : {})
  const R = computed(() => calc(data.teams, data.cfg.s))
  return {
    data,
    R,
    S: computed(() => weightsOf(data.cfg.s)),
    eventName: computed(() => data.cfg.tx?.cur_n || DEFAULT_EVENT_NAME),
    /** Sets (doc) or deletes (null) one document. Throws the server's message. */
    save: (col, id, doc) => data.write(auth.token, col, id, doc),
    reload: () => data.load(auth.token),
    /** Links into the live event's views. */
    live: {
      team: (id) => ({ path: `${BASE}/kill-teams`, query: { ...scene(), t: String(id) } }),
      player: (n) => ({ path: `${BASE}/players`, query: { ...scene(), p: n } }),
      players: () => ({ path: `${BASE}/players`, query: scene() }),
    },
    /** Links inside one archived event (v: the view, t: a Kill Team, p: a player). */
    archived: (e) => ({
      view: (v) => ({ path: `${BASE}/archive`, query: { ...scene(), e, ...(v === 'standings' ? {} : { v }) } }),
      team: (id) => ({ path: `${BASE}/archive`, query: { ...scene(), e, v: 'kill-teams', t: String(id) } }),
      player: (n) => ({ path: `${BASE}/archive`, query: { ...scene(), e, v: 'players', p: n } }),
      players: () => ({ path: `${BASE}/archive`, query: { ...scene(), e, v: 'players' } }),
    }),
    all: () => ({ path: `${BASE}/archive`, query: scene() }),
  }
}
