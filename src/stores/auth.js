import { defineStore } from 'pinia'
import * as discordAuth from '../lib/discordAuth'
import { useArchive } from './archive'
import { useRoster } from './roster'
import { useDeathwatch } from './deathwatch'
import { useDeathwatchData } from './deathwatchData'
import { stashAnchor } from '../lib/archive/anchor'

// Thin reactive wrapper around discordAuth.js. Sign-in itself is a full-page
// redirect (implicit grant), so state is correct at mount time by construction
// — main.js awaits finishSignIn() before the app mounts. Sign-out is the only
// same-page transition, so it's the only action that needs to update state.
export const useAuth = defineStore('auth', {
  state: () => ({
    member: discordAuth.currentMember(),
  }),
  getters: {
    signedIn: (s) => !!s.member,
    // A getter caches. The storage read inside it is not reactive, so on its own this returned the first
    // token it was asked for for the life of the page, and after signOut() still the old one. Depending on
    // `member` (which signOut() clears) makes it recompute then, and give null.
    token: (s) => (s.member ? discordAuth.getAccessToken() : null),
  },
  actions: {
    // options.returnTo: a path on this site to come back to (see discordAuth.beginSignIn); by default, this page.
    signIn(options) {
      // Nav bar or archive gate alike: keep a Legion Archive message anchor
      // across the Discord round-trip (a no-op anywhere else).
      stashAnchor(window.location.pathname, window.location.hash)
      discordAuth.beginSignIn(options)
    },
    signOut() {
      discordAuth.signOut()
      this.member = null
      // Wherever sign-out happens, drop the Legion Archive key, decrypted
      // content and blob URLs with it — not only when an archive page is open.
      useArchive().reset()
      // Likewise the roster (and Infirmary list), held in memory only.
      useRoster().reset()
      // And the Deathwatch clearance: signed out means no access, even for a page that stays open.
      useDeathwatch().reset()
      useDeathwatchData().reset()
    },
  },
})
