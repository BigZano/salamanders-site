// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import LibMessage from './LibMessage.vue'
import { createRenderCtx } from '../../lib/librarius/render'

// Invented ids only (the 200000000000000400 range), and invented names.
const GUILD = '200000000000000400'
const POST = '200000000000000401'
const OTHER_CHANNEL = '200000000000000403'
const MSG = '200000000000000450'
const REPLIED = '200000000000000449'
const TOR = '200000000000000410'
const IXEN = '200000000000000411'
const WARDENS = '200000000000000420'
const CDN = 'https://cdn.discordapp.com/attachments/200000000000000401/200000000000000460'
const PROXY = 'https://media.discordapp.net/external/abc123'

const people = {
  [TOR]: { name: 'Tor Mardan', avatar: 'https://cdn.discordapp.com/avatars/200000000000000410/aaaa.png?size=64' },
  [IXEN]: { name: 'Ixen Calloway', avatar: null },
}

const makeCtx = (over = {}) =>
  createRenderCtx({
    guildId: GUILD,
    postTitles: new Map([[POST, 'The Long Road']]),
    people,
    roles: [{ id: WARDENS, name: 'Wardens', color: '#aa3322' }],
    ...over,
  })
const ctx = makeCtx()

const message = (over = {}) => ({
  id: MSG,
  authorId: TOR,
  authorName: 'Tor Mardan',
  authorAvatar: 'https://cdn.discordapp.com/avatars/200000000000000410/aaaa.png?size=64',
  content: 'Hello there',
  createdAt: '2026-11-09T10:02:00.000Z',
  editedAt: null,
  replyTo: null,
  attachments: [],
  embeds: [],
  stickers: [],
  reactions: [],
  origin: 'discord',
  ...over,
})
const attachment = (n, over = {}) => ({
  id: `20000000000000046${n}`,
  filename: `file${n}.png`,
  contentType: 'image/png',
  size: 2048,
  width: 640,
  height: 480,
  url: `${CDN}/20000000000000046${n}/file${n}.png?ex=65f0&is=65e0&hm=ab12`,
  ...over,
})
const embed = (over = {}) => ({
  type: 'article',
  url: 'https://example.org/story',
  title: 'A story',
  description: 'About a **road**.',
  provider: 'Example',
  thumbnail: null,
  image: null,
  ...over,
})
const router = () =>
  createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }] })

const mountMsg = (msg = message(), props = {}) =>
  mount(LibMessage, { props: { message: msg, grouped: false, article: false, people, ctx, ...props }, global: { plugins: [router()] } })

describe('LibMessage: the frame', () => {
  it('is the message at its own address, #m-<id>', () => {
    const w = mountMsg()
    expect(w.element.id).toBe(`m-${MSG}`)
  })

  it('has class lb-article for an article, and not otherwise', () => {
    expect(mountMsg(message(), { article: true }).classes()).toContain('lb-article')
    expect(mountMsg(message(), { article: false }).classes()).not.toContain('lb-article')
    expect(mountMsg(message()).classes()).not.toContain('lb-article')
  })

  it('has class lb-grouped for a grouped message, and not otherwise', () => {
    expect(mountMsg(message(), { grouped: true }).classes()).toContain('lb-grouped')
    expect(mountMsg(message(), { grouped: false }).classes()).not.toContain('lb-grouped')
    expect(mountMsg(message()).classes()).not.toContain('lb-grouped')
  })

  it('shows the text of the message through the markdown renderer', () => {
    const w = mountMsg(message({ content: 'Some **bold** words\n> and a quote' }))
    expect(w.find('.lb-body strong').text()).toBe('bold')
    expect(w.find('.lb-body blockquote').text()).toBe('and a quote')
  })

  it('has no body for a message with no text', () => {
    expect(mountMsg(message({ content: '' })).find('.lb-body').exists()).toBe(false)
    expect(mountMsg(message({ content: ' \n ' })).find('.lb-body').exists()).toBe(false)
    expect(mountMsg(message({ content: 'x' })).find('.lb-body').exists()).toBe(true)
  })
})

describe('LibMessage: the header', () => {
  it('shows the avatar, the name and the time', () => {
    const w = mountMsg()
    const avatar = w.find('img.lb-avatar')
    expect(avatar.attributes('src')).toBe('https://cdn.discordapp.com/avatars/200000000000000410/aaaa.png?size=64')
    expect(avatar.attributes('alt')).toBe('')
    expect(avatar.attributes('loading')).toBe('lazy')
    expect(w.find('.lb-name').text()).toBe('Tor Mardan')
    const time = w.find('time.lb-time')
    expect(time.attributes('datetime')).toBe('2026-11-09T10:02:00.000Z')
    expect(time.text()).toBe(
      new Date('2026-11-09T10:02:00.000Z').toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    )
    expect(time.attributes('title')).toBe(new Date('2026-11-09T10:02:00.000Z').toLocaleString())
  })

  it('is hidden for a grouped message: no avatar, no name, no time', () => {
    const w = mountMsg(message(), { grouped: true })
    expect(w.find('.lb-head').exists()).toBe(false)
    expect(w.find('.lb-avatar').exists()).toBe(false)
    expect(w.find('.lb-name').exists()).toBe(false)
    expect(w.find('time').exists()).toBe(false)
    expect(w.text()).not.toContain('Tor Mardan')
    expect(w.text()).toContain('Hello there')
  })

  it('takes the name and avatar the page knows of the author now, over what the message was stored with', () => {
    const w = mountMsg(message({ authorName: 'Old Name', authorAvatar: null }))
    expect(w.find('.lb-name').text()).toBe('Tor Mardan')
    expect(w.find('img.lb-avatar').attributes('src')).toBe(people[TOR].avatar)
  })

  it('falls back to the name and avatar stored with the message for an author the page does not know', () => {
    const w = mountMsg(message({ authorId: '200000000000000499', authorName: 'Ghost', authorAvatar: 'https://cdn.discordapp.com/avatars/200000000000000499/bbbb.png?size=64' }))
    expect(w.find('.lb-name').text()).toBe('Ghost')
    expect(w.find('img.lb-avatar').attributes('src')).toBe('https://cdn.discordapp.com/avatars/200000000000000499/bbbb.png?size=64')
  })

  it('shows initials for an author with no avatar, even when the message has an old one', () => {
    const w = mountMsg(message({ authorId: IXEN, authorName: 'Whoever', authorAvatar: people[TOR].avatar }))
    expect(w.find('img.lb-avatar').exists()).toBe(false)
    expect(w.find('.lb-initials').text()).toBe('IC')
    expect(w.find('.lb-name').text()).toBe('Ixen Calloway')
  })

  it('shows initials for an avatar address that is not on the CDN', () => {
    for (const avatar of ['https://evil.example/a.png', 'http://cdn.discordapp.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '']) {
      const w = mountMsg(message({ authorId: '200000000000000499', authorName: 'Ghost Writer', authorAvatar: avatar }))
      expect(w.find('img').exists(), avatar).toBe(false)
      expect(w.find('.lb-initials').text()).toBe('GW')
    }
  })

  it('does not take a name off the prototype of the people table', () => {
    const w = mountMsg(message({ authorId: 'constructor', authorName: 'Real Name', authorAvatar: null }))
    expect(w.find('.lb-name').text()).toBe('Real Name')
  })

  it('shows a name as text, whatever is in it', () => {
    const w = mountMsg(message({ authorId: '200000000000000499', authorName: '<img src=x onerror=alert(1)>' }))
    expect(w.find('.lb-name').text()).toBe('<img src=x onerror=alert(1)>')
    expect(w.find('.lb-name img').exists()).toBe(false)
  })

  it('works without a people table', () => {
    const w = mount(LibMessage, { props: { message: message(), ctx }, global: { plugins: [router()] } })
    expect(w.find('.lb-name').text()).toBe('Tor Mardan')
    expect(w.classes()).not.toContain('lb-article')
    expect(w.classes()).not.toContain('lb-grouped')
  })
})

describe('LibMessage: the reply line', () => {
  const replyTo = (over = {}) => ({ id: REPLIED, authorId: IXEN, authorName: 'Ixen Calloway', content: 'Do the caravans still run?', ...over })

  it('has no reply line for a message that replies to nothing', () => {
    expect(mountMsg().find('.lb-reply').exists()).toBe(false)
    expect(mountMsg(message({ replyTo: undefined })).find('.lb-reply').exists()).toBe(false)
  })

  it('reads "↪ replying to <name>: <excerpt>" and links to the message', () => {
    const w = mountMsg(message({ replyTo: replyTo() }))
    const line = w.find('.lb-reply')
    expect(line.text()).toBe('↪ replying to Ixen Calloway: Do the caravans still run?')
    expect(line.element.tagName).toBe('A')
    expect(line.attributes('href')).toBe(`#m-${REPLIED}`)
  })

  it('has the reply line before the header', () => {
    const html = mountMsg(message({ replyTo: replyTo() })).html()
    expect(html.indexOf('lb-reply')).toBeLessThan(html.indexOf('lb-head'))
  })

  it('shows the quote as plain text, collapsed, and cut at 120 characters', () => {
    const w = mountMsg(message({ replyTo: replyTo({ content: '**bold**\n\n  and   `code` ' + 'x'.repeat(200) }) }))
    const quote = w.find('.lb-reply-quote').text()
    expect(quote.startsWith('bold and code xxx')).toBe(true)
    expect(Array.from(quote)).toHaveLength(120)
    expect(quote.endsWith('…')).toBe(true)
    expect(w.find('.lb-reply strong').exists()).toBe(false)
  })

  it('masks a spoiler in the quote, so the line never shows what it hides', () => {
    const w = mountMsg(message({ replyTo: replyTo({ content: 'the answer is ||the secret|| and **||more secret||**' }) }))
    expect(w.find('.lb-reply').text()).toBe('↪ replying to Ixen Calloway: the answer is ▒▒▒ and ▒▒▒')
    expect(w.find('.lb-reply').text()).not.toContain('secret')
  })

  it('names the author the page knows now, else the one stored with the quote', () => {
    expect(mountMsg(message({ replyTo: replyTo({ authorId: TOR, authorName: 'Old Name' }) })).find('.lb-reply-name').text()).toBe('Tor Mardan')
    expect(mountMsg(message({ replyTo: replyTo({ authorId: '200000000000000499', authorName: 'Ghost' }) })).find('.lb-reply-name').text()).toBe('Ghost')
  })

  it('leaves out the colon when there is nothing to quote', () => {
    for (const content of ['', '   ', null, undefined]) {
      const line = mountMsg(message({ replyTo: replyTo({ content }) })).find('.lb-reply')
      expect(line.text(), String(content)).toBe('↪ replying to Ixen Calloway')
      expect(line.find('.lb-reply-quote').exists()).toBe(false)
    }
  })

  it('shows a name and a quote as text, whatever is in them', () => {
    const w = mountMsg(message({ replyTo: replyTo({ authorId: null, authorName: '<b>Bold</b>', content: '<script>alert(1)</script>' }) }))
    expect(w.find('.lb-reply').text()).toBe('↪ replying to <b>Bold</b>: <script>alert(1)</script>')
    expect(w.find('.lb-reply-name b, .lb-reply script').exists()).toBe(false)
  })

  it('links to a hash, never to an address of its own making', () => {
    const w = mountMsg(message({ replyTo: replyTo({ id: '1"><script>' }) }))
    expect(w.find('.lb-reply').attributes('href')).toBe('#m-1"><script>')
    expect(w.find('script').exists()).toBe(false)
  })

  it('shows the reply line of a grouped message too, though a grouped message has none', () => {
    const w = mountMsg(message({ replyTo: replyTo() }), { grouped: true })
    expect(w.find('.lb-reply').exists()).toBe(true)
    expect(w.find('.lb-head').exists()).toBe(false)
  })
})

describe('LibMessage: attachments', () => {
  it('shows an image as a lazy image with its size, and its file name as the alt text', () => {
    const a = attachment(1)
    const img = mountMsg(message({ attachments: [a] })).find('img.lb-image')
    expect(img.attributes('src')).toBe(a.url)
    expect(img.attributes('width')).toBe('640')
    expect(img.attributes('height')).toBe('480')
    expect(img.attributes('loading')).toBe('lazy')
    expect(img.attributes('alt')).toBe('file1.png')
  })

  it('leaves the size off an image that has none', () => {
    const img = mountMsg(message({ attachments: [attachment(1, { width: null, height: null })] })).find('img.lb-image')
    expect(img.exists()).toBe(true)
    expect(img.attributes('width')).toBeUndefined()
    expect(img.attributes('height')).toBeUndefined()
  })

  it('shows "Image unavailable" in place of an image that fails to load', async () => {
    const w = mountMsg(message({ attachments: [attachment(1)] }))
    expect(w.text()).not.toContain('Image unavailable')
    await w.find('img.lb-image').trigger('error')
    expect(w.find('img.lb-image').exists()).toBe(false)
    expect(w.find('.lb-missing').text()).toBe('Image unavailable')
    expect(w.text()).toContain('Image unavailable')
  })

  it('swaps only the image that failed', async () => {
    const w = mountMsg(message({ attachments: [attachment(1), attachment(2)] }))
    await w.findAll('img.lb-image')[0].trigger('error')
    expect(w.findAll('img.lb-image')).toHaveLength(1)
    expect(w.find('img.lb-image').attributes('alt')).toBe('file2.png')
    expect(w.findAll('.lb-missing')).toHaveLength(1)
  })

  it('tries an image again when its link is renewed', async () => {
    const w = mountMsg(message({ attachments: [attachment(1)] }))
    await w.find('img.lb-image').trigger('error')
    expect(w.find('img.lb-image').exists()).toBe(false)
    const renewed = attachment(1, { url: `${CDN}/200000000000000461/file1.png?ex=ffff&is=aaaa&hm=cd34` })
    await w.setProps({ message: message({ attachments: [renewed] }) })
    expect(w.find('img.lb-image').attributes('src')).toBe(renewed.url)
    expect(w.find('.lb-missing').exists()).toBe(false)
  })

  it('shows "Image unavailable", and loads nothing, for an image that is not on the CDN', () => {
    for (const url of ['https://evil.example/a.png', 'http://cdn.discordapp.com/attachments/1/2/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', "https://cdn.discordapp.com/attachments/../avatars/1/a.png", null, undefined, '']) {
      const w = mountMsg(message({ attachments: [attachment(1, { url })] }))
      expect(w.find('img.lb-image').exists(), String(url)).toBe(false)
      expect(w.find('.lb-missing').text()).toBe('Image unavailable')
    }
  })

  it('shows a video as a link to the CDN with its name and size, not as a player', () => {
    const a = attachment(1, { filename: 'clip.mp4', contentType: 'video/mp4', size: 5 * 1024 * 1024 })
    const w = mountMsg(message({ attachments: [a] }))
    expect(w.find('video').exists()).toBe(false)
    expect(w.find('audio').exists()).toBe(false)
    expect(w.find('img.lb-image').exists()).toBe(false)
    const link = w.find('a.lb-file')
    expect(link.attributes('href')).toBe(a.url)
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toBe('noopener noreferrer')
    expect(link.text()).toBe('clip.mp4 (5.0 MB)')
  })

  it('shows any other file the same way, and a file with no type', () => {
    const w = mountMsg(
      message({
        attachments: [
          attachment(1, { filename: 'plan.pdf', contentType: 'application/pdf', size: 1536 }),
          attachment(2, { filename: 'notes', contentType: null, size: 12 }),
        ],
      }),
    )
    expect(w.findAll('a.lb-file').map((a) => a.text())).toEqual(['plan.pdf (1.5 KB)', 'notes (12 B)'])
  })

  it.each([
    [0, '0 B'],
    [1, '1 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1048575, '1024.0 KB'],
    [1048576, '1.0 MB'],
    [26214400, '25.0 MB'],
    [1073741824, '1.0 GB'],
    [5 * 1073741824, '5.0 GB'],
    [1024 * 1073741824, '1024.0 GB'],
  ])('writes %d bytes as %s', (size, text) => {
    const w = mountMsg(message({ attachments: [attachment(1, { filename: 'f.bin', contentType: 'application/octet-stream', size })] }))
    expect(w.find('a.lb-file').text()).toBe(`f.bin (${text})`)
  })

  it('leaves the size out when it is no size', () => {
    for (const size of [null, undefined, -1, NaN, Infinity, '5']) {
      const w = mountMsg(message({ attachments: [attachment(1, { filename: 'f.bin', contentType: 'application/octet-stream', size })] }))
      expect(w.find('a.lb-file').text(), String(size)).toBe('f.bin')
    }
  })

  it('shows a file that is not on the CDN as its name, with no link', () => {
    for (const url of ['https://evil.example/a.pdf', 'javascript:alert(1)', 'http://cdn.discordapp.com/attachments/1/2/a.pdf', null]) {
      const w = mountMsg(message({ attachments: [attachment(1, { filename: 'plan.pdf', contentType: 'application/pdf', size: 10, url })] }))
      expect(w.find('a').exists(), String(url)).toBe(false)
      expect(w.find('.lb-file').text()).toBe('plan.pdf (10 B)')
    }
  })

  it('calls a file with no name "Attachment"', () => {
    const w = mountMsg(message({ attachments: [attachment(1, { filename: '', contentType: 'application/pdf', size: 10 })] }))
    expect(w.find('a.lb-file').text()).toBe('Attachment (10 B)')
  })

  it('shows a file name as text, whatever is in it', () => {
    const w = mountMsg(message({ attachments: [attachment(1, { filename: '<img src=x onerror=alert(1)>.pdf', contentType: 'application/pdf', size: 1 })] }))
    expect(w.find('a.lb-file').text()).toBe('<img src=x onerror=alert(1)>.pdf (1 B)')
    expect(w.find('.lb-file img').exists()).toBe(false)
  })

  it('shows images and files together in the order they came, with an attachment-only message', () => {
    const w = mountMsg(
      message({
        content: '',
        attachments: [attachment(1), attachment(2, { filename: 'a.zip', contentType: 'application/zip', size: 10 }), attachment(3)],
      }),
    )
    expect(w.find('.lb-body').exists()).toBe(false)
    expect(w.findAll('img.lb-image')).toHaveLength(2)
    expect(w.findAll('a.lb-file')).toHaveLength(1)
  })
})

describe('LibMessage: embeds', () => {
  it('shows the title as an external link, the provider, and the description as markdown', () => {
    const w = mountMsg(message({ embeds: [embed()] }))
    const box = w.find('.lb-embed')
    const link = box.find('.lb-embed-title a')
    expect(link.text()).toBe('A story')
    expect(link.attributes('href')).toBe('https://example.org/story')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toBe('noopener noreferrer')
    expect(box.find('.lb-embed-provider').text()).toBe('Example')
    expect(box.find('.lb-embed-description strong').text()).toBe('road')
  })

  it('shows the title as text when the address is not an https one', () => {
    for (const url of ['http://example.org/story', 'javascript:alert(1)', 'data:text/html,hi', null, undefined, '']) {
      const w = mountMsg(message({ embeds: [embed({ url })] }))
      expect(w.find('.lb-embed a').exists(), String(url)).toBe(false)
      expect(w.find('.lb-embed-title').text()).toBe('A story')
    }
  })

  it('shows what the embed has and leaves out what it lacks', () => {
    const w = mountMsg(message({ embeds: [embed({ title: null, description: null, provider: null })] }))
    expect(w.find('.lb-embed').exists()).toBe(true)
    expect(w.find('.lb-embed-title').exists()).toBe(false)
    expect(w.find('.lb-embed-description').exists()).toBe(false)
    expect(w.find('.lb-embed-provider').exists()).toBe(false)
  })

  it('shows the thumbnail and the image, from the proxy only', () => {
    const thumbnail = { url: `${PROXY}/thumb.png`, width: 100, height: 80 }
    const image = { url: 'https://images-ext-1.discordapp.net/external/zzz/big.png', width: 800, height: 600 }
    const w = mountMsg(message({ embeds: [embed({ thumbnail, image })] }))
    const thumb = w.find('img.lb-embed-thumb')
    expect(thumb.attributes('src')).toBe(thumbnail.url)
    expect(thumb.attributes('width')).toBe('100')
    expect(thumb.attributes('height')).toBe('80')
    expect(thumb.attributes('loading')).toBe('lazy')
    expect(thumb.attributes('alt')).toBe('')
    const big = w.find('img.lb-embed-image')
    expect(big.attributes('src')).toBe(image.url)
    expect(big.attributes('width')).toBe('800')
    expect(big.attributes('loading')).toBe('lazy')
  })

  it('shows no picture for an address that is not the media proxy, and no "Image unavailable" either', () => {
    for (const url of ['https://evil.example/pixel.png', 'https://cdn.discordapp.com/attachments/1/2/a.png', 'http://media.discordapp.net/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', null, '']) {
      const w = mountMsg(message({ embeds: [embed({ thumbnail: { url, width: 1, height: 1 }, image: { url, width: 1, height: 1 } })] }))
      expect(w.find('.lb-embed img').exists(), String(url)).toBe(false)
      expect(w.find('.lb-missing').exists(), String(url)).toBe(false)
    }
  })

  it('shows "Image unavailable" for a proxy picture that fails to load', async () => {
    const w = mountMsg(message({ embeds: [embed({ image: { url: `${PROXY}/big.png`, width: 8, height: 8 }, thumbnail: { url: `${PROXY}/small.png`, width: 8, height: 8 } })] }))
    await w.find('img.lb-embed-image').trigger('error')
    expect(w.find('img.lb-embed-image').exists()).toBe(false)
    expect(w.find('.lb-embed .lb-missing').text()).toBe('Image unavailable')
    expect(w.find('img.lb-embed-thumb').exists()).toBe(true)
  })

  it('shows a title, a description and a provider as text, whatever is in them', () => {
    const hostile = '<img src=x onerror=alert(1)>'
    const w = mountMsg(message({ embeds: [embed({ title: hostile, provider: hostile, description: hostile })] }))
    expect(w.find('.lb-embed').text()).toContain(hostile)
    expect(w.find('.lb-embed img').exists()).toBe(false)
  })

  it('shows each of several embeds', () => {
    const w = mountMsg(message({ embeds: [embed({ title: 'One' }), embed({ title: 'Two' }), embed({ title: 'Three' })] }))
    expect(w.findAll('.lb-embed-title').map((t) => t.text())).toEqual(['One', 'Two', 'Three'])
  })

  it('renders the description with the same links as the message: a link to a post is a route', async () => {
    const w = mountMsg(message({ embeds: [embed({ description: `see https://discord.com/channels/${GUILD}/${POST}` })] }))
    await flushPromises()
    expect(w.find('.lb-embed-description a').attributes('href')).toBe(`/reliquarium/librarius/${POST}`)
  })
})

describe('LibMessage: stickers and reactions', () => {
  it('shows a sticker as [sticker: name]', () => {
    const w = mountMsg(message({ stickers: [{ id: '200000000000000470', name: 'Wave' }, { id: '200000000000000471', name: '<b>x</b>' }] }))
    expect(w.findAll('.lb-sticker').map((s) => s.text())).toEqual(['[sticker: Wave]', '[sticker: <b>x</b>]'])
    expect(w.find('.lb-sticker b').exists()).toBe(false)
  })

  it('shows reactions as read-only chips: the emoji and the count', () => {
    const w = mountMsg(
      message({
        reactions: [
          { key: 'u:🔥', id: null, name: '🔥', animated: false, count: 4 },
          { key: 'c:200000000000000430', id: '200000000000000430', name: 'wolf', animated: false, count: 12 },
          { key: 'c:200000000000000431', id: '200000000000000431', name: 'spin', animated: true, count: 1 },
        ],
      }),
    )
    const chips = w.findAll('.lb-reaction')
    expect(chips).toHaveLength(3)
    expect(chips[0].text()).toBe('🔥 4')
    expect(chips[1].find('img.lb-emoji').attributes('src')).toBe('https://cdn.discordapp.com/emojis/200000000000000430.webp?size=48')
    expect(chips[1].find('img.lb-emoji').attributes('alt')).toBe(':wolf:')
    expect(chips[1].find('.lb-count').text()).toBe('12')
    expect(chips[2].find('img.lb-emoji').attributes('src')).toBe('https://cdn.discordapp.com/emojis/200000000000000431.gif?size=48')
    expect(w.find('.lb-reactions button, .lb-reactions a, .lb-reaction button').exists()).toBe(false)
  })

  it('shows a custom emoji whose name was deleted, and one with an id that is no id', () => {
    const w = mountMsg(
      message({
        reactions: [
          { key: 'c:200000000000000430', id: '200000000000000430', name: null, animated: false, count: 2 },
          { key: 'c:bad', id: 'not-an-id', name: 'wolf', animated: false, count: 3 },
        ],
      }),
    )
    const chips = w.findAll('.lb-reaction')
    expect(chips[0].find('img.lb-emoji').attributes('alt')).toBe(':emoji:')
    expect(chips[1].find('img').exists()).toBe(false)
    expect(chips[1].text()).toBe(':wolf: 3')
  })

  it('shows a reaction name as text, whatever is in it', () => {
    const w = mountMsg(message({ reactions: [{ key: 'u:<b>', id: null, name: '<b>x</b>', animated: false, count: 1 }] }))
    expect(w.find('.lb-reaction').text()).toBe('<b>x</b> 1')
    expect(w.find('.lb-reaction b').exists()).toBe(false)
  })

  it('has no list of reactions, and no stickers, for a message with none', () => {
    const w = mountMsg()
    expect(w.find('.lb-reactions').exists()).toBe(false)
    expect(w.find('.lb-sticker').exists()).toBe(false)
    expect(w.find('.lb-embed').exists()).toBe(false)
    expect(w.find('.lb-file').exists()).toBe(false)
    expect(w.find('.lb-image').exists()).toBe(false)
  })
})

describe('LibMessage: Discord content is untrusted (hostile battery)', () => {
  const body = (content, c = ctx) => mountMsg(message({ content }), { ctx: c })

  it.each([
    ['a javascript: link', '[click me](javascript:alert(1))'],
    ['a JaVaScRiPt: link', '[click me](JaVaScRiPt:alert(1))'],
    ['a data: link', '[click me](data:text/html,<script>alert(1)</script>)'],
    ['a data: link in angle brackets', '<data:text/html,hi>'],
    ['a bare javascript: address', 'javascript:alert(1)'],
    ['an http: link', '[click me](http://example.org/x)'],
    ['a bare http: address', 'http://example.org/x'],
    ['an http: address in angle brackets', '<http://example.org/x>'],
    ['an ftp: link', '[click me](ftp://example.org/x)'],
  ])('shows %s as text, not as a link', (_, content) => {
    const w = body(content)
    expect(w.find('a').exists()).toBe(false)
    expect(w.find('[href]').exists()).toBe(false)
    expect(w.find('.lb-body').text()).toContain(content.startsWith('[') ? 'click me' : content.replace(/^<|>$/g, ''))
  })

  it('shows raw HTML as text', () => {
    for (const content of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<svg onload=alert(1)>', '<a href="javascript:alert(1)">x</a>', '<iframe src="https://evil.example"></iframe>', '**<b>bold</b>**', '||<svg onload=alert(1)>||', '`<script>`']) {
      const w = body(content)
      expect(w.find('.lb-body').findAll('script, img, svg, iframe, b, [onerror], [onload], [onclick]'), content).toHaveLength(0)
      expect(w.find('.lb-body').text()).toContain(content.replace(/\*\*|\|\||`/g, ''))
    }
  })

  // The fastest of a few mounts: a busy machine slows some runs, not all of them, while code that does too much work
  // for hostile text is slow in every one.
  const fastest = (run, times = 5) =>
    Math.min(
      ...Array.from({ length: times }, () => {
        const start = performance.now()
        run()
        return performance.now() - start
      }),
    )

  it('renders a 4000-character run of nested markers in under 50 ms', () => {
    mountMsg() // the first mount of anything pays for compiling and warming up; it is not the content's
    const content = '**__~~||'.repeat(500)
    expect(content).toHaveLength(4000)
    expect(body(content).find('.lb-body').exists()).toBe(true)
    expect(fastest(() => body(content))).toBeLessThan(50)
  })

  it('renders other long hostile runs quickly too', () => {
    mountMsg()
    for (const content of ['*'.repeat(4000), '_'.repeat(4000), '||'.repeat(2000), '['.repeat(2000), '`'.repeat(4000), '> '.repeat(2000), '- '.repeat(2000), '<'.repeat(4000), '<@'.repeat(2000), 'https://'.repeat(500), '\\'.repeat(4000), '# '.repeat(2000)]) {
      expect(fastest(() => body(content), 3), content.slice(0, 12)).toBeLessThan(250)
    }
  })

  it('keeps zero-width and right-to-left characters in the text, and makes no element of them', () => {
    const content = 'a​b‌c‍d⁠e﻿f ‮evil‬ ‏RTL‎ ⁦iso⁩'
    const w = body(content)
    expect(w.find('.lb-body').text()).toBe(content)
    expect(w.find('.lb-body').element.querySelectorAll('*:not(p):not(div)')).toHaveLength(0)
  })

  it('shows a link with an invisible character in it as text', () => {
    for (const content of ['https://example.org/‮', '[x](https://example.org/​)']) {
      const w = body(content)
      expect(w.find('a').exists(), content).toBe(false)
    }
  })

  it('shows a Discord link to another channel as an external https link', () => {
    const href = `https://discord.com/channels/${GUILD}/${OTHER_CHANNEL}/${MSG}`
    for (const content of [href, `[the other room](${href})`, `<${href}>`]) {
      const a = body(content).find('a')
      expect(a.attributes('href'), content).toBe(href)
      expect(a.attributes('rel')).toBe('noopener noreferrer')
      expect(a.attributes('target')).toBe('_blank')
    }
  })

  it('shows a Discord link to a post as a link inside the site', async () => {
    const w = body(`go to https://discord.com/channels/${GUILD}/${POST}/${MSG} now`)
    await flushPromises()
    const a = w.find('a')
    expect(a.attributes('href')).toBe(`/reliquarium/librarius/${POST}#m-${MSG}`)
    expect(a.attributes('target')).toBeUndefined()
  })

  it('shows a mention of a post by its title, as a link inside the site', async () => {
    const w = body(`<#${POST}>`)
    await flushPromises()
    const a = w.find('a.md-mention')
    expect(a.text()).toBe('The Long Road')
    expect(a.attributes('href')).toBe(`/reliquarium/librarius/${POST}`)
  })

  it('shows the mentions of a channel that is no post, a member and a role as labels', () => {
    const w = body(`<#${OTHER_CHANNEL}> <@${TOR}> <@!${IXEN}> <@&${WARDENS}> <@200000000000000499>`)
    expect(w.find('a').exists()).toBe(false)
    const labels = w.findAll('.md-mention').map((m) => m.text())
    expect(labels).toEqual(['#channel', '@Tor Mardan', '@Ixen Calloway', '@Wardens', '@unknown-member'])
    expect(w.find('.md-mention-role').attributes('style')).toContain('--role: #aa3322')
  })

  it('shows a custom emoji as the image from the CDN', () => {
    const w = body('hi <:wolf:200000000000000430> and <a:spin:200000000000000431>')
    const srcs = w.findAll('img.lb-emoji').map((i) => i.attributes('src'))
    expect(srcs).toEqual([
      'https://cdn.discordapp.com/emojis/200000000000000430.webp?size=48',
      'https://cdn.discordapp.com/emojis/200000000000000431.gif?size=48',
    ])
    expect(w.find('img.lb-emoji').attributes('loading')).toBe('lazy')
  })

  it('has no element with an event attribute, or a style that fetches, whatever the message holds', () => {
    const hostile = [
      '<img src=x onerror=alert(1)> <svg onload=alert(1)> [x](javascript:alert(1)) <b onclick=alert(1)>b</b>',
      '[x](https://example.org/" onmouseover="alert(1))',
      '[x](https://example.org/\' style=\'background:url(https://evil.example/p.png))',
    ]
    for (const content of hostile) {
      const w = mountMsg(message({ content, embeds: [embed({ title: content, description: content })], stickers: [{ id: '200000000000000470', name: content }] }))
      for (const el of w.element.querySelectorAll('*')) {
        for (const attr of el.getAttributeNames()) {
          expect(attr.startsWith('on'), `${attr} on ${el.tagName}`).toBe(false)
          if (attr === 'style') expect(el.getAttribute('style')).not.toMatch(/url\(/i)
        }
      }
    }
  })

  it('loads no picture from any host but the Discord CDN and media proxy', () => {
    const w = mountMsg(
      message({
        content: '![x](https://evil.example/p.png) https://evil.example/p.png <https://evil.example/p.png>',
        authorAvatar: 'https://evil.example/avatar.png',
        authorId: '200000000000000499',
        attachments: [attachment(1, { url: 'https://evil.example/a.png' })],
        embeds: [embed({ thumbnail: { url: 'https://evil.example/t.png', width: 1, height: 1 }, image: { url: 'https://evil.example/i.png', width: 1, height: 1 } })],
      }),
    )
    for (const img of w.findAll('img')) expect(img.attributes('src') ?? '').not.toContain('evil.example')
  })
})
