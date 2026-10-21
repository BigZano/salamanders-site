<script setup>
// The list of views in one Deathwatch area, plus the way back to the hub. One component for every width: it is
// the always-open sidebar on a wide screen and the content of the bottom sheet on a phone. It says when a link
// was used (`navigate`), so a sheet around it can close.
import { computed } from 'vue'
import { AREAS } from '../../lib/deathwatch/areas'

const props = defineProps({
  area: { type: String, required: true },
  // The slug of the tab being shown.
  current: { type: String, required: true },
})
const emit = defineEmits(['navigate'])

const info = computed(() => AREAS[props.area])
</script>

<template>
  <nav class="dw-nav" :aria-label="`${info.label} sections`">
    <ul>
      <li v-for="tab in info.tabs" :key="tab.slug">
        <RouterLink
          class="dw-nav-link"
          :to="`/deathwatch/${area}/${tab.slug}`"
          :aria-current="tab.slug === current ? 'page' : undefined"
          @click="emit('navigate')"
        >
          {{ tab.label }}
        </RouterLink>
      </li>
      <li>
        <RouterLink class="dw-nav-link dw-nav-back" to="/deathwatch" @click="emit('navigate')">Back to the Fortress</RouterLink>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.dw-nav ul {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dw-nav-link {
  display: flex;
  align-items: center;
  min-height: 44px;
  padding: 0.5rem 0.9rem;
  border-left: 2px solid transparent;
  border-radius: 2px;
  color: var(--dw-silver);
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease;
}
.dw-nav-link[aria-current='page'] {
  border-left-color: var(--dw-accent);
  background: var(--dw-surface-2);
  color: var(--dw-ink);
  font-weight: 600;
}
.dw-nav-back {
  margin-top: 0.5rem;
  color: var(--dw-muted);
}
@media (hover: hover) and (pointer: fine) {
  .dw-nav-link:hover {
    background: var(--dw-surface-2);
  }
}
.dw-nav-link:active {
  background: var(--dw-line);
}
</style>
