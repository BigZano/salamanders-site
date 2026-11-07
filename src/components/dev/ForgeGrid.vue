<script setup>
import { ref, computed } from 'vue'
import { useForge } from '../../composables/useForge'

/**
 * The grid: the same page in same-origin iframes at phone, tablet and desktop sizes, each frozen at one clock and
 * moon phase, so one look compares every viewport. Snap writes each frame's canvas to .forge/snaps.
 */
const { forge, snap, forgeIn } = useForge()
const SIZES = [
  { key: 'phone', w: 390, h: 844 },
  { key: 'tablet', w: 768, h: 1024 },
  { key: 'desktop', w: 1200, h: 800 },
]
const on = ref({ phone: true, tablet: false, desktop: true })
const path = ref('/')
const time = ref(120)
const moon = ref(0.42)
const frames = ref({})
const note = ref('')
const src = computed(() => `${path.value}?calm=0&t=${time.value}&moon=${moon.value}`)
const shown = computed(() => SIZES.filter((s) => on.value[s.key]))

/** Push the clock and moon into every frame without reloading. */
function sync() {
  for (const s of shown.value) {
    const f = forgeIn(frames.value[s.key])
    if (!f) continue
    f.moon = moon.value
    f.frozen = true
    f.actions.seek?.(time.value)
  }
}
async function snapAll(label) {
  const files = []
  for (const s of shown.value) {
    const f = forgeIn(frames.value[s.key])
    const cv = f?.actions.snapshot?.()
    if (cv) files.push(await snap(`${label || 'grid'}-${s.key}`, cv))
  }
  note.value = files.length ? `wrote ${files.length}: ${files.join(', ')}` : 'no frame ready'
}
defineExpose({ snapAll })
</script>

<template>
  <section class="fg-grid-wrap" aria-labelledby="fg-grid">
    <h3 id="fg-grid" class="fg-h">Grid</h3>
    <div class="fg-row" data-forge>
      <label v-for="s in SIZES" :key="s.key" class="fg-label"><input v-model="on[s.key]" type="checkbox" /> {{ s.key }}</label>
      <label class="fg-label" for="fg-grid-path">path</label>
      <input id="fg-grid-path" v-model="path" class="fg-input" />
      <label class="fg-label" for="fg-grid-t">t</label>
      <input id="fg-grid-t" v-model.number="time" class="fg-input fg-input-sm" inputmode="decimal" />
      <label class="fg-label" for="fg-grid-moon">moon</label>
      <input id="fg-grid-moon" v-model.number="moon" class="fg-input fg-input-sm" inputmode="decimal" />
      <button type="button" class="fg-btn fg-btn-sm" @click="sync">Sync</button>
      <button type="button" class="fg-btn fg-btn-sm" @click="snapAll('grid')">Snap all</button>
      <span v-if="note" class="fg-note">{{ note }}</span>
    </div>
    <div class="fg-frames">
      <figure v-for="s in shown" :key="s.key" class="fg-frame">
        <iframe
          :ref="(el) => (frames[s.key] = el)"
          :src="src"
          :width="s.w"
          :height="s.h"
          :title="`${s.key} ${s.w}×${s.h}`"
          loading="lazy"
        ></iframe>
        <figcaption>{{ s.key }} · {{ s.w }}×{{ s.h }}</figcaption>
      </figure>
    </div>
  </section>
</template>

<style scoped>
.fg-grid-wrap {
  padding: 1rem;
}
.fg-frames {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: flex-start;
}
.fg-frame {
  margin: 0;
}
.fg-frame iframe {
  display: block;
  border: 1px solid var(--color-ash);
  background: var(--color-obsidian);
}
.fg-frame figcaption {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--color-smoke);
  padding-top: 0.25rem;
}
</style>
