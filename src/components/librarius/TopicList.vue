<script setup>
// The Librarius topic list, the first tab of the Reliquarium: the forum's posts as rows, pinned ones on top, with a tag
// filter, a sort, the archived posts behind a button, and a button to start a post in Discord (posts are started there
// only). Each row shows the title, its tags, how many messages the reader has not seen, who wrote the newest message and
// its first line, a thumbnail when that message carries a picture, the reply count, the time of the last activity and the
// last three people to post. It asks the server for the list when it is shown and again every 30 seconds while the page is
// visible. What Discord sends goes on the page as text, never as markup. Styles are in librarius.css.
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useAuth } from '../../stores/auth'
import { useLibrarius } from '../../stores/librarius'
import { ago, excerpt, isSpoilerFile, repliesText, sortPosts } from '../../lib/librarius/layout'
import { attachmentUrl } from '../../lib/librarius/render'
import { initials, safeAvatar } from '../../lib/rosterAvatar'
import './librarius.css'

const POLL_MS = 30_000
const SNOWFLAKE = /^\d{17,20}$/
const SORTS = [
  { key: 'activity', label: 'Latest activity' },
  { key: 'created', label: 'Newest' },
]

const store = useLibrarius()
const auth = useAuth()

const tag = ref(null)
const sort = ref('activity')
const showArchived = ref(false)
// A thumbnail or an avatar that failed to load, by its address: a renewed link is a new address, so it is tried again.
const failedThumbs = reactive(new Set())
const failedAvatars = reactive(new Set())

// Whether the first answer has come, and whether the last ask failed. A failure shows only while there is nothing else to
// show: a list already on the page stays through a poll that fails.
const settled = ref(false)
const failed = ref(false)

async function refresh() {
  try {
    await store.loadPosts(auth.token)
    failed.value = false
  } catch {
    failed.value = true
  } finally {
    settled.value = true
  }
}

// One chain of timeouts, not an interval, so that a slow answer is never asked again on top of itself.
let timer = null
let stopped = false
function wait() {
  timer = setTimeout(async () => {
    if (document.visibilityState === 'visible') await refresh()
    if (!stopped) wait()
  }, POLL_MS)
}

// The poll waits for the first answer, so that a slow first answer is never asked again on top of itself.
onMounted(() => {
  refresh().finally(() => {
    if (!stopped) wait()
  })
})
onBeforeUnmount(() => {
  stopped = true
  clearTimeout(timer)
})

const tags = computed(() => (Array.isArray(store.me?.tags) ? store.me.tags : []))
const tagNames = computed(() => new Map(tags.value.map((t) => [t.id, t.name])))

const discord = computed(() => {
  const { guildId, forumId } = store.me ?? {}
  const ids = [guildId, forumId]
  return ids.every((id) => typeof id === 'string' && SNOWFLAKE.test(id)) ? `https://discord.com/channels/${guildId}/${forumId}` : null
})

const known = (id) => (Object.hasOwn(store.people, id) ? store.people[id] : null)

const number = (n) => n.toLocaleString('en')
// What the server sends for a part of a row may be odd: a part that is not what it should be is left out of the row.
const list = (value) => (Array.isArray(value) ? value : [])

function row(post, now) {
  const latest = post.latest
  const posters = list(post.posterIds)
    .slice(0, 3)
    .map(known)
    .filter(Boolean)
    .map((person) => ({ name: person.name, avatar: safeAvatar(person.avatar) }))
  const thumb = latest?.image ? attachmentUrl(latest.image.url) : null
  return {
    id: post.id,
    title: post.title,
    pinned: post.pinned === true,
    archived: post.archived === true,
    unread: Number.isSafeInteger(post.unread) && post.unread > 0 ? post.unread : 0,
    tags: list(post.tagIds).map((id) => tagNames.value.get(id)).filter(Boolean),
    latest: latest && {
      name: known(latest.authorId)?.name || latest.authorName,
      text: typeof latest.content === 'string' ? excerpt(latest.content, 120) : '',
      thumb,
      spoiler: isSpoilerFile(thumb),
    },
    replies: repliesText(post.replies),
    activityAt: post.lastActivityAt,
    activity: ago(post.lastActivityAt, now),
    posters,
  }
}

// The posts the tag chosen allows, in the order chosen, pinned ones first. The sort is stable, so posts that are level
// stay in the order the server sent.
const rows = computed(() => {
  const now = Date.now()
  const chosen = store.posts.filter((post) => tag.value === null || list(post.tagIds).includes(tag.value))
  return sortPosts(chosen, sort.value).map((post) => row(post, now))
})
const open = computed(() => rows.value.filter((r) => !r.archived))
const archived = computed(() => rows.value.filter((r) => r.archived))
const shown = computed(() => (showArchived.value ? [...open.value, ...archived.value] : open.value))
</script>

<template>
  <section class="lb-topics" aria-label="Librarius">
    <p v-if="!settled && store.posts.length === 0" class="lb-note" role="status" aria-busy="true">Loading…</p>

    <div v-else-if="failed && store.posts.length === 0" class="lb-empty panel-forge">
      <p role="alert">The Librarius couldn't be reached.</p>
      <button type="button" class="btn-ember btn-sm" @click="refresh">Retry</button>
    </div>

    <div v-else-if="store.posts.length === 0" class="lb-empty panel-forge">
      <p>Nothing here yet. Posts are started in Discord.</p>
      <a v-if="discord" class="btn-drake btn-sm" :href="discord" target="_blank" rel="noopener noreferrer">Start a post in Discord ↗</a>
    </div>

    <template v-else>
      <div class="lb-toolbar">
        <div v-if="tags.length" class="lb-chips" role="group" aria-label="Filter by tag">
          <button type="button" class="lb-chip" :aria-pressed="tag === null" @click="tag = null">All</button>
          <button v-for="t in tags" :key="t.id" type="button" class="lb-chip" :aria-pressed="tag === t.id" @click="tag = t.id">{{ t.name }}</button>
        </div>
        <select v-model="sort" class="lb-sort" aria-label="Sort posts">
          <option v-for="s in SORTS" :key="s.key" :value="s.key">{{ s.label }}</option>
        </select>
        <a v-if="discord" class="btn-drake btn-sm lb-start" :href="discord" target="_blank" rel="noopener noreferrer">Start a post in Discord ↗</a>
      </div>

      <p v-if="shown.length === 0" class="lb-note">No open posts here.</p>
      <ul v-else class="lb-rows">
        <li v-for="r in shown" :key="r.id">
          <RouterLink class="lb-topic panel-forge" :class="{ 'lb-pinned': r.pinned }" :to="`/reliquarium/librarius/${r.id}`">
            <span class="lb-topic-main">
              <span class="lb-topic-head">
                <span v-if="r.pinned" class="lb-pin">Pinned</span>
                <span class="lb-topic-title">{{ r.title }}</span>
                <span v-for="name in r.tags" :key="name" class="lb-tag">{{ name }}</span>
                <span v-if="r.unread > 0" class="lb-new">{{ number(r.unread) }} new</span>
              </span>
              <span v-if="r.latest" class="lb-topic-latest"><b class="lb-topic-author">{{ r.latest.name }}</b>: <span class="lb-topic-text">{{ r.latest.text }}</span></span>
              <span class="lb-topic-meta">
                <template v-if="r.replies">{{ r.replies }}</template>
                <template v-if="r.replies && r.activity"> · </template>
                <time v-if="r.activity" :datetime="r.activityAt">{{ r.activity }}</time>
                <span v-if="r.posters.length" class="lb-posters" role="img" :aria-label="`Recent posters: ${r.posters.map((p) => p.name).join(', ')}`">
                  <template v-for="(p, i) in r.posters" :key="i">
                    <img v-if="p.avatar && !failedAvatars.has(p.avatar)" class="lb-poster" :src="p.avatar" alt="" width="24" height="24" loading="lazy" @error="failedAvatars.add(p.avatar)" />
                    <span v-else class="lb-poster lb-initials" aria-hidden="true">{{ initials(p.name) }}</span>
                  </template>
                </span>
              </span>
            </span>
            <span v-if="r.latest && r.latest.thumb && !failedThumbs.has(r.latest.thumb)" class="lb-thumb-wrap" :class="{ 'lb-spoiler-thumb': r.latest.spoiler }">
              <img
                class="lb-thumb"
                :class="{ 'lb-blurred': r.latest.spoiler }"
                :src="r.latest.thumb"
                alt=""
                width="72"
                height="72"
                loading="lazy"
                @error="failedThumbs.add(r.latest.thumb)"
              />
              <span v-if="r.latest.spoiler" class="lb-spoiler-tag">Spoiler</span>
            </span>
          </RouterLink>
        </li>
      </ul>

      <button v-if="archived.length" type="button" class="btn-ghost btn-sm lb-archived" @click="showArchived = !showArchived">
        {{ showArchived ? 'Hide' : 'Show' }} archived ({{ archived.length }})
      </button>
    </template>
  </section>
</template>
