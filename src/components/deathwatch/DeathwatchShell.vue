<script setup>
// The frame of every Deathwatch page: the scoped dark theme (deathwatch.css) and its backdrop around whatever
// the route shows. It is only ever loaded with the lazy /deathwatch routes, so the Cinzel font and these styles
// never reach another page.
import '@fontsource-variable/cinzel'
import './deathwatch.css'
</script>

<template>
  <div class="dw">
    <div class="dw-backdrop" aria-hidden="true" />
    <slot />
  </div>
</template>
