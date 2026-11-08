<script setup>
import { ref, defineAsyncComponent } from 'vue'
import { tuningEnabled } from '../../lib/fireTuning'
import { useForge } from '../../composables/useForge'
import ForgeTime from '../../components/dev/ForgeTime.vue'
import ForgeSky from '../../components/dev/ForgeSky.vue'
import ForgePerf from '../../components/dev/ForgePerf.vue'
import ForgePresets from '../../components/dev/ForgePresets.vue'
import ForgeGrid from '../../components/dev/ForgeGrid.vue'
import ForgeRefs from '../../components/dev/ForgeRefs.vue'
import ForgeSim from '../../components/dev/ForgeSim.vue'

/**
 * The forge playground, /dev/forge, dev only: the volcano behind, a rail of controls on the left, the fire tuner
 * on the right, and a main area that is empty (Live: look at the volcano), a grid of viewports, the references, or
 * the lava's heat simulation (Sim).
 * Nothing here ships: the route exists only under `import.meta.env.DEV`.
 */
const { snap } = useForge()
const tab = ref('live')
const snapName = ref('hero')
const note = ref('')
const grid = ref(null)
// App.vue already renders the tuner when ?tune=1 is set; render our own only when it does not
const FireTuner = tuningEnabled() ? null : defineAsyncComponent(() => import('../../components/FireTuner.vue'))

async function snapLive() {
  try {
    note.value = `wrote ${await snap(snapName.value)}`
  } catch (e) {
    note.value = String(e.message)
  }
}
</script>

<template>
  <div class="forge" :class="`forge-${tab}`">
    <aside class="fg-rail" data-forge aria-label="Forge controls">
      <h2 class="fg-title">Forge</h2>
      <nav class="fg-row" aria-label="View">
        <button v-for="t in ['live', 'grid', 'refs', 'sim']" :key="t" type="button" class="fg-btn fg-btn-sm" :aria-pressed="tab === t" @click="tab = t">
          {{ t }}
        </button>
      </nav>
      <ForgeTime />
      <ForgeSky />
      <section class="fg-section" aria-labelledby="fg-snap">
        <h3 id="fg-snap" class="fg-h">Snap</h3>
        <form class="fg-row" @submit.prevent="snapLive">
          <input v-model="snapName" class="fg-input" aria-label="Snap name" />
          <button type="submit" class="fg-btn fg-btn-sm">Live</button>
          <button type="button" class="fg-btn fg-btn-sm" :disabled="tab !== 'grid'" @click="grid?.snapAll(snapName)">Grid</button>
        </form>
        <p v-if="note" class="fg-note" aria-live="polite">{{ note }}</p>
      </section>
      <ForgePresets />
      <ForgePerf />
    </aside>
    <main class="fg-main" data-forge>
      <ForgeGrid v-if="tab === 'grid'" ref="grid" />
      <ForgeRefs v-else-if="tab === 'refs'" />
      <ForgeSim v-else-if="tab === 'sim'" />
    </main>
    <component :is="FireTuner" v-if="FireTuner" />
  </div>
</template>

<style>
/* Unscoped on purpose: the rail's children share these. All of it is dev-only. */
.forge {
  min-height: 100svh;
}
.fg-rail {
  position: fixed;
  top: 4.5rem;
  left: 0.75rem;
  bottom: 0.75rem;
  width: 19rem;
  overflow: auto;
  padding: 0.75rem;
  background: rgba(5, 10, 8, 0.86);
  border: 1px solid var(--color-ash);
  color: var(--color-bone);
  font-family: var(--font-sans);
  font-size: 0.8rem;
  z-index: 80;
}
.fg-main {
  margin-left: 21rem;
  padding-top: 4.5rem;
}
.forge-live .fg-main {
  display: none;
}
.forge-grid .fg-main,
.forge-refs .fg-main,
.forge-sim .fg-main {
  background: rgba(5, 10, 8, 0.7);
  min-height: 100svh;
  margin-right: 19rem; /* the tuner sits on the right */
}
.fg-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 1rem;
  margin: 0 0 0.5rem;
  color: var(--color-ember);
}
.fg-h {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--color-smoke);
  margin: 0.9rem 0 0.35rem;
}
.fg-section + .fg-section {
  border-top: 1px solid var(--color-ash);
}
.fg-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  margin: 0.25rem 0;
}
.fg-btn {
  font: 700 0.75rem var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-bone);
  background: var(--color-basalt);
  border: 1px solid var(--color-ash);
  padding: 0.4rem 0.6rem;
  cursor: pointer;
  transition:
    transform var(--dur-press) var(--ease-forge),
    border-color var(--dur-state) var(--ease-forge),
    background-color var(--dur-state) var(--ease-forge);
}
.fg-btn:active {
  transform: scale(0.97);
}
.fg-btn[aria-pressed='true'] {
  border-color: var(--color-ember);
  background: rgba(255, 106, 43, 0.18);
}
.fg-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.fg-btn-sm {
  padding: 0.25rem 0.45rem;
  font-size: max(0.68rem, var(--text-floor));
}
.fg-label {
  color: var(--color-smoke);
  font-family: var(--font-mono);
  font-size: 0.7rem;
}
.fg-input {
  flex: 1 1 5rem;
  min-width: 3rem;
  font: 0.75rem var(--font-mono);
  color: var(--color-bone);
  background: var(--color-obsidian);
  border: 1px solid var(--color-ash);
  padding: 0.3rem 0.4rem;
}
.fg-input-sm {
  flex: 0 0 3.5rem;
}
.fg-range {
  flex: 1 1 6rem;
  accent-color: var(--color-ember);
}
.fg-val {
  font: 0.7rem var(--font-mono);
  color: var(--color-smoke);
  min-width: 2.5rem;
}
.fg-stats {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.15rem 0.6rem;
  margin: 0;
  font: 0.75rem var(--font-mono);
}
.fg-stats dt {
  color: var(--color-smoke);
}
.fg-stats dd {
  margin: 0;
}
.fg-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.fg-name {
  flex: 1 1 auto;
  font-family: var(--font-mono);
  font-size: 0.75rem;
}
.fg-note {
  font: 0.7rem var(--font-mono);
  color: var(--color-faint);
  margin: 0.25rem 0 0;
  overflow-wrap: anywhere;
}
@media (max-width: 768px) {
  .fg-rail {
    position: static;
    width: auto;
    margin: 4.5rem 0.75rem 0;
  }
  .fg-main {
    margin-left: 0;
    padding-top: 0;
  }
}
</style>
