// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import LegacyAccolades from './LegacyAccolades.vue'
import { useArchive } from '../stores/archive'
import { useAuth } from '../stores/auth'
import { makeIndex, makeLegacy } from '../lib/archive/testIndex'

// Only Discord's full-page redirect is stubbed; the real signIn runs.
vi.mock('../lib/discordAuth', async (orig) => ({ ...(await orig()), beginSignIn: vi.fn() }))

beforeEach(() => {
  setActivePinia(createPinia())
  sessionStorage.clear()
})

// legacy: the payload to seal into the index, or null for a bundle that predates the page.
async function mountPage({ signedIn = true, ready = true, legacy = makeLegacy() } = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/accolades/legacy', component: LegacyAccolades },
      { path: '/accolades', component: { render: () => null } },
    ],
  })
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuth().member = signedIn ? { id: '1', username: 'u', isMember: true } : null
  if (ready) {
    const index = makeIndex()
    if (legacy === null) delete index.legacy
    else index.legacy = legacy
    await useArchive().load('t', { loadArchive: async () => ({ keys: {}, index }) })
  }
  await router.push('/accolades/legacy')
  await router.isReady()
  const w = mount(LegacyAccolades, { global: { plugins: [router, pinia] } })
  await flushPromises()
  return w
}

describe('LegacyAccolades', () => {
  it('lists the accolades in file order, with their holder counts and the snapshot date', async () => {
    const w = await mountPage()
    expect(w.findAll('.leg-name').map((n) => n.text())).toEqual(['Fixture Laurel', 'Fixture Ember', 'Fixture Ash'])
    expect(w.findAll('.leg-count').map((n) => n.text())).toEqual(['2 holders', '2 holders', 'No holders on record'])
    expect(w.text()).toContain('2026-10-16')
  })

  it('shows holders alphabetically, ignoring case', async () => {
    const w = await mountPage()
    const first = w.findAll('.leg-accolade')[0]
    expect(first.findAll('.rs-name').map((n) => n.text())).toEqual(['Alpha Holder', 'beta holder'])
  })

  it('shows a member who held two accolades under both', async () => {
    const w = await mountPage()
    expect(w.findAll('.rs-name').filter((n) => n.text() === 'Alpha Holder')).toHaveLength(2)
  })

  it('breaks a blurb into paragraphs, and shows no list for a role nobody held', async () => {
    const w = await mountPage()
    const third = w.findAll('.leg-accolade')[2]
    expect(third.findAll('.leg-blurb').map((p) => p.text())).toEqual(['Fixture blurb three.', 'Second paragraph.'])
    expect(third.find('.leg-holders').exists()).toBe(false)
  })

  it('tints a heading with its role colour only when that colour reads on the dark plaque', async () => {
    const w = await mountPage()
    const [laurel, ember, ash] = w.findAll('.leg-name')
    expect(laurel.element.style.color).toBe('rgb(212, 160, 23)')
    expect(ember.attributes('style')).toBeUndefined() // no colour
    expect(ash.attributes('style')).toBeUndefined() // #202020 would vanish
  })

  it('renders hostile names and blurbs as inert text', async () => {
    const legacy = makeLegacy()
    legacy.accolades[0].holders[0].name = '<img src=x onerror=alert(1)>'
    legacy.accolades[0].blurb = '<script>alert(1)</script>'
    const w = await mountPage({ legacy })
    expect(w.findAll('script, img, [onerror]')).toHaveLength(0)
    expect(w.text()).toContain('<img src=x onerror=alert(1)>')
    expect(w.text()).toContain('<script>alert(1)</script>')
  })

  it('offers the two pages of the Accolades tab, with Legacy Accolades as the current page', async () => {
    const w = await mountPage()
    const links = w.find('nav[aria-label="Accolades pages"]').findAll('a')
    expect(links.map((a) => a.text())).toEqual(['Accolades', 'Legacy Accolades'])
    expect(links.map((a) => a.attributes('href'))).toEqual(['/accolades', '/accolades/legacy'])
    expect(links.map((a) => a.attributes('aria-current'))).toEqual([undefined, 'page'])
  })

  it('links back to Accolades, and nowhere near Discord', async () => {
    const w = await mountPage()
    const hrefs = w.findAll('a').map((a) => a.attributes('href'))
    expect(hrefs).toContain('/accolades')
    for (const h of hrefs) expect(h).not.toMatch(/discord(app)?\.com|discord\.gg/i)
  })

  it('says so, and offers the way back, for a bundle sealed before the page existed', async () => {
    const w = await mountPage({ legacy: null })
    expect(w.text()).toContain("haven't been sealed into the archive yet")
    expect(w.find('a[href="/accolades"]').exists()).toBe(true)
    expect(w.find('.leg').exists()).toBe(false)
  })

  it('shows a signed-out visitor the sign-in prompt and none of the content', async () => {
    const w = await mountPage({ signedIn: false, ready: false })
    expect(w.text()).toContain('Sign in with Discord')
    expect(w.text()).not.toContain('Alpha Holder')
    expect(w.text()).not.toContain('Fixture Laurel')
  })
})
