<script setup>
// One area of the fortress (Event Tracker, Armouring Hall, Chronicles of Valor, Manage): its list of views and
// the view that is open. The views themselves are rebuilt in later chunks; each shows a placeholder until then.
// The address is already canonical by the time this renders: the router's guard (redirect.js) sees to that.
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { AREAS, resolveArea } from '../../lib/deathwatch/areas'
import { useDeathwatch } from '../../stores/deathwatch'
import DeathwatchAreaBar from '../../components/deathwatch/DeathwatchAreaBar.vue'
import DeathwatchNav from '../../components/deathwatch/DeathwatchNav.vue'
import DeathwatchNavSheet from '../../components/deathwatch/DeathwatchNavSheet.vue'

const route = useRoute()
const store = useDeathwatch()
// Whether the list of views is open in the bottom sheet (a phone: from 900px wide it is the sidebar instead).
const sheetOpen = ref(false)

const page = computed(() => resolveArea(route.params))
const area = computed(() => AREAS[page.value.area])
const tabLabel = computed(() => area.value.tabs.find((t) => t.slug === page.value.tab).label)
// Manage is the Watch Commander's dashboard. Hiding it here only spares others a dead end: the server refuses them anyway.
const restricted = computed(() => page.value.area === 'manage' && !store.commander)
</script>

<template>
  <section v-if="page" class="dw-area">
    <p v-if="restricted" class="dw-area-restricted surface" role="status">Restricted to the Watch Commander.</p>
    <template v-else>
      <!-- A phone: the banner says where you are and opens the list of views from the foot of the screen. -->
      <DeathwatchAreaBar class="dw-area-bar" :area-label="area.label" :tab-label="tabLabel" :open="sheetOpen" @open="sheetOpen = true" />
      <DeathwatchNavSheet v-model="sheetOpen" :aria-label="`${area.label} views`">
        <DeathwatchNav :area="page.area" :current="page.tab" @navigate="sheetOpen = false" />
      </DeathwatchNavSheet>
      <!-- A wide screen: the same list, always open beside the page. -->
      <aside class="dw-area-side">
        <DeathwatchNav :area="page.area" :current="page.tab" />
      </aside>
      <div class="dw-area-main">
        <h1 class="dw-area-title">{{ area.label }}</h1>
        <h2 class="dw-area-tab">{{ tabLabel }}</h2>
        <div class="dw-area-placeholder surface">
          <p>This view is being rebuilt.</p>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.dw-area {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1.5rem;
  max-width: 64rem;
  margin: 0 auto;
  padding: 2rem 1rem 3rem;
}
/* One list of views, two ways to reach it: the bar and sheet below 900px, the sidebar from 900px. */
.dw-area-side {
  display: none;
}
@media (min-width: 900px) {
  .dw-area {
    grid-template-columns: 14rem 1fr;
  }
  .dw-area-bar {
    display: none;
  }
  .dw-area-side {
    display: block;
  }
}
.dw-area-title {
  margin: 0;
  font-family: var(--dw-font-title);
  font-size: clamp(1.7rem, 6vw, 2.6rem);
  font-weight: 700;
  color: var(--dw-ink);
}
.dw-area-tab {
  margin: 0.2rem 0 1.2rem;
  font-size: 1rem;
  font-weight: 500;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--dw-accent);
}
.dw-area-placeholder,
.dw-area-restricted {
  margin: 0;
  padding: 2rem 1.4rem;
  border: 1px solid var(--dw-line-2);
  border-radius: 3px;
  color: var(--dw-silver);
}
.dw-area-restricted {
  grid-column: 1 / -1;
  text-align: center;
}
</style>
