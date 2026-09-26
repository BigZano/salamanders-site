<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useAuth } from '../stores/auth'
import * as api from '../lib/reportsApi'
import { prefillUrl } from '../lib/reportPrefill'

const auth = useAuth()
const access = ref(null) // {reporter, reviewer, admin} once known
const error = ref('')
const mine = ref([])

const blank = () => ({ reportedMember: '', incidentDate: '', medium: '', mediumOther: '', witnesses: '', description: '' })
const form = reactive(blank())
const involvesReclusiarch = ref(false)
const sending = ref(false)
const sent = ref(null)

async function load() {
  error.value = ''
  if (!auth.token) return
  try {
    access.value = await api.getAccess(auth.token)
    if (access.value.reporter) mine.value = await api.listMine(auth.token)
  } catch (err) {
    error.value = err.message || 'Could not reach the reports server.'
  }
}
onMounted(load)

// Bypass: the member files the official form themselves; nothing stored here.
const officialLink = computed(() => prefillUrl(form, { filer: auth.member?.username }))

async function submit() {
  if (sending.value) return
  sending.value = true
  error.value = ''
  try {
    const { id } = await api.fileReport({ ...form }, auth.token)
    sent.value = id
    Object.assign(form, blank())
    mine.value = await api.listMine(auth.token)
  } catch (err) {
    error.value = err.message || 'Could not file the report.'
  } finally {
    sending.value = false
  }
}

const fmt = (d) => new Date(d).toLocaleDateString()
</script>

<template>
  <section class="reports">
    <header>
      <p class="eyebrow">Reclusiam</p>
      <h1 class="r-title">File a Report</h1>
      <p class="r-intro">
        Report conduct that breaks the Chapter's code. A Reclusiarch reviews every report and either deals
        with it or escalates it to High Command. You'll see its status below. Your name goes with the report.
      </p>
    </header>

    <div v-if="!auth.signedIn || !auth.token" class="panel-forge r-gate">
      <p>Sign in with Discord to file a report.</p>
      <button class="btn-ember" @click="auth.signIn()">Sign in with Discord</button>
    </div>

    <p v-else-if="error" class="r-error" role="alert">{{ error }}</p>
    <p v-else-if="!access" class="r-muted">Checking your roles…</p>

    <div v-else-if="!access.reporter" class="panel-forge r-gate">
      <p>Reports are open to XVIIIth Legion members.</p>
    </div>

    <template v-if="access?.reporter">
      <RouterLink v-if="access.reviewer || access.admin" to="/reports/review" class="ilink r-review-link">
        Open the review queue →
      </RouterLink>

      <p v-if="sent" class="r-sent" role="status">Report #{{ sent }} filed. A Reclusiarch has been notified.</p>

      <form class="panel-forge r-form" @submit.prevent="submit">
        <label>Member being reported <span class="req">*</span>
          <input v-model="form.reportedMember" maxlength="200" required />
        </label>
        <label>When did it happen?
          <input v-model="form.incidentDate" type="date" />
        </label>
        <label>Where did it happen? <span class="req">*</span>
          <select v-model="form.medium" required>
            <option value="" disabled>Choose…</option>
            <option value="text">Discord text channel</option>
            <option value="voice">Discord voice channel</option>
            <option value="dm">Discord direct message</option>
            <option value="other">Somewhere else</option>
          </select>
        </label>
        <label v-if="form.medium === 'other'">Where? <span class="req">*</span>
          <input v-model="form.mediumOther" maxlength="200" required />
        </label>
        <label>Anyone else present?
          <input v-model="form.witnesses" maxlength="1000" placeholder="Names, if it was a private interaction" />
        </label>
        <label>What happened? <span class="req">*</span>
          <textarea v-model="form.description" rows="7" maxlength="4000" required />
        </label>

        <label class="r-check">
          <input v-model="involvesReclusiarch" type="checkbox" />
          This involves a Reclusiarch
        </label>

        <div v-if="involvesReclusiarch" class="r-bypass">
          <p>
            Reports involving a Reclusiarch go straight to High Command's official form. Nothing is saved here.
            The form opens pre-filled with what you've written; check it and submit it there.
          </p>
          <a class="btn-ember" :href="officialLink" target="_blank" rel="noopener">Open the official form</a>
        </div>
        <button v-else class="btn-ember" type="submit" :disabled="sending">
          {{ sending ? 'Filing…' : 'File report' }}
        </button>
      </form>

      <section v-if="mine.length" class="r-mine">
        <h2 class="r-h2">My reports</h2>
        <ul>
          <li v-for="r in mine" :key="r.id" class="panel-forge r-row">
            <span>#{{ r.id }} · {{ r.reportedMember }}</span>
            <span class="r-muted">{{ fmt(r.createdAt) }}</span>
            <span class="r-status" :data-status="r.status">{{ api.STATUS_LABELS[r.status] }}</span>
          </li>
        </ul>
      </section>
    </template>
  </section>
</template>

<style scoped>
.reports {
  max-width: 48rem;
  margin: 0 auto;
  padding: 4rem 1.5rem 2rem;
}
.r-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: clamp(2rem, 6vw, 3.2rem);
  color: var(--color-bone);
  margin: 0.4rem 0 0.6rem;
}
.r-intro,
.r-muted {
  color: var(--color-smoke);
  line-height: 1.6;
}
.r-gate,
.r-form {
  margin-top: 1.6rem;
  padding: 1.4rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  align-items: flex-start;
}
.r-form label {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  width: 100%;
  color: var(--color-bone);
  font-size: 0.9rem;
}
.r-form input:not([type='checkbox']),
.r-form select,
.r-form textarea {
  width: 100%;
  padding: 0.6rem 0.8rem;
  background: rgba(14, 28, 22, 0.6);
  border: 1px solid var(--color-ash);
  border-radius: 3px;
  color: var(--color-bone);
  font: inherit;
}
.r-form label.r-check {
  flex-direction: row;
  align-items: center;
  gap: 0.5rem;
}
.req {
  color: var(--color-ember, #e0643a);
}
.r-bypass {
  border-left: 3px solid var(--color-ember, #e0643a);
  padding-left: 1rem;
  color: var(--color-smoke);
  line-height: 1.6;
}
.r-bypass p {
  margin: 0 0 0.8rem;
}
.r-error {
  margin-top: 1.4rem;
  color: #ff8f7a;
}
.r-sent {
  margin-top: 1.4rem;
  color: var(--color-drake);
}
.ilink {
  color: var(--color-drake);
  border-bottom: 1px solid rgba(89, 214, 108, 0.4);
}
.r-review-link {
  display: inline-block;
  margin-top: 1.4rem;
}
.r-h2 {
  font-family: var(--font-display);
  text-transform: uppercase;
  color: var(--color-bone);
  font-size: 1.1rem;
  margin: 2.4rem 0 0.8rem;
}
.r-mine ul {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.r-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 1rem;
  align-items: center;
  padding: 0.7rem 1rem;
}
.r-row > :first-child {
  flex: 1;
  color: var(--color-bone);
}
.r-status {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-size: 0.75rem;
  color: var(--color-smoke);
}
.r-status[data-status='resolved'] {
  color: var(--color-drake);
}
.r-status[data-status='escalated'] {
  color: var(--color-ember, #e0643a);
}
</style>
