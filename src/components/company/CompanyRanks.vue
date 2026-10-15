<script setup>
import PublicShape from '../roster/PublicShape.vue'
import RosterBranch from '../roster/RosterBranch.vue'
import RanksPlaceholder from './RanksPlaceholder.vue'

// A company's Ranks bar: the embedded roster bar, with the full ladder for a
// signed-in Legion member (mode "full") or counts for everyone else ("public").
// Nothing renders when there is no roster to show or none for this company;
// while it loads, a placeholder keeps the bar's place. Props in, events out:
// the page owns which bars are open and what signing in does.
defineProps({
  // a branch from rosterView.js (full) or rosterPublicView.js (public); null if the roster has none for this company
  branch: { type: Object, default: null },
  mode: { type: String, default: 'none' }, // 'full' | 'public' | 'none'
  loading: { type: Boolean, default: false },
  open: { type: Boolean, default: false },
})
defineEmits(['toggle', 'sign-in'])
</script>

<template>
  <RanksPlaceholder v-if="loading" />
  <RosterBranch
    v-else-if="branch && mode !== 'none'"
    variant="embedded"
    :branch="branch"
    :open="open && branch.openable"
    @toggle="$emit('toggle')"
  >
    <template v-if="mode === 'public'" #body>
      <PublicShape :items="branch.shape" :extra-heads="branch.extraHeads" :branch="branch" @sign-in="$emit('sign-in')" />
    </template>
  </RosterBranch>
</template>
