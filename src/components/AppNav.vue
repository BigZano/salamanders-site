<script setup>
import { ref, watch } from 'vue'
import { useRoute } from 'vue-router'

const open = ref(false)
const route = useRoute()
const DISCORD = 'https://discord.gg/salamanders'

const links = [
  { to: '/', label: 'Home' },
  { to: '/planner', label: 'Perk Builder' },
  { to: '/armoury', label: 'Armoury' },
  { to: '/builds', label: 'Builds' },
  { to: '/companies', label: 'Companies' },
]

// Close the mobile menu on navigation.
watch(
  () => route.fullPath,
  () => (open.value = false),
)
</script>

<template>
  <header class="nav">
    <div class="nav-bar">
      <RouterLink to="/" class="brand" @click="open = false">
        <span class="brand-diamond" aria-hidden="true" />
        <span class="brand-text">Salamanders</span>
        <span class="brand-legion" aria-hidden="true">XVIII</span>
      </RouterLink>

      <nav class="nav-links" aria-label="Primary">
        <RouterLink
          v-for="l in links"
          :key="l.to"
          :to="l.to"
          class="nav-link"
          exact-active-class="is-active"
        >
          {{ l.label }}
        </RouterLink>
      </nav>

      <a class="btn-ember nav-cta" :href="DISCORD" target="_blank" rel="noopener">
        Join
      </a>

      <button
        class="burger"
        :aria-expanded="open"
        aria-label="Toggle menu"
        @click="open = !open"
      >
        <span :class="{ x: open }" />
        <span :class="{ x: open }" />
        <span :class="{ x: open }" />
      </button>
    </div>

    <transition name="sheet">
      <nav v-if="open" class="nav-mobile" aria-label="Mobile">
        <RouterLink
          v-for="l in links"
          :key="l.to"
          :to="l.to"
          class="nav-mobile-link"
          exact-active-class="is-active"
        >
          {{ l.label }}
        </RouterLink>
        <a class="btn-ember nav-mobile-cta" :href="DISCORD" target="_blank" rel="noopener">
          Join the Chapter
        </a>
      </nav>
    </transition>
  </header>
</template>

<style scoped>
.nav {
  position: sticky;
  top: 0;
  z-index: 50;
  background: rgba(5, 10, 8, 0.72);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--color-ash);
}
.nav-bar {
  max-width: 76rem;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.7rem 1.25rem;
}
.brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-right: auto;
}
.brand-text {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  letter-spacing: 0.14em;
  font-size: 1.05rem;
  color: var(--color-bone);
}
.brand-diamond {
  width: 12px;
  height: 12px;
  transform: rotate(45deg);
  background: linear-gradient(180deg, #ffb066, #ff6a2b);
  box-shadow: 0 0 10px rgba(255, 106, 43, 0.6);
  flex: none;
}
.brand-legion {
  font-family: var(--font-mono);
  font-size: 0.6rem;
  letter-spacing: 0.2em;
  color: var(--color-gold);
  border: 1px solid rgba(223, 184, 91, 0.4);
  padding: 1px 5px;
  border-radius: 2px;
}
.nav-links {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.nav-link {
  position: relative;
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.82rem;
  color: var(--color-smoke);
  padding: 0.5rem 0.7rem;
  border-radius: 2px;
  transition: color 0.15s ease, background 0.15s ease;
}
.nav-link:hover {
  color: var(--color-bone);
  background: rgba(89, 214, 108, 0.06);
}
.nav-link.is-active {
  color: var(--color-drake);
}
.nav-link.is-active::after {
  content: '';
  position: absolute;
  left: 0.7rem;
  right: 0.7rem;
  bottom: -0.2rem;
  height: 2px;
  background: var(--color-ember);
  box-shadow: 0 0 8px rgba(255, 106, 43, 0.6);
}
.nav-cta {
  padding: 0.5rem 1.1rem;
  border-radius: 2px;
  font-size: 0.85rem;
}

.burger {
  display: none;
  flex-direction: column;
  justify-content: center;
  gap: 5px;
  width: 42px;
  height: 42px;
  background: transparent;
  border: 1px solid var(--color-ash);
  border-radius: 3px;
  cursor: pointer;
}
.burger span {
  display: block;
  height: 2px;
  width: 20px;
  margin: 0 auto;
  background: var(--color-bone);
  transition: transform 0.22s ease, opacity 0.2s ease;
}
.burger span.x:nth-child(1) {
  transform: translateY(7px) rotate(45deg);
}
.burger span.x:nth-child(2) {
  opacity: 0;
}
.burger span.x:nth-child(3) {
  transform: translateY(-7px) rotate(-45deg);
}

.nav-mobile {
  display: flex;
  flex-direction: column;
  padding: 0.5rem 1rem 1.25rem;
  gap: 0.15rem;
  border-top: 1px solid var(--color-ash);
}
.nav-mobile-link {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-bone);
  padding: 0.9rem 0.5rem;
  border-bottom: 1px solid rgba(38, 55, 47, 0.5);
}
.nav-mobile-link.is-active {
  color: var(--color-drake);
}
.nav-mobile-cta {
  margin-top: 0.9rem;
  justify-content: center;
  padding: 0.9rem;
  border-radius: 2px;
}

.sheet-enter-active,
.sheet-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

@media (max-width: 860px) {
  .nav-links,
  .nav-cta {
    display: none;
  }
  .burger {
    display: flex;
  }
}
</style>
