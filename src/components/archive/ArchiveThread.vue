<script setup>
import { computed, h, watch, nextTick, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useArchive } from '../../stores/archive'
import { parse } from '../../lib/archive/markdown'
import { dropDeadLines, tocOnly } from '../../lib/archive/prune'
import { classifyHref, emojiFile, attachmentFile, threadTags, mentionLabel } from '../../lib/archive/model'
import { takeAnchor } from '../../lib/archive/anchor'
import ArchiveMarkdown from './ArchiveMarkdown'
import ArchiveImage from './ArchiveImage.vue'

const props = defineProps({ collectionKey: String, threadId: String })
const archive = useArchive()
const route = useRoute()
const router = useRouter()

const col = computed(() => archive.archive.collections.get(props.collectionKey))
const entry = computed(() => col.value.threads.get(props.threadId))
const tags = computed(() => threadTags(col.value, entry.value.thread))
// Display pruning (user decision 2026-09-24): the ToC shows only live links
// and their headings; other threads drop lines that are only unlinked refs.
const isToc = computed(() => props.threadId === col.value.tocThreadId)
const kind = (href) => classifyHref(href, archive.archive).kind
const messages = computed(() =>
  entry.value.messages
    .map((m) => {
      const ast = parse(m.content ?? '')
      return { m, ast: isToc.value ? tocOnly(ast, kind) : dropDeadLines(ast, kind), attachments: isToc.value ? [] : m.attachments ?? [] }
    })
    .filter(({ ast, attachments }) => ast.some((n) => n.type !== 'blank') || attachments.length),
)

const ctx = computed(() => ({
  link: (href) => {
    const r = classifyHref(href, archive.archive)
    return r.kind === 'unaccounted' ? { kind: 'text' } : r
  },
  emoji: (n) => {
    const file = emojiFile(col.value, n.id, n.animated)
    return file ? h(ArchiveImage, { collectionKey: props.collectionKey, file, alt: `:${n.name}:` }) : `:${n.name}:`
  },
  mention: (n) => mentionLabel(col.value, archive.archive, n),
}))

function scrollToHash() {
  const id = route.hash.slice(1)
  if (id) nextTick(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }))
}
onMounted(() => {
  const stashed = takeAnchor(route.path)
  if (stashed && !route.hash) router.replace({ path: route.path, query: route.query, hash: stashed })
  else scrollToHash()
})
watch(() => [route.hash, props.threadId], scrollToHash)
</script>

<template>
  <article class="arch-thread">
    <header class="arch-head">
      <h1 class="arch-title">{{ entry.thread.name }}</h1>
      <ul v-if="tags.length" class="arch-tags">
        <li v-for="t in tags" :key="t.id" class="arch-tag">
          <ArchiveImage v-if="t.emoji_id && emojiFile(col, t.emoji_id, false)" :collection-key="collectionKey" :file="emojiFile(col, t.emoji_id, false)" alt="" />
          {{ t.name }}
        </li>
      </ul>
    </header>
    <section
      v-for="{ m, ast, attachments } in messages"
      :key="m.id"
      :id="m.id === threadId ? undefined : `m-${m.id}`"
      class="arch-msg"
    >
      <ArchiveMarkdown :nodes="ast" :ctx="ctx" />
      <template v-for="a in attachments" :key="a.id ?? a.url">
        <ArchiveImage
          v-if="attachmentFile(col, a.url)"
          :collection-key="collectionKey"
          :file="attachmentFile(col, a.url)"
          :alt="a.filename ?? 'attachment'"
          kind="attachment"
        />
      </template>
    </section>
  </article>
</template>

<style scoped>
.arch-thread { max-width: 52rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
.arch-title { font-family: var(--font-display); text-transform: uppercase; letter-spacing: 0.08em; font-size: 1.6rem; color: var(--color-bone); }
.arch-tags { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.6rem; list-style: none; padding: 0; }
.arch-tag { font-family: var(--font-mono); font-size: 0.72rem; color: var(--color-gold); border: 1px solid rgba(223, 184, 91, 0.35); border-radius: 2px; padding: 2px 6px; display: inline-flex; gap: 0.3rem; align-items: center; }
.arch-msg { padding: 1.1rem 0; border-top: 1px solid rgba(38, 55, 47, 0.5); scroll-margin-top: 5rem; }
.arch-msg:first-of-type { border-top: 0; }
:deep(.md-h1) { font-size: 1.5rem; } :deep(.md-h2) { font-size: 1.25rem; } :deep(.md-h3) { font-size: 1.05rem; }
:deep(.md-h) { font-family: var(--font-display); color: var(--color-bone); margin: 0.9rem 0 0.35rem; }
:deep(.md-line) { margin: 0.1rem 0; }
:deep(.md-blank) { height: 0.7rem; }
:deep(.md-sub) { font-size: 0.8rem; color: var(--color-smoke); margin: 0.15rem 0; }
:deep(.md-quote) { border-left: 3px solid var(--color-ash-2); padding-left: 0.8rem; margin: 0.35rem 0; }
:deep(.md-list) { padding-left: 1.3rem; margin: 0.2rem 0; }
:deep(.md-link) { color: var(--color-drake); text-decoration: underline; text-underline-offset: 2px; }
:deep(.md-code) { font-family: var(--font-mono); font-size: 0.85em; background: rgba(255, 255, 255, 0.06); padding: 0 0.25em; border-radius: 3px; }
:deep(.md-mention) { background: color-mix(in srgb, var(--role, #5865f2) 22%, transparent); color: var(--role, #c9cdfb); border-radius: 3px; padding: 0 0.2em; }
:deep(.md-spoiler) { background: #1e1f22; color: transparent; border-radius: 3px; cursor: pointer; }
:deep(.md-spoiler) * { visibility: hidden; }
:deep(.md-spoiler.is-shown) { background: rgba(255, 255, 255, 0.08); color: inherit; cursor: auto; }
:deep(.md-spoiler.is-shown) * { visibility: visible; }
</style>
