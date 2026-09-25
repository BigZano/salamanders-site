<script setup>
import { watch } from 'vue'
import { useAuth } from '../../stores/auth'
import { useArchive } from '../../stores/archive'
import { clearAnchor } from '../../lib/archive/anchor'
import ArchivePlaque from './ArchivePlaque.vue'

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
  <ArchivePlaque v-if="!auth.signedIn || archive.error === 'signed-out'" narrow>
    <div class="gate">
      <p class="gate-eyebrow">Legion Archive</p>
      <p>{{ COPY['signed-out'] }}</p>
      <button class="btn-ember gate-btn" type="button" @click="auth.signIn()">Sign in with Discord</button>
    </div>
  </ArchivePlaque>
  <div v-else-if="archive.status === 'ready'"><slot /></div>
  <ArchivePlaque v-else-if="archive.status === 'error'" narrow>
    <div class="gate" role="alert">
      <p class="gate-eyebrow">Legion Archive</p>
      <p>{{ COPY[archive.error] }}</p>
      <button v-if="archive.error === 'unavailable'" class="btn-ember gate-btn" type="button" @click="archive.retry(auth.token)">Try again</button>
      <button v-else-if="archive.error === 'outdated' || archive.error === 'integrity'" class="btn-ember gate-btn" type="button" @click="reload">Reload</button>
    </div>
  </ArchivePlaque>
  <ArchivePlaque v-else narrow>
    <div class="gate" aria-busy="true">
      <p class="gate-eyebrow">Legion Archive</p>
      <p class="gate-unsealing">Unsealing the archive…</p>
    </div>
  </ArchivePlaque>
</template>

<style scoped>
.gate { text-align: center; color: #c9cfc9; line-height: 1.6; }
.gate-eyebrow { font-family: var(--font-mono); font-size: 0.7rem; letter-spacing: 0.28em; text-transform: uppercase; color: var(--color-averland); margin: 0 0 1rem; }
.gate-btn { margin-top: 1.4rem; padding: 0.7rem 1.3rem; border-radius: 2px; }
/* The seal loosening: a slow ember pulse while the key and index load. */
.gate-unsealing { animation: gate-glow 1.6s ease-in-out infinite; }
@keyframes gate-glow { 50% { color: #ffb066; text-shadow: 0 0 12px rgba(255, 106, 43, 0.6); } }
@media (prefers-reduced-motion: reduce) { .gate-unsealing { animation: none; } }
</style>
