import { defineStore } from 'pinia'
import * as discordAuth from '../lib/discordAuth'

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
      discordAuth.beginSignIn()
    },
    signOut() {
      discordAuth.signOut()
      this.member = null
    },
  },
})
