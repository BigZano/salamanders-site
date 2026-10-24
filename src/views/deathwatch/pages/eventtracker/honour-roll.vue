<script setup>
// Event Tracker → Honour Roll: the running event's champion and awards.
import { useTracker } from '../../../../lib/deathwatch/useTracker'
import TrackerState from '../../../../components/deathwatch/tracker/TrackerState.vue'
import HonourRollView from '../../../../components/deathwatch/tracker/HonourRollView.vue'

const { data, R, live, reload } = useTracker()
</script>

<template>
  <TrackerState :status="data.status" :error="data.error" @retry="reload">
    <HonourRollView :R="R" :to="live" />
  </TrackerState>
</template>
