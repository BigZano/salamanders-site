// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import BuildCard from './BuildCard.vue'

const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)', component: { render: () => null } }] })
const build = (author) => ({
  id: 1, title: 'Melta Bulwark', className: 'Bulwark', level: 25, prestige: 0, role: '', notes: '',
  weapons: {}, perks: [], author,
})
const byline = (author) => mount(BuildCard, { props: { build: build(author) }, global: { plugins: [router] } }).find('.b-author').text()

describe('BuildCard byline', () => {
  it("shows the author's Discord display name", () => {
    expect(byline({ id: '1', displayName: 'Vulkan' })).toBe('by Vulkan')
  })

  it('never shows a username, even if one arrives', () => {
    expect(byline({ id: '1', displayName: 'Vulkan', username: 'secret-handle' })).not.toContain('secret-handle')
    expect(byline({ id: '1', username: 'secret-handle' })).toBe('by Community Member')
  })

  it.each([undefined, null, ''])('falls back to Community Member for a missing name (%s)', (displayName) => {
    expect(byline({ id: '1', displayName })).toBe('by Community Member')
  })
})
