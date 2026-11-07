<script setup>
import { ref, onMounted } from 'vue'

/** The reference images in docs/design/refs, served by the dev plugin. Look at a real frame before drawing one. */
const files = ref([])
const open = ref('')
const failed = ref(false)

onMounted(async () => {
  try {
    const res = await fetch('/__forge/refs')
    files.value = res.ok ? await res.json() : []
    failed.value = !res.ok
  } catch {
    failed.value = true
  }
})
</script>

<template>
  <section class="fg-refs" aria-labelledby="fg-refs-h">
    <h3 id="fg-refs-h" class="fg-h">References</h3>
    <p v-if="failed" class="fg-note">The dev plugin did not answer. Is this the Vite dev server?</p>
    <p v-else-if="!files.length" class="fg-note">No images in <code>docs/design/refs/</code>. Drop public-domain frames there (USGS).</p>
    <ul v-else class="fg-thumbs">
      <li v-for="f in files" :key="f">
        <button type="button" class="fg-thumb" :aria-pressed="open === f" @click="open = open === f ? '' : f">
          <img :src="`/__forge/refs/${encodeURIComponent(f)}`" :alt="f" loading="lazy" />
          <span>{{ f }}</span>
        </button>
      </li>
    </ul>
    <figure v-if="open" class="fg-large">
      <img :src="`/__forge/refs/${encodeURIComponent(open)}`" :alt="open" />
      <figcaption>{{ open }}</figcaption>
    </figure>
  </section>
</template>

<style scoped>
.fg-refs {
  padding: 1rem;
}
.fg-thumbs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.fg-thumb {
  display: grid;
  gap: 0.25rem;
  width: 160px;
  padding: 0;
  background: none;
  border: 1px solid var(--color-ash);
  color: var(--color-smoke);
  font: 0.7rem var(--font-mono);
  cursor: pointer;
}
.fg-thumb[aria-pressed='true'] {
  border-color: var(--color-ember);
}
.fg-thumb img {
  width: 100%;
  height: 100px;
  object-fit: cover;
  display: block;
}
.fg-thumb span {
  padding: 0 0.25rem 0.25rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fg-large {
  margin: 1rem 0 0;
}
.fg-large img {
  max-width: 100%;
  display: block;
  border: 1px solid var(--color-ash);
}
.fg-large figcaption {
  font: 0.75rem var(--font-mono);
  color: var(--color-smoke);
  padding-top: 0.25rem;
}
</style>
