// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DOMWrapper, mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import fc from 'fast-check'
import Composer from './Composer.vue'
import ArchiveMarkdown from '../archive/ArchiveMarkdown'
import { parse } from '../../lib/archive/markdown'
import { createRenderCtx } from '../../lib/librarius/render'
import { ACTIONS, apply, asQuote, draftKey, insertBlock } from '../../lib/librarius/composer'
import { MAX_PARTS, budget, limitFor, toDiscord } from '../../../server/src/librariusForm.js'
import { SEARCHES } from '../../lib/librarius/requests'
import { useAuth } from '../../stores/auth'

// Invented ids only (the 200000000000000400 range), and invented names.
const GUILD = '200000000000000400'
const POST = '200000000000000401'
const OTHER_POST = '200000000000000402'
const TOR = '200000000000000410'
const IXEN = '200000000000000411'
const MSG = '200000000000000450'
const OTHER_MSG = '200000000000000451'
const EMOJI = '200000000000000430'
const SITE = 'https://sm2salamanders.site'
const POST_URL = `${SITE}/reliquarium/librarius/${POST}`
const REPLY_URL = `https://discord.com/channels/${GUILD}/${POST}/${MSG}`

const people = {
  [TOR]: { name: 'Tor Mardan', avatar: null },
  [IXEN]: { name: 'Ixen Calloway', avatar: null },
}
const makeCtx = () => createRenderCtx({ guildId: GUILD, postTitles: new Map([[POST, 'The Long Road']]), people, roles: [] })
const IXEN_REPLY = { id: MSG, authorId: IXEN, authorName: 'Ixen Calloway' }

// The toolbar, in its order, by the accessible name of each button.
const NAMES = {
  h1: 'Heading 1',
  h2: 'Heading 2',
  h3: 'Heading 3',
  bold: 'Bold',
  italic: 'Italic',
  underline: 'Underline',
  strike: 'Strikethrough',
  spoiler: 'Spoiler',
  quote: 'Quote',
  code: 'Code',
  bullet: 'Bulleted list',
  numbered: 'Numbered list',
  link: 'Link',
  image: 'Add a picture',
  table: 'Table',
  rule: 'Divider',
  mention: 'Mention someone',
  emoji: 'Emoji',
  subtext: 'Small text',
}
// The three that open something of their own (the file chooser, the member search, the emoji picker) and insert from it.
const OPENERS = ['image', 'mention', 'emoji']

let pinia
let mounted = []
beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  localStorage.clear()
  useAuth().$patch({ member: { id: TOR, username: 'tor', isMember: true, librarius: true } })
})
afterEach(() => {
  for (const w of mounted) w.unmount()
  mounted = []
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const makeRouter = () => createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] })

function mountComposer(props = {}) {
  const w = mount(Composer, {
    props: { postId: POST, postTitle: 'The Long Road', authorId: TOR, authorName: 'Tor Mardan', guildId: GUILD, ctx: makeCtx(), onSend: async () => ({}), ...props },
    global: { plugins: [pinia, makeRouter()] },
    attachTo: document.body,
  })
  mounted.push(w)
  return w
}
// Unmounts a composer before the test ends, as a page that closes it does.
function close(w) {
  w.unmount()
  mounted = mounted.filter((m) => m !== w)
}
// Timers that a test moves on itself; the promises of the page run as they do.
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
const area = (w) => w.get('textarea')
// The composer itself, where it is: full screen, it is teleported to <body>, out of the wrapper (one composer mounted).
const sheet = () => new DOMWrapper(document.querySelector('section.lb-composer'))
const button = (w, name) => {
  const found = w.findAll('button').filter((b) => b.attributes('aria-label') === name || (!b.attributes('aria-label') && b.text() === name))
  expect(found, name).toHaveLength(1)
  return found[0]
}
const replyButton = (w) => button(w, 'Reply')
async function type(w, text, start = text.length, end = start) {
  await area(w).setValue(text)
  area(w).element.setSelectionRange(start, end)
}
const selection = (w) => ({ start: area(w).element.selectionStart, end: area(w).element.selectionEnd })
const reference = (nodes, ctx) => mount(ArchiveMarkdown, { props: { nodes, ctx }, global: { plugins: [makeRouter()] } }).html()
const referenceText = (nodes, ctx) => mount(ArchiveMarkdown, { props: { nodes, ctx }, global: { plugins: [makeRouter()] } }).text()
const failure = (status, message, more = {}) => Object.assign(new Error(message), { status }, more)
const paragraphs = (n, length) => Array.from({ length: n }, () => 'a'.repeat(length)).join('\n\n')
const formOptions = (over = {}) => ({ form: 'v2', authorId: TOR, siteUrl: POST_URL, ...over })
/**
 * → the first length of three paragraphs that the line of the message replied to pushes into a fourth message, or undefined.
 * It is found by halving, since the parts only grow with the length: budget() of 12,000 characters is slow, and a search one
 * length at a time runs past a test's time on a busy machine.
 */
function lengthPushedByReplyLine() {
  const replying = { replyTo: { authorId: IXEN, url: REPLY_URL } }
  const parts = (n, over) => budget(paragraphs(3, n), formOptions(over)).parts
  let lo = 3500
  let hi = 4000
  while (lo < hi) {
    const half = (lo + hi) >> 1
    if (parts(half, replying) >= 4) hi = half
    else lo = half + 1
  }
  return parts(lo, {}) === 3 && parts(lo, replying) === 4 ? lo : undefined
}

describe('Composer: the toolbar', () => {
  it('is a toolbar of named buttons, in the order the design draws them', () => {
    const w = mountComposer()
    const bar = w.get('[role="toolbar"]')
    expect(bar.attributes('aria-label')).toBe('Formatting')
    const names = bar.findAll('button').map((b) => b.attributes('aria-label'))
    expect(names).toEqual(ACTIONS.map((a) => NAMES[a]))
    expect(bar.findAll('[role="group"]').map((g) => g.findAll('button').length)).toEqual([3, 5, 4, 6, 1])
    for (const b of bar.findAll('button')) {
      expect(b.attributes('type')).toBe('button')
      expect(b.attributes('title')).toMatch(/\S/)
    }
  })

  it.each(ACTIONS.filter((a) => !OPENERS.includes(a)))('%s changes the text and the selection as apply() says', async (action) => {
    const w = mountComposer()
    const text = 'Ash plain\nSouth of the road **cool season**'
    await type(w, text, 4, 25)
    await button(w, NAMES[action]).trigger('click')
    await flushPromises()
    const want = apply(text, { start: 4, end: 25 }, action)
    expect(area(w).element.value).toBe(want.text)
    expect(selection(w)).toEqual(want.selection)
    expect(document.activeElement).toBe(area(w).element)
  })

  it('applies an action the page gives it, at the selection, as a picture, a mention or an emoji will be', async () => {
    const w = mountComposer()
    await type(w, 'Ask  now', 4)
    await w.vm.act({ type: 'mention', id: IXEN })
    await flushPromises()
    const want = apply('Ask  now', { start: 4, end: 4 }, { type: 'mention', id: IXEN })
    expect(area(w).element.value).toBe(want.text)
    expect(selection(w)).toEqual(want.selection)
    await w.vm.act({ type: 'emoji', text: `<:fire:${EMOJI}>` })
    await flushPromises()
    expect(area(w).element.value).toBe(apply(want.text, want.selection, { type: 'emoji', text: `<:fire:${EMOJI}>` }).text)
  })

  it('applies one action at a time, and one that is refused stops none after it', async () => {
    const w = mountComposer()
    await type(w, 'Ask ', 4)
    const first = w.vm.act({ type: 'emoji', text: '🔥' })
    const refused = w.vm.act({ type: 'mention', id: 'not an id' })
    const last = w.vm.act({ type: 'emoji', text: '🐉' })
    await first
    await expect(refused).rejects.toThrow(RangeError)
    await last
    expect(area(w).element.value).toBe('Ask 🔥🐉')
    expect(selection(w)).toEqual({ start: 'Ask 🔥🐉'.length, end: 'Ask 🔥🐉'.length })
  })

  it('moves along itself with the arrow keys, Home and End, one button at a time taking the tab stop', async () => {
    const w = mountComposer()
    const buttons = w.get('[role="toolbar"]').findAll('button')
    const stops = () => buttons.map((b) => b.attributes('tabindex'))
    expect(stops()).toEqual(buttons.map((_, i) => (i === 0 ? '0' : '-1')))
    buttons[0].element.focus()
    await buttons[0].trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement).toBe(buttons[1].element)
    expect(stops()[1]).toBe('0')
    expect(stops().filter((s) => s === '0')).toHaveLength(1)
    await buttons[1].trigger('keydown', { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(buttons[0].element)
    await buttons[0].trigger('keydown', { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(buttons.at(-1).element)
    await buttons.at(-1).trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement).toBe(buttons[0].element)
    await buttons[0].trigger('keydown', { key: 'End' })
    expect(document.activeElement).toBe(buttons.at(-1).element)
    await buttons.at(-1).trigger('keydown', { key: 'Home' })
    expect(document.activeElement).toBe(buttons[0].element)
    await buttons[0].trigger('keydown', { key: 'a' })
    expect(document.activeElement).toBe(buttons[0].element)
  })

  it('takes Ctrl or Cmd with B, I and U for bold, italic and underline, and no other key', async () => {
    const w = mountComposer()
    const text = 'the cool season'
    for (const [key, action] of [['b', 'bold'], ['i', 'italic'], ['u', 'underline'], ['B', 'bold']]) {
      for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
        await type(w, text, 4, 8)
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mod })
        area(w).element.dispatchEvent(event)
        await flushPromises()
        expect(event.defaultPrevented).toBe(true)
        expect(area(w).element.value).toBe(apply(text, { start: 4, end: 8 }, action).text)
      }
    }
    for (const init of [{ key: 'b' }, { key: 'k', ctrlKey: true }, { key: 'b', ctrlKey: true, altKey: true }, { key: 'b', ctrlKey: true, shiftKey: true }]) {
      await type(w, text, 4, 8)
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
      area(w).element.dispatchEvent(event)
      await flushPromises()
      expect(event.defaultPrevented).toBe(false)
      expect(area(w).element.value).toBe(text)
    }
  })
})

describe('Composer: the preview', () => {
  const PIECES = [
    '## The Arridian Wastes', '#### Deeper', '###### Deepest', '**cool season**', '*lean*', '__under__', '~~gone~~', '||hidden||', '`code`',
    '```\nblock\n```', '> a quote', '- one', '* two', '1. first', '| a | b |\n| - | - |\n| 1 | 2 |', '---', 'cited[^1]\n\n[^1]: the note',
    '![Ash plain map](upload:1)', `<@${IXEN}>`, `<:fire:${EMOJI}>`, '[a road](https://example.test/road)', 'https://example.test/b',
    `https://discord.com/channels/${GUILD}/${POST}`, 'javascript:alert(1)', '-# small', 'plain words', ' ', '\n', '\n\n', '<b>not markup</b>',
  ]

  it('is the post page\'s own renderer, given the extended markdown of the source', async () => {
    const w = mountComposer()
    const ctx = makeCtx()
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom(...PIECES), { minLength: 1, maxLength: 8 }), fc.constantFrom('', '\n', ' '), async (pieces, glue) => {
        const source = pieces.join(glue)
        if (!/\S/.test(source)) return
        await type(w, source)
        expect(w.get('#' + w.get('[role="tab"][aria-selected="true"]').attributes('aria-controls')).get('.md').html()).toBe(
          reference(parse(source, { dialect: 'extended' }), ctx),
        )
      }),
      { numRuns: 40 },
    )
  })

  it('names a member as the site knows them, and puts no markup of the source on the page', async () => {
    const w = mountComposer()
    await type(w, `Ask <@${IXEN}> about <b>this</b> <img src=x onerror=alert(1)>`)
    const panel = w.get('.md')
    expect(panel.text()).toContain('@Ixen Calloway')
    expect(panel.text()).toContain('<b>this</b>')
    expect(panel.find('b').exists()).toBe(false)
    expect(panel.find('img').exists()).toBe(false)
  })

  it('says there is nothing to show while the source is blank', async () => {
    const w = mountComposer()
    expect(w.find('.md').exists()).toBe(false)
    expect(w.get('[role="tabpanel"]').text()).toBe('Nothing to preview yet.')
    await type(w, '  \n ')
    expect(w.find('.md').exists()).toBe(false)
  })
})

describe('Composer: the tabs', () => {
  it('are real tabs: a tab list, each tab selecting its own panel, the keyboard moving between them', async () => {
    const w = mountComposer()
    const list = w.get('[role="tablist"]')
    const tabs = () => list.findAll('[role="tab"]')
    expect(tabs().map((t) => t.text())).toEqual(['Preview', 'Discord view'])
    const check = (selected) => {
      tabs().forEach((tab, i) => {
        expect(tab.attributes('aria-selected')).toBe(String(i === selected))
        expect(tab.attributes('tabindex')).toBe(i === selected ? '0' : '-1')
      })
      const panel = w.get(`#${tabs()[selected].attributes('aria-controls')}`)
      expect(panel.attributes('role')).toBe('tabpanel')
      expect(panel.attributes('aria-labelledby')).toBe(tabs()[selected].attributes('id'))
      expect(w.findAll('[role="tabpanel"]')).toHaveLength(1)
    }
    check(0)
    await tabs()[1].trigger('click')
    check(1)
    await tabs()[1].trigger('keydown', { key: 'ArrowRight' })
    check(0)
    expect(document.activeElement).toBe(tabs()[0].element)
    await tabs()[0].trigger('keydown', { key: 'ArrowLeft' })
    check(1)
    await tabs()[1].trigger('keydown', { key: 'Home' })
    check(0)
    await tabs()[0].trigger('keydown', { key: 'End' })
    check(1)
    await tabs()[1].trigger('keydown', { key: 'ArrowLeft' })
    check(0)
    await tabs()[0].trigger('keydown', { key: 'Enter' })
    check(0)
  })

  it('give two composers on one page ids of their own', () => {
    const a = mountComposer()
    const b = mountComposer({ postId: OTHER_POST })
    expect(a.get('[role="tab"]').attributes('id')).not.toBe(b.get('[role="tab"]').attributes('id'))
    expect(a.get('[role="tabpanel"]').attributes('id')).not.toBe(b.get('[role="tabpanel"]').attributes('id'))
  })
})

describe('Composer: the Discord view', () => {
  const openDiscord = async (w) => {
    await w.findAll('[role="tab"]')[1].trigger('click')
    return w.get('[role="tabpanel"]')
  }

  it('shows each message Discord will get, its text as Discord reads it, pictures, dividers and the button', async () => {
    const w = mountComposer()
    const source = 'hi ![map](upload:1)\n\n---\n\nyo'
    await type(w, source)
    const panel = await openDiscord(w)
    const parts = panel.findAll('.lb-dv-part')
    expect(parts).toHaveLength(1)
    expect(parts[0].get('.lb-dv-head').text()).toBe('Message 1 of 1')
    const sent = toDiscord(source, { ...formOptions(), images: [{ ref: 1, name: 'image-1.png' }] }).parts[0].components[0].components
    const shown = parts[0].findAll('.lb-dv-block')
    expect(shown.map((b) => b.classes().find((c) => c !== 'lb-dv-block'))).toEqual(['lb-dv-text', 'lb-dv-picture', 'lb-dv-separator', 'lb-dv-text', 'lb-dv-button'])
    const ctx = makeCtx()
    const texts = sent.filter((c) => c.type === 10)
    shown.filter((b) => b.classes('lb-dv-text')).forEach((b, i) => expect(b.get('.md').html()).toBe(reference(parse(texts[i].content), ctx)))
    expect(shown[1].text()).toBe('Picture 1')
    expect(shown[3].text()).toContain('@Tor Mardan')
    expect(shown[4].text()).toBe('Open On Site')
  })

  it('shows a reply over several messages as that many, with their marks and the reply line', async () => {
    const w = mountComposer({ replyTo: IXEN_REPLY })
    const source = paragraphs(2, 3000)
    await type(w, source)
    const panel = await openDiscord(w)
    const want = toDiscord(source, formOptions({ replyTo: { authorId: IXEN, url: REPLY_URL } })).parts
    const parts = panel.findAll('.lb-dv-part')
    expect(parts.map((p) => p.get('.lb-dv-head').text())).toEqual(['Message 1 of 2', 'Message 2 of 2'])
    expect(want).toHaveLength(2)
    parts.forEach((part, k) => expect(part.findAll('.lb-dv-text').map((b) => b.text())).toEqual(
      want[k].components[0].components.filter((c) => c.type === 10).map((c) => referenceText(parse(c.content), makeCtx())),
    ))
    expect(parts[0].text()).toContain('↪ @Ixen Calloway jump')
    expect(parts[0].text()).toContain('1/2')
    expect(parts[1].text()).toContain('2/2')
    expect(parts[0].find('.lb-dv-button').exists()).toBe(false)
    expect(parts[1].find('.lb-dv-button').exists()).toBe(true)
  })

  it('in the plain form, shows each message as its text, with the pictures it carries listed under it', async () => {
    const w = mountComposer({ form: 'plain' })
    const source = `${'b'.repeat(1500)} ![one](upload:1)\n\n${'c'.repeat(1500)} ![two](upload:2) ![three](upload:3)`
    await type(w, source)
    const panel = await openDiscord(w)
    const want = toDiscord(source, formOptions({ form: 'plain', images: [1, 2, 3].map((ref) => ({ ref, name: `image-${ref}.png` })) })).parts
    const parts = panel.findAll('.lb-dv-part')
    expect(parts).toHaveLength(want.length)
    expect(parts).toHaveLength(2)
    parts.forEach((part, k) => {
      expect(part.findAll('.lb-dv-text')).toHaveLength(1)
      expect(part.get('.lb-dv-text .md').html()).toBe(reference(parse(want[k].text), makeCtx()))
    })
    expect(parts[0].get('.lb-dv-files').text()).toBe('Attached: Picture 1')
    expect(parts[1].get('.lb-dv-files').text()).toBe('Attached: Picture 2, Picture 3')
    expect(panel.find('.lb-dv-button').exists()).toBe(false)
  })

  it('says when a reply needs more messages than Discord will be sent', async () => {
    const w = mountComposer()
    await type(w, paragraphs(4, 3000))
    const panel = await openDiscord(w)
    expect(panel.findAll('.lb-dv-part')).toHaveLength(4)
    expect(panel.get('.lb-dv-over').text()).toBe('This needs 4 Discord messages, and a reply may have 3 at most.')
  })

  it('says there is nothing to show while the source is blank', async () => {
    const w = mountComposer()
    const panel = await openDiscord(w)
    expect(panel.text()).toBe('Nothing to preview yet.')
  })
})

describe('Composer: the budget', () => {
  const meter = (w) => w.get('meter')

  it('measures the source as the server will, whatever the source, the form or the message replied to', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 4200 }),
        fc.constantFrom('v2', 'plain'),
        fc.boolean(),
        fc.integer({ min: 0, max: 3 }),
        async (n, length, form, replying, pictures) => {
          const w = mountComposer({ form, replyTo: replying ? IXEN_REPLY : null })
          const source = paragraphs(n, length) + Array.from({ length: pictures }, (_, i) => ` ![p](upload:${i + 1})`).join('')
          await type(w, source)
          const images = Array.from({ length: pictures }, (_, i) => ({ ref: i + 1, name: `image-${i + 1}.png` }))
          const want = budget(source, formOptions({ form, images, replyTo: replying ? { authorId: IXEN, url: REPLY_URL } : null }))
          expect(Number(meter(w).attributes('value'))).toBe(want.used)
          expect(Number(meter(w).attributes('max'))).toBe(want.limit)
          expect(want.limit).toBe(MAX_PARTS * limitFor(form))
          const words = `${want.used.toLocaleString('en')} / ${want.limit.toLocaleString('en')} · ${want.parts} Discord ${want.parts === 1 ? 'message' : 'messages'}`
          expect(w.get('.lb-budget-text').text()).toBe(pictures === 0 ? words : `${words} · ${pictures} ${pictures === 1 ? 'picture' : 'pictures'}`)
          expect(replyButton(w).attributes('disabled') !== undefined).toBe(want.parts > MAX_PARTS)
          close(w)
        },
      ),
      { numRuns: 30 },
    )
  })

  it('disables Reply at the first source that needs a fourth message, and says why', async () => {
    const w = mountComposer()
    await type(w, paragraphs(3, 3000))
    expect(replyButton(w).attributes('disabled')).toBeUndefined()
    expect(w.find('.lb-budget-over').exists()).toBe(false)
    await type(w, paragraphs(4, 3000))
    expect(replyButton(w).attributes('disabled')).toBeDefined()
    expect(w.get('.lb-budget-over').text()).toBe("That's longer than Discord can carry in 3 messages.")
    expect(w.get('.lb-budget').classes()).toContain('lb-over')
  })

  it('counts the line of the message replied to, so a reply it pushes into a fourth message is over', async () => {
    const length = lengthPushedByReplyLine()
    expect(length).toBeDefined()
    const plain = mountComposer()
    await type(plain, paragraphs(3, length))
    expect(replyButton(plain).attributes('disabled')).toBeUndefined()
    const replying = mountComposer({ replyTo: IXEN_REPLY })
    await type(replying, paragraphs(3, length))
    expect(replyButton(replying).attributes('disabled')).toBeDefined()
  })

  it('counts in the form in use, so a reply that fits Components V2 can be over in plain messages', async () => {
    const length = [...Array(400).keys()].map((i) => 1700 + i).find((n) => budget(paragraphs(3, n), formOptions()).parts === 3
      && budget(paragraphs(3, n), formOptions({ form: 'plain' })).parts === 4)
    expect(length).toBeDefined()
    const v2 = mountComposer()
    await type(v2, paragraphs(3, length))
    expect(replyButton(v2).attributes('disabled')).toBeUndefined()
    const plain = mountComposer({ form: 'plain' })
    await type(plain, paragraphs(3, length))
    expect(replyButton(plain).attributes('disabled')).toBeDefined()
  })

  it('is over past the 16,000 characters the server reads, however little of it Discord would show', async () => {
    const w = mountComposer()
    await type(w, `${'\n'.repeat(15_999)}a`)
    expect(budget(area(w).element.value, formOptions()).parts).toBe(1)
    expect(replyButton(w).attributes('disabled')).toBeUndefined()
    await type(w, `${'\n'.repeat(16_000)}a`)
    expect(replyButton(w).attributes('disabled')).toBeDefined()
    expect(w.get('.lb-budget-over').text()).toBe("That's longer than Discord can carry in 3 messages.")
  })

  it('keeps Reply disabled while there is nothing to send', async () => {
    const w = mountComposer()
    expect(replyButton(w).attributes('disabled')).toBeDefined()
    await type(w, ' \n\t ')
    expect(replyButton(w).attributes('disabled')).toBeDefined()
    await type(w, 'x')
    expect(replyButton(w).attributes('disabled')).toBeUndefined()
  })

  it('fails closed when the reply cannot be measured: no meter, and no Reply', async () => {
    const w = mountComposer({ guildId: 'no guild' , replyTo: IXEN_REPLY })
    await type(w, 'Hello')
    expect(w.find('meter').exists()).toBe(false)
    expect(replyButton(w).attributes('disabled')).toBeDefined()
    await w.findAll('[role="tab"]')[1].trigger('click')
    expect(w.get('[role="tabpanel"]').text()).toBe("This reply can't be measured just now.")
  })
})

describe('Composer: drafts', () => {
  beforeEach(fakeTimers)
  const kept = (replyTo = null, postId = POST) => localStorage.getItem(draftKey(postId, replyTo))

  it('keeps the text a second after the last key, and says so', async () => {
    const w = mountComposer()
    await type(w, 'The cool')
    vi.advanceTimersByTime(600)
    await type(w, 'The cool season')
    vi.advanceTimersByTime(999)
    expect(kept()).toBeNull()
    expect(w.find('.lb-draft-saved').exists()).toBe(false)
    vi.advanceTimersByTime(1)
    await nextTick()
    expect(kept()).toBe('The cool season')
    expect(w.get('.lb-draft-saved').text()).toBe('Draft saved')
    await type(w, 'The cool season is')
    expect(w.find('.lb-draft-saved').exists()).toBe(false)
  })

  it('brings the draft back when the composer opens again, for the same post and message only', async () => {
    const first = mountComposer({ replyTo: IXEN_REPLY })
    await type(first, 'South of the road')
    vi.advanceTimersByTime(1000)
    close(first)
    expect(mountComposer({ replyTo: IXEN_REPLY }).get('textarea').element.value).toBe('South of the road')
    expect(mountComposer().get('textarea').element.value).toBe('')
    expect(mountComposer({ postId: OTHER_POST, replyTo: IXEN_REPLY }).get('textarea').element.value).toBe('')
  })

  it('keeps what was typed in the last second when the composer closes', async () => {
    const w = mountComposer()
    await type(w, 'Written just now')
    close(w)
    expect(kept()).toBe('Written just now')
  })

  it('keeps what was typed in the last second when the page goes', async () => {
    const w = mountComposer()
    await type(w, 'Written as the tab closed')
    window.dispatchEvent(new Event('pagehide'))
    expect(kept()).toBe('Written as the tab closed')
    close(w)
    window.dispatchEvent(new Event('pagehide'))
    expect(kept()).toBe('Written as the tab closed')
  })

  it('removes the draft when the text is emptied', async () => {
    localStorage.setItem(draftKey(POST), 'Old words')
    const w = mountComposer()
    expect(area(w).element.value).toBe('Old words')
    await type(w, '')
    vi.advanceTimersByTime(1000)
    expect(kept()).toBeNull()
  })

  it('keeps nothing for a member who has signed out since they typed', async () => {
    const w = mountComposer()
    await type(w, 'Not for the next reader')
    useAuth().signOut()
    vi.advanceTimersByTime(1000)
    expect(kept()).toBeNull()
    close(w)
    expect(kept()).toBeNull()
  })

  it('goes on without a draft in a browser that refuses to keep one, and never says it kept it', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    const w = mountComposer()
    await type(w, 'Too much')
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(w.find('.lb-draft-saved').exists()).toBe(false)
    expect(area(w).element.value).toBe('Too much')
  })

  it('carries the text to the message it now replies to, when that has no draft of its own', async () => {
    const w = mountComposer()
    await type(w, 'Moving words')
    await w.setProps({ replyTo: IXEN_REPLY })
    expect(area(w).element.value).toBe('Moving words')
    expect(kept()).toBeNull()
    expect(kept(MSG)).toBe('Moving words')
    await w.setProps({ replyTo: null })
    expect(area(w).element.value).toBe('Moving words')
    expect(kept(MSG)).toBeNull()
    expect(kept()).toBe('Moving words')
  })

  it('opens the draft of the message it now replies to, keeping the text it had under its own', async () => {
    localStorage.setItem(draftKey(POST, OTHER_MSG), 'Answer to the other')
    const w = mountComposer({ replyTo: IXEN_REPLY })
    await type(w, 'Answer to Ixen')
    await w.setProps({ replyTo: { id: OTHER_MSG, authorId: TOR, authorName: 'Tor Mardan' } })
    expect(area(w).element.value).toBe('Answer to the other')
    expect(kept(MSG)).toBe('Answer to Ixen')
    await w.setProps({ replyTo: IXEN_REPLY })
    expect(area(w).element.value).toBe('Answer to Ixen')
  })

  it('keeps a post\'s text with that post when it is given another', async () => {
    const w = mountComposer()
    await type(w, 'For the first post')
    await w.setProps({ postId: OTHER_POST })
    expect(area(w).element.value).toBe('')
    expect(kept()).toBe('For the first post')
    await w.setProps({ postId: POST })
    expect(area(w).element.value).toBe('For the first post')
  })
})

describe('Composer: sending', () => {
  it('hands the page the source, the message replied to and the ping, and empties itself and its draft once it is sent', async () => {
    let finish
    const onSend = vi.fn(() => new Promise((resolve) => (finish = resolve)))
    const w = mountComposer({ onSend, replyTo: IXEN_REPLY })
    await type(w, 'Sent words')
    window.dispatchEvent(new Event('pagehide'))
    expect(localStorage.getItem(draftKey(POST, MSG))).toBe('Sent words')
    await replyButton(w).trigger('click')
    expect(onSend).toHaveBeenCalledWith({ source: 'Sent words', replyTo: MSG, pingReply: true, mentions: [] })
    expect(replyButton(w).attributes('disabled')).toBeDefined()
    expect(area(w).attributes('readonly')).toBeDefined()
    expect(w.get('[role="toolbar"]').findAll('button').every((b) => b.attributes('disabled') !== undefined)).toBe(true)
    expect(w.get('.lb-sending').text()).toBe('Sending…')
    await replyButton(w).trigger('click')
    expect(onSend).toHaveBeenCalledTimes(1)
    finish({ pending: { key: 'k', state: 'sending' } })
    await flushPromises()
    expect(area(w).element.value).toBe('')
    expect(area(w).attributes('readonly')).toBeUndefined()
    expect(localStorage.getItem(draftKey(POST, MSG))).toBeNull()
    expect(w.emitted('sent')).toEqual([[{ pending: { key: 'k', state: 'sending' } }]])
    expect(w.find('[role="alert"]').exists()).toBe(false)
  })

  it('clears the draft of the message it sent to, and keeps the other\'s, when the reply was moved to another while it was sending', async () => {
    localStorage.setItem(draftKey(POST, OTHER_MSG), 'The other draft')
    let finish
    const onSend = vi.fn(() => new Promise((resolve) => (finish = resolve)))
    const w = mountComposer({ onSend, replyTo: IXEN_REPLY })
    await type(w, 'Sent words')
    await replyButton(w).trigger('click')
    // While it is on its way, the member presses Reply on another message, which has a draft.
    await w.setProps({ replyTo: { id: OTHER_MSG, authorId: TOR, authorName: 'Tor Mardan' } })
    expect(area(w).element.value).toBe('The other draft')
    finish({ pending: { key: 'k', state: 'sending' } })
    await flushPromises()
    expect(area(w).element.value).toBe('The other draft')
    expect(localStorage.getItem(draftKey(POST, OTHER_MSG))).toBe('The other draft')
    expect(localStorage.getItem(draftKey(POST, MSG))).toBeNull()
  })

  it('takes the sent words with it when the reply was moved, while sending, to a message with no draft', async () => {
    let finish
    const onSend = vi.fn(() => new Promise((resolve) => (finish = resolve)))
    const w = mountComposer({ onSend, replyTo: IXEN_REPLY })
    await type(w, 'Sent words')
    await replyButton(w).trigger('click')
    await w.setProps({ replyTo: null })
    finish({ pending: { key: 'k', state: 'sending' } })
    await flushPromises()
    expect(area(w).element.value).toBe('')
    expect(localStorage.getItem(draftKey(POST, MSG))).toBeNull()
    expect(localStorage.getItem(draftKey(POST))).toBeNull()
  })

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Cmd', { metaKey: true }],
  ])('sends with %s+Enter, and gives the focus back to the text once it is sent', async (_, keys) => {
    const onSend = vi.fn(async () => ({}))
    const w = mountComposer({ onSend })
    await type(w, 'By the keys')
    await area(w).trigger('keydown', { key: 'Enter', ...keys })
    await flushPromises()
    expect(onSend).toHaveBeenCalledWith({ source: 'By the keys', replyTo: null, pingReply: false, mentions: [] })
    expect(area(w).element.value).toBe('')
    expect(document.activeElement).toBe(area(w).element)
  })

  it('sends nothing with Enter alone, with Shift or Alt too, or when there is nothing to send', async () => {
    const onSend = vi.fn(async () => ({}))
    const w = mountComposer({ onSend })
    await type(w, 'Not yet')
    for (const keys of [{}, { ctrlKey: true, shiftKey: true }, { metaKey: true, altKey: true }, { shiftKey: true }]) {
      await area(w).trigger('keydown', { key: 'Enter', ...keys })
    }
    await type(w, '   ')
    await area(w).trigger('keydown', { key: 'Enter', ctrlKey: true })
    await flushPromises()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('gives the focus back to the text after the Reply button sent it, and after an edit is saved', async () => {
    const w = mountComposer({ onSend: async () => ({}) })
    await type(w, 'Pressed')
    replyButton(w).element.focus()
    await replyButton(w).trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(area(w).element)
    const edit = mountComposer({ onSend: async () => ({}), editing: { id: MSG, source: 'Old', replyTo: null } })
    await type(edit, 'New')
    button(edit, 'Save edit').element.focus()
    await button(edit, 'Save edit').trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(area(edit).element)
  })

  it('sends no ping for a reply to nobody', async () => {
    const onSend = vi.fn(async () => ({}))
    const w = mountComposer({ onSend })
    await type(w, 'To the post')
    await replyButton(w).trigger('click')
    expect(onSend).toHaveBeenCalledWith({ source: 'To the post', replyTo: null, pingReply: false, mentions: [] })
  })

  it('keeps no draft of a reply that was sent, however late the last save would have been', async () => {
    fakeTimers()
    const w = mountComposer({ onSend: async () => ({}) })
    await type(w, 'Quick one')
    await replyButton(w).trigger('click')
    await settle()
    expect(area(w).element.value).toBe('')
    vi.advanceTimersByTime(2000)
    close(w)
    expect(localStorage.getItem(draftKey(POST))).toBeNull()
  })

  it('on a 403 keeps the text and the draft, and says the member can\'t reply here right now', async () => {
    fakeTimers()
    const w = mountComposer({ onSend: async () => Promise.reject(failure(403, 'This post is locked.')) })
    await type(w, 'Words worth keeping')
    await replyButton(w).trigger('click')
    await settle()
    vi.advanceTimersByTime(1000)
    expect(area(w).element.value).toBe('Words worth keeping')
    expect(localStorage.getItem(draftKey(POST))).toBe('Words worth keeping')
    expect(w.get('[role="alert"]').text()).toBe("You can't reply here right now. This post is locked.")
    expect(replyButton(w).attributes('disabled')).toBeUndefined()
    expect(w.emitted('sent')).toBeUndefined()
  })

  it('on a 403 with no reason of the server\'s, says only that', async () => {
    const w = mountComposer({ onSend: async () => Promise.reject(failure(403, '')) })
    await type(w, 'Words')
    await replyButton(w).trigger('click')
    await flushPromises()
    expect(w.get('[role="alert"]').text()).toBe("You can't reply here right now.")
  })

  it('on an AutoMod refusal names the rule and selects the words it matched in the editor', async () => {
    const w = mountComposer({
      onSend: async () => Promise.reject(failure(422, 'Blocked by the server\'s AutoMod rule "No Heresy".', { rule: 'No Heresy', match: { start: 6, end: 10 } })),
    })
    await type(w, 'Heard zorp today', 0)
    await replyButton(w).trigger('click')
    await flushPromises()
    const alert = w.get('[role="alert"]')
    expect(alert.text()).toContain('Blocked by the server\'s AutoMod rule "No Heresy".')
    expect(alert.text()).toContain('The words it matched are selected in your reply.')
    expect(area(w).element.value).toBe('Heard zorp today')
    expect(selection(w)).toEqual({ start: 6, end: 10 })
    expect(document.activeElement).toBe(area(w).element)
  })

  it('selects a match that ends where the text ends', async () => {
    const w = mountComposer({
      onSend: async () => Promise.reject(failure(422, 'Blocked by the server\'s AutoMod rule "No Heresy".', { rule: 'No Heresy', match: { start: 11, end: 16 } })),
    })
    await type(w, 'Heard zorp today', 0)
    await replyButton(w).trigger('click')
    await flushPromises()
    expect(selection(w)).toEqual({ start: 11, end: 16 })
  })

  it.each([
    ['none', null],
    ['one before the text', { start: -1, end: 3 }],
    ['one past the text', { start: 10, end: 17 }],
    ['one backwards', { start: 5, end: 2 }],
    ['an empty one', { start: 4, end: 4 }],
    ['one of fractions', { start: 1.5, end: 3 }],
    ['one of words', { start: '1', end: '3' }],
    ['no object', 'zorp'],
  ])('on an AutoMod refusal with %s for a match, names the rule and selects nothing', async (_, match) => {
    const w = mountComposer({
      onSend: async () => Promise.reject(failure(422, 'Blocked by the server\'s AutoMod rule "No Heresy".', { rule: 'No Heresy', match })),
    })
    await type(w, 'Heard zorp today', 2)
    await replyButton(w).trigger('click')
    await flushPromises()
    expect(w.get('[role="alert"]').text()).toBe('Blocked by the server\'s AutoMod rule "No Heresy".')
    expect(selection(w)).toEqual({ start: 2, end: 2 })
  })

  it('on an AutoMod refusal with no words of the server\'s, names the rule itself', async () => {
    const w = mountComposer({ onSend: async () => Promise.reject(failure(422, '', { rule: 'No Heresy', match: { start: 0, end: 5 } })) })
    await type(w, 'Heard zorp')
    await replyButton(w).trigger('click')
    await flushPromises()
    expect(w.get('[role="alert"]').text()).toBe('Blocked by the server\'s AutoMod rule "No Heresy". The words it matched are selected in your reply.')
    expect(selection(w)).toEqual({ start: 0, end: 5 })
  })

  it('on a 429 shows the server\'s words, or its own when there are none', async () => {
    const said = mountComposer({ onSend: async () => Promise.reject(failure(429, 'You can reply 3 times a minute. Try again in 20 seconds.')) })
    await type(said, 'Again')
    await replyButton(said).trigger('click')
    await flushPromises()
    expect(said.get('[role="alert"]').text()).toBe('You can reply 3 times a minute. Try again in 20 seconds.')
    expect(area(said).element.value).toBe('Again')
    const silent = mountComposer({ onSend: async () => Promise.reject(failure(429, '')) })
    await type(silent, 'Again')
    await replyButton(silent).trigger('click')
    await flushPromises()
    expect(silent.get('[role="alert"]').text()).toBe("You're replying too fast. Wait a moment and try again.")
  })

  it('on any other answer of the server\'s shows its words, and on no answer at all its own, keeping the text', async () => {
    for (const [error, shown] of [
      [failure(422, "This reply couldn't be checked against the server's rules. Try a shorter one."), "This reply couldn't be checked against the server's rules. Try a shorter one."],
      [failure(503, 'The Librarius is not taking replies just now.'), 'The Librarius is not taking replies just now.'],
      [failure(500, ''), "Couldn't send. Try again."],
      [new TypeError('Failed to fetch'), "Couldn't send. Try again."],
      ['a string', "Couldn't send. Try again."],
      [null, "Couldn't send. Try again."],
    ]) {
      const w = mountComposer({ onSend: async () => Promise.reject(error) })
      await type(w, 'Kept')
      await replyButton(w).trigger('click')
      await flushPromises()
      expect(w.get('[role="alert"]').text()).toBe(shown)
      expect(area(w).element.value).toBe('Kept')
    }
  })

  it('takes the alert away once the text is changed, and again as the next try starts', async () => {
    let calls = 0
    const w = mountComposer({ onSend: () => (++calls <= 2 ? Promise.reject(failure(403, '')) : new Promise(() => {})) })
    await type(w, 'One')
    await replyButton(w).trigger('click')
    await flushPromises()
    expect(w.find('[role="alert"]').exists()).toBe(true)
    await type(w, 'One more')
    expect(w.find('[role="alert"]').exists()).toBe(false)
    await replyButton(w).trigger('click')
    await flushPromises()
    expect(w.find('[role="alert"]').exists()).toBe(true)
    await replyButton(w).trigger('click')
    await nextTick()
    expect(w.find('[role="alert"]').exists()).toBe(false)
    expect(calls).toBe(3)
  })

})

describe('Composer: around the text', () => {
  it('says where the reply goes and who it is posted as', () => {
    const w = mountComposer()
    expect(w.get('.lb-composer-where').text()).toBe('Replying in: The Long Road')
    expect(w.get('.lb-posting-as').text()).toBe('Posting as Tor Mardan (your server name and picture)')
    expect(area(w).attributes('aria-label')).toBe('Your reply, in markdown')
  })

  it('shows the message it replies to, with a ping that can be turned off, and a way to stop replying to it', async () => {
    const onSend = vi.fn(async () => ({}))
    const w = mountComposer({ onSend, replyTo: IXEN_REPLY })
    expect(w.get('.lb-replying-to').text()).toContain('replying to Ixen Calloway')
    const ping = button(w, 'Ping Ixen Calloway')
    expect(ping.attributes('aria-pressed')).toBe('true')
    expect(ping.text()).toBe('@ on')
    await ping.trigger('click')
    expect(ping.attributes('aria-pressed')).toBe('false')
    expect(ping.text()).toBe('@ off')
    await type(w, 'Quietly')
    await replyButton(w).trigger('click')
    expect(onSend).toHaveBeenCalledWith({ source: 'Quietly', replyTo: MSG, pingReply: false, mentions: [] })
    await button(w, 'Stop replying to Ixen Calloway').trigger('click')
    expect(w.emitted('update:replyTo')).toEqual([[null]])
  })

  it('pings again by default for each message it is set to reply to', async () => {
    const w = mountComposer({ replyTo: IXEN_REPLY })
    await button(w, 'Ping Ixen Calloway').trigger('click')
    await w.setProps({ replyTo: { id: OTHER_MSG, authorId: TOR, authorName: 'Tor Mardan' } })
    expect(button(w, 'Ping Tor Mardan').attributes('aria-pressed')).toBe('true')
  })

  it('has no reply bar for a reply to the post itself', () => {
    const w = mountComposer()
    expect(w.find('.lb-replying-to').exists()).toBe(false)
  })

  it('goes full screen and back, by its button or by Escape', async () => {
    const w = mountComposer()
    const full = button(w, 'Full screen')
    expect(full.attributes('aria-pressed')).toBe('false')
    await full.trigger('click')
    expect(full.attributes('aria-pressed')).toBe('true')
    expect(sheet().classes()).toContain('lb-composer-full')
    await area(sheet()).trigger('keydown', { key: 'Escape' })
    expect(full.attributes('aria-pressed')).toBe('false')
    expect(sheet().classes()).not.toContain('lb-composer-full')
    await full.trigger('click')
    await full.trigger('click')
    expect(sheet().classes()).not.toContain('lb-composer-full')
    await area(sheet()).trigger('keydown', { key: 'Escape' })
    expect(sheet().classes()).not.toContain('lb-composer-full')
  })

  // The route's root is a stacking context of its own (its fade), under the site's sticky header: full screen in it, the header would
  // hide the composer's top bar, and on a phone there would be no way out.
  it('goes to the end of <body> while full screen, out of the page, keeping what it holds, and comes back to its place', async () => {
    const page = document.createElement('main')
    document.body.append(page)
    const w = mount(Composer, {
      props: { postId: POST, postTitle: 'The Long Road', authorId: TOR, authorName: 'Tor Mardan', guildId: GUILD, ctx: makeCtx(), onSend: async () => ({}), replyTo: IXEN_REPLY },
      global: { plugins: [pinia, makeRouter()] },
      attachTo: page,
    })
    mounted.push(w)
    await type(w, 'Kept words')
    await button(w, 'Full screen').trigger('click')
    await flushPromises()
    const section = document.querySelector('section.lb-composer')
    expect(section.parentElement).toBe(document.body)
    expect(page.contains(section)).toBe(false)
    expect(section.querySelector('textarea').value).toBe('Kept words')
    expect(section.querySelector('.lb-replying-to').textContent).toContain('Ixen Calloway')
    expect(document.activeElement).toBe(section.querySelector('textarea'))
    await new DOMWrapper(section.querySelector('.lb-full')).trigger('click')
    await flushPromises()
    expect(page.contains(document.querySelector('section.lb-composer'))).toBe(true)
    expect(document.querySelector('section.lb-composer textarea').value).toBe('Kept words')
    expect(document.activeElement).toBe(document.querySelector('section.lb-composer textarea'))
  })
})

// --- slice C3: mentions, emoji and pictures ---

const SEFA = '200000000000000412'
const ORRIN = '200000000000000413'
const SEFA_FOUND = { id: SEFA, name: 'Sefa Orrin', avatar: null }
// Timers and the clock that a test moves on itself (the member search is paced by the clock).
const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
const settled = async () => {
  await settle()
  await nextTick()
}
const dialog = (w, name) => w.find(`[role="dialog"][aria-label="${name}"]`)
const picture = (name = 'map.png') => new File(['not really a picture'], name, { type: 'image/png' })
const fileInput = (w) => w.get('input[type="file"]')
async function choose(w, files) {
  Object.defineProperty(fileInput(w).element, 'files', { value: files, configurable: true })
  await fileInput(w).trigger('change')
}
// An upload the test answers when it likes: what each call was given, and how to answer it.
function uploads() {
  const calls = []
  const upload = (file, n) =>
    new Promise((resolve) => {
      calls.push({ file, n, resolve })
    })
  return { calls, upload, places: () => calls.map((c) => c.n) }
}
// An event the page would get from the browser with files on it (jsdom has no DataTransfer).
function withFiles(type, field, files, types = files.length ? ['Files'] : ['text/plain']) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, field, { value: { files, types } })
  return event
}

describe('Composer: @ mentions', () => {
  async function openSearch(w) {
    await button(w, 'Mention someone').trigger('click')
    await nextTick()
    return dialog(w, 'Mention someone')
  }

  it('@ opens the member search, and the member picked goes in as <@id> at the selection, named in the preview', async () => {
    fakeClock()
    const asked = []
    const w = mountComposer({ searchMembers: async (q) => (asked.push(q), [SEFA_FOUND]) })
    await type(w, 'Ask  now', 4)
    const search = await openSearch(w)
    expect(search.exists()).toBe(true)
    expect(document.activeElement).toBe(search.get('input').element)
    await search.get('input').setValue('Se')
    await vi.advanceTimersByTimeAsync(250)
    await settled()
    expect(asked).toEqual(['Se'])
    await search.get('input').trigger('keydown', { key: 'Enter' })
    await settled()
    const want = apply('Ask  now', { start: 4, end: 4 }, { type: 'mention', id: SEFA })
    expect(area(w).element.value).toBe(want.text)
    expect(selection(w)).toEqual(want.selection)
    expect(document.activeElement).toBe(area(w).element)
    expect(dialog(w, 'Mention someone').exists()).toBe(false)
    // Sefa is in nobody's message on the page, so only the pick can name her.
    expect(w.get('.lb-tabpanel').text()).toContain('@Sefa Orrin')
    expect(w.get('.lb-tabpanel').text()).not.toContain('unknown-member')
  })

  it('names someone the page knows as the page does, and leaves anyone else to the page', async () => {
    const w = mountComposer({ searchMembers: async () => [] })
    await type(w, `<@${IXEN}> and <@${ORRIN}>`)
    const shown = w.get('.lb-tabpanel').text()
    expect(shown).toContain('@Ixen Calloway')
    expect(shown).toContain('@unknown-member')
  })

  it('sends as mentions the people picked whose mention is still in the text, once each, and no one typed in by hand', async () => {
    fakeClock()
    const onSend = vi.fn(async () => ({}))
    const found = [SEFA_FOUND, { id: ORRIN, name: 'Orrin Vale', avatar: null }]
    const w = mountComposer({ onSend, searchMembers: async () => found })
    for (const key of ['Enter', 'ArrowDown']) {
      const search = await openSearch(w)
      await search.get('input').setValue('Or')
      await vi.advanceTimersByTimeAsync(250)
      await settled()
      if (key === 'ArrowDown') await search.get('input').trigger('keydown', { key: 'ArrowDown' })
      await search.get('input').trigger('keydown', { key: 'Enter' })
      await settled()
    }
    expect(area(w).element.value).toBe(`<@${SEFA}><@${ORRIN}>`)
    await type(w, `Hail <@${ORRIN}>, <@${IXEN}> and <@${ORRIN}> again`)
    await replyButton(w).trigger('click')
    await settled()
    expect(onSend).toHaveBeenCalledWith({ source: `Hail <@${ORRIN}>, <@${IXEN}> and <@${ORRIN}> again`, replyTo: null, pingReply: false, mentions: [ORRIN] })
  })

  it('takes the mentions of a draft it opens as picked: they were picked when it was written', async () => {
    const onSend = vi.fn(async () => ({}))
    localStorage.setItem(draftKey(POST), `For <@${SEFA}>`)
    localStorage.setItem(draftKey(POST, MSG), `And <@${ORRIN}>`)
    const w = mountComposer({ onSend })
    await w.setProps({ replyTo: IXEN_REPLY })
    expect(area(w).element.value).toBe(`And <@${ORRIN}>`)
    await w.setProps({ replyTo: null })
    await replyButton(w).trigger('click')
    await settled()
    expect(onSend).toHaveBeenCalledWith({ source: `For <@${SEFA}>`, replyTo: null, pingReply: false, mentions: [SEFA] })
  })

  it('searches once a pause in the typing, and never more than the server allows in a minute, however it is typed', async () => {
    fakeClock()
    const asked = []
    const w = mountComposer({ searchMembers: async (q) => (asked.push({ q, at: Date.now() }), []) })
    const input = (await openSearch(w)).get('input')
    for (const q of ['Ix', 'Ixe', 'Ixen', 'Ixen ', 'Ixen C']) {
      await input.setValue(q)
      await vi.advanceTimersByTimeAsync(100)
    }
    await vi.advanceTimersByTimeAsync(150)
    expect(asked.map((a) => a.q)).toEqual(['Ixen C'])
    // A query every 300 ms for half a minute and more: each is a pause, and the pace holds them to the limit.
    for (let i = 0; i < 120; i++) {
      await input.setValue(`Name ${i}`)
      await vi.advanceTimersByTimeAsync(300)
    }
    await vi.advanceTimersByTimeAsync(60_000)
    expect(asked.length).toBeGreaterThan(SEARCHES.limit)
    for (let i = SEARCHES.limit; i < asked.length; i++) expect(asked[i].at - asked[i - SEARCHES.limit].at).toBeGreaterThanOrEqual(60_000)
    expect(asked.filter((a) => a.at - asked[0].at < 60_000)).toHaveLength(SEARCHES.limit)
    expect(SEARCHES.limit).toBeLessThan(30)
    expect(asked.at(-1).q).toBe('Name 119')
  })

  it('closes on Escape without leaving full screen, on a press outside it, and by @ again', async () => {
    const w = mountComposer({ searchMembers: async () => [] })
    await button(w, 'Full screen').trigger('click')
    let search = await openSearch(sheet())
    await search.get('input').trigger('keydown', { key: 'Escape' })
    expect(dialog(sheet(), 'Mention someone').exists()).toBe(false)
    expect(sheet().classes()).toContain('lb-composer-full')
    expect(document.activeElement).toBe(area(sheet()).element)
    search = await openSearch(sheet())
    search.get('input').element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await nextTick()
    expect(dialog(sheet(), 'Mention someone').exists()).toBe(true)
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await nextTick()
    expect(dialog(sheet(), 'Mention someone').exists()).toBe(false)
    await openSearch(sheet())
    await button(sheet(), 'Mention someone').trigger('click')
    expect(dialog(sheet(), 'Mention someone').exists()).toBe(false)
    await openSearch(sheet())
    await button(sheet(), 'Emoji').trigger('click')
    expect(dialog(sheet(), 'Mention someone').exists()).toBe(false)
    expect(dialog(sheet(), 'Emoji').exists()).toBe(true)
  })

  it('cannot be opened when the page gives no search', async () => {
    const w = mountComposer()
    expect(button(w, 'Mention someone').attributes('aria-disabled')).toBe('true')
    await button(w, 'Mention someone').trigger('click')
    expect(dialog(w, 'Mention someone').exists()).toBe(false)
  })
})

describe('Composer: emoji', () => {
  it('😀 opens the picker with the server\'s own emoji, and the one pressed goes in at the selection', async () => {
    const w = mountComposer({ customEmoji: [{ id: EMOJI, name: 'fire', animated: false }] })
    await type(w, 'Hot  day', 4)
    await button(w, 'Emoji').trigger('click')
    const picker = dialog(w, 'Emoji')
    expect(document.activeElement).toBe(picker.get('input').element)
    await picker.get('button[aria-label="This server"]').trigger('click')
    await picker.get('button[aria-label=":fire:"]').trigger('click')
    await settled()
    const want = apply('Hot  day', { start: 4, end: 4 }, { type: 'emoji', text: `<:fire:${EMOJI}>` })
    expect(area(w).element.value).toBe(want.text)
    expect(selection(w)).toEqual(want.selection)
    expect(document.activeElement).toBe(area(w).element)
    expect(dialog(w, 'Emoji').exists()).toBe(false)
    await button(w, 'Emoji').trigger('click')
    await dialog(w, 'Emoji').get('button[aria-label="grinning face"]').trigger('click')
    await settled()
    expect(area(w).element.value).toBe(apply(want.text, want.selection, { type: 'emoji', text: '😀' }).text)
  })

  it('closes on Escape without leaving full screen', async () => {
    const w = mountComposer()
    await button(w, 'Full screen').trigger('click')
    await button(sheet(), 'Emoji').trigger('click')
    await dialog(sheet(), 'Emoji').get('input').trigger('keydown', { key: 'Escape' })
    expect(dialog(sheet(), 'Emoji').exists()).toBe(false)
    expect(sheet().classes()).toContain('lb-composer-full')
    expect(document.activeElement).toBe(area(sheet()).element)
  })
})

describe('Composer: pictures', () => {
  it('🖼 opens the file chooser, for the four kinds the server takes', async () => {
    const w = mountComposer({ upload: uploads().upload })
    let opened = 0
    fileInput(w).element.addEventListener('click', () => opened++)
    await button(w, 'Add a picture').trigger('click')
    expect(opened).toBe(1)
    expect(fileInput(w).attributes('accept')).toBe('image/png,image/jpeg,image/webp,image/gif')
    expect(fileInput(w).attributes('multiple')).toBeDefined()
  })

  it('uploads each file chosen at the first free place, and puts it in as ![name](upload:N) once it is held', async () => {
    const up = uploads()
    const w = mountComposer({ upload: up.upload })
    await type(w, 'See the map', 3)
    const file = picture('map.png')
    await choose(w, [file])
    await settled()
    expect(up.calls.map((c) => [c.file, c.n])).toEqual([[file, 1]])
    expect(w.get('.lb-uploading').text()).toBe('Adding 1 picture…')
    await type(w, 'Words', 0)
    expect(replyButton(w).attributes('disabled')).toBeDefined()
    up.calls[0].resolve({ n: 1, name: 'map.png' })
    await settled()
    const want = apply('Words', { start: 0, end: 0 }, { type: 'image', name: 'map.png', n: 1 })
    expect(area(w).element.value).toBe(want.text)
    expect(selection(w)).toEqual(want.selection)
    expect(w.find('.lb-uploading').exists()).toBe(false)
    expect(replyButton(w).attributes('disabled')).toBeUndefined()
    expect(fileInput(w).element.value).toBe('')
    await choose(w, [picture('second.png')])
    await settled()
    expect(up.places()).toEqual([1, 2])
  })

  it('has two pictures in flight at most; the next goes when one is held', async () => {
    const up = uploads()
    const w = mountComposer({ upload: up.upload })
    await choose(w, [picture('a.png'), picture('b.png'), picture('c.png')])
    await settled()
    expect(up.places()).toEqual([1, 2])
    expect(w.get('.lb-uploading').text()).toBe('Adding 3 pictures…')
    up.calls[1].resolve({ n: 2, name: 'b.png' })
    await settled()
    expect(up.places()).toEqual([1, 2, 3])
    up.calls[0].resolve({ n: 1, name: 'a.png' })
    up.calls[2].resolve({ n: 3, name: 'c.png' })
    await settled()
    expect(area(w).element.value.match(/upload:\d+/g).sort()).toEqual(['upload:1', 'upload:2', 'upload:3'])
  })

  it('holds 10 at most, those in the text and those on their way, and a picture taken out of the text frees its place', async () => {
    const up = uploads()
    const w = mountComposer({ upload: up.upload })
    const nine = Array.from({ length: 9 }, (_, i) => `![p${i + 1}](upload:${i + 1})`).join('\n')
    await type(w, nine)
    await choose(w, [picture('ten.png'), picture('eleven.png')])
    await settled()
    expect(up.places()).toEqual([10])
    expect(w.get('[role="alert"]').text()).toBe('A reply can hold 10 pictures at most.')
    await choose(w, [picture('twelve.png')])
    await settled()
    expect(up.places()).toEqual([10])
    up.calls[0].resolve({ n: 10, name: 'ten.png' })
    await settled()
    await choose(w, [picture('again.png')])
    await settled()
    expect(up.places()).toEqual([10])
    await type(w, area(w).element.value.replace('![p4](upload:4)', ''))
    await choose(w, [picture('four.png')])
    await settled()
    expect(up.places()).toEqual([10, 4])
  })

  it.each([
    [429, 'One picture at a time, please.'],
    [503, 'Too many pictures are being sent right now.'],
  ])('on a %i shows the server\'s copy and tries again a moment later', async (status, copy) => {
    fakeTimers()
    const up = uploads()
    const w = mountComposer({ upload: up.upload })
    await choose(w, [picture()])
    await settled()
    up.calls[0].resolve({ status, error: copy })
    await settled()
    expect(w.get('.lb-uploading').text()).toBe(`${copy} Trying again in a moment.`)
    await vi.advanceTimersByTimeAsync(999)
    expect(up.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(up.places()).toEqual([1, 1])
    up.calls[1].resolve({ n: 1, name: 'map.png' })
    await settled()
    expect(area(w).element.value).toBe('![map.png](upload:1)')
    expect(w.find('.lb-uploading').exists()).toBe(false)
    expect(w.find('[role="alert"]').exists()).toBe(false)
  })

  it.each([
    [413, 'That picture is too large (10 MB at most).'],
    [400, 'That picture took too long to arrive.'],
    [408, 'That picture took too long to arrive.'],
  ])('on a %i shows the server\'s copy, tries no more, and frees the place', async (status, copy) => {
    fakeTimers()
    const up = uploads()
    const w = mountComposer({ upload: up.upload })
    await choose(w, [picture()])
    await settled()
    up.calls[0].resolve({ status, error: copy })
    await settled()
    expect(w.get('[role="alert"]').text()).toBe(copy)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(up.calls).toHaveLength(1)
    expect(area(w).element.value).toBe('')
    await choose(w, [picture('next.png')])
    await settled()
    expect(up.places()).toEqual([1, 1])
    expect(w.find('[role="alert"]').exists()).toBe(false)
  })

  it('says it could not add a picture when the upload fails without the server\'s words', async () => {
    const w = mountComposer({ upload: async () => { throw new TypeError('Failed to fetch') } })
    await choose(w, [picture()])
    await settled()
    expect(w.get('[role="alert"]').text()).toBe("Couldn't add that picture. Try again.")
    expect(area(w).element.value).toBe('')
  })

  it('takes pictures pasted or dropped into it, and leaves pasted text and dragged text to the browser', async () => {
    const up = uploads()
    const w = mountComposer({ upload: up.upload })
    const pasted = picture('pasted.png')
    const paste = withFiles('paste', 'clipboardData', [pasted])
    area(w).element.dispatchEvent(paste)
    await settled()
    expect(paste.defaultPrevented).toBe(true)
    expect(up.calls.map((c) => c.file)).toEqual([pasted])
    const words = withFiles('paste', 'clipboardData', [])
    area(w).element.dispatchEvent(words)
    expect(words.defaultPrevented).toBe(false)
    const body = w.get('.lb-compose-body').element
    const over = withFiles('dragover', 'dataTransfer', [])
    body.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(false)
    const overFiles = withFiles('dragover', 'dataTransfer', [], ['Files'])
    body.dispatchEvent(overFiles)
    expect(overFiles.defaultPrevented).toBe(true)
    const dropped = picture('dropped.png')
    const drop = withFiles('drop', 'dataTransfer', [dropped])
    area(w).element.dispatchEvent(drop)
    await settled()
    expect(drop.defaultPrevented).toBe(true)
    expect(up.calls.map((c) => c.file)).toEqual([pasted, dropped])
    const dropWords = withFiles('drop', 'dataTransfer', [])
    body.dispatchEvent(dropWords)
    expect(dropWords.defaultPrevented).toBe(false)
  })

  it('takes no pictures when the page gives no upload, or while a reply is being sent', async () => {
    const plain = mountComposer()
    expect(button(plain, 'Add a picture').attributes('aria-disabled')).toBe('true')
    let opened = 0
    fileInput(plain).element.addEventListener('click', () => opened++)
    await button(plain, 'Add a picture').trigger('click')
    expect(opened).toBe(0)
    const paste = withFiles('paste', 'clipboardData', [picture()])
    area(plain).element.dispatchEvent(paste)
    expect(paste.defaultPrevented).toBe(false)

    const up = uploads()
    const w = mountComposer({ upload: up.upload, onSend: () => new Promise(() => {}) })
    await type(w, 'Sending now')
    await replyButton(w).trigger('click')
    const late = withFiles('paste', 'clipboardData', [picture()])
    area(w).element.dispatchEvent(late)
    await choose(w, [picture()])
    await settled()
    expect(up.calls).toEqual([])
  })

  it('tries nothing more once it is closed', async () => {
    fakeTimers()
    const up = uploads()
    const w = mountComposer({ upload: up.upload })
    await choose(w, [picture()])
    await settled()
    up.calls[0].resolve({ status: 429, error: 'One picture at a time, please.' })
    await settled()
    close(w)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(up.calls).toHaveLength(1)
  })
})

describe('Composer: editing a reply', () => {
  const EDIT = { id: OTHER_MSG, source: 'The **old** words', replyTo: null }
  const saveButton = (w) => button(w, 'Save edit')
  const kept = (replyTo = null) => localStorage.getItem(draftKey(POST, replyTo))

  it('opens with the message\'s source, says it is editing, and offers to save the edit rather than to reply', async () => {
    const w = mountComposer({ replyTo: IXEN_REPLY })
    await w.setProps({ editing: EDIT })
    expect(area(w).element.value).toBe('The **old** words')
    expect(w.get('.lb-editing').text()).toContain('Editing your reply')
    expect(w.find('.lb-replying-to').exists()).toBe(false)
    expect(saveButton(w).attributes('disabled')).toBeUndefined()
    expect(w.findAll('button').some((b) => b.text() === 'Reply')).toBe(false)
  })

  it('sends the new source and the people picked for that message, and leaves the edit once it is on its way', async () => {
    const onSend = vi.fn(async () => ({ pending: { key: OTHER_MSG, state: 'sending' } }))
    const w = mountComposer({ onSend, editing: { ...EDIT, source: `Hello <@${IXEN}>` } })
    await type(w, `Hello <@${IXEN}>, again`)
    await saveButton(w).trigger('click')
    await flushPromises()
    expect(onSend).toHaveBeenCalledWith({ source: `Hello <@${IXEN}>, again`, mentions: [IXEN], edit: OTHER_MSG })
    expect(w.emitted('sent')).toEqual([[{ pending: { key: OTHER_MSG, state: 'sending' } }]])
    expect(w.emitted('update:editing')).toEqual([[null]])
  })

  it('gives the reply that was being written back when the edit ends, and never keeps the edit as its draft', async () => {
    fakeTimers()
    const w = mountComposer({ replyTo: IXEN_REPLY })
    await type(w, 'My half-written reply')
    await w.setProps({ editing: EDIT })
    // The reply's last second was kept as the edit began.
    expect(kept(MSG)).toBe('My half-written reply')
    await type(w, 'The edited words')
    vi.advanceTimersByTime(5000)
    await nextTick()
    expect(kept(MSG)).toBe('My half-written reply')
    expect(w.find('.lb-draft-saved').exists()).toBe(false)
    close(w)
    expect(kept(MSG)).toBe('My half-written reply')
    expect(Object.keys(localStorage)).toEqual([draftKey(POST, MSG)])
  })

  it('leaves the edit on Cancel, and gives the reply back as it was', async () => {
    const w = mountComposer({ replyTo: IXEN_REPLY })
    await type(w, 'Kept aside')
    await w.setProps({ editing: EDIT })
    await button(w, 'Cancel').trigger('click')
    expect(w.emitted('update:editing')).toEqual([[null]])
    await w.setProps({ editing: null })
    expect(area(w).element.value).toBe('Kept aside')
    expect(w.find('.lb-editing').exists()).toBe(false)
    expect(w.get('.lb-replying-to').text()).toContain('Ixen Calloway')
    expect(replyButton(w).exists()).toBe(true)
  })

  it('leaves full screen first on Escape, then the edit', async () => {
    const w = mountComposer({ editing: EDIT })
    await w.get('.lb-full').trigger('click')
    await area(sheet()).trigger('keydown', { key: 'Escape' })
    expect(w.get('.lb-full').attributes('aria-pressed')).toBe('false')
    expect(w.emitted('update:editing')).toBeUndefined()
    await area(w).trigger('keydown', { key: 'Escape' })
    expect(w.emitted('update:editing')).toEqual([[null]])
  })

  it('does nothing on Escape when it is neither full screen nor editing', async () => {
    const w = mountComposer()
    await area(w).trigger('keydown', { key: 'Escape' })
    expect(w.emitted('update:editing')).toBeUndefined()
  })

  it('takes no pictures in an edit: a reply\'s pictures are fixed once it is sent', async () => {
    const up = uploads()
    const w = mountComposer({ upload: up.upload, editing: { ...EDIT, source: 'Map ![map](upload:1)' } })
    expect(button(w, 'Add a picture').attributes('aria-disabled')).toBe('true')
    let opened = 0
    fileInput(w).element.addEventListener('click', () => opened++)
    await button(w, 'Add a picture').trigger('click')
    const paste = withFiles('paste', 'clipboardData', [picture()])
    area(w).element.dispatchEvent(paste)
    const drop = withFiles('drop', 'dataTransfer', [picture()])
    w.get('.lb-compose-body').element.dispatchEvent(drop)
    await choose(w, [picture()])
    await settled()
    expect(opened).toBe(0)
    expect(paste.defaultPrevented).toBe(false)
    expect(drop.defaultPrevented).toBe(false)
    expect(up.calls).toEqual([])
  })

  it('measures the edit with the line of the message it replied to, as the server does', async () => {
    const length = lengthPushedByReplyLine()
    expect(length).toBeDefined()
    const lone = mountComposer({ editing: { ...EDIT, source: paragraphs(3, length) } })
    expect(saveButton(lone).attributes('disabled')).toBeUndefined()
    const answering = mountComposer({ editing: { ...EDIT, source: paragraphs(3, length), replyTo: { id: MSG, authorId: IXEN } } })
    expect(saveButton(answering).attributes('disabled')).toBeDefined()
    // The composer's own message replied to has nothing to do with an edit.
    const elsewhere = mountComposer({ replyTo: IXEN_REPLY, editing: { ...EDIT, source: paragraphs(3, length) } })
    expect(saveButton(elsewhere).attributes('disabled')).toBeUndefined()
  })

  it('keeps the edit and says why when it is refused, and is still editing', async () => {
    const onSend = vi.fn(async () => {
      throw failure(400, 'That edit would move or change a picture.')
    })
    const w = mountComposer({ onSend, editing: EDIT })
    await type(w, 'Changed')
    await saveButton(w).trigger('click')
    await flushPromises()
    expect(area(w).element.value).toBe('Changed')
    expect(w.get('[role="alert"]').text()).toBe('That edit would move or change a picture.')
    expect(w.emitted('update:editing')).toBeUndefined()
    expect(w.get('.lb-editing').exists()).toBe(true)
  })

  it('cannot be cancelled while the edit is being sent', async () => {
    const w = mountComposer({ onSend: () => new Promise(() => {}), editing: EDIT })
    await saveButton(w).trigger('click')
    expect(button(w, 'Cancel').attributes('disabled')).toBeDefined()
    await area(w).trigger('keydown', { key: 'Escape' })
    expect(w.emitted('update:editing')).toBeUndefined()
  })

  it('opens straight into an edit, and gives the draft of its reply back after it', async () => {
    localStorage.setItem(draftKey(POST), 'A draft from before')
    const w = mountComposer({ editing: EDIT })
    expect(area(w).element.value).toBe('The **old** words')
    await w.setProps({ editing: null })
    expect(area(w).element.value).toBe('A draft from before')
  })

  it('goes from one edit to another without keeping either', async () => {
    const w = mountComposer({ editing: EDIT })
    await type(w, 'Half an edit')
    await w.setProps({ editing: { id: MSG, source: 'Another message', replyTo: null } })
    expect(area(w).element.value).toBe('Another message')
    await w.setProps({ editing: null })
    expect(area(w).element.value).toBe('')
    expect(localStorage.length).toBe(0)
  })
})

describe('Composer: pictures from before the page was loaded again', () => {
  const NOTE = 'Pictures from before the reload need adding again.'

  it('says so for a draft whose pictures are held by none, keeps the text, and sends nothing until they are gone', async () => {
    localStorage.setItem(draftKey(POST), 'See ![map](upload:1) and ![ford](upload:2)')
    const onSend = vi.fn(async () => ({}))
    const w = mountComposer({ onSend, held: () => false })
    expect(area(w).element.value).toBe('See ![map](upload:1) and ![ford](upload:2)')
    expect(w.get('.lb-dead-pictures').text()).toBe(NOTE)
    expect(replyButton(w).attributes('disabled')).toBeDefined()
    await replyButton(w).trigger('click')
    expect(onSend).not.toHaveBeenCalled()
    await type(w, 'See ![map](upload:1)')
    expect(w.find('.lb-dead-pictures').exists()).toBe(true)
    await type(w, 'See the map')
    expect(w.find('.lb-dead-pictures').exists()).toBe(false)
    expect(replyButton(w).attributes('disabled')).toBeUndefined()
  })

  it('asks the page about each picture the text shows, and only those', async () => {
    const asked = []
    const w = mountComposer({ held: (n) => (asked.push(n), n !== 3) })
    await type(w, '![a](upload:1) ![b](upload:2) ![a again](upload:1) `![c](upload:3)` upload:3')
    expect(new Set(asked)).toEqual(new Set([1, 2]))
    expect(w.find('.lb-dead-pictures').exists()).toBe(false)
    await type(w, '![c](upload:3)')
    expect(w.find('.lb-dead-pictures').exists()).toBe(true)
  })

  it('counts a picture held in this composer as held, once the page holds it', async () => {
    const places = new Set()
    const up = uploads()
    const w = mountComposer({ upload: up.upload, held: (n) => places.has(n) })
    await choose(w, [picture('map.png')])
    await settled()
    places.add(1)
    up.calls[0].resolve({ n: 1, name: 'map' })
    await settled()
    expect(area(w).element.value).toContain('![map](upload:1)')
    expect(w.find('.lb-dead-pictures').exists()).toBe(false)
    expect(replyButton(w).attributes('disabled')).toBeUndefined()
  })

  it('asks nothing when the page gives no way to, and nothing in an edit, whose pictures are the message\'s own', async () => {
    const free = mountComposer()
    await type(free, '![map](upload:1)')
    expect(free.find('.lb-dead-pictures').exists()).toBe(false)
    const held = vi.fn(() => false)
    const editing = mountComposer({ held, editing: { id: MSG, source: '![map](upload:1)', replyTo: null } })
    expect(editing.find('.lb-dead-pictures').exists()).toBe(false)
    expect(button(editing, 'Save edit').attributes('disabled')).toBeUndefined()
    expect(held).not.toHaveBeenCalled()
  })
})

// The server refuses a reply with a picture inside a spoiler (Discord would show the picture), so the composer does not offer to send one.
describe('Composer: a picture inside a spoiler', () => {
  const WORDS = "A picture can't go inside a spoiler yet: put it outside the bars."

  it('says so in the server\'s words and sends nothing, until the picture is outside the bars', async () => {
    const onSend = vi.fn(async () => ({}))
    const w = mountComposer({ onSend })
    await type(w, 'The ending: ||she dies ![map](upload:1)||')
    expect(w.get('.lb-spoiled-picture').text()).toBe(WORDS)
    expect(w.get('.lb-spoiled-picture').attributes('role')).toBe('status')
    expect(replyButton(w).attributes('disabled')).toBeDefined()
    await replyButton(w).trigger('click')
    expect(onSend).not.toHaveBeenCalled()
    await type(w, 'The ending: ||she dies|| ![map](upload:1)')
    expect(w.find('.lb-spoiled-picture').exists()).toBe(false)
    expect(replyButton(w).attributes('disabled')).toBeUndefined()
    await replyButton(w).trigger('click')
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('says so for a picture the toolbar\'s spoiler button wraps', async () => {
    const w = mountComposer()
    await type(w, '![the last map](upload:1)', 0, '![the last map](upload:1)'.length)
    await button(w, 'Spoiler').trigger('click')
    await flushPromises()
    expect(area(w).element.value).toBe('||![the last map](upload:1)||')
    expect(w.get('.lb-spoiled-picture').text()).toBe(WORDS)
    expect(replyButton(w).attributes('disabled')).toBeDefined()
  })

  it('says so in an edit too, whose Save edit it disables', async () => {
    const w = mountComposer({ editing: { id: MSG, source: '![map](upload:1)', replyTo: null } })
    expect(button(w, 'Save edit').attributes('disabled')).toBeUndefined()
    await type(w, '||![map](upload:1)||')
    expect(w.get('.lb-spoiled-picture').text()).toBe(WORDS)
    expect(button(w, 'Save edit').attributes('disabled')).toBeDefined()
  })

  it('says nothing of bars round code or escaped bars, which hide no picture', async () => {
    const w = mountComposer()
    for (const text of ['`||![a](upload:1)||`', '\\|\\|![a](upload:1)\\|\\|', '||secret|| and ![a](upload:1)']) {
      await type(w, text)
      expect(w.find('.lb-spoiled-picture').exists(), text).toBe(false)
      expect(replyButton(w).attributes('disabled'), text).toBeUndefined()
    }
  })
})

describe('Composer: when the sign-in ends', () => {
  beforeEach(fakeTimers)

  it('keeps what was typed in the last second at once when the server ends the sign-in, so none of it is lost', async () => {
    const w = mountComposer()
    await type(w, 'Typed just before it ran out')
    useAuth().expire()
    expect(localStorage.getItem(draftKey(POST))).toBe('Typed just before it ran out')
    vi.advanceTimersByTime(1000)
    close(w)
    expect(localStorage.getItem(draftKey(POST))).toBe('Typed just before it ran out')
  })

  it('keeps nothing when the member signs out: their drafts go with them', async () => {
    const w = mountComposer()
    await type(w, 'Not for the next reader')
    useAuth().signOut()
    expect(localStorage.getItem(draftKey(POST))).toBeNull()
    close(w)
    expect(localStorage.getItem(draftKey(POST))).toBeNull()
  })

  it('takes no notice of anything else the sign-in does, and none once it is closed', async () => {
    const w = mountComposer()
    await type(w, 'Still typing')
    useAuth().noteLibrarius(true)
    expect(localStorage.getItem(draftKey(POST))).toBeNull()
    close(w)
    localStorage.clear()
    useAuth().expire()
    expect(localStorage.length).toBe(0)
  })
})

describe('Composer: a block the page puts in', () => {
  it('goes in on lines of its own after the selection, with the caret under it, as insertBlock() says', async () => {
    const w = mountComposer()
    await type(w, 'My answer', 2, 5)
    await w.vm.insert(asQuote('Their words\nover two lines'))
    const want = insertBlock('My answer', { start: 2, end: 5 }, asQuote('Their words\nover two lines'))
    expect(area(w).element.value).toBe(want.text)
    expect(selection(w)).toEqual(want.selection)
    expect(document.activeElement).toBe(area(w).element)
  })

  it('goes in one at a time with the toolbar\'s actions, and one that is refused stops none after it', async () => {
    const w = mountComposer()
    await type(w, '')
    const first = w.vm.insert('> one')
    const refused = w.vm.insert('   ')
    const last = w.vm.act({ type: 'emoji', text: '😀' })
    await first
    await expect(refused).rejects.toThrow(RangeError)
    await last
    expect(area(w).element.value).toBe('> one\n😀')
  })

  it('does nothing while a reply is being sent', async () => {
    const w = mountComposer({ onSend: () => new Promise(() => {}) })
    await type(w, 'Sending')
    await replyButton(w).trigger('click')
    await w.vm.insert('> late')
    expect(area(w).element.value).toBe('Sending')
  })
})
