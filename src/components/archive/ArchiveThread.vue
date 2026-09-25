<script setup>
import { computed, h, ref, watch, nextTick, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useArchive } from '../../stores/archive'
import { parse } from '../../lib/archive/markdown'
import { dropDeadLines, tocOnly } from '../../lib/archive/prune'
import { classifyHref, emojiFile, attachmentFile, threadTags, mentionLabel } from '../../lib/archive/model'
import { takeAnchor } from '../../lib/archive/anchor'
import { motionAllowed } from '../../lib/doomfire'
import { unlistedThreads, insertEntries } from './toc'
import ArchiveMarkdown from './ArchiveMarkdown'
import ArchiveImage from './ArchiveImage.vue'
import ArchivePlaque from './ArchivePlaque.vue'

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
const messages = computed(() => {
  const shown = entry.value.messages.map((m) => {
    const ast = parse(m.content ?? '')
    return { m, ast: isToc.value ? tocOnly(ast, kind) : dropDeadLines(ast, kind), attachments: isToc.value ? [] : m.attachments ?? [] }
  })
  // The ToC gains the sealed overlay's entries, placed among the authored ones.
  if (isToc.value) {
    const withEntries = insertEntries(shown.map((x) => x.ast), col.value, archive.archive)
    shown.forEach((x, i) => (x.ast = withEntries[i]))
  }
  return shown.filter(({ ast, attachments }) => ast.some((n) => n.type !== 'blank') || attachments.length)
})

// Threads the ToC still doesn't reach, so every page stays reachable.
const unlisted = computed(() => (isToc.value ? unlistedThreads(col.value, archive.archive, messages.value.map((x) => x.ast)) : []))

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

// Brands arrive hot and cool down the page, one after another.
const plate = ref(null)
const branding = motionAllowed()
onMounted(() => {
  if (branding) {
    plate.value?.querySelectorAll('.arch-title, .md-h1, .md-h2')
      .forEach((el, i) => el.style.setProperty('--i', Math.min(i, 14)))
  }
  const stashed = takeAnchor(route.path)
  if (stashed && !route.hash) router.replace({ path: route.path, query: route.query, hash: stashed })
  else scrollToHash()
})
watch(() => [route.hash, props.threadId], scrollToHash)
</script>

<template>
  <ArchivePlaque>
    <article ref="plate" :class="['arch-thread', { 'is-branding': branding, 'is-toc': isToc }]">
      <header class="arch-head">
        <p class="arch-eyebrow">
          <span v-if="isToc">Legion Archive · {{ route.meta.title }}</span>
          <RouterLink v-else :to="`/${collectionKey}`" class="arch-back">{{ route.meta.title }}</RouterLink>
        </p>
        <h1 class="arch-title">{{ entry.thread.name }}</h1>
        <ul v-if="tags.length" class="arch-tags">
          <li v-for="t in tags" :key="t.id" class="arch-tag">
            <ArchiveImage v-if="t.emoji_id && emojiFile(col, t.emoji_id, false)" :collection-key="collectionKey" :file="emojiFile(col, t.emoji_id, false)" alt="" />
            {{ t.name }}
          </li>
        </ul>
        <div class="arch-rule" aria-hidden="true" />
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
      <section v-if="unlisted.length" class="arch-also" aria-labelledby="arch-also-h">
        <h2 id="arch-also-h" class="md-h md-h2">Also in the archive</h2>
        <ul class="md-list">
          <li v-for="t in unlisted" :key="t.id">
            <RouterLink :to="`/${collectionKey}/${t.id}`" class="md-link">{{ t.name }}</RouterLink>
          </li>
        </ul>
      </section>
    </article>
  </ArchivePlaque>
</template>

<style scoped>
.arch-thread { color: #d9ded8; line-height: 1.6; }

/* ---- header ---- */
.arch-eyebrow { font-family: var(--font-mono); font-size: 0.7rem; letter-spacing: 0.28em; text-transform: uppercase; color: var(--color-smoke); margin: 0 0 0.9rem; }
.arch-back { color: var(--color-smoke); transition: color 0.2s; }
.arch-back::before { content: '\2190\00a0\00a0'; }
.arch-back:hover { color: var(--color-averland); }
.arch-title { font-family: var(--font-display); font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; line-height: 1.05; font-size: clamp(1.8rem, 4.5vw, 2.7rem); margin: 0; }
.arch-tags { display: flex; flex-wrap: wrap; gap: 0.45rem; margin: 1rem 0 0; list-style: none; padding: 0; }
.arch-tag {
  display: inline-flex; gap: 0.35rem; align-items: center; padding: 3px 8px; border-radius: 2px;
  font-family: var(--font-mono); font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-averland);
  background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(253, 184, 37, 0.28); box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.7);
}
/* A brass inlay line, cut the same way as the filigree. */
.arch-rule {
  height: 2px; margin: 1.6rem 0 0.4rem;
  background: linear-gradient(90deg, transparent, #7a4c12 12%, var(--color-averland) 50%, #7a4c12 88%, transparent);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.9);
}

/* ---- the brand: sunk into the iron, arriving hot, cooling to Averland Sunset ---- */
.arch-title, :deep(.md-h1), :deep(.md-h2) {
  color: var(--color-averland);
  text-shadow: 0 -1px 0 rgba(0, 0, 0, 0.95), 0 1px 0 rgba(255, 225, 170, 0.1), 0 0 14px rgba(253, 184, 37, 0.14);
}
.is-branding .arch-title, .is-branding :deep(.md-h1), .is-branding :deep(.md-h2) {
  animation: brand-cool 1.7s cubic-bezier(0.2, 0.7, 0.3, 1) both;
  animation-delay: calc(var(--i, 0) * 90ms);
}
@keyframes brand-cool {
  0% { opacity: 0.2; filter: brightness(1.9) saturate(1.4) drop-shadow(0 0 10px #ff6a2b) drop-shadow(0 0 22px rgba(224, 67, 29, 0.8)); }
  15% { opacity: 1; }
  55% { filter: brightness(1.3) saturate(1.2) drop-shadow(0 0 6px rgba(255, 106, 43, 0.7)); }
  100% { filter: none; }
}

/* ---- messages ---- */
.arch-msg { position: relative; padding: 1.6rem 0; scroll-margin-top: 5rem; }
.arch-also { position: relative; padding: 1.6rem 0 0; }
.arch-msg + .arch-msg::before, .arch-also::before {
  content: ''; position: absolute; top: 0; left: 15%; right: 15%; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(253, 184, 37, 0.25), transparent);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.8);
}

/* ---- markdown ---- */
:deep(.md-h) { font-family: var(--font-display); font-weight: 700; line-height: 1.15; margin: 1.3rem 0 0.5rem; }
:deep(.md-h1) { font-size: 1.65rem; text-transform: uppercase; letter-spacing: 0.05em; }
:deep(.md-h2) { font-size: 1.3rem; text-transform: uppercase; letter-spacing: 0.04em; }
:deep(.md-h3) { font-size: 1.08rem; color: var(--color-bone); letter-spacing: 0.02em; }
:deep(.md > :first-child) { margin-top: 0; }
:deep(.md-line) { margin: 0.15rem 0; }
:deep(.md-blank) { height: 0.8rem; }
:deep(.md-sub) { font-family: var(--font-mono); font-size: 0.74rem; color: var(--color-smoke); margin: 0.2rem 0; }
:deep(strong) { color: var(--color-bone); }


/* quotes: channels cut into the iron */
:deep(.md-quote) {
  margin: 0.6rem 0; padding: 0.55rem 1rem; border-radius: 2px;
  background: rgba(0, 0, 0, 0.32); border-left: 2px solid rgba(89, 214, 108, 0.55);
  box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.75), inset 0 -1px 0 rgba(255, 255, 255, 0.03);
}
:deep(.md-quote .md-quote) { background: rgba(0, 0, 0, 0.28); border-left-color: rgba(89, 214, 108, 0.3); }

/* lists: forge marks, cooling with depth */
:deep(ul.md-list) { list-style: none; padding-left: 1.35rem; margin: 0.3rem 0; }
:deep(ul.md-list > li) { position: relative; }
:deep(ul.md-list > li)::before {
  content: ''; position: absolute; left: -1rem; top: 0.62em; width: 6px; height: 6px; transform: rotate(45deg);
  background: var(--color-ember); box-shadow: 0 0 6px rgba(255, 106, 43, 0.7);
}
:deep(ul.md-list ul.md-list > li)::before { background: #a0643a; box-shadow: none; }
:deep(ul.md-list ul.md-list ul.md-list > li)::before { background: var(--color-ash-2); }
:deep(ol.md-list) { padding-left: 1.6rem; margin: 0.3rem 0; }
:deep(ol.md-list > li)::marker { font-family: var(--font-display); color: var(--color-averland); }

/* links: bone, underscored in drake green */
:deep(.md-link) {
  color: var(--color-bone); text-decoration: underline; text-decoration-color: rgba(89, 214, 108, 0.5);
  text-decoration-thickness: 1px; text-underline-offset: 3px; transition: color 0.2s, text-decoration-color 0.2s, text-shadow 0.2s;
}
:deep(.md-link:hover) { color: #fff; text-decoration-color: var(--color-drake); text-shadow: 0 0 14px rgba(89, 214, 108, 0.45); }
:deep(.md-ext)::after { content: '\2197'; font-size: 0.75em; margin-left: 0.15em; color: var(--color-smoke); }

:deep(.md-code) { font-family: var(--font-mono); font-size: 0.85em; background: rgba(0, 0, 0, 0.45); border: 1px solid rgba(58, 82, 70, 0.6); padding: 0 0.3em; border-radius: 2px; }
:deep(.md-pre) { font-family: var(--font-mono); font-size: 0.85rem; background: rgba(0, 0, 0, 0.5); border: 1px solid rgba(58, 82, 70, 0.6); padding: 0.8rem 1rem; border-radius: 2px; overflow-x: auto; box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.7); }
:deep(.md-mention) { background: color-mix(in srgb, var(--role, #5865f2) 22%, transparent); color: var(--role, #c9cdfb); border-radius: 3px; padding: 0 0.25em; font-weight: 600; }

/* spoilers: sealed under hatched iron until struck */
:deep(.md-spoiler) {
  color: transparent; border-radius: 2px; cursor: pointer;
  background: repeating-linear-gradient(135deg, #1d1b18 0 5px, #28231d 5px 10px);
  box-shadow: inset 0 0 0 1px rgba(253, 184, 37, 0.22);
}
:deep(.md-spoiler:hover) { box-shadow: inset 0 0 0 1px rgba(253, 184, 37, 0.5); }
:deep(.md-spoiler) * { visibility: hidden; }
:deep(.md-spoiler.is-shown) { background: rgba(255, 255, 255, 0.06); box-shadow: none; color: inherit; cursor: auto; }
:deep(.md-spoiler.is-shown) * { visibility: visible; }

@media (prefers-reduced-motion: reduce) {
  .is-branding .arch-title, .is-branding :deep(.md-h1), .is-branding :deep(.md-h2) { animation: none; }
}
</style>
