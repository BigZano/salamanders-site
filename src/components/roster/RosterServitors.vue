<script setup>
import RosterMember from './RosterMember.vue'

// The servitors (bots and servo-skulls), as a muted row of chips. Members only.
defineProps({
  servitors: { type: Array, required: true },
})
</script>

<template>
  <section class="rs-servitors" aria-label="Servitors">
    <h3>Servitors</h3>
    <ul class="rs-servitor-list">
      <RosterMember v-for="m in servitors" :key="m.id" :member="m" />
    </ul>
  </section>
</template>

<style scoped>
.rs-servitors {
  margin-top: 1.4rem;
  padding-top: 1.2rem;
  border-top: 1px solid var(--color-ash);
}
.rs-servitors h3 {
  margin: 0 0 0.8rem;
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 0.9rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--color-smoke);
}
.rs-servitor-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.38rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.rs-servitor-list .rs-member {
  filter: grayscale(1);
  opacity: 0.78;
}
</style>
