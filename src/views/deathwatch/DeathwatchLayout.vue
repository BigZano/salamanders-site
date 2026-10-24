<script setup>
// The /deathwatch route's frame: the dark theme around a gate around whichever page the child route shows.
// Everything under /deathwatch is behind the gate, so no page here has to check access itself.
import DeathwatchShell from '../../components/deathwatch/DeathwatchShell.vue'
import DeathwatchGate from '../../components/deathwatch/DeathwatchGate.vue'
</script>

<template>
  <DeathwatchShell>
    <DeathwatchGate>
      <RouterView />
    </DeathwatchGate>
  </DeathwatchShell>
</template>
