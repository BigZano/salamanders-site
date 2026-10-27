// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { inline } from '../../lib/deathwatch/notables'
import Inline from './Inline'

const render = (text) => mount({ render: () => h('p', h(Inline, { segs: inline(text) })) })

describe('Inline', () => {
  it('renders a link as a real link that opens in a new tab, its text marked up', () => {
    const w = render('See [**the post**](https://discord.com/channels/1/2) now.')
    const a = w.get('a')
    expect(a.attributes()).toMatchObject({ href: 'https://discord.com/channels/1/2', target: '_blank', rel: 'noopener noreferrer' })
    expect(a.get('b').text()).toBe('the post')
    expect(w.text()).toBe('See the post now.')
  })

  it('opens a link to a page of the area in place, as a router link', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:rest(.*)*', component: { render: () => null } }] })
    const w = mount({ render: () => h('p', h(Inline, { segs: inline('See [**Requirements**](/deathwatch/recruitment/requirements).') })) }, { global: { plugins: [router] } })
    const a = w.get('a')
    expect(a.attributes('href')).toBe('/deathwatch/recruitment/requirements')
    expect(a.attributes('target')).toBeUndefined()
    expect(a.get('b').text()).toBe('Requirements')
    await a.trigger('click')
    await router.isReady()
    expect(router.currentRoute.value.fullPath).toBe('/deathwatch/recruitment/requirements')
  })

  it('never makes a link of anything but https, and never renders the text as HTML', () => {
    for (const text of ['[x](javascript:alert(1))', '[x](http://example.com)', '<img src=x onerror=alert(1)>']) {
      const w = render(text)
      expect(w.find('a').exists(), text).toBe(false)
      expect(w.find('img').exists(), text).toBe(false)
      expect(w.text(), text).toBe(text)
    }
  })

  it('renders bold, italic and a focusable spoiler', () => {
    const w = render('**b** *i* ||s||')
    expect(w.get('b').text()).toBe('b')
    expect(w.get('i').text()).toBe('i')
    expect(w.get('span.nm-spl').attributes('tabindex')).toBe('0')
  })
})
