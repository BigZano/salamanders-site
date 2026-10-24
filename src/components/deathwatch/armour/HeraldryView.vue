<script setup>
// Company Heraldry: each Battle Company's pauldron and greave, the Watch Company markings and the alternative
// colours, beside the Watch Brother figure. Tiles come from one sprite of 23: 0–13 the 1st to 7th Company (pauldron,
// greave), 14–18 the Watch Company markings Primus to Quintus, 19–22 the alternative 5th and 6th.
import { PAINT } from '../../../lib/deathwatch/armour'
import ArmourHead from './ArmourHead.vue'
import ArmourTiles from './ArmourTiles.vue'

defineProps({
  label: { type: String, required: true },
  tab: { type: String, required: true },
  list: { type: Array, required: true },
  current: { type: Object, required: true },
})
const N = 23
const ORD = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th']
const companies = (ks) => ks.map((k) => [ORD[k], [k * 2, k * 2 + 1]])
</script>

<template>
  <div class="ah">
    <ArmourHead :label="label" :tab="tab" :list="list" :current="current" />
    <div class="ah-grid">
      <figure class="ah-fig">
        <div class="ah-screen"><img :src="current.img" alt="Watch Brother armour, front view" width="468" height="880" /></div>
        <figcaption>Watch Brother · front view</figcaption>
      </figure>
      <div class="ah-col">
        <section class="ah-part">
          <h4>Battle Companies I–IV</h4>
          <div class="cos">
            <div v-for="[n, t] in companies([0, 1, 2, 3])" :key="n" class="co"><b>{{ n }} Company</b><ArmourTiles :sprite="current.spr" :tiles="t" :count="N" /></div>
          </div>
        </section>
        <section class="ah-part">
          <h4>Watch Company Markings</h4>
          <ArmourTiles class="wm" :sprite="current.spr" :tiles="[14, 15, 16, 17, 18]" :count="N" />
          <div class="ah-sw">
            <span><i :style="{ '--c': PAINT['Abaddon Black'] }" /><small>Marking</small>Abaddon Black</span>
            <span><i :style="{ '--c': PAINT['Mephiston Red'] }" /><small>Stripe</small>Mephiston Red</span>
          </div>
          <p>Painted Abaddon Black with a Mephiston Red stripe. Fully black markings denote Watch Company Primus.</p>
        </section>
      </div>
      <div class="ah-col r">
        <section class="ah-part">
          <h4>Battle Companies V–VII</h4>
          <div class="cos">
            <div v-for="[n, t] in companies([4, 5, 6])" :key="n" class="co"><b>{{ n }} Company</b><ArmourTiles :sprite="current.spr" :tiles="t" :count="N" /></div>
          </div>
          <p>These colors follow the standards of each Battle-Brother's own Company and also appear in the regular uniform guidelines.</p>
        </section>
        <section class="ah-part">
          <h4>Alternative Colors</h4>
          <div class="cos">
            <div class="co"><b>5th Company</b><ArmourTiles :sprite="current.spr" :tiles="[19, 20]" :count="N" /></div>
            <div class="co"><b>6th Company</b><ArmourTiles :sprite="current.spr" :tiles="[21, 22]" :count="N" /></div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cos {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 12px;
}
.co b {
  display: block;
  margin-bottom: 6px;
  font: 600 0.9rem var(--dw-font-cond);
  letter-spacing: 0.08em;
  color: var(--dw-ink);
}
.co {
  --tiles-max: 9.5rem;
}
.wm {
  margin-bottom: 0.75rem;
}
.wm {
  --tiles: 5;
  --tiles-max: none;
}
</style>
