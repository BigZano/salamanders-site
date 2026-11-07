<script setup>
import { ref } from 'vue'
import { fireTuning, randomize, routeProfiles } from '../../lib/fireTuning'
import { useForge } from '../../composables/useForge'

/**
 * Named presets: the whole tuning (bed, text, profiles, randomize) plus the pinned moon and the clock. Kept in this
 * browser's localStorage; Copy puts the JSON on the clipboard so a preset can be pasted into a message.
 */
const KEY = 'sal-forge-presets'
const { forge } = useForge()
const name = ref('')
const presets = ref(load())
const note = ref('')

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}')
  } catch {
    return {}
  }
}
function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(presets.value))
  } catch {
    note.value = 'could not save: storage is blocked'
  }
}
function current() {
  return {
    tuning: JSON.parse(JSON.stringify(fireTuning)),
    randomize: { ...randomize },
    profiles: JSON.parse(JSON.stringify(routeProfiles)),
    moon: forge.moon,
    time: forge.actions.time?.() ?? null,
  }
}
function save() {
  const n = name.value.trim()
  if (!n) return
  presets.value = { ...presets.value, [n]: current() }
  persist()
  note.value = `saved “${n}”`
}
function apply(n) {
  const p = presets.value[n]
  if (!p) return
  Object.assign(fireTuning.bed, p.tuning.bed)
  Object.assign(fireTuning.text, p.tuning.text)
  Object.assign(randomize, p.randomize)
  for (const k of Object.keys(p.profiles)) if (routeProfiles[k]) Object.assign(routeProfiles[k], p.profiles[k])
  forge.moon = p.moon
  if (p.time !== null) forge.actions.seek?.(p.time)
  note.value = `loaded “${n}”`
}
function remove(n) {
  const next = { ...presets.value }
  delete next[n]
  presets.value = next
  persist()
}
async function copy(n) {
  const text = JSON.stringify({ name: n, ...(n ? presets.value[n] : current()) }, null, 2)
  try {
    await navigator.clipboard.writeText(text)
    note.value = 'copied'
  } catch {
    note.value = 'clipboard blocked; the JSON is in the console'
    console.log(text)
  }
}
</script>

<template>
  <section class="fg-section" aria-labelledby="fg-presets">
    <h3 id="fg-presets" class="fg-h">Presets</h3>
    <form class="fg-row" @submit.prevent="save">
      <input v-model="name" class="fg-input" placeholder="name" aria-label="Preset name" />
      <button type="submit" class="fg-btn fg-btn-sm">Save</button>
      <button type="button" class="fg-btn fg-btn-sm" @click="copy('')">Copy current</button>
    </form>
    <ul class="fg-list">
      <li v-for="(p, n) in presets" :key="n" class="fg-row">
        <span class="fg-name">{{ n }}</span>
        <button type="button" class="fg-btn fg-btn-sm" @click="apply(n)">Load</button>
        <button type="button" class="fg-btn fg-btn-sm" @click="copy(n)">Copy</button>
        <button type="button" class="fg-btn fg-btn-sm" @click="remove(n)">×</button>
      </li>
    </ul>
    <p v-if="note" class="fg-note" aria-live="polite">{{ note }}</p>
  </section>
</template>
