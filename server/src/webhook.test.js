import { describe, it, expect, vi } from 'vitest'
import { createNotifier } from './webhook'

describe('createNotifier', () => {
  it('posts the content plus suffix and never pings anyone', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}'))
    createNotifier({ url: 'https://hook.test', suffix: ' · https://site.test/history', fetchImpl })('by @everyone <@&123>')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://hook.test')
    // The trailing '>' of the mention is Discord markdown and gets escaped;
    // allowed_mentions: { parse: [] } is what actually prevents the ping.
    expect(JSON.parse(init.body)).toEqual({
      content: 'by @everyone <@&123\\> · https://site.test/history',
      allowed_mentions: { parse: [] },
    })
  })

  it('is a no-op without a url and logs (not throws) on failure', async () => {
    const fetchImpl = vi.fn()
    createNotifier({ url: null, fetchImpl })('x')
    expect(fetchImpl).not.toHaveBeenCalled()

    const log = vi.fn()
    createNotifier({ url: 'https://hook.test', fetchImpl: vi.fn().mockRejectedValue(new Error('down')), log })('x')
    await new Promise((r) => setTimeout(r, 0))
    expect(log).toHaveBeenCalled()
  })

  it('keeps content inside Discord\'s 2000-character limit', () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}'))
    createNotifier({ url: 'https://hook.test', suffix: ' · link', fetchImpl })('x'.repeat(3000))
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).content.length).toBeLessThanOrEqual(2000)
  })

  it('escapes Discord markdown in the content, but never in the suffix', () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}'))
    createNotifier({ url: 'https://hook.test', suffix: ' · #history', fetchImpl })('by [x](http://e) **b** #h')
    const content = JSON.parse(fetchImpl.mock.calls[0][1].body).content
    expect(content).toBe('by \\[x\\]\\(http://e\\) \\*\\*b\\*\\* \\#h · #history')
  })

  it('applies the 2000-character budget after escaping, since escaping can only lengthen content', () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}'))
    // 1500 asterisks is under the budget pre-escape, but escapes to 3000 chars.
    createNotifier({ url: 'https://hook.test', suffix: ' · s', fetchImpl })('*'.repeat(1500))
    const content = JSON.parse(fetchImpl.mock.calls[0][1].body).content
    expect(content.length).toBeLessThanOrEqual(2000)
    expect(content.endsWith('… · s')).toBe(true)
  })
})
