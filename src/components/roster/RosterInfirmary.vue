<script setup>
import RosterMember from './RosterMember.vue'

// The command-only leave list. It replaces the order of battle on screen while
// open. `status` is the store's infirmaryStatus: idle, ready, denied or error.
defineProps({
  status: { type: String, default: 'idle' },
  infirmary: { type: Object, default: null },
})
</script>

<template>
  <section class="rs-infirmary surface">
    <h2 class="rs-inf-title">Infirmary</h2>
    <p v-if="status === 'denied'" role="alert">The Infirmary list is open to company command and above.</p>
    <p v-else-if="status === 'error'" role="alert">The Infirmary list could not be loaded.</p>
    <p v-else-if="!infirmary">Loading…</p>
    <template v-else>
      <p class="rs-inf-sub">{{ infirmary.count }} on leave</p>
      <ul class="rs-inf-list">
        <RosterMember v-for="m in infirmary.members" :key="m.id" :member="m">
          <span v-if="m.rank" class="rs-rank">{{ m.rank.label }}</span>
          <span v-if="m.legion" class="rs-badge rs-warn">Still holds the Legion role</span>
        </RosterMember>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.rs-infirmary {
  margin-top: 2rem;
  padding: 1.4rem 1.5rem;
  border-radius: 3px;
}
.rs-inf-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.4rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.rs-inf-sub {
  margin: 0.3rem 0 1rem;
  font-family: var(--font-mono);
  font-size: 0.74rem;
  color: var(--color-smoke);
}
.rs-inf-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
/* slot content is styled by this component, not by the chip */
.rs-rank {
  font-family: var(--font-display);
  font-size: 0.74rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-smoke);
}
.rs-warn {
  font-family: var(--font-mono);
  font-size: max(0.6rem, var(--text-floor));
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 0.06rem 0.38rem;
  border-radius: 3px;
  color: #ffd2a8;
  border: 1px solid rgba(255, 106, 43, 0.6);
  background: rgba(255, 106, 43, 0.12);
}
</style>
