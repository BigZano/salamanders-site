<script setup>
import { computed } from 'vue'
import { useArchive } from '../stores/archive'
import ArchiveGate from '../components/archive/ArchiveGate.vue'
import ArchiveThread from '../components/archive/ArchiveThread.vue'

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
    <div v-else class="arch-missing">
      <p>That page isn't in the archive.</p>
      <RouterLink :to="`/${collectionKey}`" class="md-link">Back to the table of contents</RouterLink>
    </div>
  </ArchiveGate>
</template>

<style scoped>
.arch-missing { max-width: 34rem; margin: 5rem auto; text-align: center; color: var(--color-smoke); }
</style>
