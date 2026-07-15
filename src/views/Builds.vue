<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { usePlanner } from '../stores/planner'

const planner = usePlanner()
const router = useRouter()

const form = ref({ title: '', role: '', notes: '' })

const toast = ref('')
let t
function flash(m) {
  toast.value = m
  clearTimeout(t)
  t = setTimeout(() => (toast.value = ''), 1800)
}

function save() {
  planner.saveBuild(form.value)
  form.value = { title: '', role: '', notes: '' }
  flash('Build saved')
}
function apply(id) {
  planner.applyBuild(id)
  router.push('/planner')
}
</script>

<template>
  <section class="builds">
    <header class="b-head">
      <p class="eyebrow">Field-tested</p>
      <h1 class="b-title">Recommended Builds</h1>
      <p class="b-intro">
        Your saved loadouts. Build one in the
        <RouterLink to="/planner" class="ilink">Perk Builder</RouterLink>, then name and
        save it here to share with the Chapter.
      </p>
    </header>

    <!-- Save current build -->
    <div class="save-card panel-forge">
      <div class="save-current">
        <p class="save-k">Current build</p>
        <p class="save-v">
          {{ planner.build.className }} · Level {{ planner.build.level }} ·
          {{ planner.build.count }}/8 perks
        </p>
      </div>
      <div class="save-fields">
        <input v-model="form.title" class="fld" type="text" placeholder="Build name (e.g. Lethal Bulwark)" />
        <input v-model="form.role" class="fld fld-sm" type="text" placeholder="Role (optional)" />
      </div>
      <textarea v-model="form.notes" class="fld fld-area" rows="2" placeholder="Notes (optional) — how it plays, when to use it…" />
      <button class="btn-ember btn-save" @click="save">Save current build</button>
    </div>

    <!-- Saved builds -->
    <div v-if="planner.savedBuilds.length" class="b-grid">
      <article v-for="r in planner.savedBuilds" :key="r.id" class="b-card panel-forge">
        <div class="b-card-top">
          <h2 class="b-name">{{ r.title }}</h2>
          <span class="b-class">{{ r.className }}</span>
        </div>
        <p class="b-meta">Level {{ r.level }}<span v-if="r.role"> · {{ r.role }}</span></p>
        <p v-if="r.notes" class="b-notes">{{ r.notes }}</p>

        <dl class="b-load">
          <div><dt>Primary</dt><dd>{{ r.weapons.primary || '—' }}</dd></div>
          <div><dt>Secondary</dt><dd>{{ r.weapons.secondary || '—' }}</dd></div>
          <div><dt>Melee</dt><dd>{{ r.weapons.melee || '—' }}</dd></div>
        </dl>

        <div class="b-perks">
          <span v-for="(p, i) in r.perks.filter(Boolean)" :key="i" class="b-perk">{{ p }}</span>
          <span v-if="!r.perks.some(Boolean)" class="b-perk-none">No class perks selected</span>
        </div>

        <div class="b-actions">
          <button class="btn-drake btn-sm" @click="apply(r.id)">Apply build</button>
          <button class="btn-ghost btn-sm" @click="planner.deleteBuild(r.id)">Delete</button>
        </div>
      </article>
    </div>

    <!-- Empty state -->
    <div v-else class="b-empty panel-forge">
      <div class="b-empty-mark" aria-hidden="true"><span /><span /><span /></div>
      <h2 class="b-empty-title">No builds saved yet</h2>
      <p class="b-empty-body">
        Configure a class build in the Perk Builder, name it above, and save it. Builds
        stay in your browser — sharing with the Chapter comes next.
      </p>
      <RouterLink to="/planner" class="btn-ember b-empty-cta">Open the Perk Builder</RouterLink>
    </div>

    <transition name="toast">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </transition>
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
.ilink {
  color: var(--color-drake);
  border-bottom: 1px solid rgba(89, 214, 108, 0.4);
}

/* save card */
.save-card {
  margin: 2rem 0;
  border-radius: 8px;
  padding: 1.3rem;
  display: grid;
  gap: 0.7rem;
}
.save-k {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.16em;
  font-size: 0.6rem;
  color: var(--color-gold);
}
.save-v {
  font-family: var(--font-display);
  text-transform: uppercase;
  color: var(--color-bone);
  font-size: 1.05rem;
}
.save-fields {
  display: flex;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.fld {
  background: rgba(5, 10, 8, 0.7);
  border: 1px solid var(--color-ash);
  color: var(--color-bone);
  border-radius: 2px;
  padding: 0.6rem 0.75rem;
  font-size: 0.9rem;
  font-family: var(--font-sans);
}
.fld::placeholder {
  color: #5f6f66;
}
.save-fields .fld {
  flex: 1 1 14rem;
}
.fld-sm {
  flex: 0 1 12rem !important;
}
.fld-area {
  width: 100%;
  resize: vertical;
}
.btn-save {
  justify-self: start;
  padding: 0.7rem 1.3rem;
  border-radius: 2px;
}

/* grid */
.b-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
  gap: 1rem;
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
  font-size: 1.2rem;
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
.b-meta {
  color: var(--color-smoke);
  font-size: 0.8rem;
  margin: 0.35rem 0 0.6rem;
}
.b-notes {
  color: #c3d0c6;
  font-size: 0.85rem;
  line-height: 1.5;
  margin-bottom: 0.8rem;
}
.b-load {
  margin: 0 0 0.9rem;
  display: grid;
  gap: 0.35rem;
}
.b-load div {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid rgba(38, 55, 47, 0.5);
  padding-bottom: 0.3rem;
}
.b-load dt {
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 0.62rem;
  color: var(--color-smoke);
}
.b-load dd {
  margin: 0;
  font-size: 0.82rem;
  color: var(--color-bone);
  text-align: right;
}
.b-perks {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  flex-grow: 1;
  align-content: flex-start;
}
.b-perk {
  font-size: 0.72rem;
  color: #c3d0c6;
  background: rgba(255, 106, 43, 0.07);
  border: 1px solid rgba(255, 106, 43, 0.22);
  border-radius: 2px;
  padding: 0.2rem 0.5rem;
}
.b-perk-none {
  font-size: 0.76rem;
  color: #5f6f66;
  font-style: italic;
}
.b-actions {
  display: flex;
  gap: 0.4rem;
  margin-top: 1rem;
}
.btn-sm {
  padding: 0.5rem 0.85rem;
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

/* empty */
.b-empty {
  margin-top: 0.5rem;
  border-radius: 8px;
  padding: 3rem 1.5rem;
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
  font-size: 1.5rem;
  color: var(--color-bone);
}
.b-empty-body {
  color: var(--color-smoke);
  max-width: 44ch;
  line-height: 1.6;
  margin: 0.6rem 0 1.6rem;
}
.b-empty-cta {
  padding: 0.85rem 1.5rem;
  border-radius: 2px;
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
