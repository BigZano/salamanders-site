<script setup>
import { ref, computed, onMounted } from 'vue'
import { useAuth } from '../stores/auth'
import * as api from '../lib/reportsApi'
import { prefillUrl, MEDIUM_LABELS } from '../lib/reportPrefill'

const auth = useAuth()
const access = ref(null)
const reports = ref([])
const error = ref('')
const filter = ref('open')
const selected = ref(null) // full report with events
const note = ref('')
const followUp = ref('Yes')
const formOpened = ref(false) // escalation step 1 done
const busy = ref(false)

async function load() {
  error.value = ''
  if (!auth.token) return
  try {
    access.value = await api.getAccess(auth.token)
    if (access.value.reviewer || access.value.admin) reports.value = await api.listAll(auth.token)
  } catch (err) {
    error.value = err.message || 'Could not reach the reports server.'
  }
}
onMounted(load)

const OPEN = ['received', 'under_review']
const shown = computed(() =>
  reports.value.filter((r) =>
    filter.value === 'open' ? OPEN.includes(r.status) : filter.value === 'mine' ? r.handler?.id === auth.member?.id : true,
  ),
)

async function open(r) {
  note.value = ''
  followUp.value = 'Yes'
  formOpened.value = false
  try {
    selected.value = await api.getReport(r.id, auth.token)
  } catch (err) {
    error.value = err.message
  }
}

async function act(action) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const updated = await api.act(selected.value.id, action, note.value.trim(), auth.token)
    selected.value = updated
    reports.value = reports.value.map((r) => (r.id === updated.id ? updated : r))
    note.value = ''
    formOpened.value = false
  } catch (err) {
    error.value = err.message || 'That did not go through.'
  } finally {
    busy.value = false
  }
}

const escalateLink = computed(() =>
  selected.value && prefillUrl(selected.value, { filer: auth.member?.username, followUp: followUp.value, note: note.value.trim() }),
)
const where = (r) => (r.medium === 'other' ? r.mediumOther : MEDIUM_LABELS[r.medium])
const when = (d) => new Date(d).toLocaleString()
</script>

<template>
  <section class="review">
    <header>
      <p class="eyebrow">Reclusiam</p>
      <h1 class="rv-title">Report Review</h1>
    </header>

    <div v-if="!auth.signedIn || !auth.token" class="panel-forge rv-pad">
      <p>Sign in with Discord to review reports.</p>
      <button class="btn-ember" @click="auth.signIn()">Sign in with Discord</button>
    </div>
    <p v-else-if="!access && !error" class="rv-muted">Checking your roles…</p>
    <div v-else-if="access && !access.reviewer && !access.admin" class="panel-forge rv-pad">
      <p>Restricted to Reclusiarchs.</p>
    </div>

    <p v-if="error" class="rv-error" role="alert">{{ error }}</p>

    <template v-if="access && (access.reviewer || access.admin)">
      <p v-if="!access.reviewer" class="rv-muted">Administrator view: read-only. Reclusiarchs act on reports.</p>

      <div class="rv-filters">
        <button v-for="f in ['open', 'mine', 'all']" :key="f" class="rv-chip" :class="{ on: filter === f }" @click="filter = f">
          {{ f }}
        </button>
      </div>

      <div class="rv-layout">
        <ul class="rv-list">
          <li v-if="!shown.length" class="rv-muted">Nothing here.</li>
          <li v-for="r in shown" :key="r.id">
            <button class="panel-forge rv-item" :class="{ on: selected?.id === r.id }" @click="open(r)">
              <strong>#{{ r.id }} · {{ r.reportedMember }}</strong>
              <span class="rv-muted">{{ r.reporter.username }} · {{ when(r.createdAt) }}</span>
              <span class="rv-status" :data-status="r.status">
                {{ api.STATUS_LABELS[r.status] }}<template v-if="r.handler"> · {{ r.handler.username }}</template>
              </span>
            </button>
          </li>
        </ul>

        <article v-if="selected" class="panel-forge rv-detail">
          <h2>#{{ selected.id }} · {{ selected.reportedMember }}</h2>
          <dl>
            <dt>Status</dt><dd>{{ api.STATUS_LABELS[selected.status] }}</dd>
            <dt>Reported by</dt><dd>{{ selected.reporter.username }}</dd>
            <dt>When</dt><dd>{{ selected.incidentDate || 'Not given' }}</dd>
            <dt>Where</dt><dd>{{ where(selected) }}</dd>
            <dt>Others present</dt><dd>{{ selected.witnesses || 'None given' }}</dd>
          </dl>
          <p class="rv-desc">{{ selected.description }}</p>
          <p v-if="selected.resolutionNote" class="rv-note"><strong>Reclusiarch note:</strong> {{ selected.resolutionNote }}</p>

          <!-- Reclusiarch actions -->
          <div v-if="access.reviewer && selected.status === 'received'" class="rv-actions">
            <button class="btn-ember" :disabled="busy" @click="act('claim')">Claim</button>
          </div>

          <div v-if="access.reviewer && selected.status === 'under_review'" class="rv-actions">
            <label>Notes (required to resolve; added to the official form on escalation)
              <textarea v-model="note" rows="4" maxlength="4000" />
            </label>
            <button class="btn-drake" :disabled="busy || !note.trim()" @click="act('resolve')">Resolve</button>

            <div class="rv-escalate">
              <label>Follow-up with those involved?
                <select v-model="followUp"><option>Yes</option><option>No</option></select>
              </label>
              <a class="btn-ember" :href="escalateLink" target="_blank" rel="noopener" @click="formOpened = true">
                1. Open official form (pre-filled)
              </a>
              <button class="btn-ember" :disabled="busy || !formOpened" @click="act('escalate')">
                2. I submitted it: mark escalated
              </button>
            </div>
          </div>

          <!-- Admin failsafe -->
          <div v-if="access.admin && ['resolved', 'escalated'].includes(selected.status)" class="rv-actions">
            <label>Reason to reopen (failsafe)
              <textarea v-model="note" rows="2" maxlength="4000" />
            </label>
            <button class="btn-ember" :disabled="busy || !note.trim()" @click="act('reopen')">Reopen</button>
          </div>

          <h3>History</h3>
          <ol class="rv-events">
            <li v-for="(e, i) in selected.events" :key="i">
              <span class="rv-muted">{{ when(e.createdAt) }}</span> {{ e.actor.username }} {{ e.action }}
              <template v-if="e.note">: “{{ e.note }}”</template>
            </li>
          </ol>
        </article>
      </div>
    </template>
  </section>
</template>

<style scoped>
.review {
  max-width: 72rem;
  margin: 0 auto;
  padding: 4rem 1.5rem 2rem;
}
.rv-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: clamp(2rem, 6vw, 3.2rem);
  color: var(--color-bone);
  margin: 0.4rem 0 1rem;
}
.rv-muted {
  color: var(--color-smoke);
}
.rv-error {
  color: #ff8f7a;
}
.rv-pad {
  padding: 1.4rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  align-items: flex-start;
}
.rv-filters {
  display: flex;
  gap: 0.35rem;
  margin: 1rem 0;
}
.rv-chip {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.76rem;
  color: var(--color-smoke);
  background: rgba(14, 28, 22, 0.5);
  border: 1px solid var(--color-ash);
  border-radius: 999px;
  padding: 0.35rem 0.8rem;
  cursor: pointer;
}
.rv-chip.on {
  color: var(--color-bone);
  border-color: var(--color-drake);
}
.rv-layout {
  display: grid;
  grid-template-columns: minmax(0, 20rem) minmax(0, 1fr);
  gap: 1rem;
  align-items: start;
}
@media (max-width: 760px) {
  .rv-layout {
    grid-template-columns: 1fr;
  }
}
.rv-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.rv-item {
  width: 100%;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.7rem 0.9rem;
  color: var(--color-bone);
  cursor: pointer;
  border: 1px solid transparent;
}
.rv-item.on {
  border-color: var(--color-drake);
}
.rv-status {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-size: 0.72rem;
  color: var(--color-smoke);
}
.rv-status[data-status='received'] {
  color: var(--color-gold);
}
.rv-status[data-status='escalated'] {
  color: var(--color-ember);
}
.rv-status[data-status='resolved'] {
  color: var(--color-drake);
}
.rv-detail {
  padding: 1.4rem;
  color: var(--color-bone);
  min-width: 0;
}
.rv-detail h2 {
  font-family: var(--font-display);
  text-transform: uppercase;
  margin: 0 0 1rem;
}
.rv-detail h3 {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-size: 0.9rem;
  margin: 1.6rem 0 0.5rem;
}
.rv-detail dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.3rem 1rem;
  margin: 0;
}
.rv-detail dt {
  color: var(--color-smoke);
}
.rv-detail dd {
  margin: 0;
}
.rv-desc,
.rv-note {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.6;
}
.rv-actions {
  margin-top: 1.2rem;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  align-items: flex-start;
}
.rv-actions label {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  width: 100%;
  font-size: 0.9rem;
}
.rv-actions textarea,
.rv-actions select {
  width: 100%;
  padding: 0.6rem 0.8rem;
  background: rgba(14, 28, 22, 0.6);
  border: 1px solid var(--color-ash);
  border-radius: 3px;
  color: var(--color-bone);
  font: inherit;
}
.rv-escalate {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  align-items: flex-start;
  width: 100%;
  border-top: 1px solid var(--color-ash);
  padding-top: 0.8rem;
}
.rv-events {
  padding-left: 1.2rem;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
</style>
