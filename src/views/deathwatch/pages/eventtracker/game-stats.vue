<script setup>
// A skeleton: the original's headings and labels over shimmer, until this view is rebuilt. Replace this file
// with the real view; nothing else needs to change (see src/lib/deathwatch/pages.js).
import { SkNote, SkTable, SkTiles } from '../../../../components/deathwatch/skeleton'

const labels = ['Missions played', 'Kills', 'Special Kills', 'Melee Damage', 'Ranged Damage', 'Items Found', 'Damage Taken', 'Incapacitations', 'Revives', 'In-Game Score', 'Gene-Seed']
const columns = ['Class', 'Played', 'Share', 'Ø kills', 'Seeds']
const columns2 = ['Kill Team', 'Tactical', 'Assault', 'Vanguard', 'Bulwark', 'Sniper', 'Heavy', 'Techmarine', 'Apothecary']
</script>

<template>
  <div class="dw-page">
    <SkNote />
    <h2 class="dw-plaque">Game Stats</h2>
    <SkTiles :labels="labels" />
    <SkTable :columns="columns" :rows="6" />
    <SkTable :columns="columns2" :rows="7" />
  </div>
</template>
