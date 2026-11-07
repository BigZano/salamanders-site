<script setup>
import { computed } from 'vue'
import { useForge } from '../../composables/useForge'

/** The sky and the caldera: pin the moon's phase, throw an eruption, start a Time of Trial. */
const { forge } = useForge()
const pinned = computed({
  get: () => forge.moon !== null,
  set: (on) => (forge.moon = on ? 0.42 : null),
})
</script>

<template>
  <section class="fg-section" aria-labelledby="fg-sky">
    <h3 id="fg-sky" class="fg-h">Sky and caldera</h3>
    <div class="fg-row">
      <label class="fg-label"><input v-model="pinned" type="checkbox" /> Pin moon</label>
      <input
        v-model.number="forge.moon"
        type="range"
        min="0"
        max="1"
        step="0.01"
        class="fg-range"
        :disabled="!pinned"
        aria-label="Moon phase"
      />
      <span class="fg-val">{{ pinned ? forge.moon.toFixed(2) : 'clock' }}</span>
    </div>
    <div class="fg-row">
      <button type="button" class="fg-btn fg-btn-sm" @click="forge.actions.erupt?.(1)">Erupt</button>
      <button type="button" class="fg-btn fg-btn-sm" @click="forge.actions.erupt?.(2)">Big</button>
      <button v-for="tier in [1, 2, 3]" :key="tier" type="button" class="fg-btn fg-btn-sm" @click="forge.actions.trial?.(tier)">
        Trial {{ tier }}
      </button>
    </div>
  </section>
</template>
