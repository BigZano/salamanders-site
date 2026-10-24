<script setup>
// One uniform: its parts in two columns either side of the figure. A part card and the figure's hotspot for it
// light up together (hover or focus on either); a hotspot also scrolls to its card. Notes that refer to Company
// Heraldry link there.
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { PAINT, hotspot, noteParts } from '../../../lib/deathwatch/armour'
import ArmourHead from './ArmourHead.vue'
import ArmourTiles from './ArmourTiles.vue'

const props = defineProps({
  label: { type: String, required: true },
  tab: { type: String, required: true },
  list: { type: Array, required: true },
  current: { type: Object, required: true },
})

const route = useRoute()
const link = (tab, item) => ({ path: `/deathwatch/armouringhall/${tab}${item ? `/${item}` : ''}`, query: route.query.scene ? { scene: route.query.scene } : {} })
const lit = ref('')
const flash = ref('')
const cards = ref({})
const parts = computed(() => [...props.current.L, ...props.current.R])
const reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// A note without the "(see Company Heraldry)" aside, which becomes a link below it instead.
const clean = (n) => n.replace(/\s*\(see Company Heraldry\)/, '')
const heraldry = (n) => /Company Heraldry/.test(n)

function jump(title) {
  cards.value[title]?.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' })
  flash.value = ''
  requestAnimationFrame(() => (flash.value = title))
}
</script>

<template>
  <div class="ah">
    <ArmourHead :label="label" :tab="tab" :list="list" :current="current" />
    <p v-if="current.who" class="ah-lead">
      In addition to the
      <template v-if="!current.specialistOnly"><RouterLink :to="link('standard', 'watchbrother')">standard Watch-Brother Uniform</RouterLink></template>
      <template v-if="current.command">{{ current.specialistOnly ? '' : ' and the' }} <RouterLink :to="link('specialist')">Specialist</RouterLink> markings</template>, {{ current.who }}
      may use the following colors and markings:
    </p>

    <div class="ah-grid">
      <figure class="ah-fig">
        <div class="ah-screen">
        <img :src="current.img" :alt="`${current.name} armour, front view`" width="468" height="880" />
        <button
          v-for="p in parts"
          :key="p[0]"
          type="button"
          class="ah-hs"
          :class="{ on: lit === p[0] }"
          :style="{ left: `${hotspot(current, p[4])[0]}%`, top: `${hotspot(current, p[4])[1]}%` }"
          :aria-label="`Show ${p[0]}`"
          @mouseenter="lit = p[0]"
          @mouseleave="lit = ''"
          @focus="lit = p[0]"
          @blur="lit = ''"
          @click="jump(p[0])"
        >
          <span>{{ p[0] }}</span>
        </button>
        </div>
        <figcaption>{{ current.name }} · front view<span>Tap a marker to find its part</span></figcaption>
      </figure>
      <div v-for="(col, c) in [current.L, current.R]" :key="c" class="ah-col" :class="{ r: c }">
        <section
          v-for="[title, rows, notes, tiles] in col"
          :key="title"
          :ref="(el) => (cards[title] = el)"
          class="ah-part"
          :class="{ on: lit === title, flash: flash === title }"
          tabindex="-1"
          @mouseenter="lit = title"
          @mouseleave="lit = ''"
          @animationend="flash = ''"
        >
          <h4>{{ title }}</h4>
          <ArmourTiles :sprite="current.spr" :tiles="tiles" :count="11" />
          <div v-if="rows.length" class="ah-sw">
            <span v-for="[role, paint] in rows" :key="role">
              <i :style="{ '--c': PAINT[paint] }" /><small>{{ role }}</small>{{ paint }}
            </span>
          </div>
          <template v-for="n in notes" :key="n">
            <p v-if="n.startsWith('///')" class="ah-cf">{{ n }}</p>
            <p v-else-if="noteParts(clean(n))" class="ah-nt">
              <b>{{ noteParts(clean(n))[0] }}</b><span>{{ noteParts(clean(n))[1] }}</span>
            </p>
            <p v-else>{{ clean(n) }}</p>
            <RouterLink v-if="heraldry(n)" class="ah-chl" :to="link('standard', 'companyheraldry')">Company Heraldry<i aria-hidden="true">›</i></RouterLink>
          </template>
        </section>
      </div>
    </div>

    <section class="ah-set">
      <h4>Armour Set</h4>
      <p>Coming soon</p>
    </section>
  </div>
</template>

<style scoped>
.ah-lead {
  margin: 0;
  padding: 0.75rem 1rem;
  border: 1px solid var(--dw-line-2);
  background: color-mix(in oklab, var(--dw-surface) 80%, transparent);
}
.ah-lead a {
  font-weight: 700;
  color: var(--dw-accent);
  text-decoration: underline;
  text-decoration-color: color-mix(in oklab, var(--dw-accent) 50%, transparent);
  text-underline-offset: 4px;
}
.ah-lead a:focus-visible {
  outline: 2px solid var(--dw-accent);
  outline-offset: 2px;
}
.ah-hs {
  position: absolute;
  z-index: 2;
  width: 18px;
  height: 18px;
  margin: -9px 0 0 -9px;
  padding: 0;
  border: 2px solid var(--dw-accent);
  border-radius: 50%;
  background: rgb(10 13 17 / 0.65);
  cursor: pointer;
  transition: transform 0.25s, background-color 0.25s;
}
/* A larger invisible target than the 18px dot, for a thumb. */
.ah-hs::after {
  content: '';
  position: absolute;
  inset: -13px;
}
.ah-hs span {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 9px);
  translate: -50% 4px;
  padding: 3px 10px;
  font: 700 0.75rem / 1.2 var(--dw-font-cond);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  white-space: nowrap;
  color: var(--dw-accent);
  background: rgb(10 13 17 / 0.92);
  border: 1px solid var(--dw-accent);
  border-radius: 999px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s, translate 0.25s;
}
.ah-hs.on,
.ah-hs:focus-visible {
  transform: scale(1.3);
  background: var(--dw-accent);
  outline: none;
}
.ah-hs.on span,
.ah-hs:focus-visible span {
  opacity: 1;
  translate: -50% 0;
}
.ah-part:focus {
  outline: none;
}
.ah-part.on {
  border-color: var(--dw-accent);
  background: var(--dw-grain), color-mix(in oklab, var(--dw-accent) 8%, #0b130c);
}
.ah-part.flash {
  animation: ah-flash 1.3s ease-out;
}
/* The card a marker jumped to brightens, then settles. Its corners are clipped, so it lights from inside. */
@keyframes ah-flash {
  from {
    border-color: var(--dw-accent);
    background-color: color-mix(in oklab, var(--dw-accent) 22%, #0b130c);
  }
}
.ah-nt {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  padding: 0.55rem 0.75rem;
  font-size: 0.9rem;
  border-left: 1px solid color-mix(in oklab, var(--dw-accent) 70%, transparent);
  background: linear-gradient(90deg, color-mix(in oklab, var(--dw-accent) 9%, transparent), transparent 85%);
}
.ah-nt b {
  min-width: 58px;
  padding-top: 2px;
  font: 500 0.95rem / 1 var(--dw-font-hud);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--dw-accent);
}
.ah-cf {
  font: 600 0.9rem ui-monospace, Consolas, monospace;
  letter-spacing: 0.14em;
  color: var(--dw-muted);
}
.ah-chl {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 36px;
  margin-top: 0.5rem;
  padding: 0.25rem 0.75rem;
  font: 600 0.85rem / 1 var(--dw-font-cond);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  text-decoration: none;
  color: var(--dw-accent);
  border: 1px solid color-mix(in oklab, var(--dw-accent) 50%, var(--dw-line-2));
}
.ah-chl i {
  font-style: normal;
}
.ah-chl:focus-visible {
  outline: 2px solid var(--dw-accent);
  outline-offset: 2px;
}
.ah-set {
  display: grid;
  justify-items: center;
  gap: 0.4rem;
  padding: 1.4rem 1rem 1.2rem;
  text-align: center;
  border: 1px solid transparent;
  border-image: var(--dw-frame-s) 12 / 12px stretch;
  background: var(--dw-scan), var(--dw-grain), rgb(4 8 4 / 0.7);
}
.ah-set h4 {
  margin: 0;
  font: 500 clamp(1.6rem, 3vw, 2.2rem) / 1 var(--dw-font-hud);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--dw-accent);
}
.ah-set p {
  margin: 0;
  font: 700 0.9rem var(--dw-font-cond);
  letter-spacing: 0.4em;
  text-transform: uppercase;
  color: var(--dw-muted);
}
@media (prefers-reduced-motion: reduce) {
  .ah-part.flash {
    animation: none;
  }
  .ah-hs,
  .ah-hs span {
    transition: none;
  }
}
</style>
