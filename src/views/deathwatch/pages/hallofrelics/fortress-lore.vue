<script setup>
// The Fortress Lore, as the old site set it: an illuminated chronicle in relic gold. A hero over the Hall of Relics'
// painting, a row of chapter buttons (they scroll; no #hash, which the router would take for a page), six chapters
// with their numeral, a gold initial, speeches, proclamations and battle cries. The texts are the old site's (lib/deathwatch/lore.js), each replaced by what the area's data holds for it.
import { computed, onMounted, ref } from 'vue'
import Inline from '../../../../components/deathwatch/Inline'
import LoadRetry from '../../../../components/deathwatch/LoadRetry.vue'
import { lore } from '../../../../lib/deathwatch/lore'
import { useAuth } from '../../../../stores/auth'
import { useDeathwatchData } from '../../../../stores/deathwatchData'

const auth = useAuth()
const data = useDeathwatchData()
// Once: the defaults show at once, and what the data holds replaces them when it arrives.
onMounted(() => {
  if (data.status !== 'ready') data.load(auth.token)
})
const l = computed(() => lore(data.cfg.tx))

const sections = ref({})
const reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
// To the chapter, and the keyboard's focus with it, so the next Tab goes on from there.
function jump(key) {
  const el = sections.value[key]
  el?.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' })
  el?.focus({ preventScroll: true })
}
</script>

<template>
  <div class="dw-page lo">
    <h2 class="dw-sr-only">Fortress Lore</h2>
    <LoadRetry v-if="data.status === 'error'">The latest texts could not be loaded.</LoadRetry>
    <header class="lo-hero">
      <p class="lo-cls">Hall of Relics · Fortress Lore</p>
      <p class="lo-title" aria-hidden="true">Watch Fortress Ebonhold</p>
      <p v-if="l.sub.length" class="lo-sub"><Inline :segs="l.sub" /></p>
      <span class="lo-orn" aria-hidden="true" />
      <p v-if="l.epigraph.length" class="lo-epi"><Inline :segs="l.epigraph" /></p>
    </header>

    <nav class="lo-toc" aria-label="Chapters">
      <button v-for="c in l.chapters" :key="c.n" type="button" @click="jump(c.n)">
        <b>{{ c.n }}</b><Inline :segs="c.title" />
      </button>
    </nav>

    <section v-for="c in l.chapters" :key="c.n" :ref="(el) => (sections[c.n] = el)" class="lo-c" tabindex="-1">
      <header>
        <span class="lo-n" aria-hidden="true"><span>{{ c.n }}</span></span>
        <h3 class="lo-h"><Inline :segs="c.title" /></h3>
      </header>
      <div class="lo-b">
        <template v-for="(b, i) in c.blocks" :key="i">
          <p v-if="b.kind === 'p'"><Inline :segs="b.lines[0]" /></p>
          <blockquote v-else-if="b.kind === 'q'" class="lo-sp">
            <p v-for="(line, j) in b.lines" :key="j"><Inline :segs="line" /></p>
          </blockquote>
          <p v-else-if="b.kind === 'x'" class="lo-x"><Inline :segs="b.lines[0]" /></p>
          <div v-else class="lo-cry">
            <p v-for="(line, j) in b.lines" :key="j"><Inline :segs="line" /></p>
          </div>
        </template>
      </div>
    </section>

  </div>
</template>

<style scoped>
/* The old site's Fortress Lore (Obsidian & Gold), in the area's own faces: Cinzel for titles, Barlow Condensed for
   labels, Teko for the battle cries. */
.lo {
  --gd: #d6b05c;
  --gl: #f3e2b0;
  max-width: 880px;
  margin: 0 auto;
}
.lo-hero {
  position: relative;
  display: grid;
  justify-items: center;
  gap: 8px;
  padding: clamp(48px, 9vw, 110px) 20px clamp(36px, 6vw, 64px);
  overflow: hidden;
  isolation: isolate;
  text-align: center;
  border: 1px solid #c99a3e;
  border-radius: 12px;
  box-shadow: 0 0 0 1px rgb(214 176 92 / 0.25), 0 0 50px -10px rgb(214 176 92 / 0.45);
}
.lo-hero::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  background:
    radial-gradient(ellipse at 50% 40%, rgb(0 0 0 / 0.35), rgb(0 0 0 / 0.88) 78%),
    linear-gradient(180deg, rgb(5 6 4 / 0.2), rgb(5 6 4 / 0.95)),
    url('../../../../components/deathwatch/img/lore-relics.webp') center 30% / cover no-repeat;
}
.lo-cls {
  margin: 0;
  font: 600 13px var(--dw-font-cond);
  letter-spacing: 0.4em;
  text-transform: uppercase;
  color: var(--gd);
}
.lo-title {
  margin: 0;
  font: 700 clamp(34px, 7vw, 76px) / 1.05 var(--dw-font-title);
  text-wrap: balance;
  background: linear-gradient(180deg, #fff0b8 0%, #d9a536 45%, #7a4b0a 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  filter: drop-shadow(0 2px 2px rgb(0 0 0 / 0.8));
}
.lo-sub {
  margin: 0;
  font: 700 clamp(12px, 1.6vw, 16px) var(--dw-font-title);
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--gl);
}
.lo-orn {
  position: relative;
  display: block;
  width: min(340px, 80%);
  height: 14px;
  margin: 4px auto 0;
  background: linear-gradient(90deg, transparent, var(--gd) 30%, var(--gd) 70%, transparent) center / 100% 1px no-repeat;
}
.lo-orn::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 8px;
  height: 8px;
  background: var(--gd);
  transform: translate(-50%, -50%) rotate(45deg);
  box-shadow: 0 0 12px rgb(240 213 138 / 0.8);
}
.lo-epi {
  max-width: 50ch;
  margin: 10px 0 0;
  font: italic 500 clamp(17px, 2vw, 21px) / 1.5 var(--dw-font-title);
  color: #efe6cf;
  text-shadow: 0 2px 8px #000;
}

.lo-toc {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin: 22px 0 0;
}
.lo-toc button {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 7px 14px 6px;
  font: 600 13px var(--dw-font-cond);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--gl);
  background: rgb(10 10 12 / 0.8);
  border: 1px solid rgb(201 154 62 / 0.4);
  border-radius: 999px;
  cursor: pointer;
  transition: border-color 0.2s, background-color 0.2s;
}
.lo-toc b {
  font: 700 14px var(--dw-font-title);
  color: var(--gd);
}
.lo-toc button:hover,
.lo-toc button:focus-visible {
  border-color: var(--gd);
  background: rgb(214 176 92 / 0.14);
}
.lo-toc button:focus-visible {
  outline: 2px solid var(--gl);
  outline-offset: 2px;
}
/* A chapter takes the focus from its button; it is no control, so it shows no ring of its own. */
.lo-c:focus {
  outline: none;
}

.lo-c {
  scroll-margin-top: 5rem;
  margin: 56px 0 0;
}
.lo-c header {
  display: grid;
  justify-items: center;
  gap: 4px;
  margin-bottom: 22px;
  text-align: center;
}
.lo-c header::after {
  content: '';
  width: min(260px, 60%);
  height: 1px;
  margin-top: 10px;
  background: linear-gradient(90deg, transparent, var(--gd), transparent);
}
/* The chapter's numeral, in a gold-edged diamond of black stone. */
.lo-n {
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  rotate: 45deg;
  border: 1px solid #c99a3e;
  background: radial-gradient(circle at 35% 30%, #2c2c33, #0b0b0e 70%);
  box-shadow: 0 0 18px -4px rgb(212 169 74 / 0.55);
}
.lo-n span {
  rotate: -45deg;
  font: 700 19px var(--dw-font-title);
  color: var(--gl);
}
.lo-h {
  margin: 16px 0 0;
  font: 700 clamp(22px, 3vw, 32px) / 1.15 var(--dw-font-title);
  letter-spacing: 0.06em;
  color: var(--gl);
  text-wrap: balance;
}
.lo-b {
  max-width: 66ch;
  margin: 0 auto;
  font-size: 17px;
  line-height: 1.75;
  color: #ddd5c2;
}
.lo-b p {
  margin: 0 0 14px;
}
/* The chapter opens on a gold initial. */
.lo-b > p:first-child::first-letter {
  float: left;
  margin: 6px 10px 0 0;
  font: 700 3.7em / 0.8 var(--dw-font-title);
  color: var(--gd);
  text-shadow: 0 0 12px rgb(214 176 92 / 0.45);
}
.lo-b .lo-x {
  margin: 24px 0;
  font: 700 clamp(18px, 2.3vw, 24px) / 1.35 var(--dw-font-title);
  letter-spacing: 0.04em;
  text-align: center;
  color: var(--gl);
  text-wrap: balance;
}
/* A speech: a gold rule down its side. */
.lo-sp {
  margin: 22px 0;
  padding: 18px 22px;
  font: italic 500 18px / 1.6 var(--dw-font-title);
  color: #efe6cf;
  border-left: 3px solid var(--gd);
  background: linear-gradient(90deg, rgb(212 169 74 / 0.08), transparent);
}
.lo-b .lo-sp p {
  margin: 0 0 10px;
}
.lo-b .lo-sp p:last-child {
  margin: 0;
}
/* Battle cries, glowing like the forge. */
.lo-cry {
  display: grid;
  gap: 4px;
  margin: 26px 0;
  padding: 18px 12px;
  text-align: center;
  border-block: 1px solid rgb(214 176 92 / 0.4);
  background: radial-gradient(ellipse at 50% 100%, rgb(255 110 30 / 0.14), transparent 70%);
}
.lo-b .lo-cry p {
  margin: 0;
  font: 500 clamp(24px, 3.4vw, 38px) / 1.1 var(--dw-font-hud);
  letter-spacing: 0.1em;
  color: #ff9a4a;
  text-shadow: 0 0 14px rgb(255 120 40 / 0.55);
}

.lo :deep(b) {
  color: var(--gl);
}
@media (prefers-reduced-motion: reduce) {
  .lo-toc button {
    transition: none;
  }
}
</style>
