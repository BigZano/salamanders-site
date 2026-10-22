<script setup>
// The /deathwatch route's frame: the dark theme around a gate around whichever page the child route shows.
// Everything under /deathwatch is behind the gate, so no page here has to check access itself.
import DeathwatchShell from '../../components/deathwatch/DeathwatchShell.vue'
import DeathwatchGate from '../../components/deathwatch/DeathwatchGate.vue'
import DeathwatchLegal from '../../components/deathwatch/DeathwatchLegal.vue'
</script>

<template>
  <DeathwatchShell>
    <DeathwatchGate>
      <RouterView />
    </DeathwatchGate>
    <!-- Outside the gate, so it is on every screen: the page, and each state of the gate (the only one the public sees). -->
    <DeathwatchLegal />
  </DeathwatchShell>
</template>
