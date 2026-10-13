import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import * as api from '../lib/rosterApi'
import { loadFixture } from '../lib/rosterFixture'

// One counter per kind of load: a response only lands if no later call (or
// reset) has started since, so a slow answer can never overwrite a newer one.
let rosterSeq = 0
let infirmarySeq = 0

const statusOf = (err) => (err?.status === 401 ? 'signin' : err?.status === 403 ? 'denied' : 'error')
const messageOf = (err) => err?.message || 'Could not reach the roster server.'

export const useRoster = defineStore('roster', {
  // Server responses are wholesale-replaced snapshots, never edited in place.
  state: () => ({ status: 'idle', roster: null, infirmaryStatus: 'idle', infirmary: null, message: '' }),
  actions: {
    async load(token) {
      const mine = ++rosterSeq
      const fixture = await loadFixture()
      if (mine !== rosterSeq) return
      if (fixture?.status) {
        // A dev "state" scene (loading, signin, denied, error): show that state, with no roster.
        infirmarySeq++
        this.$patch({ status: fixture.status, message: fixture.message ?? '', roster: null, infirmary: null, infirmaryStatus: 'idle' })
        return
      }
      if (!fixture && !token) {
        // Signed out: keep nothing, and let no in-flight response bring anything back.
        infirmarySeq++
        this.$patch({ status: 'signin', roster: null, infirmary: null, infirmaryStatus: 'idle' })
        return
      }
      if (!this.roster) this.status = 'loading'
      try {
        const data = fixture ? fixture.roster : await api.getRoster(token)
        if (mine !== rosterSeq) return
        this.roster = markRaw(data)
        this.status = 'ready'
        this.message = ''
      } catch (err) {
        if (mine !== rosterSeq) return
        this.status = statusOf(err)
        this.message = messageOf(err)
        // A refused caller keeps nothing; a server hiccup keeps the last copy on screen.
        if (this.status !== 'error') {
          infirmarySeq++
          this.roster = null
          this.infirmary = null
          this.infirmaryStatus = 'idle'
        }
      }
    },

    async loadInfirmary(token) {
      const mine = ++infirmarySeq
      const fixture = await loadFixture()
      if (mine !== infirmarySeq) return
      if (fixture?.status) return // a state scene has no Infirmary list
      try {
        const data = fixture ? fixture.infirmary : await api.getInfirmary(token)
        if (mine !== infirmarySeq) return
        this.infirmary = markRaw(data)
        this.infirmaryStatus = 'ready'
      } catch (err) {
        if (mine !== infirmarySeq) return
        this.infirmaryStatus = statusOf(err)
        // Refused (401/403) keeps nothing; a server hiccup keeps the last list.
        if (this.infirmaryStatus !== 'error') this.infirmary = null
      }
    },

    reset() {
      rosterSeq++
      infirmarySeq++
      this.$patch({ status: 'idle', roster: null, infirmaryStatus: 'idle', infirmary: null, message: '' })
    },
  },
})
