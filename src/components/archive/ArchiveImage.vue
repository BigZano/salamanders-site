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
.arch-img-emoji img { height: 1.375em; width: auto; vertical-align: -0.3em; }
.arch-img-attachment { display: block; margin-top: 0.75rem; }
.arch-img-attachment img { max-width: 100%; max-height: 32rem; border: 1px solid var(--color-ash); border-radius: 3px; }
.arch-img-pending { display: inline-block; width: 1.2em; height: 1.2em; }
.arch-img-attachment .arch-img-pending { display: block; height: 8rem; background: rgba(89, 214, 108, 0.04); }
.arch-img-fallback { font-family: var(--font-mono); font-size: 0.8em; color: var(--color-smoke); }
</style>
