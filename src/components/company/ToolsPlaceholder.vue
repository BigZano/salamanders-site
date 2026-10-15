<script setup>
// Holds the members' toolbar's place (the status line and the Find me, Expand all
// and Infirmary buttons) while the roster arrives, for a visitor the Legion list
// knows (auth.member.isMember) and so probably about to get it. Without it the toolbar pops in above everything
// and shoves the page down. Decorative, and it takes nothing from the caller.
defineOptions({ inheritAttrs: false })
</script>

<template>
  <div class="rs-tools-loading" aria-hidden="true" />
</template>

<style scoped>
/* Measured on the fixture, as the page moves when the real toolbar replaces this: 116px on a wide screen, 245px on a phone, where it wraps. */
.rs-tools-loading {
  min-height: 7.25rem;
}
@media (max-width: 600px) {
  .rs-tools-loading {
    min-height: 15.3rem;
  }
}
</style>
