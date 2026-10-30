<script setup>
// One part of a uniform in detail: its tiles, a row per paint, its notes. Shown beside the figure on a wide screen
// and in the bottom sheet on a phone. Notes that refer to Company Heraldry link there, on the canonical address. The
// notes are the part's page text (armourTexts.js notesOf), one per line, with their marks.
import { useRoute } from 'vue-router'
import { resolveArea } from '../../../lib/deathwatch/areas'
import { PAINT, noteParts } from '../../../lib/deathwatch/armour'
import { inline } from '../../../lib/deathwatch/notables'
import Inline from '../Inline'
import ArmourTiles from './ArmourTiles.vue'

defineProps({
  label: { type: String, required: true },
  part: { type: Array, required: true },
  notes: { type: Array, required: true },
  sprite: { type: String, required: true },
})
const route = useRoute()
const heraldryLink = () => ({
  path: resolveArea({ area: 'armouringhall', tab: 'standard', sub: 'companyheraldry' }).canonical,
  query: route.query.scene ? { scene: route.query.scene } : {},
})

// A note without the "(see Company Heraldry)" aside, which becomes a link below it instead.
const clean = (n) => n.replace(/\s*\(see Company Heraldry\)/, '')
const heraldry = (n) => /Company Heraldry/.test(n)
</script>

<template>
  <div class="ad">
    <p class="ad-cls">{{ label }} Armour</p>
    <h4 class="ad-title">{{ part[0] }}</h4>
    <ArmourTiles class="ad-tiles" :sprite="sprite" :tiles="part[3]" :count="11" />
    <ul v-if="part[1].length" class="ad-sw">
      <li v-for="[role, paint] in part[1]" :key="role">
        <i :style="{ '--c': PAINT[paint] }" /><small>{{ role }}</small>{{ paint }}
      </li>
    </ul>
    <div v-if="notes.length" class="ad-notes">
      <template v-for="n in notes" :key="n">
        <p v-if="n.startsWith('///')" class="ah-cf">{{ n }}</p>
        <p v-else-if="noteParts(clean(n))" class="ah-nt">
          <b>{{ noteParts(clean(n))[0] }}</b><span><Inline :segs="inline(noteParts(clean(n))[1])" /></span>
        </p>
        <p v-else><Inline :segs="inline(clean(n))" /></p>
        <RouterLink v-if="heraldry(n)" class="ah-chl" :to="heraldryLink()">Company Heraldry<i aria-hidden="true">›</i></RouterLink>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ad {
  display: grid;
  gap: 0.9rem;
}
.ad-cls {
  margin: 0;
  font: 600 0.78rem / 1 var(--dw-font-cond);
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--dw-accent);
}
.ad-title {
  margin: -0.4rem 0 0;
  font: 700 clamp(1.6rem, 3vw, 2.1rem) / 1.1 var(--dw-font-title);
  color: var(--dw-ink);
}
.ad-tiles {
  --tiles-max: 22rem;
}
.ad-sw {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ad-sw li {
  display: grid;
  grid-template-columns: 40px 1fr;
  column-gap: 14px;
  align-items: center;
  padding: 0.6rem 0;
  font-weight: 600;
  line-height: 1.25;
}
.ad-sw li + li {
  border-top: 1px solid var(--dw-line);
}
.ad-sw small {
  font: 600 0.7rem var(--dw-font-cond);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--dw-muted);
}
.ad-sw i {
  grid-row: 1 / 3;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: radial-gradient(circle at 32% 30%, rgb(255 255 255 / 0.45), transparent 42%), var(--c);
  box-shadow: inset 0 -3px 5px rgb(0 0 0 / 0.4), 0 0 0 1px var(--dw-line-2);
}
/* A gold hairline with a diamond splits the paints from the notes, as on the head's ornament. */
.ad-notes {
  display: grid;
  gap: 0.5rem;
  padding-top: 0.9rem;
  background: linear-gradient(90deg, transparent, var(--dw-gold) 15%, var(--dw-gold) 85%, transparent) top / 100% 1px no-repeat;
}
.ad-notes p {
  margin: 0;
  line-height: 1.5;
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
  justify-self: start;
  align-items: center;
  gap: 0.4rem;
  min-height: 36px;
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
</style>
