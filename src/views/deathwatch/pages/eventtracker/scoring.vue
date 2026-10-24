<script setup>
// A skeleton: the original's headings and labels over shimmer, until this view is rebuilt. Replace this file
// with the real view; nothing else needs to change (see src/lib/deathwatch/pages.js).
import { SkNote, SkTiles } from '../../../../components/deathwatch/skeleton'

const labels = ['Played mission', 'Gene-Seed', '2 Guardian Relics', '3 Armoury Data', 'Extermination Rank', 'Total']
</script>

<template>
  <div class="dw-page">
    <SkNote />
    <h2 class="dw-plaque">Event points per mission</h2>
    <SkTiles :count="3" />
    <h2 class="dw-plaque">Best possible mission</h2>
    <SkTiles :labels="labels" />
    <h2 class="dw-plaque">MVP score per objective</h2>
    <SkTiles :count="5" />
  </div>
</template>
