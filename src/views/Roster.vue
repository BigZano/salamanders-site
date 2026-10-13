<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAuth } from '../stores/auth'
import { useRoster } from '../stores/roster'
import RosterMember from '../components/roster/RosterMember.vue'
import { SCENES } from '../lib/rosterScenes'
import '../components/roster/roster.css'

// Structure only. The page's visual design is done on the Windows machine
// against src/data/roster.fixture.json; keep the classes and data attributes
// (they are listed in roster.css, which is where the styles go).
const POLL_MS = 60_000
const auth = useAuth()
const store = useRoster()
const showInfirmary = ref(false)
// Dev only, with the fixture on: links that flip the page between its scenes.
const devScenes = import.meta.env.DEV && import.meta.env.VITE_ROSTER_FIXTURE ? SCENES : null
let timer = null

const updated = computed(() => (store.roster ? new Date(store.roster.fetchedAt).toLocaleTimeString() : ''))

function refresh() {
  if (document.hidden) return
  store.load(auth.token)
  if (showInfirmary.value) store.loadInfirmary(auth.token)
}
function toggleInfirmary() {
  showInfirmary.value = !showInfirmary.value
  if (showInfirmary.value) store.loadInfirmary(auth.token)
}

// Signing out on this page resets the store to idle; loading again shows the
// sign-in prompt now instead of a bare heading until the next poll.
watch(() => auth.member, () => store.load(auth.token))

onMounted(() => {
  store.load(auth.token)
  timer = setInterval(refresh, POLL_MS)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <section class="roster" aria-labelledby="roster-title">
    <h1 id="roster-title">Order of Battle</h1>

    <nav v-if="devScenes" class="rs-dev-scenes" aria-label="Fixture scenes (dev only)">
      <a v-for="scene in devScenes" :key="scene" :href="`?scene=${scene}`">{{ scene }}</a>
    </nav>

    <p v-if="store.status === 'loading'">Loading the roster…</p>
    <div v-else-if="store.status === 'signin'">
      <p>Sign in with Discord to see the roster.</p>
      <button type="button" class="rs-signin" @click="auth.signIn()">Sign in with Discord</button>
    </div>
    <p v-else-if="store.status === 'denied'" role="alert">{{ store.message }}</p>
    <p v-else-if="store.status === 'error' && !store.roster" role="alert">The roster could not be loaded. Try again shortly.</p>

    <template v-if="store.roster">
      <p v-if="store.status === 'error'" role="alert">The roster could not be refreshed. Showing the last copy.</p>
      <p class="rs-meta">
        Updated {{ updated }}<span v-if="store.roster.stale"> · out of date</span>
      </p>

      <button v-if="store.roster.viewer.infirmary" type="button" class="rs-infirmary-toggle" :aria-pressed="showInfirmary" @click="toggleInfirmary">
        Infirmary
      </button>

      <div v-if="showInfirmary" class="rs-infirmary">
        <h2>Infirmary</h2>
        <p v-if="store.infirmaryStatus === 'denied'" role="alert">The Infirmary list is open to company command and above.</p>
        <p v-else-if="store.infirmaryStatus === 'error'" role="alert">The Infirmary list could not be loaded.</p>
        <p v-else-if="!store.infirmary">Loading…</p>
        <template v-else>
          <p>{{ store.infirmary.count }} on leave</p>
          <ul>
            <RosterMember v-for="m in store.infirmary.members" :key="m.id" :member="m">
              <span v-if="m.rank" class="rs-rank">{{ m.rank.label }}</span>
              <span v-if="m.legion" class="rs-badge rs-warn">Still holds the Legion role</span>
            </RosterMember>
          </ul>
        </template>
      </div>

      <template v-else>
        <section class="rs-high-command" aria-label="High Command">
          <h2>High Command</h2>
          <div v-for="row in store.roster.highCommand" :key="row.rank.key" class="rs-row" :data-rank="row.rank.key">
            <h3>{{ row.rank.label }}</h3>
            <ul>
              <RosterMember v-for="m in row.members" :key="m.id" :member="m" />
            </ul>
          </div>
        </section>

        <div class="rs-branches">
          <article v-for="b in store.roster.branches" :key="b.key" class="rs-branch" :data-branch="b.key" :data-kind="b.kind">
            <h2>{{ b.label }}</h2>
            <div class="rs-head">
              <h3>{{ b.head.rank.label }}</h3>
              <p v-if="b.head.vacant">Vacant</p>
              <ul v-else>
                <RosterMember v-for="m in b.head.members" :key="m.id" :member="m" />
              </ul>
            </div>
            <div v-if="b.aside.length" class="rs-aside">
              <h3>Honoured Dreadnoughts</h3>
              <ul>
                <RosterMember v-for="m in b.aside" :key="m.id" :member="m" />
              </ul>
            </div>
            <div v-for="row in b.rows" :key="row.rank.key" class="rs-row" :data-rank="row.rank.key" :data-tier="row.rank.tier" :data-lateral="row.rank.lateral ? '' : null">
              <h3>{{ row.rank.label }}</h3>
              <ul>
                <RosterMember v-for="m in row.members" :key="m.id" :member="m" />
              </ul>
            </div>
          </article>
        </div>

        <section v-if="store.roster.unassigned.rows.length" class="rs-unassigned" aria-label="Unassigned">
          <h2>Unassigned</h2>
          <div v-for="row in store.roster.unassigned.rows" :key="row.rank.key" class="rs-row" :data-rank="row.rank.key">
            <h3>{{ row.rank.label }}</h3>
            <ul>
              <RosterMember v-for="m in row.members" :key="m.id" :member="m" />
            </ul>
          </div>
        </section>

        <section v-if="store.roster.servitors.length" class="rs-servitors" aria-label="Servitors">
          <h2>Servitors</h2>
          <ul>
            <RosterMember v-for="m in store.roster.servitors" :key="m.id" :member="m" />
          </ul>
        </section>
      </template>
    </template>
  </section>
</template>
