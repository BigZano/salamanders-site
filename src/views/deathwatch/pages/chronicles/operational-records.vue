<script setup>
// A skeleton: the original's headings and labels over shimmer, until this view is rebuilt. Replace this file
// with the real view; nothing else needs to change (see src/lib/deathwatch/pages.js).
import { SkNote, SkTable, SkTiles } from '../../../../components/deathwatch/skeleton'

const columns = ['#', 'Kill Team', 'Points']
</script>

<template>
  <div class="dw-page">
    <SkNote />
    <h2 class="dw-sr-only">Operational Records</h2>
    <h2 class="dw-plaque">Current Kill-Team Standings</h2>
    <SkTable :columns="columns" />
    <SkTiles :count="1" />
  </div>
</template>
