<script setup>
// The podium of a standings page: three cards, the middle one (first place) raised. Pure placeholder, so it
// is hidden from assistive technology; the page's real heading comes before it.
</script>

<template>
  <div class="sk-podium" aria-hidden="true">
    <div v-for="(first, i) in [false, true, false]" :key="i" class="sk-card" :class="{ 'is-first': first }">
      <span class="dw-sk-bar sk-name" />
      <span class="dw-sk-bar sk-score" />
      <span class="dw-sk-bar sk-foot" />
    </div>
  </div>
</template>

<style scoped>
.sk-podium {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: end;
  gap: 0.75rem;
}
.sk-card {
  display: grid;
  gap: 0.7rem;
  padding: 1rem;
  border: 1px solid var(--dw-line-2);
  background: color-mix(in oklab, var(--dw-surface) 82%, transparent);
}
.sk-card.is-first {
  padding-block: 1.4rem;
  border-color: color-mix(in oklab, var(--dw-gold) 55%, var(--dw-line-2));
}
.sk-name {
  width: 70%;
}
.sk-score {
  height: 2rem;
  width: 55%;
}
.sk-foot {
  width: 40%;
}
@media (max-width: 480px) {
  .sk-podium {
    gap: 0.4rem;
  }
  .sk-card {
    padding: 0.7rem;
  }
}
</style>
