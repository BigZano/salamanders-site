// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import EmojiPicker from './EmojiPicker.vue'
import emojis from '../../data/emojis.json'

// Invented ids only (the 200000000000000400 range), and invented names.
const FIRE = '200000000000000430'
const DRAKE = '200000000000000431'
const GROUPS = ['Smileys & Emotion', 'People & Body', 'Animals & Nature', 'Food & Drink', 'Activities', 'Travel & Places', 'Objects', 'Symbols', 'Flags']
const TABS = ['Smileys', 'People', 'Animals', 'Food', 'Activities', 'Travel', 'Objects', 'Symbols', 'Flags', 'This server']

let mounted = []
afterEach(() => {
  for (const w of mounted) w.unmount()
  mounted = []
  document.body.innerHTML = ''
})

function mountPicker(props = {}) {
  const w = mount(EmojiPicker, { props, attachTo: document.body })
  mounted.push(w)
  return w
}
const tab = (w, label) => w.get(`[role="group"][aria-label="Kinds of emoji"] button[aria-label="${label}"]`)
const shown = (w) => w.findAll('.lb-picker-grid button').map((b) => b.attributes('aria-label'))
const search = (w) => w.get('input[type="search"]')

describe('EmojiPicker', () => {
  it('opens on the smileys, every one of them in the list\'s order, each a button named for its emoji', () => {
    const w = mountPicker()
    expect(w.get('[role="dialog"]').attributes('aria-label')).toBe('Emoji')
    const smileys = emojis.filter((e) => e.group === GROUPS[0])
    expect(shown(w)).toEqual(smileys.map((e) => e.name))
    const first = w.get('.lb-picker-grid button')
    expect(first.attributes('type')).toBe('button')
    expect(first.attributes('title')).toBe(smileys[0].name)
    expect(first.text()).toBe(smileys[0].emoji)
  })

  it('has a button for each kind, the one shown pressed, and shows each kind when it is pressed', async () => {
    const w = mountPicker()
    const kinds = w.get('[role="group"][aria-label="Kinds of emoji"]').findAll('button')
    expect(kinds.map((b) => b.attributes('aria-label'))).toEqual(TABS)
    for (const b of kinds) expect(b.attributes('type')).toBe('button')
    for (const [i, group] of GROUPS.entries()) {
      await tab(w, TABS[i]).trigger('click')
      expect(kinds.map((b) => b.attributes('aria-pressed'))).toEqual(TABS.map((_, j) => String(j === i)))
      expect(shown(w)).toEqual(emojis.filter((e) => e.group === group).map((e) => e.name))
    }
  })

  it('puts the search box in focus when it opens', () => {
    const w = mountPicker()
    expect(document.activeElement).toBe(search(w).element)
    expect(search(w).attributes('aria-label')).toBe('Search emoji')
  })

  it('searches the kind shown by name, in any case, and says when nothing matches', async () => {
    const w = mountPicker()
    await search(w).setValue('  GRINNING ')
    expect(shown(w)).toEqual(emojis.filter((e) => e.group === GROUPS[0] && e.name.includes('grinning')).map((e) => e.name))
    expect(shown(w).length).toBeGreaterThan(1)
    await search(w).setValue('dragon of the deep')
    expect(shown(w)).toEqual([])
    expect(w.get('.lb-picker-empty').text()).toBe('No emoji match that.')
  })

  it('gives the emoji pressed, as its text', async () => {
    const w = mountPicker()
    await tab(w, 'Animals').trigger('click')
    const fox = emojis.find((e) => e.name === 'fox')
    await w.get(`.lb-picker-grid button[aria-label="fox"]`).trigger('click')
    expect(w.emitted('pick')).toEqual([[fox.emoji]])
  })

  it('gives the first emoji shown on Enter in the search box, and nothing when none is shown', async () => {
    const w = mountPicker()
    await search(w).setValue('heart')
    await search(w).trigger('keydown', { key: 'Enter' })
    expect(w.emitted('pick')).toEqual([[emojis.find((e) => e.group === GROUPS[0] && e.name.includes('heart')).emoji]])
    await search(w).setValue('no such thing at all')
    await search(w).trigger('keydown', { key: 'Enter' })
    expect(w.emitted('pick')).toHaveLength(1)
  })

  it('shows the server\'s own emoji from Discord\'s emoji pictures, and gives each as <:name:id>, or <a:name:id> when it moves', async () => {
    const w = mountPicker({ custom: [{ id: FIRE, name: 'salamander_fire', animated: false }, { id: DRAKE, name: 'drake', animated: true }] })
    await tab(w, 'This server').trigger('click')
    expect(shown(w)).toEqual([':salamander_fire:', ':drake:'])
    const pictures = w.findAll('.lb-picker-grid img')
    expect(pictures.map((p) => p.attributes('src'))).toEqual([
      `https://cdn.discordapp.com/emojis/${FIRE}.webp?size=48`,
      `https://cdn.discordapp.com/emojis/${DRAKE}.gif?size=48`,
    ])
    for (const p of pictures) expect(p.attributes('alt')).toBe('')
    await w.findAll('.lb-picker-grid button')[0].trigger('click')
    await w.findAll('.lb-picker-grid button')[1].trigger('click')
    expect(w.emitted('pick')).toEqual([[`<:salamander_fire:${FIRE}>`], [`<a:drake:${DRAKE}>`]])
    await search(w).setValue('DRA')
    expect(shown(w)).toEqual([':drake:'])
  })

  it('leaves out a custom emoji whose id or name could not be written as one', async () => {
    const custom = [
      null, 'fire', 7, [], {}, { id: FIRE }, { name: 'fire' },
      { id: Number(FIRE), name: 'fire' }, { id: '12345', name: 'fire' }, { id: `${FIRE}0000`, name: 'fire' }, { id: ` ${FIRE}`, name: 'fire' },
      { id: FIRE, name: 'fi>re' }, { id: FIRE, name: 'fi:re' }, { id: FIRE, name: 'two words' }, { id: FIRE, name: '' }, { id: FIRE, name: 'x'.repeat(33) },
      { id: FIRE, name: ['fire'] }, { id: FIRE, name: 'fire\n' },
      { id: DRAKE, name: 'drake', animated: 'yes' },
    ]
    const w = mountPicker({ custom })
    await tab(w, 'This server').trigger('click')
    expect(shown(w)).toEqual([':drake:'])
    expect(w.get('.lb-picker-grid img').attributes('src')).toBe(`https://cdn.discordapp.com/emojis/${DRAKE}.webp?size=48`)
    await w.get('.lb-picker-grid button').trigger('click')
    expect(w.emitted('pick')).toEqual([[`<:drake:${DRAKE}>`]])
  })

  it('says so when the server has no emoji of its own', async () => {
    const w = mountPicker({ custom: [] })
    await tab(w, 'This server').trigger('click')
    expect(shown(w)).toEqual([])
    expect(w.get('.lb-picker-empty').text()).toBe('This server has no emoji of its own.')
    await search(w).setValue('fire')
    expect(w.get('.lb-picker-empty').text()).toBe('No emoji match that.')
  })

  it('shows 200 at most, and names in it stay text', async () => {
    const custom = Array.from({ length: 250 }, (_, i) => ({ id: `2000000000000${String(i).padStart(5, '0')}`, name: `e${i}` }))
    const standard = [{ emoji: '😀', name: '<img src=x onerror=alert(1)>', group: GROUPS[0] }]
    const w = mountPicker({ custom, standard })
    expect(shown(w)).toEqual(['<img src=x onerror=alert(1)>'])
    expect(w.find('.lb-picker-grid img').exists()).toBe(false)
    await tab(w, 'This server').trigger('click')
    expect(shown(w)).toHaveLength(200)
    expect(shown(w)[199]).toBe(':e199:')
  })

  it('closes on Escape, and keeps the key to itself', async () => {
    let outside = 0
    const w = mountPicker()
    document.body.addEventListener('keydown', () => outside++)
    await search(w).trigger('keydown', { key: 'Escape' })
    expect(w.emitted('close')).toHaveLength(1)
    expect(outside).toBe(0)
    await search(w).trigger('keydown', { key: 'a' })
    expect(w.emitted('close')).toHaveLength(1)
  })
})
