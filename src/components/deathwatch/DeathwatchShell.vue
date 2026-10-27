<script setup>
// The frame of every Deathwatch page: the scoped dark theme (deathwatch.css) and its backdrop around whatever
// the route shows. It is only ever loaded with the lazy /deathwatch routes, so the fonts and these styles
// never reach another page. `data-area` says which area is showing (the hub, or one of the areas), and the
// stylesheet paints that area's backdrop from it.
import { computed, inject } from 'vue'
import { routeLocationKey } from 'vue-router'
import '@fontsource-variable/cinzel'
import '@fontsource-variable/teko'
import '@fontsource/barlow/latin-400.css'
import '@fontsource/barlow/latin-500.css'
import '@fontsource/barlow/latin-600.css'
import '@fontsource/barlow-condensed/latin-500.css'
import '@fontsource/barlow-condensed/latin-600.css'
import '@fontsource/barlow-condensed/latin-700.css'
import './deathwatch.css'
import { resolveArea } from '../../lib/deathwatch/areas'

// Not useRoute(): the shell is also mounted without a router (its own tests), where that would warn. The URL
// is untrusted, and resolveArea only accepts the known areas.
const route = inject(routeLocationKey, null)
const area = computed(() => resolveArea(route?.params)?.area ?? 'hub')
</script>

<template>
  <div class="dw" :data-area="area">
    <div class="dw-backdrop" aria-hidden="true" />
    <slot />
  </div>
</template>
