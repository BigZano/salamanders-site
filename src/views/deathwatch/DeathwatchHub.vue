<script setup>
// The fortress's front hall, as the original's destination menu: the crest and the name, one painted card for
// each area (straight to its first view), and a way back to the Salamanders. The Manage button is the Watch
// Commander's alone (a convenience only: the server enforces it). The animated door that opened onto this menu
// is not part of it here.
import { computed } from 'vue'
import { AREAS, resolveArea } from '../../lib/deathwatch/areas'
import { iconFor } from '../../lib/deathwatch/icons'
import { useDeathwatch } from '../../stores/deathwatch'
import crest from '../../components/deathwatch/img/crest-large.webp'
import clan from '../../components/deathwatch/img/clan.png'
import trackerArt from '../../components/deathwatch/img/card-tracker.webp'
import armouringArt from '../../components/deathwatch/img/card-armouring.jpg'
import chroniclesArt from '../../components/deathwatch/img/card-chronicles.webp'

const store = useDeathwatch()
const ART = { eventtracker: trackerArt, armouringhall: armouringArt, chronicles: chroniclesArt }
// The three areas everyone sees. Manage has no card: it is a button, below.
const cards = computed(() =>
  Object.entries(AREAS)
    .filter(([area]) => Object.hasOwn(ART, area))
    .map(([area, { label, blurb }]) => ({ area, label, blurb, art: ART[area], to: resolveArea({ area }).canonical })),
)
const manageTo = resolveArea({ area: 'manage' }).canonical
</script>

<template>
  <section class="dw-hub">
    <header class="dw-hub-head">
      <img class="dw-hub-crest" :src="crest" alt="Deathwatch crest of Watch Fortress Ebonhold" width="190" height="190" />
      <p class="dw-hub-eyebrow">XVIIIth Legiones Astartes, The Salamanders</p>
      <h1 class="dw-hub-title">Watch Fortress Ebonhold</h1>
      <p class="dw-hub-tagline">Suffer not the alien to live.</p>
      <p class="dw-hub-prompt">Choose your destination</p>
    </header>
    <ul class="dw-hub-cards">
      <li v-for="card in cards" :key="card.area">
        <RouterLink class="dw-card" :to="card.to">
          <img class="dw-card-art" :src="card.art" alt="" width="320" height="180" loading="lazy" />
          <span class="dw-card-title">{{ card.label }}</span>
          <span class="dw-card-blurb">{{ card.blurb }}</span>
        </RouterLink>
      </li>
    </ul>
    <RouterLink class="dw-card dw-card-home" to="/">
      <img class="dw-card-icon" :src="clan" alt="" width="44" height="44" loading="lazy" />
      <span class="dw-card-text">
        <span class="dw-card-title">Return to the Salamanders</span>
        <span class="dw-card-blurb">Back to the main site</span>
      </span>
    </RouterLink>
    <RouterLink v-if="store.commander" class="dw-manage dw-btn" :to="manageTo">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
        <component :is="shape[0]" v-for="(shape, i) in iconFor('manage')" :key="i" v-bind="shape[1]" />
      </svg>
      Manage
    </RouterLink>
  </section>
</template>

<style scoped>
.dw-hub {
  display: grid;
  justify-items: center;
  gap: 1.1rem;
  max-width: 52rem;
  margin: 0 auto;
  padding: 2rem 1rem 3rem;
}
.dw-hub-head {
  display: grid;
  justify-items: center;
  gap: 0.5rem;
  padding: 1.2rem 1.5rem;
  text-align: center;
  background: radial-gradient(ellipse at center, rgb(6 9 6 / 0.7), transparent 72%);
}
.dw-hub-crest {
  width: clamp(110px, 26vw, 160px);
  height: auto;
  filter: drop-shadow(0 10px 30px rgb(0 0 0 / 0.6)) drop-shadow(0 0 14px rgb(255 120 30 / 0.35));
}
.dw-hub-eyebrow {
  margin: 0;
  font: 600 clamp(0.75rem, 1.6vw, 0.95rem) / 1.3 var(--dw-font-cond);
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--dw-accent);
}
.dw-hub-title {
  margin: 0;
  font-family: var(--dw-font-title);
  font-size: clamp(2rem, 7vw, 3.6rem);
  font-weight: 700;
  line-height: 1.02;
  letter-spacing: 0.04em;
  color: var(--dw-ink);
  text-wrap: balance;
}
.dw-hub-tagline {
  margin: 0;
  font-style: italic;
  font-weight: 500;
  color: var(--dw-muted);
}
.dw-hub-prompt {
  margin: 0.6rem 0 0;
  font: 600 0.8rem / 1.2 var(--dw-font-cond);
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--dw-silver);
}
/* One card per row on a phone, three side by side from 640px. */
.dw-hub-cards {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.9rem;
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}
@media (min-width: 640px) {
  .dw-hub-cards {
    grid-template-columns: repeat(3, 1fr);
  }
}
.dw-card {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  height: 100%;
  min-height: 44px;
  overflow: hidden;
  border: 1px solid var(--dw-line-2);
  background: color-mix(in oklab, var(--dw-surface) 92%, transparent);
  transition:
    transform 0.15s var(--ease-forge),
    border-color 0.2s ease;
}
.dw-card-art {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  max-height: 11rem;
  object-fit: cover;
}
.dw-card-title {
  padding: 0.6rem 1rem 0;
  font-family: var(--dw-font-title);
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--dw-ink);
}
.dw-card-blurb {
  padding: 0 1rem 0.9rem;
  font-size: 0.9rem;
  line-height: 1.45;
  color: var(--dw-muted);
}
/* The card back to the Salamanders: full width under the three, a row with the clan's icon. */
.dw-card-home {
  flex-direction: row;
  align-items: center;
  gap: 1rem;
  width: 100%;
  height: auto;
  min-height: 64px;
  padding: 0.7rem 1rem;
}
.dw-card-home .dw-card-icon {
  flex: none;
  width: 44px;
  height: 44px;
  object-fit: contain;
}
.dw-card-text {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.dw-card-home .dw-card-title,
.dw-card-home .dw-card-blurb {
  padding: 0;
}
@media (hover: hover) and (pointer: fine) {
  .dw-card:hover {
    border-color: var(--dw-accent);
  }
}
.dw-card:active {
  transform: scale(0.98);
}
.dw-manage {
  justify-self: start;
  gap: 0.6rem;
  margin-top: 0.5rem;
  text-decoration: none;
}
.dw-manage svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
