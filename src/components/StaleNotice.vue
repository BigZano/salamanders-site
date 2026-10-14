<script setup>
import { computed } from 'vue'
import migrations from '../data/perk-migrations.json'

const props = defineProps({ notices: { type: Array, default: () => [] } })
defineEmits(['dismiss'])

const replaced = computed(() => props.notices.filter((n) => n.kind === 'replaced').length)
const noun = (n) => `${n} perk${n === 1 ? '' : 's'}`
const heading = computed(() =>
  replaced.value
    ? `Patch ${migrations.patch} rework: re-pick ${noun(replaced.value)}`
    : `Patch ${migrations.patch} rework: review ${noun(props.notices.length)}`,
)
const where = (n) => (n.level === null ? 'Prestige' : `Level ${n.level}`)
</script>

<template>
  <aside v-if="notices.length" class="stale-notice" role="status">
    <div class="stale-top">
      <h2 class="stale-head">{{ heading }}</h2>
      <button type="button" class="stale-dismiss" @click="$emit('dismiss')">Dismiss</button>
    </div>
    <p class="stale-lead">
      This build was made before the patch changed some perks. The ones that no longer exist were
      removed along with their notes.
    </p>
    <ul class="stale-list">
      <li v-for="(n, i) in notices" :key="i" class="stale-item">
        <span class="stale-where">{{ where(n) }}</span>
        <template v-if="n.kind === 'replaced'">
          <span class="stale-was">{{ n.was }}</span>
          <span class="stale-arrow" aria-hidden="true">→</span>
          <span class="stale-now">{{ n.now }}</span>
        </template>
        <template v-else>
          <span class="stale-was">{{ n.was }}</span>
          <span class="stale-rework">was reworked</span>
        </template>
        <span v-if="n.note" class="stale-note">{{ n.note }}</span>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.stale-notice {
  margin: 0 0 1.4rem;
  padding: 1rem 1.2rem;
  border: 1px solid rgba(255, 106, 43, 0.45);
  border-left-width: 3px;
  border-radius: 4px;
  background: rgba(255, 106, 43, 0.07);
}
.stale-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.stale-head {
  margin: 0;
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-size: 1.05rem;
  color: var(--color-ember);
}
.stale-dismiss {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.8rem;
  color: var(--color-smoke);
  background: transparent;
  border: 1px solid var(--color-ash);
  border-radius: 2px;
  padding: 0.3rem 0.7rem;
  cursor: pointer;
}
.stale-dismiss:hover {
  color: var(--color-bone);
}
.stale-lead {
  margin: 0.5rem 0 0.7rem;
  font-family: var(--font-sans);
  font-size: 0.9rem;
  color: var(--color-smoke);
}
.stale-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.3rem;
}
.stale-item {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.2rem 0.6rem;
  font-family: var(--font-sans);
  font-size: 0.9rem;
  color: var(--color-bone);
}
.stale-where {
  min-width: 4.5rem;
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-size: 0.75rem;
  color: var(--color-smoke);
}
.stale-was {
  text-decoration: line-through;
  text-decoration-color: rgba(255, 106, 43, 0.6);
  color: var(--color-smoke);
}
.stale-rework {
  color: var(--color-gold);
}
.stale-arrow {
  color: var(--color-smoke);
}
.stale-now {
  color: var(--color-drake);
}
.stale-note {
  flex-basis: 100%;
  padding-left: 5.1rem;
  font-size: 0.8rem;
  color: var(--color-smoke);
}
@media (max-width: 36rem) {
  .stale-note {
    padding-left: 0;
  }
}
</style>
