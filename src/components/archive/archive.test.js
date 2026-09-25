// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { h } from 'vue'
import ArchiveMarkdown from './ArchiveMarkdown'
import ArchiveView from '../../views/ArchiveView.vue'
import ArchiveImage from './ArchiveImage.vue'
import { parse } from '../../lib/archive/markdown'
import { useArchive } from '../../stores/archive'
import { useAuth } from '../../stores/auth'
import { makeIndex, IDS } from '../../lib/archive/testIndex'
import { stashAnchor, takeAnchor } from '../../lib/archive/anchor'

// Only Discord's full-page redirect is stubbed; the real signIn runs.
vi.mock('../../lib/discordAuth', async (orig) => ({ ...(await orig()), beginSignIn: vi.fn() }))

function router() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/:c(accolades|ranks)/:threadId(\\d{17,20})?', component: ArchiveView, props: (r) => ({ collectionKey: r.params.c, threadId: r.params.threadId || null }) },
      { path: '/', component: { render: () => null } },
    ],
  })
}
const textCtx = { link: () => ({ kind: 'text' }), emoji: (n) => `:${n.name}:`, mention: () => ({ label: '@x', color: null }) }

beforeEach(() => {
  setActivePinia(createPinia())
  sessionStorage.clear()
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
})

describe('ArchiveMarkdown hostile input', () => {
  const hostile = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '[x](javascript:alert(1))', '<javascript:alert(1)>',
    '[x](https://ok.io" onmouseover="alert(1))', '**<b>bold</b>**', '||<svg onload=alert(1)>||', '`<script>`',
  ]
  it.each(hostile)('%s renders as inert text', async (src) => {
    const r = router()
    const w = mount(ArchiveMarkdown, { props: { nodes: parse(src), ctx: textCtx }, global: { plugins: [r] } })
    expect(w.findAll('script, img, svg, [onerror], [onload], [onmouseover]').length).toBe(0)
    for (const a of w.findAll('a')) expect(a.attributes('href')).not.toMatch(/^javascript:/i)
  })
})

async function mountView(path, { status = 'ready', signedIn = true, index = makeIndex() } = {}) {
  const r = router()
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuth()
  auth.member = signedIn ? { id: '1', username: 'u', isMember: true } : null
  const archive = useArchive()
  if (status === 'ready') await archive.load('t', { loadArchive: async () => ({ keys: {}, index }) })
  await r.push(path)
  await r.isReady()
  const w = mount(ArchiveView, { props: { collectionKey: path.split('/')[1], threadId: path.split('/')[2]?.split('#')[0] ?? null }, global: { plugins: [r, pinia], stubs: { ArchiveImage: true } } })
  await flushPromises()
  return { w, r, archive }
}

describe('ArchiveView', () => {
  it('landing renders the ToC; no rendered href points at Discord', async () => {
    const { w } = await mountView('/accolades')
    expect(w.text()).toContain('Fixture ToC')
    for (const a of w.findAll('a')) expect(a.attributes('href')).not.toMatch(/discord(app)?\.com|discord\.gg/i)
    expect(w.find('a[href="/ranks/200000000000000001#m-200000000000000011"]').exists()).toBe(true)
  })
  it('fixed external channel mention renders as text, not a link', async () => {
    const { w } = await mountView('/accolades')
    expect(w.find('.md-mention-channel').text()).toBe('#fixture-reports')
  })
  it('dead link follows its fix to the replacement message', async () => {
    const { w } = await mountView(`/accolades/${IDS.A_T2}`)
    expect(w.find(`a[href="/accolades/${IDS.A_T2}#m-${IDS.A_T2_M}"]`).exists()).toBe(true)
  })
  it('non-Discord link is external with noopener', async () => {
    const { w } = await mountView(`/accolades/${IDS.A_T2}`)
    const a = w.find('a.md-ext')
    expect(a.attributes()).toMatchObject({ href: 'https://example.com/wiki', target: '_blank', rel: 'noopener noreferrer' })
  })
  it('system messages (type 4) are not rendered', async () => {
    const { w } = await mountView('/accolades')
    expect(w.text()).not.toContain('renamed')
  })
  it('messages get m-<id> anchors except the thread starter', async () => {
    const { w } = await mountView('/accolades')
    expect(w.find(`#m-${IDS.A_TOC_M2}`).exists()).toBe(true)
    expect(w.find(`#m-${IDS.A_TOC}`).exists()).toBe(false)
  })
  it('unknown thread id → archive not-found, not a crash', async () => {
    const { w } = await mountView('/ranks/999999999999999999')
    expect(w.text()).toContain("isn't in the archive")
  })
  it('a thread from the other collection is not served under this prefix', async () => {
    const { w } = await mountView(`/ranks/${IDS.A_T2}`)
    expect(w.text()).toContain("isn't in the archive")
  })
  it('spoilers start hidden and reveal on click and on keyboard', async () => {
    const { w } = await mountView(`/accolades/${IDS.A_T2}`)
    const s = w.find('.md-spoiler')
    expect(s.attributes('aria-expanded')).toBe('false')
    await s.trigger('keydown', { key: 'Enter' })
    expect(s.attributes('aria-expanded')).toBe('true')
  })
  it('signed out → sign-in prompt, no content, and a message anchor is stashed on sign-in', async () => {
    const { w } = await mountView('/accolades', { status: 'idle', signedIn: false })
    expect(w.text()).toContain('Sign in with Discord')
    expect(w.text()).not.toContain('Fixture')
    history.replaceState(null, '', `/accolades#m-${IDS.A_TOC_M2}`)
    await w.find('button').trigger('click')
    expect(takeAnchor('/accolades')).toBe(`#m-${IDS.A_TOC_M2}`)
  })
  it('a stashed anchor is restored after sign-in once content is ready (cold deep link)', async () => {
    stashAnchor('/accolades', `#m-${IDS.A_TOC_M2}`)
    const { r } = await mountView('/accolades')
    await flushPromises()
    expect(r.currentRoute.value.hash).toBe(`#m-${IDS.A_TOC_M2}`)
  })
  it('an anchor stashed for another thread is not applied here', async () => {
    stashAnchor(`/accolades/${IDS.A_T2}`, `#m-${IDS.A_T2_M}`)
    const { r } = await mountView('/accolades')
    await flushPromises()
    expect(r.currentRoute.value.hash).toBe('')
  })
  it('a refused sign-in clears any pending anchor', async () => {
    stashAnchor('/accolades', `#m-${IDS.A_TOC_M2}`)
    const { ArchiveAccessError } = await import('../../lib/archive/client')
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuth().member = { id: '1', username: 'u', isMember: true }
    const r = router()
    await r.push('/accolades')
    mount(ArchiveView, { props: { collectionKey: 'accolades' }, global: { plugins: [r, pinia] } })
    await useArchive().load('t', { loadArchive: async () => { throw new ArchiveAccessError('restricted') } })
    await flushPromises()
    expect(takeAnchor('/accolades')).toBeNull()
  })
  it.each([
    ['restricted', /doesn't currently hold the role/, null],
    ['unavailable', /couldn't be reached/, 'Try again'],
    ['outdated', /out of date/, 'Reload'],
    ['integrity', /integrity check/, 'Reload'],
    ['unpublished', /hasn't been published/, null],
  ])('error %s shows its message', async (st, re, button) => {
    const r = router()
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuth().member = { id: '1', username: 'u', isMember: true }
    const archive = useArchive()
    await archive.load('t', { loadArchive: async () => { const { ArchiveAccessError } = await import('../../lib/archive/client'); throw new ArchiveAccessError(st) } })
    await r.push('/accolades')
    const w = mount(ArchiveView, { props: { collectionKey: 'accolades' }, global: { plugins: [r, pinia] } })
    expect(w.text()).toMatch(re)
    expect(w.text()).not.toContain('Fixture')
    if (button) expect(w.find('button').text()).toBe(button)
  })
  it('signing out while viewing clears content immediately', async () => {
    const { w, archive } = await mountView('/accolades')
    useAuth().member = null
    await flushPromises()
    expect(archive.status).toBe('idle')
    expect(w.text()).not.toContain('Fixture')
  })
})

describe('ArchiveImage', () => {
  it('a failing asset shows its alt text instead of breaking the page', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const archive = useArchive()
    archive.assetUrl = () => Promise.reject(new Error('404'))
    const w = mount(ArchiveImage, { props: { collectionKey: 'accolades', file: 'x.png', alt: ':fx:' }, global: { plugins: [pinia] } })
    await flushPromises()
    expect(w.find('.arch-img-fallback').text()).toBe(':fx:')
  })
  it('attachments wait for the viewport before loading', async () => {
    const observed = []
    window.IntersectionObserver = class { constructor(cb) { this.cb = cb } observe(el) { observed.push(this) } disconnect() {} }
    const pinia = createPinia()
    setActivePinia(pinia)
    const archive = useArchive()
    let asked = 0
    archive.assetUrl = async () => (asked++, 'blob:x')
    mount(ArchiveImage, { props: { collectionKey: 'accolades', file: 'big.png', alt: 'a', kind: 'attachment' }, global: { plugins: [pinia] } })
    await flushPromises()
    expect(asked).toBe(0)
    observed[0].cb([{ isIntersecting: true }])
    await flushPromises()
    expect(asked).toBe(1)
    delete window.IntersectionObserver
  })
})
