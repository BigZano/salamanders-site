<script setup>
// A skeleton: the original's headings and labels over shimmer, until this view is rebuilt. Replace this file
// with the real view; nothing else needs to change (see src/lib/deathwatch/pages.js).
import { SkNote, SkTable } from '../../../../components/deathwatch/skeleton'

const columns = ['#', 'Player', 'Tours', 'Missions', 'MVP', 'Kills', 'Special', 'Melee', 'Ranged', 'Items', 'Dmg taken', 'Incaps', 'Revives', 'Seed']
</script>

<template>
  <div class="dw-page">
    <SkNote />
    <h2 class="dw-sr-only">Player Profiles</h2>
    <SkTable :columns="columns" :rows="8" />
  </div>
</template>
