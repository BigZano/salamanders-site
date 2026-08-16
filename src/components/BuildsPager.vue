<script setup>
const props = defineProps({
  page: { type: Number, required: true },
  pageCount: { type: Number, required: true },
})
const emit = defineEmits(['update:page'])
</script>

<template>
  <div v-if="pageCount > 1" class="pager">
    <button class="pager-btn" :disabled="page <= 1" @click="emit('update:page', page - 1)">
      ‹ Prev
    </button>
    <span class="pager-label">Page {{ page }} of {{ pageCount }}</span>
    <button
      class="pager-btn"
      :disabled="page >= pageCount"
      @click="emit('update:page', page + 1)"
    >
      Next ›
    </button>
  </div>
</template>

<style scoped>
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  margin-top: 1.2rem;
}
.pager-btn {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.7rem;
  color: var(--color-smoke);
  background: transparent;
  border: 1px solid var(--color-ash);
  border-radius: 2px;
  padding: 0.4rem 0.8rem;
  cursor: pointer;
  transition: 0.12s;
}
.pager-btn:hover:not(:disabled) {
  color: var(--color-bone);
  border-color: var(--color-ash-2);
}
.pager-btn:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}
.pager-label {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: var(--color-smoke);
  min-width: 7rem;
  text-align: center;
}
</style>
