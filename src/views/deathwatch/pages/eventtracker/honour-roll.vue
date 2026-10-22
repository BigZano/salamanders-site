<script setup>
// A skeleton: the original's headings and labels over shimmer, until this view is rebuilt. Replace this file
// with the real view; nothing else needs to change (see src/lib/deathwatch/pages.js).
import { SkNote, SkTiles } from '../../../../components/deathwatch/skeleton'

const labels = ['Event Champion', 'MVP', 'Executioner · most kills', 'Terminator · most special kills', 'Blade Master · melee damage', 'Marksman · ranged damage', 'Scavenger · most items', 'Guardian Angel · most revives', 'Gene-Seed Hunter · seeds found']
const labels2 = ['Best Average']
</script>

<template>
  <div class="dw-page">
    <SkNote />
    <h2 class="dw-plaque">Honour Roll</h2>
    <SkTiles :labels="labels" />
    <h2 class="dw-plaque">Kill Team awards</h2>
    <SkTiles :labels="labels2" />
  </div>
</template>
