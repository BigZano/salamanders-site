<script setup>
// Armouring Hall → Restricted Wargear: Deathwatch wargear that combatants not on deployment may not wear, and how
// each piece is unlocked for good. The texts are page texts (rw_*, lib/deathwatch/armourTexts.js), the old site's by
// default, which the Watch Commander can edit from the page.
import { computed, onMounted } from 'vue'
import Inline from '../../../../components/deathwatch/Inline'
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
</script>

<template>
  <div class="dw-page">
    <header class="rw-head">
      <p class="rw-cls">Armouring Hall</p>
      <h2 class="rw-title">Restricted Wargear</h2>
    </header>
    <section class="rw">
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
  text-align: center;
}
.rw-cls {
  margin: 0;
  font: 600 0.8rem / 1 var(--dw-font-cond);
  letter-spacing: 0.4em;
  text-transform: uppercase;
  color: var(--dw-muted);
}
.rw-title {
  margin: 0.3rem 0 0;
  font: 700 clamp(2rem, 6vw, 4.2rem) / 1.05 var(--dw-font-title);
  color: #ff8a73;
  text-shadow: 0 2px 2px rgb(0 0 0 / 0.8);
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
