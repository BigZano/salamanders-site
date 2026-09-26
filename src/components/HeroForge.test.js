// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import HeroForge from './HeroForge.vue'
import { useAuth } from '../stores/auth'

const INVITE = 'https://discord.gg/salamanders'

function render(member) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuth().member = member
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)', component: { render: () => null } }],
  })
  // FireText paints on a canvas jsdom doesn't have.
  const w = mount(HeroForge, { global: { plugins: [pinia, router], stubs: { FireText: true } } })
  return { discord: w.get('a.btn-ember'), planner: w.get('a.btn-planner') }
}

beforeEach(() => sessionStorage.clear())

describe('HeroForge Discord button', () => {
  it.each([
    ['signed out', null],
    ['signed in, not in the XVIIIth Legion', { id: '1', username: 'guest', isMember: false }],
    ['signed in, membership unknown', { id: '1', username: 'guest' }],
  ])('invites to join when %s', (_, member) => {
    const { discord } = render(member)
    expect(discord.text()).toBe('Join the Chapter')
    expect(discord.attributes('href')).toBe(INVITE)
  })

  it('offers members the way back into the server instead of joining', () => {
    const { discord } = render({ id: '1', username: 'brother', isMember: true })
    expect(discord.text()).toBe('Open the Discord')
    expect(discord.text()).not.toMatch(/join/i)
    expect(discord.attributes('href')).toBe(INVITE)
    expect(discord.attributes('target')).toBe('_blank')
    expect(discord.attributes('rel')).toContain('noopener')
  })
})

describe('HeroForge planner button', () => {
  it('still goes to the planner, for members and guests alike', () => {
    for (const member of [null, { id: '1', username: 'brother', isMember: true }]) {
      const { planner } = render(member)
      expect(planner.attributes('href')).toBe('/planner')
      expect(planner.text()).toBe('Open the Planner')
    }
  })
})
