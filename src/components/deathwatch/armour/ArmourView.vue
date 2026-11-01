<script setup>
// One uniform, one part at a time. On a wide screen: the parts as a list, the figure, the chosen part in detail.
// On a phone: the figure, the parts as a strip of thumbnails, and a bar at the foot that opens the chosen part in a
// bottom sheet (a marker opens it straight away). A part and its marker light up together (hover or focus on
// either). The introduction and the notes are page texts (lib/deathwatch/armourTexts.js) the Watch Commander can edit.
import { computed, onMounted, ref } from 'vue'
import { hotspot } from '../../../lib/deathwatch/armour'
import { leadOf, notesOf } from '../../../lib/deathwatch/armourTexts'
import { useAuth } from '../../../stores/auth'
import { useDeathwatchData } from '../../../stores/deathwatchData'
import DeathwatchNavSheet from '../DeathwatchNavSheet.vue'
import Inline from '../Inline'
import ArmourDetail from './ArmourDetail.vue'
import ArmourHead from './ArmourHead.vue'
import './armour-view.css'

const props = defineProps({
  label: { type: String, required: true },
  tab: { type: String, required: true },
  list: { type: Array, required: true },
  current: { type: Object, required: true },
})

const auth = useAuth()
const data = useDeathwatchData()
// Once: the defaults show at once, and what the data holds replaces them when it arrives.
onMounted(() => {
  if (data.status !== 'ready') data.load(auth.token)
})
const lead = computed(() => leadOf(data.cfg.tx, props.current))
const notes = computed(() => notesOf(data.cfg.tx, props.current, part.value[0]))
const parts = computed(() => [...props.current.L, ...props.current.R])
// The chosen part by title, so it stays chosen on the next uniform; the first part until one is chosen.
const sel = ref('')
const part = computed(() => parts.value.find((p) => p[0] === sel.value) ?? parts.value[0])
const lit = ref('')
const sheet = ref(false)
// The layout follows the hall's own width (a container query), so the stylesheet decides: no detail beside the
// figure means the phone layout.
const detail = ref(null)
const phone = () => getComputedStyle(detail.value).display === 'none'

// A part's tile, cut from the sprite of 11 and cropped to fill a thumbnail: its middle, or for a part whose telling
// detail sits higher in the tile (the knee, the chest's eagle), nearer its top. The first tile, but the Gauntlets'
// second, which shows the gauntlet better.
const FOCUS_Y = { Wargear: 25, Breastplate: 25, Greaves: 12 }
const THUMB_TILE = { Gauntlets: 1 }
const thumb = (p) => ({
  backgroundImage: `url(${props.current.spr})`,
  backgroundPosition: `${(p[3][THUMB_TILE[p[0]] ?? 0] ?? p[3][0]) * 10}% ${FOCUS_Y[p[0]] ?? 50}%`,
})

function pick(title, open = false) {
  sel.value = title
  if (open && phone()) sheet.value = true
}
</script>

<template>
  <div class="ah">
    <ArmourHead :label="label" :tab="tab" :list="list" :current="current" />
    <p v-if="lead.length" class="ah-lead"><Inline :segs="lead" /></p>

    <div class="av">
      <nav class="av-parts" aria-labelledby="av-parts-h">
        <h4 id="av-parts-h" class="av-h">Armour Parts</h4>
        <ul>
          <li v-for="p in parts" :key="p[0]">
            <button
              type="button"
              class="av-part"
              :class="{ on: lit === p[0] }"
              :aria-current="p === part ? 'true' : undefined"
              @mouseenter="lit = p[0]"
              @mouseleave="lit = ''"
              @focus="lit = p[0]"
              @blur="lit = ''"
              @click="pick(p[0])"
            >
              <i class="av-thumb" :style="thumb(p)" aria-hidden="true" />
              <span>{{ p[0] }}</span>
              <svg class="av-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
            </button>
          </li>
        </ul>
      </nav>

      <div class="av-stage">
        <figure class="av-fig">
          <img :src="current.img" :alt="`${current.name} armour, front view`" width="468" height="880" />
          <button
            v-for="p in parts"
            :key="p[0]"
            type="button"
            class="ah-hs"
            :class="{ on: lit === p[0] || p === part, l: hotspot(current, p[4])[0] < 20, r: hotspot(current, p[4])[0] > 80 }"
            :style="{ left: `${hotspot(current, p[4])[0]}%`, top: `${hotspot(current, p[4])[1]}%` }"
            :aria-label="`Show ${p[0]}`"
            @mouseenter="lit = p[0]"
            @mouseleave="lit = ''"
            @focus="lit = p[0]"
            @blur="lit = ''"
            @click="pick(p[0], true)"
          >
            <span>{{ p[0] }}</span>
          </button>
          <figcaption>Front view</figcaption>
        </figure>
        <p class="av-hint">Select a part or a marker to view its details.</p>
      </div>

      <!-- Announced in a word on each pick; the panel itself is not live, so its tiles are not all read out again. -->
      <p class="av-live" aria-live="polite">Showing {{ part[0] }}</p>
      <aside ref="detail" class="av-detail">
        <ArmourDetail :label="label" :part="part" :notes="notes" :sprite="current.spr" />
      </aside>

      <button type="button" class="av-bar" @click="sheet = true">
        <i class="av-thumb" :style="thumb(part)" aria-hidden="true" />
        <span><b>{{ part[0] }}</b>View colours &amp; details</span>
        <svg class="av-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>
      </button>
    </div>

    <DeathwatchNavSheet v-model="sheet" :aria-label="`${part[0]} details`">
      <div class="av-sheet">
        <button type="button" class="av-close" aria-label="Close" @click="sheet = false">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
        <ArmourDetail :label="label" :part="part" :notes="notes" :sprite="current.spr" />
      </div>
    </DeathwatchNavSheet>

    <section class="ah-set">
      <h4>Armour Set</h4>
      <p>Coming soon</p>
    </section>
  </div>
</template>
