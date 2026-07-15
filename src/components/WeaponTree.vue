<script setup>
import { ref, computed } from 'vue'
import { usePlanner } from '../stores/planner'
import { QUALITIES, slug } from '../lib/wiki'

const props = defineProps({
  weapon: { type: String, required: true },
  data: { type: Object, required: true }, // { perks:[{name,quality,description}], budget }
})
const planner = usePlanner()

const perks = computed(() =>
  props.data.perks.map((p, i) => ({ ...p, id: `${slug(p.quality)}-${slug(p.name)}-${i}` })),
)
const tiers = computed(() =>
  QUALITIES.map((q) => ({ quality: q, perks: perks.value.filter((p) => p.quality === q) })).filter(
    (t) => t.perks.length,
  ),
)

const budget = computed(() => planner.weaponBudgets[props.weapon] ?? props.data.budget ?? 10)
const selected = computed(() => planner.weaponPerks[props.weapon] || {})
const used = computed(() => Object.keys(selected.value).length)
const full = computed(() => used.value >= budget.value)

const inspected = ref(null)
function inspect(p) {
  inspected.value = p
}
function toggle(p) {
  planner.toggleWeaponPerk(props.weapon, p.id, props.data.budget ?? 10)
  inspect(p)
}
</script>

<template>
  <div class="wtree">
    <div class="wtree-tools">
      <label class="wtree-budget">
        <span>Perk-point budget</span>
        <input
          type="number"
          min="1"
          max="40"
          :value="budget"
          @change="planner.setWeaponBudget(weapon, $event.target.value)"
        />
      </label>
      <span class="wtree-pts" :class="{ full }">{{ used }} / {{ budget }} points</span>
      <button class="wtree-reset" @click="planner.resetWeaponTree(weapon)">Reset tree</button>
    </div>

    <div class="wtree-scroll">
      <div class="wtree-grid">
        <section v-for="t in tiers" :key="t.quality" class="wtier" :data-q="slug(t.quality)">
          <div class="wtier-head">{{ t.quality }}</div>
          <div class="wtier-nodes">
            <button
              v-for="p in t.perks"
              :key="p.id"
              class="wnode"
              :class="{ on: selected[p.id], dim: !selected[p.id] && full }"
              @click="toggle(p)"
              @mouseenter="inspect(p)"
              @focus="inspect(p)"
            >
              <span class="wnode-dot" />
              <span class="wnode-name">{{ p.name }}</span>
            </button>
          </div>
        </section>
      </div>
    </div>

    <div v-if="inspected" class="wdetail" :data-q="slug(inspected.quality)">
      <div class="wdetail-top">
        <span class="wdetail-q">{{ inspected.quality }}</span>
        <strong class="wdetail-name">{{ inspected.name }}</strong>
      </div>
      <p class="wdetail-desc">{{ inspected.description }}</p>
    </div>
  </div>
</template>

<style scoped>
.wtree-tools {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}
.wtree-budget {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 0.6rem;
  color: var(--color-smoke);
}
.wtree-budget input {
  width: 4rem;
  background: rgba(5, 10, 8, 0.7);
  border: 1px solid var(--color-ash);
  color: var(--color-bone);
  border-radius: 2px;
  padding: 0.35rem 0.5rem;
  font-size: 0.9rem;
}
.wtree-pts {
  font-family: var(--font-display);
  font-weight: 700;
  color: var(--color-gold);
  font-size: 0.95rem;
}
.wtree-pts.full {
  color: var(--color-ember);
}
.wtree-reset {
  margin-left: auto;
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.72rem;
  color: var(--color-smoke);
  background: transparent;
  border: 1px solid var(--color-ash);
  border-radius: 2px;
  padding: 0.4rem 0.7rem;
  cursor: pointer;
}
.wtree-reset:hover {
  color: var(--color-bone);
  border-color: var(--color-ash-2);
}

.wtree-scroll {
  overflow-x: auto;
  border: 1px solid var(--color-ash);
  border-radius: 8px;
  background: rgba(7, 17, 13, 0.4);
  padding: 1rem;
}
.wtree-grid {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(11rem, 1fr);
  gap: 0.8rem;
  min-width: max-content;
}
.wtier-head {
  text-align: center;
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 800;
  letter-spacing: 0.08em;
  font-size: 0.72rem;
  padding: 0.35rem;
  margin-bottom: 0.6rem;
  border-radius: 3px;
  color: #0a1410;
}
.wtier[data-q='standard'] .wtier-head {
  background: #9aa8a0;
}
.wtier[data-q='master-crafted'] .wtier-head {
  background: var(--color-drake);
}
.wtier[data-q='artificer'] .wtier-head {
  background: var(--color-cobalt);
}
.wtier[data-q='relic'] .wtier-head {
  background: var(--color-violet);
}
.wtier[data-q='heroic'] .wtier-head {
  background: var(--color-gold);
}
.wtier-nodes {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.wnode {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  text-align: left;
  padding: 0.55rem 0.6rem;
  border: 1px solid var(--color-ash);
  border-radius: 5px;
  background: rgba(14, 28, 22, 0.5);
  color: #c3d0c6;
  font-size: 0.78rem;
  line-height: 1.2;
  cursor: pointer;
  transition: 0.12s;
}
.wnode:hover {
  border-color: var(--color-ash-2);
  color: var(--color-bone);
}
.wnode-dot {
  flex: none;
  width: 10px;
  height: 10px;
  transform: rotate(45deg);
  background: #3a5246;
}
.wtier[data-q='standard'] .wnode-dot {
  background: #9aa8a0;
}
.wtier[data-q='master-crafted'] .wnode-dot {
  background: var(--color-drake);
}
.wtier[data-q='artificer'] .wnode-dot {
  background: var(--color-cobalt);
}
.wtier[data-q='relic'] .wnode-dot {
  background: var(--color-violet);
}
.wtier[data-q='heroic'] .wnode-dot {
  background: var(--color-gold);
}
.wnode.on {
  color: var(--color-bone);
  border-color: var(--color-ember);
  background: rgba(255, 106, 43, 0.12);
  box-shadow: inset 0 0 0 1px rgba(255, 106, 43, 0.35);
}
.wnode.dim {
  opacity: 0.4;
  cursor: not-allowed;
}

.wdetail {
  margin-top: 1rem;
  padding: 0.9rem 1rem;
  border: 1px solid var(--color-ash);
  border-left: 3px solid var(--color-ash-2);
  border-radius: 6px;
  background: rgba(14, 28, 22, 0.4);
}
.wdetail[data-q='standard'] {
  border-left-color: #9aa8a0;
}
.wdetail[data-q='master-crafted'] {
  border-left-color: var(--color-drake);
}
.wdetail[data-q='artificer'] {
  border-left-color: var(--color-cobalt);
}
.wdetail[data-q='relic'] {
  border-left-color: var(--color-violet);
}
.wdetail[data-q='heroic'] {
  border-left-color: var(--color-gold);
}
.wdetail-top {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  margin-bottom: 0.3rem;
}
.wdetail-q {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 0.6rem;
  color: var(--color-gold);
}
.wdetail-name {
  font-family: var(--font-display);
  text-transform: uppercase;
  color: var(--color-bone);
  font-size: 1.05rem;
}
.wdetail-desc {
  color: #c3d0c6;
  font-size: 0.85rem;
  line-height: 1.5;
}
</style>
