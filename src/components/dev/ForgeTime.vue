<script setup>
import { ref } from 'vue'
import { useForge } from '../../composables/useForge'

/** The volcano's clock: freeze, step a frame, run at a speed, or seek to a second. */
const { forge } = useForge()
const seek = ref('')
const SPEEDS = [0.25, 0.5, 1, 2, 4]

function go() {
  const s = parseFloat(seek.value)
  if (Number.isFinite(s)) forge.actions.seek?.(s)
}
</script>

<template>
  <section class="fg-section" aria-labelledby="fg-time">
    <h3 id="fg-time" class="fg-h">Time</h3>
    <div class="fg-row">
      <button type="button" class="fg-btn" :aria-pressed="forge.frozen" @click="forge.frozen = !forge.frozen">
        {{ forge.frozen ? 'Frozen' : 'Running' }}
      </button>
      <button type="button" class="fg-btn" :disabled="!forge.frozen" @click="forge.step++">Step</button>
    </div>
    <div class="fg-row" role="group" aria-label="Speed">
      <button
        v-for="s in SPEEDS"
        :key="s"
        type="button"
        class="fg-btn fg-btn-sm"
        :aria-pressed="forge.speed === s"
        @click="forge.speed = s"
      >
        {{ s }}×
      </button>
    </div>
    <form class="fg-row" @submit.prevent="go">
      <label class="fg-label" for="fg-seek">Seek (s)</label>
      <input id="fg-seek" v-model="seek" class="fg-input" inputmode="decimal" placeholder="120" />
      <button type="submit" class="fg-btn fg-btn-sm">Go</button>
    </form>
  </section>
</template>
