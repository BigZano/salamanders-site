<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { usePlanner, CLASS_NAMES } from '../stores/planner'
import { useAuth } from '../stores/auth'
import * as buildsApi from '../lib/buildsApi'
import { canDeleteBuild } from '../lib/permissions'
import { splitByMembership, paginate } from '../lib/buildGroups'
import discordMembers from '../data/discord-members.json'
import BuildCard from '../components/BuildCard.vue'
import BuildsPager from '../components/BuildsPager.vue'

const planner = usePlanner()
const auth = useAuth()
const router = useRouter()

const builds = ref([])
const loading = ref(true)
const loadError = ref('')

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    builds.value = await buildsApi.listBuilds()
  } catch (err) {
    loadError.value = err.message || 'Could not reach the builds server.'
  } finally {
    loading.value = false
  }
}
onMounted(load)

const query = ref('')
const classFilter = ref('')

/** Everything a build is made of is searchable: name, role, notes, perks, weapons. */
function haystack(b) {
  return [
    b.title,
    b.role,
    b.notes,
    b.className,
    ...(b.perks || []),
    ...(b.prestigePicks || []),
    ...Object.values(b.weapons || {}),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return builds.value.filter(
    (b) =>
      (!classFilter.value || b.className === classFilter.value) &&
      (!q || haystack(b).includes(q)),
  )
})

// Only offer class chips for classes the gallery actually contains.
const usedClasses = computed(() =>
  CLASS_NAMES.filter((c) => builds.value.some((b) => b.className === c)),
)

// Verified members first, everyone else below — see src/lib/buildGroups.js.
const groups = computed(() => splitByMembership(filtered.value, discordMembers.memberIds))
const memberPage = ref(1)
const otherPage = ref(1)
// A new search/filter reshuffles which builds exist at all — stale page
// numbers from the previous result set would otherwise point at the wrong
// (or a now-nonexistent) page.
watch(filtered, () => {
  memberPage.value = 1
  otherPage.value = 1
})
const memberPaged = computed(() => paginate(groups.value.member, memberPage.value))
const otherPaged = computed(() => paginate(groups.value.other, otherPage.value))

const toast = ref('')
let t
function flash(m) {
  toast.value = m
  clearTimeout(t)
  t = setTimeout(() => (toast.value = ''), 1800)
}

function apply(build) {
  planner.applyBuildData(build)
  router.push('/planner')
}

const deleting = ref(null)
async function remove(b) {
  if (deleting.value) return
  deleting.value = b.id
  try {
    await buildsApi.deleteBuild(b.id, auth.token)
    builds.value = builds.value.filter((x) => x.id !== b.id)
    flash(`Deleted “${b.title}”`)
  } catch (err) {
    flash(err.message || 'Could not delete that build')
  } finally {
    deleting.value = null
  }
}
</script>

<template>
  <section class="builds">
    <header class="b-head">
      <p class="eyebrow">Field-tested</p>
      <h1 class="b-title">Recommended Builds</h1>
      <p class="b-intro">
        Builds the Chapter has posted. Make one in the
        <RouterLink to="/planner" class="ilink">Perk Builder</RouterLink> and save it from
        the Your Build panel — sign in with Discord first so it's tied to your name.
      </p>
    </header>

    <p v-if="loading" class="b-none">Loading builds…</p>
    <p v-else-if="loadError" class="b-none b-error">{{ loadError }}</p>

    <!-- Search + filter -->
    <div v-if="!loading && !loadError && builds.length" class="b-tools">
      <input
        v-model="query"
        class="b-search"
        type="search"
        placeholder="Search builds, perks, weapons, notes…"
        aria-label="Search builds"
      />
      <div class="b-filters" role="group" aria-label="Filter by class">
        <button
          class="b-chip"
          :class="{ on: !classFilter }"
          @click="classFilter = ''"
        >
          All
          <span class="b-chip-n">{{ builds.length }}</span>
        </button>
        <button
          v-for="c in usedClasses"
          :key="c"
          class="b-chip"
          :class="{ on: classFilter === c }"
          @click="classFilter = classFilter === c ? '' : c"
        >
          {{ c }}
          <span class="b-chip-n">
            {{ builds.filter((b) => b.className === c).length }}
          </span>
        </button>
      </div>
    </div>

    <p v-if="!loading && builds.length && !filtered.length" class="b-none">
      No builds match that search.
    </p>

    <!-- Verified members' builds, first and badged -->
    <section v-if="groups.member.length" class="b-section">
      <h2 class="b-section-title">Verified Members</h2>
      <div class="b-grid">
        <BuildCard
          v-for="r in memberPaged.items"
          :key="r.id"
          :build="r"
          show-badge
          :can-delete="canDeleteBuild(auth.member, r)"
          :deleting="deleting === r.id"
          @open="apply"
          @remove="remove"
        />
      </div>
      <BuildsPager v-model:page="memberPage" :page-count="memberPaged.pageCount" />
    </section>

    <!-- Everyone else -->
    <section v-if="groups.other.length" class="b-section">
      <h2 class="b-section-title">Community Builds</h2>
      <div class="b-grid">
        <BuildCard
          v-for="r in otherPaged.items"
          :key="r.id"
          :build="r"
          :can-delete="canDeleteBuild(auth.member, r)"
          :deleting="deleting === r.id"
          @open="apply"
          @remove="remove"
        />
      </div>
      <BuildsPager v-model:page="otherPage" :page-count="otherPaged.pageCount" />
    </section>

    <!-- Empty state -->
    <div v-if="!loading && !loadError && !builds.length" class="b-empty panel-forge">
      <div class="b-empty-mark" aria-hidden="true"><span /><span /><span /></div>
      <h2 class="b-empty-title">No builds posted yet</h2>
      <p class="b-empty-body">
        Build a loadout in the Perk Builder, then hit Save to library in the Your Build
        panel. Sign in with Discord to post — everyone sees it here.
      </p>
      <RouterLink to="/planner" class="btn-ember b-empty-cta">Open the Perk Builder</RouterLink>
    </div>

    <transition name="toast">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </transition>
  </section>
</template>

<style scoped>
.builds {
  max-width: 68rem;
  margin: 0 auto;
  padding: 4rem 1.5rem 2rem;
}
.b-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: clamp(2.2rem, 7vw, 3.6rem);
  color: var(--color-bone);
  margin: 0.4rem 0 0.6rem;
}
.b-intro {
  color: var(--color-smoke);
  max-width: 58ch;
  line-height: 1.6;
}
.ilink {
  color: var(--color-drake);
  border-bottom: 1px solid rgba(89, 214, 108, 0.4);
}

/* search + filter */
.b-tools {
  margin: 2rem 0 1.4rem;
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}
.b-search {
  width: 100%;
  max-width: 28rem;
  padding: 0.65rem 0.9rem;
  background: rgba(14, 28, 22, 0.6);
  border: 1px solid var(--color-ash);
  border-radius: 3px;
  color: var(--color-bone);
  font-size: 0.92rem;
}
.b-search::placeholder {
  color: #5f6f66;
}
.b-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.b-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.76rem;
  color: var(--color-smoke);
  background: rgba(14, 28, 22, 0.5);
  border: 1px solid var(--color-ash);
  border-radius: 2px;
  padding: 0.35rem 0.7rem;
  cursor: pointer;
  transition: 0.12s;
}
.b-chip:hover {
  color: var(--color-bone);
  border-color: var(--color-ash-2);
}
.b-chip.on {
  color: #1a0d06;
  background: linear-gradient(180deg, #ffb066, #ff6a2b);
  border-color: rgba(255, 176, 102, 0.6);
}
.b-chip-n {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  opacity: 0.75;
}
.b-none {
  color: var(--color-smoke);
  padding: 1.5rem 0;
}
.b-error {
  color: var(--color-ember);
}

/* sections + grid */
.b-section {
  margin-top: 2.2rem;
}
.b-section:first-of-type {
  margin-top: 0.5rem;
}
.b-section-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 700;
  font-size: 1rem;
  color: var(--color-smoke);
  border-bottom: 1px solid var(--color-ash);
  padding-bottom: 0.5rem;
  margin-bottom: 1rem;
}
.b-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
  gap: 1rem;
}

/* empty */
.b-empty {
  margin-top: 0.5rem;
  border-radius: 8px;
  padding: 3rem 1.5rem;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.b-empty-mark {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1.4rem;
}
.b-empty-mark span {
  width: 9px;
  height: 9px;
  transform: rotate(45deg);
  background: linear-gradient(180deg, #ffb066, #ff6a2b);
  box-shadow: 0 0 12px rgba(255, 106, 43, 0.6);
  opacity: 0.5;
}
.b-empty-mark span:nth-child(2) {
  opacity: 1;
}
.b-empty-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: 1.5rem;
  color: var(--color-bone);
}
.b-empty-body {
  color: var(--color-smoke);
  max-width: 44ch;
  line-height: 1.6;
  margin: 0.6rem 0 1.6rem;
}
.b-empty-cta {
  padding: 0.85rem 1.5rem;
  border-radius: 2px;
}

.toast {
  position: fixed;
  bottom: 1.4rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 80;
  background: rgba(5, 10, 8, 0.92);
  border: 1px solid var(--color-drake);
  color: var(--color-bone);
  padding: 0.6rem 1.1rem;
  border-radius: 3px;
  font-size: 0.85rem;
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}
</style>
