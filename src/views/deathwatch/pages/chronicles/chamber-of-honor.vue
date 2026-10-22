<script setup>
// A skeleton: the original's headings and labels over shimmer, until this view is rebuilt. Replace this file
// with the real view; nothing else needs to change (see src/lib/deathwatch/pages.js).
import { SkNote, SkTiles } from '../../../../components/deathwatch/skeleton'

const labels = ['MVP', 'Executioner', 'Terminator', 'Blade Master', 'Marksman', 'Scavenger', 'Guardian Angel', 'Gene-Seed Hunter']
</script>

<template>
  <div class="dw-page">
    <SkNote />
    <h2 class="dw-sr-only">Chamber of Honor</h2>
    <h2 class="dw-plaque">Battle-Brother Honours</h2>
    <SkTiles :labels="labels" />
  </div>
</template>
