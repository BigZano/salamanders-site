import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { inspect } from 'node:util'
import { WebhookError, createWebhookClient, parseWebhookUrl, sendBody, webhookUrl } from './librariusWebhook.js'
import { displayableLength, toDiscord } from './librariusForm.js'

// Every id and token here is invented.
const API = 'https://discord.com/api'
const MOCK = 'http://discord-mock:4400'
const HOOK = '200000000000000450'
const TOKEN = 'invented-webhook-token_0123456789abcdef'
const URL_OK = `${API}/webhooks/${HOOK}/${TOKEN}`
const ROOT = `${API}/v10/webhooks/${HOOK}/${TOKEN}`
const THREAD = '200000000000000410'
const MSG = '200000000000000430'
const USER_A = '200000000000000420'
const USER_B = '200000000000000421'
const AUTHOR = '200000000000000422'
const AVATAR = 'https://cdn.discordapp.com/avatars/200000000000000422/0a1b2c3d.png'

const V2_PART = { text: 'hello', components: [{ type: 17, components: [{ type: 10, content: 'hello' }] }], files: [] }
const PLAIN_PART = { text: 'hello', components: null, files: [] }
const v2 = (over = {}) => ({ form: 'v2', part: V2_PART, username: 'Invented Name', avatarUrl: AVATAR, mentionIds: [], ...over })
const plain = (over = {}) => ({ form: 'plain', part: PLAIN_PART, username: 'Invented Name', avatarUrl: AVATAR, mentionIds: [], ...over })

const message = (id = MSG) => ({ id, content: 'invented', webhook_id: HOOK })
const answer = (status, body, headers) => ({ status, body, headers })

/**
 * A client on a fake fetch that answers from a queue. Each reply is { status, body, headers } (a JSON answer), { raw } (the
 * body as text), an Error (thrown by the fetch), or a function that answers itself. Every call is recorded as it arrives.
 */
function rig(replies = [], over = {}) {
  const seen = []
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, init })
    const r = replies.shift()
    if (r === undefined) throw new Error('the test queued no reply for this call')
    if (r instanceof Error) throw r
    if (typeof r === 'function') return r(url, init)
    const bodyless = r.status === 204 || r.status === 205
    const text = r.raw !== undefined ? r.raw : JSON.stringify(r.body ?? null)
    return new Response(bodyless ? null : text, { status: r.status, headers: r.headers })
  }
  const client = createWebhookClient({ fetchImpl, url: URL_OK, apiBase: API, ...over })
  return { client, seen }
}

// A fetch that answers with a status the Response constructor refuses (it takes 200 to 599 only).
const oddStatus = (status) => () => ({ status, headers: new Headers(), json: async () => null })

const failure = async (promise) => {
  try {
    await promise
  } catch (err) {
    return err
  }
  throw new Error('the call did not fail')
}

// Every way an error can show its content.
function dumpOf(err) {
  const fields = Object.getOwnPropertyNames(err).map((k) => String(err[k]))
  return [String(err), err.message, err.stack, JSON.stringify(err), inspect(err, { depth: 8, showHidden: true }), ...fields].join('\n')
}

describe('parseWebhookUrl: only a Discord webhook address, with nothing round it', () => {
  const ids = ['10000000000000000', '200000000000000450', '99999999999999999999']
  const tokens = ['abcdefgh', 'A1b2C3d4_-E5f6', 'x'.repeat(200), TOKEN]

  it('takes the id and the token of https://discord.com/api/webhooks/<id>/<token>', () => {
    for (const id of ids) {
      for (const token of tokens) {
        expect(parseWebhookUrl(`https://discord.com/api/webhooks/${id}/${token}`, API)).toEqual({ id, token })
      }
    }
  })

  it('refuses what is not text, as a TypeError', () => {
    for (const value of [undefined, null, 0, 12, true, [], [URL_OK], {}, { toString: () => URL_OK }, new URL(URL_OK), Symbol('x')]) {
      expect(() => parseWebhookUrl(value, API)).toThrow(TypeError)
    }
  })

  it('refuses every hostile shape, as a RangeError that names no part of the value', () => {
    const hostile = [
      '',
      ' ',
      ` ${URL_OK}`,
      `${URL_OK} `,
      `${URL_OK}\n`,
      `\n${URL_OK}`,
      `${URL_OK}\t`,
      `${URL_OK}\0`,
      ` ${URL_OK}`,
      `"${URL_OK}"`,
      `'${URL_OK}'`,
      `${URL_OK}/`,
      `${URL_OK}/extra`,
      `${URL_OK}//`,
      `${URL_OK}?wait=true`,
      `${URL_OK}?`,
      `${URL_OK}#x`,
      `${URL_OK}#`,
      `${URL_OK}.json`,
      `${URL_OK}%20`,
      `http://discord.com/api/webhooks/${HOOK}/${TOKEN}`,
      `HTTPS://discord.com/api/webhooks/${HOOK}/${TOKEN}`,
      `https://DISCORD.com/api/webhooks/${HOOK}/${TOKEN}`,
      `https://discord.COM/api/webhooks/${HOOK}/${TOKEN}`,
      `https://discord.com/API/webhooks/${HOOK}/${TOKEN}`,
      `https://discord.com/api/WEBHOOKS/${HOOK}/${TOKEN}`,
      `https://discord.com./api/webhooks/${HOOK}/${TOKEN}`,
      `https://discord.com.evil.test/api/webhooks/${HOOK}/${TOKEN}`,
      `https://evildiscord.com/api/webhooks/${HOOK}/${TOKEN}`,
      `https://discord.com@evil.test/api/webhooks/${HOOK}/${TOKEN}`,
      `https://evil.test@discord.com/api/webhooks/${HOOK}/${TOKEN}`,
      `https://user:pass@discord.com/api/webhooks/${HOOK}/${TOKEN}`,
      `https://discord.com:443/api/webhooks/${HOOK}/${TOKEN}`,
      `https://discord.com:8443/api/webhooks/${HOOK}/${TOKEN}`,
      `https://discord.com\\@evil.test/api/webhooks/${HOOK}/${TOKEN}`,
      `https://evil.test/https://discord.com/api/webhooks/${HOOK}/${TOKEN}`,
      `//discord.com/api/webhooks/${HOOK}/${TOKEN}`,
      `discord.com/api/webhooks/${HOOK}/${TOKEN}`,
      `/api/webhooks/${HOOK}/${TOKEN}`,
      `${HOOK}/${TOKEN}`,
      `https://discordapp.com/api/webhooks/${HOOK}/${TOKEN}`,
      `https://canary.discord.com/api/webhooks/${HOOK}/${TOKEN}`,
      `https://ptb.discord.com/api/webhooks/${HOOK}/${TOKEN}`,
      `https://discord.com/api/v10/webhooks/${HOOK}/${TOKEN}`,
      `https://discord.com/api/v9/webhooks/${HOOK}/${TOKEN}`,
      `https://discord.com/webhooks/${HOOK}/${TOKEN}`,
      `https://discord.com/api//webhooks/${HOOK}/${TOKEN}`,
      `https://discord.com/api/webhooks//${HOOK}/${TOKEN}`,
      `https://discord.com/api/webhooks/${HOOK}`,
      `https://discord.com/api/webhooks/${HOOK}/`,
      `https://discord.com/api/webhooks/${TOKEN}`,
      `https://discord.com/api/webhooks/`,
      `https://discord.com/api/webhooks`,
      `https://discord.com/api/webhooks/${TOKEN}/${HOOK}`,
      `https://discord.com/api/webhooks/${HOOK}/${TOKEN}/github`,
      `https://discord.com/api/webhooks/${HOOK}/../${TOKEN}`,
      `https://discord.com/api/webhooks/../${HOOK}/${TOKEN}`,
      `https://discord.com/api/webhooks/${HOOK}/${TOKEN}/..`,
      `https://discord.com/api/webhooks/${HOOK}/%2e%2e`,
      `https://discord.com/api/webhooks/1000000000000000/${TOKEN}`,
      `https://discord.com/api/webhooks/${'9'.repeat(21)}/${TOKEN}`,
      `https://discord.com/api/webhooks/${HOOK.slice(0, -1)}x/${TOKEN}`,
      `https://discord.com/api/webhooks/x${HOOK.slice(1)}/${TOKEN}`,
      `https://discord.com/api/webhooks/+${HOOK}/${TOKEN}`,
      `https://discord.com/api/webhooks/-${HOOK}/${TOKEN}`,
      `https://discord.com/api/webhooks/${HOOK}.0/${TOKEN}`,
      `https://discord.com/api/webhooks/0x${HOOK}/${TOKEN}`,
      `https://discord.com/api/webhooks/${HOOK} /${TOKEN}`,
      `https://discord.com/api/webhooks/${'٢'.repeat(18)}/${TOKEN}`,
      `https://discord.com/api/webhooks/${'２'.repeat(18)}/${TOKEN}`,
      `https://discord.com/api/webhooks/${HOOK}/${TOKEN.slice(0, 7)}`,
      `https://discord.com/api/webhooks/${HOOK}/abcdefg`,
      `https://discord.com/api/webhooks/${HOOK}/${'x'.repeat(201)}`,
      `https://discord.com/api/webhooks/${HOOK}/${TOKEN}.`,
      `https://discord.com/api/webhooks/${HOOK}/${TOKEN}=`,
      `https://discord.com/api/webhooks/${HOOK}/${TOKEN}%`,
      `https://discord.com/api/webhooks/${HOOK}/${TOKEN}@`,
      `https://discord.com/api/webhooks/${HOOK}/${TOKEN}:`,
      `https://discord.com/api/webhooks/${HOOK}/${TOKEN}\\`,
      `https://discord.com/api/webhooks/${HOOK}/${TOKEN} x`,
      `https://discord.com/api/webhooks/${HOOK}/abcd efgh`,
      `https://discord.com/api/webhooks/${HOOK}/abcd\nefgh`,
      `https://discord.com/api/webhooks/${HOOK}/abcd\refgh`,
      `https://discord.com/api/webhooks/${HOOK}/abcd.efgh`,
      `https://discord.com/api/webhooks/${HOOK}/abcd+efgh`,
      `https://discord.com/api/webhooks/${HOOK}/abcd%2Fefgh`,
      `https://discord.com/api/webhooks/${HOOK}/abcdéfgh`,
      `https://discord.com/api/webhooks/${HOOK}/${'é'.repeat(8)}`,
      `https://discord.com/api/webhooks/${HOOK}/${'𝐚'.repeat(8)}`,
      `https://discord.com/api/webhooks/${HOOK}/abcdefgh​`,
      `https://discord.com/api/webhooks/${HOOK}/ａｂｃｄｅｆｇｈ`,
      `${URL_OK}\n${URL_OK}`,
      `${URL_OK} ${URL_OK}`,
    ]
    for (const value of hostile) {
      const err = (() => {
        try {
          parseWebhookUrl(value, API)
        } catch (e) {
          return e
        }
        return null
      })()
      expect(err, JSON.stringify(value)).toBeInstanceOf(RangeError)
      expect(err.message).toBe('The webhook address is not https://discord.com/api/webhooks/<id>/<token>.')
    }
  })

  it('takes the e2e mock only when the API base is that http origin, at /api/webhooks/', () => {
    const mock = `${MOCK}/api/webhooks/${HOOK}/${TOKEN}`
    expect(parseWebhookUrl(mock, MOCK)).toEqual({ id: HOOK, token: TOKEN })
    expect(parseWebhookUrl(mock, `${MOCK}/`)).toEqual({ id: HOOK, token: TOKEN })
    expect(parseWebhookUrl(mock, `${MOCK}///`)).toEqual({ id: HOOK, token: TOKEN })
    // The real address is still good beside it.
    expect(parseWebhookUrl(URL_OK, MOCK)).toEqual({ id: HOOK, token: TOKEN })
    // The mock's origin only: a path on the API base is not part of it.
    expect(parseWebhookUrl(mock, `${MOCK}/v10`)).toEqual({ id: HOOK, token: TOKEN })
    const refused = [
      [mock, API],
      [mock, 'https://discord-mock:4400'],
      [mock, 'http://other-host:4400'],
      [mock, 'http://discord-mock:4401'],
      [mock, 'http://discord-mock'],
      [mock, 'http://discord-mock.evil.test:4400'],
      [`${MOCK}.evil.test/api/webhooks/${HOOK}/${TOKEN}`, MOCK],
      [`${MOCK}/webhooks/${HOOK}/${TOKEN}`, MOCK],
      [`${MOCK}/api/v10/webhooks/${HOOK}/${TOKEN}`, MOCK],
      [`${MOCK}/api/webhooks/${HOOK}/${TOKEN}/`, MOCK],
      [`${MOCK}/api/webhooks/${HOOK}/${TOKEN}?x=1`, MOCK],
      [`${MOCK}/x/api/webhooks/${HOOK}/${TOKEN}`, MOCK],
      [`${MOCK}@evil.test/api/webhooks/${HOOK}/${TOKEN}`, MOCK],
      [`http://discord-mock:4400@evil.test/api/webhooks/${HOOK}/${TOKEN}`, MOCK],
      [`http://evil.test/api/webhooks/${HOOK}/${TOKEN}`, MOCK],
      [`https://discord-mock:4400/api/webhooks/${HOOK}/${TOKEN}`, MOCK],
      [`http://discord.com/api/webhooks/${HOOK}/${TOKEN}`, MOCK],
    ]
    for (const [value, base] of refused) expect(() => parseWebhookUrl(value, base), `${value} ${base}`).toThrow(RangeError)
  })

  it('refuses an API base that is not an http(s) address, before it looks at the address', () => {
    for (const base of [undefined, null, 0, [], {}]) expect(() => parseWebhookUrl(URL_OK, base)).toThrow(TypeError)
    for (const base of ['', ' ', 'discord.com/api', 'ftp://discord.com/api', 'ws://x:1', 'https://', 'http://', 'https:// x', 'https://x y', 'https://x\n']) {
      expect(() => parseWebhookUrl(URL_OK, base), base).toThrow(RangeError)
    }
  })

  it('names nothing of the address in any refusal, for any text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 120 }), fc.stringMatching(/^[A-Za-z0-9_-]{8,40}$/), (junk, tail) => {
        const secret = `zz${tail}`
        for (const value of [junk, `${API}/webhooks/${HOOK}/${secret}/${junk}`, `${junk}${secret}`, `${API}/webhooks/${junk}/${secret}`]) {
          try {
            parseWebhookUrl(value, API)
          } catch (err) {
            expect(dumpOf(err)).not.toContain(secret)
          }
        }
      }),
    )
  })

  it('accepts exactly the addresses that are the prefix, a 17 to 20 digit id, a slash and an 8 to 200 character token', () => {
    const idPart = /^\d{17,20}$/
    const tokenPart = /^[A-Za-z0-9_-]{8,200}$/
    const alphabet = fc.constantFrom(...'0123456789abcXYZ_-.%/ \n+é٢'.split(''))
    fc.assert(
      fc.property(fc.array(alphabet, { maxLength: 24 }), fc.array(alphabet, { maxLength: 24 }), (idChars, tokenChars) => {
        const id = idChars.join('')
        const token = tokenChars.join('')
        const expected = idPart.test(id) && tokenPart.test(token)
        const value = `${API}/webhooks/${id}/${token}`
        let got
        try {
          got = parseWebhookUrl(value, API)
        } catch {
          got = null
        }
        expect(got !== null).toBe(expected)
        if (expected) expect(got).toEqual({ id, token })
      }),
      { numRuns: 400 },
    )
  })

  it('accepts any id of 17 to 20 digits and any token of 8 to 200 URL-safe characters', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9]{17,20}$/), fc.stringMatching(/^[A-Za-z0-9_-]{8,200}$/), (id, token) => {
        expect(parseWebhookUrl(`${API}/webhooks/${id}/${token}`, API)).toEqual({ id, token })
      }),
    )
  })
})

describe('webhookUrl: the address of a webhook Discord just made', () => {
  it('is the real address for the real API, and the mock address for an http one', () => {
    expect(webhookUrl(API, HOOK, TOKEN)).toBe(URL_OK)
    expect(webhookUrl(`${API}/`, HOOK, TOKEN)).toBe(URL_OK)
    expect(webhookUrl(MOCK, HOOK, TOKEN)).toBe(`${MOCK}/api/webhooks/${HOOK}/${TOKEN}`)
    expect(webhookUrl(`${MOCK}/`, HOOK, TOKEN)).toBe(`${MOCK}/api/webhooks/${HOOK}/${TOKEN}`)
  })

  it('is always an address that parseWebhookUrl takes back', () => {
    for (const base of [API, MOCK]) expect(parseWebhookUrl(webhookUrl(base, HOOK, TOKEN), base)).toEqual({ id: HOOK, token: TOKEN })
  })

  it('refuses an id or a token that would not be taken back, naming neither', () => {
    for (const [id, token] of [
      ['12', TOKEN],
      [HOOK, 'short'],
      [HOOK, `${TOKEN}/x`],
      [HOOK, `${TOKEN}?x`],
      [`${HOOK}/x`, TOKEN],
      ['', TOKEN],
      [HOOK, ''],
    ]) {
      const err = (() => {
        try {
          webhookUrl(API, id, token)
        } catch (e) {
          return e
        }
        return null
      })()
      expect(err).toBeInstanceOf(RangeError)
      expect(err.message).toBe('The webhook address is not https://discord.com/api/webhooks/<id>/<token>.')
    }
  })

  it('refuses an id or a token that is not text, which would otherwise be written as undefined or a number', () => {
    for (const [id, token] of [
      [undefined, TOKEN],
      [null, TOKEN],
      [Number(HOOK), TOKEN],
      [BigInt(HOOK), TOKEN],
      [HOOK, undefined],
      [HOOK, null],
      [HOOK, 12345678],
      [HOOK, ['abcdefgh']],
      [HOOK, { toString: () => TOKEN }],
    ]) {
      expect(() => webhookUrl(API, id, token)).toThrow(TypeError)
    }
  })

  it('refuses an API base that is not an http(s) address', () => {
    expect(() => webhookUrl(undefined, HOOK, TOKEN)).toThrow(TypeError)
    expect(() => webhookUrl('discord.com/api', HOOK, TOKEN)).toThrow(RangeError)
  })
})

describe('sendBody: the one builder of what the webhook sends', () => {
  it('builds a Components V2 message: its flag and components, no content, and no one parsed from the text', () => {
    const body = sendBody(v2())
    expect(body).toStrictEqual({
      flags: 32768,
      components: V2_PART.components,
      username: 'Invented Name',
      avatar_url: AVATAR,
      allowed_mentions: { parse: [], users: [] },
    })
    expect('content' in body).toBe(false)
  })

  it('builds a plain message: its text as content with the suppress-embeds flag, and no components', () => {
    const body = sendBody(plain())
    expect(body).toStrictEqual({
      flags: 4,
      content: 'hello',
      username: 'Invented Name',
      avatar_url: AVATAR,
      allowed_mentions: { parse: [], users: [] },
    })
    expect('components' in body).toBe(false)
  })

  it('leaves the avatar out when there is none, and not as null', () => {
    for (const avatarUrl of [null, undefined]) {
      expect('avatar_url' in sendBody(v2({ avatarUrl }))).toBe(false)
      expect('avatar_url' in sendBody(plain({ avatarUrl }))).toBe(false)
    }
    const { avatarUrl, ...without } = v2()
    expect(avatarUrl).toBe(AVATAR)
    expect('avatar_url' in sendBody(without)).toBe(false)
  })

  it('takes no mentions when none are given, and reads the form from the part it is given', () => {
    const { mentionIds, ...without } = v2()
    expect(mentionIds).toEqual([])
    expect(sendBody(without).allowed_mentions).toStrictEqual({ parse: [], users: [] })
  })

  it('names the picked people as the only ones that may be pinged', () => {
    expect(sendBody(v2({ mentionIds: [USER_A, USER_B] })).allowed_mentions).toStrictEqual({ parse: [], users: [USER_A, USER_B] })
    expect(sendBody(plain({ mentionIds: [USER_B, USER_A] })).allowed_mentions).toStrictEqual({ parse: [], users: [USER_B, USER_A] })
  })

  it('names each person once, in the order given, and at most 10 people', () => {
    expect(sendBody(v2({ mentionIds: [USER_A, USER_B, USER_A, USER_B, USER_A] })).allowed_mentions.users).toEqual([USER_A, USER_B])
    const many = Array.from({ length: 25 }, (_, i) => String(200000000000000500n + BigInt(i)))
    expect(sendBody(v2({ mentionIds: many })).allowed_mentions.users).toEqual(many.slice(0, 10))
    expect(sendBody(v2({ mentionIds: many.slice(0, 10) })).allowed_mentions.users).toEqual(many.slice(0, 10))
    expect(sendBody(v2({ mentionIds: many.slice(0, 9) })).allowed_mentions.users).toEqual(many.slice(0, 9))
    // The 11th person is the one that goes, and a repeat is not counted as a person.
    expect(sendBody(v2({ mentionIds: [...many.slice(0, 5), ...many.slice(0, 5), ...many.slice(5, 12)] })).allowed_mentions.users).toEqual(many.slice(0, 10))
  })

  it('does not change its input, and does not hand its own list to the caller', () => {
    const input = v2({ mentionIds: [USER_A, USER_A, USER_B] })
    const copy = structuredClone(input)
    const body = sendBody(input)
    expect(input).toEqual(copy)
    body.allowed_mentions.users.push('1')
    body.allowed_mentions.parse.push('everyone')
    expect(input.mentionIds).toEqual([USER_A, USER_A, USER_B])
    expect(sendBody(input).allowed_mentions).toStrictEqual({ parse: [], users: [USER_A, USER_B] })
  })

  it('refuses a mention that is not a plain Discord id, whatever it asks to ping', () => {
    for (const bad of ['everyone', '@everyone', '@here', 'here', 'roles', '<@&200000000000000420>', '<@200000000000000420>', '', ' ', '0', '123', '2000000000000004', '9'.repeat(21),
      '200000000000000420 ', ' 200000000000000420', '200000000000000420\n', '0200000000000000420', '000000000000000001', '-200000000000000420', '2e17', '２００００００００００００００４２０', '200000000000000420,200000000000000421']) {
      expect(() => sendBody(v2({ mentionIds: [USER_A, bad] })), JSON.stringify(bad)).toThrow(RangeError)
    }
    for (const bad of [123, 200000000000000420, null, undefined, {}, [], ['x'], true]) {
      expect(() => sendBody(v2({ mentionIds: [bad] }))).toThrow(TypeError)
    }
  })

  it('refuses a list of mentions that is not a list', () => {
    for (const bad of ['', USER_A, 123, {}, { length: 1, 0: USER_A }, true, null]) expect(() => sendBody(v2({ mentionIds: bad }))).toThrow(TypeError)
  })

  it('checks an id past the 10th too, so one bad id cannot hide at the end of a long list', () => {
    const many = Array.from({ length: 12 }, (_, i) => String(200000000000000500n + BigInt(i)))
    expect(() => sendBody(v2({ mentionIds: [...many, 'everyone'] }))).toThrow(RangeError)
  })

  it('refuses a form that is not v2 or plain', () => {
    for (const form of ['V2', 'plain ', 'p', '', undefined, null, 2, {}]) expect(() => sendBody(v2({ form }))).toThrow(RangeError)
  })

  it('refuses a part that does not match its form', () => {
    expect(() => sendBody(v2({ part: PLAIN_PART }))).toThrow(TypeError)
    expect(() => sendBody(plain({ part: V2_PART }))).toThrow(TypeError)
    expect(() => sendBody(v2({ part: { ...V2_PART, components: [] } }))).toThrow(RangeError)
    for (const part of [undefined, null, 'x', 12, [], [V2_PART]]) {
      expect(() => sendBody(v2({ part }))).toThrow(TypeError)
      expect(() => sendBody(plain({ part }))).toThrow(TypeError)
    }
    for (const components of [undefined, 'x', {}, 12]) expect(() => sendBody(v2({ part: { ...V2_PART, components } }))).toThrow(TypeError)
    for (const text of [undefined, null, 12, [], {}]) expect(() => sendBody(plain({ part: { ...PLAIN_PART, text } }))).toThrow(TypeError)
  })

  it('refuses a plain message with no text, which Discord would refuse', () => {
    expect(() => sendBody(plain({ part: { ...PLAIN_PART, text: '' } }))).toThrow(RangeError)
  })

  it('refuses a plain part over 2000 characters and takes one of exactly 2000', () => {
    expect(sendBody(plain({ part: { ...PLAIN_PART, text: 'a'.repeat(2000) } })).content).toBe('a'.repeat(2000))
    expect(() => sendBody(plain({ part: { ...PLAIN_PART, text: 'a'.repeat(2001) } }))).toThrow(RangeError)
  })

  it('refuses a V2 part over 4000 displayable characters, counting the button, and takes one of exactly 4000', () => {
    const part = (text, label) => ({
      text,
      components: [
        {
          type: 17,
          components: [
            { type: 10, content: text },
            { type: 1, components: [{ type: 2, style: 5, label, url: 'https://sm2salamanders.site/' }] },
          ],
        },
      ],
      files: [],
    })
    expect(displayableLength(part('a'.repeat(3988), 'Open On Site'))).toBe(4000)
    expect(sendBody(v2({ part: part('a'.repeat(3988), 'Open On Site') })).flags).toBe(32768)
    expect(displayableLength(part('a'.repeat(3989), 'Open On Site'))).toBe(4001)
    expect(() => sendBody(v2({ part: part('a'.repeat(3989), 'Open On Site') }))).toThrow(RangeError)
    expect(() => sendBody(v2({ part: part('a'.repeat(4001), '') }))).toThrow(RangeError)
  })

  it('refuses a username that is not 1 to 80 characters of text, and takes both ends', () => {
    expect(sendBody(v2({ username: 'a' })).username).toBe('a')
    expect(sendBody(v2({ username: 'a'.repeat(80) })).username).toBe('a'.repeat(80))
    for (const bad of ['', 'a'.repeat(81)]) expect(() => sendBody(v2({ username: bad }))).toThrow(RangeError)
    for (const bad of [undefined, null, 12, [], {}]) expect(() => sendBody(v2({ username: bad }))).toThrow(TypeError)
    const { username, ...without } = v2()
    expect(username).toBe('Invented Name')
    expect(() => sendBody(without)).toThrow(TypeError)
  })

  it('takes an https avatar of up to 512 characters and refuses any other', () => {
    const long = `https://cdn.discordapp.com/${'a'.repeat(512 - 'https://cdn.discordapp.com/'.length)}`
    expect(long).toHaveLength(512)
    expect(sendBody(v2({ avatarUrl: long })).avatar_url).toBe(long)
    for (const bad of [`${long}a`, 'http://cdn.discordapp.com/a.png', 'ftp://x.test/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'cdn.discordapp.com/a.png', '//cdn.discordapp.com/a.png',
      '', ' ', `${AVATAR} `, ` ${AVATAR}`, `${AVATAR}\n`, `${AVATAR} x`, `${AVATAR}>`, `<${AVATAR}`, 'https://', 'https:///a.png', 'HTTPS://cdn.discordapp.com/a.png']) {
      expect(() => sendBody(v2({ avatarUrl: bad })), JSON.stringify(bad)).toThrow(RangeError)
    }
    for (const bad of [12, [], {}, true, AVATAR.length]) expect(() => sendBody(v2({ avatarUrl: bad }))).toThrow(TypeError)
  })

  it('refuses options that are not an object', () => {
    for (const bad of [undefined, null]) expect(() => sendBody(bad)).toThrow(TypeError)
  })

  it('builds from what the form makes: a V2 reply with a picture and a plain one', () => {
    const options = { authorId: AUTHOR, siteUrl: 'https://sm2salamanders.site/reliquarium/librarius', images: [{ ref: 1, name: 'one.png' }] }
    for (const form of ['v2', 'plain']) {
      const { parts } = toDiscord('Hello **there**\n\n![a picture](upload:1)', { ...options, form })
      const body = sendBody({ form, part: parts[0], username: 'Invented Name', avatarUrl: null, mentionIds: [AUTHOR] })
      expect(body.allowed_mentions).toStrictEqual({ parse: [], users: [AUTHOR] })
      expect(body.flags).toBe(form === 'v2' ? 32768 : 4)
      if (form === 'v2') expect(body.components).toBe(parts[0].components)
      else expect(body.content).toBe(parts[0].text)
    }
  })

  it('never lets a message ping everyone or a role, or anyone it was not told of, for any mention list and any text', () => {
    const ids = fc.stringMatching(/^[1-9][0-9]{16,19}$/)
    const junk = fc.oneof(fc.string({ unit: 'binary', maxLength: 30 }), fc.constantFrom('everyone', '@everyone', '@here', '<@&200000000000000420>', '<@200000000000000420>'), ids)
    fc.assert(
      fc.property(fc.array(junk, { maxLength: 30 }), fc.string({ minLength: 1, maxLength: 300 }), fc.constantFrom('v2', 'plain'), (mentionIds, text, form) => {
        const part = form === 'v2' ? { text, components: [{ type: 17, components: [{ type: 10, content: text }] }], files: [] } : { text, components: null, files: [] }
        let body
        try {
          body = sendBody({ form, part, username: 'x', mentionIds })
        } catch (err) {
          expect(err).toBeInstanceOf(Error)
          return
        }
        const am = body.allowed_mentions
        expect(Object.keys(am).sort()).toEqual(['parse', 'users'])
        expect(am.parse).toEqual([])
        expect(am.users.length).toBeLessThanOrEqual(10)
        expect(new Set(am.users).size).toBe(am.users.length)
        for (const id of am.users) {
          expect(id).toMatch(/^[1-9][0-9]{16,19}$/)
          expect(mentionIds).toContain(id)
        }
        const wire = JSON.stringify(body.allowed_mentions)
        expect(wire).not.toMatch(/everyone|roles|here/)
        // Every mention that was asked for and is a person, up to the cap, is there.
        const people = [...new Set(mentionIds)].slice(0, 10)
        expect(am.users).toEqual(people)
      }),
      { numRuns: 300 },
    )
  })

  it('refuses a list with any non-id, and otherwise names the first 10 distinct people (property)', () => {
    const id = fc.stringMatching(/^[1-9][0-9]{16,19}$/)
    fc.assert(
      fc.property(fc.array(id, { maxLength: 40 }), fc.integer({ min: 0, max: 40 }), fc.string({ minLength: 1, maxLength: 20 }), (list, at, bad) => {
        const body = sendBody(v2({ mentionIds: list }))
        expect(body.allowed_mentions.users).toEqual([...new Set(list)].slice(0, 10))
        if (/^[1-9][0-9]{16,19}$/.test(bad)) return
        const withBad = [...list]
        withBad.splice(Math.min(at, withBad.length), 0, bad)
        expect(() => sendBody(v2({ mentionIds: withBad }))).toThrow()
      }),
    )
  })
})

describe('WebhookError', () => {
  it('is an Error named WebhookError, with every field set to something', async () => {
    const r = rig([answer(400, { code: 50035 })])
    const err = await failure(r.client.send(THREAD, sendBody(v2())))
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(WebhookError)
    expect(err.name).toBe('WebhookError')
    expect(Object.keys(err).sort()).toEqual(['blocked', 'code', 'fatal', 'global', 'messageGone', 'name', 'retryAfterMs', 'status', 'threadGone', 'unknown'])
    expect(err).toMatchObject({ status: 400, code: 50035, fatal: false, blocked: false, unknown: false, threadGone: false, messageGone: false, global: false, retryAfterMs: null })
  })
})

describe('the id of the webhook', () => {
  it('is the id of the address, which Discord puts on every message the webhook posts, so the site can tell them from the rest', () => {
    expect(rig().client.id).toBe(HOOK)
    expect(rig([], { url: `${MOCK}/api/webhooks/${USER_A}/${TOKEN}`, apiBase: MOCK }).client.id).toBe(USER_A)
  })

  it('cannot be changed, and is not the token', () => {
    const { client } = rig()
    expect(() => {
      client.id = USER_B
    }).toThrow(TypeError)
    expect(client.id).toBe(HOOK)
    expect(JSON.stringify(client)).not.toContain(TOKEN)
    expect(inspect(client, { showHidden: true })).not.toContain(TOKEN)
  })
})

describe('createWebhookClient: the settings', () => {
  it('refuses an address that is not a Discord webhook, naming nothing of it', () => {
    for (const url of [undefined, null, 12, '', 'https://example.test/api/webhooks/x/y', `${API}/webhooks/${HOOK}`, `${URL_OK}?x=1`]) {
      expect(() => createWebhookClient({ fetchImpl: async () => null, url, apiBase: API }), String(url)).toThrow()
    }
    const err = (() => {
      try {
        createWebhookClient({ fetchImpl: async () => null, url: `${URL_OK}?x=1`, apiBase: API })
      } catch (e) {
        return e
      }
      return null
    })()
    expect(err).toBeInstanceOf(RangeError)
    expect(dumpOf(err)).not.toContain(TOKEN)
  })

  it('refuses an API base that is not an http(s) address', () => {
    for (const apiBase of [undefined, null, '', 'discord.com/api', 12]) {
      expect(() => createWebhookClient({ fetchImpl: async () => null, url: URL_OK, apiBase })).toThrow()
    }
  })

  it('takes the e2e mock address when the API base is that http origin', async () => {
    const r = rig([answer(200, message())], { url: `${MOCK}/api/webhooks/${HOOK}/${TOKEN}`, apiBase: MOCK })
    await r.client.send(THREAD, sendBody(v2()))
    expect(r.seen[0].url).toBe(`${MOCK}/v10/webhooks/${HOOK}/${TOKEN}?wait=true&thread_id=${THREAD}&with_components=true`)
  })

  it('refuses a fetch that is not a function, and a timeout that is not a positive number', () => {
    for (const fetchImpl of [null, 'fetch', {}, 12]) expect(() => createWebhookClient({ fetchImpl, url: URL_OK, apiBase: API })).toThrow(TypeError)
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '15000', null]) {
      expect(() => createWebhookClient({ fetchImpl: async () => null, url: URL_OK, apiBase: API, timeoutMs }), String(timeoutMs)).toThrow()
    }
    expect(() => createWebhookClient({ fetchImpl: async () => null, url: URL_OK, apiBase: API, timeoutMs: 1 })).not.toThrow()
  })

  it('refuses a newest that is not a function', () => {
    for (const newest of [null, 'x', {}, 12]) expect(() => createWebhookClient({ fetchImpl: async () => null, url: URL_OK, apiBase: API, newest })).toThrow(TypeError)
  })

  it('uses the global fetch when none is given', async () => {
    const real = globalThis.fetch
    const seen = []
    globalThis.fetch = async (url) => {
      seen.push(url)
      return new Response(JSON.stringify(message()), { status: 200 })
    }
    try {
      const client = createWebhookClient({ url: URL_OK, apiBase: API })
      await client.send(THREAD, sendBody(v2()))
    } finally {
      globalThis.fetch = real
    }
    expect(seen).toEqual([`${ROOT}?wait=true&thread_id=${THREAD}&with_components=true`])
  })
})

describe('send', () => {
  it('posts the body as JSON into the thread, waits for the message and asks for its components', async () => {
    const r = rig([answer(200, message())])
    const body = sendBody(v2({ mentionIds: [USER_A] }))
    const got = await r.client.send(THREAD, body)
    expect(got).toEqual(message())
    expect(r.seen).toHaveLength(1)
    const { url, init } = r.seen[0]
    expect(url).toBe(`${ROOT}?wait=true&thread_id=${THREAD}&with_components=true`)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body)).toEqual(body)
    expect(init.body).toBe(JSON.stringify(body))
  })

  it('sends no Authorization: the address is the credential', async () => {
    const r = rig([answer(200, message())])
    await r.client.send(THREAD, sendBody(plain()))
    expect(Object.keys(r.seen[0].init.headers).map((k) => k.toLowerCase())).not.toContain('authorization')
  })

  it('never follows a redirect, which could take the address somewhere else', async () => {
    const r = rig([answer(200, message())])
    await r.client.send(THREAD, sendBody(plain()))
    expect(r.seen[0].init.redirect).toBe('error')
  })

  it('gives each call its own timeout signal that has not fired when the call starts', async () => {
    const r = rig([answer(200, message()), answer(200, message())])
    await r.client.send(THREAD, sendBody(plain()))
    await r.client.send(THREAD, sendBody(plain()))
    expect(r.seen[0].init.signal).toBeInstanceOf(AbortSignal)
    expect(r.seen[0].init.signal.aborted).toBe(false)
    expect(r.seen[1].init.signal).not.toBe(r.seen[0].init.signal)
  })

  it('refuses a thread id that is not a plain Discord id, before it sends anything, so it cannot reshape the query', async () => {
    const r = rig([])
    for (const bad of ['', '1', `${THREAD}&thread_name=x`, `${THREAD}/../x`, `${THREAD} `, undefined, null, 12, [], {}]) {
      const err = await failure(r.client.send(bad, sendBody(plain())))
      expect(err, String(bad)).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(WebhookError)
    }
    expect(r.seen).toHaveLength(0)
  })

  it('refuses a body that did not come from sendBody, before it sends anything', async () => {
    const r = rig([])
    const good = sendBody(v2())
    const refused = [
      undefined,
      null,
      'text',
      [],
      {},
      { content: 'hi' },
      { ...good, allowed_mentions: undefined },
      { ...good, allowed_mentions: null },
      { ...good, allowed_mentions: {} },
      { ...good, allowed_mentions: { users: [] } },
      { ...good, allowed_mentions: { parse: ['everyone'] } },
      { ...good, allowed_mentions: { parse: ['roles'] } },
      { ...good, allowed_mentions: { parse: ['users'] } },
      { ...good, allowed_mentions: { parse: ['everyone', 'roles', 'users'] } },
      { ...good, allowed_mentions: { parse: [], roles: [USER_A] } },
      { ...good, allowed_mentions: { parse: [], roles: [] } },
      { ...good, allowed_mentions: { parse: [], users: ['everyone'] } },
      { ...good, allowed_mentions: { parse: [], users: [USER_A], replied_user: true } },
      { ...good, allowed_mentions: { parse: [], users: Array.from({ length: 11 }, (_, i) => String(200000000000000500n + BigInt(i))) } },
      { ...good, allowed_mentions: { parse: [], users: USER_A } },
      { ...good, allowed_mentions: { parse: {}, users: [] } },
      { ...good, thread_name: 'a new post' },
      { ...good, applied_tags: [USER_A] },
      { ...good, embeds: [] },
      { ...good, tts: true },
      { ...good, message_reference: { message_id: MSG } },
      { ...good, attachments: [] },
      { ...good, poll: {} },
    ]
    for (const body of refused) {
      let thrown = null
      try {
        await r.client.send(THREAD, body)
      } catch (e) {
        thrown = e
      }
      expect(thrown, JSON.stringify(body)).toBeInstanceOf(Error)
      expect(thrown).not.toBeInstanceOf(WebhookError)
    }
    for (const body of refused) {
      let thrown = null
      try {
        await r.client.edit(THREAD, MSG, body)
      } catch (e) {
        thrown = e
      }
      expect(thrown, JSON.stringify(body)).toBeInstanceOf(Error)
    }
    expect(r.seen).toHaveLength(0)
  })

  it('takes every field sendBody sets, and the empty and the full list of people', async () => {
    const r = rig([answer(200, message()), answer(200, message()), answer(200, message())])
    const many = Array.from({ length: 10 }, (_, i) => String(200000000000000500n + BigInt(i)))
    await r.client.send(THREAD, sendBody(v2({ mentionIds: many })))
    await r.client.send(THREAD, sendBody(plain({ avatarUrl: null })))
    await r.client.send(THREAD, sendBody(plain({ mentionIds: [USER_A] })))
    expect(r.seen).toHaveLength(3)
  })

  it('sends files as multipart: the body as payload_json, which lists each file, then each file in order', async () => {
    const r = rig([answer(200, message())])
    const files = [
      { name: 'one.png', type: 'image/png', bytes: new Uint8Array([1, 2, 3]) },
      { name: 'two.webp', type: 'image/webp', bytes: Buffer.from([9, 8, 7, 6]) },
    ]
    const body = sendBody(v2())
    await r.client.send(THREAD, body, files)
    const { init } = r.seen[0]
    expect(init.method).toBe('POST')
    // No content type by hand: fetch makes it, with the boundary.
    expect(init.headers).toEqual({})
    expect(init.body).toBeInstanceOf(FormData)
    expect([...init.body.keys()]).toEqual(['payload_json', 'files[0]', 'files[1]'])
    expect(JSON.parse(init.body.get('payload_json'))).toEqual({
      ...body,
      attachments: [
        { id: 0, filename: 'one.png' },
        { id: 1, filename: 'two.webp' },
      ],
    })
    const [one, two] = [init.body.get('files[0]'), init.body.get('files[1]')]
    expect(one.name).toBe('one.png')
    expect(one.type).toBe('image/png')
    expect([...new Uint8Array(await one.arrayBuffer())]).toEqual([1, 2, 3])
    expect(two.name).toBe('two.webp')
    expect(two.type).toBe('image/webp')
    expect([...new Uint8Array(await two.arrayBuffer())]).toEqual([9, 8, 7, 6])
    // Still the same address and query.
    expect(r.seen[0].url).toBe(`${ROOT}?wait=true&thread_id=${THREAD}&with_components=true`)
  })

  it('does not change the body it is given when it adds the file list', async () => {
    const r = rig([answer(200, message())])
    const body = sendBody(plain())
    const copy = structuredClone(body)
    await r.client.send(THREAD, body, [{ name: 'one.png', type: 'image/png', bytes: new Uint8Array([1]) }])
    expect(body).toEqual(copy)
    expect('attachments' in body).toBe(false)
  })

  it('sends plain JSON when the file list is empty or missing', async () => {
    const r = rig([answer(200, message()), answer(200, message()), answer(200, message())])
    await r.client.send(THREAD, sendBody(plain()), [])
    await r.client.send(THREAD, sendBody(plain()), undefined)
    await r.client.send(THREAD, sendBody(plain()), null)
    for (const { init } of r.seen) {
      expect(typeof init.body).toBe('string')
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
      expect('attachments' in JSON.parse(init.body)).toBe(false)
    }
  })

  it('takes 10 files and refuses an 11th, and a file of any shape but { name, type, bytes }', async () => {
    const file = (i) => ({ name: `f${i}.png`, type: 'image/png', bytes: new Uint8Array([i]) })
    const r = rig([answer(200, message())])
    await r.client.send(THREAD, sendBody(plain()), Array.from({ length: 10 }, (_, i) => file(i)))
    expect([...r.seen[0].init.body.keys()]).toHaveLength(11)
    await expect(r.client.send(THREAD, sendBody(plain()), Array.from({ length: 11 }, (_, i) => file(i)))).rejects.toThrow(RangeError)
    const good = file(1)
    for (const bad of ['x', 12, {}, true]) await expect(r.client.send(THREAD, sendBody(plain()), bad)).rejects.toThrow(TypeError)
    for (const bad of [null, undefined, 'x', 12, [], { ...good, name: undefined }, { ...good, name: 12 }, { ...good, type: undefined }, { ...good, type: 12 }, { ...good, bytes: undefined },
      { ...good, bytes: 'abc' }, { ...good, bytes: [1, 2] }, { ...good, bytes: new ArrayBuffer(2) }, { ...good, bytes: { length: 2 } }]) {
      await expect(r.client.send(THREAD, sendBody(plain()), [bad])).rejects.toThrow(TypeError)
    }
    for (const name of ['', '../x.png', 'a/b.png', 'a\\b.png', 'a"b.png', 'a\nb.png', '.png', ' a.png', 'a'.repeat(101)]) {
      await expect(r.client.send(THREAD, sendBody(plain()), [{ ...good, name }]), JSON.stringify(name)).rejects.toThrow(RangeError)
    }
    expect(r.seen).toHaveLength(1)
  })

  it('refuses a file whose type is not one of the four picture types', async () => {
    const r = rig([])
    for (const type of ['', 'text/html', 'image/svg+xml', 'application/octet-stream', 'IMAGE/PNG', 'image/png; charset=x']) {
      await expect(r.client.send(THREAD, sendBody(plain()), [{ name: 'a.png', type, bytes: new Uint8Array([1]) }]), type).rejects.toThrow(RangeError)
    }
    for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      const ok = rig([answer(200, message())])
      await ok.client.send(THREAD, sendBody(plain()), [{ name: 'a.png', type, bytes: new Uint8Array([1]) }])
      expect(ok.seen[0].init.body.get('files[0]').type).toBe(type)
    }
  })

  it('refuses a file with no bytes', async () => {
    const r = rig([])
    await expect(r.client.send(THREAD, sendBody(plain()), [{ name: 'a.png', type: 'image/png', bytes: new Uint8Array(0) }])).rejects.toThrow(RangeError)
  })

  it('answers a message that carries its id, and nothing less', async () => {
    for (const body of [null, 'ok', 12, [], {}, { id: 12 }, { id: '12' }, { id: `${MSG} ` }, { id: null }, { content: 'x' }]) {
      const r = rig([answer(200, body)])
      const err = await failure(r.client.send(THREAD, sendBody(plain())))
      expect(err, JSON.stringify(body)).toBeInstanceOf(WebhookError)
      expect(err).toMatchObject({ status: 200, code: null, unknown: true, fatal: false, blocked: false })
      expect(err.message).toBe('Discord answered 200 to the webhook send, but not with a message.')
    }
    const raw = rig([{ status: 200, raw: 'not json at all' }])
    const err = await failure(raw.client.send(THREAD, sendBody(plain())))
    expect(err).toMatchObject({ status: 200, unknown: true })
    const empty = rig([answer(204)])
    expect(await failure(empty.client.send(THREAD, sendBody(plain())))).toMatchObject({ status: 204, unknown: true })
  })

  it('takes any 2xx that carries the message', async () => {
    for (const status of [200, 201, 299]) {
      const reply = () => ({ status, headers: new Headers(), json: async () => message() })
      const r = rig([reply])
      expect(await r.client.send(THREAD, sendBody(plain()))).toEqual(message())
    }
  })
})

describe('the errors of send: what may have landed, and what was refused', () => {
  const sendError = async (reply, over) => {
    const r = rig([reply], over)
    return failure(r.client.send(THREAD, sendBody(plain())))
  }

  it('a timeout may have landed: unknown, with no status', async () => {
    const r = rig([], {
      timeoutMs: 15,
      fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
    })
    const err = await failure(r.client.send(THREAD, sendBody(plain())))
    expect(err).toBeInstanceOf(WebhookError)
    expect(err).toMatchObject({ status: null, code: null, unknown: true, fatal: false, blocked: false, retryAfterMs: null })
    expect(err.message).toBe('The webhook send got no answer from Discord.')
  })

  it('a timeout that comes while the body is being read may have landed too', async () => {
    const err = await sendError(
      () => ({
        status: 200,
        headers: new Headers(),
        json: () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      }),
    )
    expect(err).toMatchObject({ status: 200, unknown: true })
  })

  it('any error the fetch throws, whatever it is, may have landed: unknown', async () => {
    const thrown = [
      new Error('connect ECONNREFUSED'),
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
      new TypeError('fetch failed'),
      new DOMException('aborted', 'AbortError'),
      new DOMException('timed out', 'TimeoutError'),
      new Error('redirect mode is set to error'),
    ]
    for (const e of thrown) {
      const err = await sendError(e)
      expect(err, e.message).toBeInstanceOf(WebhookError)
      expect(err).toMatchObject({ status: null, code: null, unknown: true, fatal: false, blocked: false })
      expect(err.message).toBe('The webhook send got no answer from Discord.')
    }
  })

  it('a fetch that throws something that is not an error, or throws at once, is unknown too', async () => {
    for (const make of [() => Promise.reject('a string'), () => Promise.reject(null), () => Promise.reject(undefined), () => { throw new Error('sync') }]) {
      const r = rig([], { fetchImpl: make })
      const err = await failure(r.client.send(THREAD, sendBody(plain())))
      expect(err).toMatchObject({ unknown: true, status: null })
    }
  })

  it('any 5xx may have landed: unknown, with its status and code', async () => {
    for (const status of [500, 501, 502, 503, 504, 520, 522, 599]) {
      const err = await sendError(answer(status, { code: 0, message: 'x' }))
      expect(err, String(status)).toMatchObject({ status, code: 0, unknown: true, fatal: false, blocked: false, retryAfterMs: null })
      expect(err.message).toBe(`Discord answered ${status} to the webhook send.`)
    }
    expect(await sendError(answer(502, null))).toMatchObject({ status: 502, code: null, unknown: true })
    expect(await sendError({ status: 503, raw: '<html>bad gateway</html>' })).toMatchObject({ status: 503, code: null, unknown: true })
  })

  it('a 5xx that says rate limit or webhook gone is still only "may have landed"', async () => {
    expect(await sendError(answer(503, { code: 10015 }))).toMatchObject({ unknown: true, fatal: false })
    expect(await sendError(answer(500, { code: 200000 }))).toMatchObject({ unknown: true, blocked: false })
  })

  it('an answer that is neither 2xx nor 4xx may have landed: unknown', async () => {
    for (const status of [100, 101, 301, 302, 304, 399, 600, 999]) {
      const err = await sendError(oddStatus(status))
      expect(err, String(status)).toMatchObject({ status, unknown: true, fatal: false, blocked: false })
    }
  })

  it('a 4xx was not accepted: never unknown', async () => {
    for (const status of [400, 402, 403, 405, 408, 409, 410, 413, 415, 422, 424, 451, 499]) {
      const err = await sendError(answer(status, { code: 50035 }))
      expect(err, String(status)).toMatchObject({ status, code: 50035, unknown: false, fatal: false, blocked: false, threadGone: false, messageGone: false })
      expect(err.message).toBe(`Discord answered ${status} to the webhook send.`)
    }
  })

  it('401 is the webhook refused: fatal, whatever the code', async () => {
    for (const code of [0, 50027, 10015, 12345, null]) {
      const err = await sendError(answer(401, code === null ? { message: 'Unauthorized' } : { code }))
      expect(err).toMatchObject({ status: 401, code, fatal: true, unknown: false, blocked: false })
    }
    expect(await sendError({ status: 401, raw: 'nope' })).toMatchObject({ fatal: true, code: null })
  })

  it('404 is the webhook gone: fatal, for Unknown Webhook (10015), for any other code, and for none', async () => {
    for (const code of [10015, 0, 10004, 10013, 10011, 50027, 12345]) {
      expect(await sendError(answer(404, { code })), String(code)).toMatchObject({ status: 404, code, fatal: true, unknown: false, threadGone: false, messageGone: false })
    }
    expect(await sendError(answer(404, null))).toMatchObject({ status: 404, code: null, fatal: true })
    expect(await sendError({ status: 404, raw: '<html>not found</html>' })).toMatchObject({ fatal: true })
  })

  it('404 with Unknown Channel (10003) is the thread gone, not the webhook: not fatal, threadGone', async () => {
    const err = await sendError(answer(404, { code: 10003, message: 'Unknown Channel' }))
    expect(err).toMatchObject({ status: 404, code: 10003, fatal: false, threadGone: true, messageGone: false, unknown: false, blocked: false })
  })

  it('404 with Unknown Message (10008) is the message gone, not the webhook: not fatal, messageGone', async () => {
    const err = await sendError(answer(404, { code: 10008, message: 'Unknown Message' }))
    expect(err).toMatchObject({ status: 404, code: 10008, fatal: false, threadGone: false, messageGone: true, unknown: false, blocked: false })
  })

  it('only a 404 means the thread or the message is gone: 10003 and 10008 on other statuses mean nothing special', async () => {
    for (const status of [400, 403, 410]) {
      for (const code of [10003, 10008]) expect(await sendError(answer(status, { code }))).toMatchObject({ status, code, fatal: false, threadGone: false, messageGone: false })
    }
  })

  it('403 and 400 are plain failures that carry their code, so the outbox can tell an archived thread from the rest', async () => {
    expect(await sendError(answer(400, { code: 50083, message: 'Thread is archived' }))).toMatchObject({ status: 400, code: 50083, fatal: false, blocked: false, unknown: false })
    expect(await sendError(answer(403, { code: 50013 }))).toMatchObject({ status: 403, code: 50013, fatal: false })
  })

  it('an AutoMod block (200000) or a blocked link (200001) was refused: blocked, never unknown', async () => {
    for (const code of [200000, 200001]) {
      for (const status of [400, 403]) {
        const err = await sendError(answer(status, { code, message: 'Message was blocked by AutoMod' }))
        expect(err).toMatchObject({ status, code, blocked: true, fatal: false, unknown: false, retryAfterMs: null })
      }
    }
    expect(await sendError(answer(400, { code: 200002 }))).toMatchObject({ blocked: false })
    expect(await sendError(answer(400, { code: 199999 }))).toMatchObject({ blocked: false })
    expect(await sendError(answer(400, { code: '200000' }))).toMatchObject({ blocked: false, code: null })
  })

  it('a blocked answer is blocked even on 404 or 401, which no real answer is, because the code says what was refused', async () => {
    expect(await sendError(answer(404, { code: 200000 }))).toMatchObject({ blocked: true, fatal: false })
    expect(await sendError(answer(401, { code: 200001 }))).toMatchObject({ blocked: true, fatal: false })
  })

  it('reads a code only when it is a whole number', async () => {
    for (const code of ['200000', 200000.5, null, undefined, [], {}, true, Number.NaN]) {
      const err = await sendError(answer(400, { code }))
      expect(err.code).toBeNull()
      expect(err.blocked).toBe(false)
    }
    expect((await sendError(answer(400, [200000]))).code).toBeNull()
    expect((await sendError(answer(400, 'text'))).code).toBeNull()
    expect((await sendError(answer(400, 200000))).code).toBeNull()
    expect((await sendError(answer(400, { code: -5 }))).code).toBe(-5)
  })
})

describe('429: not accepted, so a later resend is safe', () => {
  const run = async (what, reply) => {
    const r = rig([reply])
    const body = sendBody(plain())
    const call = { send: () => r.client.send(THREAD, body), edit: () => r.client.edit(THREAD, MSG, body), remove: () => r.client.remove(THREAD, MSG) }[what]
    return failure(call())
  }

  for (const what of ['send', 'edit', 'remove']) {
    describe(what, () => {
      it('takes the wait from retry_after of the body, in seconds that may be fractional', async () => {
        const err = await run(what, answer(429, { code: 0, message: 'You are being rate limited.', retry_after: 1.5, global: false }))
        expect(err).toBeInstanceOf(WebhookError)
        expect(err).toMatchObject({ status: 429, retryAfterMs: 1500, global: false, unknown: false, fatal: false, blocked: false })
        expect(err.message).toBe(`Discord answered 429 to the webhook ${what === 'remove' ? 'delete' : what}.`)
      })

      it('takes it from the Retry-After header when the body has none', async () => {
        expect(await run(what, answer(429, { message: 'x' }, { 'Retry-After': '3' }))).toMatchObject({ retryAfterMs: 3000 })
        expect(await run(what, { status: 429, raw: '<html>slow down</html>', headers: { 'Retry-After': '0.25' } })).toMatchObject({ retryAfterMs: 250 })
      })

      it('prefers the body to the header', async () => {
        expect(await run(what, answer(429, { retry_after: 2 }, { 'Retry-After': '9' }))).toMatchObject({ retryAfterMs: 2000 })
      })

      it('rounds the wait to whole milliseconds, so float noise does not reach the outbox', async () => {
        expect(await run(what, answer(429, { retry_after: 1.005 }))).toMatchObject({ retryAfterMs: 1005 })
        expect(await run(what, answer(429, { retry_after: 0.07 }))).toMatchObject({ retryAfterMs: 70 })
        expect(await run(what, answer(429, {}, { 'Retry-After': '0.07' }))).toMatchObject({ retryAfterMs: 70 })
        expect(await run(what, answer(429, { retry_after: 0.0004 }))).toMatchObject({ retryAfterMs: 0 })
        expect(await run(what, answer(429, { retry_after: 0.0006 }))).toMatchObject({ retryAfterMs: 1 })
      })

      it('takes a wait of 0 from the body as 0', async () => {
        expect(await run(what, answer(429, { retry_after: 0 }, { 'Retry-After': '9' }))).toMatchObject({ retryAfterMs: 0 })
      })

      it('uses the header when the body wait is not a usable number', async () => {
        for (const retry_after of ['2', -1, Number.NaN, null, [], {}, true]) {
          expect(await run(what, answer(429, { retry_after }, { 'Retry-After': '4' })), JSON.stringify(retry_after)).toMatchObject({ retryAfterMs: 4000 })
        }
      })

      it('waits a second when neither says, or says something that is not a wait', async () => {
        expect(await run(what, answer(429, null))).toMatchObject({ retryAfterMs: 1000 })
        for (const header of ['', 'soon', '-3', 'Infinity', 'NaN', 'Wed, 21 Oct 2026 07:28:00 GMT']) {
          expect(await run(what, answer(429, {}, { 'Retry-After': header })), header).toMatchObject({ retryAfterMs: 1000 })
        }
      })

      it('caps a wait at an hour, so a number the outbox reads is always a sane one', async () => {
        expect(await run(what, answer(429, { retry_after: 3600 }))).toMatchObject({ retryAfterMs: 3_600_000 })
        expect(await run(what, answer(429, { retry_after: 3600.5 }))).toMatchObject({ retryAfterMs: 3_600_000 })
        expect(await run(what, answer(429, { retry_after: 1e12 }))).toMatchObject({ retryAfterMs: 3_600_000 })
        expect(await run(what, answer(429, {}, { 'Retry-After': '99999' }))).toMatchObject({ retryAfterMs: 3_600_000 })
        expect(await run(what, answer(429, { retry_after: 1e999 }))).toMatchObject({ retryAfterMs: 1000 })
      })

      it('says when the limit is global, by the body or by the header', async () => {
        expect(await run(what, answer(429, { retry_after: 1, global: true }))).toMatchObject({ global: true })
        expect(await run(what, answer(429, { retry_after: 1 }, { 'X-RateLimit-Global': 'true' }))).toMatchObject({ global: true })
        expect(await run(what, answer(429, { retry_after: 1, global: false }, { 'X-RateLimit-Global': 'true' }))).toMatchObject({ global: true })
        expect(await run(what, answer(429, { retry_after: 1, global: true }, { 'X-RateLimit-Global': 'false' }))).toMatchObject({ global: true })
      })

      it('is not global unless it says so exactly', async () => {
        expect(await run(what, answer(429, { retry_after: 1, global: 'true' }))).toMatchObject({ global: false })
        expect(await run(what, answer(429, { retry_after: 1, global: 1 }))).toMatchObject({ global: false })
        expect(await run(what, answer(429, { retry_after: 1 }, { 'X-RateLimit-Global': 'TRUE' }))).toMatchObject({ global: false })
        expect(await run(what, answer(429, { retry_after: 1 }, { 'X-RateLimit-Global': '1' }))).toMatchObject({ global: false })
      })

      it('is never unknown, fatal or blocked, whatever its body says', async () => {
        expect(await run(what, answer(429, { code: 200000, retry_after: 1 }))).toMatchObject({ status: 429, code: 200000, blocked: false, fatal: false, unknown: false })
        expect(await run(what, answer(429, { code: 10015, retry_after: 1 }))).toMatchObject({ fatal: false, unknown: false })
      })
    })
  }

  it('does not sleep or retry: one call, and the outbox decides', async () => {
    const r = rig([answer(429, { retry_after: 0.001 }), answer(200, message())])
    await failure(r.client.send(THREAD, sendBody(plain())))
    expect(r.seen).toHaveLength(1)
  })
})

describe('edit', () => {
  it('patches the message in the thread with the body and asks for its components', async () => {
    const r = rig([answer(200, message())])
    const body = sendBody(v2({ mentionIds: [USER_A] }))
    const got = await r.client.edit(THREAD, MSG, body)
    expect(got).toEqual(message())
    const { url, init } = r.seen[0]
    expect(url).toBe(`${ROOT}/messages/${MSG}?thread_id=${THREAD}&with_components=true`)
    expect(init.method).toBe('PATCH')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('does not send the name or the picture, which an edit cannot change, and does not change its input', async () => {
    const r = rig([answer(200, message())])
    const body = sendBody(v2())
    const copy = structuredClone(body)
    await r.client.edit(THREAD, MSG, body)
    const sent = JSON.parse(r.seen[0].init.body)
    expect(sent).toEqual({ flags: 32768, components: V2_PART.components, allowed_mentions: { parse: [], users: [] } })
    expect('username' in sent || 'avatar_url' in sent).toBe(false)
    expect(body).toEqual(copy)
  })

  it('takes a body with no name or picture', async () => {
    const r = rig([answer(200, message())])
    await r.client.edit(THREAD, MSG, { flags: 4, content: 'x', allowed_mentions: { parse: [] } })
    expect(JSON.parse(r.seen[0].init.body)).toEqual({ flags: 4, content: 'x', allowed_mentions: { parse: [] } })
  })

  it('refuses ids that are not plain Discord ids, before it sends anything', async () => {
    const r = rig([])
    for (const bad of ['', '1', `${MSG}/x`, `${MSG}?x=1`, `../${MSG}`, undefined, null, 12]) {
      await expect(r.client.edit(bad, MSG, sendBody(plain())), String(bad)).rejects.toThrow()
      await expect(r.client.edit(THREAD, bad, sendBody(plain())), String(bad)).rejects.toThrow()
    }
    expect(r.seen).toHaveLength(0)
  })

  it('answers the message, and a 2xx with no message is a plain failure, not unknown: an edit can be repeated', async () => {
    for (const body of [null, {}, 'x', { id: 12 }]) {
      const r = rig([answer(200, body)])
      const err = await failure(r.client.edit(THREAD, MSG, sendBody(plain())))
      expect(err).toMatchObject({ status: 200, unknown: false, fatal: false })
      expect(err.message).toBe('Discord answered 200 to the webhook edit, but not with a message.')
    }
  })

  it('a timeout, a network error and a 5xx are plain failures: an edit can be repeated, so none is unknown', async () => {
    const timeout = rig([], { timeoutMs: 15, fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) })
    expect(await failure(timeout.client.edit(THREAD, MSG, sendBody(plain())))).toMatchObject({ status: null, unknown: false, fatal: false })
    const net = rig([new Error('ECONNRESET')])
    const err = await failure(net.client.edit(THREAD, MSG, sendBody(plain())))
    expect(err).toMatchObject({ status: null, unknown: false })
    expect(err.message).toBe('The webhook edit got no answer from Discord.')
    for (const status of [500, 502, 503, 599]) {
      const r = rig([answer(status, null)])
      expect(await failure(r.client.edit(THREAD, MSG, sendBody(plain())))).toMatchObject({ status, unknown: false, fatal: false })
    }
    const odd = rig([oddStatus(302)])
    expect(await failure(odd.client.edit(THREAD, MSG, sendBody(plain())))).toMatchObject({ status: 302, unknown: false })
  })

  it('maps the other statuses as send does: fatal, gone, blocked or plain', async () => {
    const run = async (reply) => failure(rig([reply]).client.edit(THREAD, MSG, sendBody(plain())))
    expect(await run(answer(401, { code: 50027 }))).toMatchObject({ fatal: true })
    expect(await run(answer(404, { code: 10015 }))).toMatchObject({ fatal: true })
    expect(await run(answer(404, null))).toMatchObject({ fatal: true })
    expect(await run(answer(404, { code: 10008 }))).toMatchObject({ fatal: false, messageGone: true })
    expect(await run(answer(404, { code: 10003 }))).toMatchObject({ fatal: false, threadGone: true })
    expect(await run(answer(400, { code: 200000 }))).toMatchObject({ blocked: true })
    expect(await run(answer(400, { code: 200001 }))).toMatchObject({ blocked: true })
    expect(await run(answer(400, { code: 50083 }))).toMatchObject({ status: 400, code: 50083, fatal: false, blocked: false })
  })
})

describe('remove', () => {
  it('deletes the message in the thread and answers nothing', async () => {
    const r = rig([answer(204)])
    const got = await r.client.remove(THREAD, MSG)
    expect(got).toBeUndefined()
    const { url, init } = r.seen[0]
    expect(url).toBe(`${ROOT}/messages/${MSG}?thread_id=${THREAD}`)
    expect(init.method).toBe('DELETE')
    expect(init.body).toBeUndefined()
    expect(init.headers).toEqual({})
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('takes any 2xx as done', async () => {
    for (const status of [200, 204]) expect(await rig([answer(status, status === 200 ? {} : undefined)]).client.remove(THREAD, MSG)).toBeUndefined()
  })

  it('treats a message that is already gone (404, code 10008) as success', async () => {
    const r = rig([answer(404, { code: 10008, message: 'Unknown Message' })])
    expect(await r.client.remove(THREAD, MSG)).toBeUndefined()
  })

  it('does not treat any other 404 as done: Unknown Webhook is fatal, Unknown Channel is the thread gone', async () => {
    expect(await failure(rig([answer(404, { code: 10015 })]).client.remove(THREAD, MSG))).toMatchObject({ status: 404, code: 10015, fatal: true, messageGone: false })
    expect(await failure(rig([answer(404, null)]).client.remove(THREAD, MSG))).toMatchObject({ status: 404, code: null, fatal: true })
    expect(await failure(rig([answer(404, { code: 0 })]).client.remove(THREAD, MSG))).toMatchObject({ fatal: true })
    expect(await failure(rig([answer(404, { code: 10003 })]).client.remove(THREAD, MSG))).toMatchObject({ status: 404, code: 10003, fatal: false, threadGone: true })
  })

  it('does not treat code 10008 on another status as done', async () => {
    for (const status of [400, 403, 410, 500]) {
      expect(await failure(rig([answer(status, { code: 10008 })]).client.remove(THREAD, MSG))).toBeInstanceOf(WebhookError)
    }
  })

  it('a timeout, a network error and a 5xx are plain failures: a delete can be repeated, so none is unknown', async () => {
    const net = rig([new Error('ECONNRESET')])
    const err = await failure(net.client.remove(THREAD, MSG))
    expect(err).toMatchObject({ status: null, unknown: false, fatal: false })
    expect(err.message).toBe('The webhook delete got no answer from Discord.')
    for (const status of [500, 503]) expect(await failure(rig([answer(status, null)]).client.remove(THREAD, MSG))).toMatchObject({ status, unknown: false })
    expect(await failure(rig([oddStatus(302)]).client.remove(THREAD, MSG))).toMatchObject({ status: 302, unknown: false })
  })

  it('maps the other statuses as send does', async () => {
    expect(await failure(rig([answer(401, null)]).client.remove(THREAD, MSG))).toMatchObject({ fatal: true })
    expect(await failure(rig([answer(403, { code: 50013 })]).client.remove(THREAD, MSG))).toMatchObject({ status: 403, code: 50013, fatal: false })
    expect(await failure(rig([answer(400, { code: 200000 })]).client.remove(THREAD, MSG))).toMatchObject({ blocked: true })
  })

  it('refuses ids that are not plain Discord ids, before it sends anything', async () => {
    const r = rig([])
    for (const bad of ['', '1', `${MSG}/x`, `${MSG}?x=1`, `../${MSG}`, undefined, null, 12]) {
      await expect(r.client.remove(bad, MSG), String(bad)).rejects.toThrow()
      await expect(r.client.remove(THREAD, bad), String(bad)).rejects.toThrow()
    }
    expect(r.seen).toHaveLength(0)
  })
})

describe('recent: what this webhook posted lately, through the bot client', () => {
  const other = { id: '200000000000000431', webhook_id: '200000000000000451', content: 'another webhook' }
  const human = { id: '200000000000000432', content: 'a person', author: { id: USER_A } }
  const ours = { id: '200000000000000433', webhook_id: HOOK, content: 'ours' }
  const ours2 = { id: '200000000000000434', webhook_id: HOOK, content: 'ours too' }

  it('asks the bot client for the newest messages of the thread, 20 by default, and keeps those of this webhook', async () => {
    const asked = []
    const newest = async (...args) => {
      asked.push(args)
      return [ours2, human, other, ours]
    }
    const client = createWebhookClient({ fetchImpl: async () => null, url: URL_OK, apiBase: API, newest })
    expect(await client.recent(THREAD)).toEqual([ours2, ours])
    expect(await client.recent(THREAD, 5)).toEqual([ours2, ours])
    expect(asked).toEqual([
      [THREAD, 20],
      [THREAD, 5],
    ])
  })

  it('answers nothing when the thread holds none of its messages', async () => {
    const client = createWebhookClient({ fetchImpl: async () => null, url: URL_OK, apiBase: API, newest: async () => [human, other] })
    expect(await client.recent(THREAD)).toEqual([])
  })

  it('compares the whole webhook id, as text', async () => {
    const near = [{ ...ours, webhook_id: `${HOOK}0` }, { ...ours, webhook_id: HOOK.slice(0, -1) }, { ...ours, webhook_id: Number(HOOK) }, { ...ours, webhook_id: null }, { ...ours, webhook_id: undefined }]
    const client = createWebhookClient({ fetchImpl: async () => null, url: URL_OK, apiBase: API, newest: async () => near })
    expect(await client.recent(THREAD)).toEqual([])
  })

  it('refuses when no bot client was given, saying so as a TypeError', async () => {
    const client = createWebhookClient({ fetchImpl: async () => null, url: URL_OK, apiBase: API })
    const err = await failure(client.recent(THREAD))
    expect(err).toBeInstanceOf(TypeError)
    expect(err.message).toBe('recent needs the newest option of createWebhookClient.')
  })

  it('lets what the bot client throws go up as it is', async () => {
    const boom = new Error('bot client says no')
    const client = createWebhookClient({ fetchImpl: async () => null, url: URL_OK, apiBase: API, newest: async () => Promise.reject(boom) })
    expect(await failure(client.recent(THREAD))).toBe(boom)
  })

  it('never calls the webhook itself', async () => {
    const r = rig([], { newest: async () => [ours] })
    await r.client.recent(THREAD)
    expect(r.seen).toHaveLength(0)
  })
})

describe('the address and its token never leave in an error', () => {
  const token = fc.stringMatching(/^[A-Za-z0-9_-]{8,60}$/).map((s) => `zz${s}`)
  const ID = HOOK

  // Every way a call can fail, each with the address and the token in whatever Discord or the network might echo.
  const scenarios = (url, secret) => [
    { reply: new Error(`connect ECONNREFUSED ${url}`) },
    { reply: Object.assign(new Error(`getaddrinfo ENOTFOUND discord.com ${secret}`), { code: 'ENOTFOUND', cause: new Error(url), url }) },
    { reply: new DOMException(`aborted ${url}`, 'AbortError') },
    { reply: () => Promise.reject(url) },
    { reply: answer(400, { code: 50035, message: `bad ${url}`, errors: { token: { _errors: [{ message: secret }] } } }) },
    { reply: answer(401, { code: 50027, message: `Invalid Webhook Token ${secret}` }) },
    { reply: answer(404, { code: 10015, message: `Unknown Webhook ${url}` }) },
    { reply: answer(404, { code: 10003, message: `Unknown Channel ${secret}` }) },
    { reply: answer(404, { code: 10008, message: `Unknown Message ${secret}` }), notRemove: true },
    { reply: answer(429, { retry_after: 2, global: false, message: `limited ${url}` }) },
    { reply: answer(429, { retry_after: 2, global: true, message: secret }, { 'Retry-After': secret }) },
    { reply: answer(500, { message: url }) },
    { reply: { status: 502, raw: `<html>${url}</html>` } },
    { reply: answer(400, { code: 200000, message: `AutoMod ${url}` }) },
    { reply: answer(400, { code: 200001, message: secret }) },
    { reply: answer(200, { id: 12, url, token: secret }) },
    { reply: { status: 200, raw: `${url} ${secret}` } },
    { reply: oddStatus(302) },
  ]

  it('holds in no field, no text and no inspection of any error, on any path', async () => {
    await fc.assert(
      fc.asyncProperty(token, async (secret) => {
        const url = `${API}/webhooks/${ID}/${secret}`
        for (const { reply, notRemove } of scenarios(url, secret)) {
          for (const what of ['send', 'edit', 'remove']) {
            if (what === 'remove' && notRemove) continue
            const fetchImpl = async () => {
              if (typeof reply === 'function') return reply()
              if (reply instanceof Error) throw reply
              return new Response(reply.raw ?? JSON.stringify(reply.body ?? null), { status: reply.status, headers: reply.headers })
            }
            const client = createWebhookClient({ fetchImpl, url, apiBase: API })
            const body = sendBody(plain())
            const run = { send: () => client.send(THREAD, body), edit: () => client.edit(THREAD, MSG, body), remove: () => client.remove(THREAD, MSG) }[what]
            let err = null
            try {
              await run()
            } catch (e) {
              err = e
            }
            if (err === null) continue
            expect(err).toBeInstanceOf(WebhookError)
            expect(err.cause).toBeUndefined()
            const dump = dumpOf(err)
            expect(dump).not.toContain(secret)
            expect(dump).not.toContain(url)
            expect(dump).not.toContain(`/webhooks/${ID}`)
          }
        }
      }),
      { numRuns: 25 },
    )
  })

  it('holds when the timeout fires, and for a refusal at construction', async () => {
    await fc.assert(
      fc.asyncProperty(token, async (secret) => {
        const url = `${API}/webhooks/${ID}/${secret}`
        const fetchImpl = (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error(`${url} ${init.signal.reason.name}`))))
        const client = createWebhookClient({ fetchImpl, url, apiBase: API, timeoutMs: 5 })
        const err = await failure(client.send(THREAD, sendBody(plain())))
        expect(dumpOf(err)).not.toContain(secret)
        for (const bad of [`${url}/x`, `${url}?x`, `x${url}`, `${API}/webhooks/${ID}/${secret.slice(0, 3)}`]) {
          const refusal = (() => {
            try {
              createWebhookClient({ fetchImpl, url: bad, apiBase: API })
            } catch (e) {
              return e
            }
            return null
          })()
          expect(refusal).not.toBeNull()
          expect(dumpOf(refusal)).not.toContain(secret)
        }
      }),
      { numRuns: 10 },
    )
  })

  it('holds for what the other checks throw before a call, even when the token is in the thread id or the body', async () => {
    await fc.assert(
      fc.asyncProperty(token, async (secret) => {
        const url = `${API}/webhooks/${ID}/${secret}`
        const client = createWebhookClient({ fetchImpl: async () => null, url, apiBase: API })
        const attempts = [
          () => client.send(`${THREAD}${secret}`, sendBody(plain())),
          () => client.send(THREAD, { content: secret }),
          () => client.send(THREAD, { ...sendBody(plain()), thread_name: secret }),
          () => client.edit(secret, MSG, sendBody(plain())),
          () => client.remove(THREAD, secret),
          () => client.send(THREAD, sendBody(plain()), [{ name: secret, type: 'image/png', bytes: new Uint8Array([1]) }]),
          () => client.send(THREAD, sendBody(plain()), [{ name: 'a.png', type: secret, bytes: new Uint8Array([1]) }]),
        ]
        for (const attempt of attempts) {
          let err = null
          try {
            await attempt()
          } catch (e) {
            err = e
          }
          expect(err).not.toBeNull()
          expect(dumpOf(err)).not.toContain(secret)
        }
      }),
      { numRuns: 10 },
    )
  })

  it('holds for the error of recent when no bot client was given', async () => {
    const client = createWebhookClient({ fetchImpl: async () => null, url: URL_OK, apiBase: API })
    const err = await failure(client.recent(THREAD))
    expect(dumpOf(err)).not.toContain(TOKEN)
  })
})

// What a refusal says, in full: a text of its own for each, as the module's doc comment promises.
function refusalOf(fn) {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error('it did not throw')
}

function expectRefusal(err, Type, message) {
  expect(err).toBeInstanceOf(Type)
  expect(err.constructor).toBe(Type)
  expect(err.message).toBe(message)
}

describe('every refusal says what is wrong, in words of its own', () => {
  const BODY = 'The body must be one that sendBody built.'
  const GOOD = () => sendBody(v2())

  it('parseWebhookUrl and webhookUrl', () => {
    expectRefusal(refusalOf(() => parseWebhookUrl(undefined, API)), TypeError, 'The webhook address must be text.')
    expectRefusal(refusalOf(() => parseWebhookUrl(12, API)), TypeError, 'The webhook address must be text.')
    expectRefusal(refusalOf(() => parseWebhookUrl(URL_OK, undefined)), TypeError, 'apiBase must be text.')
    expectRefusal(refusalOf(() => parseWebhookUrl(URL_OK, '')), RangeError, 'apiBase must be an http:// or https:// address.')
    expectRefusal(refusalOf(() => webhookUrl(API, undefined, TOKEN)), TypeError, 'The webhook id and token must be text.')
    expectRefusal(refusalOf(() => webhookUrl(API, HOOK, 12345678)), TypeError, 'The webhook id and token must be text.')
  })

  it('sendBody: the form and the part', () => {
    expectRefusal(refusalOf(() => sendBody(v2({ form: 'V2' }))), RangeError, 'form must be "v2" or "plain".')
    for (const part of [undefined, null, 'x', 12, [], [V2_PART]]) expectRefusal(refusalOf(() => sendBody(v2({ part }))), TypeError, 'part must be an object.')
    for (const part of [undefined, null, 'x', 12, [], [PLAIN_PART]]) expectRefusal(refusalOf(() => sendBody(plain({ part }))), TypeError, 'part must be an object.')
    expectRefusal(refusalOf(() => sendBody(v2({ part: PLAIN_PART }))), TypeError, 'A v2 part must have components.')
    expectRefusal(refusalOf(() => sendBody(v2({ part: { ...V2_PART, components: [] } }))), RangeError, 'A v2 part must have at least one component.')
    expectRefusal(refusalOf(() => sendBody(plain({ part: V2_PART }))), TypeError, 'A plain part has no components.')
    expectRefusal(refusalOf(() => sendBody(plain({ part: { ...PLAIN_PART, text: undefined } }))), TypeError, 'A plain part must have text.')
    expectRefusal(refusalOf(() => sendBody(plain({ part: { ...PLAIN_PART, text: '' } }))), RangeError, 'A plain part must have some text.')
    expectRefusal(refusalOf(() => sendBody(plain({ part: { ...PLAIN_PART, text: 'a'.repeat(2001) } }))), RangeError, 'A plain message holds at most 2000 characters.')
    const long = { text: 'x', components: [{ type: 17, components: [{ type: 10, content: 'a'.repeat(4001) }] }], files: [] }
    expectRefusal(refusalOf(() => sendBody(v2({ part: long }))), RangeError, 'A v2 message holds at most 4000 characters.')
  })

  it('sendBody: the name, the picture and the people', () => {
    expectRefusal(refusalOf(() => sendBody(v2({ username: undefined }))), TypeError, 'username must be text.')
    expectRefusal(refusalOf(() => sendBody(v2({ username: '' }))), RangeError, 'username must be 1 to 80 characters.')
    expectRefusal(refusalOf(() => sendBody(v2({ username: 'a'.repeat(81) }))), RangeError, 'username must be 1 to 80 characters.')
    expectRefusal(refusalOf(() => sendBody(v2({ avatarUrl: 12 }))), TypeError, 'avatarUrl must be text or null.')
    expectRefusal(refusalOf(() => sendBody(v2({ avatarUrl: 'http://x.test/a.png' }))), RangeError, 'avatarUrl must be an https link of at most 512 characters.')
    expectRefusal(refusalOf(() => sendBody(v2({ mentionIds: 'x' }))), TypeError, 'mentionIds must be a list.')
    expectRefusal(refusalOf(() => sendBody(v2({ mentionIds: [12] }))), TypeError, 'A mention must be a Discord id.')
    expectRefusal(refusalOf(() => sendBody(v2({ mentionIds: ['everyone'] }))), RangeError, 'A mention must be a Discord id.')
  })

  it('createWebhookClient: its options', () => {
    const make = (over) => () => createWebhookClient({ fetchImpl: async () => null, url: URL_OK, apiBase: API, ...over })
    expectRefusal(refusalOf(make({ fetchImpl: 'fetch' })), TypeError, 'fetchImpl must be a function.')
    expectRefusal(refusalOf(make({ timeoutMs: 0 })), RangeError, 'timeoutMs must be a number above 0.')
    expectRefusal(refusalOf(make({ timeoutMs: Number.NaN })), RangeError, 'timeoutMs must be a number above 0.')
    expectRefusal(refusalOf(make({ newest: 'x' })), TypeError, 'newest must be a function.')
    expectRefusal(refusalOf(make({ url: undefined })), TypeError, 'The webhook address must be text.')
    expectRefusal(refusalOf(make({ url: 'https://example.test/' })), RangeError, 'The webhook address is not https://discord.com/api/webhooks/<id>/<token>.')
    expectRefusal(refusalOf(make({ apiBase: undefined })), TypeError, 'apiBase must be text.')
    expectRefusal(refusalOf(make({ apiBase: 'x' })), RangeError, 'apiBase must be an http:// or https:// address.')
  })

  it('the calls: the ids', async () => {
    const r = rig([])
    const body = GOOD()
    expectRefusal(await failure(r.client.send('1', body)), TypeError, 'threadId must be a Discord id.')
    expectRefusal(await failure(r.client.edit('1', MSG, body)), TypeError, 'threadId must be a Discord id.')
    expectRefusal(await failure(r.client.edit(THREAD, '1', body)), TypeError, 'messageId must be a Discord id.')
    expectRefusal(await failure(r.client.remove('1', MSG)), TypeError, 'threadId must be a Discord id.')
    expectRefusal(await failure(r.client.remove(THREAD, '1')), TypeError, 'messageId must be a Discord id.')
    // The thread is read before the message.
    expectRefusal(await failure(r.client.edit('1', '1', body)), TypeError, 'threadId must be a Discord id.')
    expectRefusal(await failure(r.client.remove('1', '1')), TypeError, 'threadId must be a Discord id.')
    expect(r.seen).toHaveLength(0)
  })

  it('the calls: the body, for a send and an edit alike', async () => {
    const r = rig([])
    const good = GOOD()
    for (const call of [(b) => r.client.send(THREAD, b), (b) => r.client.edit(THREAD, MSG, b)]) {
      for (const bad of [undefined, null, 'text', 12, true, [], [good]]) expectRefusal(await failure(call(bad)), TypeError, BODY)
      for (const extra of [{ thread_name: 'x' }, { applied_tags: [] }, { embeds: [] }, { tts: true }, { attachments: [] }, { message_reference: {} }]) {
        expectRefusal(await failure(call({ ...good, ...extra })), RangeError, 'The body holds a field that sendBody never sets.')
      }
      const mentions = 'The body must carry the allowed_mentions that sendBody builds.'
      for (const allowed_mentions of [undefined, null, 'x', 12, [], {}, { users: [] }, { parse: ['everyone'] }, { parse: {} }, { parse: 'x' }, { parse: [], roles: [] }, { parse: [], replied_user: false },
        { parse: [], users: USER_A }, { parse: [], users: [12] }, { parse: [], users: [Number(USER_A)] }, { parse: [], users: [null] }, { parse: [], users: ['everyone'] }, { parse: [], users: [' ' + USER_A] }]) {
        expectRefusal(await failure(call({ ...good, allowed_mentions })), RangeError, mentions)
      }
      expectRefusal(await failure(call({ ...good, allowed_mentions: { parse: [], users: Array.from({ length: 11 }, (_, i) => String(200000000000000500n + BigInt(i))) } })), RangeError, mentions)
    }
    expect(r.seen).toHaveLength(0)
  })

  it('send: the files', async () => {
    const r = rig([])
    const body = GOOD()
    const file = { name: 'a.png', type: 'image/png', bytes: new Uint8Array([1]) }
    expectRefusal(await failure(r.client.send(THREAD, body, 'x')), TypeError, 'files must be a list.')
    expectRefusal(await failure(r.client.send(THREAD, body, 12)), TypeError, 'files must be a list.')
    expectRefusal(await failure(r.client.send(THREAD, body, {})), TypeError, 'files must be a list.')
    expectRefusal(await failure(r.client.send(THREAD, body, Array(11).fill(file))), RangeError, 'At most 10 files can be sent.')
    for (const bad of [null, undefined, 'x', 12, [], { ...file, name: 12 }, { ...file, type: 12 }, { ...file, bytes: [1] }, { ...file, bytes: new ArrayBuffer(1) }]) {
      expectRefusal(await failure(r.client.send(THREAD, body, [bad])), TypeError, 'A file must be { name, type, bytes }.')
    }
    expectRefusal(await failure(r.client.send(THREAD, body, [{ ...file, name: 'a/b.png' }])), RangeError, 'A file name must be a plain file name.')
    expectRefusal(await failure(r.client.send(THREAD, body, [{ ...file, type: 'text/html' }])), RangeError, 'A file must be a PNG, JPEG, WebP or GIF picture.')
    expectRefusal(await failure(r.client.send(THREAD, body, [{ ...file, bytes: new Uint8Array(0) }])), RangeError, 'A file must have some bytes.')
    expect(r.seen).toHaveLength(0)
  })

  it('an address with allowed_mentions users that are numbers is refused whole, as are the bodies that name a number', async () => {
    const r = rig([])
    const bad = { ...GOOD(), allowed_mentions: { parse: [], users: [Number(USER_A), USER_B] } }
    expect((await failure(r.client.send(THREAD, bad))).message).toBe('The body must carry the allowed_mentions that sendBody builds.')
  })
})

describe('the shape of every error, field by field', () => {
  const FIELDS = ['status', 'code', 'fatal', 'blocked', 'unknown', 'threadGone', 'messageGone', 'retryAfterMs', 'global']
  const full = (err) => Object.fromEntries(FIELDS.map((k) => [k, err[k]]))
  const E = (over) => ({ status: null, code: null, fatal: false, blocked: false, unknown: false, threadGone: false, messageGone: false, retryAfterMs: null, global: false, ...over })
  const NAMES = { send: 'send', edit: 'edit', remove: 'delete' }

  for (const what of ['send', 'edit', 'remove']) {
    it(`${what}: each kind of failure sets exactly its own fields`, async () => {
      // May it have landed? Only a send says so.
      const lands = what === 'send'
      const rows = [
        [new Error('ECONNRESET'), E({ unknown: lands }), `The webhook ${NAMES[what]} got no answer from Discord.`],
        [answer(500, null), E({ status: 500, unknown: lands }), `Discord answered 500 to the webhook ${NAMES[what]}.`],
        [answer(503, { code: 0 }), E({ status: 503, code: 0, unknown: lands }), `Discord answered 503 to the webhook ${NAMES[what]}.`],
        [oddStatus(302), E({ status: 302, unknown: lands }), `Discord answered 302 to the webhook ${NAMES[what]}.`],
        [oddStatus(300), E({ status: 300, unknown: lands }), `Discord answered 300 to the webhook ${NAMES[what]}.`],
        [oddStatus(101), E({ status: 101, unknown: lands }), `Discord answered 101 to the webhook ${NAMES[what]}.`],
        [oddStatus(100), E({ status: 100, unknown: lands }), `Discord answered 100 to the webhook ${NAMES[what]}.`],
        [oddStatus(600), E({ status: 600, unknown: lands }), `Discord answered 600 to the webhook ${NAMES[what]}.`],
        [answer(429, { retry_after: 1.5 }), E({ status: 429, retryAfterMs: 1500 }), `Discord answered 429 to the webhook ${NAMES[what]}.`],
        [answer(429, { retry_after: 2, global: true, code: 20028 }), E({ status: 429, code: 20028, retryAfterMs: 2000, global: true }), `Discord answered 429 to the webhook ${NAMES[what]}.`],
        [answer(400, { code: 50035 }), E({ status: 400, code: 50035 }), `Discord answered 400 to the webhook ${NAMES[what]}.`],
        [answer(400, null), E({ status: 400 }), `Discord answered 400 to the webhook ${NAMES[what]}.`],
        [answer(403, { code: 50013 }), E({ status: 403, code: 50013 }), `Discord answered 403 to the webhook ${NAMES[what]}.`],
        [answer(401, { code: 50027 }), E({ status: 401, code: 50027, fatal: true }), `Discord answered 401 to the webhook ${NAMES[what]}.`],
        [answer(404, { code: 10015 }), E({ status: 404, code: 10015, fatal: true }), `Discord answered 404 to the webhook ${NAMES[what]}.`],
        [answer(404, null), E({ status: 404, fatal: true }), `Discord answered 404 to the webhook ${NAMES[what]}.`],
        [answer(404, { code: 10003 }), E({ status: 404, code: 10003, threadGone: true }), `Discord answered 404 to the webhook ${NAMES[what]}.`],
        [answer(400, { code: 200000 }), E({ status: 400, code: 200000, blocked: true }), `Discord answered 400 to the webhook ${NAMES[what]}.`],
        [answer(400, { code: 200001 }), E({ status: 400, code: 200001, blocked: true }), `Discord answered 400 to the webhook ${NAMES[what]}.`],
        [answer(200, {}), E({ status: 200, unknown: lands }), `Discord answered 200 to the webhook ${NAMES[what]}, but not with a message.`],
        [answer(204), E({ status: 204, unknown: lands }), `Discord answered 204 to the webhook ${NAMES[what]}, but not with a message.`],
      ]
      // A delete has no message to answer with: an answer that says nothing is its success.
      if (what !== 'remove') rows.push([answer(404, { code: 10008 }), E({ status: 404, code: 10008, messageGone: true }), `Discord answered 404 to the webhook ${NAMES[what]}.`])
      else rows.splice(rows.length - 2, 2)
      for (const [reply, expected, message] of rows) {
        const r = rig([reply])
        const body = sendBody(plain())
        const call = { send: () => r.client.send(THREAD, body), edit: () => r.client.edit(THREAD, MSG, body), remove: () => r.client.remove(THREAD, MSG) }[what]
        const err = await failure(call())
        expect(full(err), message).toEqual(expected)
        expect(err.message).toBe(message)
      }
    })
  }

  it('a successful call answers without an error: a 2xx for each, and the ends of the range', async () => {
    for (const status of [200, 201, 299]) {
      const reply = () => ({ status, headers: new Headers(), json: async () => message() })
      expect(await rig([reply]).client.edit(THREAD, MSG, sendBody(plain()))).toEqual(message())
      expect(await rig([() => ({ status, headers: new Headers(), json: async () => null })]).client.remove(THREAD, MSG)).toBeUndefined()
    }
    for (const status of [199, 300]) {
      const err = await failure(rig([oddStatus(status)]).client.remove(THREAD, MSG))
      expect(err.status).toBe(status)
    }
  })

  it('a delete that is refused for another reason is an error even when its text says the message is gone', async () => {
    const err = await failure(rig([answer(500, { code: 10008 })]).client.remove(THREAD, MSG))
    expect(full(err)).toEqual(E({ status: 500, code: 10008 }))
  })
})

describe('the root of the calls', () => {
  it('has no slash at its end, however many the API base has', async () => {
    for (const apiBase of [API, `${API}/`, `${API}//`, `${API}///`]) {
      const r = rig([answer(200, message()), answer(200, message()), answer(204)], { apiBase })
      await r.client.send(THREAD, sendBody(plain()))
      await r.client.edit(THREAD, MSG, sendBody(plain()))
      await r.client.remove(THREAD, MSG)
      expect(r.seen.map((s) => s.url)).toEqual([
        `${ROOT}?wait=true&thread_id=${THREAD}&with_components=true`,
        `${ROOT}/messages/${MSG}?thread_id=${THREAD}&with_components=true`,
        `${ROOT}/messages/${MSG}?thread_id=${THREAD}`,
      ])
    }
  })

  it('keeps a path on the API base, and makes the call at the API base given, not at the address', async () => {
    const r = rig([answer(200, message())], { apiBase: 'http://discord-mock:4400/mock/' })
    await r.client.send(THREAD, sendBody(plain()))
    expect(r.seen[0].url).toBe(`http://discord-mock:4400/mock/v10/webhooks/${HOOK}/${TOKEN}?wait=true&thread_id=${THREAD}&with_components=true`)
  })

  it('takes the mock address only with an http API base, not an https one at the same place', () => {
    const mock = (scheme) => `${scheme}://discord-mock:4400/api/webhooks/${HOOK}/${TOKEN}`
    expect(() => parseWebhookUrl(mock('https'), 'https://discord-mock:4400')).toThrow(RangeError)
    expect(() => parseWebhookUrl(`https://d.test/api/webhooks/${HOOK}/${TOKEN}`, 'https://d.test/api')).toThrow(RangeError)
    expect(() => parseWebhookUrl(`https://d.test/api/webhooks/${HOOK}/${TOKEN}`, 'https://d.test')).toThrow(RangeError)
    expect(parseWebhookUrl(mock('http'), 'http://discord-mock:4400')).toEqual({ id: HOOK, token: TOKEN })
  })
})
