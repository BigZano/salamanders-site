<script setup>
import ForgeCanvas from './ForgeCanvas.vue'

const DISCORD = 'https://discord.gg/salamanders'
</script>

<template>
  <section class="hero">
    <ForgeCanvas :intensity="1" />
    <div class="hero-inner">
      <p class="eyebrow">XVIII Legion · Sons of Vulkan</p>
      <h1 class="wordmark">Salamanders</h1>
      <div class="ember-rule" aria-hidden="true">
        <span /><span /><span />
      </div>
      <p class="tagline">Into the fires of battle, unto the anvil of war.</p>
      <div class="cta-row">
        <a class="btn-ember" :href="DISCORD" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24" class="glyph" aria-hidden="true">
            <path
              fill="currentColor"
              d="M20 4.4A19 19 0 0 0 15.3 3l-.24.5a17 17 0 0 1 4.2 1.3 15 15 0 0 0-14.5 0A17 17 0 0 1 9 3.5L8.7 3A19 19 0 0 0 4 4.4 20 20 0 0 0 .5 18a19 19 0 0 0 5.8 3l.8-1.3a12 12 0 0 1-1.8-.9l.4-.3a13.6 13.6 0 0 0 11.6 0l.4.3a12 12 0 0 1-1.8.9l.8 1.3a19 19 0 0 0 5.8-3A20 20 0 0 0 20 4.4ZM8.3 14.8c-.9 0-1.7-.9-1.7-2s.7-2 1.7-2 1.7.9 1.7 2-.8 2-1.7 2Zm7.4 0c-.9 0-1.7-.9-1.7-2s.7-2 1.7-2 1.7.9 1.7 2-.8 2-1.7 2Z"
            />
          </svg>
          Join the Chapter
        </a>
        <RouterLink class="btn-drake" to="/planner">Open the Planner</RouterLink>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hero {
  position: relative;
  min-height: 92svh;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 6rem 1.5rem 4rem;
  isolation: isolate;
  text-align: center;
}
.hero-inner {
  position: relative;
  z-index: 2;
  max-width: 60rem;
  width: 100%;
}
.wordmark {
  font-family: var(--font-display);
  text-transform: uppercase;
  font-weight: 700;
  line-height: 0.9;
  letter-spacing: 0.02em;
  font-size: clamp(3.4rem, 14vw, 10rem);
  margin: 0.6rem 0 0;
  background: linear-gradient(180deg, #fff2e0 0%, #ffd6a0 40%, #ff8a3d 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  /* drop-shadow (not text-shadow) — clean glow on gradient-clipped text */
  filter: drop-shadow(0 0 26px rgba(255, 106, 43, 0.28));
}
.ember-rule {
  display: flex;
  gap: 0.5rem;
  justify-content: center;
  align-items: center;
  margin: 1.3rem 0 0.2rem;
}
.ember-rule span {
  width: 8px;
  height: 8px;
  transform: rotate(45deg);
  background: linear-gradient(180deg, #ffb066, #ff6a2b);
  box-shadow: 0 0 12px rgba(255, 106, 43, 0.7);
}
.ember-rule span:nth-child(2) {
  width: 10px;
  height: 10px;
}
.tagline {
  font-family: var(--font-sans);
  color: var(--color-smoke);
  font-size: clamp(1rem, 2.4vw, 1.3rem);
  max-width: 42ch;
  margin: 1rem auto 0;
  line-height: 1.5;
}
.cta-row {
  margin-top: 2.2rem;
  display: flex;
  gap: 0.9rem;
  justify-content: center;
  flex-wrap: wrap;
}
.btn-ember,
.btn-drake {
  padding: 0.85rem 1.5rem;
  border-radius: 2px;
  font-size: 1rem;
}
.glyph {
  width: 20px;
  height: 20px;
}

@media (max-width: 768px) {
  .hero {
    padding: 5rem 1.25rem 3rem;
  }
}
</style>
