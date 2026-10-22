<script setup>
// One area of the fortress (Event Tracker, Armouring Hall, Chronicles of Valor, Manage): the rail with the
// crest, the area's name and its list of views, and beside it the framed sheet that holds the open view. The
// views themselves are files under ./pages/<area>/<tab>.vue (found by lib/deathwatch/pages.js); each is a
// skeleton until it is rebuilt. The address is already canonical by the time this renders: the router's guard
// (redirect.js) sees to that.
import { computed, defineAsyncComponent, h, ref } from 'vue'
import { useRoute } from 'vue-router'
import { AREAS, resolveArea } from '../../lib/deathwatch/areas'
import { pageLoader } from '../../lib/deathwatch/pages'
import { useDeathwatch } from '../../stores/deathwatch'
import crest from '../../components/deathwatch/img/crest.webp'
import DeathwatchAreaBar from '../../components/deathwatch/DeathwatchAreaBar.vue'
import DeathwatchNav from '../../components/deathwatch/DeathwatchNav.vue'
import DeathwatchNavSheet from '../../components/deathwatch/DeathwatchNavSheet.vue'
import { SkNote } from '../../components/deathwatch/skeleton'

const route = useRoute()
const store = useDeathwatch()
// Whether the list of views is open in the bottom sheet (a phone: from 900px wide it is the sidebar instead).
const sheetOpen = ref(false)

const page = computed(() => resolveArea(route.params))
const area = computed(() => AREAS[page.value.area])
// Manage is the Watch Commander's dashboard. Hiding it here only spares others a dead end: the server refuses them anyway.
const restricted = computed(() => page.value.area === 'manage' && !store.commander)
const tabLabel = computed(() => area.value.tabs.find((t) => t.slug === page.value.tab).label)

// While a view's chunk is on its way (after a short delay, so a fast one never flashes it), and if it fails.
const Loading = { render: () => h('p', { class: 'dw-area-loading', role: 'status' }, 'Loading…') }
const Failed = { render: () => h('p', { class: 'dw-area-error', role: 'alert' }, 'This view could not be loaded. Try again.') }
const view = computed(() => {
  const loader = pageLoader(page.value.area, page.value.tab)
  return loader ? defineAsyncComponent({ loader, loadingComponent: Loading, errorComponent: Failed, delay: 200 }) : SkNote
})
</script>

<template>
  <section v-if="page" class="dw-area">
    <p v-if="restricted" class="dw-area-restricted dw-panel" role="status">Restricted to the Watch Commander.</p>
    <template v-else>
      <!-- The rail. On a phone only its head shows (the crest and the area's name); from 900px the list of views joins it. -->
      <aside class="dw-area-side dw-panel">
        <header class="dw-area-head">
          <img class="dw-area-crest" :src="crest" alt="" width="120" height="120" />
          <div>
            <p class="dw-area-eyebrow">Watch Fortress Ebonhold</p>
            <h1 class="dw-area-title">{{ area.label }}</h1>
          </div>
        </header>
        <div class="dw-area-navwrap">
          <DeathwatchNav :area="page.area" :current="page.tab" />
        </div>
      </aside>
      <!-- A phone: the bar says which view is open and opens the list of views from the foot of the screen. -->
      <DeathwatchAreaBar class="dw-area-bar" :area-label="area.label" :tab-label="tabLabel" :open="sheetOpen" @open="sheetOpen = true" />
      <DeathwatchNavSheet v-model="sheetOpen" :aria-label="`${area.label} views`">
        <DeathwatchNav :area="page.area" :current="page.tab" @navigate="sheetOpen = false" />
      </DeathwatchNavSheet>
      <div class="dw-area-main">
        <div class="dw-area-sheet dw-panel">
          <component :is="view" :key="`${page.area}/${page.tab}`" />
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.dw-area {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 1rem;
  max-width: 78rem;
  margin: 0 auto;
  padding: 1.25rem 1rem 3rem;
}
.dw-area-side {
  padding: 0.9rem 1.1rem;
}
.dw-area-head {
  display: flex;
  align-items: center;
  gap: 0.9rem;
}
.dw-area-crest {
  flex: none;
  width: 44px;
  height: 44px;
  object-fit: contain;
  filter: drop-shadow(0 3px 8px rgb(0 0 0 / 0.45));
}
.dw-area-eyebrow {
  margin: 0 0 0.15rem;
  font: 600 0.75rem / 1.3 var(--dw-font-cond);
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--dw-accent);
}
.dw-area-title {
  margin: 0;
  font-family: var(--dw-font-title);
  font-size: clamp(1.1rem, 4.6vw, 1.4rem);
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: 0.04em;
  color: var(--dw-ink);
  text-wrap: balance;
}
/* The list of views has two homes: the bar and sheet below 900px, this rail from 900px. */
.dw-area-navwrap {
  display: none;
}
.dw-area-sheet {
  min-width: 0;
  padding: 1.2rem 1rem 1.6rem;
}
.dw-area-restricted {
  grid-column: 1 / -1;
  margin: 0;
  padding: 2rem 1.4rem;
  text-align: center;
  color: var(--dw-silver);
}
.dw-area-loading,
.dw-area-error {
  margin: 0;
  color: var(--dw-muted);
}
.dw-area-error {
  color: var(--dw-down);
}
@media (min-width: 900px) {
  .dw-area {
    grid-template-columns: 18.75rem minmax(0, 1fr);
    align-items: start;
    gap: 1.5rem;
    padding-top: 2rem;
  }
  .dw-area-side {
    position: sticky;
    top: 5rem;
    display: flex;
    flex-direction: column;
    gap: 1.6rem;
    padding: 1.6rem 1.25rem 1.25rem;
  }
  .dw-area-head {
    flex-direction: column;
    align-items: flex-start;
    gap: 1rem;
  }
  .dw-area-crest {
    width: 120px;
    height: 120px;
  }
  .dw-area-eyebrow {
    font-size: 0.8rem;
  }
  .dw-area-title {
    font-size: 2rem;
  }
  .dw-area-navwrap {
    display: block;
  }
  .dw-area-bar {
    display: none;
  }
  .dw-area-sheet {
    padding: 1.6rem 1.8rem 2rem;
  }
}
</style>
