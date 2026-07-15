<script setup>
import { ref, computed } from 'vue'
import weapons from '../data/weapons.json'
import classes from '../data/classes.json'

const cats = [
  { key: 'primary', label: 'Primary' },
  { key: 'secondary', label: 'Secondary' },
  { key: 'melee', label: 'Melee' },
]
const active = ref('primary')
const q = ref('')

const classNames = Object.keys(classes)

// weapon -> [classes that can equip it] for the active category, filtered by search
const list = computed(() =>
  weapons.fallbackWeapons[active.value]
    .filter((w) => w.toLowerCase().includes(q.value.trim().toLowerCase()))
    .map((w) => ({
      name: w,
      users: classNames.filter((c) => classes[c].weapons[active.value]?.includes(w)),
    })),
)
</script>

<template>
  <section class="armoury">
    <header class="a-head">
      <p class="eyebrow">Wargear</p>
      <h1 class="a-title">Weapon Armoury</h1>
      <p class="a-intro">
        Every weapon of the Chapter, by slot, and the classes that bear it.
      </p>
    </header>

    <input
      v-model="q"
      class="w-search"
      type="search"
      placeholder="Search weapons…"
      aria-label="Search weapons"
    />

    <div class="catbar" role="tablist" aria-label="Weapon categories">
      <button
        v-for="c in cats"
        :key="c.key"
        class="cat-tab"
        :class="{ on: active === c.key }"
        role="tab"
        :aria-selected="active === c.key"
        @click="active = c.key"
      >
        {{ c.label }}
        <span class="cat-count">{{ weapons.fallbackWeapons[c.key].length }}</span>
      </button>
    </div>

    <div class="w-grid">
      <article v-for="w in list" :key="w.name" class="w-card panel-forge">
        <h2 class="w-name">{{ w.name }}</h2>
        <p class="w-users-k">Used by</p>
        <div v-if="w.users.length" class="w-users">
          <RouterLink
            v-for="u in w.users"
            :key="u"
            to="/planner"
            class="w-user"
          >{{ u }}</RouterLink>
        </div>
        <p v-else class="w-users-none">No class in the current data</p>
      </article>
    </div>

    <p v-if="!list.length" class="w-empty">No weapons match “{{ q }}”.</p>

    <p class="w-note">
      <span class="w-note-dot" /> Per-weapon perk trees — quality tiers, point budgets and
      node paths — sync from the game wiki. That build is next.
    </p>
  </section>
</template>

<style scoped>
.armoury {
  max-width: 68rem;
  margin: 0 auto;
  padding: 4rem 1.5rem 2rem;
}
.a-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: clamp(2.2rem, 7vw, 3.6rem);
  color: var(--color-bone);
  margin: 0.4rem 0 0.6rem;
}
.a-intro {
  color: var(--color-smoke);
  max-width: 54ch;
  line-height: 1.6;
}
.w-search {
  margin-top: 1.4rem;
  width: 100%;
  max-width: 24rem;
  padding: 0.65rem 1rem;
  background: rgba(14, 28, 22, 0.6);
  border: 1px solid var(--color-ash);
  border-radius: 3px;
  color: var(--color-bone);
  font-size: 0.95rem;
}
.w-search::placeholder {
  color: #5f6f66;
}
.w-empty {
  color: var(--color-smoke);
  padding: 1.5rem 0;
}
.w-note {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: 1.5rem;
  padding-top: 1.2rem;
  border-top: 1px solid var(--color-ash);
  color: var(--color-smoke);
  font-size: 0.85rem;
  line-height: 1.5;
}
.w-note-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-gold);
  box-shadow: 0 0 8px rgba(223, 184, 91, 0.6);
}

.catbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 2rem 0 1.5rem;
}
.cat-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.9rem;
  color: var(--color-smoke);
  background: rgba(14, 28, 22, 0.5);
  border: 1px solid var(--color-ash);
  padding: 0.55rem 1rem;
  border-radius: 2px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.cat-tab:hover {
  color: var(--color-bone);
}
.cat-tab.on {
  color: #1a0d06;
  background: linear-gradient(180deg, #ffb066, #ff6a2b);
  border-color: rgba(255, 176, 102, 0.6);
}
.cat-count {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  opacity: 0.7;
}

.w-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
  gap: 0.9rem;
}
.w-card {
  border-radius: 5px;
  padding: 1.1rem;
}
.w-name {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: 1.15rem;
  color: var(--color-bone);
  line-height: 1.1;
}
.w-users-k {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.16em;
  font-size: 0.6rem;
  color: var(--color-gold);
  margin: 0.8rem 0 0.5rem;
}
.w-users {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.w-user {
  font-size: 0.76rem;
  color: var(--color-drake);
  background: rgba(89, 214, 108, 0.07);
  border: 1px solid rgba(89, 214, 108, 0.2);
  border-radius: 2px;
  padding: 0.2rem 0.5rem;
  transition: background 0.15s ease;
}
.w-user:hover {
  background: rgba(89, 214, 108, 0.15);
}
.w-users-none {
  color: #5f6f66;
  font-size: 0.8rem;
  font-style: italic;
}
</style>
