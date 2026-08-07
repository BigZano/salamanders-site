<script setup>
import { useRoute } from 'vue-router'

const route = useRoute()
</script>

<template>
  <section class="nf">
    <p class="eyebrow">Off the map</p>
    <h1 class="nf-title">No such muster</h1>
    <p class="nf-body">
      Nothing is filed under <code class="nf-path">{{ route.fullPath }}</code>. Pick a
      destination below.
    </p>
    <div class="nf-links">
      <RouterLink to="/" class="btn-ember nf-cta">Back to the forge</RouterLink>
      <RouterLink to="/planner" class="btn-drake nf-cta">Perk Builder</RouterLink>
    </div>
  </section>
</template>

<style scoped>
.nf {
  max-width: 40rem;
  margin: 0 auto;
  padding: 7rem 1.5rem 4rem;
  text-align: center;
}
.nf-title {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  font-size: clamp(2.2rem, 7vw, 3.4rem);
  color: var(--color-bone);
  margin: 0.4rem 0 0.8rem;
}
.nf-body {
  color: var(--color-smoke);
  line-height: 1.6;
}
.nf-path {
  font-family: var(--font-mono);
  font-size: 0.85em;
  color: var(--color-gold);
  word-break: break-all;
}
.nf-links {
  display: flex;
  gap: 0.6rem;
  justify-content: center;
  flex-wrap: wrap;
  margin-top: 1.8rem;
}
.nf-cta {
  padding: 0.8rem 1.4rem;
  border-radius: 2px;
}
</style>
