<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useAuth } from '../stores/auth'
import { usePerkCorrections } from '../stores/perkCorrections'
import * as api from '../lib/perksApi'
import { historyLabel } from '../lib/historyLabels'

// Version History: every perk correction, soft-deleted build and privilege
// change, newest first. The server decides who sees it; this page only
// hides what the caller can't use.
const auth = useAuth()
const corrections = usePerkCorrections()
const FILTERS = [
  { key: null, label: 'All' },
  { key: 'perk_correction', label: 'Perks' },
  { key: 'build', label: 'Builds' },
  { key: 'privilege', label: 'Privileges' },
]
const subject = ref(null)
const q = ref('')
const events = ref([])
const next = ref(null)
const revocations = ref([])
const error = ref('')
const openId = ref(null)
const revoking = ref(null) // event whose actor is being revoked
const reason = ref('')
const busy = ref(false)
const loading = ref(false)

let seq = 0
let t

const canRevoke = computed(() => !!corrections.privileges?.revoker)
// The server's idea of who the caller is wins; the stored member is a fallback.
const me = computed(() => corrections.privileges?.id ?? auth.member?.id)

async function load(more = false) {
  error.value = ''
  if (!auth.token) return
  const mine = ++seq
  loading.value = true
  try {
    const page = await api.getHistory({ subject: subject.value, q: q.value.trim(), before: more ? next.value : null }, auth.token)
    if (mine !== seq) return
    events.value = more ? [...events.value, ...page.events] : page.events
    next.value = page.next
    revocations.value = page.revocations
  } catch (err) {
    if (mine !== seq) return
    error.value = err.status === 403 ? 'Version History is restricted to the forge and Legion leadership.' : err.message
  } finally {
    if (mine === seq) loading.value = false
  }
}
onMounted(() => load())
onBeforeUnmount(() => clearTimeout(t))
watch(subject, () => load())
watch(q, () => {
  clearTimeout(t)
  t = setTimeout(() => load(), 300)
})
watch(() => auth.member?.id, () => load())

async function run(fn) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await fn()
    await load()
  } catch (err) {
    error.value = err.message || 'That did not go through.'
  } finally {
    busy.value = false
  }
}
const revert = (e) => run(() => corrections.revert(Number(e.subjectId), null, auth.token))
const revoke = () =>
  run(async () => {
    await api.revokePrivileges(revoking.value.actor.id, { reason: reason.value.trim(), username: revoking.value.actor.username }, auth.token)
    revoking.value = null
    reason.value = ''
  })
const reinstate = (r) => run(() => api.reinstatePrivileges(r.discordId, null, auth.token))
const when = (d) => new Date(d).toLocaleString()
</script>

<template>
  <section class="hist">
    <header class="hist-head">
      <p class="eyebrow">The Forge</p>
      <h1 class="hist-title">Version History</h1>
      <p class="hist-intro">Every perk correction, deleted build and privilege change. Nothing here is ever removed.</p>
    </header>

    <p v-if="!auth.signedIn" class="hist-empty">Sign in with Discord to view the history.</p>
    <template v-else>
      <div class="hist-tools">
        <button v-for="f in FILTERS" :key="f.label" type="button" class="hist-filter" :class="{ on: subject === f.key }" @click="subject = f.key">
          {{ f.label }}
        </button>
        <input v-model="q" type="search" class="hist-search" maxlength="80" placeholder="Weapon, class, perk or build…" aria-label="Search history" />
      </div>

      <p v-if="error" class="hist-error" role="alert">{{ error }}</p>

      <section v-if="canRevoke && revocations.length" class="hist-revoked">
        <h2>Revoked privileges</h2>
        <ul>
          <li v-for="r in revocations" :key="r.id">
            <strong>{{ r.username }}</strong> — {{ r.reason }} <span class="hist-meta">by {{ r.revokedBy.username }}, {{ when(r.createdAt) }}</span>
            <button type="button" :disabled="busy" @click="reinstate(r)">Reinstate</button>
          </li>
        </ul>
      </section>

      <ol class="hist-list">
        <li v-for="e in events" :key="e.id" class="hist-item" :data-subject="e.subject">
          <button type="button" class="hist-line" :aria-expanded="openId === e.id" @click="openId = openId === e.id ? null : e.id">
            <span class="hist-when">{{ when(e.createdAt) }}</span>
            <span class="hist-what">{{ historyLabel(e) }}</span>
          </button>
          <div v-if="openId === e.id" class="hist-detail">
            <p v-if="e.note" class="hist-note">Note: {{ e.note }}</p>
            <div v-if="e.snapshot?.before" class="hist-change">
              <p><span class="hist-change-label">Before:</span> {{ e.snapshot.before.description || '—' }}</p>
              <p><span class="hist-change-label">After:</span> {{ e.snapshot.description || 'removed' }}</p>
            </div>
            <pre class="hist-snap">{{ JSON.stringify(e.snapshot, null, 2) }}</pre>
            <div class="hist-actions">
              <button v-if="e.subject === 'perk_correction' && e.action === 'created'" type="button" :disabled="busy" @click="revert(e)">Revert</button>
              <button v-if="canRevoke && e.actor.id !== me && e.actor.id !== '0'" type="button" @click="revoking = e">Revoke {{ e.actor.username }}</button>
            </div>
            <form v-if="revoking?.id === e.id" class="hist-revoke" @submit.prevent="revoke">
              <label :for="`reason-${e.id}`">Reason (required)</label>
              <input :id="`reason-${e.id}`" v-model="reason" maxlength="200" required />
              <button type="submit" :disabled="busy || !reason.trim()">Confirm revoke</button>
              <button type="button" @click="revoking = null">Cancel</button>
            </form>
          </div>
        </li>
      </ol>
      <p v-if="!events.length && !error" class="hist-empty">Nothing yet.</p>
      <button v-if="next" type="button" class="hist-more" :disabled="loading" @click="load(true)">Older</button>
    </template>
  </section>
</template>

<style scoped>
.hist {
  max-width: 60rem;
  margin: 0 auto;
  padding: 2rem 1rem 4rem;
}
.hist-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  color: var(--color-bone);
  font-size: 2rem;
}
.hist-intro,
.hist-empty,
.hist-meta {
  color: var(--color-smoke);
}
.hist-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 1.2rem 0;
}
.hist-filter,
.hist button {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.7rem;
  color: var(--color-bone);
  background: transparent;
  border: 1px solid var(--color-ash);
  border-radius: 2px;
  padding: 0.35rem 0.7rem;
  cursor: pointer;
}
.hist-filter.on {
  border-color: var(--color-ember);
  color: var(--color-ember);
}
.hist-search,
.hist-revoke input {
  flex: 1;
  min-width: 12rem;
  background: rgba(5, 10, 8, 0.7);
  border: 1px solid var(--color-ash);
  color: var(--color-bone);
  border-radius: 2px;
  padding: 0.4rem 0.6rem;
}
.hist-error {
  color: var(--color-ember);
}
.hist-list {
  list-style: none;
  padding: 0;
  display: grid;
  gap: 0.4rem;
}
.hist-item {
  border: 1px solid var(--color-ash);
  border-left: 3px solid var(--color-ash-2);
  border-radius: 5px;
  background: rgba(14, 28, 22, 0.4);
}
.hist-item[data-subject='perk_correction'] {
  border-left-color: var(--color-gold);
}
.hist-item[data-subject='build'] {
  border-left-color: var(--color-drake);
}
.hist-item[data-subject='privilege'] {
  border-left-color: var(--color-ember);
}
.hist .hist-line {
  display: flex;
  gap: 1rem;
  width: 100%;
  text-align: left;
  border: 0;
  text-transform: none;
  letter-spacing: 0;
  font-family: inherit;
  font-size: 0.85rem;
  padding: 0.6rem 0.8rem;
}
.hist-when {
  flex: none;
  color: var(--color-smoke);
  font-family: var(--font-mono);
  font-size: 0.7rem;
}
.hist-detail {
  padding: 0 0.8rem 0.8rem;
}
.hist-change {
  display: grid;
  gap: 0.3rem;
  margin: 0 0 0.6rem;
  font-size: 0.85rem;
}
.hist-change p {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.hist-change-label {
  color: var(--color-smoke);
}
.hist-snap {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.72rem;
  color: #c3d0c6;
  background: rgba(5, 10, 8, 0.6);
  padding: 0.6rem;
  border-radius: 3px;
  max-height: 20rem;
  overflow: auto;
}
.hist-actions,
.hist-revoke {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  margin-top: 0.5rem;
}
.hist-revoked {
  margin-bottom: 1.2rem;
  padding: 0.8rem;
  border: 1px solid var(--color-ember);
  border-radius: 5px;
}
.hist-revoked ul {
  list-style: none;
  padding: 0;
  display: grid;
  gap: 0.4rem;
}
.hist-more {
  margin-top: 1rem;
}
</style>
