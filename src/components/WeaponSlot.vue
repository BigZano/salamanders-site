<script setup>
import { ref, computed, watch } from 'vue'
import { usePlanner } from '../stores/planner'
import { WIKI } from '../lib/wiki'
import { resolveWeapon } from '../lib/weapons'
import WeaponTree from './WeaponTree.vue'

/**
 * One weapon slot in the Perk Builder loadout: choose the weapon, then spend its
 * perk points inline. The tree data is the same wiki-backed source the Armoury
 * uses, loaded on demand so picking a weapon stays instant.
 */
const props = defineProps({
  slot: { type: String, required: true }, // primary | secondary | melee
  label: { type: String, required: true },
})

const planner = usePlanner()

const options = computed(() => planner.meta.weapons[props.slot] || [])
const weapon = computed(() => planner.activeWeapons[props.slot] || '')
const spent = computed(() => (weapon.value ? planner.weaponUsed(weapon.value) : 0))

const open = ref(false)
const status = ref('idle') // idle | loading | ready | error
const data = ref(null)

async function load() {
  if (!weapon.value) return
  status.value = 'loading'
  data.value = null
  const resolved = await resolveWeapon(weapon.value)
  data.value = resolved
  status.value = resolved ? 'ready' : 'error'
}

function toggle() {
  open.value = !open.value
  if (open.value && status.value === 'idle') load()
}

// Changing the weapon invalidates whatever tree is on screen.
watch(weapon, () => {
  status.value = 'idle'
  data.value = null
  if (open.value) load()
})

const wikiUrl = computed(() => WIKI + encodeURIComponent(weapon.value))
</script>

<template>
  <div class="slot" :class="{ open, empty: !weapon }">
    <div class="slot-bar">
      <span class="slot-label">{{ label }}</span>

      <select
        class="slot-select"
        :value="weapon"
        :disabled="!options.length"
        :aria-label="label"
        @change="planner.setWeapon(slot, $event.target.value)"
      >
        <option value="">
          {{ options.length ? 'None selected' : `No ${label.toLowerCase()} for this class` }}
        </option>
        <option v-for="w in options" :key="w" :value="w">{{ w }}</option>
      </select>

      <span v-if="weapon" class="slot-pts" :class="{ spent: spent > 0 }">
        {{ spent }} {{ spent === 1 ? 'perk' : 'perks' }}
      </span>

      <button v-if="weapon" class="slot-toggle" :aria-expanded="open" @click="toggle">
        {{ open ? 'Hide tree' : 'Perk tree' }}
        <span class="chev" :class="{ up: open }" aria-hidden="true">▾</span>
      </button>
    </div>

    <div v-if="open && weapon" class="slot-body">
      <div v-if="status === 'loading'" class="slot-msg">
        <span class="spinner" /> Syncing {{ weapon }} from the wiki…
      </div>

      <div v-else-if="status === 'error'" class="slot-msg slot-msg-error">
        <p>No perk tree for {{ weapon }} yet — the wiki page has no readable perk table.</p>
        <a class="slot-wiki" :href="wikiUrl" target="_blank" rel="noopener">Open wiki ↗</a>
      </div>

      <WeaponTree v-else-if="status === 'ready' && data" :weapon="weapon" :data="data" />
    </div>
  </div>
</template>

<style scoped>
.slot {
  border: 1px solid var(--color-ash);
  border-radius: 6px;
  background: rgba(7, 17, 13, 0.45);
}
.slot + .slot {
  margin-top: 0.5rem;
}
.slot.open {
  border-color: var(--color-ash-2);
}
.slot-bar {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  flex-wrap: wrap;
  padding: 0.75rem 0.9rem;
}
.slot-label {
  flex: none;
  min-width: 8.5rem;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.14em;
  font-size: 0.58rem;
  color: var(--color-smoke);
}
.slot-select {
  flex: 1 1 12rem;
  min-width: 0;
  background: rgba(5, 10, 8, 0.7);
  border: 1px solid var(--color-ash);
  color: var(--color-bone);
  border-radius: 2px;
  padding: 0.45rem 0.5rem;
  font-size: 0.88rem;
}
.slot-select:disabled {
  opacity: 0.4;
}
.slot.empty .slot-select {
  color: var(--color-smoke);
}
.slot-pts {
  flex: none;
  font-family: var(--font-mono);
  font-size: 0.62rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-smoke);
  border: 1px solid var(--color-ash);
  border-radius: 2px;
  padding: 2px 6px;
}
.slot-pts.spent {
  color: var(--color-ember);
  border-color: rgba(255, 106, 43, 0.45);
}
.slot-toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 700;
  font-size: 0.72rem;
  color: var(--color-drake);
  background: rgba(89, 214, 108, 0.06);
  border: 1px solid rgba(89, 214, 108, 0.4);
  border-radius: 2px;
  padding: 0.4rem 0.7rem;
  cursor: pointer;
}
.slot-toggle:hover {
  background: rgba(89, 214, 108, 0.12);
}
.chev {
  transition: transform 0.18s ease;
}
.chev.up {
  transform: rotate(180deg);
}
.slot-body {
  padding: 0 0.9rem 0.9rem;
  border-top: 1px solid var(--color-ash);
  margin-top: -1px;
  padding-top: 0.9rem;
}
.slot-msg {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  color: var(--color-smoke);
  font-size: 0.85rem;
  padding: 1rem 0;
}
.slot-msg-error {
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
}
.slot-wiki {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.75rem;
  color: var(--color-drake);
  border-bottom: 1px solid rgba(89, 214, 108, 0.4);
}
.spinner {
  width: 15px;
  height: 15px;
  border: 2px solid var(--color-ash-2);
  border-top-color: var(--color-ember);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
  }
  .chev {
    transition: none;
  }
}

@media (max-width: 600px) {
  .slot-label {
    min-width: 100%;
  }
}
</style>
