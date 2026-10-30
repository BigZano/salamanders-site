<script setup>
// Standings for one event (the live one or an archived one): the top three on a podium, the table, the points
// progression and the Watch Companies. With `share`, the Watch Commander can copy the standings as a Discord message.
import { computed, ref } from 'vue'
import { COMPANIES, discordText, num } from '../../../lib/deathwatch/tracker'
import PointsChart from './PointsChart.vue'

const props = defineProps({
  R: { type: Object, required: true },
  team: { type: Function, required: true },
  share: { type: Boolean, default: false },
})

const podium = computed(() => props.R.ts.filter((t) => t.tot > 0).slice(0, 3))
const weekMax = computed(() => Math.max(1, ...props.R.ts.flatMap((t) => t.wk)))
// Medal places by points, so teams level on points share a medal colour.
const medal = (t) => (t.tot > 0 ? 1 + props.R.ts.filter((x) => x.tot > t.tot).length : 9)
const move = (t) => (t.mv > 0 ? `▲${t.mv}` : t.mv < 0 ? `▼${-t.mv}` : '–')
const companies = computed(() =>
  COMPANIES.map((c) => {
    const a = props.R.ts.filter((t) => t.co === c)
    return { c, n: a.length, pts: a.reduce((x, t) => x + t.tot, 0) }
  }).sort((a, b) => b.pts - a.pts),
)

const text = ref('')
const copied = ref('')
async function copy() {
  try {
    await navigator.clipboard.writeText(text.value)
    copied.value = 'Copied ✓'
  } catch {
    copied.value = 'Select all and copy by hand'
  }
}
</script>

<template>
  <h2 class="dw-plaque">Standings</h2>
  <ol v-if="podium.length" class="pod" aria-label="Top three">
    <li v-for="t in podium" :key="t.id" class="pod-card" :class="`p${t.r}`">
      <div class="pod-head">
        <span class="pod-rank">{{ t.r }}</span>
        <div>
          <h3 class="pod-name"><RouterLink class="dw-link" :to="team(t.id)">{{ t.n }}</RouterLink></h3>
          <small>{{ t.co }} Company · {{ t.pl }} missions</small>
        </div>
      </div>
      <p class="pod-pts"><span>{{ num(t.tot) }}</span><small>event points</small></p>
      <div class="pod-weeks" role="img" :aria-label="`Points per week: ${t.wk.map((w, j) => `W${j + 1} ${num(w)}`).join(', ')}`">
        <i v-for="(w, j) in t.wk" :key="j" :style="{ '--h': `${((w / weekMax) * 100).toFixed(1)}%` }"><b>W{{ j + 1 }}</b></i>
      </div>
      <p class="pod-foot"><span>Ø {{ num(Math.round(t.avg)) }}/mission</span><span>{{ t.gap ? `−${num(t.gap)} to #1` : 'Leading' }}</span></p>
    </li>
  </ol>
  <div class="dw-scroll">
    <table class="dw-table">
      <thead>
        <tr><th>#</th><th class="l">Kill Team</th><th>W1</th><th>W2</th><th>W3</th><th>W4</th><th>Total</th><th>Gap</th><th>Ø/mission</th></tr>
      </thead>
      <tbody>
        <tr v-for="t in R.ts" :key="t.id" :class="medal(t) < 4 ? `m${medal(t)}` : ''">
          <td class="rank">{{ t.r }}</td>
          <td class="l">
            <b><RouterLink class="dw-link" :to="team(t.id)">{{ t.n }}</RouterLink></b>
            <small>{{ t.co }} <span :class="t.mv > 0 ? 'up' : t.mv < 0 ? 'down' : ''">{{ move(t) }}</span></small>
          </td>
          <td v-for="(w, j) in t.wk" :key="j">{{ num(w) }}</td>
          <td class="big">{{ num(t.tot) }}</td>
          <td>{{ t.gap ? `−${num(t.gap)}` : '–' }}</td>
          <td>{{ num(Math.round(t.avg)) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
  <h2 class="dw-plaque">Points progression</h2>
  <PointsChart :R="R" />
  <h2 class="dw-plaque">Watch Companies</h2>
  <div class="dw-scroll">
    <table class="dw-table">
      <thead>
        <tr><th class="l">Company</th><th>Kill Teams</th><th>Points</th></tr>
      </thead>
      <tbody>
        <tr v-for="c in companies" :key="c.c">
          <td class="l"><b>{{ c.c }}</b></td>
          <td>{{ c.n }}</td>
          <td class="big">{{ num(c.pts) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
  <template v-if="share">
    <div class="dw-actions">
      <button type="button" class="dw-btn" @click="text = discordText(R)">Share to Discord</button>
    </div>
    <div v-if="text" class="share">
      <textarea v-model="text" rows="12" aria-label="Discord message" />
      <div class="dw-actions">
        <button type="button" class="dw-btn" @click="copy">Copy</button>
        <button type="button" class="dw-btn" @click="text = ''">Close</button>
        <span class="dw-msg" role="status">{{ copied }}</span>
      </div>
    </div>
  </template>
</template>

<style scoped>
.pod {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 0.75rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.pod-card {
  display: grid;
  gap: 0.6rem;
  padding: 1rem;
  border: 1px solid var(--dw-line-2);
  background: color-mix(in oklab, var(--dw-surface) 88%, transparent);
  --pc: var(--dw-accent);
}
.pod-card.p1 {
  --pc: var(--dw-gold);
  border-color: color-mix(in oklab, var(--dw-gold) 55%, var(--dw-line-2));
}
.pod-card.p2 {
  --pc: var(--dw-silver);
}
.pod-card.p3 {
  --pc: #d39a68;
}
.pod-head {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}
.pod-rank {
  display: grid;
  place-items: center;
  flex: none;
  width: 2.4rem;
  height: 2.4rem;
  font: 500 1.6rem / 1 var(--dw-font-hud);
  color: var(--dw-bg);
  background: var(--pc);
  clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
}
.pod-name {
  margin: 0;
  font: 600 1.1rem / 1.2 var(--dw-font-cond);
  color: var(--dw-ink);
  overflow-wrap: anywhere;
}
.pod-head small,
.pod-pts small,
.pod-foot {
  color: var(--dw-muted);
  font-size: 0.85rem;
}
.pod-pts {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin: 0;
}
.pod-pts span {
  font: 500 2.2rem / 1 var(--dw-font-hud);
  color: var(--pc);
}
.pod-weeks {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  align-items: end;
  gap: 0.4rem;
  height: 4.5rem;
}
.pod-weeks i {
  position: relative;
  height: max(var(--h), 2px);
  background: color-mix(in oklab, var(--pc) 55%, transparent);
}
.pod-weeks b {
  position: absolute;
  bottom: -1.2rem;
  left: 0;
  right: 0;
  font: 600 0.7rem / 1 var(--dw-font-cond);
  font-style: normal;
  text-align: center;
  color: var(--dw-muted);
}
.pod-foot {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  margin: 0.9rem 0 0;
}
.share {
  display: grid;
  gap: 0.6rem;
}
.share textarea {
  width: 100%;
  padding: 0.7rem;
  font: 400 0.85rem / 1.4 ui-monospace, monospace;
  color: var(--dw-ink);
  background: var(--dw-bg);
  border: 1px solid var(--dw-line-2);
}
</style>
