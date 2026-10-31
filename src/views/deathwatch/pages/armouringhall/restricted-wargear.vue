<script setup>
// Armouring Hall → Restricted Wargear: Deathwatch wargear that combatants not on deployment may not wear, and how
// each piece is unlocked for good. The text is the old site's (its rw_* page texts).
// shortcut: the text is fixed here until Page Texts is ported; then it becomes editable like the other pages.

const PIECES = [
  { set: 'Mark VIII Errant Deathwatch', part: 'L. Pauldron', unlock: 'one (1) Tour of Duty', proof: 'you retain the Discord role awarded for a completed Tour.' },
  { set: 'Deathwatch', part: 'L. Gauntlet (Heroic)', unlock: 'two (2) Tours of Duty', proof: 'two (2) mentions.' },
]
</script>

<template>
  <div class="dw-page">
    <header class="rw-head">
      <p class="rw-cls">Armouring Hall</p>
      <h2 class="rw-title">Restricted Wargear</h2>
    </header>
    <section class="rw">
      <h3>Restricted / Locked Wargear</h3>
      <p class="rw-f">Wargear that is Restricted or completely Locked from being worn.</p>
      <h4>Non-Active Deployment</h4>
      <p>
        The following Deathwatch wargear may <b>not</b> be worn by combatants who are not currently deployed with the Watch, unless explicit authorization has
        been granted:
      </p>
      <div class="rw-grid">
        <div v-for="p in PIECES" :key="p.part" class="rw-card">
          <span class="rw-set">{{ p.set }}</span>
          <b>{{ p.part }}</b>
          <p>Permanently unlocked by completing <b>{{ p.unlock }}</b>.</p>
          <p class="rw-proof">Proof: {{ p.proof }}</p>
        </div>
      </div>
      <p class="rw-f">A Tour of Duty is a four-week Deathwatch Tour. <b>Previous Tours of Duty also count</b> toward the required number.</p>
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
.rw b {
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
