<script setup>
// Holds a Ranks bar's place, at about the height of a collapsed one, while the
// roster code and data arrive, so the story under it does not jump when the bar
// appears. Decorative: nothing to read, so it is hidden from assistive tech.
</script>

<template>
  <div class="rs-ranks-loading surface" aria-hidden="true" />
</template>

<style scoped>
.rs-ranks-loading {
  min-height: 5rem;
  border-radius: 3px;
}
</style>
