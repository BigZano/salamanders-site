import { defineStore } from 'pinia'
import * as discordAuth from '../lib/discordAuth'
import { useArchive } from './archive'
import { useRoster } from './roster'
import { useDeathwatch } from './deathwatch'
import { useDeathwatchData } from './deathwatchData'
import { useLibrarius } from './librarius'
import { stashAnchor } from '../lib/archive/anchor'
import { forgetPlaces } from '../lib/librarius/places'
import { clearAllDrafts, draftStorage } from '../lib/librarius/composer'

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
      // The Librarius too: the forum's posts and messages are for the person who was signed in, not the next one.
      useLibrarius().reset()
      // And where they were in each post, which is the last reader's own reading and is kept per tab.
      forgetPlaces()
      // And the replies they had begun, kept as drafts in this browser: the next person to sign in here is not them.
      clearAllDrafts(draftStorage())
    },
    // The server no longer takes the sign-in: a read of the Librarius was answered 401 (the token has run out, or was revoked). The
    // reader is signed out as signOut() does it, so that the pages ask them to sign in again instead of losing what they showed
    // without a word, and what they had under way in this browser is kept for when they are back: their drafts and their place in
    // each post. It was the server that let them go, not someone else who took their seat.
    expire() {
      discordAuth.signOut()
      this.member = null
      useArchive().reset()
      useRoster().reset()
      useDeathwatch().reset()
      useDeathwatchData().reset()
      useLibrarius().reset()
    },
    // Keeps the server's latest answer about whether this person may read the Librarius (see discordAuth.rememberLibrarius),
    // so that the nav links show the Reliquarium to someone who signed in before they were let in, and stop showing it when
    // they no longer are. The member is replaced only when the answer is news: the page that asks does so on every visit,
    // and whatever watches `member` (the nav bar asks for the reader's privileges again) starts over when it is replaced.
    noteLibrarius(access) {
      discordAuth.rememberLibrarius(access)
      const member = discordAuth.currentMember()
      if (member?.librarius !== this.member?.librarius) this.member = member
    },
  },
})
