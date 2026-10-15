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
/* Measured on the live roster (2026-10-15): the panel is 309-316px on a wide screen and 553px under 800px,
   where its two columns stack. (The fixture's smaller court gave 229px and 473px, which left the real
   panel 80px taller than its placeholder.) The real height follows who holds High Command, so this is a
   close estimate, not a promise; the page's deep-link scroll does not depend on it being exact. */
.rs-hc-loading {
  min-height: 19.5rem;
  border-radius: 3px;
}
@media (max-width: 800px) {
  .rs-hc-loading {
    min-height: 34.6rem;
  }
}
</style>
