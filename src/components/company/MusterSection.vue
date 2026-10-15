<script setup>
import RosterBranch from '../roster/RosterBranch.vue'
import RosterServitors from '../roster/RosterServitors.vue'

// The housekeeping at the foot of the page, for signed-in Legion members only:
// who has no company yet (a bar like the others) and the servitors. Props in,
// one event out; the page owns which bars are open.
defineProps({
  // the Unassigned view branch from rosterView.js, or null when nobody is unassigned
  unassigned: { type: Object, default: null },
  servitors: { type: Array, default: () => [] },
  open: { type: Boolean, default: false },
})
defineEmits(['toggle'])
</script>

<template>
  <section id="muster" class="muster" aria-labelledby="muster-title">
    <h2 id="muster-title" class="muster-title">Muster</h2>
    <p class="muster-sub">For Legion members: who has no company yet, and the servitors.</p>
    <RosterBranch v-if="unassigned" :branch="unassigned" variant="unassigned" :open="open" @toggle="$emit('toggle')" />
    <RosterServitors v-if="servitors.length" :servitors="servitors" />
  </section>
</template>

<style scoped>
.muster {
  margin-bottom: 3.5rem;
  scroll-margin-top: 5rem;
}
.muster-title {
  margin: 0;
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: clamp(1.4rem, 4vw, 2rem);
  letter-spacing: 0.01em;
  color: var(--color-bone);
  line-height: 1.05;
}
.muster-sub {
  margin: 0.3rem 0 1.2rem;
  color: var(--color-drake);
  font-size: 0.92rem;
}
</style>
