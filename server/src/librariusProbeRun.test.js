import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { inflateSync } from 'node:zlib'
import { ProbeRefused, buildV2, fillText, probeConfig, probePng, runProbe } from './librariusProbeRun.js'

// Every id here is invented.
const LIBRARIUS = '200000000000000400'
const GUILD = '200000000000000401'
const OWNER = '200000000000000402'
const WEBHOOK = '200000000000000403'
const PROBE = '200000000000000411'
// The fake hands out ids in order from here: the post first, then one for each message it accepts.
const POST = '200000000000000600'
const idAfter = (n) => String(BigInt(POST) + BigInt(n))
const BOT_TOKEN = 'bot-token-for-the-test-9f8e7d'
const WEBHOOK_TOKEN = 'webhook-token-for-the-test-1a2b3c'
const API = 'https://discord.test/api'

const ENV = {
  DISCORD_API_BASE: API,
  DISCORD_BOT_TOKEN: BOT_TOKEN,
  DISCORD_GUILD_ID: GUILD,
  LIBRARIUS_CHANNEL_ID: LIBRARIUS,
  LIBRARIUS_PROBE_CHANNEL_ID: PROBE,
}

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

// The characters of every Text Display in a Components V2 payload, however deep.
function textOf(components) {
  let total = 0
  const walk = (list) => {
    for (const c of list ?? []) {
      if (c.type === 10) total += c.content.length
      walk(c.components)
    }
  }
  walk(components)
  return total
}

// The characters of every button label too: Discord may count them in the 4000 of a message, so the fake does.
function labelsOf(components) {
  let total = 0
  const walk = (list) => {
    for (const c of list ?? []) {
      if (c.type === 2) total += c.label.length
      walk(c.components)
    }
  }
  walk(components)
  return total
}

const countedOf = (components) => textOf(components) + labelsOf(components)

const textsOf = (components) => {
  const out = []
  const walk = (list) => {
    for (const c of list ?? []) {
      if (c.type === 10) out.push(c.content)
      walk(c.components)
    }
  }
  walk(components)
  return out
}

const OVER_LIMIT = {
  code: 50035,
  message: 'Invalid Form Body',
  errors: { components: { 0: { components: { 0: { _errors: [{ code: 'BASE_TYPE_MAX_LENGTH', message: 'Must be 4000 or fewer in length.' }] } } } } },
}

/**
 * A fake of the few Discord routes the probe calls, on a clock the test owns. `reply(call)` may answer a call itself
 * (a { status, body } or a thrown error); otherwise the fake answers like Discord would, refusing a V2 message whose
 * text is over 4000 characters in all.
 */
function world({ channelType = 15, channel = {}, rules = [], reply = () => undefined, ownerId = OWNER } = {}) {
  let clock = 1_000_000
  let nextId = 0
  const fresh = () => String(200000000000000600n + BigInt(nextId++))
  const calls = []
  const sleeps = []

  async function fetchImpl(url, init = {}) {
    clock += 25
    const u = new URL(url)
    const call = {
      href: u.href,
      method: init.method ?? 'GET',
      path: u.pathname.slice('/api'.length),
      query: u.searchParams,
      headers: init.headers ?? {},
      at: clock,
      json: undefined,
      file: undefined,
    }
    if (typeof init.body === 'string') call.json = JSON.parse(init.body)
    else if (init.body instanceof FormData) {
      call.json = JSON.parse(init.body.get('payload_json'))
      const part = init.body.get('files[0]')
      call.file = { name: part.name, type: part.type, bytes: new Uint8Array(await part.arrayBuffer()) }
    }
    calls.push(call)

    const custom = reply(call)
    if (custom) return json(custom.status, custom.body, custom.headers)

    const { method, path } = call
    if (method === 'GET' && path === `/v10/channels/${PROBE}`) {
      return json(200, {
        id: PROBE,
        type: channelType,
        guild_id: GUILD,
        // The forum is private: @everyone (the role whose id is the guild's) is denied View Channel.
        permission_overwrites: [{ id: GUILD, type: 0, allow: '0', deny: '1024' }],
        ...channel,
      })
    }
    if (method === 'GET' && path === `/v10/guilds/${GUILD}`) return json(200, { id: GUILD, owner_id: ownerId })
    if (method === 'GET' && path === `/v10/guilds/${GUILD}/auto-moderation/rules`) return json(200, rules)
    if (method === 'POST' && path === `/v10/channels/${PROBE}/webhooks`) {
      return json(200, { id: WEBHOOK, token: WEBHOOK_TOKEN, name: call.json.name })
    }
    if (path === `/v10/webhooks/${WEBHOOK}/${WEBHOOK_TOKEN}` && method === 'POST') {
      if (call.json.flags === 32768 && countedOf(call.json.components) > 4000) return json(400, OVER_LIMIT)
      const id = fresh()
      return json(200, { id, channel_id: call.json.thread_name ? id : call.query.get('thread_id') })
    }
    if (path.startsWith(`/v10/webhooks/${WEBHOOK}/${WEBHOOK_TOKEN}/messages/`) && method === 'PATCH') {
      if (countedOf(call.json.components) > 4000) return json(400, OVER_LIMIT)
      return json(200, { id: path.split('/').pop() })
    }
    if (method === 'DELETE' && path === `/v10/webhooks/${WEBHOOK}`) return new Response(null, { status: 204 })
    return json(404, { code: 0, message: '404: Not Found' })
  }

  return {
    calls,
    sleeps,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    now: () => clock,
  }
}

async function run({ argv = [], env = ENV, interrupt = { handler: null, off: false }, ...options } = {}) {
  const w = world(options)
  const out = []
  const errs = []
  const exits = []
  const code = await runProbe({
    argv,
    env,
    fetchImpl: w.fetchImpl,
    sleep: w.sleep,
    now: w.now,
    onInterrupt: (handler) => {
      interrupt.handler = handler
      return () => {
        interrupt.off = true
      }
    },
    exit: (c) => exits.push(c),
    log: (line) => out.push(String(line)),
    warn: (line) => errs.push(String(line)),
  })
  const all = [...out, ...errs].join('\n')
  const executes = w.calls.filter((c) => c.method === 'POST' && c.path === `/v10/webhooks/${WEBHOOK}/${WEBHOOK_TOKEN}`)
  return {
    ...w,
    code,
    exits,
    interrupt,
    out,
    errs,
    all,
    post: executes.find((c) => c.json.thread_name !== undefined),
    sends: executes.filter((c) => c.json.thread_name === undefined),
    edits: w.calls.filter((c) => c.method === 'PATCH'),
  }
}

describe('probeConfig: the settings the probe refuses to run without', () => {
  it('takes the token, the guild and the probe forum from the environment', () => {
    expect(probeConfig(ENV)).toEqual({ apiBase: API, botToken: BOT_TOKEN, guildId: GUILD, probeId: PROBE, librariusId: LIBRARIUS })
  })

  it('talks to the real Discord unless the environment names another API (the e2e mock)', () => {
    expect(probeConfig({ ...ENV, DISCORD_API_BASE: '' }).apiBase).toBe('https://discord.com/api')
    expect(probeConfig({ ...ENV, DISCORD_API_BASE: undefined }).apiBase).toBe('https://discord.com/api')
    expect(probeConfig({ ...ENV, DISCORD_API_BASE: 'http://mock:9000/api/' }).apiBase).toBe('http://mock:9000/api')
  })

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['not text', 411],
    ['too short', '1'.repeat(16)],
    ['too long', '1'.repeat(21)],
    ['not digits', '20000000000000041x'],
    ['spaced', ` ${PROBE}`],
    ['a negative number', `-${PROBE}`],
    ['a url', 'https://discord.com/channels/1/2'],
  ])('refuses a probe channel id that is %s', (_name, value) => {
    expect(() => probeConfig({ ...ENV, LIBRARIUS_PROBE_CHANNEL_ID: value })).toThrow(ProbeRefused)
  })

  it('refuses any probe channel id that is not 17 to 20 digits', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/^\d{17,20}$/.test(s)),
        (value) => {
          expect(() => probeConfig({ ...ENV, LIBRARIUS_PROBE_CHANNEL_ID: value })).toThrow(ProbeRefused)
        },
      ),
    )
  })

  it('refuses the Librarius channel itself, however its number is written', () => {
    expect(() => probeConfig({ ...ENV, LIBRARIUS_PROBE_CHANNEL_ID: LIBRARIUS })).toThrow(/Librarius/)
    // Discord reads an id as a number, so leading zeros name the same channel.
    expect(() => probeConfig({ ...ENV, LIBRARIUS_PROBE_CHANNEL_ID: `00${LIBRARIUS}` })).toThrow(/Librarius/)
    expect(() => probeConfig({ ...ENV, LIBRARIUS_PROBE_CHANNEL_ID: LIBRARIUS, LIBRARIUS_CHANNEL_ID: `0${LIBRARIUS}` })).toThrow(
      /Librarius/,
    )
  })

  it('does not mind when the Librarius is not configured at all, and then knows no Librarius forum', () => {
    expect(probeConfig({ ...ENV, LIBRARIUS_CHANNEL_ID: undefined })).toMatchObject({ probeId: PROBE, librariusId: null })
    expect(probeConfig({ ...ENV, LIBRARIUS_CHANNEL_ID: '' })).toMatchObject({ probeId: PROBE, librariusId: null })
  })

  it.each([
    ['with a stray space before it', ` ${LIBRARIUS}`],
    ['with a stray space after it', `${LIBRARIUS} `],
    ['a line break after it', `${LIBRARIUS}\n`],
    ['not digits', 'the librarius'],
    ['too short', '1'.repeat(16)],
    ['too long', '1'.repeat(21)],
    ['only spaces', ' '],
    ['null', null],
    ['a number', 200000000000000400],
  ])('refuses a Librarius channel id that is set but %s, so the check against it cannot fail open', (_name, value) => {
    // Were it let through, the equality check against the probe forum would compare against nothing, and pass.
    for (const probe of [PROBE, LIBRARIUS]) {
      expect(() => probeConfig({ ...ENV, LIBRARIUS_PROBE_CHANNEL_ID: probe, LIBRARIUS_CHANNEL_ID: value })).toThrow(/LIBRARIUS_CHANNEL_ID/)
    }
  })

  it('refuses any Librarius channel id that is set but is not 17 to 20 digits, naming the variable and not its value', () => {
    const messageFor = (value) => {
      try {
        probeConfig({ ...ENV, LIBRARIUS_CHANNEL_ID: value })
      } catch (err) {
        return err.message
      }
      return ''
    }
    const fixed = messageFor('x')
    expect(fixed).toMatch(/LIBRARIUS_CHANNEL_ID/)
    // One message for every value: it cannot be echoing any of them.
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((v) => !/^\d{17,20}$/.test(v)),
        (value) => {
          expect(messageFor(value)).toBe(fixed)
        },
      ),
    )
  })

  it.each([
    ['DISCORD_BOT_TOKEN', undefined],
    ['DISCORD_BOT_TOKEN', ''],
    ['DISCORD_GUILD_ID', undefined],
    ['DISCORD_GUILD_ID', 'the guild'],
  ])('refuses %s when it is %j', (name, value) => {
    expect(() => probeConfig({ ...ENV, [name]: value })).toThrow(new RegExp(name))
  })

  it('names a variable in a refusal, never a value', () => {
    for (const bad of [{ LIBRARIUS_PROBE_CHANNEL_ID: 'wrong' }, { LIBRARIUS_PROBE_CHANNEL_ID: LIBRARIUS }, { DISCORD_GUILD_ID: 'oops' }]) {
      let message = ''
      try {
        probeConfig({ ...ENV, ...bad })
      } catch (err) {
        message = err.message
      }
      expect(message).not.toBe('')
      expect(message).not.toContain(BOT_TOKEN)
      expect(message).not.toContain(LIBRARIUS)
      expect(message).not.toContain('wrong')
      expect(message).not.toContain('oops')
    }
  })
})

describe('fillText: text of exactly the length a limit needs probing at', () => {
  it('is exactly the length asked for, and starts with the label', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 6000 }), (n) => {
        const label = 'Probe one: '
        const text = fillText(label, n)
        expect(text.length).toBe(n)
        expect(n >= label.length ? text.startsWith(label) : label.startsWith(text)).toBe(true)
      }),
    )
  })

  it('refuses a length that is not a whole number of at least 0', () => {
    for (const n of [-1, 1.5, Number.NaN, Infinity, '10', undefined]) expect(() => fillText('x', n)).toThrow(RangeError)
  })

  it('has no line breaks, so the length is the same however Discord counts them', () => {
    expect(fillText('Probe: ', 3990)).not.toMatch(/[\r\n]/)
  })
})

describe('probePng: the picture that rides along in message 1', () => {
  const png = probePng()
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)

  function crc32(bytes) {
    let c = ~0
    for (const b of bytes) {
      c ^= b
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
    }
    return ~c >>> 0
  }

  function chunks() {
    const list = []
    for (let at = 8; at < png.length; ) {
      const length = view.getUint32(at)
      const type = String.fromCharCode(...png.slice(at + 4, at + 8))
      const data = png.slice(at + 8, at + 8 + length)
      const crc = view.getUint32(at + 8 + length)
      list.push({ type, data, crc, checked: crc32(png.slice(at + 4, at + 8 + length)) })
      at += 12 + length
    }
    return list
  }

  it('starts with the PNG signature', () => {
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  })

  it('is an IHDR, an IDAT and an IEND, each with the right checksum', () => {
    const list = chunks()
    expect(list.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
    for (const c of list) expect(c.crc).toBe(c.checked)
  })

  it('is 1 pixel by 1, 8-bit RGBA, with a pixel that is not transparent', () => {
    const [ihdr, idat] = chunks()
    const head = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength)
    expect(head.getUint32(0)).toBe(1)
    expect(head.getUint32(4)).toBe(1)
    expect([...ihdr.data.slice(8)]).toEqual([8, 6, 0, 0, 0])
    const pixels = inflateSync(idat.data)
    expect(pixels.length).toBe(5) // one filter byte and four channels
    expect(pixels[0]).toBe(0)
    expect(pixels[4]).toBe(255)
  })

  it('ends exactly at the IEND chunk', () => {
    expect(png.length).toBe(8 + chunks().reduce((n, c) => n + 12 + c.data.length, 0))
  })
})

describe('buildV2: a Components V2 message in one Container', () => {
  it('is flagged V2, holds one Container and carries no plain content', () => {
    const body = buildV2('hello')
    expect(body.flags).toBe(32768)
    expect(body).not.toHaveProperty('content')
    expect(body.components).toEqual([{ type: 17, components: [{ type: 10, content: 'hello' }] }])
  })

  it('makes one Text Display for each text it is given', () => {
    const body = buildV2(['a', 'b', 'c'])
    expect(textsOf(body.components)).toEqual(['a', 'b', 'c'])
  })

  it('adds a Separator, a Media Gallery and a link button, in that order, after the text', () => {
    const body = buildV2('t', {
      image: 'attachment://probe.png',
      button: { label: 'Open On Site', url: 'https://example.test/x' },
    })
    expect(body.components[0].components).toEqual([
      { type: 10, content: 't' },
      { type: 14, divider: true, spacing: 1 },
      { type: 12, items: [{ media: { url: 'attachment://probe.png' } }] },
      { type: 1, components: [{ type: 2, style: 5, label: 'Open On Site', url: 'https://example.test/x' }] },
    ])
  })

  it('has no Separator when there is nothing to separate the text from', () => {
    expect(buildV2('t', {}).components[0].components.map((c) => c.type)).toEqual([10])
  })

  it('keeps the text exactly as given', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(textsOf(buildV2(text).components)).toEqual([text])
      }),
    )
  })
})

describe('runProbe: what the owner can trust before anything is sent', () => {
  it.each([
    ['the probe forum is not set', { LIBRARIUS_PROBE_CHANNEL_ID: undefined }, /LIBRARIUS_PROBE_CHANNEL_ID/],
    ['the probe forum is not an id', { LIBRARIUS_PROBE_CHANNEL_ID: 'forum' }, /LIBRARIUS_PROBE_CHANNEL_ID/],
    ['the probe forum is the Librarius', { LIBRARIUS_PROBE_CHANNEL_ID: LIBRARIUS }, /Librarius/],
    ['there is no bot token', { DISCORD_BOT_TOKEN: '' }, /DISCORD_BOT_TOKEN/],
  ])('exits 2 and calls nothing when %s', async (_name, change, message) => {
    const r = await run({ env: { ...ENV, ...change } })
    expect(r.code).toBe(2)
    expect(r.calls).toEqual([])
    expect(r.errs.join('\n')).toMatch(message)
    expect(r.out).toEqual([])
  })

  it('exits 2 on an argument it does not know, calling nothing, so a typo never runs a step', async () => {
    for (const argv of [['--automd'], ['--dry'], ['automod'], ['--automod', 'extra'], ['-x']]) {
      const r = await run({ argv })
      expect(r.code).toBe(2)
      expect(r.calls).toEqual([])
      expect(r.errs.join('\n')).toMatch(/usage/)
    }
  })

  it.each([0, 4, 5, 13, 16])('exits 2 when the probe channel is type %i, not a forum, creating no webhook', async (type) => {
    const r = await run({ channelType: type })
    expect(r.code).toBe(2)
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /v10/channels/${PROBE}`])
    expect(r.errs.join('\n')).toMatch(/forum/)
  })

  it('exits 1, creating nothing, when the probe channel cannot be read', async () => {
    const r = await run({ reply: (c) => (c.path === `/v10/channels/${PROBE}` ? { status: 403, body: { code: 50001, message: 'Missing Access' } } : undefined) })
    expect(r.code).toBe(1)
    expect(r.calls).toHaveLength(1)
    expect(r.errs.join('\n')).toMatch(/403/)
  })
})

describe('runProbe: the run', () => {
  it('reads the channel, then makes a webhook called Librarius probe in the probe forum, as the bot', async () => {
    const r = await run()
    expect(r.code).toBe(0)
    const [channel] = r.calls
    expect(`${channel.method} ${channel.path}`).toBe(`GET /v10/channels/${PROBE}`)
    expect(channel.headers.Authorization).toBe(`Bot ${BOT_TOKEN}`)
    const made = r.calls.find((c) => c.path === `/v10/channels/${PROBE}/webhooks`)
    expect(made.method).toBe('POST')
    expect(made.json).toEqual({ name: 'Librarius probe' })
    expect(made.headers.Authorization).toBe(`Bot ${BOT_TOKEN}`)
    expect(r.calls.indexOf(made)).toBeLessThan(r.calls.indexOf(r.post))
  })

  it('makes one post by webhook with a timed name and a plain first message', async () => {
    const r = await run()
    expect(r.post.json.thread_name).toMatch(/^Librarius probe \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
    expect(typeof r.post.json.content).toBe('string')
    expect(r.post.json.content.length).toBeGreaterThan(0)
    expect(r.post.json.allowed_mentions).toEqual({ parse: [] })
    expect(r.post.query.get('wait')).toBe('true')
    expect(r.post.query.has('thread_id')).toBe(false)
  })

  it('sends every message into that post, waiting for the answer, with components and no mentions parsed', async () => {
    const r = await run()
    expect(r.sends.length).toBe(10)
    for (const s of r.sends) {
      expect(s.query.get('thread_id')).toBe(POST)
      expect(s.query.get('wait')).toBe('true')
      expect(s.query.get('with_components')).toBe('true')
      expect(s.json.allowed_mentions).toEqual({ parse: [] })
    }
  })

  it('never sends the bot token to a webhook route, nor the webhook token in a header', async () => {
    const r = await run()
    for (const c of r.calls.filter((x) => x.path.includes(WEBHOOK_TOKEN))) {
      expect(JSON.stringify(c.headers)).not.toContain(BOT_TOKEN)
      expect(Object.keys(c.headers).map((h) => h.toLowerCase())).not.toContain('authorization')
    }
  })

  it('only ever calls the API it was pointed at, and never the Librarius channel', async () => {
    const r = await run()
    expect(r.calls.length).toBeGreaterThan(10)
    for (const c of r.calls) expect(c.href.startsWith(`${API}/v10/`)).toBe(true)
    for (const c of r.calls) expect(`${c.path}?${c.query}`).not.toContain(LIBRARIUS)
    for (const c of r.calls) expect(JSON.stringify(c.json ?? '')).not.toContain(LIBRARIUS)
  })

  it('sends message 1: a V2 message of 3988 characters, a Separator, the picture and a link button', async () => {
    const r = await run()
    const one = r.sends[0]
    expect(one.json.flags).toBe(32768)
    expect(one.json).not.toHaveProperty('content')
    const [container] = one.json.components
    expect(one.json.components).toHaveLength(1)
    expect(container.type).toBe(17)
    expect(container.components.map((c) => c.type)).toEqual([10, 14, 12, 1])
    expect(container.components[0].content).toHaveLength(3988)
    // With the 12 characters of the button's label the message is 4000 exactly, whether or not Discord counts labels.
    expect(countedOf(one.json.components)).toBe(4000)
    expect(container.components[2].items).toEqual([{ media: { url: 'attachment://probe.png' } }])
    expect(container.components[3].components).toEqual([
      { type: 2, style: 5, label: 'Open On Site', url: 'https://sm2salamanders.site/reliquarium/librarius' },
    ])
    expect(one.json.attachments).toEqual([{ id: 0, filename: 'probe.png' }])
    expect(one.file.name).toBe('probe.png')
    expect(one.file.type).toBe('image/png')
    expect([...one.file.bytes]).toEqual([...probePng()])
  })

  it('gives message 1 a word to search for, and no line break in its 3988 characters', async () => {
    const r = await run()
    const text = r.sends[0].json.components[0].components[0].content
    expect(text).toMatch(/quokkaprobe/)
    expect(text).not.toMatch(/[\r\n]/)
  })

  it('sends message 2: V2 Text Displays that total 4001 characters, and records the refusal', async () => {
    const r = await run()
    const two = r.sends[1]
    expect(two.json.flags).toBe(32768)
    expect(textOf(two.json.components)).toBe(4001)
    expect(two.file).toBeUndefined()
    const table = r.out.join('\n')
    expect(table).toMatch(/\b400\b/)
    expect(table).toMatch(/50035/)
    expect(table).toMatch(/Must be 4000 or fewer in length/)
  })

  it('sends message 3 with the guild owner mentioned, the owner read from the guild', async () => {
    const r = await run()
    const three = r.sends[2]
    expect(three.json.flags).toBe(32768)
    expect(textsOf(three.json.components).join('\n')).toContain(`<@${OWNER}>`)
    expect(r.calls.some((c) => c.method === 'GET' && c.path === `/v10/guilds/${GUILD}`)).toBe(true)
    expect(three.json.allowed_mentions).toEqual({ parse: [] })
  })

  it('skips message 3, and says so, when the owner cannot be read', async () => {
    const r = await run({ reply: (c) => (c.path === `/v10/guilds/${GUILD}` ? { status: 403, body: { code: 50001, message: 'Missing Access' } } : undefined) })
    expect(r.code).toBe(0)
    expect(r.sends).toHaveLength(9)
    expect(r.sends.every((s) => !JSON.stringify(s.json).includes('<@'))).toBe(true)
    expect(r.out.join('\n')).toMatch(/3.*skipped/i)
  })

  it('sends a 3-part reply of 11,500 characters, 1500 ms or more apart, each part inside the limit', async () => {
    const r = await run()
    const parts = r.sends.slice(3, 6)
    expect(parts.map((p) => textOf(p.json.components)).reduce((a, b) => a + b, 0)).toBe(11_500)
    for (const p of parts) {
      expect(p.json.flags).toBe(32768)
      expect(textOf(p.json.components)).toBeLessThanOrEqual(3900)
    }
    expect(parts[1].at - parts[0].at).toBeGreaterThanOrEqual(1500)
    expect(parts[2].at - parts[1].at).toBeGreaterThanOrEqual(1500)
  })

  it('edits part 1 afterwards, to add jump links to parts 2 and 3, and the edit still fits', async () => {
    const r = await run()
    expect(r.edits).toHaveLength(1)
    const [edit] = r.edits
    const parts = r.sends.slice(3, 6)
    // The post is id 0, message 1 is 1, message 2 was refused and took no id, so message 3 is 2 and the parts are 3, 4, 5.
    expect(edit.method).toBe('PATCH')
    expect(edit.path).toBe(`/v10/webhooks/${WEBHOOK}/${WEBHOOK_TOKEN}/messages/${idAfter(3)}`)
    expect(edit.query.get('thread_id')).toBe(POST)
    expect(edit.query.get('with_components')).toBe('true')
    expect(edit.json.allowed_mentions).toEqual({ parse: [] })
    expect(edit.json.flags).toBe(32768)
    const text = textsOf(edit.json.components).join('\n')
    expect(text.match(/https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+/g)).toEqual([
      `https://discord.com/channels/${GUILD}/${POST}/${idAfter(4)}`,
      `https://discord.com/channels/${GUILD}/${POST}/${idAfter(5)}`,
    ])
    expect(textOf(edit.json.components)).toBeLessThanOrEqual(4000)
    // It keeps all of part 1's own text, and comes after the third part.
    expect(text.startsWith(textsOf(parts[0].json.components)[0])).toBe(true)
    expect(edit.at).toBeGreaterThan(parts[2].at)
  })

  it('sends a plain message of exactly 2000 characters with the SUPPRESS_EMBEDS flag', async () => {
    const r = await run()
    const plain = r.sends[6]
    expect(plain.json.content).toHaveLength(2000)
    expect(plain.json.flags).toBe(4)
    expect(plain.json).not.toHaveProperty('components')
  })

  it('then sends three more replies, 1500 ms or more apart, inside 60 seconds', async () => {
    const r = await run()
    const burst = r.sends.slice(7, 10)
    expect(burst).toHaveLength(3)
    for (const b of burst) expect(b.json.flags).toBe(32768)
    expect(burst[1].at - burst[0].at).toBeGreaterThanOrEqual(1500)
    expect(burst[2].at - burst[1].at).toBeGreaterThanOrEqual(1500)
    expect(burst[2].at - burst[0].at).toBeLessThan(60_000)
  })

  it('spaces every send 1500 ms or more from the one before, so the probe never trips a rate limit itself', async () => {
    const r = await run()
    const times = r.calls.filter((c) => c.path.startsWith(`/v10/webhooks/${WEBHOOK}/`) && c.method !== 'DELETE').map((c) => c.at)
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(1500)
  })

  it('does not send the AutoMod message, nor read the rules, without --automod', async () => {
    const r = await run({ rules: [{ trigger_type: 1, enabled: true, trigger_metadata: { keyword_filter: ['spam'] } }] })
    expect(r.sends).toHaveLength(10)
    expect(r.calls.some((c) => c.path.includes('auto-moderation'))).toBe(false)
    expect(r.all).not.toContain('spam')
  })

  it('deletes the probe webhook last, as the bot, and leaves the post alone', async () => {
    const r = await run()
    const last = r.calls.at(-1)
    expect(`${last.method} ${last.path}`).toBe(`DELETE /v10/webhooks/${WEBHOOK}`)
    expect(last.headers.Authorization).toBe(`Bot ${BOT_TOKEN}`)
    expect(r.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)
    expect(r.calls.some((c) => c.path.startsWith('/v10/channels/') && c.method === 'DELETE')).toBe(false)
  })
})

describe('runProbe: what it prints', () => {
  it('prints a row for every step with its status, code, message, time and message id, then the checklist', async () => {
    const r = await run()
    const text = r.out.join('\n')
    // a header, a rule and a row for each call: the webhook, the post, 1, 2, 3, three parts, the edit, 5, three more, the delete
    expect(r.out.filter((l) => l.startsWith('|'))).toHaveLength(2 + 14)
    // the refused message 2 has a status, a code, Discord's text, and no message id
    const row2 = r.out.find((l) => /^\|\s*2\b/.test(l))
    expect(row2).toMatch(/\b400\b/)
    expect(row2).toMatch(/50035/)
    expect(row2).toMatch(/\|\s*25\s*\|/) // the fake takes 25 ms to answer
    // message 1 has an id: the first one the fake made after the post
    const row1 = r.out.find((l) => /^\|\s*1\b/.test(l))
    expect(row1).toMatch(/\b200\b/)
    expect(row1).toContain(idAfter(1))
    expect(text).toContain(
      'Open the probe post on desktop and on a phone. (a) Message 1 shows in full, the image sits inside the box, the button works. (b) Message 3 shows your name as a mention and you got no ping. (c) The 3-part reply reads in order with working jump links. (d) Search Discord for a word from message 1: is it found? (e) Your moderators\' AutoMod alert channel shows nothing (or, with --automod, what it shows). (f) Your account has no timeout or warning. Reply with the table and a–f.',
    )
    expect(r.out.at(-1)).toContain('Reply with the table and a–f.')
  })

  it('tells the owner the word to search for, and that the search can lag, after the table and before the checklist', async () => {
    const r = await run()
    const line = r.out.indexOf("search word for (d): quokkaprobe, and Discord's search index can lag a few minutes")
    expect(line).toBeGreaterThan(r.out.findLastIndex((l) => l.startsWith('|')))
    expect(line).toBeLessThan(r.out.findIndex((l) => l.startsWith('Open the probe post')))
    // and it is the word that message 1 holds
    expect(r.sends[0].json.components[0].components[0].content).toContain('quokkaprobe')
  })

  it('names the post it made, by its id, so the owner can find it', async () => {
    const r = await run()
    expect(r.all).toContain(`https://discord.com/channels/${GUILD}/${POST}`)
  })

  it('never prints the bot token, the webhook token or a webhook url, whatever Discord says', async () => {
    const echo = `bad ${BOT_TOKEN} and ${WEBHOOK_TOKEN} at https://discord.com/api/webhooks/${WEBHOOK}/${WEBHOOK_TOKEN}?wait=true done`
    const r = await run({
      reply: (c) => (c.json?.flags === 32768 && textOf(c.json.components) === 4001 ? { status: 400, body: { code: 50035, message: echo } } : undefined),
    })
    expect(r.all).toContain('50035')
    expect(r.all).not.toContain(BOT_TOKEN)
    expect(r.all).not.toContain(WEBHOOK_TOKEN)
    expect(r.all).not.toMatch(/https?:\/\/discord\.com\/api\/webhooks/)
    expect(r.all).not.toContain(`/webhooks/${WEBHOOK}`)
  })

  it('never prints a token however it is placed in what Discord says', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 120 }), fc.string({ maxLength: 120 }), fc.string({ maxLength: 120 }), async (a, b, c) => {
        const echo = `${a}${WEBHOOK_TOKEN}${b}${BOT_TOKEN}${c}${WEBHOOK_TOKEN.slice(0, 12)}`
        const r = await run({
          reply: (call) => (call.json?.flags === 32768 && textOf(call.json.components) === 4001 ? { status: 400, body: { code: 50035, message: echo, errors: { x: { _errors: [{ code: 'X', message: echo }] } } } } : undefined),
        })
        expect(r.all).not.toContain(BOT_TOKEN)
        expect(r.all).not.toContain(WEBHOOK_TOKEN)
      }),
      { numRuns: 40 },
    )
  })

  it('never prints a token that a network error carries in its message', async () => {
    const r = await run({
      reply: (c) => {
        if (c.json?.flags === 32768 && textOf(c.json.components) === 4001) {
          throw Object.assign(new TypeError(`connect failed for https://discord.com/api/v10/webhooks/${WEBHOOK}/${WEBHOOK_TOKEN}`), { code: 'ConnectionRefused' })
        }
        return undefined
      },
    })
    expect(r.code).toBe(0)
    expect(r.all).not.toContain(WEBHOOK_TOKEN)
    expect(r.all).not.toContain(BOT_TOKEN)
    const row2 = r.out.find((l) => /^\|\s*2\b/.test(l))
    expect(row2).toMatch(/TypeError/)
    expect(row2).toMatch(/ConnectionRefused/)
  })

  it('keeps the table to one line a row, however Discord words a message', async () => {
    const r = await run({
      reply: (c) => (c.json?.flags === 32768 && textOf(c.json.components) === 4001 ? { status: 400, body: { code: 50035, message: 'one\ntwo | three\r\nfour' } } : undefined),
    })
    const row2 = r.out.find((l) => /^\|\s*2\b/.test(l))
    expect(row2).toMatch(/one two \/ three four/)
    expect(row2).not.toMatch(/[\r\n]/)
  })

  it('cuts a link out of what Discord says', async () => {
    const r = await run({
      reply: (c) => (c.json?.flags === 32768 && textOf(c.json.components) === 4001 ? { status: 400, body: { code: 50035, message: 'see https://cdn.discordapp.com/x?sig=abc please' } } : undefined),
    })
    expect(r.all).not.toContain('sig=abc')
    expect(r.all).toContain('[link]')
  })

  it('keeps a code that is not a number, and a status that is not JSON, from breaking the table', async () => {
    const r = await run({
      reply: (c) => (c.json?.flags === 32768 && textOf(c.json.components) === 4001 ? { status: 502, body: '<html>bad gateway</html>' } : undefined),
    })
    expect(r.code).toBe(0)
    expect(r.out.find((l) => /^\|\s*2\b/.test(l))).toMatch(/\b502\b/)
  })
})

describe('runProbe: when a step goes wrong', () => {
  it('goes on to the next step after a refusal, because a refusal is the finding', async () => {
    const r = await run()
    expect(r.sends).toHaveLength(10)
    expect(r.code).toBe(0)
  })

  it('goes on after a network failure, recording it', async () => {
    let n = 0
    const r = await run({
      reply: (c) => {
        if (c.json?.flags === 32768 && textOf(c.json.components) === 3988 && n++ === 0) throw new TypeError('socket closed')
        return undefined
      },
    })
    expect(r.code).toBe(0)
    expect(r.sends.length).toBe(10)
    expect(r.out.find((l) => /^\|\s*1\b/.test(l))).toMatch(/TypeError/)
  })

  it('does not edit part 1 when part 2 or 3 was refused, and says why', async () => {
    const r = await run({
      reply: (c) => (textsOf(c.json?.components).some((t) => t.startsWith('Part 2 of 3')) ? { status: 400, body: { code: 50035, message: 'no' } } : undefined),
    })
    expect(r.edits).toEqual([])
    expect(r.out.join('\n')).toMatch(/4.*edit.*skipped/i)
    expect(r.calls.at(-1).method).toBe('DELETE')
  })

  it('exits 1 and creates nothing more when the webhook cannot be made', async () => {
    const r = await run({ reply: (c) => (c.path === `/v10/channels/${PROBE}/webhooks` ? { status: 403, body: { code: 50013, message: 'Missing Permissions' } } : undefined) })
    expect(r.code).toBe(1)
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /v10/channels/${PROBE}`,
      `GET /v10/guilds/${GUILD}`,
      `POST /v10/channels/${PROBE}/webhooks`,
    ])
    expect(r.all).toMatch(/403/)
    expect(r.all).toMatch(/50013/)
  })

  it('exits 1, sends nothing and still deletes the webhook when the post cannot be made', async () => {
    const r = await run({ reply: (c) => (c.json?.thread_name ? { status: 400, body: { code: 50035, message: 'Invalid Form Body' } } : undefined) })
    expect(r.code).toBe(1)
    expect(r.sends).toEqual([])
    expect(r.calls.at(-1).method).toBe('DELETE')
    expect(r.all).not.toContain(WEBHOOK_TOKEN)
  })

  it('exits 1 and says the webhook is still there when it cannot be deleted', async () => {
    const r = await run({ reply: (c) => (c.method === 'DELETE' ? { status: 403, body: { code: 50013, message: 'Missing Permissions' } } : undefined) })
    expect(r.code).toBe(1)
    expect(r.all).toMatch(/not deleted/i)
    expect(r.all).toMatch(/Librarius probe/)
    expect(r.all).not.toContain(WEBHOOK_TOKEN)
  })

  it('deletes the webhook even when something unforeseen throws part way, and exits 1', async () => {
    const w = world()
    const errs = []
    let waits = 0
    const code = await runProbe({
      argv: [],
      env: ENV,
      fetchImpl: w.fetchImpl,
      sleep: async () => {
        if (++waits === 3) throw new RangeError('unforeseen')
        await w.sleep(1500)
      },
      now: w.now,
      log: () => {},
      warn: (l) => errs.push(String(l)),
    })
    expect(code).toBe(1)
    expect(w.calls.at(-1).method).toBe('DELETE')
    expect(errs.join('\n')).toMatch(/RangeError/)
  })
})

describe('runProbe: --automod', () => {
  // A KEYWORD rule that blocks the message, as the guild's would. BLOCK_MESSAGE is action type 1, SEND_ALERT_MESSAGE 2.
  const rule = (extra = {}) => ({
    id: '1',
    trigger_type: 1,
    enabled: true,
    trigger_metadata: { keyword_filter: ['*badword*', 'second'] },
    actions: [{ type: 2, metadata: { channel_id: '200000000000000450' } }, { type: 1 }],
    exempt_channels: [],
    ...extra,
  })

  const blocked = { status: 400, body: { code: 200000, message: 'Message blocked by AutoMod' } }
  const hasKeyword = (c) => JSON.stringify(c.json ?? '').includes('badword')
  const isV2 = (c) => c.json?.flags === 32768
  const keywordSends = (r) => r.sends.filter(hasKeyword)

  it("sends the first keyword of the guild's KEYWORD rule twice: as V2 text, then as plain content, without wildcards", async () => {
    const r = await run({ argv: ['--automod'], rules: [rule()] })
    expect(r.code).toBe(0)
    expect(r.sends).toHaveLength(12)
    const [v2, plain] = r.sends.slice(10)
    expect(v2.json.flags).toBe(32768)
    expect(v2.json).not.toHaveProperty('content')
    expect(textsOf(v2.json.components).join('\n')).toContain('badword')
    expect(textsOf(v2.json.components).join('\n')).not.toContain('*')
    expect(plain.json.flags).toBe(4)
    expect(plain.json).not.toHaveProperty('components')
    expect(plain.json.content).toContain('badword')
    expect(plain.json.content).not.toContain('*')
    for (const s of [v2, plain]) expect(s.json.allowed_mentions).toEqual({ parse: [] })
    const read = r.calls.find((c) => c.path === `/v10/guilds/${GUILD}/auto-moderation/rules`)
    expect(read.method).toBe('GET')
    expect(read.headers.Authorization).toBe(`Bot ${BOT_TOKEN}`)
  })

  it('sends the plain one about 2 s after the V2 one', async () => {
    const r = await run({ argv: ['--automod'], rules: [rule()] })
    const [v2, plain] = r.sends.slice(10)
    expect(plain.at - v2.at).toBeGreaterThanOrEqual(2000)
    expect(plain.at - v2.at).toBeLessThan(3000)
  })

  it('records a row for each form, with its status and code, and never prints the keyword', async () => {
    const r = await run({ argv: ['--automod'], rules: [rule()], reply: (c) => (hasKeyword(c) ? blocked : undefined) })
    expect(r.code).toBe(0)
    for (const label of ['7a', '7b']) {
      const row = r.out.find((l) => new RegExp(`^\\|\\s*${label}\\b`).test(l))
      expect(row).toMatch(/\b400\b/)
      expect(row).toMatch(/200000/)
    }
    expect(r.out.filter((l) => /^\|\s*7/.test(l))).toHaveLength(2)
    expect(r.all).not.toContain('badword')
  })

  it.each([
    ['the V2 text is blocked and the plain content is not', isV2, 'V2'],
    ['the plain content is blocked and the V2 text is not', (c) => !isV2(c), 'plain'],
  ])('reports each form on its own when %s', async (_name, blocksThis, which) => {
    const r = await run({ argv: ['--automod'], rules: [rule()], reply: (c) => (hasKeyword(c) && blocksThis(c) ? blocked : undefined) })
    expect(r.code).toBe(0)
    const v2Row = r.out.find((l) => /^\|\s*7a\b/.test(l))
    const plainRow = r.out.find((l) => /^\|\s*7b\b/.test(l))
    const [hit, miss] = which === 'V2' ? [v2Row, plainRow] : [plainRow, v2Row]
    // a row's cells: step, HTTP status, code, what Discord says, milliseconds and message id
    const cells = (line) => line.split('|').slice(1, -1).map((c) => c.trim())
    expect(cells(hit).slice(1, 3)).toEqual(['400', '200000'])
    expect(cells(hit)[5]).toBe('')
    // the one that got through has no code and the id Discord gave it: the next after the three bursts, as the blocked one took none
    expect(cells(miss).slice(1, 3)).toEqual(['200', ''])
    expect(cells(miss)[5]).toBe(idAfter(10))
  })

  it('does not retry a block: each form is sent once', async () => {
    const r = await run({ argv: ['--automod'], rules: [rule()], reply: (c) => (hasKeyword(c) ? blocked : undefined) })
    expect(keywordSends(r)).toHaveLength(2)
    expect(keywordSends(r).filter(isV2)).toHaveLength(1)
  })

  it.each([
    ['no rules', []],
    ['a rule of another kind', [rule({ trigger_type: 3 })]],
    ['a disabled rule', [rule({ enabled: false })]],
    ['a rule with no keywords', [rule({ trigger_metadata: { keyword_filter: [] } })]],
    ['a rule with only wildcards', [rule({ trigger_metadata: { keyword_filter: ['**', '*'] } })]],
    ['a rule with no metadata', [rule({ trigger_metadata: undefined })]],
    ['a keyword that is not text', [rule({ trigger_metadata: { keyword_filter: [7, null] } })]],
    ['a rule that only sends an alert', [rule({ actions: [{ type: 2, metadata: {} }] })]],
    ['a rule that only times the member out', [rule({ actions: [{ type: 3, metadata: { duration_seconds: 60 } }] })]],
    ['a rule with no actions', [rule({ actions: [] })]],
    ['a rule with no action list', [rule({ actions: undefined })]],
    ['a rule whose actions are not a list', [rule({ actions: { type: 1 } })]],
    ['a rule that exempts the probe forum', [rule({ exempt_channels: [PROBE] })]],
    ['a rule that exempts the probe forum among others', [rule({ exempt_channels: ['200000000000000450', PROBE] })]],
  ])('sends nothing and says so when there is %s', async (_name, rules) => {
    const r = await run({ argv: ['--automod'], rules })
    expect(r.code).toBe(0)
    expect(r.sends).toHaveLength(10)
    expect(r.out.join('\n')).toMatch(/7.*skipped/i)
  })

  it('uses the first usable keyword of the first rule that is enabled, a KEYWORD rule, blocks, and does not exempt the probe forum', async () => {
    const r = await run({
      argv: ['--automod'],
      rules: [
        rule({ trigger_type: 3 }),
        rule({ enabled: false }),
        rule({ actions: [{ type: 2, metadata: {} }] }),
        rule({ exempt_channels: [PROBE] }),
        rule({ trigger_metadata: { keyword_filter: ['*', 'wanted*', 'later'] } }),
        rule(),
      ],
    })
    const [v2, plain] = r.sends.slice(10)
    expect(textsOf(v2.json.components).join('\n')).toContain('wanted')
    expect(textsOf(v2.json.components).join('\n')).not.toContain('later')
    expect(plain.json.content).toContain('wanted')
    expect(plain.json.content).not.toContain('later')
  })

  it('skips step 7, and says so, when the rules cannot be read', async () => {
    const r = await run({ argv: ['--automod'], reply: (c) => (c.path.includes('auto-moderation') ? { status: 403, body: { code: 50013, message: 'Missing Permissions' } } : undefined) })
    expect(r.code).toBe(0)
    expect(r.sends).toHaveLength(10)
    expect(r.out.join('\n')).toMatch(/7.*skipped/i)
  })
})

describe('runProbe: --automod, what the rule says about the Librarius forum', () => {
  const rule = (extra = {}) => ({
    id: '1',
    trigger_type: 1,
    enabled: true,
    trigger_metadata: { keyword_filter: ['*badword*'] },
    actions: [{ type: 1 }],
    exempt_channels: [],
    ...extra,
  })

  it('says the rule does not exempt the Librarius forum, after the table', async () => {
    const r = await run({ argv: ['--automod'], rules: [rule()] })
    const note = r.out.findIndex((l) => /does not exempt the Librarius forum/.test(l))
    expect(note).toBeGreaterThan(r.out.findLastIndex((l) => l.startsWith('|')))
    expect(r.all).not.toMatch(/\bexempts the Librarius forum/)
  })

  it('says the rule exempts the Librarius forum when it lists it', async () => {
    const r = await run({ argv: ['--automod'], rules: [rule({ exempt_channels: ['200000000000000450', LIBRARIUS] })] })
    expect(r.all).toMatch(/exempts the Librarius forum/)
    expect(r.all).not.toMatch(/does not exempt/)
  })

  it('says it cannot tell when the Librarius is not configured', async () => {
    const r = await run({ argv: ['--automod'], rules: [rule()], env: { ...ENV, LIBRARIUS_CHANNEL_ID: undefined } })
    expect(r.out).toContain('LIBRARIUS_CHANNEL_ID is not set, so it is not known whether the AutoMod rule of step 7 exempts the Librarius forum.')
    expect(r.all).not.toMatch(/does not exempt|exempts the Librarius forum \(/)
  })

  it('says nothing about it without --automod, or when step 7 is skipped', async () => {
    expect((await run({ rules: [rule()] })).all).not.toMatch(/the Librarius forum/)
    expect((await run({ argv: ['--automod'], rules: [] })).all).not.toMatch(/the Librarius forum/)
  })

  it('never prints the keyword in saying it', async () => {
    const r = await run({ argv: ['--automod'], rules: [rule()] })
    expect(r.all).not.toContain('badword')
  })
})

describe('runProbe: where it is allowed to post', () => {
  const only = (r) => r.calls.map((c) => `${c.method} ${c.path}`)

  it.each([
    ['another guild', '200000000000000999'],
    ['no guild', undefined],
    ['a null guild', null],
    ['a guild id that is a number', 200000000000000401],
  ])('exits 2, with only the channel read made, when the probe channel is in %s', async (_name, guild) => {
    const r = await run({ channel: { guild_id: guild } })
    expect(r.code).toBe(2)
    expect(only(r)).toEqual([`GET /v10/channels/${PROBE}`])
    expect(r.errs).toEqual(['Probe not run: the probe channel is not in DISCORD_GUILD_ID.'])
    expect(r.out).toEqual([])
  })

  it.each([
    ['no overwrites at all', []],
    ['no overwrite list', undefined],
    ['an overwrite list that is not a list', { id: GUILD, type: 0, deny: '1024' }],
    ['an overwrite for another role', [{ id: '200000000000000450', type: 0, allow: '0', deny: '1024' }]],
    ['an overwrite for everyone that only allows', [{ id: GUILD, type: 0, allow: '1024', deny: '0' }]],
    ['an overwrite for everyone that denies other things', [{ id: GUILD, type: 0, allow: '0', deny: '2048' }]],
    ['an overwrite for a member with the guild id', [{ id: GUILD, type: 1, allow: '0', deny: '1024' }]],
    ['a deny that is a number', [{ id: GUILD, type: 0, allow: '0', deny: 1024 }]],
    ['a deny that is negative (every bit, as a two\'s complement)', [{ id: GUILD, type: 0, allow: '0', deny: '-1' }]],
    ['a deny that is not a number', [{ id: GUILD, type: 0, allow: '0', deny: 'view' }]],
    ['no deny', [{ id: GUILD, type: 0, allow: '0' }]],
    ['junk among the overwrites', [null, 7, 'x', [], { id: GUILD }]],
  ])('exits 2, with only the channel read made, when the forum has %s: everyone can see it', async (_name, overwrites) => {
    const r = await run({ channel: { permission_overwrites: overwrites } })
    expect(r.code).toBe(2)
    expect(only(r)).toEqual([`GET /v10/channels/${PROBE}`])
    expect(r.errs).toEqual(['Probe not run: everyone can see the probe forum.'])
    expect(r.out).toEqual([])
  })

  it.each([
    ['exactly View Channel', '1024'],
    ['View Channel among other bits', '1049600'],
    ['every bit', '8796093022207'],
  ])('goes on when @everyone is denied %s, whatever the other overwrites', async (_name, deny) => {
    const r = await run({
      channel: {
        permission_overwrites: [
          { id: '200000000000000450', type: 0, allow: '1024', deny: '0' },
          { id: GUILD, type: 0, allow: '0', deny },
          { id: OWNER, type: 1, allow: '1024', deny: '0' },
        ],
      },
    })
    expect(r.code).toBe(0)
    expect(r.sends).toHaveLength(10)
  })

  it('says it is the wrong guild before it says anything about who can see the forum', async () => {
    const r = await run({ channel: { guild_id: '200000000000000999', permission_overwrites: [] } })
    expect(r.errs).toEqual(['Probe not run: the probe channel is not in DISCORD_GUILD_ID.'])
  })

  it('says it is not a forum before it says anything about the guild', async () => {
    const r = await run({ channelType: 0, channel: { guild_id: '200000000000000999', permission_overwrites: [] } })
    expect(r.code).toBe(2)
    expect(r.errs.join('\n')).toMatch(/forum/)
  })

  it('refuses a stray space in LIBRARIUS_CHANNEL_ID with exit 2 and no call at all', async () => {
    const r = await run({ env: { ...ENV, LIBRARIUS_CHANNEL_ID: ` ${PROBE}` } })
    expect(r.code).toBe(2)
    expect(r.calls).toEqual([])
    expect(r.errs.join('\n')).toMatch(/LIBRARIUS_CHANNEL_ID/)
    expect(r.errs.join('\n')).not.toContain(PROBE)
  })
})

describe('runProbe: when Discord says to slow down (429)', () => {
  const limited = (retry, extra = {}) => ({ status: 429, body: { message: 'You are being rate limited.', code: 0, ...retry }, ...extra })
  const isThree = (c) => textsOf(c.json?.components).some((t) => t.startsWith('Probe message three'))
  // The webhook calls that sent something, in order, refused or not.
  const webhookCalls = (r) => r.calls.filter((c) => c.path.startsWith(`/v10/webhooks/${WEBHOOK}/`))
  const after = (r, refused) => webhookCalls(r)[webhookCalls(r).indexOf(refused) + 1]

  it('waits the retry_after of the body before the next send, and never resends the refused one', async () => {
    const r = await run({ reply: (c) => (isThree(c) ? limited({ retry_after: 5, global: false }) : undefined) })
    const refused = r.sends[2]
    const next = after(r, refused)
    expect(next.at - refused.at).toBeGreaterThanOrEqual(5000)
    expect(r.sends.filter(isThree)).toHaveLength(1)
    expect(r.sends).toHaveLength(10)
    expect(r.code).toBe(0)
    expect(r.out.find((l) => /^\|\s*3\b/.test(l))).toMatch(/\b429\b/)
    expect(r.calls.at(-1).method).toBe('DELETE')
  })

  it('reads the Retry-After header when the body has no retry_after', async () => {
    const r = await run({ reply: (c) => (isThree(c) ? limited({}, { headers: { 'Retry-After': '4' } }) : undefined) })
    const refused = r.sends[2]
    expect(after(r, refused).at - refused.at).toBeGreaterThanOrEqual(4000)
    expect(after(r, refused).at - refused.at).toBeLessThan(5000)
  })

  it('prefers the body to the header', async () => {
    const r = await run({ reply: (c) => (isThree(c) ? limited({ retry_after: 3 }, { headers: { 'Retry-After': '10' } }) : undefined) })
    const refused = r.sends[2]
    expect(after(r, refused).at - refused.at).toBeGreaterThanOrEqual(3000)
    expect(after(r, refused).at - refused.at).toBeLessThan(4000)
  })

  it('keeps its usual 1500 ms when Discord asks for less', async () => {
    const r = await run({ reply: (c) => (isThree(c) ? limited({ retry_after: 0.4 }) : undefined) })
    const refused = r.sends[2]
    expect(after(r, refused).at - refused.at).toBeGreaterThanOrEqual(1500)
    expect(after(r, refused).at - refused.at).toBeLessThan(2000)
  })

  it('waits only once: the sends after the next one are 1500 ms apart again', async () => {
    const r = await run({ reply: (c) => (isThree(c) ? limited({ retry_after: 5 }) : undefined) })
    const [, , , a, b] = webhookCalls(r).slice(1)
    expect(b.at - a.at).toBeGreaterThanOrEqual(1500)
    expect(b.at - a.at).toBeLessThan(2000)
  })

  it('waits a whole 60 seconds, the longest it waits, and goes on', async () => {
    const r = await run({ reply: (c) => (isThree(c) ? limited({ retry_after: 60 }) : undefined) })
    const refused = r.sends[2]
    expect(after(r, refused).at - refused.at).toBeGreaterThanOrEqual(60_000)
    expect(r.sends).toHaveLength(10)
    expect(r.code).toBe(0)
  })

  it.each([
    ['a retry_after over 60 seconds', limited({ retry_after: 60.5 })],
    ['an enormous retry_after', limited({ retry_after: 1e9 })],
    ['a Retry-After header over 60 seconds', limited({}, { headers: { 'Retry-After': '61' } })],
    ['a global limit, however short', limited({ retry_after: 1, global: true })],
    ['a global limit named in a header', limited({ retry_after: 1 }, { headers: { 'X-RateLimit-Global': 'true' } })],
  ])('stops sending, and still deletes the webhook, on %s', async (_name, answer) => {
    const r = await run({ reply: (c) => (isThree(c) ? answer : undefined) })
    expect(r.sends).toHaveLength(3)
    expect(webhookCalls(r).at(-1)).toBe(r.sends[2])
    expect(r.edits).toEqual([])
    expect(r.calls.at(-1).method).toBe('DELETE')
    expect(r.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)
    expect(r.code).toBe(1)
    expect(r.errs.join('\n')).toMatch(/rate limit/i)
    // every step it did not send says so in the table, and the answers do not claim a finished run
    const text = r.out.join('\n')
    expect(r.out.find((l) => /^\|\s*3\b/.test(l))).toMatch(/\b429\b/)
    expect(r.out.find((l) => /^\|\s*4 reply part 1/.test(l))).toMatch(/skipped/)
    expect(r.out.find((l) => /^\|\s*6 burst reply 3/.test(l))).toMatch(/skipped/)
    expect(r.out.find((l) => /^\|\s*4 edit/.test(l))).toMatch(/skipped.*rate limited/)
    expect(text).not.toContain('Reply with the table')
  })

  it('stops before the AutoMod step too, without reading the rules', async () => {
    const r = await run({ argv: ['--automod'], rules: [], reply: (c) => (isThree(c) ? limited({ retry_after: 1, global: true }) : undefined) })
    expect(r.calls.some((c) => c.path.includes('auto-moderation'))).toBe(false)
    expect(r.out.find((l) => /^\|\s*7\b/.test(l))).toMatch(/skipped/)
  })

  it('stops, and does not edit, when a part of the reply is limited globally', async () => {
    const r = await run({
      reply: (c) => (textsOf(c.json?.components).some((t) => t.startsWith('Part 2 of 3')) ? limited({ retry_after: 1, global: true }) : undefined),
    })
    expect(r.edits).toEqual([])
    expect(r.sends.filter((s) => textsOf(s.json.components).some((t) => t.startsWith('Part 3 of 3')))).toEqual([])
    expect(r.calls.at(-1).method).toBe('DELETE')
  })

  it.each([
    ['a negative retry_after', { retry_after: -5 }],
    ['a retry_after that is text', { retry_after: 'soon' }],
    ['a retry_after that is null', { retry_after: null }],
    ['no retry information at all', {}],
    ['a global that is not true', { retry_after: 1, global: 'yes' }],
  ])('goes on at its usual pace after %s', async (_name, body) => {
    const r = await run({ reply: (c) => (isThree(c) ? limited(body) : undefined) })
    expect(r.sends).toHaveLength(10)
    expect(r.code).toBe(0)
    const refused = r.sends[2]
    expect(after(r, refused).at - refused.at).toBeGreaterThanOrEqual(1500)
    expect(after(r, refused).at - refused.at).toBeLessThan(3000)
  })

  it('never prints a token that a 429 message carries', async () => {
    const r = await run({ reply: (c) => (isThree(c) ? limited({ retry_after: 1, message: `limited ${WEBHOOK_TOKEN} ${BOT_TOKEN}` }) : undefined) })
    expect(r.all).not.toContain(WEBHOOK_TOKEN)
    expect(r.all).not.toContain(BOT_TOKEN)
  })
})

describe('runProbe: when it is stopped or loses its webhook', () => {
  const HINT = 'If a webhook named "Librarius probe" exists in the probe forum, delete it: Edit Channel → Integrations → Webhooks.'
  const isThree = (c) => textsOf(c.json?.components).some((t) => t.startsWith('Probe message three'))

  it('on Ctrl-C deletes the webhook, then exits 130, and sends nothing more', async () => {
    const interrupt = { handler: null, off: false }
    let fired
    const r = await run({
      interrupt,
      reply: (c) => {
        if (isThree(c)) fired ??= interrupt.handler()
        return undefined
      },
    })
    await fired
    expect(r.exits).toEqual([130])
    expect(r.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)
    expect(r.calls.at(-1).method).toBe('DELETE')
    expect(r.calls.at(-1).headers.Authorization).toBe(`Bot ${BOT_TOKEN}`)
    expect(r.sends).toHaveLength(3)
    expect(r.code).toBe(130)
    expect(r.all).not.toContain(WEBHOOK_TOKEN)
  })

  it('on Ctrl-C before the webhook exists, exits 130, makes none and needs no hint', async () => {
    const interrupt = { handler: null, off: false }
    let fired
    const r = await run({
      interrupt,
      reply: (c) => {
        if (c.method === 'GET' && c.path === `/v10/guilds/${GUILD}`) fired ??= interrupt.handler()
        return undefined
      },
    })
    await fired
    expect(r.exits).toEqual([130])
    expect(r.calls.some((c) => c.path === `/v10/channels/${PROBE}/webhooks`)).toBe(false)
    expect(r.calls.some((c) => c.method === 'DELETE')).toBe(false)
    expect(r.errs.join('\n')).not.toContain(HINT)
  })

  it('on Ctrl-C while the webhook is being made, says how to delete it by hand and exits 130', async () => {
    const interrupt = { handler: null, off: false }
    let fired
    const r = await run({
      interrupt,
      reply: (c) => {
        if (c.method === 'POST' && c.path === `/v10/channels/${PROBE}/webhooks`) fired ??= interrupt.handler()
        return undefined
      },
    })
    await fired
    expect(r.exits).toEqual([130])
    expect(r.errs).toContain(HINT)
  })

  it('on a second Ctrl-C exits at once, without a second delete', async () => {
    const interrupt = { handler: null, off: false }
    let first
    let second
    const r = await run({
      interrupt,
      reply: (c) => {
        if (isThree(c)) {
          first ??= interrupt.handler()
          second ??= interrupt.handler()
        }
        return undefined
      },
    })
    await Promise.all([first, second])
    expect(r.exits).toEqual([130, 130])
    expect(r.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)
  })

  it('listens for Ctrl-C while it runs, and stops listening after', async () => {
    const interrupt = { handler: null, off: false }
    await run({ interrupt })
    expect(typeof interrupt.handler).toBe('function')
    expect(interrupt.off).toBe(true)
  })

  it.each([
    ['a refusal of the settings', { env: { ...ENV, LIBRARIUS_PROBE_CHANNEL_ID: undefined } }],
    ['a dry run', { argv: ['--dry-run'] }],
  ])('does not listen for Ctrl-C on %s', async (_name, options) => {
    const interrupt = { handler: null, off: false }
    await run({ interrupt, ...options })
    expect(interrupt.handler).toBeNull()
  })

  it.each([
    ['refuses (403)', { status: 403, body: { code: 50013, message: 'Missing Permissions' } }],
    ['fails at the server (500)', { status: 500, body: { code: 0, message: 'boom' } }],
    ['answers with no id', { status: 200, body: { token: WEBHOOK_TOKEN } }],
    ['answers with an id that is not one', { status: 200, body: { id: 'abc', token: WEBHOOK_TOKEN } }],
  ])('says how to delete the webhook by hand when making it %s', async (_name, answer) => {
    const r = await run({ reply: (c) => (c.path === `/v10/channels/${PROBE}/webhooks` ? answer : undefined) })
    expect(r.code).toBe(1)
    expect(r.errs).toContain(HINT)
    expect(r.all).not.toContain(WEBHOOK_TOKEN)
  })

  it('says how to delete it by hand when the answer is lost', async () => {
    const r = await run({
      reply: (c) => {
        if (c.path === `/v10/channels/${PROBE}/webhooks`) throw Object.assign(new TypeError('timed out'), { name: 'TimeoutError' })
        return undefined
      },
    })
    expect(r.code).toBe(1)
    expect(r.errs).toContain(HINT)
  })

  it('does not say it when the webhook was made', async () => {
    const r = await run()
    expect(r.errs).toEqual([])
  })

  it('says where to delete the webhook when it cannot delete it itself', async () => {
    const r = await run({ reply: (c) => (c.method === 'DELETE' ? { status: 403, body: { code: 50013, message: 'Missing Permissions' } } : undefined) })
    expect(r.errs.join('\n')).toMatch(/Edit Channel → Integrations → Webhooks/)
  })
})

describe('runProbe: --dry-run', () => {
  it('calls nothing at all, and says nothing was sent', async () => {
    const out = []
    const code = await runProbe({
      argv: ['--dry-run'],
      env: ENV,
      fetchImpl: () => {
        throw new Error('a dry run must not call out')
      },
      sleep: async () => {
        throw new Error('a dry run does not wait')
      },
      now: () => 0,
      log: (l) => out.push(String(l)),
      warn: (l) => out.push(String(l)),
    })
    expect(code).toBe(0)
    expect(out.join('\n')).toMatch(/dry run/i)
    expect(out.join('\n')).toMatch(/nothing was sent/i)
  })

  it('prints each call it would make, with its method, route and a short body', async () => {
    const r = await run({ argv: ['--dry-run', '--automod'] })
    expect(r.calls).toEqual([])
    const text = r.out.join('\n')
    expect(text).toContain(`POST /v10/channels/${PROBE}/webhooks`)
    expect(text).toContain('wait=true')
    expect(text).toContain('with_components=true')
    expect(text).toContain('thread_id')
    expect(text).toContain('PATCH')
    expect(text).toContain('DELETE')
    expect(text).toContain('auto-moderation')
    // the keyword goes twice, as V2 text and as plain content
    expect(text).toContain('Probe message seven, an AutoMod check: {first keyword}')
    expect(text).toContain('"content":"Probe message seven, a plain AutoMod check: {first keyword}","flags":4')
    expect(text).toContain('<3988 characters>')
    expect(text).toContain('allowed_mentions')
    expect(text).toContain('32768')
    expect(text).toContain('probe.png')
    expect(r.out.every((l) => l.length < 500)).toBe(true)
    expect(r.out.length).toBeLessThan(150)
  })

  it('never shows a token, a webhook id or a real keyword', async () => {
    const r = await run({ argv: ['--dry-run', '--automod'] })
    expect(r.all).not.toContain(BOT_TOKEN)
    expect(r.all).not.toContain(WEBHOOK_TOKEN)
    expect(r.all).toMatch(/\{webhook token\}/)
  })

  it('still refuses a bad configuration with exit 2', async () => {
    const r = await run({ argv: ['--dry-run'], env: { ...ENV, LIBRARIUS_PROBE_CHANNEL_ID: LIBRARIUS } })
    expect(r.code).toBe(2)
    expect(r.errs.join('\n')).toMatch(/Librarius/)
  })

  it('prints no result table and no checklist, since nothing ran', async () => {
    const r = await run({ argv: ['--dry-run'] })
    expect(r.out.join('\n')).not.toContain('Reply with the table')
  })
})
