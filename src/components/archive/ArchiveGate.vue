<script setup>
import { watch } from 'vue'
import { useAuth } from '../../stores/auth'
import { useArchive } from '../../stores/archive'
import { clearAnchor } from '../../lib/archive/anchor'

const auth = useAuth()
const archive = useArchive()

watch(() => auth.signedIn, (signedIn) => { if (!signedIn) archive.reset() })
watch(() => [auth.signedIn, archive.status], () => {
  if (auth.signedIn && archive.status === 'idle') archive.load(auth.token)
}, { immediate: true })

// A sign-in that ends refused/failed must not leave an anchor that some
// later thread visit would pick up.
watch(() => archive.status, (st) => { if (st === 'error') clearAnchor() })
const reload = () => window.location.reload()
const COPY = {
  'signed-out': 'The Legion Archive is restricted to the XVIIIth Legion. Sign in with Discord to continue.',
  restricted: "Restricted to the XVIIIth Legion. Your Discord account doesn't currently hold the role.",
  unavailable: "The archive couldn't be reached. Try again in a moment.",
  outdated: 'This page is out of date. Reload to get the latest archive.',
  integrity: "The archive failed an integrity check and wasn't shown. Reload to try again.",
  unpublished: "The archive hasn't been published yet.",
}
</script>

<template>
  <div v-if="!auth.signedIn || archive.error === 'signed-out'" class="gate">
    <p>{{ COPY['signed-out'] }}</p>
    <button class="btn-ember gate-btn" type="button" @click="auth.signIn()">Sign in with Discord</button>
  </div>
  <div v-else-if="archive.status === 'ready'"><slot /></div>
  <div v-else-if="archive.status === 'error'" class="gate" role="alert">
    <p>{{ COPY[archive.error] }}</p>
    <button v-if="archive.error === 'unavailable'" class="btn-ember gate-btn" type="button" @click="archive.retry(auth.token)">Try again</button>
    <button v-else-if="archive.error === 'outdated' || archive.error === 'integrity'" class="btn-ember gate-btn" type="button" @click="reload">Reload</button>
  </div>
  <div v-else class="gate" aria-busy="true"><p>Unsealing the archive…</p></div>
</template>

<style scoped>
.gate { max-width: 34rem; margin: 5rem auto; padding: 0 1.25rem; text-align: center; color: var(--color-smoke); }
.gate-btn { margin-top: 1.2rem; padding: 0.7rem 1.3rem; border-radius: 2px; }
</style>
