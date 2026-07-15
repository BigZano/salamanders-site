<script setup>
import builds from '../data/builds.json'

const DISCORD = 'https://discord.gg/salamanders'
</script>

<template>
  <section class="builds">
    <header class="b-head">
      <p class="eyebrow">Field-tested</p>
      <h1 class="b-title">Recommended Builds</h1>
      <p class="b-intro">
        Loadouts the Chapter runs on the hardest difficulties.
      </p>
    </header>

    <!-- Populated builds -->
    <div v-if="builds.length" class="b-grid">
      <article v-for="b in builds" :key="b.id" class="b-card panel-forge">
        <div class="b-card-top">
          <h2 class="b-name">{{ b.title }}</h2>
          <span v-if="b.class" class="b-class">{{ b.class }}</span>
        </div>
        <p v-if="b.author" class="b-author">by {{ b.author }}</p>

        <dl v-if="b.primary || b.secondary || b.melee" class="b-load">
          <div v-if="b.primary"><dt>Primary</dt><dd>{{ b.primary }}</dd></div>
          <div v-if="b.secondary"><dt>Secondary</dt><dd>{{ b.secondary }}</dd></div>
          <div v-if="b.melee"><dt>Melee</dt><dd>{{ b.melee }}</dd></div>
        </dl>

        <div v-if="b.perks?.length" class="b-perks">
          <span v-for="p in b.perks" :key="p" class="b-perk">{{ p }}</span>
        </div>

        <p v-if="b.notes" class="b-notes">{{ b.notes }}</p>
      </article>
    </div>

    <!-- Empty state -->
    <div v-else class="b-empty panel-forge">
      <div class="b-empty-mark" aria-hidden="true">
        <span /><span /><span />
      </div>
      <h2 class="b-empty-title">No builds forged yet</h2>
      <p class="b-empty-body">
        The Chapter's builds live in our Discord. Once we migrate them, they'll appear
        here — searchable, by class, with weapons and perks.
      </p>
      <a class="btn-ember b-empty-cta" :href="DISCORD" target="_blank" rel="noopener">
        Find builds in Discord
      </a>
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
  gap: 0.6rem;
}
.b-name {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: 1.25rem;
  color: var(--color-bone);
  line-height: 1.1;
}
.b-class {
  flex: none;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 0.6rem;
  color: var(--color-drake);
  border: 1px solid rgba(89, 214, 108, 0.35);
  border-radius: 2px;
  padding: 2px 6px;
}
.b-author {
  color: var(--color-smoke);
  font-size: 0.82rem;
  margin: 0.3rem 0 0.9rem;
}
.b-load {
  margin: 0 0 0.9rem;
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
.b-perks {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.b-perk {
  font-size: 0.74rem;
  color: #c3d0c6;
  background: rgba(255, 106, 43, 0.07);
  border: 1px solid rgba(255, 106, 43, 0.22);
  border-radius: 2px;
  padding: 0.2rem 0.5rem;
}
.b-notes {
  color: var(--color-smoke);
  font-size: 0.85rem;
  line-height: 1.5;
  margin-top: 0.8rem;
}

/* Empty state */
.b-empty {
  margin-top: 2.5rem;
  border-radius: 8px;
  padding: 3.5rem 1.5rem;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.b-empty-mark {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1.4rem;
}
.b-empty-mark span {
  width: 9px;
  height: 9px;
  transform: rotate(45deg);
  background: linear-gradient(180deg, #ffb066, #ff6a2b);
  box-shadow: 0 0 12px rgba(255, 106, 43, 0.6);
  opacity: 0.5;
}
.b-empty-mark span:nth-child(2) {
  opacity: 1;
}
.b-empty-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: 1.6rem;
  color: var(--color-bone);
}
.b-empty-body {
  color: var(--color-smoke);
  max-width: 42ch;
  line-height: 1.6;
  margin: 0.6rem 0 1.6rem;
}
.b-empty-cta {
  padding: 0.85rem 1.5rem;
  border-radius: 2px;
}
</style>
