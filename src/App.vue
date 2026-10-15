<script setup>
import { defineAsyncComponent } from 'vue'
import AppNav from './components/AppNav.vue'
import SiteFooter from './components/SiteFooter.vue'
import MountDeathfire from './components/MountDeathfire.vue'
import { tuningEnabled } from './lib/fireTuning'

// Dev-only slider panel, loaded only when ?tune=1 is present.
const tuning = tuningEnabled()
const FireTuner = tuning ? defineAsyncComponent(() => import('./components/FireTuner.vue')) : null
</script>

<template>
  <!-- Mount Deathfire behind every page; each route gets its own face of it. -->
  <MountDeathfire />
  <component :is="FireTuner" v-if="tuning" />

  <AppNav />

  <main>
    <!--
      No <Transition> around the view. `mode="out-in"` deadlocked here: on a cold
      load of a lazy route the outgoing child is a comment placeholder that never
      fires a transition end, so the incoming view never mounted (every route but
      "/" rendered blank). The enter animation below gives the same feel with no
      dependency on a leave completing.
    -->
    <RouterView />
  </main>

  <SiteFooter />
</template>

<style scoped>
main {
  min-height: 60svh;
}
/* Route enter animation — replaces the old RouterView transition. Each route's
   root element is a fresh node, so this replays on every navigation. */
main > * {
  animation: view-in 0.22s ease-out both;
}
@keyframes view-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
@media (prefers-reduced-motion: reduce) {
  main > * {
    animation: none;
  }
}
</style>
