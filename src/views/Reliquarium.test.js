// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { galleryItem, artItem } from '../test-utils/galleryItem'
import { forgetReloads } from '../lib/gallery/reloadOnce'

const state = vi.hoisted(() => ({ auth: null }))
vi.mock('../stores/auth', () => ({ useAuth: () => state.auth }))
vi.mock('../lib/gallery/api')
vi.mock('../lib/librarius/api')
import { getMe, listClips, listArt, listMine, listReview, listEvents } from '../lib/gallery/api'
import { getMe as getLibrariusMe, listPosts, getPost, listMessages, getChanges, markRead } from '../lib/librarius/api'
import { useGallery } from '../stores/gallery'
import { useLibrarius } from '../stores/librarius'
import Reliquarium from './Reliquarium.vue'

const apiError = (status, message = 'nope') => Object.assign(new Error(message), { status })
const deferred = () => {
  let resolve
  const promise = new Promise((res) => (resolve = res))
  return { promise, resolve }
}
const member = () =>
  reactive({
    token: 'tok',
    member: { id: '100000000000000001', isMember: true },
    signedIn: true,
    signIn: vi.fn(),
    noteLibrarius: vi.fn(),
  })
const signedOut = () => reactive({ token: null, member: null, signedIn: false, signIn: vi.fn(), noteLibrarius: vi.fn() })

const mounted = []
async function visit(path = '/reliquarium') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/reliquarium/:tab(librarius|clips|art|submit|mine|review)?', name: 'reliquarium', component: Reliquarium },
      { path: '/reliquarium/librarius/:postId(\\d{17,20})', name: 'reliquarium-post', component: Reliquarium },
    ],
  })
  router.push(path)
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const w = mount(Reliquarium, { global: { plugins: [pinia, router] }, attachTo: document.body })
  mounted.push(w)
  await flushPromises()
  await flushPromises()
  return { w, router }
}
const tabs = (w) => w.findAll('.rq-tab')
const tabNames = (w) => tabs(w).map((t) => t.text())

beforeEach(() => {
  vi.resetAllMocks()
  forgetReloads()
  state.auth = member()
  getMe.mockResolvedValue({ access: true, approver: false })
  // Unless a test says otherwise the reader may not read the Librarius, so that the gallery tests below are of someone who
  // may read the galleries only.
  getLibrariusMe.mockResolvedValue({ access: false })
  listPosts.mockResolvedValue({ posts: [], people: {} })
  listClips.mockResolvedValue({ items: [galleryItem('1', { title: 'A clip' })], next: null })
  listArt.mockResolvedValue({ items: [artItem('2', { title: 'A picture' })], next: null })
  listMine.mockResolvedValue({ items: [] })
  listReview.mockResolvedValue({ items: [], sync: { lastRunAt: null, lastOkAt: null, lastError: null } })
})
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()))

// jsdom has no scrolling, and a post scrolls itself to where the reader means to be.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  window.scrollBy = vi.fn()
})
afterEach(() => {
  delete Element.prototype.scrollIntoView
  delete window.scrollBy
})

describe('Reliquarium: who gets in', () => {
  it('asks the server about a signed-in person, with the token, and shows nothing of the galleries meanwhile', async () => {
    const d = deferred()
    getMe.mockReturnValue(d.promise)
    const { w } = await visit()
    expect(getMe).toHaveBeenCalledWith('tok')
    expect(w.text()).toContain('Checking…')
    expect(w.find('[aria-busy="true"]').exists()).toBe(true)
    expect(tabs(w)).toHaveLength(0)
    expect(listClips).not.toHaveBeenCalled()
    d.resolve({ access: true, approver: false })
    await flushPromises()
    expect(w.text()).not.toContain('Checking…')
    expect(tabs(w).length).toBeGreaterThan(0)
  })

  it('asks a signed-out visitor to sign in, never asks the server, and brings them back to this tab', async () => {
    state.auth = signedOut()
    const { w } = await visit('/reliquarium/art')
    expect(getMe).not.toHaveBeenCalled()
    const signIn = w.findAll('button').find((b) => b.text() === 'Sign in with Discord')
    expect(signIn.classes()).toContain('btn-ember')
    expect(tabs(w)).toHaveLength(0)
    await signIn.trigger('click')
    expect(state.auth.signIn).toHaveBeenCalledWith({ returnTo: '/reliquarium/art' })
  })

  it('keeps out someone the server does not clear', async () => {
    getMe.mockResolvedValue({ access: false, approver: false })
    const { w } = await visit()
    expect(w.text()).toContain('Restricted to the XVIIIth Legion.')
    expect(tabs(w)).toHaveLength(0)
    expect(listClips).not.toHaveBeenCalled()
    expect(w.findAll('button')).toHaveLength(0)
  })

  it('says the Reliquarium could not be reached, and tries again when asked', async () => {
    getMe.mockRejectedValueOnce(apiError(503))
    const { w } = await visit()
    expect(w.find('[role="alert"]').text()).toBe("The Reliquarium couldn't be reached.")
    expect(tabs(w)).toHaveLength(0)
    getMe.mockResolvedValueOnce({ access: true, approver: false })
    await w.findAll('button').find((b) => b.text() === 'Retry').trigger('click')
    await flushPromises()
    expect(getMe).toHaveBeenCalledTimes(2)
    expect(tabs(w).length).toBeGreaterThan(0)
  })

  it('does not keep a list on screen while the store checks again', async () => {
    const { w } = await visit()
    expect(w.find('.rq-grid').exists()).toBe(true)
    const d = deferred()
    getMe.mockReturnValue(d.promise)
    useGallery().load('tok')
    await flushPromises()
    expect(w.find('.rq-grid').exists()).toBe(false)
    expect(tabs(w)).toHaveLength(0)
    d.resolve({ access: true, approver: false })
    await flushPromises()
  })

  it('goes back to asking for sign-in, with the galleries gone, when the person signs out', async () => {
    const { w } = await visit()
    expect(w.find('.rq-grid').exists()).toBe(true)
    state.auth.member = null
    state.auth.token = null
    await flushPromises()
    expect(w.find('.rq-grid').exists()).toBe(false)
    expect(w.text()).toContain('Sign in with Discord')
    expect(useGallery().clips.items).toEqual([])
  })
})

describe('Reliquarium: the tabs', () => {
  it('gives a member Clips, Artwork, Submit and Mine, and no Review', async () => {
    const { w } = await visit()
    expect(tabNames(w)).toEqual(['Clips', 'Artwork', 'Submit', 'Mine'])
  })

  it('gives an approver Review as well, with the number waiting', async () => {
    getMe.mockResolvedValue({ access: true, approver: true })
    listReview.mockResolvedValue({
      items: [artItem('3', { status: 'pending' }), artItem('4', { status: 'pending' })],
      sync: { lastRunAt: null, lastOkAt: null, lastError: null },
    })
    const { w } = await visit()
    expect(tabNames(w)).toEqual(['Clips', 'Artwork', 'Submit', 'Mine', 'Review 2'])
    expect(tabs(w)[4].find('.rq-badge').text()).toBe('2')
  })

  it('shows no number on Review when nothing is waiting', async () => {
    getMe.mockResolvedValue({ access: true, approver: true })
    const { w } = await visit()
    expect(tabNames(w)).toEqual(['Clips', 'Artwork', 'Submit', 'Mine', 'Review'])
    expect(w.find('.rq-badge').exists()).toBe(false)
  })

  it('links each tab to its own address, and marks the one that is open', async () => {
    getMe.mockResolvedValue({ access: true, approver: true })
    const { w } = await visit('/reliquarium/mine')
    expect(tabs(w).map((t) => t.attributes('href'))).toEqual([
      '/reliquarium/clips',
      '/reliquarium/art',
      '/reliquarium/submit',
      '/reliquarium/mine',
      '/reliquarium/review',
    ])
    expect(tabs(w).map((t) => t.attributes('aria-current'))).toEqual([undefined, undefined, undefined, 'page', undefined])
  })

  it('opens on Clips when no tab is in the address', async () => {
    const { w } = await visit('/reliquarium')
    expect(tabs(w)[0].attributes('aria-current')).toBe('page')
    expect(w.findAll('.rq-card')).toHaveLength(1)
    expect(w.text()).toContain('A clip')
  })

  it('opens the tab in the address', async () => {
    const art = await visit('/reliquarium/art')
    expect(art.w.text()).toContain('A picture')
    expect(art.w.text()).not.toContain('A clip')
    const submit = await visit('/reliquarium/submit')
    expect(submit.w.find('input[type="file"]').exists()).toBe(true)
  })

  it('moves to another tab when its link is followed, and keeps the lists it already has', async () => {
    const { w, router } = await visit('/reliquarium/clips')
    await router.push('/reliquarium/art')
    await flushPromises()
    expect(w.text()).toContain('A picture')
    expect(tabs(w)[1].attributes('aria-current')).toBe('page')
    await router.push('/reliquarium/clips')
    await flushPromises()
    expect(w.text()).toContain('A clip')
    expect(listClips).toHaveBeenCalledTimes(1)
  })
})

describe('Reliquarium: the Review tab', () => {
  it('shows a member the Clips instead, marked as the open tab, when they go to /review', async () => {
    const { w, router } = await visit('/reliquarium/review')
    expect(tabs(w)[0].attributes('aria-current')).toBe('page')
    expect(w.text()).toContain('A clip')
    expect(w.text()).not.toContain('Clips poll')
    expect(router.currentRoute.value.fullPath).toBe('/reliquarium/review')
    expect(listReview).not.toHaveBeenCalled()
  })

  it('shows an approver the queue at /review, with the poll line', async () => {
    getMe.mockResolvedValue({ access: true, approver: true })
    listReview.mockResolvedValue({
      items: [artItem('3', { status: 'pending', title: 'Waiting piece' })],
      sync: { lastRunAt: null, lastOkAt: null, lastError: null },
    })
    const { w } = await visit('/reliquarium/review')
    expect(tabs(w)[4].attributes('aria-current')).toBe('page')
    expect(w.text()).toContain('Waiting piece')
    expect(w.text()).toContain('Clips poll: last run never, last success never')
    expect(listReview).toHaveBeenCalledTimes(1)
    // the activity log is on this tab, shut, and has asked for nothing
    expect(w.find('.rq-events-toggle').text()).toBe('Recent activity')
    expect(listEvents).not.toHaveBeenCalled()
  })

  it('shows a member no activity log, on any tab', async () => {
    for (const path of ['/reliquarium/clips', '/reliquarium/review', '/reliquarium/mine']) {
      const { w } = await visit(path)
      expect(w.find('.rq-events-toggle').exists(), path).toBe(false)
    }
  })

  it('fetches an approver\'s queue for the number on the tab even from another tab, and a member\'s never', async () => {
    getMe.mockResolvedValue({ access: true, approver: true })
    await visit('/reliquarium/clips')
    expect(listReview).toHaveBeenCalledWith('tok')
    expect(listReview).toHaveBeenCalledTimes(1)
    vi.clearAllMocks()
    getMe.mockResolvedValue({ access: true, approver: false })
    await visit('/reliquarium/clips')
    expect(listReview).not.toHaveBeenCalled()
  })

  it('does not fetch the queue a second time when an approver lands on it', async () => {
    getMe.mockResolvedValue({ access: true, approver: true })
    await visit('/reliquarium/review')
    expect(listReview).toHaveBeenCalledTimes(1)
  })
})

describe('Reliquarium: the lists wait for the check', () => {
  it('fetches Mine only once the person is cleared', async () => {
    const d = deferred()
    getMe.mockReturnValue(d.promise)
    await visit('/reliquarium/mine')
    expect(listMine).not.toHaveBeenCalled()
    d.resolve({ access: true, approver: false })
    await flushPromises()
    expect(listMine).toHaveBeenCalledWith('tok')
  })

  it('never fetches anything for someone refused', async () => {
    getMe.mockResolvedValue({ access: false, approver: false })
    await visit('/reliquarium/mine')
    for (const call of [listClips, listArt, listMine, listReview]) expect(call).not.toHaveBeenCalled()
  })
})

// The Librarius, the first tab for whoever Discord lets read it. Every id and name here is invented.
const mid = (n) => String(200000000000000000n + BigInt(n))
const GUILD = mid(400)
const FORUM = mid(401)
const POST = mid(402)
const OTHER_POST = mid(403)
const TOR = mid(410)
const TAG = mid(420)
const LIBRARIUS_ME = { access: true, ready: true, tags: [{ id: TAG, name: 'Lore' }], roles: [], guildId: GUILD, forumId: FORUM }
const topic = (id, title) => ({
  id,
  title,
  tagIds: [],
  pinned: false,
  locked: false,
  archived: false,
  createdAt: '2026-11-01T10:00:00.000Z',
  lastActivityAt: '2026-11-10T10:00:00.000Z',
  replies: 3,
  unread: 0,
  latest: { id: mid(460), authorId: TOR, authorName: 'Tor Mardan', authorAvatar: null, content: 'Hello there', image: null },
  posterIds: [TOR],
})
const postMessage = (id, content) => ({
  id,
  authorId: TOR,
  authorName: 'Tor Mardan',
  authorAvatar: null,
  content,
  createdAt: '2026-11-08T21:14:00.000Z',
  editedAt: null,
  replyTo: null,
  attachments: [],
  embeds: [],
  stickers: [],
  reactions: [],
  origin: 'discord',
})
const aPost = (id, title) => ({
  id,
  ownerId: TOR,
  title,
  tagIds: [],
  pinned: false,
  locked: false,
  archived: false,
  createdAt: '2026-11-08T21:14:00.000Z',
  replies: 1,
})

// The Librarius answers for a reader who may read it: the list of two posts, and a post's own page.
function librariusAllows(me = LIBRARIUS_ME) {
  getLibrariusMe.mockResolvedValue(me)
  listPosts.mockResolvedValue({ posts: [topic(POST, 'The Long Road'), topic(OTHER_POST, 'Another Road')], people: {} })
  getPost.mockImplementation(async (_token, id) => ({ post: aPost(id, id === POST ? 'The Long Road' : 'Another Road'), lastRead: null, rev: '40' }))
  // Both the page of messages and the question about the post's opening message are answered by the opening message.
  listMessages.mockImplementation(async (_token, id) => ({
    messages: [postMessage(id, `Opening words of ${id}`)],
    hasOlder: false,
    hasNewer: false,
    people: {},
    rev: '40',
  }))
  getChanges.mockResolvedValue({ messages: [], deleted: [], rev: '41', people: {} })
  markRead.mockResolvedValue(null)
}
const galleryRefuses = () => getMe.mockResolvedValue({ access: false, approver: false })
const topics = (w) => w.findAll('.lb-topic-title').map((t) => t.text())
const currentTabs = (w) => tabs(w).filter((t) => t.attributes('aria-current') === 'page').map((t) => t.text())

describe('Reliquarium: the Librarius tab', () => {
  it('is the first tab, ahead of the gallery\'s, for someone who may read both', async () => {
    librariusAllows()
    const { w } = await visit('/reliquarium/librarius')
    expect(tabNames(w)).toEqual(['Librarius', 'Clips', 'Artwork', 'Submit', 'Mine'])
    expect(tabs(w).map((t) => t.attributes('href'))).toEqual([
      '/reliquarium/librarius',
      '/reliquarium/clips',
      '/reliquarium/art',
      '/reliquarium/submit',
      '/reliquarium/mine',
    ])
    expect(currentTabs(w)).toEqual(['Librarius'])
  })

  it('goes ahead of Review too, for an approver', async () => {
    librariusAllows()
    getMe.mockResolvedValue({ access: true, approver: true })
    const { w } = await visit()
    expect(tabNames(w)).toEqual(['Librarius', 'Clips', 'Artwork', 'Submit', 'Mine', 'Review'])
  })

  it('asks the server about the Librarius with the token, and shows the topic list on the tab', async () => {
    librariusAllows()
    const { w } = await visit('/reliquarium/librarius')
    expect(getLibrariusMe).toHaveBeenCalledWith('tok')
    expect(listPosts).toHaveBeenCalledWith('tok')
    expect(topics(w)).toEqual(['The Long Road', 'Another Road'])
    expect(w.find('.rq-grid').exists()).toBe(false)
  })

  it('opens on the Librarius when no tab is in the address, and fetches no gallery for it', async () => {
    librariusAllows()
    const { w, router } = await visit('/reliquarium')
    expect(currentTabs(w)).toEqual(['Librarius'])
    expect(topics(w)).toEqual(['The Long Road', 'Another Road'])
    expect(listClips).not.toHaveBeenCalled()
    expect(router.currentRoute.value.fullPath).toBe('/reliquarium')
  })

  it('opens on Clips when the Librarius is not for the reader, and the address names no tab', async () => {
    const { w } = await visit('/reliquarium')
    expect(currentTabs(w)).toEqual(['Clips'])
    expect(listPosts).not.toHaveBeenCalled()
  })

  it('opens the gallery tab in the address even where the Librarius is the default', async () => {
    librariusAllows()
    const { w } = await visit('/reliquarium/art')
    expect(currentTabs(w)).toEqual(['Artwork'])
    expect(w.text()).toContain('A picture')
    expect(listPosts).not.toHaveBeenCalled()
  })

  it('moves between the Librarius and the galleries as the links are followed', async () => {
    librariusAllows()
    const { w, router } = await visit('/reliquarium/librarius')
    await router.push('/reliquarium/clips')
    await flushPromises()
    expect(currentTabs(w)).toEqual(['Clips'])
    expect(w.text()).toContain('A clip')
    expect(w.find('.lb-topics').exists()).toBe(false)
    await router.push('/reliquarium/librarius')
    await flushPromises()
    expect(currentTabs(w)).toEqual(['Librarius'])
    expect(topics(w)).toEqual(['The Long Road', 'Another Road'])
  })

  it('has the lede of the page name the Librarius first', async () => {
    librariusAllows()
    const { w } = await visit()
    expect(w.text()).toContain('The Librarius, clips and artwork from the Legion, kept in one place.')
    expect(w.text()).not.toContain('Clips and artwork from the Legion, kept in one place.')
  })
})

describe('Reliquarium: a reader of the Librarius who is not let into the galleries', () => {
  it('sees the Librarius tab and no other', async () => {
    librariusAllows()
    galleryRefuses()
    const { w } = await visit('/reliquarium/librarius')
    expect(tabNames(w)).toEqual(['Librarius'])
    expect(w.text()).not.toContain('Clips')
    expect(w.text()).not.toContain('Artwork')
    expect(w.text()).not.toContain('Restricted to the XVIIIth Legion.')
    expect(topics(w)).toEqual(['The Long Road', 'Another Road'])
  })

  it('is on the Librarius at /reliquarium, and when the address names a gallery tab they may not see', async () => {
    librariusAllows()
    galleryRefuses()
    for (const path of ['/reliquarium', '/reliquarium/clips', '/reliquarium/art', '/reliquarium/submit', '/reliquarium/mine', '/reliquarium/review']) {
      const { w, router } = await visit(path)
      expect(currentTabs(w), path).toEqual(['Librarius'])
      expect(topics(w), path).toEqual(['The Long Road', 'Another Road'])
      expect(router.currentRoute.value.fullPath, path).toBe(path)
    }
    for (const call of [listClips, listArt, listMine, listReview]) expect(call).not.toHaveBeenCalled()
  })

  it('is also let in when the galleries cannot be reached, and sees the Librarius only', async () => {
    librariusAllows()
    getMe.mockRejectedValue(apiError(503))
    const { w } = await visit('/reliquarium')
    expect(tabNames(w)).toEqual(['Librarius'])
    expect(w.find('[role="alert"]').exists()).toBe(false)
  })
})

describe('Reliquarium: a reader of the galleries who is not let into the Librarius', () => {
  it('sees no Librarius tab, and never asks for a post', async () => {
    const { w } = await visit('/reliquarium')
    expect(tabNames(w)).toEqual(['Clips', 'Artwork', 'Submit', 'Mine'])
    expect(w.find('a[href^="/reliquarium/librarius"]').exists()).toBe(false)
    expect(w.find('.lb-topics').exists()).toBe(false)
    expect(listPosts).not.toHaveBeenCalled()
  })

  it('is shown the Clips for an address that names the Librarius, or one of its posts', async () => {
    for (const path of ['/reliquarium/librarius', `/reliquarium/librarius/${POST}`]) {
      vi.clearAllMocks()
      const { w, router } = await visit(path)
      expect(currentTabs(w), path).toEqual(['Clips'])
      expect(w.text(), path).toContain('A clip')
      expect(router.currentRoute.value.fullPath, path).toBe(path)
      expect(listPosts, path).not.toHaveBeenCalled()
      expect(getPost, path).not.toHaveBeenCalled()
    }
  })

  it('stays out of the Librarius when its answer is an outage or a refused token, and keeps the galleries', async () => {
    for (const failure of [apiError(503), apiError(401), apiError(403), new Error('offline')]) {
      getLibrariusMe.mockRejectedValue(failure)
      const { w } = await visit('/reliquarium')
      expect(tabNames(w), String(failure.status)).toEqual(['Clips', 'Artwork', 'Submit', 'Mine'])
    }
  })

  it('takes anything but a plain true from the Librarius for a no', async () => {
    for (const access of ['true', 1, [true], {}, null, undefined, 'yes']) {
      getLibrariusMe.mockResolvedValue({ access, ready: true })
      const { w } = await visit('/reliquarium')
      expect(tabNames(w), String(access)).toEqual(['Clips', 'Artwork', 'Submit', 'Mine'])
    }
    expect(listPosts).not.toHaveBeenCalled()
  })
})

describe('Reliquarium: who is kept out, or asked to sign in', () => {
  it('says "Restricted to the XVIIIth Legion." only when both refuse, and shows nothing of either', async () => {
    galleryRefuses()
    getLibrariusMe.mockResolvedValue({ access: false })
    const { w } = await visit('/reliquarium/librarius')
    expect(w.text()).toContain('Restricted to the XVIIIth Legion.')
    expect(tabs(w)).toHaveLength(0)
    expect(w.findAll('button')).toHaveLength(0)
    for (const call of [listClips, listArt, listMine, listReview, listPosts, getPost]) expect(call).not.toHaveBeenCalled()
  })

  it('treats a 403 from the Librarius as a refusal too', async () => {
    galleryRefuses()
    getLibrariusMe.mockRejectedValue(apiError(403))
    const { w } = await visit()
    expect(w.text()).toContain('Restricted to the XVIIIth Legion.')
  })

  it('does not say "Restricted" while either answer is still on its way, and the Librarius reader waits for the other', async () => {
    librariusAllows()
    const slow = deferred()
    getMe.mockReturnValue(slow.promise)
    const { w } = await visit('/reliquarium')
    expect(w.text()).toContain('Checking…')
    expect(w.find('[aria-busy="true"]').exists()).toBe(true)
    expect(w.text()).not.toContain('Restricted')
    // Nothing is chosen for the reader while the other answer may still put the Clips ahead of, or behind, the Librarius.
    expect(tabs(w)).toHaveLength(0)
    expect(listClips).not.toHaveBeenCalled()
    expect(listPosts).not.toHaveBeenCalled()
    slow.resolve({ access: true, approver: false })
    await flushPromises()
    expect(tabNames(w)).toEqual(['Librarius', 'Clips', 'Artwork', 'Submit', 'Mine'])
    expect(listClips).not.toHaveBeenCalled()
  })

  it('waits for the Librarius, too, before it shows the galleries', async () => {
    const slow = deferred()
    getLibrariusMe.mockReturnValue(slow.promise)
    const { w } = await visit('/reliquarium')
    expect(w.text()).toContain('Checking…')
    expect(tabs(w)).toHaveLength(0)
    expect(listClips).not.toHaveBeenCalled()
    slow.resolve({ access: false })
    await flushPromises()
    expect(tabNames(w)).toEqual(['Clips', 'Artwork', 'Submit', 'Mine'])
  })

  it('does not keep the page on screen while the Librarius store checks again', async () => {
    librariusAllows()
    const { w } = await visit('/reliquarium/librarius')
    expect(w.find('.lb-topics').exists()).toBe(true)
    const slow = deferred()
    getLibrariusMe.mockReturnValue(slow.promise)
    useLibrarius().load('tok')
    await flushPromises()
    expect(w.find('.lb-topics').exists()).toBe(false)
    expect(tabs(w)).toHaveLength(0)
    slow.resolve(LIBRARIUS_ME)
    await flushPromises()
    expect(w.find('.lb-topics').exists()).toBe(true)
  })

  it('asks for sign-in when both servers refuse the token', async () => {
    getMe.mockRejectedValue(apiError(401))
    getLibrariusMe.mockRejectedValue(apiError(401))
    const { w } = await visit('/reliquarium/librarius')
    expect(w.text()).toContain('Sign in with Discord to see the Reliquarium.')
    expect(w.findAll('button').filter((b) => b.text() === 'Sign in with Discord')).toHaveLength(1)
    expect(tabs(w)).toHaveLength(0)
    expect(state.auth.noteLibrarius).not.toHaveBeenCalled()
  })

  it('does not ask for sign-in while only one server refuses the token', async () => {
    getMe.mockRejectedValue(apiError(401))
    getLibrariusMe.mockResolvedValue({ access: false })
    const { w } = await visit('/reliquarium')
    expect(w.text()).not.toContain('Sign in with Discord')
    expect(w.text()).not.toContain('Restricted')
    expect(w.find('[role="alert"]').text()).toBe("The Reliquarium couldn't be reached.")
  })

  it('asks a signed-out visitor to sign in, once for both, and asks the server nothing', async () => {
    state.auth = signedOut()
    const { w } = await visit('/reliquarium/librarius')
    expect(getMe).not.toHaveBeenCalled()
    expect(getLibrariusMe).not.toHaveBeenCalled()
    const signIns = w.findAll('button').filter((b) => b.text() === 'Sign in with Discord')
    expect(signIns).toHaveLength(1)
    expect(w.text()).toContain('Sign in with Discord to see the Reliquarium.')
    expect(tabs(w)).toHaveLength(0)
    await signIns[0].trigger('click')
    expect(state.auth.signIn).toHaveBeenCalledWith({ returnTo: '/reliquarium/librarius' })
  })

  it('brings a signed-out visitor back to the post they came for', async () => {
    state.auth = signedOut()
    const { w } = await visit(`/reliquarium/librarius/${POST}`)
    await w.findAll('button').find((b) => b.text() === 'Sign in with Discord').trigger('click')
    expect(state.auth.signIn).toHaveBeenCalledWith({ returnTo: `/reliquarium/librarius/${POST}` })
  })

  it('says the Reliquarium could not be reached when the Librarius cannot be, and the galleries refuse', async () => {
    galleryRefuses()
    getLibrariusMe.mockRejectedValue(apiError(503))
    const { w } = await visit()
    expect(w.find('[role="alert"]').text()).toBe("The Reliquarium couldn't be reached.")
    expect(w.text()).not.toContain('Restricted')
    expect(tabs(w)).toHaveLength(0)
  })

  it('says it too when the galleries cannot be reached and the Librarius refuses, and Retry asks both again', async () => {
    getMe.mockRejectedValueOnce(apiError(503))
    getLibrariusMe.mockResolvedValueOnce({ access: false })
    const { w } = await visit()
    expect(w.find('[role="alert"]').text()).toBe("The Reliquarium couldn't be reached.")
    librariusAllows()
    getMe.mockResolvedValueOnce({ access: true, approver: false })
    await w.findAll('button').find((b) => b.text() === 'Retry').trigger('click')
    await flushPromises()
    expect(getMe).toHaveBeenCalledTimes(2)
    expect(getLibrariusMe).toHaveBeenCalledTimes(2)
    expect(tabNames(w)).toEqual(['Librarius', 'Clips', 'Artwork', 'Submit', 'Mine'])
  })

  it('lets a reader whose Librarius answer was an outage try again from Retry when the galleries refuse', async () => {
    galleryRefuses()
    getLibrariusMe.mockRejectedValueOnce(apiError(503))
    const { w } = await visit('/reliquarium/librarius')
    librariusAllows()
    await w.findAll('button').find((b) => b.text() === 'Retry').trigger('click')
    await flushPromises()
    expect(tabNames(w)).toEqual(['Librarius'])
    expect(topics(w)).toEqual(['The Long Road', 'Another Road'])
  })

  it('goes back to asking for sign-in, with the Librarius gone, when the person signs out', async () => {
    librariusAllows()
    galleryRefuses()
    const { w } = await visit('/reliquarium/librarius')
    expect(topics(w)).toHaveLength(2)
    state.auth.member = null
    state.auth.token = null
    await flushPromises()
    expect(w.find('.lb-topics').exists()).toBe(false)
    expect(w.text()).toContain('Sign in with Discord')
    const store = useLibrarius()
    expect(store.status).toBe('signin')
    expect(store.me).toBeNull()
    expect(store.posts).toEqual([])
    expect(store.post).toBeNull()
  })

  it('takes the Librarius away when the server stops letting the reader read it, and shows the galleries', async () => {
    librariusAllows()
    const { w } = await visit('/reliquarium/librarius')
    expect(currentTabs(w)).toEqual(['Librarius'])
    listPosts.mockRejectedValue(apiError(403))
    await useLibrarius().loadPosts('tok').catch(() => {})
    await flushPromises()
    expect(tabNames(w)).toEqual(['Clips', 'Artwork', 'Submit', 'Mine'])
    expect(currentTabs(w)).toEqual(['Clips'])
    expect(w.text()).toContain('A clip')
  })
})

describe('Reliquarium: while the Librarius is being imported', () => {
  const NOTICE = 'The Librarius is being brought over from Discord. Check back in a few minutes.'

  it('keeps the Librarius tab, and says so in place of the list, asking for no posts', async () => {
    librariusAllows({ ...LIBRARIUS_ME, ready: false })
    galleryRefuses()
    const { w } = await visit('/reliquarium/librarius')
    expect(tabNames(w)).toEqual(['Librarius'])
    expect(w.text()).toContain(NOTICE)
    expect(w.find('.lb-topics').exists()).toBe(false)
    expect(listPosts).not.toHaveBeenCalled()
  })

  it('says so in place of a post, asking for none', async () => {
    librariusAllows({ ...LIBRARIUS_ME, ready: false })
    galleryRefuses()
    const { w } = await visit(`/reliquarium/librarius/${POST}`)
    expect(w.text()).toContain(NOTICE)
    expect(w.find('.lb-post').exists()).toBe(false)
    expect(getPost).not.toHaveBeenCalled()
    expect(listMessages).not.toHaveBeenCalled()
  })

  it('still shows the galleries beside it, and says nothing of the import on them', async () => {
    librariusAllows({ ...LIBRARIUS_ME, ready: false })
    const { w, router } = await visit('/reliquarium/librarius')
    expect(tabNames(w)).toEqual(['Librarius', 'Clips', 'Artwork', 'Submit', 'Mine'])
    await router.push('/reliquarium/clips')
    await flushPromises()
    expect(w.text()).not.toContain(NOTICE)
    expect(w.text()).toContain('A clip')
  })

  it('says nothing of it once the import is done', async () => {
    librariusAllows()
    const { w } = await visit('/reliquarium/librarius')
    expect(w.text()).not.toContain('brought over')
  })
})

describe('Reliquarium: a post', () => {
  it('shows the post the address names, under the Librarius tab, which stays the open tab', async () => {
    librariusAllows()
    const { w } = await visit(`/reliquarium/librarius/${POST}`)
    expect(getPost).toHaveBeenCalledWith('tok', POST)
    expect(w.find('.lb-post-title').text()).toBe('The Long Road')
    expect(w.text()).toContain(`Opening words of ${POST}`)
    expect(w.find('.lb-topics').exists()).toBe(false)
    expect(tabNames(w)).toEqual(['Librarius', 'Clips', 'Artwork', 'Submit', 'Mine'])
    expect(currentTabs(w)).toEqual(['Librarius'])
  })

  it('shows it to a reader of the Librarius alone', async () => {
    librariusAllows()
    galleryRefuses()
    const { w } = await visit(`/reliquarium/librarius/${POST}`)
    expect(w.find('.lb-post-title').text()).toBe('The Long Road')
    expect(tabNames(w)).toEqual(['Librarius'])
  })

  it('opens a post from the list, and comes back to the list by the tab', async () => {
    librariusAllows()
    const { w, router } = await visit('/reliquarium/librarius')
    await w.findAll('.lb-topic').find((a) => a.text().includes('Another Road')).trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe(`/reliquarium/librarius/${OTHER_POST}`)
    expect(w.find('.lb-post-title').text()).toBe('Another Road')
    await tabs(w)[0].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/reliquarium/librarius')
    expect(topics(w)).toEqual(['The Long Road', 'Another Road'])
  })

  it('does not ask whether the reader may read again when a post is opened, so no "Checking…" comes between', async () => {
    librariusAllows()
    const { w, router } = await visit('/reliquarium/librarius')
    await router.push(`/reliquarium/librarius/${POST}`)
    await flushPromises()
    expect(w.find('.lb-post-title').text()).toBe('The Long Road')
    await router.push('/reliquarium/librarius')
    await flushPromises()
    expect(getLibrariusMe).toHaveBeenCalledTimes(1)
    expect(getMe).toHaveBeenCalledTimes(1)
  })

  it('shows another post when the address moves to it, not the old one', async () => {
    librariusAllows()
    const { w, router } = await visit(`/reliquarium/librarius/${POST}`)
    expect(w.find('.lb-post-title').text()).toBe('The Long Road')
    await router.push(`/reliquarium/librarius/${OTHER_POST}`)
    await flushPromises()
    expect(getPost).toHaveBeenLastCalledWith('tok', OTHER_POST)
    expect(w.find('.lb-post-title').text()).toBe('Another Road')
    expect(w.text()).toContain(`Opening words of ${OTHER_POST}`)
    expect(w.text()).not.toContain(`Opening words of ${POST}`)
  })

  it('leaves the post with a hash on its address as the post, for the page to scroll to', async () => {
    librariusAllows()
    const { w, router } = await visit(`/reliquarium/librarius/${POST}#m-${POST}`)
    expect(router.currentRoute.value.hash).toBe(`#m-${POST}`)
    expect(w.find('.lb-post-title').text()).toBe('The Long Road')
  })
})

describe('Reliquarium: it tells the nav what it learned of the Librarius', () => {
  it('says yes when the reader may read it, ready or still being imported', async () => {
    librariusAllows()
    await visit()
    expect(state.auth.noteLibrarius).toHaveBeenCalledTimes(1)
    expect(state.auth.noteLibrarius).toHaveBeenCalledWith(true)

    state.auth = member()
    librariusAllows({ ...LIBRARIUS_ME, ready: false })
    await visit()
    expect(state.auth.noteLibrarius).toHaveBeenCalledTimes(1)
    expect(state.auth.noteLibrarius).toHaveBeenCalledWith(true)
  })

  it('says no when the server refuses the reader, whether or not the galleries let them in', async () => {
    getLibrariusMe.mockResolvedValue({ access: false })
    await visit()
    expect(state.auth.noteLibrarius).toHaveBeenCalledTimes(1)
    expect(state.auth.noteLibrarius).toHaveBeenCalledWith(false)

    state.auth = member()
    getLibrariusMe.mockRejectedValue(apiError(403))
    await visit()
    expect(state.auth.noteLibrarius).toHaveBeenCalledTimes(1)
    expect(state.auth.noteLibrarius).toHaveBeenCalledWith(false)
  })

  it('says nothing when it learned nothing: an outage, a refused token, or no one signed in', async () => {
    for (const failure of [apiError(503), apiError(401), new Error('offline')]) {
      state.auth = member()
      getLibrariusMe.mockRejectedValue(failure)
      await visit()
      expect(state.auth.noteLibrarius, String(failure.status)).not.toHaveBeenCalled()
    }
    state.auth = signedOut()
    await visit()
    expect(state.auth.noteLibrarius).not.toHaveBeenCalled()
  })

  it('says it after the answer, not before', async () => {
    const slow = deferred()
    getLibrariusMe.mockReturnValue(slow.promise)
    await visit()
    expect(state.auth.noteLibrarius).not.toHaveBeenCalled()
    slow.resolve(LIBRARIUS_ME)
    await flushPromises()
    expect(state.auth.noteLibrarius).toHaveBeenCalledWith(true)
  })

  it('does not ask again when the nav is told something new and the member is replaced, which would flicker the page', async () => {
    librariusAllows()
    state.auth.noteLibrarius = vi.fn((access) => {
      state.auth.member = { ...state.auth.member, librarius: access }
    })
    const { w } = await visit('/reliquarium/librarius')
    expect(state.auth.noteLibrarius).toHaveBeenCalledTimes(1)
    expect(getLibrariusMe).toHaveBeenCalledTimes(1)
    expect(getMe).toHaveBeenCalledTimes(1)
    expect(w.text()).not.toContain('Checking…')
    expect(topics(w)).toHaveLength(2)
  })
})
