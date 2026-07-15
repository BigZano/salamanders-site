<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePlanner, CLASS_NAMES } from '../stores/planner'

const planner = usePlanner()
const route = useRoute()
const router = useRouter()

const CAT_LABEL = ['Core', 'Core', 'Core', 'Team', 'Gear', 'Gear', 'Gear', 'Signature']
const levels = Array.from({ length: 25 }, (_, i) => i + 1)
const slots = [
  { key: 'primary', label: 'Primary Weapon' },
  { key: 'secondary', label: 'Secondary Weapon' },
  { key: 'melee', label: 'Melee Weapon' },
]

function initials(name) {
  const w = (name || '').replace(/[",]/g, '').trim().split(/\s+/)
  return ((w[0]?.[0] || '') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase()
}

// Perk detail (hover / focus / select)
const inspected = ref(null)
function inspect(perk) {
  inspected.value = perk
}
const detail = computed(() => inspected.value)

const isSelected = (perk) => planner.selected[perk.col] === perk.name

function onPerk(perk) {
  if (perk.level > planner.level) return
  planner.togglePerk(perk)
  inspect(perk)
}

// Toast
const toast = ref('')
let toastTimer
function flash(msg) {
  toast.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 1800)
}
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const t = document.createElement('textarea')
    t.value = text
    document.body.appendChild(t)
    t.select()
    document.execCommand('copy')
    t.remove()
  }
}
async function copyBuild() {
  await copy(planner.buildText())
  flash('Build copied to clipboard')
}
async function shareBuild() {
  const b = planner.encode()
  await router.replace({ query: { ...route.query, b } })
  await copy(window.location.href)
  flash('Share link copied')
}

onMounted(() => {
  planner.hydrate()
  if (route.query.b) planner.applyEncoded(String(route.query.b))
  inspect(planner.columns[0].perks[0])
})
</script>

<template>
  <section class="planner">
    <header class="p-head">
      <p class="eyebrow">Doctrine</p>
      <h1 class="p-title">Perk Builder</h1>
    </header>

    <!-- Class selector -->
    <div class="classbar" role="tablist" aria-label="Classes">
      <button
        v-for="name in CLASS_NAMES"
        :key="name"
        class="class-tab"
        :class="{ on: planner.activeClass === name }"
        role="tab"
        :aria-selected="planner.activeClass === name"
        @click="planner.setClass(name)"
      >
        {{ name }}
      </button>
    </div>

    <!-- Class hero -->
    <div class="hero-card">
      <div class="hero-id">
        <span class="emblem">{{ initials(planner.activeClass) }}</span>
        <div>
          <h2 class="hero-name">
            {{ planner.activeClass }}
            <span class="hero-ability">• {{ planner.meta.ability }}</span>
          </h2>
          <p class="hero-desc">{{ planner.meta.description }}</p>
        </div>
      </div>

      <div class="controls">
        <label class="field">
          <span>Class Level</span>
          <select :value="planner.level" @change="planner.setLevel($event.target.value)">
            <option v-for="l in levels" :key="l" :value="l">{{ l }}</option>
          </select>
        </label>
        <label v-for="s in slots" :key="s.key" class="field">
          <span>{{ s.label }}</span>
          <select
            :value="planner.activeWeapons[s.key] || ''"
            :disabled="!planner.meta.weapons[s.key]?.length"
            @change="planner.setWeapon(s.key, $event.target.value)"
          >
            <option value="">
              {{ planner.meta.weapons[s.key]?.length ? 'None selected' : 'Not available' }}
            </option>
            <option v-for="w in planner.meta.weapons[s.key] || []" :key="w" :value="w">
              {{ w }}
            </option>
          </select>
        </label>
      </div>
    </div>

    <div class="layout">
      <!-- Perk tree -->
      <div class="tree-wrap">
        <div class="tree-scroll">
          <div class="perk-grid">
            <section
              v-for="c in planner.columns"
              :key="c.col"
              class="perk-col"
              :data-cat="c.cat"
            >
              <div class="perk-col-head">{{ c.head }}</div>
              <div class="perk-list">
                <button
                  v-for="perk in c.perks"
                  :key="perk.level"
                  class="perk"
                  :data-cat="perk.cat"
                  :class="{ selected: isSelected(perk), locked: perk.level > planner.level }"
                  :disabled="perk.level > planner.level"
                  @click="onPerk(perk)"
                  @mouseenter="inspect(perk)"
                  @focus="inspect(perk)"
                >
                  <span v-if="perk.level > planner.level" class="lock">LV {{ perk.level }}</span>
                  <span class="perk-icon">{{ initials(perk.name) }}</span>
                  <span class="perk-name">{{ perk.name }}</span>
                </button>
              </div>
              <div class="col-level">First unlock<strong>{{ 2 + c.col }}</strong></div>
            </section>
          </div>
        </div>

        <!-- Perk detail -->
        <div v-if="detail" class="perk-detail" :data-cat="detail.cat">
          <span class="detail-icon">{{ initials(detail.name) }}</span>
          <div class="detail-body">
            <p class="detail-name">{{ detail.name }}</p>
            <p class="detail-meta">
              {{ CAT_LABEL[detail.col] }} perk · Column {{ detail.col + 1 }} · Unlocks at level
              {{ detail.level }}
            </p>
            <p class="detail-note">
              Tap to slot it into your build. Full perk descriptions come from the wiki in a
              later pass.
            </p>
          </div>
        </div>
      </div>

      <!-- Build panel -->
      <aside class="build">
        <div class="build-head">
          <h3>Your Build</h3>
          <span class="build-count">{{ planner.build.count }} / 8</span>
        </div>
        <div class="build-list">
          <div v-for="s in planner.build.slots" :key="s.label" class="build-row" :data-cat="s.cat">
            <span class="mini">{{ s.name ? initials(s.name) : '—' }}</span>
            <div>
              <div class="build-label">{{ s.label }}</div>
              <div class="build-name" :class="{ empty: !s.name }">
                {{ s.name || 'No perk selected' }}
              </div>
            </div>
          </div>
        </div>

        <div class="build-summary">
          <p class="bs-line"><strong>{{ planner.build.ability }}</strong></p>
          <p class="bs-line">Starting: {{ planner.build.starting }}</p>
          <p class="bs-line">Primary: {{ planner.build.weapons.primary || '—' }}</p>
          <p class="bs-line">Secondary: {{ planner.build.weapons.secondary || '—' }}</p>
          <p class="bs-line">Melee: {{ planner.build.weapons.melee || '—' }}</p>
        </div>

        <div class="build-actions">
          <button class="btn-drake btn-sm" @click="copyBuild">Copy build</button>
          <button class="btn-drake btn-sm" @click="shareBuild">Share link</button>
          <button class="btn-ghost btn-sm" @click="planner.resetClass()">Reset</button>
        </div>
      </aside>
    </div>

    <transition name="toast">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </transition>
  </section>
</template>

<style scoped>
.planner {
  max-width: 78rem;
  margin: 0 auto;
  padding: 4rem 1.5rem 2rem;
}
.p-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: clamp(2.2rem, 7vw, 3.6rem);
  color: var(--color-bone);
  margin: 0.4rem 0 0;
}

/* class selector */
.classbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 1.6rem 0 1.4rem;
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
}
.class-tab.on {
  color: #1a0d06;
  background: linear-gradient(180deg, #ffb066, #ff6a2b);
  border-color: rgba(255, 176, 102, 0.6);
}

/* class hero */
.hero-card {
  border: 1px solid var(--color-ash);
  border-radius: 8px;
  background: rgba(7, 17, 13, 0.5);
  padding: 1.4rem;
  display: flex;
  gap: 1.5rem;
  justify-content: space-between;
  flex-wrap: wrap;
}
.hero-id {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
  min-width: 16rem;
  flex: 1;
}
.emblem {
  flex: none;
  display: grid;
  place-items: center;
  width: 3.4rem;
  height: 3.4rem;
  font-family: var(--font-display);
  font-weight: 700;
  color: var(--color-drake);
  background: rgba(89, 214, 108, 0.08);
  border: 1px solid rgba(89, 214, 108, 0.3);
  clip-path: polygon(15% 0, 85% 0, 100% 50%, 85% 100%, 15% 100%, 0 50%);
}
.hero-name {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: 1.5rem;
  color: var(--color-bone);
}
.hero-ability {
  font-family: var(--font-sans);
  text-transform: none;
  font-size: 0.85rem;
  color: var(--color-gold);
  font-weight: 500;
}
.hero-desc {
  color: #c3d0c6;
  line-height: 1.55;
  margin-top: 0.3rem;
  max-width: 44ch;
  font-size: 0.9rem;
}
.controls {
  display: grid;
  grid-template-columns: repeat(2, minmax(9rem, 1fr));
  gap: 0.6rem;
  align-content: start;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.field span {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.14em;
  font-size: 0.58rem;
  color: var(--color-smoke);
}
.field select {
  background: rgba(5, 10, 8, 0.7);
  border: 1px solid var(--color-ash);
  color: var(--color-bone);
  border-radius: 2px;
  padding: 0.45rem 0.5rem;
  font-size: 0.85rem;
}
.field select:disabled {
  opacity: 0.4;
}

/* layout */
.layout {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1.2rem;
  margin-top: 1.2rem;
}
@media (min-width: 980px) {
  .layout {
    grid-template-columns: 1fr 20rem;
    align-items: start;
  }
}

/* perk tree */
.tree-scroll {
  overflow-x: auto;
  border: 1px solid var(--color-ash);
  border-radius: 8px;
  background: rgba(7, 17, 13, 0.4);
  padding: 1.2rem 1rem 0.5rem;
}
.perk-grid {
  min-width: 900px;
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 0.4rem;
}
.perk-col {
  position: relative;
  padding-bottom: 2.6rem;
}
.perk-col-head {
  text-align: center;
  font-family: var(--font-display);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.1em;
  color: var(--color-cobalt);
  margin-bottom: 0.8rem;
}
.perk-col[data-cat='team'] .perk-col-head {
  color: var(--color-drake);
}
.perk-col[data-cat='gear'] .perk-col-head {
  color: var(--color-gold);
}
.perk-col[data-cat='signature'] .perk-col-head {
  color: var(--color-violet);
}
.perk-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.perk {
  position: relative;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  min-height: 118px;
  padding: 0.5rem 0.25rem;
  text-align: center;
  cursor: pointer;
  transition: 0.15s;
}
.perk:hover:not(:disabled) {
  border-color: var(--color-ash-2);
  background: rgba(255, 255, 255, 0.02);
}
.perk.locked {
  cursor: not-allowed;
  opacity: 0.45;
}
.perk-icon {
  width: 54px;
  height: 54px;
  margin: 0 auto 0.5rem;
  display: grid;
  place-items: center;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 0.9rem;
  color: #dfeee2;
  clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
  background: linear-gradient(145deg, #2a4a8a, #14213f);
}
.perk[data-cat='team'] .perk-icon {
  background: linear-gradient(145deg, #2b6b60, #12362f);
}
.perk[data-cat='gear'] .perk-icon {
  background: linear-gradient(145deg, #72581f, #35280c);
}
.perk[data-cat='signature'] .perk-icon {
  background: linear-gradient(145deg, #5b376f, #281733);
}
.perk.selected .perk-icon {
  box-shadow:
    0 0 0 3px #0c1d10,
    0 0 0 5px var(--color-ember),
    0 0 16px rgba(255, 106, 43, 0.6);
}
.perk-name {
  display: block;
  font-size: 0.72rem;
  line-height: 1.2;
  color: #c3d0c6;
}
.perk.selected .perk-name {
  color: var(--color-bone);
}
.lock {
  position: absolute;
  top: 4px;
  right: 4px;
  font-family: var(--font-mono);
  font-size: 0.55rem;
  color: var(--color-gold);
  border: 1px solid rgba(223, 184, 91, 0.4);
  border-radius: 2px;
  padding: 0 3px;
}
.col-level {
  position: absolute;
  bottom: 0.5rem;
  left: 0;
  right: 0;
  text-align: center;
  color: #728078;
  font-size: 0.62rem;
  font-family: var(--font-mono);
}
.col-level strong {
  display: block;
  color: var(--color-gold);
  font-size: 0.95rem;
}

/* perk detail */
.perk-detail {
  display: flex;
  gap: 0.9rem;
  align-items: center;
  margin-top: 0.9rem;
  padding: 0.9rem 1rem;
  border: 1px solid var(--color-ash);
  border-left: 3px solid var(--color-cobalt);
  border-radius: 6px;
  background: rgba(14, 28, 22, 0.4);
}
.perk-detail[data-cat='team'] {
  border-left-color: var(--color-drake);
}
.perk-detail[data-cat='gear'] {
  border-left-color: var(--color-gold);
}
.perk-detail[data-cat='signature'] {
  border-left-color: var(--color-violet);
}
.detail-icon {
  flex: none;
  width: 3rem;
  height: 3rem;
  display: grid;
  place-items: center;
  font-family: var(--font-display);
  font-weight: 700;
  color: #dfeee2;
  clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
  background: linear-gradient(145deg, #2a4a8a, #14213f);
}
.detail-name {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  color: var(--color-bone);
  font-size: 1.05rem;
}
.detail-meta {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: var(--color-gold);
  margin: 0.15rem 0 0.3rem;
}
.detail-note {
  color: var(--color-smoke);
  font-size: 0.8rem;
  line-height: 1.4;
}

/* build panel */
.build {
  border: 1px solid var(--color-ash);
  border-radius: 8px;
  background: rgba(7, 17, 13, 0.6);
  padding: 1.2rem;
  position: sticky;
  top: 5rem;
}
.build-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 0.9rem;
}
.build-head h3 {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  color: var(--color-bone);
}
.build-count {
  font-family: var(--font-mono);
  color: var(--color-gold);
  font-size: 0.85rem;
}
.build-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.build-row {
  display: flex;
  gap: 0.6rem;
  align-items: center;
}
.mini {
  flex: none;
  width: 2rem;
  height: 2rem;
  display: grid;
  place-items: center;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 0.7rem;
  color: #dfeee2;
  clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
  background: linear-gradient(145deg, #2a4a8a, #14213f);
}
.build-row[data-cat='team'] .mini {
  background: linear-gradient(145deg, #2b6b60, #12362f);
}
.build-row[data-cat='gear'] .mini {
  background: linear-gradient(145deg, #72581f, #35280c);
}
.build-row[data-cat='signature'] .mini {
  background: linear-gradient(145deg, #5b376f, #281733);
}
.build-label {
  font-family: var(--font-mono);
  font-size: 0.56rem;
  letter-spacing: 0.12em;
  color: var(--color-smoke);
}
.build-name {
  font-size: 0.82rem;
  color: var(--color-bone);
}
.build-name.empty {
  color: #5f6f66;
}
.build-summary {
  margin-top: 1rem;
  padding-top: 0.9rem;
  border-top: 1px solid var(--color-ash);
}
.bs-line {
  font-size: 0.8rem;
  color: var(--color-smoke);
  line-height: 1.5;
}
.bs-line strong {
  color: var(--color-drake);
}
.build-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 1rem;
}
.btn-sm {
  padding: 0.5rem 0.8rem;
  border-radius: 2px;
  font-size: 0.78rem;
  cursor: pointer;
}
.btn-ghost {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 700;
  color: var(--color-smoke);
  background: transparent;
  border: 1px solid var(--color-ash);
}
.btn-ghost:hover {
  color: var(--color-bone);
  border-color: var(--color-ash-2);
}

/* toast */
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
  box-shadow: 0 10px 40px -8px rgba(0, 0, 0, 0.8);
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

@media (max-width: 600px) {
  .planner {
    padding-top: 3rem;
  }
  .controls {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
