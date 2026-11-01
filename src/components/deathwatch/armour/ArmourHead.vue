<script setup>
// The head of an Armouring Hall page: the hall's own head (HallHead), the picker between the tab's uniforms as
// a dropdown (links, so each has its address), then the uniform's icon either side of its class label and its title
// in the uniform's own colours. On a phone the dropdown is a bar that opens them in a bottom sheet instead, as the
// area's own bar does for its tabs.
import { onBeforeUnmount, ref } from 'vue'
import { useRoute } from 'vue-router'
import { itemSlug } from '../../../lib/deathwatch/armour'
import DeathwatchAreaBar from '../DeathwatchAreaBar.vue'
import DeathwatchNavSheet from '../DeathwatchNavSheet.vue'
import HallHead from './HallHead.vue'
import './armour.css'

defineProps({
  label: { type: String, required: true },
  tab: { type: String, required: true },
  list: { type: Array, required: true },
  current: { type: Object, required: true },
})
const route = useRoute()
const to = (tab, u) => ({ path: `/deathwatch/armouringhall/${tab}/${itemSlug(u)}`, query: route.query.scene ? { scene: route.query.scene } : {} })
const sheet = ref(false)
// The wide screen's dropdown: closes on a pick, on Escape (back to its button), and when focus leaves it.
const dd = ref(null)
function close(e) {
  dd.value.open = false
  if (e?.key === 'Escape') dd.value.querySelector('summary').focus()
}
const leave = (e) => dd.value.contains(e.relatedTarget) || (dd.value.open = false)
// Safari on macOS does not focus <summary> on a click, so a click elsewhere brings no focusout: a press outside closes
// it too, listened for only while it is open.
function outside(e) {
  if (dd.value && !dd.value.contains(e.target)) dd.value.open = false
}
// From the event, not the ref: toggle comes a task later, by when a pick may have taken the page (and the ref) away.
function toggled(e) {
  if (e.target.open) document.addEventListener('pointerdown', outside)
  else document.removeEventListener('pointerdown', outside)
}
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside))
</script>

<template>
  <HallHead :tab="tab" />
  <template v-if="list.length > 1">
    <div class="ah-pick">
      <details ref="dd" class="ah-dd" @focusout="leave" @keydown.esc="close" @toggle="toggled">
        <summary class="ah-dd-btn">
          <img :src="current.ico" alt="" width="34" height="34" />
          <span>{{ current.name }}</span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </summary>
        <nav class="ah-dd-list" :aria-label="label">
          <RouterLink
            v-for="u in list"
            :key="u.name"
            class="ah-pick-link"
            :to="to(tab, u)"
            :aria-current="u === current ? 'page' : undefined"
            @click="close"
          >
            <img :src="u.ico" alt="" width="28" height="28" />
            <span>{{ u.name }}</span>
            <i v-if="u.wip" class="ah-wip">WIP</i>
          </RouterLink>
        </nav>
      </details>
    </div>
    <DeathwatchAreaBar class="ah-pick-bar" :area-label="label" :tab-label="current.name" :open="sheet" @open="sheet = true" />
    <DeathwatchNavSheet v-model="sheet" :aria-label="`${label} uniforms`">
      <nav class="ah-pick-sheet" :aria-label="label">
        <RouterLink
          v-for="u in list"
          :key="u.name"
          class="ah-pick-row"
          :to="to(tab, u)"
          :aria-current="u === current ? 'page' : undefined"
          @click="sheet = false"
        >
          <img :src="u.ico" alt="" width="34" height="34" />
          <span>{{ u.name }}</span>
          <i v-if="u.wip" class="ah-wip">WIP</i>
        </RouterLink>
      </nav>
    </DeathwatchNavSheet>
  </template>
  <header class="ah-head" :style="{ '--t1': current.t[0], '--t2': current.t[1], '--t3': current.t[2] }">
    <img class="ah-icon" :src="current.ico" alt="" width="76" height="76" />
    <div>
      <p class="ah-cls">{{ label }}</p>
      <h3 class="ah-title">{{ current.name }}</h3>
      <p v-if="current.wip" class="ah-wip-line"><span class="ah-wip">WIP</span></p>
      <span class="ah-orn" aria-hidden="true" />
    </div>
    <img class="ah-icon" :src="current.ico" alt="" width="76" height="76" />
  </header>
</template>

<style scoped>
/* A phone: the bar that opens the uniforms in the sheet; from 900px the sub-tabs instead. */
.ah-pick {
  display: none;
}
.ah-pick-sheet {
  display: grid;
  gap: 0.4rem;
}
.ah-pick-row {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  min-height: 52px;
  padding: 0.4rem 0.9rem 0.4rem 0.6rem;
  font: 600 0.95rem / 1 var(--dw-font-cond);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  text-decoration: none;
  color: var(--dw-ink);
  border: 1px solid var(--dw-line-2);
  border-radius: 10px;
}
.ah-pick-row img {
  width: 34px;
  height: auto;
}
.ah-pick-row[aria-current='page'] {
  color: var(--dw-accent);
  border-color: var(--dw-accent);
}
.ah-pick-row:focus-visible {
  outline: 2px solid var(--dw-accent);
  outline-offset: 2px;
}
@media (min-width: 900px) {
  .ah-pick-bar {
    display: none;
  }
}
/* The uniforms as a dropdown under a gold rule, as in the design: a framed button with the open uniform's icon and
   name (the tab's name already shows above the uniform's title); its list opens over the page below. */
@media (min-width: 900px) {
  .ah-pick {
    display: grid;
    justify-items: center;
    gap: 0.5rem;
    padding-top: 0.8rem;
    background: linear-gradient(90deg, transparent, var(--dw-gold) 10%, var(--dw-gold) 90%, transparent) top / 100% 1px no-repeat;
  }
}
.ah-dd {
  position: relative;
  width: min(24rem, 100%);
}
.ah-dd-btn {
  display: flex;
  align-items: center;
  gap: 0.9rem;
  min-height: 56px;
  padding: 0.4rem 1rem 0.4rem 0.6rem;
  list-style: none;
  cursor: pointer;
  font: 600 1.05rem / 1 var(--dw-font-cond);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--dw-ink);
  border: 1px solid color-mix(in oklab, var(--dw-gold) 45%, var(--dw-line-2));
  border-radius: 8px;
  background: color-mix(in oklab, var(--dw-surface) 85%, transparent);
}
.ah-dd-btn::-webkit-details-marker {
  display: none;
}
.ah-dd-btn span {
  flex: 1;
  text-align: center;
}
.ah-dd-btn img {
  width: 34px;
  height: auto;
}
.ah-dd-btn svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform var(--dur-state) var(--ease-forge);
}
.ah-dd[open] .ah-dd-btn svg {
  transform: rotate(180deg);
}
.ah-dd-btn:focus-visible {
  outline: 2px solid var(--dw-accent);
  outline-offset: 2px;
}
.ah-dd-list {
  position: absolute;
  inset: calc(100% + 0.35rem) 0 auto;
  z-index: 20;
  display: grid;
  gap: 0.25rem;
  padding: 0.35rem;
  border: 1px solid color-mix(in oklab, var(--dw-gold) 45%, var(--dw-line-2));
  border-radius: 8px;
  background: var(--dw-surface);
  box-shadow: 0 12px 30px rgb(0 0 0 / 0.6);
}
.ah-pick-link {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 44px;
  padding: 0 0.75rem 0 0.5rem;
  font: 600 0.85rem / 1 var(--dw-font-cond);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  text-decoration: none;
  color: var(--dw-muted);
  border-radius: 6px;
}
.ah-pick-link img {
  width: 28px;
  height: auto;
}
.ah-pick-link[aria-current='page'] {
  color: var(--dw-accent);
  background: color-mix(in oklab, var(--dw-accent) 10%, transparent);
}
.ah-pick-link:focus-visible {
  outline: 2px solid var(--dw-accent);
  outline-offset: -2px;
}
@media (hover: hover) and (pointer: fine) {
  .ah-pick-link:hover,
  .ah-dd-btn:hover {
    color: var(--dw-ink);
    border-color: var(--dw-accent);
  }
  .ah-pick-link:hover {
    background: color-mix(in oklab, var(--dw-ink) 6%, transparent);
  }
}
.ah-head {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: clamp(0.75rem, 3vw, 2rem);
  text-align: center;
}
.ah-icon {
  flex: none;
  width: clamp(30px, 6vw, 76px);
  height: auto;
  filter: drop-shadow(0 4px 10px rgb(0 0 0 / 0.55));
}
.ah-cls {
  margin: 0;
  font: 600 0.8rem / 1 var(--dw-font-cond);
  letter-spacing: 0.4em;
  text-transform: uppercase;
  color: var(--dw-muted);
}
.ah-title {
  margin: 0.3rem 0 0;
  font: 700 clamp(2rem, 6vw, 4.2rem) / 1.05 var(--dw-font-title);
  background: linear-gradient(180deg, var(--t1), var(--t2) 55%, var(--t3));
  background-clip: text;
  color: transparent;
  filter: drop-shadow(0 2px 2px rgb(0 0 0 / 0.8));
}
.ah-orn {
  position: relative;
  display: block;
  width: min(340px, 80%);
  height: 14px;
  margin: 0.3rem auto 0;
  background: linear-gradient(90deg, transparent, var(--dw-accent) 30%, var(--dw-accent) 70%, transparent) center / 100% 1px no-repeat;
}
.ah-orn::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 8px;
  height: 8px;
  background: var(--dw-accent);
  transform: translate(-50%, -50%) rotate(45deg);
  box-shadow: 0 0 10px var(--dw-accent);
}
.ah-wip {
  padding: 1px 6px;
  font: 700 0.7rem / 1.3 var(--dw-font-cond);
  font-style: normal;
  letter-spacing: 0.14em;
  color: var(--dw-gold);
  border: 1px solid var(--dw-gold);
  border-radius: 4px;
}
.ah-wip-line {
  margin: 0.4rem 0 0;
}
</style>
