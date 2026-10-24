<script setup>
// A skeleton: the original's headings and labels over shimmer, until this view is rebuilt. Replace this file
// with the real view; nothing else needs to change (see src/lib/deathwatch/pages.js).
import { SkForm, SkNote, SkTable, SkTiles } from '../../../../components/deathwatch/skeleton'

const fields = ['Kill Team']
const labels = ['Rank', 'Event points', 'Move', 'Gap to #1', 'Missions played', 'KIA']
const columns = ['Player', 'Obj', 'Kills', 'Special', 'Melee', 'Ranged', 'Items', 'Dmg taken', 'Incaps', 'Revives', 'MVP']
const columns2 = ['Week', 'Points', 'Total']
const columns3 = ['Mission', 'Kills', 'Special', 'Melee', 'Ranged', 'Incaps', 'Revives', 'Seed', 'Armoury', 'Relic', 'Ext', 'Points', 'MVP']
</script>

<template>
  <div class="dw-page">
    <SkNote />
    <h2 class="dw-plaque">Kill Team profile</h2>
    <SkForm :fields="fields" />
    <SkTiles :labels="labels" />
    <h2 class="dw-plaque">Players</h2>
    <SkTable :columns="columns" />
    <h2 class="dw-plaque">Points per week</h2>
    <SkTable :columns="columns2" :rows="4" />
    <h2 class="dw-plaque">Missions</h2>
    <SkTable :columns="columns3" />
  </div>
</template>
