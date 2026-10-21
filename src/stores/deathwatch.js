import { defineStore } from 'pinia'
import { getMe } from '../lib/deathwatch/api'
import { loadFixture } from '../lib/deathwatch/fixture'

// Whether the signed-in user may see the Deathwatch area, and whether they are the Watch Commander: the
// answer to GET /deathwatch/me, nothing more. It only decides what to show; the server enforces every read
// and write again. Statuses: idle, checking, allowed, denied, signin, unavailable.

// One counter for every call: an answer lands only if no later load() or reset() has started since, so a
// slow response can never bring back a state the user has already left (sign-out resets).
let seq = 0

const statusOf = (err) => (err?.status === 401 ? 'signin' : err?.status === 403 ? 'denied' : 'unavailable')

export const useDeathwatch = defineStore('deathwatch', {
  state: () => ({ status: 'idle', commander: false }),
  actions: {
    async load(token) {
      const mine = ++seq
      const fixture = await loadFixture()
      if (mine !== seq) return
      if (fixture) {
        // A dev scene: show that state without asking the server.
        this.$patch({ status: fixture.status, commander: fixture.commander })
        return
      }
      if (!token) {
        this.$patch({ status: 'signin', commander: false })
        return
      }
      this.$patch({ status: 'checking', commander: false })
      try {
        const me = await getMe(token)
        if (mine !== seq) return
        // Only a plain `true` counts: anything else fails closed. A commander always has access.
        const allowed = me?.access === true
        this.$patch({ status: allowed ? 'allowed' : 'denied', commander: allowed && me.watchCommander === true })
      } catch (err) {
        if (mine !== seq) return
        this.$patch({ status: statusOf(err), commander: false })
      }
    },

    reset() {
      seq++
      this.$patch({ status: 'idle', commander: false })
    },
  },
})
