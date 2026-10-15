// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, RouterLinkStub } from '@vue/test-utils'

const state = vi.hoisted(() => ({ links: [] }))
vi.mock('../lib/useNavLinks', () => ({ useNavLinks: () => ({ get value() { return state.links } }) }))
import SiteFooter from './SiteFooter.vue'

const BASE = [
  { to: '/', label: 'Home' },
  { to: '/planner', label: 'Perk Builder' },
  { to: '/armoury', label: 'Armoury' },
  { to: '/builds', label: 'Builds' },
  { to: '/companies', label: 'Companies' },
]
const MEMBER = [...BASE, { to: '/reports', label: 'Reports', section: true }]
const render = () => mount(SiteFooter, { global: { stubs: { RouterLink: RouterLinkStub } } })

beforeEach(() => { state.links = BASE })

describe('SiteFooter', () => {
  it('lists every nav link except Home, plus Discord', () => {
    const w = render()
    const routes = w.findAllComponents(RouterLinkStub).map((l) => l.props('to'))
    expect(routes).toEqual(['/planner', '/armoury', '/builds', '/companies'])
    const discord = w.find('a[href="https://discord.gg/salamanders"]')
    expect(discord.exists()).toBe(true)
    expect(discord.attributes('rel')).toBe('noopener')
  })

  it('shows a member-only link to a member and not to a visitor', () => {
    expect(render().text()).not.toContain('Reports')
    state.links = MEMBER
    expect(render().text()).toContain('Reports')
  })

  it('shows the current year in the fine print', () => {
    expect(render().find('.footer-fine').text()).toContain(String(new Date().getFullYear()))
  })
})
