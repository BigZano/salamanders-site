<script setup>
// Company Heraldry, laid out as a uniform is (armour-view.css): the Battle Companies as a list with their pauldrons |
// the Watch Brother figure | the chosen company's pauldron and greave (and its alternative colours, where it has
// them), with the Watch Company markings under it. Tiles come from one sprite of 23: 0–13 the 1st to 7th Company
// (pauldron, greave), 14–18 the Watch Company markings Primus to Quintus, 19–22 the alternative 5th and 6th. The
// notes are page texts (lib/deathwatch/armourTexts.js) the Watch Commander can edit: one note under every company,
// the alternative note under an alternative scheme.
import { computed, onMounted, ref } from 'vue'
import { PAINT } from '../../../lib/deathwatch/armour'
import { heraldryNotes } from '../../../lib/deathwatch/armourTexts'
import { useAuth } from '../../../stores/auth'
import { useDeathwatchData } from '../../../stores/deathwatchData'
import Inline from '../Inline'
import ArmourHead from './ArmourHead.vue'
import ArmourTiles from './ArmourTiles.vue'
import './armour-view.css'

defineProps({
  label: { type: String, required: true },
  tab: { type: String, required: true },
  list: { type: Array, required: true },
  current: { type: Object, required: true },
})
const N = 23
const ORD = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th']
const ALT = { 4: [19, 20], 5: [21, 22] }
// The Watch Brother in each company's colours (screenshots of 31 Oct 2026): co-1st.jpg … co-7th.jpg, co-5thalt.jpg.
const FIGS = import.meta.glob('../img/armour/co-*.jpg', { eager: true, import: 'default' })
const fig = computed(() => FIGS[`../img/armour/co-${ORD[k.value]}${alt.value && ALT[k.value] ? 'alt' : ''}.jpg`])
const auth = useAuth()
const data = useDeathwatchData()
// Once: the defaults show at once, and what the data holds replaces them when it arrives.
onMounted(() => {
  if (data.status !== 'ready') data.load(auth.token)
})
const notes = (slug) => heraldryNotes(data.cfg.tx, slug)

const k = ref(0)
const alt = ref(false)
const scheme = computed(() => (alt.value && ALT[k.value]) || [k.value * 2, k.value * 2 + 1])
const note = computed(() => notes(alt.value && ALT[k.value] ? 'alternative' : 'companies'))
function pick(i) {
  k.value = i
  alt.value = false
}
// The company's pauldron from the sprite of 23, cropped to fill a thumbnail.
const thumb = (i) => ({ backgroundImage: 'var(--spr)', backgroundSize: `${N * 100}% auto`, backgroundPosition: `${((i * 2) / (N - 1)) * 100}% 35%` })
</script>

<template>
  <div class="ah" :style="{ '--spr': `url(${current.spr})` }">
    <ArmourHead :label="label" :tab="tab" :list="list" :current="current" />

    <div class="av">
      <nav class="av-parts" aria-labelledby="hv-cos-h">
        <h4 id="hv-cos-h" class="av-h">Battle Company</h4>
        <ul>
          <li v-for="(n, i) in ORD" :key="n">
            <button type="button" class="av-part" :aria-current="i === k ? 'true' : undefined" @click="pick(i)">
              <i class="av-thumb" :style="thumb(i)" aria-hidden="true" />
              <span>{{ n }} Company</span>
              <svg class="av-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
            </button>
          </li>
        </ul>
      </nav>

      <div class="av-stage">
        <figure class="av-fig">
          <img :src="fig" :alt="`Watch Brother armour in the ${ORD[k]} Company's colours, front view`" width="468" height="880" />
          <figcaption>Front view</figcaption>
        </figure>
      </div>

      <div class="hv-side">
        <p class="av-live" aria-live="polite">Showing the {{ ORD[k] }} Company</p>
        <section class="hv-box">
          <h4 class="hv-h">{{ ORD[k] }} Company</h4>
          <template v-if="ALT[k]">
            <p class="hv-lbl">Colour scheme</p>
            <div class="hv-modes" role="group" aria-label="Colour scheme">
              <button type="button" class="hv-mode" :aria-pressed="!alt" @click="alt = false">Standard</button>
              <button type="button" class="hv-mode" :aria-pressed="alt" @click="alt = true">Alternative</button>
            </div>
          </template>
          <div class="hv-pg"><span class="hv-lbl">Pauldron</span><span class="hv-lbl">Greave</span></div>
          <ArmourTiles class="hv-tiles" :sprite="current.spr" :tiles="scheme" :count="N" />
          <p v-for="(p, i) in note" :key="i" class="hv-note"><Inline :segs="p" /></p>
        </section>

        <section class="hv-box">
          <h4 class="hv-h">Watch Company Markings</h4>
          <ArmourTiles class="wm" :sprite="current.spr" :tiles="[14, 15, 16, 17, 18]" :count="N" />
          <div class="ah-sw">
            <span><i :style="{ '--c': PAINT['Abaddon Black'] }" /><small>Marking</small>Abaddon Black</span>
            <span><i :style="{ '--c': PAINT['Mephiston Red'] }" /><small>Stripe</small>Mephiston Red</span>
          </div>
          <p v-for="(p, i) in notes('markings')" :key="i" class="hv-note"><Inline :segs="p" /></p>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* A phone: the figure, the companies as a strip, then the chosen one; from 700px the third column. */
.hv-side {
  order: 3;
  display: grid;
  align-content: start;
  gap: 0.75rem;
}
@container (min-width: 700px) {
  .hv-side {
    order: 0;
  }
}
.hv-box {
  display: grid;
  gap: 0.6rem;
  padding: 1.1rem;
  border: 1px solid color-mix(in oklab, var(--dw-gold) 35%, var(--dw-line-2));
  border-radius: 10px;
  background: var(--dw-grain), color-mix(in oklab, #0b130c 94%, transparent);
}
.hv-h {
  margin: 0;
  padding-bottom: 0.7rem;
  font: 600 1.15rem / 1 var(--dw-font-title);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--dw-gold);
  border-bottom: 1px solid color-mix(in oklab, var(--dw-gold) 40%, transparent);
}
.hv-lbl {
  margin: 0;
  font: 600 0.85rem / 1.2 var(--dw-font-body);
  color: var(--dw-ink);
}
.hv-modes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border: 1px solid var(--dw-line-2);
  border-radius: 8px;
  overflow: hidden;
}
.hv-mode {
  min-height: 44px;
  font: 600 0.9rem / 1 var(--dw-font-body);
  color: var(--dw-muted);
  background: none;
  border: 0;
  cursor: pointer;
}
.hv-mode[aria-pressed='true'] {
  color: var(--dw-ink);
  background: color-mix(in oklab, var(--dw-accent) 16%, transparent);
  box-shadow: inset 0 0 0 1px var(--dw-accent);
  border-radius: 8px;
}
.hv-mode:focus-visible {
  outline: 2px solid var(--dw-accent);
  outline-offset: -2px;
}
.hv-pg {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.hv-note {
  margin: 0;
  font-size: 0.92rem;
  line-height: 1.5;
  color: var(--dw-muted);
}
/* The pauldron and greave fill the box, so they line up under their labels (same two columns, same gap). */
.hv-tiles {
  --tiles-max: none;
}
.wm {
  --tiles: 5;
  --tiles-max: none;
}
/* The figure stands in the middle column without markers, so it may grow as the uniforms' does. */
.av-stage {
  align-self: start;
}
</style>
