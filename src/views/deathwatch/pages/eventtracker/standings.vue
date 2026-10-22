<script setup>
// A skeleton: the original's headings and labels over shimmer, until this view is rebuilt. Replace this file
// with the real view; nothing else needs to change (see src/lib/deathwatch/pages.js).
import { SkChart, SkNote, SkPodium, SkTable } from '../../../../components/deathwatch/skeleton'

const columns = ['#', 'Kill Team', 'W1', 'W2', 'W3', 'W4', 'Total', 'Gap', 'Ø/mission']
const columns2 = ['Company', 'Kill Teams', 'Points']
</script>

<template>
  <div class="dw-page">
    <SkNote />
    <h2 class="dw-plaque">Standings</h2>
    <SkPodium />
    <SkTable :columns="columns" :rows="7" />
    <h2 class="dw-plaque">Points progression</h2>
    <SkChart />
    <h2 class="dw-plaque">Watch Companies</h2>
    <SkTable :columns="columns2" />
  </div>
</template>
