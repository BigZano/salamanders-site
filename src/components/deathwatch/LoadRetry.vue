<script setup>
// What a page that reads the area's data once shows when that failed: the message (the slot) and a button that loads
// it again, as the Event Tracker's own "Try again" does. Without it only a reload or another tab would recover.
import { useAuth } from '../../stores/auth'
import { useDeathwatchData } from '../../stores/deathwatchData'

const auth = useAuth()
const data = useDeathwatchData()
</script>

<template>
  <p class="dw-retry" role="alert">
    <slot />
    <button type="button" class="dw-btn rm-fade" @click="data.load(auth.token)">Try again</button>
  </p>
</template>

<style scoped>
.dw-retry {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 0.6rem 1rem;
  margin: 0;
  color: var(--dw-muted);
}
</style>
