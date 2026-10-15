<script setup>
// Holds High Command's place, at about the height of the panel, while the roster
// code and data arrive, so the chips and the story under it do not jump when the
// panel appears. Decorative: nothing to read, so it is hidden from assistive tech.
// It stands in for the panel (and for its props) as an async component's loading
// state, so it takes nothing from the caller but a class.
defineOptions({ inheritAttrs: false })
</script>

<template>
  <div class="rs-hc-loading surface" :class="$attrs.class" aria-hidden="true" />
</template>

<style scoped>
/* Measured on the fixture: the panel is 229px on a wide screen and 473px under 800px, where its two columns stack. */
.rs-hc-loading {
  min-height: 14.3rem;
  border-radius: 3px;
}
@media (max-width: 800px) {
  .rs-hc-loading {
    min-height: 29.6rem;
  }
}
</style>
