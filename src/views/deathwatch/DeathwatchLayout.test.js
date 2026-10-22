// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { h } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory, RouterView } from 'vue-router'

vi.mock('../../lib/deathwatch/api', () => ({ getMe: vi.fn() }))
vi.mock('../../lib/deathwatch/fixture', () => ({ loadFixture: vi.fn() }))
import { loadFixture } from '../../lib/deathwatch/fixture'
import DeathwatchLayout from './DeathwatchLayout.vue'

async function mountLayout(scene) {
  loadFixture.mockResolvedValue(scene)
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/deathwatch', component: DeathwatchLayout, children: [{ path: '', component: { render: () => h('p', { class: 'child' }, 'the hub') } }] }],
  })
  router.push('/deathwatch')
  await router.isReady()
  const w = mount({ render: () => h(RouterView) }, { global: { plugins: [pinia, router] } })
  await flushPromises()
  return w
}

beforeEach(() => vi.resetAllMocks())

describe('DeathwatchLayout', () => {
  it('frames the page in the Deathwatch theme and shows it to someone cleared', async () => {
    const w = await mountLayout({ _fixture: true, scene: 'allowed', status: 'allowed', commander: false })
    expect(w.find('.dw').exists()).toBe(true)
    expect(w.find('.dw .child').text()).toBe('the hub')
  })

  it('carries the fan-site disclaimer on every screen: the page, and each state of the gate', async () => {
    for (const status of ['allowed', 'denied', 'signin', 'checking', 'unavailable']) {
      const w = await mountLayout({ _fixture: true, scene: status, status, commander: false })
      expect(w.find('.dw .dw-legal').text(), status).toContain('Not affiliated with or endorsed by Games Workshop')
      expect(w.findAll('.dw-legal'), status).toHaveLength(1)
    }
  })

  it('keeps the page out, inside the same frame, for someone who is not', async () => {
    const w = await mountLayout({ _fixture: true, scene: 'denied', status: 'denied', commander: false })
    expect(w.find('.dw').exists()).toBe(true)
    expect(w.find('.child').exists()).toBe(false)
    expect(w.text()).toContain('Your clearance is not on record.')
  })
})
