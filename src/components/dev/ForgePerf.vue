<script setup>
import { useForge } from '../../composables/useForge'

/** Draw cost over the last sixty frames, written by the volcano. */
const { forge } = useForge()
</script>

<template>
  <section class="fg-section" aria-labelledby="fg-perf">
    <h3 id="fg-perf" class="fg-h">Draw cost</h3>
    <dl class="fg-stats">
      <dt>mean</dt>
      <dd>{{ forge.stats.draw.toFixed(2) }} ms</dd>
      <dt>worst</dt>
      <dd>{{ forge.stats.max.toFixed(2) }} ms</dd>
      <dt>fps</dt>
      <dd>{{ forge.stats.fps.toFixed(0) }}</dd>
    </dl>
  </section>
</template>
