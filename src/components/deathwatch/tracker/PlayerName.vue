<script setup>
// A player's name as a link to their profile, with the KIA tag if they fell and the guest tag if asked for.
import { kiaLabel } from '../../../lib/deathwatch/tracker'

defineProps({
  name: { type: String, required: true },
  R: { type: Object, required: true },
  to: { type: Object, default: null },
  guest: { type: Boolean, default: false },
})
</script>

<template>
  <RouterLink v-if="to" class="dw-link" :to="to">{{ name }}</RouterLink><span v-else>{{ name }}</span>
  <span v-if="guest" class="dw-tag guest" title="Not on this Kill Team's roster. Counts for Kill Team points, not for MVP.">Guest</span>
  <span v-if="R.kia.has(name)" class="dw-tag kia" :title="`Killed in action${R.kia.get(name) ? ` in week ${R.kia.get(name)}` : ''}`">{{ kiaLabel(R, name) }}</span>
</template>
