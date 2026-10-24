<script setup>
// Manage → Checks: things in the live event's data that are probably mistakes, each with how often it occurs.
import { computed } from 'vue'
import { useTracker } from '../../../../lib/deathwatch/useTracker'
import { SLOTS } from '../../../../lib/deathwatch/tracker'
import TrackerState from '../../../../components/deathwatch/tracker/TrackerState.vue'

const { data, R, reload } = useTracker()
const rows = computed(() => {
  const k = R.value.CK
  return [
    [`Missions with Gene-Seed + Relics over ${SLOTS} slots`, k.slots.length, k.slots.join(', ')],
    ['Kill Teams with identical stats in a mission', k.du.length, k.du.map((a) => a.join(' = ')).join('; ')],
    ['Missions played without data', k.nd.length, k.nd.join(', ')],
    ['Gene-Seeds without a finder', k.sg, ''],
    ['Player entries without a class', R.value.none, ''],
  ]
})
</script>

<template>
  <TrackerState :status="data.status" :error="data.error" @retry="reload">
    <h2 class="dw-plaque">Data checks</h2>
    <div class="dw-scroll">
      <table class="dw-table">
        <thead>
          <tr><th class="l">Check</th><th>Found</th></tr>
        </thead>
        <tbody>
          <tr v-for="[t, n, d] in rows" :key="t">
            <td class="l wrap"><b>{{ t }}</b><small v-if="d">{{ d }}</small></td>
            <td class="big" :class="n ? 'down' : 'up'">{{ n }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </TrackerState>
</template>

<style scoped>
.wrap {
  white-space: normal;
}
</style>
