<script setup>
// The two pages of the Accolades tab, side by side: the accolades and the retired ones. Shown on the Accolades
// landing page (when the bundle carries the legacy data) and on the Legacy Accolades page. The current page is
// the exact match, so the router marks it `aria-current="page"`.
</script>

<template>
  <nav class="acc-switch" aria-label="Accolades pages">
    <RouterLink to="/accolades" class="acc-switch-link" exact-active-class="is-current">Accolades</RouterLink>
    <RouterLink to="/accolades/legacy" class="acc-switch-link" exact-active-class="is-current">Legacy Accolades</RouterLink>
  </nav>
</template>

<style scoped>
.acc-switch { display: flex; flex-wrap: wrap; gap: 0.4rem 1.7rem; margin: 0 0 1.6rem; }
.acc-switch-link {
  font-family: var(--font-mono); font-size: 0.74rem; letter-spacing: 0.22em; text-transform: uppercase;
  color: var(--color-smoke); padding-bottom: 0.25rem; border-bottom: 2px solid transparent;
  transition: color 0.2s, border-color 0.2s;
}
.acc-switch-link:hover { color: var(--color-bone); }
.acc-switch-link:focus-visible { outline: 2px solid var(--color-drake); outline-offset: 3px; }
.acc-switch-link.is-current { color: var(--color-averland); border-bottom-color: var(--color-averland); }
</style>
