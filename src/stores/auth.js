import { defineStore } from 'pinia'
import * as discordAuth from '../lib/discordAuth'
import { useArchive } from './archive'
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
    token: () => discordAuth.getAccessToken(),
  },
  actions: {
    signIn() {
      // Nav bar or archive gate alike: keep a Legion Archive message anchor
      // across the Discord round-trip (a no-op anywhere else).
      stashAnchor(window.location.pathname, window.location.hash)
      discordAuth.beginSignIn()
    },
    signOut() {
      discordAuth.signOut()
      this.member = null
      // Wherever sign-out happens, drop the Legion Archive key, decrypted
      // content and blob URLs with it — not only when an archive page is open.
      useArchive().reset()
    },
  },
})
