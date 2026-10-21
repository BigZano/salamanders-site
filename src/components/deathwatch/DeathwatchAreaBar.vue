<script setup>
// The banner at the head of an area on a phone: it says where you are (the area, and the view that is open)
// and is the button that opens the list of views in the bottom sheet. A painted banner image goes behind it later.
defineProps({
  areaLabel: { type: String, required: true },
  tabLabel: { type: String, required: true },
  open: { type: Boolean, default: false },
})
defineEmits(['open'])
</script>

<template>
  <button class="dw-areabar" type="button" aria-haspopup="dialog" :aria-expanded="open ? 'true' : 'false'" @click="$emit('open')">
    <span class="dw-areabar-text">
      <span class="dw-areabar-area">{{ areaLabel }}</span>
      <span class="dw-areabar-tab">{{ tabLabel }}</span>
    </span>
    <svg class="dw-areabar-chevron" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
</template>

<style scoped>
.dw-areabar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  width: 100%;
  min-height: 56px;
  padding: 0.7rem 1rem;
  border: 1px solid var(--dw-line-2);
  border-radius: 3px;
  background: linear-gradient(90deg, var(--dw-surface-2), var(--dw-surface));
  color: var(--dw-ink);
  text-align: left;
  cursor: pointer;
  transition:
    transform 0.15s var(--ease-forge),
    border-color 0.2s ease;
}
.dw-areabar-text {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.dw-areabar-area {
  font-family: var(--dw-font-title);
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.dw-areabar-tab {
  font-size: 0.8rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--dw-accent);
}
.dw-areabar-chevron {
  flex: none;
  color: var(--dw-muted);
}
@media (hover: hover) and (pointer: fine) {
  .dw-areabar:hover {
    border-color: var(--dw-accent);
  }
}
.dw-areabar:active {
  transform: scale(0.98);
}
</style>
