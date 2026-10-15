<script setup>
// Holds a Ranks bar's place, at about the height of a collapsed one, while the
// roster code and data arrive, so the story under it does not jump when the bar
// appears. Decorative: nothing to read, so it is hidden from assistive tech.
// It stands in for the bar (and for its props) as an async component's loading
// state, so it takes nothing from the caller.
defineOptions({ inheritAttrs: false })
</script>

<template>
  <div class="rs-ranks-loading surface" aria-hidden="true" />
</template>

<style scoped>
/* Measured on the fixture: a collapsed bar is 74-80px on a wide screen, and 100-146px on a phone, where the head wraps. */
.rs-ranks-loading {
  min-height: 5rem;
  border-radius: 3px;
}
@media (max-width: 760px) {
  .rs-ranks-loading {
    min-height: 6.5rem;
  }
}
</style>
