<script setup>
import { computed } from 'vue'
import classes from '../data/classes.json'

// Rough starter loadouts derived from class data. Placeholders for the
// Chapter to curate — flagged clearly so admins comment, not take as final.
const builds = computed(() =>
  Object.entries(classes).map(([name, c]) => ({
    name,
    ability: c.ability,
    primary: c.weapons.primary?.[0] || '—',
    secondary: c.weapons.secondary?.[0] || '—',
    melee: c.weapons.melee?.[0] || '—',
    perks: [c.rows?.[0]?.[0], c.rows?.[1]?.[0], c.rows?.[2]?.[0]].filter(Boolean),
  })),
)
</script>

<template>
  <section class="builds">
    <header class="b-head">
      <p class="eyebrow">Field-tested</p>
      <h1 class="b-title">Recommended Builds</h1>
      <p class="b-intro">
        Starter loadouts, one per class. These are
        <strong class="draft-word">draft templates</strong> auto-filled from class data —
        for the Chapter to review and replace with real recommendations.
      </p>
    </header>

    <div class="b-grid">
      <article v-for="b in builds" :key="b.name" class="b-card panel-forge">
        <div class="b-card-top">
          <h2 class="b-name">{{ b.name }}</h2>
          <span class="b-tag">Draft</span>
        </div>
        <p class="b-ability">{{ b.ability }}</p>

        <dl class="b-load">
          <div><dt>Primary</dt><dd>{{ b.primary }}</dd></div>
          <div><dt>Secondary</dt><dd>{{ b.secondary }}</dd></div>
          <div><dt>Melee</dt><dd>{{ b.melee }}</dd></div>
        </dl>

        <p class="b-perks-k">Key perks</p>
        <div class="b-perks">
          <span v-for="p in b.perks" :key="p" class="b-perk">{{ p }}</span>
        </div>

        <RouterLink to="/planner" class="b-edit">Open in builder →</RouterLink>
      </article>
    </div>
  </section>
</template>

<style scoped>
.builds {
  max-width: 68rem;
  margin: 0 auto;
  padding: 4rem 1.5rem 2rem;
}
.b-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: clamp(2.2rem, 7vw, 3.6rem);
  color: var(--color-bone);
  margin: 0.4rem 0 0.6rem;
}
.b-intro {
  color: var(--color-smoke);
  max-width: 58ch;
  line-height: 1.6;
}
.draft-word {
  color: var(--color-gold);
  font-weight: 600;
}

.b-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
  gap: 1rem;
  margin-top: 2rem;
}
.b-card {
  display: flex;
  flex-direction: column;
  border-radius: 6px;
  padding: 1.3rem;
}
.b-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.b-name {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: 1.35rem;
  color: var(--color-drake);
}
.b-tag {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.14em;
  font-size: 0.58rem;
  color: var(--color-gold);
  border: 1px solid rgba(223, 184, 91, 0.4);
  border-radius: 2px;
  padding: 2px 6px;
}
.b-ability {
  color: var(--color-smoke);
  font-size: 0.85rem;
  margin: 0.3rem 0 1rem;
}
.b-load {
  margin: 0 0 1rem;
  display: grid;
  gap: 0.4rem;
}
.b-load div {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid rgba(38, 55, 47, 0.5);
  padding-bottom: 0.35rem;
}
.b-load dt {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 0.64rem;
  color: var(--color-smoke);
}
.b-load dd {
  margin: 0;
  font-size: 0.85rem;
  color: var(--color-bone);
  text-align: right;
}
.b-perks-k {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.16em;
  font-size: 0.6rem;
  color: var(--color-gold);
  margin-bottom: 0.5rem;
}
.b-perks {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  flex-grow: 1;
  align-content: flex-start;
}
.b-perk {
  font-size: 0.74rem;
  color: #c3d0c6;
  background: rgba(255, 106, 43, 0.07);
  border: 1px solid rgba(255, 106, 43, 0.22);
  border-radius: 2px;
  padding: 0.2rem 0.5rem;
}
.b-edit {
  margin-top: 1.1rem;
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.78rem;
  color: var(--color-drake);
}
</style>
