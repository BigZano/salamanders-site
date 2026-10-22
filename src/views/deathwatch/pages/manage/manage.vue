<script setup>
// A skeleton: the original's headings and labels over shimmer, until this view is rebuilt. Replace this file
// with the real view; nothing else needs to change (see src/lib/deathwatch/pages.js).
import { SkForm, SkNote } from '../../../../components/deathwatch/skeleton'

const fields = ['Base points', 'Incap penalty', 'Revive bonus', 'Gene-Seed bonus', 'Armoury Data bonus', 'Guardian Relic bonus']
</script>

<template>
  <div class="dw-page">
    <SkNote />
    <h2 class="dw-plaque">Scoring</h2>
    <SkForm :fields="fields" />
    <h2 class="dw-plaque">Rename or merge player</h2>
    <SkForm :count="2" />
    <h2 class="dw-plaque">Kill Teams</h2>
    <SkForm :count="3" />
    <h2 class="dw-plaque">Restore from backup</h2>
    <SkForm :count="1" />
    <h2 class="dw-plaque">Event archive</h2>
    <SkForm :count="1" />
    <h2 class="dw-plaque">Reset Kill Teams</h2>
    <SkForm :count="1" />
  </div>
</template>
