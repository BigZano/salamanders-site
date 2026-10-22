<script setup>
// A skeleton: the original's headings and labels over shimmer, until this view is rebuilt. Replace this file
// with the real view; nothing else needs to change (see src/lib/deathwatch/pages.js).
import { SkNote, SkTable } from '../../../../components/deathwatch/skeleton'

const columns = ['']
</script>

<template>
  <div class="dw-page">
    <SkNote />
    <h2 class="dw-plaque">Data checks</h2>
    <SkTable :columns="columns" :rows="4" />
  </div>
</template>
