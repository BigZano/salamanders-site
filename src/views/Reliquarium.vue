<script setup>
// The Reliquarium: the Legion's Librarius, clips and art. This page is the gate (it shows them only to someone the
// server clears, and otherwise says why not), the tab bar, and whichever tab the address names. It trusts nothing
// but the server's answers: the `isMember` and `librarius` hints that show the nav entry are not consulted here, and
// the state in the stores only decides what to show (the server checks every read and write again).
//
// Two servers' checks decide who sees what, and they are separate: the galleries' (the Legion role) and the Librarius's
// (Discord's own permissions on its forum, which a person may hold without the role). The page is open to someone either
// lets in, and each adds its own tabs: the Librarius first, then the galleries'. It waits for both answers before it
// chooses a tab, so that the first tab is never the galleries' for a reader who is a moment from being shown the Librarius.
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAuth } from '../stores/auth'
import { useGallery } from '../stores/gallery'
import { useLibrarius } from '../stores/librarius'
import PageHeader from '../components/PageHeader.vue'
import GalleryGrid from '../components/gallery/GalleryGrid.vue'
import SubmitForm from '../components/gallery/SubmitForm.vue'
import MineList from '../components/gallery/MineList.vue'
import ReviewQueue from '../components/gallery/ReviewQueue.vue'
import TopicList from '../components/librarius/TopicList.vue'
import PostPage from '../components/librarius/PostPage.vue'
import '../components/gallery/gallery.css'

const auth = useAuth()
const gallery = useGallery()
const librarius = useLibrarius()
const route = useRoute()

// Asks the Librarius, and tells the nav what it learned, so that its Reliquarium link follows (a person let in, or let out,
// since they signed in). Only an answer says anything: an outage or a refused token leaves what the nav knew as it was.
async function checkLibrarius() {
  await librarius.load(auth.token)
  const { status } = librarius
  if (status === 'allowed' || status === 'importing') auth.noteLibrarius(true)
  else if (status === 'denied') auth.noteLibrarius(false)
}

// auth.token reads storage and isn't reactive; whether auth.member is there is (signing out clears it), so it drives the
// check. It is whether there is a member that is watched, not the member itself: the nav is told what the Librarius said
// by replacing the member, and that must not start the checks again.
// Signing out also empties the stores, so nothing of the last person's lists is left for the next.
watch(
  () => Boolean(auth.member),
  (signedIn) => {
    if (!signedIn) {
      gallery.reset()
      librarius.reset()
    }
    gallery.load(auth.token)
    checkLibrarius()
  },
  { immediate: true },
)

const pending = (status) => status === 'idle' || status === 'checking'
const galleryOpen = computed(() => gallery.status === 'allowed')
// A Librarius still being brought over from Discord is the reader's to see, with a word about the wait.
const librariusOpen = computed(() => librarius.status === 'allowed' || librarius.status === 'importing')
// The Librarius could not be reached: that is no answer about the reader (a rollout, an outage), so it never hides what the
// galleries said. See `gate`, and the note above the tabs.
const librariusDown = computed(() => librarius.status === 'unavailable')

// A second try at the Librarius, from the note above the tabs, is made with the page where it is: the galleries have answered,
// and a Retry that took the page away and put it back would lose whatever was typed into it.
const retrying = ref(false)
const busy = computed(
  () => pending(gallery.status) || (pending(librarius.status) && !(retrying.value && galleryOpen.value)),
)
const open = computed(() => !busy.value && (galleryOpen.value || librariusOpen.value))

// What the gate says while the page is shut, from the two answers. Both settled: both asking to sign in, or both refusing, say
// so, and so does one of them when the other could not be reached; anything else (a server down, or the two at odds) is
// that the Reliquarium could not be reached.
// The exception is a refusal by the galleries while the Librarius cannot be reached, for a reader whom the hint kept at sign-in
// (see discordAuth.js) says may read the Librarius: they are told it is the Librarius that could not be reached, with a Retry for
// it, and not that they are kept out. The hint only picks the message. It shows nothing: what opens is what the server says.
const gate = computed(() => {
  if (busy.value) return 'busy'
  const { status: g } = gallery
  const l = librarius.status
  if (g === 'signin' && (l === 'signin' || l === 'unavailable')) return 'signin'
  if (g === 'denied' && l === 'unavailable' && auth.member?.librarius === true) return 'librarius'
  if (g === 'denied' && (l === 'denied' || l === 'unavailable')) return 'denied'
  return 'unreachable'
})
const signIn = () => auth.signIn({ returnTo: route.fullPath })
const retry = () => {
  gallery.load(auth.token)
  checkLibrarius()
}
async function retryLibrarius() {
  if (retrying.value) return
  retrying.value = true
  try {
    await checkLibrarius()
  } finally {
    retrying.value = false
  }
}

const waiting = computed(() => gallery.review.items.length)
const tabs = computed(() => [
  ...(librariusOpen.value ? [{ key: 'librarius', label: 'Librarius' }] : []),
  ...(galleryOpen.value
    ? [
        { key: 'clips', label: 'Clips' },
        { key: 'art', label: 'Artwork' },
        { key: 'submit', label: 'Submit' },
        { key: 'mine', label: 'Mine' },
        ...(gallery.approver ? [{ key: 'review', label: 'Review' }] : []),
      ]
    : []),
])
// A tab the person may not see (Review, for a member; the Clips, for someone the galleries refuse) shows the first tab they
// may, and marks it as the open tab: the Librarius, else the Clips. A post is on the Librarius tab.
const tab = computed(() => {
  const asked = route.name === 'reliquarium-post' ? 'librarius' : route.params.tab
  return tabs.value.some((t) => t.key === asked) ? asked : tabs.value[0]?.key
})
const onPost = computed(() => route.name === 'reliquarium-post')

// The number on the Review tab is what the queue holds, so an approver's queue is fetched as soon as the page
// opens, whichever tab it opens on. (On the Review tab the queue fetches itself.) Only once the check has settled:
// a new check drops answers that are still on their way.
watch(
  () => gallery.status === 'allowed' && gallery.approver && tab.value !== 'review',
  (wanted) => {
    if (wanted) gallery.loadReview(auth.token).catch(() => {})
  },
  { immediate: true },
)
</script>

<template>
  <section class="rq">
    <PageHeader
      eyebrow="Members only"
      title="Reliquarium"
      lede="The Librarius, clips and artwork from the Legion, kept in one place."
    />

    <div v-if="!open" class="rq-gate surface" :aria-busy="busy ? 'true' : undefined">
      <template v-if="gate === 'signin'">
        <p>Sign in with Discord to see the Reliquarium.</p>
        <button class="btn-ember" type="button" @click="signIn">Sign in with Discord</button>
      </template>
      <p v-else-if="gate === 'busy'" role="status">Checking…</p>
      <template v-else-if="gate === 'librarius'">
        <p role="alert">The Librarius couldn't be reached.</p>
        <button class="btn-ember" type="button" @click="retryLibrarius">Retry</button>
      </template>
      <p v-else-if="gate === 'denied'">Restricted to the XVIIIth Legion.</p>
      <template v-else>
        <p role="alert">The Reliquarium couldn't be reached.</p>
        <button class="btn-ember" type="button" @click="retry">Retry</button>
      </template>
    </div>

    <template v-else>
      <div v-if="(librariusDown || retrying) && galleryOpen" class="rq-outage">
        <p role="status">The Librarius couldn't be reached.</p>
        <button class="btn-ghost btn-sm" type="button" :disabled="retrying" @click="retryLibrarius">Retry</button>
      </div>

      <nav class="rq-tabs" aria-label="Reliquarium sections">
        <RouterLink
          v-for="t in tabs"
          :key="t.key"
          class="rq-tab"
          :to="`/reliquarium/${t.key}`"
          :aria-current="t.key === tab ? 'page' : null"
        >
          {{ t.label }}
          <span v-if="t.key === 'review' && waiting > 0" class="rq-badge">{{ waiting }}</span>
        </RouterLink>
      </nav>

      <template v-if="tab === 'librarius'">
        <div v-if="librarius.status === 'importing'" class="lb-empty panel-forge">
          <p role="status">The Librarius is being brought over from Discord. Check back in a few minutes.</p>
        </div>
        <!-- Keyed by the post, so that another post is a new page, never the old one with a new id. -->
        <PostPage v-else-if="onPost" :key="route.params.postId" :post-id="route.params.postId" />
        <TopicList v-else />
      </template>
      <GalleryGrid v-else-if="tab === 'clips' || tab === 'art'" :key="tab" :kind="tab" />
      <SubmitForm v-else-if="tab === 'submit'" />
      <MineList v-else-if="tab === 'mine'" />
      <ReviewQueue v-else />
    </template>
  </section>
</template>
