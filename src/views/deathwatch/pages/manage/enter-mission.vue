<script setup>
// A skeleton: the original's headings and labels over shimmer, until this view is rebuilt. Replace this file
// with the real view; nothing else needs to change (see src/lib/deathwatch/pages.js).
import { SkForm, SkNote } from '../../../../components/deathwatch/skeleton'

const fields = ['Kill Team', 'Week', 'Objective', 'Played', 'In-Game Score', 'Gene-Seed']
</script>

<template>
  <div class="dw-page">
    <SkNote />
    <h2 class="dw-plaque">Enter mission</h2>
    <SkForm :fields="fields" />
    <h2 class="dw-plaque">Reset all missions</h2>
    <SkForm :count="1" />
  </div>
</template>
