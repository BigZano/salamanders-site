import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { BIGINT_MAX, attempt, describe as describeError, isId, isStoreId, scrub } from './librariusText.js'

// Every id, link and token here is invented.
const MAX = 200
const BIG = 9223372036854775807n
// A link as the Librarius must never log or show it: a scheme, or a Discord CDN host followed by a path.
const LINK = /(?:https?|wss?):\/\/|(?:cdn\.discordapp\.com|media\.discordapp\.net)\//i
const TOKEN = 'MTk4OTg5.GaBcDe.not-a-real-token-0123456789'

/** An error whose name and message are what a test says. */
const named = (name, message) => Object.assign(new Error(message), { name })

describe('isId', () => {
  it('takes the digits of a snowflake, 17 to 20 of them, and nothing else', () => {
    expect(isId('12345678901234567')).toBe(true)
    expect(isId('123456789012345678')).toBe(true)
    expect(isId('12345678901234567890')).toBe(true)
    expect(isId('1234567890123456')).toBe(false)
    expect(isId('123456789012345678901')).toBe(false)
    expect(isId('')).toBe(false)
  })

  it('answers true exactly for 17 to 20 digits, over every string', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 30 }), (s) => {
        expect(isId(s)).toBe(/^[0-9]{17,20}$/.test(s))
      }),
      { numRuns: 400 },
    )
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9]{17,20}$/), (s) => {
        expect(isId(s)).toBe(true)
      }),
    )
  })

  it('refuses a stray character at either end, or a line break after the digits', () => {
    const id = '200000000000000410'
    for (const bad of [` ${id}`, `${id} `, `${id}\n`, `\n${id}`, `${id}\n${id}`, `-${id}`, `+${id}`, `${id}.0`, `${id}n`, `0x${id}`, `${id.slice(0, 9)}_${id.slice(9)}`]) {
      expect(isId(bad)).toBe(false)
    }
    // Digits of another script are not digits here.
    expect(isId('٢٠٠٠٠٠٠٠٠٠٠٠٠٠٠٤١٠')).toBe(false)
    expect(isId('２００００００００００００００４１０')).toBe(false)
  })

  it('refuses everything that is not text, however it prints', () => {
    const id = '200000000000000410'
    const printsAsId = { toString: () => id, valueOf: () => id }
    for (const bad of [200000000000000410, 200000000000000410n, null, undefined, true, [id], { id }, printsAsId, new String(id), Symbol(id), () => id]) {
      expect(isId(bad)).toBe(false)
    }
    fc.assert(
      fc.property(fc.anything(), (v) => {
        expect(isId(v)).toBe(typeof v === 'string' && /^[0-9]{17,20}$/.test(v))
      }),
    )
  })
})

describe('isStoreId and BIGINT_MAX', () => {
  it('BIGINT_MAX is the most a Postgres bigint holds', () => {
    expect(BIGINT_MAX).toBe(BIG)
    expect(BIGINT_MAX).toBe(2n ** 63n - 1n)
  })

  it('takes a snowflake up to the bigint maximum and refuses the next', () => {
    expect(isStoreId('9223372036854775807')).toBe(true)
    expect(isStoreId('9223372036854775806')).toBe(true)
    expect(isStoreId('9223372036854775808')).toBe(false)
    expect(isStoreId('9999999999999999999')).toBe(false)
    expect(isStoreId('99999999999999999999')).toBe(false)
    expect(isStoreId('18446744073709551615')).toBe(false)
    expect(isStoreId('00000000000000001')).toBe(true)
    expect(isStoreId('00000000000000000000')).toBe(true)
  })

  it('is a snowflake that fits, over every id-shaped string', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9]{17,20}$/), (s) => {
        expect(isStoreId(s)).toBe(BigInt(s) <= BIG)
      }),
      { numRuns: 400 },
    )
    // The numbers right at the edge, both ways.
    fc.assert(
      fc.property(fc.bigInt({ min: BIG - 1000n, max: BIG + 1000n }), (n) => {
        expect(isStoreId(String(n))).toBe(n <= BIG)
      }),
    )
  })

  it('is no wider than isId, and refuses what is no snowflake before it reads it as a number', () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        if (isStoreId(v)) expect(isId(v)).toBe(true)
      }),
    )
    for (const bad of ['', '1', '1234567890123456', '123456789012345678901', '1e18'.padEnd(18, '0'), ' 200000000000000410', '200000000000000410\n', 200000000000000410n, 200000000000000410, null, undefined, {}, [], ['200000000000000410']]) {
      expect(isStoreId(bad)).toBe(false)
    }
  })
})

describe('scrub', () => {
  it('cuts a link with its scheme, up to the next whitespace', () => {
    expect(scrub('see https://cdn.test/a.png?ex=1&hm=secret now')).toBe('see [link] now')
    expect(scrub('see http://a.test now')).toBe('see [link] now')
    expect(scrub('open wss://gateway.test/?v=10&encoding=json please')).toBe('open [link] please')
    expect(scrub('open ws://gateway.test please')).toBe('open [link] please')
    expect(scrub('https://')).toBe('[link]')
    expect(scrub('(https://a.test/x)')).toBe('([link]')
  })

  it('cuts a link whatever its case', () => {
    expect(scrub('HTTPS://CDN.TEST/X?SIG=1')).toBe('[link]')
    expect(scrub('HtTp://a.test')).toBe('[link]')
    expect(scrub('WSS://a.test and Ws://b.test')).toBe('[link] and [link]')
  })

  it('cuts a link with no scheme when it is on the Discord CDN or media host', () => {
    expect(scrub('cdn.discordapp.com/attachments/1/2/a.png?ex=1&is=2&hm=3')).toBe('[link]')
    expect(scrub('media.discordapp.net/attachments/1/2/a.png?ex=1&hm=3')).toBe('[link]')
    expect(scrub('403 for cdn.discordapp.com/attachments/1/2/a.png?hm=3 today')).toBe('403 for [link] today')
    expect(scrub('403 for media.discordapp.net/a today')).toBe('403 for [link] today')
    expect(scrub('CDN.DiscordApp.COM/attachments/1/2/a.png')).toBe('[link]')
    expect(scrub('Media.DiscordApp.Net/attachments/1/2/a.png')).toBe('[link]')
  })

  it('leaves the host names alone when no path follows, and other hosts without a scheme', () => {
    expect(scrub('connect cdn.discordapp.com failed')).toBe('connect cdn.discordapp.com failed')
    expect(scrub('connect media.discordapp.net failed')).toBe('connect media.discordapp.net failed')
    expect(scrub('cdn.discordapp.com:443 refused')).toBe('cdn.discordapp.com:443 refused')
    expect(scrub('cdnXdiscordappXcom/a')).toBe('cdnXdiscordappXcom/a')
    expect(scrub('media.discordapp.org/a')).toBe('media.discordapp.org/a')
    expect(scrub('cdn.discordapp.net/a')).toBe('cdn.discordapp.net/a')
    expect(scrub('a plain sentence, no more')).toBe('a plain sentence, no more')
    expect(scrub('https:/ not a link, and ftp-less')).toBe('https:/ not a link, and ftp-less')
  })

  it('cuts every link of a text, however they are separated', () => {
    expect(scrub('a https://x.test/1 b http://y.test/2 c cdn.discordapp.com/3 d')).toBe('a [link] b [link] c [link] d')
    expect(scrub('https://x.test/1\nhttps://y.test/2\thttps://z.test/3')).toBe('[link]\n[link]\t[link]')
    expect(scrub('https://x.test/1https://y.test/2')).toBe('[link]')
    expect(scrub('a https://x.test/1　b')).toBe('a [link]　b')
  })

  it('replaces a secret, every time it appears, before it cuts links', () => {
    expect(scrub(`token ${TOKEN} twice ${TOKEN}`, { secret: TOKEN })).toBe('token [token] twice [token]')
    expect(scrub(`Bot ${TOKEN}`, { secret: TOKEN })).toBe('Bot [token]')
    expect(scrub(`https://x.test/${TOKEN}/y`, { secret: TOKEN })).toBe('[link]')
    expect(scrub(`${TOKEN}${TOKEN}`, { secret: TOKEN })).toBe('[token][token]')
  })

  it('does not replace a secret that was not given, or that is not a non-empty text', () => {
    expect(scrub(`token ${TOKEN}`)).toBe(`token ${TOKEN}`)
    expect(scrub(`token ${TOKEN}`, {})).toBe(`token ${TOKEN}`)
    expect(scrub(`token ${TOKEN}`, undefined)).toBe(`token ${TOKEN}`)
    expect(scrub(`token ${TOKEN}`, null)).toBe(`token ${TOKEN}`)
    for (const secret of ['', undefined, null, 0, 12, true, {}, [], [TOKEN], Symbol(TOKEN), () => TOKEN, 5n]) {
      expect(scrub('abc 12 true [object Object] 5', { secret })).toBe('abc 12 true [object Object] 5')
    }
  })

  it('takes a secret literally, not as a pattern or a replacement', () => {
    expect(scrub('abc a.c a*c', { secret: 'a.c' })).toBe('abc [token] a*c')
    expect(scrub('x $& y', { secret: '$&' })).toBe('x [token] y')
    expect(scrub('x (a|b) y', { secret: '(a|b)' })).toBe('x [token] y')
    expect(scrub('Hunter2 hunter2', { secret: 'hunter2' })).toBe('Hunter2 [token]')
  })

  it('prints what is no text, and takes nothing for the empty text', () => {
    expect(scrub(undefined)).toBe('')
    expect(scrub(null)).toBe('')
    expect(scrub(12)).toBe('12')
    expect(scrub(false)).toBe('false')
    expect(scrub(['https://x.test/1', 'b'])).toBe('[link]')
    expect(scrub(Object.create(null))).toBe('')
    expect(scrub({ toString: () => { throw new Error('no') } })).toBe('')
    expect(scrub(Symbol('s'))).toBe('Symbol(s)')
  })

  it('survives an options object whose secret cannot be read', () => {
    const hostile = {
      get secret() {
        throw new Error('no')
      },
    }
    expect(scrub('plain https://x.test', hostile)).toBe('plain [link]')
    expect(scrub('plain', new Proxy({}, { get: () => { throw new Error('no') } }))).toBe('plain')
    // Nothing is replaced for it: not even the word a failed read would leave behind.
    expect(scrub('null undefined NaN [object Object]', hostile)).toBe('null undefined NaN [object Object]')
    expect(scrub('null undefined NaN [object Object]', null)).toBe('null undefined NaN [object Object]')
    expect(scrub('null undefined NaN [object Object]', undefined)).toBe('null undefined NaN [object Object]')
    expect(scrub('null undefined NaN [object Object]', 'secret')).toBe('null undefined NaN [object Object]')
  })

  it('caps the text at 200 characters, counted after the cuts', () => {
    expect(scrub('a'.repeat(199))).toBe('a'.repeat(199))
    expect(scrub('a'.repeat(200))).toBe('a'.repeat(200))
    expect(scrub('a'.repeat(201))).toBe('a'.repeat(200))
    expect(scrub('b'.repeat(5000))).toBe('b'.repeat(200))
    expect(scrub('')).toBe('')
    // A link far past 200 characters long is one cut, not 200 characters of it.
    expect(scrub(`${'a'.repeat(190)} https://x.test/${'p'.repeat(500)}`)).toBe(`${'a'.repeat(190)} [link]`)
    // The cut comes first, and only then the cap, which may cut into the stand-in itself.
    expect(scrub(`${'a'.repeat(192)} https://x.test/${'p'.repeat(500)}`)).toBe(`${'a'.repeat(192)} [link]`)
    expect(scrub(`${'a'.repeat(195)} https://x.test/${'p'.repeat(500)}`)).toBe(`${'a'.repeat(195)} [lin`)
    // And a token that straddled it likewise.
    expect(scrub(`${'a'.repeat(190)}${TOKEN}`, { secret: TOKEN })).toBe(`${'a'.repeat(190)}[token]`)
  })

  it('never splits a character in two at the cap', () => {
    const face = '\u{1F600}'
    expect(scrub(`${'a'.repeat(198)}${face}`)).toBe(`${'a'.repeat(198)}${face}`)
    expect(scrub(`${'a'.repeat(199)}${face}`)).toBe('a'.repeat(199))
    expect(scrub(`${'a'.repeat(200)}${face}`)).toBe('a'.repeat(200))
    expect(scrub(face.repeat(150))).toBe(face.repeat(100))
    expect(scrub(face.repeat(100))).toBe(face.repeat(100))
    expect(scrub(face.repeat(101))).toBe(face.repeat(100))
  })

  it('is the text itself when it holds no link and no secret and is short enough, over every such text', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z0-9 ,.:;!?()'\n\t-]{0,200}$/), (s) => {
        expect(scrub(s)).toBe(s)
      }),
      { numRuns: 300 },
    )
  })

  it('keeps the first 200 characters of a long text with nothing to cut', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z0-9 ]{201,600}$/), (s) => {
        expect(scrub(s)).toBe(s.slice(0, MAX))
      }),
      { numRuns: 100 },
    )
  })

  it('leaves no link, no secret and no more than 200 characters, over hostile text', () => {
    const piece = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 20 }),
      fc.constantFrom(
        'https://', 'HTTP://', 'wss://', 'Ws://', 'cdn.discordapp.com/', 'MEDIA.discordapp.net/', ' ', '\n', '\t', ' ', '\u{1F600}', '/', '.', ':',
        'cdn.discordapp.com', 'ttps://', 'htt', 'x?ex=1&hm=2', TOKEN, TOKEN.slice(0, 8), '[link]', '[token]',
      ),
    )
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 40 }), (parts) => {
        const out = scrub(parts.join(''), { secret: TOKEN })
        expect(out).not.toMatch(LINK)
        expect(out).not.toContain(TOKEN)
        expect(out.length).toBeLessThanOrEqual(MAX)
      }),
      { numRuns: 500 },
    )
  })

  it('answers a well-formed text with a well-formed one', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 300 }), (s) => {
        expect(scrub(s).isWellFormed()).toBe(true)
      }),
    )
  })

  it('never keeps a secret, whatever surrounds it, when it is made of characters the stand-in has none of', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9A-F]{8,40}$/), fc.string({ maxLength: 60 }), fc.string({ maxLength: 60 }), (secret, before, after) => {
        const out = scrub(`${before}${secret}${after}`, { secret })
        expect(out).not.toContain(secret)
      }),
      { numRuns: 300 },
    )
  })
})

describe('describe', () => {
  it('words an error as its name, a colon and its message', () => {
    expect(describeError(new Error('boom'))).toBe('Error: boom')
    expect(describeError(new TypeError('afterId must be a message id, or 0.'))).toBe('TypeError: afterId must be a message id, or 0.')
    expect(describeError(named('Upstream', 'Discord answered 500.'))).toBe('Upstream: Discord answered 500.')
    expect(describeError({ name: 'Custom', message: 'plain object' })).toBe('Custom: plain object')
    expect(describeError(new Error(''))).toBe('Error: ')
  })

  it('says Error with nothing after it for something that is no error', () => {
    for (const odd of [undefined, null, 'a plain string', 0, 42, true, false, 7n, [], {}, [1, 2], NaN]) {
      expect(describeError(odd)).toBe('Error: ')
    }
  })

  it('keeps a name or a message that is empty or not text', () => {
    expect(describeError({ name: '', message: 'm' })).toBe(': m')
    expect(describeError({ name: 'N', message: 5 })).toBe('N: 5')
    expect(describeError({ name: 7, message: 'm' })).toBe('7: m')
    expect(describeError({ name: null, message: null })).toBe('Error: ')
    expect(describeError({ name: undefined, message: undefined })).toBe('Error: ')
    expect(describeError({ name: false, message: false })).toBe('false: false')
    expect(describeError({ name: 'N', message: [1, 2] })).toBe('N: 1,2')
  })

  it('does not throw for a name or a message that cannot be read or printed, and says what it can', () => {
    const throwing = (key) => ({
      get [key]() {
        throw new Error('getter')
      },
    })
    expect(describeError(Object.defineProperties({}, { name: { get() { throw new Error('x') } }, message: { value: 'm' } }))).toBe('Error: m')
    expect(describeError(Object.defineProperties({}, { name: { value: 'N' }, message: { get() { throw new Error('x') } } }))).toBe('N: ')
    expect(describeError(throwing('name'))).toBe('Error: ')
    expect(describeError(throwing('message'))).toBe('Error: ')
    expect(describeError({ name: Symbol('s'), message: Symbol('t') })).toBe('Symbol(s): Symbol(t)')
    expect(describeError({ name: 'N', message: Symbol('t') })).toBe('N: Symbol(t)')
    expect(describeError({ name: 'N', message: { toString() { throw new Error('x') } } })).toBe('N: ')
    expect(describeError({ name: { toString() { throw new Error('x') } }, message: 'm' })).toBe('Error: m')
    expect(describeError({ name: 'N', message: Object.create(null) })).toBe('N: ')
    expect(describeError({ name: Object.create(null), message: 'm' })).toBe('Error: m')
    expect(describeError(Symbol('whole'))).toBe('Error: ')
    expect(describeError(new Proxy({}, { get: () => { throw new Error('trap') } }))).toBe('Error: ')
    expect(describeError(new Proxy(new Error('m'), { get: () => { throw new Error('trap') } }))).toBe('Error: ')
  })

  it('does not throw, whatever it is given as the error or as the options', () => {
    const errors = fc.oneof(
      fc.anything(),
      fc.record({ name: fc.anything(), message: fc.anything() }),
      fc.record({ name: fc.string({ unit: 'binary' }), message: fc.string({ unit: 'binary', maxLength: 500 }) }),
    )
    fc.assert(
      fc.property(errors, fc.anything(), (err, options) => {
        const out = describeError(err, options)
        expect(typeof out).toBe('string')
        expect(out.length).toBeLessThanOrEqual(MAX)
      }),
      { numRuns: 500 },
    )
  })

  it('cuts links out of the name and of the message, with the scrubbing of scrub', () => {
    expect(describeError(new Error('Discord answered 403 for https://cdn.test/a.png?ex=1&hm=secret and http://a.test/b today.'))).toBe(
      'Error: Discord answered 403 for [link] and [link] today.',
    )
    expect(describeError(named('Bad https://x.test/secret', 'x'))).toBe('Bad [link] x')
    expect(describeError(new Error('HTTPS://CDN.TEST/X?SIG=1'))).toBe('Error: [link]')
    expect(describeError(new Error('refused cdn.discordapp.com/attachments/1/2/a.png?hm=3'))).toBe('Error: refused [link]')
    expect(describeError(new Error('refused media.discordapp.net/attachments/1/2/a.png?hm=3'))).toBe('Error: refused [link]')
    expect(describeError(new Error('socket to wss://gateway.test/?v=10 closed'))).toBe('Error: socket to [link] closed')
  })

  it('replaces the secret when given, in the name or the message, and only then', () => {
    expect(describeError(new Error(`Bot ${TOKEN} refused`), { secret: TOKEN })).toBe('Error: Bot [token] refused')
    expect(describeError(named(TOKEN, 'm'), { secret: TOKEN })).toBe('[token]: m')
    expect(describeError(new Error(`Bot ${TOKEN} refused`))).toBe(`Error: Bot ${TOKEN} refused`)
    expect(describeError(new Error(`Bot ${TOKEN} refused`), { secret: '' })).toBe(`Error: Bot ${TOKEN} refused`)
    expect(describeError(new Error('refused'), { secret: TOKEN })).toBe('Error: refused')
  })

  it('caps the whole at 200 characters, the name and the colon counted', () => {
    expect(describeError(new Error('a'.repeat(193)))).toBe(`Error: ${'a'.repeat(193)}`)
    expect(describeError(new Error('a'.repeat(194)))).toBe(`Error: ${'a'.repeat(193)}`)
    expect(describeError(new Error('b'.repeat(5000)))).toBe(`Error: ${'b'.repeat(193)}`)
    expect(describeError(named('N'.repeat(300), 'm'))).toBe('N'.repeat(200))
  })

  it('leaves no link, no secret and no more than 200 characters of anything thrown', () => {
    const text = fc.array(
      fc.oneof(
        fc.string({ unit: 'binary', maxLength: 30 }),
        fc.constantFrom('https://a.test/x?hm=1', 'HTTP://B', 'wss://g.test', 'cdn.discordapp.com/attachments/1/2/x.png', 'media.discordapp.net/x', ' ', TOKEN),
      ),
      { maxLength: 30 },
    )
    fc.assert(
      fc.property(text, text, (name, message) => {
        const out = describeError({ name: name.join(''), message: message.join('') }, { secret: TOKEN })
        expect(out).not.toMatch(LINK)
        expect(out).not.toContain(TOKEN)
        expect(out.length).toBeLessThanOrEqual(MAX)
      }),
      { numRuns: 400 },
    )
  })
})

describe('attempt', () => {
  it('answers true when the write succeeds, after waiting for it', async () => {
    const order = []
    const done = await attempt(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push('written')
    }, () => order.push('refused'))
    order.push(`answered ${done}`)
    expect(order).toEqual(['written', 'answered true'])
  })

  it('answers true whatever a successful write returns', async () => {
    for (const value of [undefined, null, false, 0, '', 'x', {}, [], NaN]) {
      expect(await attempt(() => value, () => {})).toBe(true)
      expect(await attempt(async () => value, () => {})).toBe(true)
    }
  })

  it('answers false, and hands the TypeError to onRefused, when the write rejects with one', async () => {
    const refusals = []
    const refusal = new TypeError('id does not fit')
    expect(await attempt(async () => { throw refusal }, (err) => refusals.push(err))).toBe(false)
    expect(refusals).toEqual([refusal])
    expect(refusals[0]).toBe(refusal)
  })

  it('treats a TypeError thrown at once, and one of a subclass, as a refusal too', async () => {
    class Refused extends TypeError {}
    const refusals = []
    expect(await attempt(() => { throw new TypeError('now') }, (err) => refusals.push(err))).toBe(false)
    expect(await attempt(() => Promise.reject(new Refused('sub')), (err) => refusals.push(err))).toBe(false)
    expect(refusals.map((e) => e.message)).toEqual(['now', 'sub'])
  })

  it('lets anything that is not a TypeError go on up, as it was, and never calls onRefused for it', async () => {
    const refusals = []
    const onRefused = (err) => refusals.push(err)
    const fails = [new Error('down'), new RangeError('range'), new SyntaxError('syntax'), Object.assign(new Error('deadlock'), { code: '40P01' }), 'a string', 7, null, undefined, { name: 'TypeError', message: 'looks like one' }]
    for (const thrown of fails) {
      let caught
      try {
        await attempt(async () => { throw thrown }, onRefused)
        caught = { none: true }
      } catch (err) {
        caught = { err }
      }
      expect(caught.none).toBeUndefined()
      expect(caught.err).toBe(thrown)
      try {
        await attempt(() => { throw thrown }, onRefused)
        caught = { none: true }
      } catch (err) {
        caught = { err }
      }
      expect(caught.err).toBe(thrown)
    }
    expect(refusals).toEqual([])
  })

  it('lets what onRefused throws go on up', async () => {
    const trouble = new Error('the log is closed')
    await expect(attempt(() => { throw new TypeError('x') }, () => { throw trouble })).rejects.toBe(trouble)
  })

  it('refuses a write or an onRefused that is no function, before it runs anything', async () => {
    let ran = false
    const write = () => { ran = true }
    for (const bad of [undefined, null, 'x', 0, {}, []]) {
      await expect(attempt(write, bad)).rejects.toThrow(new TypeError('onRefused must be a function.'))
      await expect(attempt(bad, () => {})).rejects.toThrow(new TypeError('write must be a function.'))
    }
    expect(ran).toBe(false)
    await expect(attempt()).rejects.toThrow(new TypeError('write must be a function.'))
  })

  it('runs the write once', async () => {
    let runs = 0
    await attempt(() => { runs += 1 }, () => {})
    await attempt(() => { runs += 1; throw new TypeError('x') }, () => {})
    expect(runs).toBe(2)
  })
})
