// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import RosterMember from './RosterMember.vue'
import { ROSTER_VIEWER } from '../../lib/rosterContext'

const CDN = 'https://cdn.discordapp.com/avatars/900000000000000001/abc.png?size=64'
const member = (over = {}) => ({ id: '900000000000000001', name: 'Aurelian Ashgrave', avatar: null, company: null, ...over })
const render = (props = {}, options = {}) => mount(RosterMember, { props: { member: member(), ...props }, ...options })

describe('RosterMember', () => {
  it('shows the display name as text, never as HTML', () => {
    const name = '<img src=x onerror=alert(1)>'
    const w = render({ member: member({ name }) })
    expect(w.find('.rs-name').text()).toBe(name)
    expect(w.findAll('img')).toHaveLength(0)
  })

  it('keeps a long emoji name whole in one element', () => {
    const name = '🔥🔥 Aurelian the Unyielding of Nocturne 🔥'
    expect(render({ member: member({ name }) }).find('.rs-name').text()).toBe(name)
  })

  it('shows initials and no image without an avatar', () => {
    const w = render()
    expect(w.find('.rs-avatar').text()).toBe('AA')
    expect(w.find('.rs-avatar').classes()).toContain('rs-initials')
    expect(w.find('img').exists()).toBe(false)
  })

  it('renders the image with width, height and async decoding for an allowlisted URL', () => {
    const w = render({ member: member({ avatar: CDN }) })
    const img = w.find('img.rs-avatar-img')
    expect(img.attributes()).toMatchObject({ src: CDN, width: '64', height: '64', decoding: 'async', alt: '' })
    expect(img.attributes('loading')).toBeUndefined()
    expect(w.find('.rs-avatar').text()).toBe('AA') // the initials stay underneath as the placeholder
    expect(w.find('.rs-avatar').classes()).not.toContain('rs-initials')
  })

  it('holds the image back until imageReady', async () => {
    const w = render({ member: member({ avatar: CDN }), imageReady: false })
    expect(w.find('img').exists()).toBe(false)
    expect(w.find('.rs-avatar').text()).toBe('AA')
    await w.setProps({ imageReady: true })
    expect(w.find('img').exists()).toBe(true)
  })

  it.each([['a foreign origin', 'https://example.com/a.png'], ['a javascript: URL', 'javascript:alert(1)']])(
    'falls back to initials for %s',
    (_, avatar) => {
      const w = render({ member: member({ avatar }) })
      expect(w.find('img').exists()).toBe(false)
      expect(w.find('.rs-avatar').classes()).toContain('rs-initials')
    },
  )

  it('shows the company tag only when it adds something', () => {
    const branch = { kind: 'company', number: 1 }
    expect(render({ member: member({ company: 1 }), branch }).find('.rs-tag').exists()).toBe(false)
    expect(render({ member: member({ company: 3 }), branch }).find('.rs-tag').text()).toBe('3rd')
    expect(render({ member: member({ company: 2 }) }).find('.rs-tag').text()).toBe('2nd')
    expect(render({ member: member({ company: 1 }), branch: { kind: 'specialty' } }).find('.rs-tag').text()).toBe('1st')
  })

  it('shows Acting, Check name and Bot', () => {
    const w = render({ member: member({ acting: true, nameMismatch: true, bot: true }) })
    const badges = w.findAll('.rs-badge')
    expect(badges.map((b) => b.text())).toEqual(['Acting', 'Check name', 'Bot'])
    expect(w.find('.rs-badge.rs-warn').text()).toBe('Check name')
    expect(w.find('.rs-warn').attributes('title')).toMatch(/different company/)
  })

  it('marks the viewer\'s own chip with rs-me and a You tag', () => {
    const provide = { [ROSTER_VIEWER]: ref('900000000000000001') }
    const mine = render({}, { global: { provide } })
    expect(mine.find('li').classes()).toContain('rs-me')
    expect(mine.find('.rs-you').text()).toBe('You')
    const other = render({ member: member({ id: '900000000000000002' }) }, { global: { provide } })
    expect(other.find('li').classes()).not.toContain('rs-me')
    expect(other.find('.rs-you').exists()).toBe(false)
  })

  it('works with no viewer provided', () => {
    expect(render().find('li').classes()).not.toContain('rs-me')
  })

  it('is a list item carrying the member id, and the hero variant adds its class', () => {
    const w = render({ hero: true })
    expect(w.element.tagName).toBe('LI')
    expect(w.attributes('data-id')).toBe('900000000000000001')
    expect(w.classes()).toEqual(expect.arrayContaining(['rs-member', 'rs-hero']))
  })

  it('renders its slot last', () => {
    const w = render({}, { slots: { default: '<span class="extra">x</span>' } })
    expect([...w.element.children].at(-1).className).toBe('extra')
  })
})
