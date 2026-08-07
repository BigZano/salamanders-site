<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import weapons from '../data/weapons.json'
import classes from '../data/classes.json'
import { usePlanner } from '../stores/planner'
import { WIKI } from '../lib/wiki'
import { resolveWeapon, SOURCE_LABEL, slotAverages, GAUGE_MAX } from '../lib/weapons'
import WeaponTree from '../components/WeaponTree.vue'

const planner = usePlanner()

const cats = [
  { key: 'primary', label: 'Primary' },
  { key: 'secondary', label: 'Secondary' },
  { key: 'melee', label: 'Melee' },
]
const active = ref('primary')
const q = ref('')
const classNames = Object.keys(classes)

const classesFor = (name) =>
  classNames.filter((c) => classes[c].weapons[active.value]?.includes(name))

const list = computed(() =>
  weapons.fallbackWeapons[active.value]
    .filter((w) => w.toLowerCase().includes(q.value.trim().toLowerCase()))
    .map((w) => ({
      name: w,
      users: classNames.filter((c) => classes[c].weapons[active.value]?.includes(w)),
    })),
)

const activeWeapon = ref(null)
const status = ref('idle') // idle | loading | ready | error
const data = ref(null)
const errorMsg = ref('')

const toast = ref('')
let tt
function flash(m) {
  toast.value = m
  clearTimeout(tt)
  tt = setTimeout(() => (toast.value = ''), 1800)
}

async function selectWeapon(name) {
  activeWeapon.value = name
  status.value = 'loading'
  data.value = null
  const resolved = await resolveWeapon(name)
  if (resolved) {
    data.value = resolved
    versionIndex.value = Math.max(
      0,
      (resolved.versions || []).findIndex((v) => v.quality === 'Standard'),
    )
    status.value = 'ready'
  } else {
    errorMsg.value = 'No perk tree for this weapon yet — the wiki page has no perk table.'
    status.value = 'error'
  }
}

function setCat(key) {
  active.value = key
  activeWeapon.value = null
  status.value = 'idle'
}

// ---- stats ----
const versionIndex = ref(0)
const versions = computed(() => data.value?.versions || [])
const version = computed(() => versions.value[versionIndex.value] || null)

// Slot average, so each bar reads against its peers rather than in a vacuum.
const averages = computed(() => slotAverages(weapons.fallbackWeapons[active.value]))

const gauges = computed(() => {
  const g = version.value?.gauges
  if (!g) return []
  return Object.entries(g).map(([label, { value, raw }]) => {
    const avg = averages.value[label]
    const delta = typeof avg === 'number' ? value - avg : null
    return {
      label,
      value,
      raw,
      pct: Math.min(100, (value / GAUGE_MAX) * 100),
      avgPct: typeof avg === 'number' ? Math.min(100, (avg / GAUGE_MAX) * 100) : null,
      delta,
      trend: delta === null ? '' : delta > 0.25 ? 'over' : delta < -0.25 ? 'under' : 'par',
    }
  })
})

const figures = computed(() => Object.entries(version.value?.figures || {}))

const canEquip = computed(
  () =>
    activeWeapon.value &&
    classes[planner.activeClass].weapons[active.value]?.includes(activeWeapon.value),
)
function equip() {
  if (!canEquip.value) return
  planner.setWeapon(active.value, activeWeapon.value)
  flash(`${activeWeapon.value} equipped for ${planner.activeClass}`)
}
const wikiUrl = (name) => WIKI + encodeURIComponent(name)

// Deep link: /armoury?w=Bolt Rifle — used by the Builds page and share links.
const route = useRoute()
function openFromQuery(name) {
  if (!name) return
  const cat = cats.find((c) => weapons.fallbackWeapons[c.key].includes(name))
  if (!cat) return
  active.value = cat.key
  q.value = ''
  selectWeapon(name)
}
onMounted(() => openFromQuery(route.query.w))
watch(() => route.query.w, openFromQuery)
</script>

<template>
  <section class="armoury">
    <header class="a-head">
      <p class="eyebrow">Wargear</p>
      <h1 class="a-title">Weapon Armoury</h1>
      <p class="a-intro">
        Every weapon of the Chapter. Pick one to plan its perk tree. Trees ship with the
        site and are re-synced weekly.
      </p>
    </header>

    <div class="a-controls">
      <div class="catbar" role="tablist" aria-label="Weapon categories">
        <button
          v-for="c in cats"
          :key="c.key"
          class="cat-tab"
          :class="{ on: active === c.key }"
          role="tab"
          :aria-selected="active === c.key"
          @click="setCat(c.key)"
        >
          {{ c.label }}
          <span class="cat-count">{{ weapons.fallbackWeapons[c.key].length }}</span>
        </button>
      </div>
      <input
        v-model="q"
        class="w-search"
        type="search"
        placeholder="Search weapons…"
        aria-label="Search weapons"
      />
    </div>

    <div class="a-layout">
      <!-- Weapon list -->
      <nav class="w-list" aria-label="Weapons">
        <button
          v-for="w in list"
          :key="w.name"
          class="w-item"
          :class="{ on: activeWeapon === w.name }"
          @click="selectWeapon(w.name)"
        >
          {{ w.name }}
          <span class="w-item-users">{{ w.users.length }}</span>
        </button>
        <p v-if="!list.length" class="w-empty">No weapons match “{{ q }}”.</p>
      </nav>

      <!-- Weapon detail -->
      <div class="w-detail">
        <div v-if="status === 'idle'" class="w-prompt">
          <span class="w-prompt-mark">⚒</span>
          <p>Select a weapon to plan its perk tree.</p>
        </div>

        <div v-else-if="status === 'loading'" class="w-loading">
          <span class="spinner" /> Syncing {{ activeWeapon }} from the wiki…
        </div>

        <div v-else-if="status === 'error'" class="w-error">
          <h2>{{ activeWeapon }}</h2>
          <p>{{ errorMsg }}</p>
          <div class="w-error-actions">
            <button class="btn-drake btn-sm" @click="selectWeapon(activeWeapon)">Retry</button>
            <a class="btn-ghost btn-sm" :href="wikiUrl(activeWeapon)" target="_blank" rel="noopener">Open wiki ↗</a>
          </div>
        </div>

        <template v-else-if="status === 'ready' && data">
          <div class="w-hero">
            <div>
              <p class="eyebrow">
                {{ data.meta?.slot || active }}<span v-if="data.meta?.category"> · {{ data.meta.category }}</span>
              </p>
              <h2 class="w-hero-name">{{ activeWeapon }}</h2>
            </div>
            <span class="w-src" :class="data.source">
              {{ SOURCE_LABEL[data.source] }}
            </span>
          </div>

          <dl class="w-tags">
            <div v-if="data.meta?.damageType">
              <dt>Damage</dt>
              <dd>{{ data.meta.damageType }}</dd>
            </div>
            <div>
              <dt>Classes</dt>
              <dd>{{ classesFor(activeWeapon).join(', ') || 'None' }}</dd>
            </div>
          </dl>

          <p v-if="data.intro?.length" class="w-hero-intro">{{ data.intro.join(' ') }}</p>

          <!-- Stat block -->
          <section v-if="versions.length" class="stats">
            <div class="stats-head">
              <h3 class="stats-title">Statistics</h3>
              <label class="stats-version">
                <span>Version</span>
                <select v-model.number="versionIndex">
                  <option v-for="(v, i) in versions" :key="i" :value="i">
                    {{ v.name }}<span v-if="v.quality"> — {{ v.quality }}</span>
                  </option>
                </select>
              </label>
            </div>

            <ul class="gauges">
              <li v-for="g in gauges" :key="g.label" class="gauge">
                <span class="gauge-label">{{ g.label }}</span>
                <span class="gauge-track">
                  <span class="gauge-fill" :class="g.trend" :style="{ width: g.pct + '%' }" />
                  <span
                    v-if="g.avgPct !== null"
                    class="gauge-avg"
                    :style="{ left: g.avgPct + '%' }"
                    :title="`Slot average ${g.delta >= 0 ? '' : ''}`"
                  />
                </span>
                <span class="gauge-val">{{ g.raw }}</span>
                <span class="gauge-delta" :class="g.trend">
                  {{ g.delta === null ? '' : (g.delta > 0 ? '+' : '') + g.delta.toFixed(1) }}
                </span>
              </li>
            </ul>

            <p class="gauges-key">
              Bars are the in-game 0–{{ GAUGE_MAX }} ratings. The notch marks the
              {{ active }} average; the number is this weapon's difference from it.
            </p>

            <dl v-if="figures.length" class="figures">
              <div v-for="[k, v] in figures" :key="k">
                <dt>{{ k }}</dt>
                <dd>{{ v }}</dd>
              </div>
            </dl>
          </section>

          <div class="w-hero-actions">
            <button class="btn-ember btn-sm" :disabled="!canEquip" @click="equip">
              {{ canEquip ? `Equip for ${planner.activeClass}` : `Not for ${planner.activeClass}` }}
            </button>
            <a class="btn-ghost btn-sm" :href="wikiUrl(activeWeapon)" target="_blank" rel="noopener">
              Open wiki ↗
            </a>
          </div>

          <WeaponTree :weapon="activeWeapon" :data="data" />
        </template>
      </div>
    </div>

    <transition name="toast">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </transition>
  </section>
</template>

<style scoped>
.armoury {
  max-width: 76rem;
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

.a-controls {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  margin: 1.6rem 0 1.2rem;
}
.catbar {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.cat-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.85rem;
  color: var(--color-smoke);
  background: rgba(14, 28, 22, 0.5);
  border: 1px solid var(--color-ash);
  padding: 0.5rem 0.9rem;
  border-radius: 2px;
  cursor: pointer;
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
.w-search {
  flex: 1 1 14rem;
  max-width: 20rem;
  padding: 0.55rem 0.9rem;
  background: rgba(14, 28, 22, 0.6);
  border: 1px solid var(--color-ash);
  border-radius: 3px;
  color: var(--color-bone);
  font-size: 0.9rem;
}
.w-search::placeholder {
  color: #5f6f66;
}

.a-layout {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1.2rem;
}
@media (min-width: 900px) {
  .a-layout {
    grid-template-columns: 15rem 1fr;
    align-items: start;
  }
  .w-list {
    position: sticky;
    top: 5rem;
    max-height: calc(100svh - 6rem);
    overflow-y: auto;
  }
}
.w-list {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.w-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  text-align: left;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--color-ash);
  border-radius: 3px;
  background: rgba(14, 28, 22, 0.4);
  color: var(--color-bone);
  font-size: 0.85rem;
  cursor: pointer;
  transition: 0.12s;
}
.w-item:hover {
  border-color: var(--color-ash-2);
}
.w-item.on {
  border-color: var(--color-ember);
  background: rgba(255, 106, 43, 0.1);
}
.w-item-users {
  flex: none;
  font-family: var(--font-mono);
  font-size: 0.62rem;
  color: var(--color-drake);
}
.w-empty {
  color: var(--color-smoke);
  padding: 1rem 0;
  font-size: 0.85rem;
}

.w-detail {
  border: 1px solid var(--color-ash);
  border-radius: 8px;
  background: rgba(7, 17, 13, 0.4);
  padding: 1.4rem;
  min-height: 16rem;
}
.w-prompt,
.w-loading,
.w-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.8rem;
  min-height: 14rem;
  text-align: center;
  color: var(--color-smoke);
}
.w-prompt-mark {
  font-size: 2.5rem;
  opacity: 0.5;
}
.w-loading {
  flex-direction: row;
}
.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--color-ash-2);
  border-top-color: var(--color-ember);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.w-error h2 {
  font-family: var(--font-display);
  text-transform: uppercase;
  color: var(--color-bone);
}
.w-error-actions {
  display: flex;
  gap: 0.5rem;
}

.w-hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}
.w-hero-name {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: clamp(1.4rem, 4vw, 2rem);
  color: var(--color-bone);
}
.w-src {
  flex: none;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 0.58rem;
  padding: 2px 7px;
  border-radius: 2px;
  border: 1px solid var(--color-ash);
}
.w-src.baked {
  color: var(--color-drake);
  border-color: rgba(89, 214, 108, 0.4);
}
.w-src.wiki {
  color: var(--color-cobalt);
  border-color: rgba(108, 196, 239, 0.4);
}
.w-src.offline {
  color: var(--color-gold);
  border-color: rgba(223, 184, 91, 0.4);
}
/* dossier tags */
.w-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 0.6rem 2rem;
  margin: 0.8rem 0 0;
}
.w-tags > div {
  min-width: 0;
  flex: 0 1 auto;
}
.w-tags dt {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.14em;
  font-size: 0.54rem;
  color: var(--color-smoke);
}
.w-tags dd {
  margin: 0.15rem 0 0;
  font-size: 0.82rem;
  color: #c3d0c6;
  max-width: 34ch;
}

/* stat block */
.stats {
  margin: 1.4rem 0 1.6rem;
  padding: 1.1rem 1.2rem 1.2rem;
  border: 1px solid var(--color-ash);
  border-radius: 6px;
  background: rgba(5, 10, 8, 0.45);
}
.stats-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}
.stats-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-weight: 700;
  font-size: 0.95rem;
  color: var(--color-bone);
}
.stats-version {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.stats-version span {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.14em;
  font-size: 0.54rem;
  color: var(--color-smoke);
}
.stats-version select {
  background: rgba(5, 10, 8, 0.8);
  border: 1px solid var(--color-ash);
  color: var(--color-bone);
  border-radius: 2px;
  padding: 0.35rem 0.5rem;
  font-size: 0.82rem;
  max-width: 16rem;
}

.gauges {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.gauge {
  display: grid;
  grid-template-columns: 8.5rem 1fr 2.4rem 2.6rem;
  align-items: center;
  gap: 0.7rem;
}
.gauge-label {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 0.58rem;
  color: var(--color-smoke);
}
/* Track is notched into ten segments, like a gauge struck on the anvil. */
.gauge-track {
  position: relative;
  height: 12px;
  border: 1px solid var(--color-ash);
  border-radius: 2px;
  background-image: repeating-linear-gradient(
    90deg,
    rgba(255, 255, 255, 0.05) 0 calc(10% - 1px),
    transparent calc(10% - 1px) 10%
  );
  overflow: hidden;
}
.gauge-fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: linear-gradient(90deg, #8a4a1c, var(--color-ember));
}
.gauge-fill.over {
  background: linear-gradient(90deg, #a35a1f, #ffb066);
}
.gauge-fill.under {
  background: linear-gradient(90deg, #2f4438, #5d7767);
}
.gauge-avg {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 2px;
  transform: translateX(-1px);
  background: var(--color-bone);
  opacity: 0.75;
}
.gauge-val {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--color-bone);
  text-align: right;
}
.gauge-delta {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  text-align: right;
}
.gauge-delta.over {
  color: var(--color-drake);
}
.gauge-delta.under {
  color: #8b6f6f;
}
.gauge-delta.par {
  color: var(--color-smoke);
}
.gauges-key {
  margin-top: 0.8rem;
  color: #728078;
  font-size: 0.7rem;
  line-height: 1.5;
}

.figures {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 2rem;
  margin: 0.9rem 0 0;
  padding-top: 0.9rem;
  border-top: 1px solid var(--color-ash);
}
.figures dt {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.14em;
  font-size: 0.54rem;
  color: var(--color-smoke);
}
.figures dd {
  margin: 0.15rem 0 0;
  font-family: var(--font-display);
  font-size: 1.1rem;
  color: var(--color-gold);
}

@media (max-width: 560px) {
  .gauge {
    grid-template-columns: 7rem 1fr 2.2rem;
  }
  .gauge-delta {
    display: none;
  }
}

.w-hero-intro {
  color: #c3d0c6;
  line-height: 1.6;
  margin: 0.8rem 0;
  font-size: 0.9rem;
  max-width: 60ch;
}
.w-hero-actions {
  display: flex;
  gap: 0.5rem;
  margin: 0.8rem 0 1.4rem;
  flex-wrap: wrap;
}
.btn-sm {
  padding: 0.5rem 0.9rem;
  border-radius: 2px;
  font-size: 0.78rem;
  cursor: pointer;
}
.btn-ember:disabled {
  filter: grayscale(0.6) brightness(0.7);
  cursor: not-allowed;
}
.btn-ghost {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 700;
  color: var(--color-smoke);
  background: transparent;
  border: 1px solid var(--color-ash);
  text-decoration: none;
}
.btn-ghost:hover {
  color: var(--color-bone);
  border-color: var(--color-ash-2);
}

.toast {
  position: fixed;
  bottom: 1.4rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 80;
  background: rgba(5, 10, 8, 0.92);
  border: 1px solid var(--color-drake);
  color: var(--color-bone);
  padding: 0.6rem 1.1rem;
  border-radius: 3px;
  font-size: 0.85rem;
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}
</style>
