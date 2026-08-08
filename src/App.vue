<script setup>
import { defineAsyncComponent } from 'vue'
import AppNav from './components/AppNav.vue'
import MountDeathfire from './components/MountDeathfire.vue'
import { tuningEnabled } from './lib/fireTuning'

// Dev-only slider panel, loaded only when ?tune=1 is present.
const tuning = tuningEnabled()
const FireTuner = tuning ? defineAsyncComponent(() => import('./components/FireTuner.vue')) : null

const DISCORD = 'https://discord.gg/salamanders'
const year = new Date().getFullYear()
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

  <footer class="site-footer">
    <div class="footer-inner">
      <div class="footer-col">
        <p class="footer-mark">Salamanders</p>
        <p class="footer-motto">Into the fires of battle, unto the anvil of war.</p>
      </div>
      <div class="footer-col footer-links">
        <RouterLink to="/planner">Perk Builder</RouterLink>
        <RouterLink to="/armoury">Armoury</RouterLink>
        <RouterLink to="/builds">Builds</RouterLink>
        <RouterLink to="/companies">Companies</RouterLink>
        <a :href="DISCORD" target="_blank" rel="noopener">Discord</a>
      </div>
    </div>
    <div class="rule-forge" />
    <p class="footer-fine">
      © {{ year }} Salamanders clan · A fan-run community for Warhammer 40,000: Space
      Marine 2. Not affiliated with or endorsed by Games Workshop or Focus Entertainment.
    </p>
  </footer>
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
.site-footer {
  margin-top: 4rem;
  border-top: 1px solid var(--color-ash);
  background: rgba(7, 17, 13, 0.6);
}
.footer-inner {
  max-width: 76rem;
  margin: 0 auto;
  padding: 2.5rem 1.5rem 1.5rem;
  display: flex;
  gap: 2rem;
  flex-wrap: wrap;
  justify-content: space-between;
}
.footer-mark {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.16em;
  font-weight: 700;
  font-size: 1.1rem;
  color: var(--color-bone);
}
.footer-motto {
  color: var(--color-smoke);
  font-style: italic;
  margin-top: 0.35rem;
  font-size: 0.9rem;
}
.footer-links {
  display: flex;
  gap: 1.1rem;
  align-items: flex-start;
  flex-wrap: wrap;
}
.footer-links a {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.82rem;
  color: var(--color-smoke);
}
.footer-links a:hover {
  color: var(--color-drake);
}
.footer-fine {
  max-width: 76rem;
  margin: 1rem auto 0;
  padding: 1rem 1.5rem 2rem;
  color: #5f6f66;
  font-size: 0.72rem;
  line-height: 1.5;
}

@media (prefers-reduced-motion: reduce) {
  main > * {
    animation: none;
  }
}
</style>
