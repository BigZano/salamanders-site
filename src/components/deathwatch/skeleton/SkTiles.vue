<script setup>
// Labelled stat tiles: the real label of each, and a placeholder bar where its value will be.
defineProps({
  labels: { type: Array, required: true },
})
</script>

<template>
  <div class="sk-tiles">
    <div v-for="(label, i) in labels" :key="i" class="sk-tile">
      <p class="sk-label">{{ label }}</p>
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
