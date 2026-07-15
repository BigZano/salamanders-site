<script setup>
import AppNav from './components/AppNav.vue'

const DISCORD = 'https://discord.gg/salamanders'
const year = new Date().getFullYear()
</script>

<template>
  <AppNav />

  <main>
    <RouterView v-slot="{ Component }">
      <transition name="fade" mode="out-in">
        <component :is="Component" />
      </transition>
    </RouterView>
  </main>

  <footer class="site-footer">
    <div class="footer-inner">
      <div class="footer-col">
        <p class="footer-mark">Salamanders</p>
        <p class="footer-motto">Into the fires of battle, unto the anvil of war.</p>
      </div>
      <div class="footer-col footer-links">
        <RouterLink to="/planner">Perk Builder</RouterLink>
        <RouterLink to="/armoury">Armoury</RouterLink>
        <RouterLink to="/builds">Builds</RouterLink>
        <RouterLink to="/companies">Companies</RouterLink>
        <a :href="DISCORD" target="_blank" rel="noopener">Discord</a>
      </div>
    </div>
    <div class="rule-forge" />
    <p class="footer-fine">
      © {{ year }} Salamanders clan · A fan-run community for Warhammer 40,000: Space
      Marine 2. Not affiliated with or endorsed by Games Workshop or Focus Entertainment.
    </p>
  </footer>
</template>

<style scoped>
main {
  min-height: 60svh;
}
.site-footer {
  margin-top: 4rem;
  border-top: 1px solid var(--color-ash);
  background: rgba(7, 17, 13, 0.6);
}
.footer-inner {
  max-width: 76rem;
  margin: 0 auto;
  padding: 2.5rem 1.5rem 1.5rem;
  display: flex;
  gap: 2rem;
  flex-wrap: wrap;
  justify-content: space-between;
}
.footer-mark {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.16em;
  font-weight: 700;
  font-size: 1.1rem;
  color: var(--color-bone);
}
.footer-motto {
  color: var(--color-smoke);
  font-style: italic;
  margin-top: 0.35rem;
  font-size: 0.9rem;
}
.footer-links {
  display: flex;
  gap: 1.1rem;
  align-items: flex-start;
  flex-wrap: wrap;
}
.footer-links a {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.82rem;
  color: var(--color-smoke);
}
.footer-links a:hover {
  color: var(--color-drake);
}
.footer-fine {
  max-width: 76rem;
  margin: 1rem auto 0;
  padding: 1rem 1.5rem 2rem;
  color: #5f6f66;
  font-size: 0.72rem;
  line-height: 1.5;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .fade-enter-active,
  .fade-leave-active {
    transition: none;
  }
}
</style>
