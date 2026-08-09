<script setup>
import { ref, computed } from 'vue'
import { useRoute } from 'vue-router'
import {
  fireTuning,
  randomize,
  resetTuning,
  routeProfiles,
  profileFor,
  DEFAULTS,
  RANDOMIZE_DEFAULTS,
  ROUTE_PROFILE_DEFAULTS,
} from '../lib/fireTuning'

/**
 * Dev-only slider panel for the fire effects, shown at ?tune=1.
 *
 * Dial the look in the browser, hit Copy values, and paste the result into
 * DEFAULTS and ROUTE_PROFILE_DEFAULTS in lib/fireTuning.js. Never rendered for
 * ordinary visitors.
 *
 * The top three sections are global and describe the baked hero. "This page"
 * edits only the route you're currently on, so navigate first, then tune.
 */
const open = ref(true)
const copied = ref(false)
const route = useRoute()

const TEXT_FIELDS = [
  { key: 'pixel', label: 'Pixel size', min: 1, max: 12, step: 1 },
  { key: 'speed', label: 'Speed', min: 0.1, max: 3, step: 0.05 },
  { key: 'maxHeight', label: 'Max height', min: 0.1, max: 1, step: 0.05 },
  { key: 'variation', label: 'Variation', min: 0.1, max: 2, step: 0.05 },
  { key: 'intensity', label: 'Intensity', min: 0.2, max: 2, step: 0.05 },
  { key: 'base', label: 'Base brightness', min: 0, max: 1, step: 0.05 },
]

// Several of these ceilings were hit dead-on during the last tuning pass —
// flows, ridges, ash and plume count all ended pinned at max, which means the
// slider was the limit, not the eye. Raised so there's headroom above the
// baked values rather than a wall at them.
const CRUST_FIELDS = [
  { key: 'height', label: 'Peak height', min: 60, max: 1200, step: 10 },
  { key: 'width', label: 'Base width', min: 0.2, max: 2, step: 0.02 },
  { key: 'offsetX', label: 'Peak position', min: 0, max: 1, step: 0.02 },
  { key: 'faceSpread', label: 'Face variation', min: 0, max: 0.45, step: 0.01 },
  { key: 'flows', label: 'Lava flows', min: 0, max: 48, step: 1 },
  { key: 'flowHeat', label: 'Lava heat', min: 0, max: 2, step: 0.05 },
  { key: 'caldera', label: 'Caldera heat', min: 0, max: 2, step: 0.05 },
  { key: 'ridges', label: 'Distant ridges', min: 0, max: 16, step: 1 },
  { key: 'glow', label: 'Sky glow', min: 0, max: 1.2, step: 0.02 },
  { key: 'ash', label: 'Falling ash', min: 0, max: 400, step: 4 },
]

const BED_FIELDS = [
  { key: 'eruptRate', label: 'Eruption rate', min: 0, max: 4, step: 0.1 },
  { key: 'sparks', label: 'Sparks per pulse', min: 0, max: 4, step: 0.1 },
  { key: 'count', label: 'Plume count', min: 0, max: 500, step: 4 },
  { key: 'sparkMix', label: 'Sparks vs embers', min: 0, max: 1, step: 0.05 },
  { key: 'speed', label: 'Rise speed', min: 0.1, max: 4, step: 0.05 },
  { key: 'scale', label: 'Particle scale', min: 0.2, max: 5, step: 0.1 },
]

// Per-route departure from the baked hero.
const PROFILE_FIELDS = [
  { key: 'bearing', label: 'Bearing', min: -0.6, max: 0.6, step: 0.01, hint: 'where you stand' },
  { key: 'scale', label: 'Scale', min: 0.15, max: 1.4, step: 0.02, hint: 'how far away it is' },
  { key: 'variance', label: 'Variance', min: 0, max: 1.5, step: 0.05, hint: 'how far detail strays' },
  { key: 'density', label: 'Density', min: 0, max: 1.5, step: 0.05, hint: 'plume, ash, sky and lava heat' },
]

const profile = computed(() => profileFor(route.path))
/** Which entry is actually being edited — '*' when the route has none. */
const profileKey = computed(() => (routeProfiles[route.path] ? route.path : '*'))
const profileChanged = (key) =>
  profile.value[key] !== ROUTE_PROFILE_DEFAULTS[profileKey.value]?.[key]

// What a route's seed may vary. Everything else is identical on every page.
const RANDOM_FIELDS = [
  { key: 'offsetX', label: 'Peak position', hint: 'walk around the mountain' },
  { key: 'flows', label: 'Lava layout', hint: 'which channels face you' },
  { key: 'ridges', label: 'Far ridges', hint: 'parallax on the range behind' },
  { key: 'asymmetry', label: 'Cone profile', hint: 'off = one mountain, on = many' },
]

const snippet = computed(
  () =>
    `text: ${JSON.stringify(fireTuning.text, null, 2)},\n` +
    `bed: ${JSON.stringify(fireTuning.bed, null, 2)},\n` +
    `randomize: ${JSON.stringify(randomize, null, 2)},\n` +
    `profiles: ${JSON.stringify(routeProfiles, null, 2)},`,
)

async function copyValues() {
  try {
    await navigator.clipboard.writeText(snippet.value)
  } catch {
    const t = document.createElement('textarea')
    t.value = snippet.value
    document.body.appendChild(t)
    t.select()
    document.execCommand('copy')
    t.remove()
  }
  copied.value = true
  setTimeout(() => (copied.value = false), 1600)
}

const changed = (group, key) => fireTuning[group][key] !== DEFAULTS[group][key]
</script>

<template>
  <aside class="tuner" :class="{ closed: !open }">
    <header class="tuner-bar">
      <h2 class="tuner-title">Fire tuning</h2>
      <button class="tuner-toggle" @click="open = !open">{{ open ? '–' : '+' }}</button>
    </header>

    <div v-if="open" class="tuner-body">
      <section>
        <h3 class="tuner-group">Lettering</h3>
        <label v-for="f in TEXT_FIELDS" :key="f.key" class="row">
          <span class="row-label" :class="{ on: changed('text', f.key) }">{{ f.label }}</span>
          <input
            v-model.number="fireTuning.text[f.key]"
            type="range"
            :min="f.min"
            :max="f.max"
            :step="f.step"
          />
          <span class="row-val">{{ fireTuning.text[f.key] }}</span>
        </label>
      </section>

      <section>
        <h3 class="tuner-group">Mount Deathfire</h3>
        <label v-for="f in CRUST_FIELDS" :key="f.key" class="row">
          <span class="row-label" :class="{ on: changed('bed', f.key) }">{{ f.label }}</span>
          <input
            v-model.number="fireTuning.bed[f.key]"
            type="range"
            :min="f.min"
            :max="f.max"
            :step="f.step"
          />
          <span class="row-val">{{ fireTuning.bed[f.key] }}</span>
        </label>
      </section>

      <section>
        <h3 class="tuner-group">Plume &amp; sparks</h3>
        <label v-for="f in BED_FIELDS" :key="f.key" class="row">
          <span class="row-label" :class="{ on: changed('bed', f.key) }">{{ f.label }}</span>
          <input
            v-model.number="fireTuning.bed[f.key]"
            type="range"
            :min="f.min"
            :max="f.max"
            :step="f.step"
          />
          <span class="row-val">{{ fireTuning.bed[f.key] }}</span>
        </label>
      </section>

      <section>
        <h3 class="tuner-group">Varies per page</h3>
        <label v-for="f in RANDOM_FIELDS" :key="f.key" class="check">
          <input v-model="randomize[f.key]" type="checkbox" />
          <span>
            <span class="check-label" :class="{ on: randomize[f.key] !== RANDOMIZE_DEFAULTS[f.key] }">
              {{ f.label }}
            </span>
            <span class="check-hint">{{ f.hint }}</span>
          </span>
        </label>
      </section>

      <section>
        <h3 class="tuner-group">
          This page <span class="tuner-route">{{ profileKey }}</span>
        </h3>
        <p v-if="profileKey === '/'" class="tuner-hint">
          The baked hero. 0 / 1 / 1 / 1 is the anchor every other page is
          measured from — move the global sliders above instead.
        </p>
        <label v-for="f in PROFILE_FIELDS" :key="f.key" class="row">
          <span class="row-label" :class="{ on: profileChanged(f.key) }" :title="f.hint">
            {{ f.label }}
          </span>
          <input
            v-model.number="profile[f.key]"
            type="range"
            :min="f.min"
            :max="f.max"
            :step="f.step"
          />
          <span class="row-val">{{ profile[f.key] }}</span>
        </label>
      </section>

      <div class="tuner-actions">
        <button class="btn-ember btn-xs" @click="copyValues">
          {{ copied ? 'Copied' : 'Copy values' }}
        </button>
        <button class="btn-xs ghost" @click="resetTuning">Reset</button>
      </div>
      <p class="tuner-note">
        Lettering only redraws on the hero. Peak height, width, position, face
        variation, lava flows, ridges, ash and plume count rebuild the mountain;
        the rest apply live. "This page" edits only the route you're on, so
        navigate first, then tune — Copy values emits every page's profile.
      </p>
    </div>
  </aside>
</template>

<style scoped>
.tuner {
  position: fixed;
  top: 4.5rem;
  right: 0.75rem;
  z-index: 90;
  width: 20rem;
  max-width: calc(100vw - 1.5rem);
  max-height: calc(100vh - 6rem);
  overflow-y: auto;
  background: rgba(5, 10, 8, 0.94);
  border: 1px solid var(--color-ash-2);
  border-radius: 6px;
  backdrop-filter: blur(8px);
  box-shadow: 0 20px 60px -20px rgba(0, 0, 0, 0.9);
}
.tuner-bar {
  position: sticky;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.6rem 0.8rem;
  background: rgba(5, 10, 8, 0.96);
  border-bottom: 1px solid var(--color-ash);
}
.tuner-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 0.78rem;
  color: var(--color-gold);
}
.tuner-toggle {
  width: 1.5rem;
  height: 1.5rem;
  line-height: 1;
  color: var(--color-bone);
  background: transparent;
  border: 1px solid var(--color-ash);
  border-radius: 2px;
  cursor: pointer;
}
.tuner-body {
  padding: 0.7rem 0.8rem 0.9rem;
}
.tuner-group {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.14em;
  font-size: 0.54rem;
  color: var(--color-smoke);
  margin: 0.5rem 0 0.45rem;
}
.tuner-route {
  font-family: var(--font-mono);
  letter-spacing: 0;
  text-transform: none;
  color: var(--color-ember);
}
.tuner-hint {
  color: #728078;
  font-size: 0.6rem;
  line-height: 1.4;
  margin-bottom: 0.4rem;
}
.row {
  display: grid;
  grid-template-columns: 6.4rem 1fr 2.4rem;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.3rem;
}
.row-label {
  font-size: 0.7rem;
  color: var(--color-smoke);
}
.row-label.on {
  color: var(--color-ember);
}
.row input {
  width: 100%;
  accent-color: var(--color-ember);
}
.row-val {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: var(--color-bone);
  text-align: right;
}
.check {
  display: grid;
  grid-template-columns: 1rem 1fr;
  align-items: start;
  gap: 0.5rem;
  margin-bottom: 0.35rem;
  cursor: pointer;
}
.check input {
  margin-top: 0.15rem;
  accent-color: var(--color-ember);
}
.check-label {
  display: block;
  font-size: 0.7rem;
  color: var(--color-smoke);
}
.check-label.on {
  color: var(--color-ember);
}
.check-hint {
  display: block;
  font-size: 0.58rem;
  color: #5f6f66;
  line-height: 1.3;
}
.tuner-actions {
  display: flex;
  gap: 0.4rem;
  margin-top: 0.7rem;
}
.btn-xs {
  padding: 0.4rem 0.7rem;
  border-radius: 2px;
  font-size: 0.7rem;
  cursor: pointer;
}
.ghost {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 700;
  color: var(--color-smoke);
  background: transparent;
  border: 1px solid var(--color-ash);
}
.tuner-note {
  margin-top: 0.6rem;
  color: #728078;
  font-size: 0.62rem;
  line-height: 1.45;
}
.tuner.closed {
  width: auto;
}
</style>
