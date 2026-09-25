<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useArchive } from '../../stores/archive'

const props = defineProps({
  collectionKey: { type: String, required: true },
  file: { type: String, required: true },
  alt: { type: String, required: true },
  kind: { type: String, default: 'emoji' }, // 'emoji' | 'attachment'
})
const archive = useArchive()
const src = ref(null)
const failed = ref(false)
const el = ref(null)
let observer = null

async function load() {
  try {
    src.value = await archive.assetUrl(props.collectionKey, props.file)
  } catch {
    failed.value = true
  }
}
onMounted(() => {
  // Attachments can be tens of MB: only fetch + decrypt when near the viewport.
  if (props.kind === 'attachment' && 'IntersectionObserver' in window) {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer.disconnect()
        load()
      }
    }, { rootMargin: '600px' })
    observer.observe(el.value)
  } else load()
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <span ref="el" :class="['arch-img', `arch-img-${kind}`]">
    <img v-if="src" :src="src" :alt="alt" :title="kind === 'emoji' ? alt : undefined" />
    <span v-else-if="failed" class="arch-img-fallback">{{ alt }}</span>
    <span v-else class="arch-img-pending" aria-hidden="true" />
  </span>
</template>

<style scoped>
/* Tailwind's preflight makes every img a block; emoji sit in the line, as in Discord. */
.arch-img-emoji img { display: inline-block; height: 1.375em; width: auto; vertical-align: -0.3em; }
/* Attachments are mounted like the plaque itself: a brass lip set into the iron. */
.arch-img-attachment {
  display: block; width: fit-content; max-width: 100%; margin: 1.1rem auto 0.4rem; padding: 5px; border-radius: 3px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--color-averland) 70%, #fff), var(--color-averland) 25%, color-mix(in srgb, var(--color-averland) 50%, #3a1a03));
  box-shadow: 0 0 0 1px #000, 0 10px 24px -10px rgba(0, 0, 0, 0.9), inset 0 1px 0 rgba(255, 245, 210, 0.6);
}
.arch-img-attachment img { display: block; max-width: 100%; max-height: 32rem; border-radius: 1px; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.85); }
.arch-img-pending { display: inline-block; width: 1.2em; height: 1.2em; }
.arch-img-attachment .arch-img-pending { display: block; width: min(24rem, 70vw); height: 12rem; background: #0b0c0b; }
.arch-img-attachment .arch-img-fallback { display: block; padding: 1rem 1.25rem; background: #0b0c0b; }
.arch-img-fallback { font-family: var(--font-mono); font-size: 0.8em; color: var(--color-smoke); }
</style>
