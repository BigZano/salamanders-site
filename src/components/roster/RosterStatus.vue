<script setup>
// The line under the page header: how many are on the roll, the gaps leadership
// needs to see (each a link to its first branch), when it was last updated, and
// the page's actions. Props in, events out; the page decides what they do.
defineProps({
  // { total, vacant: string[], acting: string[], mismatch: string[] } (branch keys), from rosterView.js
  summary: { type: Object, required: true },
  updated: { type: String, default: '' },
  stale: { type: Boolean, default: false },
  openable: { type: Boolean, default: false },
  allOpen: { type: Boolean, default: false },
  canInfirmary: { type: Boolean, default: false },
  infirmaryOpen: { type: Boolean, default: false },
  message: { type: String, default: '' },
})
defineEmits(['find', 'toggle-all', 'toggle-infirmary', 'jump'])

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
</script>

<template>
  <div class="rs-status-block">
    <ul class="rs-status">
      <li>{{ summary.total }} on the roll</li>
      <li v-if="summary.vacant.length">
        <button type="button" @click="$emit('jump', summary.vacant[0])">{{ plural(summary.vacant.length, 'vacant post', 'vacant posts') }}</button>
      </li>
      <li v-if="summary.acting.length">
        <button type="button" @click="$emit('jump', summary.acting[0])">{{ plural(summary.acting.length, 'acting head', 'acting heads') }}</button>
      </li>
      <li v-if="summary.mismatch.length">
        <button type="button" @click="$emit('jump', summary.mismatch[0])">
          {{ plural(summary.mismatch.length, 'branch with a name to check', 'branches with names to check') }}
        </button>
      </li>
      <li class="rs-meta">Updated {{ updated }}<template v-if="stale"> · out of date</template></li>
    </ul>

    <div class="rs-actions">
      <button type="button" class="rs-btn rs-find" @click="$emit('find')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
          <circle cx="8" cy="8" r="4.2" />
          <path d="M8 0.8v3M8 12.2v3M0.8 8h3M12.2 8h3" />
        </svg>
        Find me
      </button>
      <button v-if="openable" type="button" class="rs-btn rs-expand-all" @click="$emit('toggle-all')">
        {{ allOpen ? 'Collapse all' : 'Expand all' }}
      </button>
      <span class="rs-spacer" />
      <button v-if="canInfirmary" type="button" class="rs-btn rs-infirmary-toggle" :aria-pressed="infirmaryOpen" @click="$emit('toggle-infirmary')">
        Infirmary
      </button>
    </div>
    <p class="rs-find-msg" role="status">{{ message }}</p>
  </div>
</template>

<style scoped>
.rs-status {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 1.2rem;
  margin: 1.4rem 0 0;
  padding: 0;
  list-style: none;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--color-smoke);
}
.rs-status li + li::before {
  content: '';
  display: inline-block;
  width: 5px;
  height: 5px;
  margin: 0 1.1rem 0.12rem -0.1rem;
  background: var(--color-ash-2);
  transform: rotate(45deg);
}
.rs-status button {
  all: unset;
  cursor: pointer;
  color: var(--color-gold);
  border-bottom: 1px dotted rgba(223, 184, 91, 0.6);
}
.rs-status button:hover {
  color: var(--color-bone);
}
.rs-status button:focus-visible {
  outline: 2px solid var(--color-drake);
  outline-offset: 3px;
}
.rs-meta {
  margin-left: auto;
}

.rs-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.7rem;
  margin-top: 1.4rem;
}
.rs-spacer {
  flex: 1;
}
.rs-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 44px;
  padding: 0.55rem 0.95rem;
  cursor: pointer;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 0.85rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-smoke);
  background: transparent;
  border: 1px solid var(--color-ash-2);
  transition: background 0.2s, border-color 0.2s, color 0.2s;
}
.rs-btn:hover {
  color: var(--color-bone);
  border-color: var(--color-smoke);
}
.rs-btn svg {
  width: 1rem;
  height: 1rem;
}
.rs-find {
  color: var(--color-drake);
  background: rgba(89, 214, 108, 0.06);
  border-color: rgba(89, 214, 108, 0.4);
}
.rs-find:hover {
  color: var(--color-drake);
  background: rgba(89, 214, 108, 0.12);
  border-color: rgba(89, 214, 108, 0.75);
}
.rs-btn[aria-pressed='true'] {
  color: var(--color-bone);
  border-color: var(--color-gold);
}
.rs-find-msg {
  min-height: 1.2rem;
  margin: 0.6rem 0 0;
  font-family: var(--font-mono);
  font-size: 0.76rem;
  color: var(--color-averland);
}
</style>
