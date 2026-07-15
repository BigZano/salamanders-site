<script setup>
defineProps({
  kite: { type: String, default: '' },
  title: { type: String, required: true },
  note: { type: String, default: '' },
})
</script>

<template>
  <section class="ph">
    <div class="ph-numeral" aria-hidden="true">XVIII</div>
    <p v-if="kite" class="eyebrow">{{ kite }}</p>
    <h1 class="ph-title">{{ title }}</h1>
    <p class="ph-note">{{ note }}</p>
    <p class="ph-status">
      <span class="ph-dot" /> Being forged — ported from the original planner next.
    </p>
  </section>
</template>

<style scoped>
.ph {
  max-width: 48rem;
  margin: 0 auto;
  padding: 5rem 1.5rem 3rem;
  text-align: center;
}
.ph-numeral {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(3rem, 12vw, 5.5rem);
  letter-spacing: 0.1em;
  line-height: 1;
  margin-bottom: 1rem;
  color: transparent;
  background: linear-gradient(180deg, #3f5a49, #16241c);
  -webkit-background-clip: text;
  background-clip: text;
}
.ph-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: clamp(2.2rem, 8vw, 4rem);
  letter-spacing: 0.01em;
  margin: 0.4rem 0 0.6rem;
  color: var(--color-bone);
}
.ph-note {
  color: var(--color-smoke);
  font-size: 1.05rem;
  line-height: 1.6;
  max-width: 34ch;
  margin: 0 auto;
}
.ph-status {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 2rem;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  letter-spacing: 0.06em;
  color: var(--color-gold);
}
.ph-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-ember);
  box-shadow: 0 0 10px var(--color-ember);
  animation: pulse 1.8s ease-in-out infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ph-dot {
    animation: none;
  }
}
</style>
