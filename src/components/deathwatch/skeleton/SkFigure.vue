<script setup>
// A tall framed placeholder for a figure (the Armouring Hall's armour study) before its image exists.
</script>

<template>
  <div class="sk-figure" aria-hidden="true">
    <span class="dw-sk-bar sk-head" />
    <span class="dw-sk-bar sk-body" />
  </div>
</template>

<style scoped>
.sk-figure {
  display: grid;
  justify-items: center;
  align-content: center;
  gap: 1rem;
  min-height: 18rem;
  border: 1px solid var(--dw-line);
  background: color-mix(in oklab, var(--dw-surface) 70%, transparent);
}
.sk-head {
  width: 5rem;
  height: 5rem;
  border-radius: 50%;
}
.sk-body {
  width: 9rem;
  height: 7rem;
}
</style>
