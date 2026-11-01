<script setup>
import { computed } from 'vue'
import { useArchive } from '../stores/archive'
import { legacyView } from '../lib/archive/legacy'
import ArchiveGate from '../components/archive/ArchiveGate.vue'
import ArchivePlaque from '../components/archive/ArchivePlaque.vue'
import RosterMember from '../components/roster/RosterMember.vue'
import AccoladesSwitch from '../components/archive/AccoladesSwitch.vue'

// The gate renders this only once the archive is unsealed. `legacy` is null for a bundle sealed before
// this page existed; sign-out resets the store, hence the optional chain.
const archive = useArchive()
const view = computed(() => (archive.archive?.legacy ? legacyView(archive.archive.legacy) : null))
</script>

<template>
  <ArchiveGate>
    <ArchivePlaque v-if="view">
      <AccoladesSwitch />
      <article class="leg">
        <header>
          <p class="leg-eyebrow">Legion Archive · Accolades</p>
          <h1 class="leg-title">Legacy Accolades</h1>
          <p class="leg-note">Roles retired from the Discord server. Holders as recorded on {{ view.snapshotDate }}.</p>
          <div class="leg-rule" aria-hidden="true" />
        </header>
        <section v-for="a in view.accolades" :key="a.roleId" class="leg-accolade" :aria-labelledby="`leg-${a.roleId}`">
          <h2 :id="`leg-${a.roleId}`" class="leg-name" :style="a.color ? { color: a.color } : undefined">{{ a.name }}</h2>
          <p v-for="(p, i) in a.paragraphs" :key="i" class="leg-blurb">{{ p }}</p>
          <p class="leg-count">{{ a.countLabel }}</p>
          <ul v-if="a.holders.length" class="leg-holders">
            <RosterMember v-for="h in a.holders" :key="h.id" :member="h" :image-ready="false" />
          </ul>
        </section>
      </article>
    </ArchivePlaque>
    <ArchivePlaque v-else narrow>
      <div class="leg-missing">
        <p class="leg-eyebrow">Legion Archive</p>
        <p>The Legacy Accolades haven't been sealed into the archive yet.</p>
        <RouterLink to="/accolades" class="leg-missing-link">Back to the Accolades</RouterLink>
      </div>
    </ArchivePlaque>
  </ArchiveGate>
</template>

<!-- ArchiveThread's heading styles are scoped to that component, so the few the page shares are repeated here
     rather than lifting them out of the fidelity-critical thread view. -->
<style scoped>
.leg { color: #d9ded8; line-height: 1.6; }
.leg-eyebrow { font-family: var(--font-mono); font-size: 0.7rem; letter-spacing: 0.28em; text-transform: uppercase; color: var(--color-smoke); margin: 0 0 0.9rem; }
.leg-missing .leg-eyebrow { color: var(--color-averland); }
.leg-title {
  font-family: var(--font-display); font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; line-height: 1.05;
  font-size: clamp(1.8rem, 4.5vw, 2.7rem); margin: 0; color: var(--color-averland);
  text-shadow: 0 -1px 0 rgba(0, 0, 0, 0.95), 0 1px 0 rgba(255, 225, 170, 0.1), 0 0 14px rgba(253, 184, 37, 0.14);
}
.leg-note { font-family: var(--font-mono); font-size: 0.74rem; color: var(--color-smoke); margin: 0.9rem 0 0; }
.leg-rule {
  height: 2px; margin: 1.6rem 0 0.4rem;
  background: linear-gradient(90deg, transparent, #7a4c12 12%, var(--color-averland) 50%, #7a4c12 88%, transparent);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.9);
}
.leg-accolade { position: relative; padding: 1.6rem 0; }
.leg-accolade + .leg-accolade::before {
  content: ''; position: absolute; top: 0; left: 15%; right: 15%; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(253, 184, 37, 0.25), transparent);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.8);
}
.leg-name { font-family: var(--font-display); font-weight: 700; font-size: 1.3rem; text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 0.5rem; color: var(--color-bone); }
.leg-blurb { margin: 0.4rem 0; white-space: pre-line; }
.leg-count { font-family: var(--font-mono); font-size: 0.7rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-smoke); margin: 0.9rem 0 0.5rem; }
.leg-holders { display: flex; flex-wrap: wrap; gap: 0.38rem; margin: 0; padding: 0; list-style: none; }
.leg-missing { text-align: center; color: #c9cfc9; }
.leg-missing-link { display: inline-block; margin-top: 0.9rem; color: var(--color-bone); text-decoration: underline; text-decoration-color: rgba(89, 214, 108, 0.5); text-underline-offset: 3px; }
@media (hover: hover) and (pointer: fine) {
  .leg-missing-link:hover { color: #fff; text-decoration-color: var(--color-drake); }
}
</style>
