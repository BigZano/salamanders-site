<script setup>
// The bar under the area's head on a phone: it says where you are (the area, and the view that is open) and is
// the button that opens the list of views in the bottom sheet.
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
  padding: 0.7rem 1.1rem;
  border: 0;
  border-radius: 0;
  background:
    linear-gradient(180deg, color-mix(in oklab, var(--dw-accent) 16%, transparent), color-mix(in oklab, var(--dw-accent) 6%, transparent)),
    var(--dw-surface);
  box-shadow: inset 0 0 14px color-mix(in oklab, var(--dw-accent) 18%, transparent);
  clip-path: polygon(9px 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0 100%, 0 9px);
  color: var(--dw-ink);
  text-align: left;
  cursor: pointer;
  transition: transform var(--dur-press) var(--ease-forge);
}
.dw-areabar-text {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.dw-areabar-area {
  font: 600 0.75rem / 1.2 var(--dw-font-cond);
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--dw-muted);
}
.dw-areabar-tab {
  font: 500 1.5rem / 1 var(--dw-font-hud);
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--dw-accent);
  text-shadow: 0 0 8px color-mix(in oklab, var(--dw-accent) 60%, transparent);
}
.dw-areabar-chevron {
  flex: none;
  color: var(--dw-accent);
}
.dw-areabar:active {
  transform: scale(0.97);
}
/* Its corners are clipped, which also clips an outline drawn outside the box: draw the ring inside it. */
.dw-areabar:focus-visible {
  outline: 2px solid var(--dw-accent);
  outline-offset: -6px;
}
</style>
