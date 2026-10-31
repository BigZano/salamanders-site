// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import HeroForge from './HeroForge.vue'
import { useAuth } from '../stores/auth'

const INVITE = 'https://discord.gg/salamanders'
// Opens the guild directly; an invite link shows members Discord's join screen.
const SERVER = 'https://discord.com/channels/1322056087792521269'

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
    ['isMember is truthy but not true', { id: '1', username: 'guest', isMember: 'true' }],
  ])('invites to join when %s', (_, member) => {
    const { discord } = render(member)
    expect(discord.text()).toBe('Join the Chapter')
    expect(discord.attributes('href')).toBe(INVITE)
  })

  it('sends members straight into the server instead of the invite', () => {
    const { discord } = render({ id: '1', username: 'brother', isMember: true })
    expect(discord.text()).toBe('Open the Discord')
    expect(discord.text()).not.toMatch(/join/i)
    expect(discord.attributes('href')).not.toBe(INVITE)
    expect(discord.attributes('target')).toBe('_blank')
    expect(discord.attributes('rel')).toContain('noopener')
  })

  it('the member button links to the Discord server channel URL built from the guild id', () => {
    // The guild id is the Discord server's id, public in every invite link.
    const member = render({ id: '1', username: 'brother', isMember: true }).discord
    expect(member.attributes('href')).toBe(SERVER)
    expect(member.attributes('href')).toMatch(/^https:\/\/discord\.com\/channels\/\d{17,20}$/)

    // Anyone who is not a confirmed member gets the invite, never the server URL.
    for (const visitor of [null, { id: '1', username: 'guest', isMember: false }]) {
      expect(render(visitor).discord.attributes('href')).toBe(INVITE)
    }
  })
})

describe('HeroForge planner button', () => {
  it('still goes to the planner, for members and guests alike', () => {
    for (const member of [null, { id: '1', username: 'brother', isMember: true }]) {
      const { planner } = render(member)
      expect(planner.attributes('href')).toBe('/planner')
      expect(planner.text()).toBe('Open the Perk Builder')
    }
  })
})
