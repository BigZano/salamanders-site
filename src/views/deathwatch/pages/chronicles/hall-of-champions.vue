<script setup>
// A skeleton: the original's headings and labels over shimmer, until this view is rebuilt. Replace this file
// with the real view; nothing else needs to change (see src/lib/deathwatch/pages.js).
import { SkNote, SkTiles } from '../../../../components/deathwatch/skeleton'

const labels = ['Requirements', 'Award', 'Accolade Duration', 'Legacy']
</script>

<template>
  <div class="dw-page">
    <SkNote />
    <h2 class="dw-sr-only">Hall of Champions</h2>
    <SkTiles :count="1" />
    <h2 class="dw-plaque">Past Champions</h2>
    <SkTiles :count="2" />
    <h2 class="dw-plaque">How to earn this honor?</h2>
    <SkTiles :labels="labels" />
  </div>
</template>
