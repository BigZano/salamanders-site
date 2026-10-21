<script setup>
// The fortress's front hall: one card for each area, straight to its first view, and a way back to the
// Salamanders. The Manage card is the Watch Commander's alone (a convenience only: the server enforces it).
import { computed } from 'vue'
import { AREAS, resolveArea } from '../../lib/deathwatch/areas'
import { useDeathwatch } from '../../stores/deathwatch'

const store = useDeathwatch()
const cards = computed(() =>
  Object.entries(AREAS)
    .filter(([area]) => area !== 'manage' || store.commander)
    .map(([area, { label, blurb }]) => ({ area, label, blurb, to: resolveArea({ area }).canonical })),
)
</script>

<template>
  <section class="dw-hub">
    <header class="dw-hub-head">
      <p class="dw-hub-eyebrow">XVIIIth Legiones Astartes, The Salamanders</p>
      <h1 class="dw-hub-title">Watch Fortress Ebonhold</h1>
      <p class="dw-hub-tagline">Suffer not the alien to live.</p>
    </header>
    <ul class="dw-hub-cards">
      <li v-for="card in cards" :key="card.area">
        <RouterLink class="dw-card" :to="card.to">
          <span class="dw-card-title">{{ card.label }}</span>
          <span class="dw-card-blurb">{{ card.blurb }}</span>
        </RouterLink>
      </li>
      <li>
        <RouterLink class="dw-card dw-card-home" to="/">
          <span class="dw-card-title">Return to the Salamanders</span>
          <span class="dw-card-blurb">Back to the main site</span>
        </RouterLink>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.dw-hub {
  max-width: 60rem;
  margin: 0 auto;
  padding: 2.5rem 1rem 3rem;
}
.dw-hub-head {
  margin-bottom: 2rem;
  text-align: center;
}
.dw-hub-eyebrow {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--dw-accent);
}
.dw-hub-title {
  margin: 0.6rem 0;
  font-family: var(--dw-font-title);
  font-size: clamp(2rem, 8vw, 3.4rem);
  font-weight: 700;
  line-height: 1.05;
  color: var(--dw-ink);
}
.dw-hub-tagline {
  margin: 0;
  font-style: italic;
  color: var(--dw-muted);
}
/* One full-width card per row on a phone, two from 640px, three from 900px. */
.dw-hub-cards {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.9rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
@media (min-width: 640px) {
  .dw-hub-cards {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (min-width: 900px) {
  .dw-hub-cards {
    grid-template-columns: repeat(3, 1fr);
  }
}
.dw-card {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.3rem;
  height: 100%;
  min-height: 88px;
  padding: 1rem 1.2rem;
  border: 1px solid var(--dw-line-2);
  border-radius: 3px;
  background: var(--dw-surface);
  transition:
    transform 0.15s var(--ease-forge),
    border-color 0.2s ease;
}
.dw-card-home {
  border-style: dashed;
}
.dw-card-title {
  font-family: var(--dw-font-title);
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--dw-ink);
}
.dw-card-blurb {
  font-size: 0.9rem;
  line-height: 1.45;
  color: var(--dw-muted);
}
@media (hover: hover) and (pointer: fine) {
  .dw-card:hover {
    border-color: var(--dw-accent);
  }
}
.dw-card:active {
  transform: scale(0.98);
}
</style>
