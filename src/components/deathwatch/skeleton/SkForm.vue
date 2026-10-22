<script setup>
// The shape of a form before it exists: each field's real label over a placeholder box. Nothing here can be
// typed into or pressed: a skeleton only shows where things will go.
defineProps({
  fields: { type: Array, required: true },
})
</script>

<template>
  <div class="sk-form">
    <div v-for="(field, i) in fields" :key="i" class="sk-field">
      <span class="sk-label">{{ field }}</span>
      <span class="sk-input" aria-hidden="true"><span class="dw-sk-bar" /></span>
    </div>
  </div>
</template>

<style scoped>
.sk-form {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
  gap: 0.9rem 1rem;
}
.sk-field {
  display: grid;
  gap: 0.35rem;
}
.sk-label {
  font: 600 0.8rem / 1.2 var(--dw-font-cond);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--dw-muted);
}
.sk-input {
  display: block;
  padding: 0.75rem 0.8rem;
  border: 1px solid var(--dw-line-2);
  background: color-mix(in oklab, var(--dw-surface) 85%, transparent);
}
.sk-input .dw-sk-bar {
  width: 50%;
}
</style>
