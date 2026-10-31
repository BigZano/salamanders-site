<script setup>
// The head of an Armouring Hall page: the picker between the tab's uniforms (as links, so each has its address),
// then the uniform's icon either side of its class label and its title in the uniform's own colours.
import { useRoute } from 'vue-router'
import { itemSlug } from '../../../lib/deathwatch/armour'
import './armour.css'

defineProps({
  label: { type: String, required: true },
  tab: { type: String, required: true },
  list: { type: Array, required: true },
  current: { type: Object, required: true },
})
const route = useRoute()
const to = (tab, u) => ({ path: `/deathwatch/armouringhall/${tab}/${itemSlug(u)}`, query: route.query.scene ? { scene: route.query.scene } : {} })
</script>

<template>
  <nav v-if="list.length > 1" class="ah-pick" :aria-label="label">
    <RouterLink v-for="u in list" :key="u.name" class="ah-pick-link" :to="to(tab, u)" :aria-current="u === current ? 'page' : undefined">
      <img :src="u.ico" alt="" width="34" height="34" />
      <span>{{ u.name }}</span>
      <i v-if="u.wip" class="ah-wip">WIP</i>
    </RouterLink>
  </nav>
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
.ah-pick {
  display: flex;
  gap: 0.6rem;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  padding: 2px 2px 6px;
  scrollbar-width: none;
}
.ah-pick-link {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.6rem;
  min-height: 44px;
  padding: 0.35rem 1rem 0.35rem 0.5rem;
  font: 600 0.9rem / 1 var(--dw-font-cond);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  text-decoration: none;
  color: var(--dw-muted);
  border: 1px solid var(--dw-line-2);
  border-radius: 999px;
  background: color-mix(in oklab, var(--dw-surface) 70%, transparent);
}
.ah-pick-link img {
  width: 34px;
  height: auto;
}
.ah-pick-link[aria-current='page'] {
  color: var(--dw-accent);
  border-color: var(--dw-accent);
  box-shadow: 0 0 0 1px var(--dw-accent);
}
.ah-pick-link:focus-visible {
  outline: 2px solid var(--dw-accent);
  outline-offset: 2px;
}
@media (hover: hover) and (pointer: fine) {
  .ah-pick-link:hover {
    color: var(--dw-ink);
    border-color: var(--dw-muted);
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
