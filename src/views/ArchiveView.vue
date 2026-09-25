<script setup>
import { computed } from 'vue'
import { useArchive } from '../stores/archive'
import ArchiveGate from '../components/archive/ArchiveGate.vue'
import ArchiveThread from '../components/archive/ArchiveThread.vue'
import ArchivePlaque from '../components/archive/ArchivePlaque.vue'

const props = defineProps({ collectionKey: { type: String, required: true }, threadId: { type: String, default: null } })
const archive = useArchive()
const resolved = computed(() => {
  const col = archive.archive?.collections.get(props.collectionKey)
  if (!col) return null
  const id = props.threadId ?? col.tocThreadId
  return col.threads.has(id) ? id : null
})
</script>

<template>
  <ArchiveGate>
    <ArchiveThread v-if="resolved" :key="resolved" :collection-key="collectionKey" :thread-id="resolved" />
    <ArchivePlaque v-else narrow>
      <div class="arch-missing">
        <p class="arch-missing-eyebrow">Legion Archive</p>
        <p>That page isn't in the archive.</p>
        <RouterLink :to="`/${collectionKey}`" class="arch-missing-link">Back to the table of contents</RouterLink>
      </div>
    </ArchivePlaque>
  </ArchiveGate>
</template>

<style scoped>
.arch-missing { text-align: center; color: #c9cfc9; }
.arch-missing-eyebrow { font-family: var(--font-mono); font-size: 0.7rem; letter-spacing: 0.28em; text-transform: uppercase; color: var(--color-averland); margin: 0 0 1rem; }
.arch-missing-link { display: inline-block; margin-top: 0.9rem; color: var(--color-bone); text-decoration: underline; text-decoration-color: rgba(89, 214, 108, 0.5); text-underline-offset: 3px; }
.arch-missing-link:hover { color: #fff; text-decoration-color: var(--color-drake); }
</style>
