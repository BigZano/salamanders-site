<script setup>
import RosterMember from './RosterMember.vue'
import RosterRank from './RosterRank.vue'

// High Command: the first rank's first member as a large hero, and the other
// ranks in a column beside it. Nothing renders when nobody holds High Command.
defineProps({
  // { hero: { rank, member } | null, court: Row[] } from rosterView.js
  banner: { type: Object, required: true },
})
</script>

<template>
  <section v-if="banner.hero" class="rs-high-command surface" data-jump="high-command" aria-label="High Command">
    <div class="rs-hero-block">
      <p class="rs-dais-label">High Command</p>
      <div class="rs-row" :data-rank="banner.hero.rank.key">
        <h3 class="rs-hero-rank">{{ banner.hero.rank.label }}</h3>
        <ul class="rs-hero-list">
          <RosterMember :member="banner.hero.member" hero />
        </ul>
      </div>
    </div>
    <div class="rs-court">
      <RosterRank v-for="r in banner.court" :key="r.rank.key" :row="r" />
    </div>
  </section>
</template>

<style scoped>
.rs-high-command {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1.4fr);
  gap: 1.6rem 2.4rem;
  margin-top: 2rem;
  padding: 1.7rem 1.8rem 1.8rem;
  border-radius: 3px;
}
/* a gold edge and a faint glow: the crown of the page */
.rs-high-command::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -1px;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--color-gold) 30%, var(--color-whitehot) 50%, var(--color-gold) 70%, transparent);
}
.rs-high-command::after {
  content: '';
  position: absolute;
  left: 10%;
  right: 10%;
  top: 0;
  height: 90px;
  background: radial-gradient(60% 100% at 50% 0, rgba(223, 184, 91, 0.12), transparent);
  pointer-events: none;
}
.rs-dais-label {
  margin: 0 0 0.9rem;
  font-family: var(--font-mono);
  font-size: 0.68rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--color-gold);
}
.rs-hero-rank {
  margin: 0 0 0.5rem;
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 0.85rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-gold);
}
.rs-hero-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.rs-court {
  --rs-label-w: 8.5rem;
  display: grid;
  gap: 0.9rem;
  align-content: start;
  padding-left: 2.2rem;
  border-left: 1px solid rgba(223, 184, 91, 0.25);
}
.rs-court :deep(.rs-rank-label) {
  color: var(--color-gold);
}
@media (max-width: 800px) {
  .rs-high-command {
    grid-template-columns: 1fr;
    padding: 1.4rem 1.2rem;
  }
  .rs-court {
    padding: 1.1rem 0 0;
    border-left: 0;
    border-top: 1px solid rgba(223, 184, 91, 0.25);
  }
}
</style>
