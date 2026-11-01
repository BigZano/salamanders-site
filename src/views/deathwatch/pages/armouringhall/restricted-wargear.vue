<script setup>
// Armouring Hall → Restricted Wargear: Deathwatch wargear that combatants not on deployment may not wear, and how
// each piece is unlocked for good. The texts are page texts (rw_*, lib/deathwatch/armourTexts.js), the old site's by
// default, which the Watch Commander can edit from the page. Two sub-tabs: Non-Active Deployment (those texts) and
// Active Deployment (to come).
import { computed, onMounted, ref } from 'vue'
import Inline from '../../../../components/deathwatch/Inline'
import HallHead from '../../../../components/deathwatch/armour/HallHead.vue'
import { restrictedWargear } from '../../../../lib/deathwatch/armourTexts'
import { useAuth } from '../../../../stores/auth'
import { useDeathwatchData } from '../../../../stores/deathwatchData'

const auth = useAuth()
const data = useDeathwatchData()
// Once: the defaults show at once, and what the data holds replaces them when it arrives.
onMounted(() => {
  if (data.status !== 'ready') data.load(auth.token)
})
const rw = computed(() => restrictedWargear(data.cfg.tx))
const MODES = [
  ['non-active', 'Non-Active Deployment'],
  ['active', 'Active Deployment', true],
]
const mode = ref('non-active')
</script>

<template>
  <div class="dw-page">
    <HallHead tab="restricted-wargear" />
    <header class="rw-head">
      <h2 class="rw-title">Restricted Wargear</h2>
    </header>
    <div class="rw-modes" role="group" aria-label="Deployment">
      <button v-for="[k, label, wip] in MODES" :key="k" type="button" class="rw-mode" :aria-pressed="mode === k ? 'true' : 'false'" @click="mode = k">
        {{ label }}<i v-if="wip" class="rw-wip">WIP</i>
      </button>
    </div>
    <section v-if="mode === 'active'" class="rw rw-soon">
      <h3>Active Deployment</h3>
      <p>Coming soon</p>
    </section>
    <section v-else class="rw">
      <h3 v-if="rw.title.length"><Inline :segs="rw.title" /></h3>
      <p v-if="rw.sub.length" class="rw-f"><Inline :segs="rw.sub" /></p>
      <h4 v-if="rw.heading.length"><Inline :segs="rw.heading" /></h4>
      <p v-if="rw.intro.length"><Inline :segs="rw.intro" /></p>
      <div v-if="rw.cards.length" class="rw-grid">
        <div v-for="(p, i) in rw.cards" :key="i" class="rw-card">
          <span class="rw-set">{{ p.set }}</span>
          <b>{{ p.part }}</b>
          <p v-if="p.unlock.length"><Inline :segs="p.unlock" /></p>
          <p v-if="p.proof.length" class="rw-proof"><Inline :segs="p.proof" /></p>
        </div>
      </div>
      <p v-if="rw.footnote.length" class="rw-f"><Inline :segs="rw.footnote" /></p>
    </section>
  </div>
</template>

<style scoped>
.rw-head {
  margin-top: 1.25rem;
  text-align: center;
}
.rw-title {
  margin: 0;
  font: 700 clamp(2rem, 6vw, 4.2rem) / 1.05 var(--dw-font-title);
  color: #ff8a73;
  text-shadow: 0 2px 2px rgb(0 0 0 / 0.8);
}
/* The two sub-tabs, as the uniforms' in the other tabs: plain words under a gold rule, the open one underlined. */
.rw-modes {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  margin: 0.75rem 0;
  padding-top: 0.6rem;
  background: linear-gradient(90deg, transparent, var(--dw-gold) 10%, var(--dw-gold) 90%, transparent) top / 100% 1px no-repeat;
}
.rw-mode {
  min-height: 44px;
  padding: 0 clamp(0.6rem, 2.5vw, 1.2rem);
  font: 600 0.8rem / 1 var(--dw-font-cond);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--dw-muted);
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  cursor: pointer;
}
/* As the uniforms' WIP mark (ArmourHead). */
.rw-wip {
  margin-left: 0.5rem;
  padding: 1px 6px;
  font: 700 0.7rem / 1.3 var(--dw-font-cond);
  font-style: normal;
  letter-spacing: 0.14em;
  color: var(--dw-gold);
  border: 1px solid var(--dw-gold);
  border-radius: 4px;
}
.rw-mode + .rw-mode {
  border-left: 1px solid var(--dw-line-2);
}
.rw-mode[aria-pressed='true'] {
  color: var(--dw-accent);
  border-bottom-color: var(--dw-accent);
}
.rw-mode:focus-visible {
  outline: 2px solid var(--dw-accent);
  outline-offset: -2px;
}
@media (hover: hover) and (pointer: fine) {
  .rw-mode:hover {
    color: var(--dw-ink);
  }
}
.rw-soon {
  justify-items: center;
  padding-block: 2rem;
  text-align: center;
}
.rw-soon p {
  font: 700 0.9rem var(--dw-font-cond);
  letter-spacing: 0.4em;
  text-transform: uppercase;
  color: var(--dw-muted);
}
.rw {
  display: grid;
  gap: 0.7rem;
  padding: 1.25rem 1.4rem;
  border: 1px solid rgb(232 80 60 / 0.45);
  border-radius: 8px;
  background: linear-gradient(180deg, rgb(232 80 60 / 0.08), transparent 60%), rgb(4 8 4 / 0.7);
}
.rw h3 {
  margin: 0;
  font: 700 1.25rem var(--dw-font-cond);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #ff8a73;
}
.rw h4 {
  margin: 0.4rem 0 0;
  font: 700 0.8rem var(--dw-font-cond);
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: #ff8a73;
}
.rw p {
  margin: 0;
  line-height: 1.55;
}
/* Bold in a page text: its elements carry no scope id (Inline.js). */
.rw :deep(b) {
  color: var(--dw-ink);
}
.rw-f {
  font-size: 0.9rem;
  color: var(--dw-muted);
}
.rw-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr));
  gap: 10px;
}
.rw-card {
  display: grid;
  gap: 4px;
  padding: 0.75rem 0.9rem;
  border: 1px solid var(--dw-line-2);
  border-left: 3px solid #ff8a73;
  border-radius: 6px;
  background: var(--dw-surface);
}
.rw-set {
  font: 600 0.7rem var(--dw-font-cond);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--dw-muted);
}
.rw-card > b {
  font: 700 1.1rem var(--dw-font-cond);
  color: var(--dw-accent);
}
.rw-proof {
  font-size: 0.8rem;
  color: var(--dw-muted);
}
</style>
