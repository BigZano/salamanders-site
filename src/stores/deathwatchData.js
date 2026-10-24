import { defineStore } from 'pinia'
import { getData, writeDoc } from '../lib/deathwatch/api'
import { clone } from '../lib/deathwatch/tracker'

// The Deathwatch area's documents (GET /deathwatch/data): teams (the live event), cfg (s: scoring weights,
// tx: page texts) and archive (finished events). Held in memory only; sign-out drops them. Writes go to the server
// one document at a time (Watch Commander only, and the server checks that itself) and land here once it has
// accepted them. Statuses: idle, loading, ready, error.
// shortcut: no polling; the data is fetched on the first Event Tracker or Manage view and again after a minute
// on the next one. Add ETag polling (the server already sends one) if the views must follow a live event.

const STALE_MS = 60_000
let seq = 0

// Fixture mode (VITE_DEATHWATCH_FIXTURE, dev only): invented data and in-memory writes, no server. The literal
// condition lets the build drop the fixture, as in fixture.js.
async function fixture() {
  if (import.meta.env.DEV && import.meta.env.VITE_DEATHWATCH_FIXTURE) return (await import('../lib/deathwatch/fixtureData')).fixtureData()
  return null
}

export const useDeathwatchData = defineStore('deathwatchData', {
  state: () => ({ status: 'idle', error: '', teams: {}, cfg: {}, archive: {}, at: 0, local: false }),
  actions: {
    /** Fetches everything, unless it is fresh already (force: always). */
    async load(token, { force = false } = {}) {
      if (!force && this.status === 'ready' && Date.now() - this.at < STALE_MS) return
      const mine = ++seq
      if (this.status !== 'ready') this.status = 'loading'
      try {
        const fx = await fixture()
        const d = fx ?? (await getData(token))
        if (mine !== seq) return
        this.$patch({ status: 'ready', error: '', teams: d.teams ?? {}, cfg: d.cfg ?? {}, archive: d.archive ?? {}, at: Date.now(), local: !!fx })
      } catch (err) {
        if (mine !== seq) return
        // A refresh that fails keeps what is on screen; only a first load turns into an error.
        if (this.status !== 'ready') this.$patch({ status: 'error', error: err?.message || 'The data could not be loaded.' })
      }
    },

    /** Sets (doc) or deletes (null) one document, on the server first, then here. Throws what the server said. */
    async write(token, col, id, doc) {
      if (!this.local) await writeDoc(token, col, id, doc)
      const next = { ...this[col] }
      if (doc === null) delete next[id]
      else next[id] = clone(doc)
      this[col] = next
    },

    reset() {
      seq++
      this.$reset()
    },
  },
})
