<script setup>
// Stat tiles: the real label of each, and a placeholder bar where its value will be. Where the original's
// label is not a fixed word (it was a name or a date), give a `count` instead: the tiles then have no label.
import { computed } from 'vue'

const props = defineProps({
  labels: { type: Array, default: () => [] },
  count: { type: Number, default: 0 },
})
const tiles = computed(() => (props.labels.length ? props.labels : Array(props.count).fill('')))
</script>

<template>
  <div class="sk-tiles">
    <div v-for="(label, i) in tiles" :key="i" class="sk-tile">
      <p v-if="label" class="sk-label">{{ label }}</p>
      <span class="dw-sk-bar sk-value" aria-hidden="true" />
    </div>
  </div>
</template>

<style scoped>
.sk-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
  gap: 0.75rem;
}
.sk-tile {
  padding: 0.8rem 1rem 1rem;
  border: 1px solid var(--dw-line-2);
  background: color-mix(in oklab, var(--dw-surface) 80%, transparent);
}
.sk-label {
  margin: 0 0 0.7rem;
  font: 600 0.8rem / 1.2 var(--dw-font-cond);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--dw-muted);
}
.sk-value {
  height: 1.6rem;
  width: 60%;
}
</style>
