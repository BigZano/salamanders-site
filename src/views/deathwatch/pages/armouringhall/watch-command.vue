<script setup>
// A skeleton: the original's headings and labels over shimmer, until this view is rebuilt. Replace this file
// with the real view; nothing else needs to change (see src/lib/deathwatch/pages.js).
import { SkFigure, SkNote, SkTiles } from '../../../../components/deathwatch/skeleton'

const labels = ['Helm', 'Pauldrons', 'Wargear', 'Breastplate', 'Gauntlets', 'Greaves', 'Armour Set']
</script>

<template>
  <div class="dw-page">
    <SkNote />
    <h2 class="dw-sr-only">Watch Command</h2>
    <SkFigure />
    <SkTiles :labels="labels" />
  </div>
</template>
