<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, provide, shallowRef, useTemplateRef, watch } from 'vue'
import { useAuth } from '../stores/auth'
import { useRoster } from '../stores/roster'
import PageHeader from '../components/PageHeader.vue'
import RosterBanner from '../components/roster/RosterBanner.vue'
import RosterBranch from '../components/roster/RosterBranch.vue'
import RosterInfirmary from '../components/roster/RosterInfirmary.vue'
import RosterMember from '../components/roster/RosterMember.vue'
import RosterStatus from '../components/roster/RosterStatus.vue'
import { SCENES } from '../lib/rosterScenes'
import { ROSTER_VIEWER } from '../lib/rosterContext'
import { useOpenBranches } from '../lib/useOpenBranches'
import { useRosterPolling } from '../lib/useRosterPolling'
import { openNow, withReaderPinned } from '../lib/pinReader'
import '../components/roster/roster.css'

// A thin composition surface: fetch lifecycle, which panel shows, and the page's
// actions (Find me, bulk open, status links, deep link). The shape of the page
// comes from store.view (src/lib/rosterView.js); the pieces are in
// src/components/roster/. Hooks for tests and e2e are listed in roster.css.
const auth = useAuth()
const store = useRoster()
const open = useOpenBranches()
const root = useTemplateRef('root')
const showInfirmary = shallowRef(false)
const findMessage = shallowRef('')
// Dev only, with the fixture on: links that flip the page between its scenes.
const devScenes = import.meta.env.DEV && import.meta.env.VITE_ROSTER_FIXTURE ? SCENES : null

provide(ROSTER_VIEWER, computed(() => auth.member?.id ?? null))

const view = computed(() => store.view)
const updated = computed(() => (store.roster ? new Date(store.roster.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''))
const openableKeys = computed(() => view.value?.openableKeys ?? [])
const allOpen = computed(() => open.allOpen(openableKeys.value))

function load() {
  store.load(auth.token)
  if (showInfirmary.value) store.loadInfirmary(auth.token)
}
const polling = useRosterPolling({ load })

function toggleInfirmary() {
  showInfirmary.value = !showInfirmary.value
  if (showInfirmary.value) store.loadInfirmary(auth.token)
}

const branchEls = () => (root.value ? [...root.value.querySelectorAll('.rs-branch, .rs-unassigned')] : [])
const targetOf = (key) => [...(root.value?.querySelectorAll('[data-jump]') ?? [])].find((el) => el.dataset.jump === key)

// Bulk open and close: snap, and hold the branch under the reader's eye in place.
function toggleAll() {
  return withReaderPinned(branchEls(), () => open.setAll(openableKeys.value, !allOpen.value))
}

function flash(el, cls) {
  el.classList.remove(cls)
  void el.offsetWidth // restart the animation if it is already running
  el.classList.add(cls)
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true })
}

// The order of battle is hidden while the Infirmary shows; bring it back before jumping.
async function showOrder() {
  if (!showInfirmary.value) return
  showInfirmary.value = false
  await nextTick()
}

// Open a branch with no height animation, so the scroll that follows is exact.
async function jumpTo(key) {
  await showOrder()
  if (openableKeys.value.includes(key)) await openNow(() => open.openKey(key))
  const el = targetOf(key)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  flash(el, 'rs-flash')
}

async function findMe() {
  findMessage.value = ''
  const id = auth.member?.id
  const key = id ? view.value?.index.get(id) : undefined
  if (!key) {
    findMessage.value = 'You are not on the roll. Check your Legion and rank roles in Discord.'
    return
  }
  await showOrder()
  if (key === 'high-command') {
    targetOf(key)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return
  }
  await openNow(() => open.openKey(key))
  const chip = [...(targetOf(key)?.querySelectorAll('[data-id]') ?? [])].find((el) => el.dataset.id === id)
  if (!chip) return
  chip.scrollIntoView({ behavior: 'smooth', block: 'center' })
  flash(chip, 'rs-ping')
}

// /roster#company-3 opens that branch once, the first time data arrives. The
// sign-in callback also uses the fragment; useOpenBranches ignores that.
let hashApplied = false
async function applyHash() {
  if (hashApplied || !view.value) return
  hashApplied = true
  const key = open.hashKey()
  if (key && openableKeys.value.includes(key)) {
    await nextTick()
    await jumpTo(key)
  }
}
watch(view, (now, before) => {
  if (now && !before) applyHash()
})

// Signing out on this page resets the store to idle; loading again shows the
// sign-in prompt now instead of a bare heading until the next poll.
watch(() => auth.member, () => store.load(auth.token))

onMounted(() => {
  polling.start()
  applyHash()
})
onBeforeUnmount(() => polling.stop())
</script>

<template>
  <section ref="root" class="roster" aria-labelledby="roster-title">
    <PageHeader
      eyebrow="XVIII Legion"
      title="Order of Battle"
      title-id="roster-title"
      lede="Who leads what, read live from Discord roles. Open a branch to see its ranks."
    />

    <nav v-if="devScenes" class="rs-dev-scenes" aria-label="Fixture scenes (dev only)">
      <a v-for="scene in devScenes" :key="scene" :href="`?scene=${scene}`">{{ scene }}</a>
    </nav>

    <p v-if="store.status === 'loading'" class="rs-note">Loading the roster…</p>
    <div v-else-if="store.status === 'signin'" class="rs-note">
      <p>Sign in with Discord to see the roster.</p>
      <button type="button" class="rs-signin btn-drake" @click="auth.signIn()">Sign in with Discord</button>
    </div>
    <p v-else-if="store.status === 'denied'" class="rs-note" role="alert">{{ store.message }}</p>
    <p v-else-if="store.status === 'error' && !store.roster" class="rs-note" role="alert">The roster could not be loaded. Try again shortly.</p>

    <template v-if="store.roster && view">
      <p v-if="store.status === 'error'" class="rs-note" role="alert">The roster could not be refreshed. Showing the last copy.</p>

      <RosterStatus
        :summary="view.summary"
        :updated="updated"
        :stale="store.roster.stale"
        :openable="openableKeys.length > 0"
        :all-open="allOpen"
        :can-infirmary="store.roster.viewer.infirmary"
        :infirmary-open="showInfirmary"
        :message="findMessage"
        @find="findMe"
        @toggle-all="toggleAll"
        @toggle-infirmary="toggleInfirmary"
        @jump="jumpTo"
      />

      <RosterInfirmary v-if="showInfirmary" :status="store.infirmaryStatus" :infirmary="store.infirmary" />

      <template v-else>
        <RosterBanner :banner="view.banner" />

        <div class="rs-order">
          <div class="rs-branches">
            <RosterBranch
              v-for="b in view.branches"
              :key="b.key"
              :branch="b"
              :open="b.openable && open.isOpen(b.key)"
              @toggle="open.toggle(b.key)"
            />
          </div>
          <RosterBranch
            v-if="view.unassigned"
            :branch="view.unassigned"
            variant="unassigned"
            :open="open.isOpen('unassigned')"
            @toggle="open.toggle('unassigned')"
          />
        </div>

        <section v-if="view.servitors.length" class="rs-servitors" aria-label="Servitors">
          <h2>Servitors</h2>
          <ul class="rs-servitor-list">
            <RosterMember v-for="m in view.servitors" :key="m.id" :member="m" />
          </ul>
        </section>
      </template>
    </template>
  </section>
</template>

<style scoped>
.roster {
  max-width: 72rem;
  margin: 0 auto;
  padding: 3rem 1.5rem 5rem;
}
.rs-note {
  margin-top: 1.4rem;
  color: var(--color-smoke);
}
.rs-signin {
  padding: 0.55rem 0.95rem;
  min-height: 44px;
  cursor: pointer;
}
.rs-dev-scenes {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 0.9rem;
  margin-top: 1rem;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--color-smoke);
}
.rs-dev-scenes a:hover {
  color: var(--color-drake);
}

.rs-order {
  display: grid;
  gap: 0.55rem;
  margin-top: 2.2rem;
}
.rs-branches {
  display: grid;
  gap: 0.55rem;
}

.rs-servitors {
  margin-top: 2.6rem;
  padding-top: 1.2rem;
  border-top: 1px solid var(--color-ash);
}
.rs-servitors h2 {
  margin: 0 0 0.8rem;
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 0.9rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--color-smoke);
}
.rs-servitor-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.38rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.rs-servitor-list .rs-member {
  filter: grayscale(1);
  opacity: 0.78;
}

@media (max-width: 760px) {
  .roster {
    padding: 2rem 1rem 4rem;
  }
}
</style>
