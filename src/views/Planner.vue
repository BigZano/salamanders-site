<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePlanner, CLASS_NAMES, describePerk, MAX_PRESTIGE } from '../stores/planner'
import { useAuth } from '../stores/auth'
import * as buildsApi from '../lib/buildsApi'
import WeaponSlot from '../components/WeaponSlot.vue'

const planner = usePlanner()
const auth = useAuth()
const route = useRoute()
const router = useRouter()

const CAT_LABEL = ['Core', 'Core', 'Core', 'Team', 'Gear', 'Gear', 'Gear', 'Signature']
const slots = [
  { key: 'primary', label: 'Primary Weapon' },
  { key: 'secondary', label: 'Secondary Weapon' },
  { key: 'melee', label: 'Melee Weapon' },
]

function initials(name) {
  const w = (name || '').replace(/[",]/g, '').trim().split(/\s+/)
  return ((w[0]?.[0] || '') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase()
}

// Floating popout: read-only preview, follows whatever's hovered/focused.
const hovered = ref(null)
const popoutBelow = ref(false)
const popoutStyle = ref({})
function showPopout(perk, evt) {
  hovered.value = perk
  const rect = evt.currentTarget.getBoundingClientRect()
  const half = 150 // half the popout's ~300px width, for clamping
  const left = Math.min(Math.max(rect.left + rect.width / 2, half + 12), window.innerWidth - half - 12)
  // Not enough headroom above (near the top of the viewport) — flip below instead.
  popoutBelow.value = rect.top < 200
  const top = popoutBelow.value ? rect.bottom + 12 : rect.top - 10
  popoutStyle.value = { left: `${left}px`, top: `${top}px` }
}
function hidePopout() {
  hovered.value = null
}
const hoveredText = computed(() =>
  hovered.value ? describePerk(planner.activeClass, hovered.value.name) : '',
)
const hoveredWhy = computed(() => {
  const p = hovered.value
  if (!p || planner.selected[p.col] !== p.name) return ''
  return planner.justified[p.col] || ''
})

// Authoring box: pinned to whichever perk was last clicked into the build,
// not whatever's hovered — hovering to compare picks shouldn't steal focus
// away from the reasoning you're mid-sentence writing.
const editingCol = ref(null)
const editingPerk = computed(() => {
  if (editingCol.value == null) return null
  const name = planner.selected[editingCol.value]
  if (!name) return null
  return planner.columns[editingCol.value].perks.find((p) => p.name === name) || null
})
const justificationDraft = ref('')
watch(editingPerk, (p) => {
  justificationDraft.value = p ? planner.justified[p.col] || '' : ''
})
function saveJustification() {
  if (editingPerk.value) planner.setJustification(editingPerk.value.col, justificationDraft.value)
}

const ROMAN = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV' }

// Save-to-library, inline in the build panel.
const saveDetails = ref(false)
const saveForm = ref({ title: '', role: '', notes: '' })
const saving = ref(false)

// Enter in the build-name field and a click on "Save to library" both submit
// the same form — nothing stopped both firing seconds apart (Enter, then an
// unsure click right after) and writing two near-identical entries. `saving`
// covers the request itself; the timestamp still catches a second submit
// fired before the first request has even started.
let lastSave = 0
async function submitSave() {
  if (!auth.signedIn) {
    flash('Sign in with Discord to save a build')
    auth.signIn()
    return
  }
  const now = Date.now()
  if (saving.value || now - lastSave < 600) return
  lastSave = now
  saving.value = true
  try {
    const name = saveForm.value.title.trim() || `${planner.activeClass} Build`
    await buildsApi.createBuild(planner.buildSnapshot(saveForm.value), auth.token)
    saveForm.value = { title: '', role: '', notes: '' }
    saveDetails.value = false
    flash(`Saved “${name}” to the Builds gallery`)
  } catch (err) {
    flash(err.message || 'Could not save the build — try again')
  } finally {
    saving.value = false
  }
}

// Weapon perks picked for the weapon currently in a given slot.
function weaponPerkCount(slotKey) {
  const w = planner.activeWeapons[slotKey]
  return w ? planner.weaponUsed(w) : 0
}

const isSelected = (perk) => planner.selected[perk.col] === perk.name

function onPerk(perk) {
  if (perk.level > planner.level) return
  planner.togglePerk(perk)
  editingCol.value = planner.selected[perk.col] === perk.name ? perk.col : null
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
              :class="{ picked: !!planner.selected[c.col] }"
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
                  @mouseenter="showPopout(perk, $event)"
                  @mouseleave="hidePopout"
                  @focus="showPopout(perk, $event)"
                  @blur="hidePopout"
                >
                  <span v-if="perk.level > planner.level" class="lock">LV {{ perk.level }}</span>
                  <span v-if="isSelected(perk)" class="pick-mark" aria-hidden="true" />
                  <span class="perk-icon">{{ initials(perk.name) }}</span>
                  <span class="perk-name">{{ perk.name }}</span>
                </button>
              </div>
            </section>
          </div>
        </div>

        <!-- Reasoning: pinned to the last perk you clicked into the build, so
             readers hovering it later can see why you picked it. -->
        <div v-if="editingPerk" class="perk-author" :data-cat="editingPerk.cat">
          <span class="pa-icon">{{ initials(editingPerk.name) }}</span>
          <div class="pa-body">
            <p class="pa-name">
              {{ editingPerk.name }}
              <span class="pa-meta">selected · column {{ editingPerk.col + 1 }}</span>
            </p>
            <label class="pa-label" :for="`why-${editingPerk.col}`">Why this pick?</label>
            <textarea
              :id="`why-${editingPerk.col}`"
              v-model="justificationDraft"
              class="pa-field"
              rows="2"
              placeholder="What does this add to the build? When do you lean on it?"
              @blur="saveJustification"
            />
          </div>
        </div>
        <p v-else class="perk-author-empty">
          Pick a perk above to write down why it's in the build — readers see it on hover.
        </p>
      </div>

      <!-- Floating preview: wiki text plus the creator's reasoning, anchored
           to whatever perk is currently hovered or focused. -->
      <Teleport to="body">
        <div
          v-if="hovered"
          class="perk-popout"
          :class="{ below: popoutBelow }"
          :style="popoutStyle"
          :data-cat="hovered.cat"
        >
          <p class="pp-name">{{ hovered.name }}</p>
          <p class="pp-meta">
            {{ CAT_LABEL[hovered.col] }} · Column {{ hovered.col + 1 }} · Unlocks at level
            {{ hovered.level }}
          </p>
          <p v-if="hoveredText" class="pp-desc">{{ hoveredText }}</p>
          <p v-else class="pp-desc pp-empty">
            No description on the wiki yet. Re-run the perk bake after the next patch.
          </p>
          <div v-if="hoveredWhy" class="pp-why">
            <span class="pp-why-label">Why the creator picked it</span>
            <p>{{ hoveredWhy }}</p>
          </div>
        </div>
      </Teleport>

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
          <p v-if="planner.activePrestige" class="bs-line">
            Prestige {{ planner.activePrestige }} ·
            {{ planner.activePrestigePicks.length }}/{{ planner.activePrestige }} perks
          </p>
          <p v-if="planner.activePrestigePicks.length" class="bs-line bs-picks">
            {{ planner.activePrestigePicks.join(', ') }}
          </p>
        </div>

        <div class="build-gear">
          <div v-for="s in slots" :key="s.key" class="bg-row">
            <span class="bg-slot">{{ s.label.replace(' Weapon', '') }}</span>
            <span class="bg-name" :class="{ empty: !planner.build.weapons[s.key] }">
              {{ planner.build.weapons[s.key] || 'None selected' }}
            </span>
            <span v-if="weaponPerkCount(s.key)" class="bg-pts">
              +{{ weaponPerkCount(s.key) }}
            </span>
          </div>
        </div>

        <!-- Save where the build is made. Name stays visible so it's obvious the
             build gets a name, rather than hiding behind the button. -->
        <form class="save" @submit.prevent="submitSave">
          <label class="save-label" for="build-name">Build name</label>
          <input
            id="build-name"
            v-model="saveForm.title"
            class="fld"
            type="text"
            :placeholder="`${planner.activeClass} build`"
          />

          <button
            v-if="!saveDetails"
            type="button"
            class="save-more"
            @click="saveDetails = true"
          >
            + Add role and notes
          </button>
          <template v-else>
            <input
              v-model="saveForm.role"
              class="fld"
              type="text"
              placeholder="Role (e.g. Frontline)"
              aria-label="Role"
            />
            <textarea
              v-model="saveForm.notes"
              class="fld"
              rows="2"
              placeholder="Notes — how it plays, when to use it"
              aria-label="Notes"
            />
          </template>

          <button type="submit" class="btn-ember btn-sm save-go" :disabled="saving">
            {{ saving ? 'Saving…' : 'Save to library' }}
          </button>
        </form>

        <div class="build-actions">
          <button class="btn-drake btn-sm" @click="copyBuild">Copy build</button>
          <button class="btn-drake btn-sm" @click="shareBuild">Share link</button>
          <button class="btn-ghost btn-sm" @click="planner.resetClass()">Reset</button>
        </div>
      </aside>
    </div>

    <!-- Loadout: weapons and their perk trees, so a build is complete in one place. -->
    <section class="loadout">
      <div class="lo-head">
        <div>
          <p class="eyebrow">Wargear</p>
          <h2 class="lo-title">Loadout</h2>
        </div>
        <p class="lo-note">
          Pick a weapon per slot, then open its tree to spend perk points. Trees come from
          the wiki and are cached for a day.
        </p>
      </div>
      <WeaponSlot v-for="s in slots" :key="s.key" :slot="s.key" :label="s.label" />
    </section>

    <!-- Prestige perks: earned past level 25, so they sit outside the 8-column grid. -->
    <section class="prestige">
      <div class="pr-head">
        <div>
          <p class="eyebrow">Past the anvil</p>
          <h2 class="pr-title">Prestige Perks</h2>
        </div>
        <div class="pr-meta">
          <span class="pr-count" :class="{ full: planner.prestigePicksLeft === 0 && planner.activePrestige > 0 }">
            {{ planner.activePrestigePicks.length }} / {{ planner.activePrestige }} picked
          </span>
          <p class="pr-note">One perk per prestige rank, up to {{ MAX_PRESTIGE }} total.</p>
        </div>
      </div>

      <!-- One slot per rank: this is the real shape of the mechanic. -->
      <ol class="pr-ranks">
        <li
          v-for="s in planner.prestigeSlots"
          :key="s.rank"
          class="pr-rank"
          :class="{ locked: !s.unlocked, filled: !!s.perk }"
        >
          <span class="pr-rank-mark">{{ ROMAN[s.rank] }}</span>
          <div class="pr-rank-body">
            <p class="pr-rank-label">Prestige {{ s.rank }}</p>
            <p v-if="s.perk" class="pr-rank-perk">{{ s.perk.name }}</p>
            <p v-else class="pr-rank-perk empty">
              {{ s.unlocked ? 'Choose a perk below' : 'Not reached' }}
            </p>
          </div>
          <button
            v-if="s.perk"
            class="pr-rank-clear"
            :aria-label="`Clear the Prestige ${s.rank} perk`"
            @click="planner.clearPrestigeSlot(s.rank)"
          >
            ×
          </button>
        </li>
      </ol>

      <p class="pr-pool-label">
        Seven perks per class · pick one each time you prestige
      </p>
      <div class="pr-grid">
        <button
          v-for="p in planner.prestigePool"
          :key="p.name"
          type="button"
          class="pr-card"
          :class="{ picked: p.picked }"
          :disabled="p.disabled"
          :aria-pressed="p.picked"
          @click="planner.togglePrestigePerk(p.name)"
        >
          <span v-if="p.picked" class="pr-mark" aria-hidden="true" />
          <h3 class="pr-name">{{ p.name }}</h3>
          <p class="pr-desc">{{ p.description }}</p>
        </button>
      </div>
    </section>

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
  display: inline-flex;
  max-width: 100%;
  border: 1px solid var(--color-ash);
  border-radius: 8px;
  background: rgba(7, 17, 13, 0.5);
  padding: 1.4rem;
}
.hero-id {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
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
/* Grid items default to min-width:auto, so the 900px tree below would stretch
   this column and push the whole page sideways on narrow screens. */
.tree-wrap {
  min-width: 0;
}
.tree-scroll {
  overflow-x: auto;
  border: 1px solid var(--color-ash);
  border-radius: 8px;
  background: rgba(7, 17, 13, 0.4);
  padding: 1.2rem 1rem 0.5rem;
}
.perk-grid {
  min-width: 640px;
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 0.4rem;
}
.perk-col {
  position: relative;
}
.perk-col-head {
  position: relative;
  text-align: center;
  font-family: var(--font-display);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.1em;
  color: var(--color-cobalt);
  margin-bottom: 0.8rem;
  padding-bottom: 0.4rem;
}
/* A column with a pick lights its head — read your whole build across the tree. */
.perk-col.picked .perk-col-head::after {
  content: '';
  position: absolute;
  left: 15%;
  right: 15%;
  bottom: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--color-ember), transparent);
  box-shadow: 0 0 8px rgba(255, 106, 43, 0.7);
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
/* Selected reads as forged: lit card, ember ring, gold name, diamond marker. */
.perk.selected {
  border-color: var(--color-ember);
  background: rgba(255, 106, 43, 0.12);
  box-shadow:
    inset 0 0 0 1px rgba(255, 106, 43, 0.35),
    0 0 22px -6px rgba(255, 106, 43, 0.55);
}
.perk.selected:hover:not(:disabled) {
  border-color: var(--color-ember);
  background: rgba(255, 106, 43, 0.16);
}
/* clip-path clips box-shadow away, which is why the old ember ring never showed.
   drop-shadow follows the clipped hex silhouette. */
.perk.selected .perk-icon {
  filter: drop-shadow(0 0 7px rgba(255, 106, 43, 0.85));
}
.pick-mark {
  position: absolute;
  top: 6px;
  left: 6px;
  width: 9px;
  height: 9px;
  transform: rotate(45deg);
  background: linear-gradient(180deg, #ffb066, #ff6a2b);
  box-shadow: 0 0 10px rgba(255, 106, 43, 0.8);
}
.perk-name {
  display: block;
  font-size: 0.72rem;
  line-height: 1.2;
  color: #c3d0c6;
}
.perk.selected .perk-name {
  color: var(--color-gold);
  font-weight: 600;
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
/* perk authoring — the dead space under the tree becomes a workspace for
   whichever perk was last clicked into the build. */
.perk-author {
  display: flex;
  gap: 0.9rem;
  margin-top: 0.9rem;
  padding: 0.9rem 1rem;
  border: 1px solid var(--color-ash);
  border-left: 3px solid var(--color-cobalt);
  border-radius: 6px;
  background: rgba(14, 28, 22, 0.4);
}
.perk-author[data-cat='team'] {
  border-left-color: var(--color-drake);
}
.perk-author[data-cat='gear'] {
  border-left-color: var(--color-gold);
}
.perk-author[data-cat='signature'] {
  border-left-color: var(--color-violet);
}
.pa-icon {
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
.pa-body {
  flex: 1;
  min-width: 0;
}
.pa-name {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  color: var(--color-bone);
  font-size: 1.05rem;
}
.pa-meta {
  font-family: var(--font-mono);
  text-transform: none;
  font-weight: 400;
  font-size: 0.68rem;
  letter-spacing: 0.06em;
  color: var(--color-gold);
}
.pa-label {
  display: block;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 0.56rem;
  color: var(--color-smoke);
  margin: 0.5rem 0 0.3rem;
}
.pa-field {
  width: 100%;
  background: rgba(5, 10, 8, 0.7);
  border: 1px solid var(--color-ash);
  color: var(--color-bone);
  border-radius: 2px;
  padding: 0.5rem 0.6rem;
  font-size: 0.82rem;
  font-family: var(--font-sans);
  line-height: 1.4;
  resize: vertical;
}
.pa-field::placeholder {
  color: #5f6f66;
}
.perk-author-empty {
  margin-top: 0.9rem;
  padding: 0.9rem 1rem;
  border: 1px dashed var(--color-ash);
  border-radius: 6px;
  text-align: center;
  color: var(--color-smoke);
  font-size: 0.82rem;
}

/* floating popout — read-only preview, anchored to the hovered/focused hex */
.perk-popout {
  position: fixed;
  transform: translate(-50%, calc(-100% - 12px));
  width: min(90vw, 300px);
  z-index: 95;
  pointer-events: none;
  padding: 0.8rem 0.9rem;
  border: 1px solid var(--color-ash-2);
  border-top: 2px solid var(--color-cobalt);
  border-radius: 6px;
  background: rgba(6, 12, 10, 0.96);
  box-shadow: 0 16px 40px -12px rgba(0, 0, 0, 0.85);
}
.perk-popout[data-cat='team'] {
  border-top-color: var(--color-drake);
}
.perk-popout[data-cat='gear'] {
  border-top-color: var(--color-gold);
}
.perk-popout[data-cat='signature'] {
  border-top-color: var(--color-violet);
}
.perk-popout.below {
  transform: translate(-50%, 0);
}
.perk-popout::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -5px;
  width: 9px;
  height: 9px;
  transform: translateX(-50%) rotate(45deg);
  background: rgba(6, 12, 10, 0.96);
  border-right: 1px solid var(--color-ash-2);
  border-bottom: 1px solid var(--color-ash-2);
}
.perk-popout.below::after {
  bottom: auto;
  top: -5px;
  border-right: none;
  border-bottom: none;
  border-left: 1px solid var(--color-ash-2);
  border-top: 1px solid var(--color-ash-2);
}
.pp-name {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  color: var(--color-bone);
  font-size: 1rem;
}
.pp-meta {
  font-family: var(--font-mono);
  font-size: 0.64rem;
  color: var(--color-gold);
  margin: 0.15rem 0 0.4rem;
}
.pp-desc {
  color: var(--color-smoke);
  font-size: 0.8rem;
  line-height: 1.4;
}
.pp-empty {
  font-style: italic;
}
.pp-why {
  margin-top: 0.6rem;
  padding-top: 0.5rem;
  padding-left: 0.6rem;
  border-top: 1px solid var(--color-ash);
  border-left: 2px solid var(--color-ember);
}
.pp-why-label {
  display: block;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 0.56rem;
  color: var(--color-ember);
  margin-bottom: 0.2rem;
}
.pp-why p {
  color: #dfeee2;
  font-size: 0.82rem;
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
.bs-picks {
  color: var(--color-gold);
  font-size: 0.76rem;
}
.build-gear {
  margin-top: 0.8rem;
  padding-top: 0.8rem;
  border-top: 1px solid var(--color-ash);
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.bg-row {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}
.bg-slot {
  flex: none;
  width: 4.6rem;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 0.54rem;
  color: var(--color-smoke);
}
.bg-name {
  flex: 1;
  font-size: 0.8rem;
  color: var(--color-bone);
  line-height: 1.3;
}
.bg-name.empty {
  color: #5f6f66;
}
.bg-pts {
  flex: none;
  font-family: var(--font-mono);
  font-size: 0.58rem;
  color: var(--color-ember);
  border: 1px solid rgba(255, 106, 43, 0.4);
  border-radius: 2px;
  padding: 1px 4px;
}
.save {
  margin-top: 1rem;
  padding-top: 0.9rem;
  border-top: 1px solid var(--color-ash);
  display: grid;
  gap: 0.4rem;
}
.save-label {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.14em;
  font-size: 0.54rem;
  color: var(--color-smoke);
}
.save-more {
  justify-self: start;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 0.56rem;
  color: var(--color-drake);
  background: transparent;
  border: 0;
  padding: 0.15rem 0;
  cursor: pointer;
}
.save-more:hover {
  color: var(--color-bone);
}
.save-go {
  justify-content: center;
  margin-top: 0.2rem;
}
.save .fld {
  width: 100%;
  background: rgba(5, 10, 8, 0.7);
  border: 1px solid var(--color-ash);
  color: var(--color-bone);
  border-radius: 2px;
  padding: 0.5rem 0.6rem;
  font-size: 0.82rem;
  font-family: var(--font-sans);
  resize: vertical;
}
.save .fld::placeholder {
  color: #5f6f66;
}
.build-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.7rem;
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

/* loadout */
.loadout {
  margin-top: 2.6rem;
  padding-top: 2rem;
  border-top: 1px solid var(--color-ash);
}
.lo-head,
.pr-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1.4rem;
}
.lo-title,
.pr-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: clamp(1.5rem, 4vw, 2.1rem);
  color: var(--color-bone);
  margin-top: 0.3rem;
}
.lo-note {
  max-width: 38ch;
  color: var(--color-smoke);
  font-size: 0.8rem;
  line-height: 1.5;
}

/* prestige */
.prestige {
  margin-top: 2.6rem;
  padding-top: 2rem;
  border-top: 1px solid var(--color-ash);
}
.pr-meta {
  text-align: right;
}
.pr-count {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1.05rem;
  color: var(--color-gold);
}
.pr-count.full {
  color: var(--color-ember);
}
.pr-note {
  max-width: 34ch;
  color: var(--color-smoke);
  font-size: 0.8rem;
  line-height: 1.5;
  margin-top: 0.2rem;
}
/* rank rail */
.pr-ranks {
  list-style: none;
  margin: 0 0 1.6rem;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  gap: 0.6rem;
}
.pr-rank {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.8rem 0.9rem;
  border: 1px solid var(--color-ash);
  border-radius: 5px;
  background: rgba(7, 17, 13, 0.5);
}
.pr-rank.locked {
  opacity: 0.45;
}
.pr-rank.filled {
  border-color: rgba(255, 106, 43, 0.55);
  background: rgba(255, 106, 43, 0.08);
}
.pr-rank-body {
  min-width: 0;
}
.pr-rank-label {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.14em;
  font-size: 0.54rem;
  color: var(--color-smoke);
}
.pr-rank-perk {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: 0.95rem;
  color: var(--color-gold);
  line-height: 1.15;
  margin-top: 0.15rem;
}
.pr-rank-perk.empty {
  font-family: var(--font-sans);
  text-transform: none;
  font-weight: 400;
  font-size: 0.8rem;
  color: #5f6f66;
}
.pr-rank-clear {
  margin-left: auto;
  flex: none;
  width: 1.4rem;
  height: 1.4rem;
  line-height: 1;
  font-size: 1rem;
  color: var(--color-smoke);
  background: transparent;
  border: 1px solid var(--color-ash);
  border-radius: 2px;
  cursor: pointer;
}
.pr-rank-clear:hover {
  color: var(--color-bone);
  border-color: var(--color-ember);
}
.pr-pool-label {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.14em;
  font-size: 0.58rem;
  color: var(--color-smoke);
  margin-bottom: 0.6rem;
}
.pr-rank-mark {
  display: grid;
  place-items: center;
  min-width: 2rem;
  height: 2rem;
  padding: 0 0.4rem;
  font-family: var(--font-display);
  font-weight: 700;
  letter-spacing: 0.08em;
  font-size: 0.85rem;
  color: var(--color-gold);
  border: 1px solid rgba(223, 184, 91, 0.45);
  clip-path: polygon(15% 0, 85% 0, 100% 50%, 85% 100%, 15% 100%, 0 50%);
  background: rgba(223, 184, 91, 0.1);
}
.pr-rank.locked .pr-rank-mark {
  color: var(--color-smoke);
  border-color: var(--color-ash);
  background: transparent;
}
.pr-rank.filled .pr-rank-mark {
  color: var(--color-ember);
  border-color: rgba(255, 106, 43, 0.5);
  background: rgba(255, 106, 43, 0.12);
}
.pr-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: 0.7rem;
}
.pr-card {
  position: relative;
  border: 1px solid var(--color-ash);
  border-left: 2px solid var(--color-gold);
  border-radius: 4px;
  background: rgba(7, 17, 13, 0.5);
  padding: 0.9rem 1rem;
  text-align: left;
  font: inherit;
  cursor: pointer;
  transition: 0.15s;
}
.pr-card:hover:not(:disabled) {
  border-color: var(--color-ash-2);
  border-left-color: var(--color-gold);
  background: rgba(14, 28, 22, 0.7);
}
.pr-card:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}
.pr-card.picked {
  border-color: var(--color-ember);
  border-left-color: var(--color-ember);
  background: rgba(255, 106, 43, 0.12);
  box-shadow:
    inset 0 0 0 1px rgba(255, 106, 43, 0.35),
    0 0 22px -6px rgba(255, 106, 43, 0.55);
  opacity: 1;
}
.pr-card.picked .pr-name {
  color: var(--color-gold);
}
.pr-mark {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 9px;
  height: 9px;
  transform: rotate(45deg);
  background: linear-gradient(180deg, #ffb066, #ff6a2b);
  box-shadow: 0 0 10px rgba(255, 106, 43, 0.8);
}
.pr-name {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: 1rem;
  color: var(--color-bone);
  margin-bottom: 0.3rem;
}
.pr-desc {
  color: #c3d0c6;
  font-size: 0.83rem;
  line-height: 1.5;
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
}
</style>
