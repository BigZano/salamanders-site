<script setup>
import RosterMember from './RosterMember.vue'

// One rank: its label and count on the left, its members as wrapping chips on the right.
// Used in a branch's ladder, the High Command court, and Unassigned.
defineProps({
  row: { type: Object, required: true },
  // { kind, number } of the branch these chips sit in (null outside a branch)
  branch: { type: Object, default: null },
  // data-tier belongs to branch rows only
  withTier: { type: Boolean, default: false },
  imageReady: { type: Boolean, default: true },
})
</script>

<template>
  <div
    class="rs-row"
    :data-rank="row.rank.key"
    :data-tier="withTier ? row.rank.tier : undefined"
    :data-lateral="row.rank.lateral ? '' : undefined"
  >
    <h3 class="rs-rank-label">
      {{ row.rank.label }}<span class="rs-count">{{ row.members.length }}</span>
    </h3>
    <ul class="rs-chips">
      <RosterMember v-for="m in row.members" :key="m.id" :member="m" :branch="branch" :image-ready="imageReady" />
    </ul>
  </div>
</template>

<style scoped>
/* the parent sets --rs-label-w where a row needs a narrower or auto label column */
.rs-row {
  display: grid;
  grid-template-columns: var(--rs-label-w, 10rem) 1fr;
  gap: 0.35rem 0.9rem;
  align-items: start;
}
.rs-rank-label {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  margin: 0;
  padding-top: 0.38rem;
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 0.82rem;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: #b9c7bd;
}
.rs-count {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  letter-spacing: 0;
  color: var(--color-smoke);
}
.rs-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.38rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
@media (max-width: 760px) {
  .rs-row {
    grid-template-columns: 1fr;
  }
  .rs-rank-label {
    padding-top: 0.1rem;
  }
}
</style>
