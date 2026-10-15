import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import * as api from '../lib/rosterApi'
import { loadFixture } from '../lib/rosterFixture'
import { buildPublicView } from '../lib/rosterPublicView'

// One load at a time per store: a second call while one runs waits for it instead of asking again.
const running = new WeakMap()

/**
 * The public roster (GET /roster/public): fetched once per visit, never polled,
 * and never carrying anything the server did not choose to make public. The
 * member roster has its own store (roster.js); the page picks between them.
 */
export const useRosterPublic = defineStore('rosterPublic', {
  state: () => ({ status: 'idle', snapshot: null }),
  getters: {
    view: (state) => (state.snapshot ? buildPublicView(state.snapshot) : null),
  },
  actions: {
    load() {
      if (running.has(this)) return running.get(this)
      const run = this.fetchOnce().finally(() => running.delete(this))
      running.set(this, run)
      return run
    },

    async fetchOnce() {
      this.status = 'loading'
      try {
        const fixture = await loadFixture()
        let data
        if (fixture) {
          // Dev scenes: `undefined` is the "loading" scene (it never answers), `null` the "error" scene.
          if (fixture.public === undefined) return await new Promise(() => {})
          if (fixture.public === null) throw new Error('fixture error scene')
          data = fixture.public
        } else {
          data = await api.getPublicRoster()
        }
        this.snapshot = markRaw(data)
        this.status = 'ready'
      } catch {
        this.snapshot = null
        this.status = 'error'
      }
    },
  },
})
