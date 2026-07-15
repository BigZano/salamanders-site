<script setup>
import { ref, computed, reactive } from 'vue'
import classes from '../data/classes.json'

const classNames = Object.keys(classes)
const active = ref(classNames[0])
const current = computed(() => classes[active.value])

// Cosmetic perk selection (rough draft — no budget rules yet).
const picked = reactive(new Set())
const key = (perk) => `${active.value}::${perk}`
function toggle(perk) {
  const k = key(perk)
  picked.has(k) ? picked.delete(k) : picked.add(k)
}
const pickedCount = computed(
  () => [...picked].filter((k) => k.startsWith(active.value + '::')).length,
)
const isPicked = (perk) => picked.has(key(perk))

const slots = [
  { key: 'primary', label: 'Primary' },
  { key: 'secondary', label: 'Secondary' },
  { key: 'melee', label: 'Melee' },
]
</script>

<template>
  <section class="planner">
    <header class="p-head">
      <p class="eyebrow">Doctrine</p>
      <h1 class="p-title">Perk Builder</h1>
      <p class="p-intro">
        Pick a class and plan a loadout. Tap perks to mark a path — rough draft, so
        there are no point limits yet.
      </p>
    </header>

    <!-- Class selector -->
    <div class="classbar" role="tablist" aria-label="Classes">
      <button
        v-for="name in classNames"
        :key="name"
        class="class-tab"
        :class="{ on: active === name }"
        role="tab"
        :aria-selected="active === name"
        @click="active = name"
      >
        {{ name }}
      </button>
    </div>

    <!-- Active class -->
    <div class="class-panel">
      <div class="cp-top">
        <div>
          <h2 class="cp-name">{{ active }}</h2>
          <p class="cp-desc">{{ current.description }}</p>
        </div>
        <div class="cp-ability panel-forge">
          <p class="cp-ability-k">Signature ability</p>
          <p class="cp-ability-v">{{ current.ability }}</p>
        </div>
      </div>

      <div class="cp-starting">
        <span class="cp-starting-k">Starting perk</span>
        {{ current.starting }}
      </div>

      <!-- Weapons -->
      <div class="cp-weapons">
        <div v-for="s in slots" :key="s.key" class="wslot">
          <p class="wslot-h">{{ s.label }}</p>
          <div v-if="current.weapons[s.key]?.length" class="wchips">
            <span v-for="w in current.weapons[s.key]" :key="w" class="wchip">{{ w }}</span>
          </div>
          <p v-else class="wnone">Not available to this class</p>
        </div>
      </div>

      <!-- Perk grid -->
      <div class="perks-head">
        <h3 class="perks-title">Perk Tree</h3>
        <span class="perks-count">{{ pickedCount }} selected</span>
      </div>
      <div class="perk-rows">
        <div v-for="(row, ri) in current.rows" :key="ri" class="perk-row">
          <span class="perk-row-n">{{ ri + 1 }}</span>
          <div class="perk-cells">
            <button
              v-for="perk in row"
              :key="perk"
              class="perk"
              :class="{ on: isPicked(perk) }"
              @click="toggle(perk)"
            >
              {{ perk }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.planner {
  max-width: 68rem;
  margin: 0 auto;
  padding: 4rem 1.5rem 2rem;
}
.p-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: clamp(2.2rem, 7vw, 3.6rem);
  color: var(--color-bone);
  margin: 0.4rem 0 0.6rem;
}
.p-intro {
  color: var(--color-smoke);
  max-width: 54ch;
  line-height: 1.6;
}

.classbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 2rem 0 1.5rem;
}
.class-tab {
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
.class-tab:hover {
  color: var(--color-bone);
  border-color: var(--color-ash-2);
}
.class-tab.on {
  color: #1a0d06;
  background: linear-gradient(180deg, #ffb066, #ff6a2b);
  border-color: rgba(255, 176, 102, 0.6);
}

.class-panel {
  border: 1px solid var(--color-ash);
  border-radius: 6px;
  padding: 1.6rem;
  background: rgba(7, 17, 13, 0.5);
}
.cp-top {
  display: flex;
  gap: 1.5rem;
  justify-content: space-between;
  flex-wrap: wrap;
}
.cp-name {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: 1.8rem;
  color: var(--color-drake);
}
.cp-desc {
  color: #c3d0c6;
  line-height: 1.6;
  max-width: 46ch;
  margin-top: 0.4rem;
}
.cp-ability {
  border-radius: 4px;
  padding: 0.8rem 1rem;
  min-width: 12rem;
}
.cp-ability-k {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.16em;
  font-size: 0.62rem;
  color: var(--color-gold);
}
.cp-ability-v {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: 1.15rem;
  color: var(--color-bone);
  margin-top: 0.2rem;
}
.cp-starting {
  margin: 1.2rem 0;
  padding: 0.7rem 0.9rem;
  border-left: 2px solid var(--color-ember);
  background: rgba(255, 106, 43, 0.05);
  color: #c3d0c6;
  font-size: 0.92rem;
  line-height: 1.5;
}
.cp-starting-k {
  display: block;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.16em;
  font-size: 0.62rem;
  color: var(--color-gold);
  margin-bottom: 0.2rem;
}

.cp-weapons {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  gap: 1rem;
  margin-bottom: 1.6rem;
}
.wslot-h {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.16em;
  font-size: 0.66rem;
  color: var(--color-smoke);
  margin-bottom: 0.5rem;
}
.wchips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.wchip {
  font-size: 0.8rem;
  color: var(--color-bone);
  background: rgba(89, 214, 108, 0.07);
  border: 1px solid rgba(89, 214, 108, 0.2);
  border-radius: 2px;
  padding: 0.25rem 0.55rem;
}
.wnone {
  color: #5f6f66;
  font-size: 0.82rem;
  font-style: italic;
}

.perks-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  border-top: 1px solid var(--color-ash);
  padding-top: 1.4rem;
  margin-bottom: 1rem;
}
.perks-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: 1.2rem;
  color: var(--color-bone);
}
.perks-count {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--color-gold);
}
.perk-row {
  display: flex;
  gap: 0.7rem;
  margin-bottom: 0.7rem;
  align-items: stretch;
}
.perk-row-n {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.8rem;
  font-family: var(--font-display);
  font-weight: 700;
  color: var(--color-gold);
  border: 1px solid var(--color-ash);
  border-radius: 2px;
  background: rgba(223, 184, 91, 0.05);
}
.perk-cells {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
  gap: 0.4rem;
  flex: 1;
}
.perk {
  text-align: left;
  font-size: 0.78rem;
  line-height: 1.25;
  color: #c3d0c6;
  background: rgba(14, 28, 22, 0.55);
  border: 1px solid var(--color-ash);
  border-radius: 2px;
  padding: 0.5rem 0.6rem;
  cursor: pointer;
  transition: all 0.12s ease;
}
.perk:hover {
  border-color: var(--color-ash-2);
  color: var(--color-bone);
}
.perk.on {
  color: var(--color-bone);
  border-color: var(--color-ember);
  background: rgba(255, 106, 43, 0.12);
  box-shadow: inset 0 0 0 1px rgba(255, 106, 43, 0.3);
}

@media (max-width: 600px) {
  .class-panel {
    padding: 1.1rem;
  }
  .perk-cells {
    grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr));
  }
}
</style>
