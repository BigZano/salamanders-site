<script setup>
import HeroForge from '../components/HeroForge.vue'

const ops = [
  {
    to: '/planner',
    kite: 'Doctrine',
    title: 'Perk Builder',
    body: 'Plan every class — Tactical to Sniper — and forge a build perk by perk.',
  },
  {
    to: '/armoury',
    kite: 'Wargear',
    title: 'Weapon Armoury',
    body: 'Every weapon by slot — primary, secondary, melee — and the classes that bear it.',
  },
  {
    to: '/builds',
    kite: 'Field-tested',
    title: 'Recommended Builds',
    body: 'Save your class loadouts, then apply or share them in a click.',
  },
  {
    to: '/companies',
    kite: 'The Chapter',
    title: 'Companies & Roster',
    body: 'Our companies, their sections, and the brothers who hold the line.',
  },
]
</script>

<template>
  <HeroForge />

  <section class="ops">
    <div class="ops-head">
      <p class="eyebrow">Operations Planner</p>
      <h2 class="ops-title">Muster the Chapter</h2>
    </div>
    <div class="ops-grid">
      <RouterLink v-for="o in ops" :key="o.to" :to="o.to" class="ops-card panel-forge">
        <p class="ops-kite">{{ o.kite }}</p>
        <h3 class="ops-card-title">{{ o.title }}</h3>
        <p class="ops-body">{{ o.body }}</p>
        <span class="ops-go">Enter →</span>
      </RouterLink>
    </div>
  </section>
</template>

<style scoped>
.ops {
  max-width: 76rem;
  margin: 0 auto;
  padding: 2rem 1.5rem 1rem;
}
.ops-head {
  margin-bottom: 1.5rem;
}
.ops-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: clamp(1.8rem, 5vw, 2.8rem);
  letter-spacing: 0.01em;
  margin: 0.3rem 0 0;
  color: var(--color-bone);
}
.ops-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: 1rem;
}
.ops-card {
  display: flex;
  flex-direction: column;
  padding: 1.4rem;
  border-radius: 4px;
  transition: transform 0.18s ease, border-color 0.18s ease;
}
.ops-card:hover {
  transform: translateY(-3px);
  border-color: var(--color-drake);
}
.ops-kite {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.22em;
  font-size: 0.64rem;
  color: var(--color-gold);
}
.ops-card-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: 1.25rem;
  margin: 0.5rem 0 0.4rem;
  color: var(--color-bone);
}
.ops-body {
  color: var(--color-smoke);
  font-size: 0.9rem;
  line-height: 1.5;
  flex-grow: 1;
}
.ops-go {
  margin-top: 1rem;
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.8rem;
  color: var(--color-drake);
}
</style>
