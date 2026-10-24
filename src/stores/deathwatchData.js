import { defineStore } from 'pinia'
import { getData, writeDoc } from '../lib/deathwatch/api'
import { clone } from '../lib/deathwatch/tracker'

// The Deathwatch area's documents (GET /deathwatch/data): teams (the live event), cfg (s: scoring weights,
// tx: page texts) and archive (finished events). Held in memory only; sign-out drops them. The views poll it
// (useTracker.js): with the last ETag, so an unchanged event costs the server a 304 and no body. Writes go to the
// server one document at a time (Watch Commander only, and the server checks that itself), land here at once,
// and are followed by a refetch so the page shows what the server holds. Statuses: idle, loading, ready, error.

let seq = 0

// Fixture mode (VITE_DEATHWATCH_FIXTURE, dev only): invented data and in-memory writes, no server; ?scene=empty
// gives an area with no data at all. The literal condition lets the build drop the fixture, as in fixture.js.
async function fixture() {
  if (import.meta.env.DEV && import.meta.env.VITE_DEATHWATCH_FIXTURE) {
    const scene = new URLSearchParams(globalThis.location?.search ?? '').get('scene')
    return (await import('../lib/deathwatch/fixtureData')).fixtureData(scene)
  }
  return null
}

export const useDeathwatchData = defineStore('deathwatchData', {
  state: () => ({ status: 'idle', error: '', teams: {}, cfg: {}, archive: {}, etag: '', local: false }),
  actions: {
    /** Fetches everything, or nothing if the server says it is unchanged. A fixture loads once. */
    async load(token) {
      if (this.local) return
      const mine = ++seq
      if (this.status !== 'ready') this.status = 'loading'
      try {
        const fx = await fixture()
        const got = fx ? { data: fx, etag: '' } : await getData(token, this.etag)
        if (mine !== seq) return
        if (got) {
          const { teams = {}, cfg = {}, archive = {} } = got.data ?? {}
          this.$patch({ teams, cfg, archive, etag: got.etag ?? '', local: !!fx })
        }
        this.$patch({ status: 'ready', error: '' })
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
      if (!this.local) this.load(token) // not awaited: the change is already on screen
    },

    reset() {
      seq++
      this.$reset()
    },
  },
})
