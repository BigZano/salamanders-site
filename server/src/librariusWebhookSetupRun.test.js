import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { SetupRefused, runSetup, setupConfig } from './librariusWebhookSetupRun.js'
import { parseWebhookUrl } from './librariusWebhook.js'

// Every id and token here is invented.
const GUILD = '200000000000000400'
const FORUM = '200000000000000401'
const BOT = '200000000000000402'
const OTHER_PERSON = '200000000000000403'
const NEW_HOOK = '200000000000000470'
const OLD_HOOK = '200000000000000471'
const BOT_TOKEN = 'bot-token-for-the-test-9f8e7d'
const HOOK_TOKEN = 'new-webhook-token-for-the-test_1a2b3c-XYZ'
const OLD_TOKEN = 'old-webhook-token-for-the-test_9z8y7x-ABC'
const API = 'https://discord.test/api'
const ENV = { DISCORD_API_BASE: API, DISCORD_BOT_TOKEN: BOT_TOKEN, DISCORD_GUILD_ID: GUILD, LIBRARIUS_CHANNEL_ID: FORUM }

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const forum = (over = {}) => ({ id: FORUM, type: 15, guild_id: GUILD, name: 'invented forum', ...over })
const hook = (over = {}) => ({ id: OLD_HOOK, type: 1, name: 'Librarius', channel_id: FORUM, token: OLD_TOKEN, user: { id: BOT, username: 'invented bot' }, application_id: null, ...over })
const OLD_LINE = `LIBRARIUS_WEBHOOK_URL=https://discord.com/api/webhooks/${OLD_HOOK}/${OLD_TOKEN}`

/**
 * A fake of the four routes the setup calls. `over` replaces what a route answers: a Response, a function of the call, or an
 * Error to throw. Every call is recorded as it arrives.
 */
function rig(over = {}) {
  const seen = []
  const routes = {
    'GET /v10/users/@me': () => json(200, { id: BOT, username: 'invented bot', bot: true }),
    [`GET /v10/channels/${FORUM}`]: () => json(200, forum()),
    [`GET /v10/channels/${FORUM}/webhooks`]: () => json(200, []),
    [`POST /v10/channels/${FORUM}/webhooks`]: () => json(200, { id: NEW_HOOK, token: HOOK_TOKEN, name: 'Librarius', channel_id: FORUM }),
    ...over,
  }
  const fetchImpl = async (url, init = {}) => {
    // The route, whichever host and /api prefix the base had.
    const path = new URL(url).pathname.replace(/^\/api(?=\/v10)/, '')
    const key = `${init.method} ${path}`
    seen.push({ key, url, init })
    const route = routes[key]
    if (route === undefined) throw new Error(`the test has no route for ${key}`)
    const r = typeof route === 'function' ? route(init) : route
    if (r instanceof Error) throw r
    return r
  }
  return { seen, fetchImpl }
}

async function run({ argv = [], env = ENV, routes = {}, fetchImpl } = {}) {
  const r = rig(routes)
  const out = []
  const err = []
  const code = await runSetup({ argv, env, fetchImpl: fetchImpl ?? r.fetchImpl, log: (l) => out.push(String(l)), warn: (l) => err.push(String(l)) })
  return { code, out, err, seen: r.seen, all: [...out, ...err].join('\n') }
}

const count = (text, needle) => text.split(needle).length - 1

describe('setupConfig: the settings the setup refuses to run without', () => {
  it('takes the token, the guild, the forum and the API base from the environment', () => {
    expect(setupConfig(ENV)).toEqual({ apiBase: API, botToken: BOT_TOKEN, guildId: GUILD, channelId: FORUM })
  })

  it('talks to the real Discord unless the environment names another API, and drops the slashes that end it', () => {
    const { DISCORD_API_BASE, ...without } = ENV
    expect(DISCORD_API_BASE).toBe(API)
    expect(setupConfig(without).apiBase).toBe('https://discord.com/api')
    expect(setupConfig({ ...without, DISCORD_API_BASE: '' }).apiBase).toBe('https://discord.com/api')
    expect(setupConfig({ ...ENV, DISCORD_API_BASE: `${API}///` }).apiBase).toBe(API)
  })

  it('refuses each missing or malformed setting, naming the variable and not its value', () => {
    const cases = [
      ['DISCORD_BOT_TOKEN', undefined, 'DISCORD_BOT_TOKEN is not set.'],
      ['DISCORD_BOT_TOKEN', '', 'DISCORD_BOT_TOKEN is not set.'],
      ['DISCORD_GUILD_ID', undefined, 'DISCORD_GUILD_ID is not a Discord guild id (17 to 20 digits).'],
      ['DISCORD_GUILD_ID', '123', 'DISCORD_GUILD_ID is not a Discord guild id (17 to 20 digits).'],
      ['DISCORD_GUILD_ID', `${GUILD}x`, 'DISCORD_GUILD_ID is not a Discord guild id (17 to 20 digits).'],
      ['LIBRARIUS_CHANNEL_ID', undefined, 'LIBRARIUS_CHANNEL_ID is not set. It is the id of the Librarius forum.'],
      ['LIBRARIUS_CHANNEL_ID', '', 'LIBRARIUS_CHANNEL_ID is not set. It is the id of the Librarius forum.'],
      ['LIBRARIUS_CHANNEL_ID', '12345', 'LIBRARIUS_CHANNEL_ID is not a Discord channel id (17 to 20 digits).'],
      ['LIBRARIUS_CHANNEL_ID', `${FORUM}/webhooks`, 'LIBRARIUS_CHANNEL_ID is not a Discord channel id (17 to 20 digits).'],
    ]
    for (const [name, value, message] of cases) {
      const err = (() => {
        try {
          setupConfig({ ...ENV, [name]: value })
        } catch (e) {
          return e
        }
        return null
      })()
      expect(err, `${name}=${value}`).toBeInstanceOf(SetupRefused)
      expect(err.message).toBe(message)
      expect(err.name).toBe('SetupRefused')
      if (value) expect(err.message).not.toContain(value)
    }
  })
})

describe('runSetup: the run', () => {
  it('makes the webhook "Librarius" on the forum as the bot and prints its address, once, to standard output', async () => {
    const r = await run()
    expect(r.code).toBe(0)
    // The address of a webhook is Discord's own, whatever API base the calls went to.
    expect(r.out).toEqual([`LIBRARIUS_WEBHOOK_URL=https://discord.com/api/webhooks/${NEW_HOOK}/${HOOK_TOKEN}`])
    // The one address is the one place the token is.
    expect(count(r.all, HOOK_TOKEN)).toBe(1)
    expect(r.err.join('\n')).not.toContain(HOOK_TOKEN)
    expect(r.all).not.toContain(BOT_TOKEN)
  })

  it('tells the owner on standard error where the line is, that it is secret, and how to get it back if it is lost', async () => {
    const r = await run()
    const said = r.err.join('\n')
    // Run as the README says (`>> .env`), the line is in server/.env already and shows nowhere: nothing is "above" to paste.
    expect(said).toContain('Its address is the one line on standard output, LIBRARIUS_WEBHOOK_URL=…')
    expect(said).toContain("with >> .env (the README's way) that line is now the last of server/.env, so check that grep -c '^LIBRARIUS_WEBHOOK_URL=' .env says 1")
    expect(said).toContain('without >> .env, the line is above: put it into server/.env on the host that runs the API')
    expect(said).not.toContain('Paste the line above')
    expect(said).toContain('Then rebuild the API.')
    expect(said).toContain('secret')
    // Lost: run it again, or copy it from Discord. Never delete the webhook for it: that strands every reply it sent.
    expect(said).toContain('run this again with --print-existing (it prints the address of the webhook that is there)')
    expect(said).toContain('Edit Channel → Integrations → Webhooks → Librarius → Copy Webhook URL')
    expect(said).toContain('Do not delete the webhook once the site has sent replies')
    expect(said).not.toContain('Delete Webhook')
  })

  it('prints an address that the webhook client takes back: the real one for the real API', async () => {
    const real = { ...ENV, DISCORD_API_BASE: 'https://discord.com/api' }
    const r = await run({ env: real })
    const line = r.out[0]
    expect(line.startsWith('LIBRARIUS_WEBHOOK_URL=')).toBe(true)
    expect(line).toBe(`LIBRARIUS_WEBHOOK_URL=https://discord.com/api/webhooks/${NEW_HOOK}/${HOOK_TOKEN}`)
    expect(parseWebhookUrl(line.slice('LIBRARIUS_WEBHOOK_URL='.length), 'https://discord.com/api')).toEqual({ id: NEW_HOOK, token: HOOK_TOKEN })
  })

  it('prints the mock address for an http API base (the e2e mock)', async () => {
    const mock = { ...ENV, DISCORD_API_BASE: 'http://discord-mock:4400' }
    const seen = []
    const base = rig()
    const fetchImpl = async (url, init) => {
      seen.push(url)
      return base.fetchImpl(url.replace('http://discord-mock:4400', API), init)
    }
    const r = await run({ env: mock, fetchImpl })
    expect(r.code).toBe(0)
    expect(r.out).toEqual([`LIBRARIUS_WEBHOOK_URL=http://discord-mock:4400/api/webhooks/${NEW_HOOK}/${HOOK_TOKEN}`])
    expect(seen[0].startsWith('http://discord-mock:4400/v10/')).toBe(true)
  })

  it('calls Discord in order, as the bot, and makes the webhook with the name and nothing else', async () => {
    const r = await run()
    expect(r.seen.map((s) => s.key)).toEqual(['GET /v10/users/@me', `GET /v10/channels/${FORUM}`, `GET /v10/channels/${FORUM}/webhooks`, `POST /v10/channels/${FORUM}/webhooks`])
    for (const s of r.seen) {
      expect(s.url.startsWith(`${API}/v10/`)).toBe(true)
      expect(s.init.headers.Authorization).toBe(`Bot ${BOT_TOKEN}`)
      expect(s.init.redirect).toBe('error')
      expect(s.init.signal).toBeInstanceOf(AbortSignal)
    }
    const post = r.seen[3].init
    expect(JSON.parse(post.body)).toEqual({ name: 'Librarius' })
    expect(post.headers['Content-Type']).toBe('application/json')
    for (const s of r.seen.slice(0, 3)) {
      expect(s.init.body).toBeUndefined()
      expect('Content-Type' in s.init.headers).toBe(false)
    }
  })

  it('the dry run calls nothing, says on standard error what it would call, and prints nothing to standard output', async () => {
    for (const argv of [['--dry-run'], ['--dry-run', '--print-existing'], ['--print-existing', '--dry-run'], ['--dry-run', '--dry-run']]) {
      const r = await run({ argv })
      expect(r.code, argv.join(' ')).toBe(0)
      expect(r.seen).toEqual([])
      expect(r.out).toEqual([])
      expect(r.err[0]).toBe('Dry run: nothing is called. These are the calls the setup would make, in order, all as the bot.')
      expect(r.err).toContain('GET /v10/users/@me')
      expect(r.err).toContain(`GET /v10/channels/${FORUM}`)
      expect(r.err).toContain(`GET /v10/channels/${FORUM}/webhooks`)
      expect(r.err).toContain(`POST /v10/channels/${FORUM}/webhooks  body: {"name":"Librarius"}  (only when no webhook named "Librarius" that this bot made is there)`)
      expect(r.err.at(-1)).toBe('Dry run: nothing was called.')
      expect(r.all).not.toContain('LIBRARIUS_WEBHOOK_URL=https')
      expect(r.all).not.toContain(BOT_TOKEN)
    }
  })

  it('the dry run says whether the address of a webhook that is there would be printed', async () => {
    const plain = await run({ argv: ['--dry-run'] })
    expect(plain.err).toContain('Then it prints LIBRARIUS_WEBHOOK_URL= and the address of the webhook it made, on standard output. Of a webhook that is there already it prints the id, and the address only with --print-existing.')
    const asked = await run({ argv: ['--dry-run', '--print-existing'] })
    expect(asked.err).toContain('Then it prints LIBRARIUS_WEBHOOK_URL= and the address of the webhook it made, or of the one that is there already, on standard output.')
  })

  it('the dry run works with no network at all', async () => {
    const r = await run({
      argv: ['--dry-run'],
      fetchImpl: () => {
        throw new Error('no network')
      },
    })
    expect(r.code).toBe(0)
  })

  it('the dry run still refuses a bad setting', async () => {
    const r = await run({ argv: ['--dry-run'], env: { ...ENV, LIBRARIUS_CHANNEL_ID: '' } })
    expect(r.code).toBe(2)
    expect(r.out).toEqual([])
  })

  it('refuses an argument it does not know, before any call', async () => {
    const unknown = [['--force'], ['--dry-run', '--force'], ['dry-run'], ['-n'], [''], ['--print-existing=1'], ['--print'], ['--Print-Existing'], ['print-existing'], ['--print-existing', 'x']]
    for (const argv of unknown) {
      const r = await run({ argv })
      expect(r.code, argv.join(' ')).toBe(2)
      expect(r.seen).toEqual([])
      expect(r.out).toEqual([])
      expect(r.err).toEqual(['Setup not run: Unknown argument. usage: bun src/librariusWebhookSetupRun.js [--dry-run] [--print-existing]'])
    }
  })

  it('refuses a bad setting with exit 2, before any call, saying which', async () => {
    const r = await run({ env: { ...ENV, DISCORD_BOT_TOKEN: '' } })
    expect(r.code).toBe(2)
    expect(r.seen).toEqual([])
    expect(r.err).toEqual(['Setup not run: DISCORD_BOT_TOKEN is not set.'])
  })
})

describe('runSetup: the checks before it makes anything', () => {
  const noPost = (r) => expect(r.seen.some((s) => s.key.startsWith('POST'))).toBe(false)

  it('refuses a channel that is not a forum, with exit 2', async () => {
    for (const type of [0, 2, 4, 5, 11, 13, 16, undefined, '15']) {
      const r = await run({ routes: { [`GET /v10/channels/${FORUM}`]: () => json(200, forum({ type })) } })
      expect(r.code, String(type)).toBe(2)
      expect(r.err).toEqual(['Setup not run: LIBRARIUS_CHANNEL_ID is not a forum channel.'])
      noPost(r)
    }
  })

  it('refuses a channel of another guild, with exit 2', async () => {
    for (const guild_id of ['200000000000000499', undefined, null, GUILD.slice(1)]) {
      const r = await run({ routes: { [`GET /v10/channels/${FORUM}`]: () => json(200, forum({ guild_id })) } })
      expect(r.code, String(guild_id)).toBe(2)
      expect(r.err).toEqual(['Setup not run: the Librarius channel is not in DISCORD_GUILD_ID.'])
      noPost(r)
    }
  })

  it('stops, with exit 1, when the bot cannot be identified', async () => {
    const bad = [() => json(401, { message: '401: Unauthorized', code: 0 }), () => json(200, { username: 'no id' }), () => json(200, { id: 'x' }), () => json(200, [BOT]), () => json(200, null), () => new Error('ECONNRESET')]
    for (const route of bad) {
      const r = await run({ routes: { 'GET /v10/users/@me': route } })
      expect(r.code).toBe(1)
      expect(r.err[0].startsWith('Setup stopped: the bot could not be identified (')).toBe(true)
      expect(r.err[0].endsWith('). Nothing was made.')).toBe(true)
      expect(r.seen).toHaveLength(1)
    }
  })

  it('stops, with exit 1, when the channel cannot be read', async () => {
    const bad = [() => json(403, { message: 'Missing Access', code: 50001 }), () => json(404, { message: 'Unknown Channel', code: 10003 }), () => json(200, null), () => json(200, [forum()]), () => new Error('ECONNRESET')]
    for (const route of bad) {
      const r = await run({ routes: { [`GET /v10/channels/${FORUM}`]: route } })
      expect(r.code).toBe(1)
      expect(r.err[0].startsWith('Setup stopped: the Librarius channel could not be read (')).toBe(true)
      noPost(r)
    }
  })

  it('stops, with exit 1, when the webhooks cannot be listed', async () => {
    const bad = [() => json(403, { message: 'Missing Permissions', code: 50013 }), () => json(200, {}), () => json(200, null), () => json(500, null), () => new Error('ECONNRESET')]
    for (const route of bad) {
      const r = await run({ routes: { [`GET /v10/channels/${FORUM}/webhooks`]: route } })
      expect(r.code).toBe(1)
      expect(r.err[0].startsWith('Setup stopped: the webhooks of the Librarius channel could not be listed (')).toBe(true)
      noPost(r)
    }
  })

  it('names the status alone when what Discord answered is not JSON', async () => {
    const r = await run({ routes: { [`GET /v10/channels/${FORUM}/webhooks`]: () => new Response('<html>bad gateway</html>', { status: 502 }) } })
    expect(r.code).toBe(1)
    expect(r.out).toEqual([])
    expect(r.err).toEqual(['Setup stopped: the webhooks of the Librarius channel could not be listed (HTTP 502). Nothing was made.'])
  })

  it('throws, and calls nothing, for an environment it cannot read at all: that is no setting of the owner\'s', async () => {
    const r = rig()
    const out = []
    await expect(runSetup({ env: null, fetchImpl: r.fetchImpl, log: (l) => out.push(l), warn: (l) => out.push(l) })).rejects.toThrow(TypeError)
    expect(r.seen).toEqual([])
    expect(out).toEqual([])
  })

  it('names what Discord said, as a status and a code, and nothing that carries a link or a token', async () => {
    const r = await run({
      routes: { [`GET /v10/channels/${FORUM}/webhooks`]: () => json(403, { message: `Missing Permissions at https://discord.com/api/webhooks/${NEW_HOOK}/${HOOK_TOKEN} for ${BOT_TOKEN}`, code: 50013 }) },
    })
    expect(r.err[0]).toBe('Setup stopped: the webhooks of the Librarius channel could not be listed (HTTP 403, code 50013: Missing Permissions at [link] for [token]). Nothing was made.')
  })

  it('names the kind of a network error and nothing it carried', async () => {
    const boom = Object.assign(new Error(`connect ECONNREFUSED ${API} ${BOT_TOKEN}`), { name: 'FetchError', code: 'ECONNREFUSED' })
    const r = await run({ routes: { 'GET /v10/users/@me': () => boom } })
    expect(r.err).toEqual(['Setup stopped: the bot could not be identified (no answer (FetchError ECONNREFUSED)). Nothing was made.'])
    const odd = await run({ routes: { 'GET /v10/users/@me': () => Object.assign(new Error('x'), { name: 'not a name!', code: { toString: () => BOT_TOKEN } }) } })
    expect(odd.err).toEqual(['Setup stopped: the bot could not be identified (no answer (Error)). Nothing was made.'])
    const hostile = {
      get name() {
        throw new Error(BOT_TOKEN)
      },
    }
    const throwing = await run({
      routes: {
        'GET /v10/users/@me': () => {
          throw hostile
        },
      },
    })
    expect(throwing.err).toEqual(['Setup stopped: the bot could not be identified (no answer (Error)). Nothing was made.'])
  })
})

describe('runSetup: a webhook of the same name, without --print-existing', () => {
  const listed = (hooks) => ({ [`GET /v10/channels/${FORUM}/webhooks`]: () => json(200, hooks) })
  const THERE = `A Librarius webhook is there (id ${OLD_HOOK}). Run again with --print-existing to print its address.`

  it('makes nothing and prints no address: it gives the id on standard error, says how to print the address, and exits 0', async () => {
    const r = await run({ routes: listed([hook()]) })
    expect(r.code).toBe(0)
    expect(r.seen.some((s) => s.key.startsWith('POST'))).toBe(false)
    expect(r.out).toEqual([])
    expect(r.err).toEqual([THERE, 'Nothing was made. Do not delete the webhook once the site has sent replies: a new webhook cannot edit or delete what this one sent.'])
    expect(r.all).not.toContain(OLD_TOKEN)
    expect(r.all).not.toContain('LIBRARIUS_WEBHOOK_URL')
    expect(r.all).not.toContain(BOT_TOKEN)
  })

  it('says the same whether or not Discord gave a usable address for it: nothing of the token is read out', async () => {
    for (const token of [undefined, null, 'short', `${OLD_TOKEN}/x`, 12345678, '']) {
      const r = await run({ routes: listed([hook({ token })]) })
      expect(r.code, JSON.stringify(token)).toBe(0)
      expect(r.out).toEqual([])
      expect(r.err[0]).toBe(THERE)
    }
  })

  it('says its id is unknown when the webhook it found has none', async () => {
    for (const id of [undefined, 'not an id', 12]) {
      const r = await run({ routes: listed([hook({ id })]) })
      expect(r.code).toBe(0)
      expect(r.out).toEqual([])
      expect(r.err[0]).toBe('A Librarius webhook is there (id unknown). Run again with --print-existing to print its address.')
      expect(r.all).not.toContain('not an id')
    }
  })

  it('finds it anywhere in the list, among other webhooks, and prints the address of none of them', async () => {
    const others = [
      hook({ id: '200000000000000472', name: 'Something else', token: 'token-of-another-hook-aaaa' }),
      hook({ id: '200000000000000473', user: { id: OTHER_PERSON }, token: 'token-of-a-stranger-bbbb' }),
      hook(),
      hook({ id: '200000000000000474', name: 'Another', token: 'token-of-another-name-cccc' }),
    ]
    const r = await run({ routes: listed(others) })
    expect(r.code).toBe(0)
    expect(r.out).toEqual([])
    expect(r.err[0]).toBe(THERE)
    expect(r.all).not.toContain('token-')
  })

  it('no token of the webhook ever reaches either output, for any token it has (property)', async () => {
    const token = fc.stringMatching(/^[A-Za-z0-9_-]{8,80}$/).map((s) => `zz${s}`)
    await fc.assert(
      fc.asyncProperty(token, async (secret) => {
        const r = await run({ routes: listed([hook({ token: secret })]) })
        expect(r.code).toBe(0)
        expect(r.out).toEqual([])
        expect(count(r.all, secret)).toBe(0)
      }),
      { numRuns: 40 },
    )
  })
})

describe('runSetup: a webhook of the same name, with --print-existing', () => {
  const listed = (hooks) => ({ [`GET /v10/channels/${FORUM}/webhooks`]: () => json(200, hooks) })
  const ask = (routes, env) => run({ argv: ['--print-existing'], routes, ...(env ? { env } : {}) })

  it('makes nothing and prints the address of the webhook that is there: exit 0, once, to standard output only', async () => {
    const r = await ask(listed([hook()]))
    expect(r.code).toBe(0)
    expect(r.seen.some((s) => s.key.startsWith('POST'))).toBe(false)
    expect(r.out).toEqual([OLD_LINE])
    expect(count(r.all, OLD_TOKEN)).toBe(1)
    expect(r.err.join('\n')).not.toContain(OLD_TOKEN)
    expect(r.all).not.toContain(BOT_TOKEN)
    expect(r.err).toHaveLength(1)
    expect(r.err[0]).toContain(`(id ${OLD_HOOK})`)
    expect(r.err[0].startsWith('A webhook named "Librarius" that this bot made is already on the Librarius forum')).toBe(true)
    expect(r.err[0]).toContain('so none was made. Its address, the address of the webhook this command made on an earlier run, is the one line on standard output, LIBRARIUS_WEBHOOK_URL=…')
    // With `--print-existing` before the `>> .env`, as the README says when .env does not have it, the line is in server/.env already.
    expect(r.err[0]).toContain("with >> .env (the README's way) that line is now the last of server/.env, so check that grep -c '^LIBRARIUS_WEBHOOK_URL=' .env says 1")
    expect(r.err[0]).toContain('without >> .env, the line is above: put it into server/.env if it is not there.')
    expect(r.err[0]).not.toContain('the line above is')
    expect(r.err[0]).not.toContain('the one the site uses')
  })

  it('takes the flag in any place, and with --dry-run calls nothing', async () => {
    const r = await run({ argv: ['--print-existing', '--print-existing'], routes: listed([hook()]) })
    expect(r.out).toEqual([OLD_LINE])
    const dry = await run({ argv: ['--print-existing', '--dry-run'], routes: listed([hook()]) })
    expect(dry.seen).toEqual([])
    expect(dry.out).toEqual([])
  })

  it('never says to delete the webhook, and says not to once the site has sent replies', async () => {
    const r = await ask(listed([hook()]))
    expect(r.err[0]).toContain('Do not delete the webhook once the site has sent replies')
    expect(r.err[0]).not.toContain('Delete Webhook')
    const bare = await ask(listed([hook({ token: undefined })]))
    expect(bare.err[0]).toContain('Do not delete the webhook once the site has sent replies')
    expect(bare.err[0]).not.toContain('Delete Webhook')
  })

  it('prints the address of the API it was told of as Discord has it, and the mock address for an http base', async () => {
    const mock = { ...ENV, DISCORD_API_BASE: 'http://discord-mock:4400/api' }
    const r = await ask(listed([hook()]), mock)
    expect(r.out).toEqual([`LIBRARIUS_WEBHOOK_URL=http://discord-mock:4400/api/webhooks/${OLD_HOOK}/${OLD_TOKEN}`])
  })

  it('says it is the same one whatever its case or the space round its name', async () => {
    for (const name of ['Librarius', 'librarius', 'LIBRARIUS', ' Librarius ', 'Librarius\n']) {
      const r = await ask(listed([hook({ name })]))
      expect(r.code, JSON.stringify(name)).toBe(0)
      expect(r.out, JSON.stringify(name)).toEqual([OLD_LINE])
      expect(r.seen.some((s) => s.key.startsWith('POST'))).toBe(false)
    }
  })

  it('knows the bot as the user that made the webhook, or as its application', async () => {
    for (const mine of [hook({ user: { id: BOT } }), hook({ user: { id: OTHER_PERSON }, application_id: BOT }), hook({ user: undefined, application_id: BOT })]) {
      const r = await ask(listed([mine]))
      expect(r.out).toEqual([OLD_LINE])
    }
  })

  it('finds it anywhere in the list, among other webhooks, and prints its address and no other', async () => {
    const others = [
      hook({ id: '200000000000000472', name: 'Something else', token: 'token-of-another-hook-aaaa' }),
      hook({ id: '200000000000000473', user: { id: OTHER_PERSON }, token: 'token-of-a-stranger-bbbb' }),
      hook(),
      hook({ id: '200000000000000474', name: 'Another', token: 'token-of-another-name-cccc' }),
    ]
    const r = await ask(listed(others))
    expect(r.code).toBe(0)
    expect(r.out).toEqual([OLD_LINE])
    expect(r.all).not.toContain('token-of-')
    expect(r.err[0]).toContain(`(id ${OLD_HOOK})`)
  })

  it('does not take for ours a webhook of that name that someone else made, nor one of ours with another name', async () => {
    const theirs = [
      hook({ user: { id: OTHER_PERSON }, application_id: null }),
      hook({ user: undefined, application_id: null }),
      hook({ user: null }),
      hook({ user: 'x' }),
      hook({ user: { id: undefined } }),
      hook({ name: 'Librarius probe' }),
      hook({ name: 'The Librarius' }),
      hook({ name: 'Librarius2' }),
      hook({ name: '' }),
      hook({ name: undefined }),
      hook({ name: 12 }),
      null,
      'x',
      [],
    ]
    for (const argv of [[], ['--print-existing']]) {
      for (const entry of theirs) {
        const r = await run({ argv, routes: listed([entry]) })
        expect(r.code, JSON.stringify(entry)).toBe(0)
        expect(r.seen.some((s) => s.key.startsWith('POST')), JSON.stringify(entry)).toBe(true)
        // It made a new one: that is the address printed, never the stranger's.
        expect(r.out, JSON.stringify(entry)).toEqual([`LIBRARIUS_WEBHOOK_URL=https://discord.com/api/webhooks/${NEW_HOOK}/${HOOK_TOKEN}`])
        expect(r.all).not.toContain(OLD_TOKEN)
      }
    }
  })

  it('does not take a webhook of this name made by someone else for the bot, even when its id matches no one', async () => {
    const r = await ask(listed([hook({ user: { id: OTHER_PERSON }, application_id: OTHER_PERSON })]))
    expect(r.code).toBe(0)
    expect(r.seen.some((s) => s.key.startsWith('POST'))).toBe(true)
  })

  it('stops, with exit 1 and nothing printed, when Discord gave no usable address for it: it says to copy it from Discord', async () => {
    const bodies = [
      hook({ token: undefined }),
      hook({ token: null }),
      hook({ token: 'short' }),
      hook({ token: `${OLD_TOKEN}/x` }),
      hook({ token: 12345678 }),
      hook({ token: '' }),
    ]
    for (const entry of bodies) {
      const r = await ask(listed([entry]))
      expect(r.code, JSON.stringify(entry)).toBe(1)
      expect(r.seen.some((s) => s.key.startsWith('POST'))).toBe(false)
      expect(r.out).toEqual([])
      expect(r.err).toHaveLength(1)
      expect(r.err[0]).toContain(`(id ${OLD_HOOK})`)
      expect(r.err[0]).toContain('Nothing was made.')
      expect(r.err[0]).toContain('Copy its address from Edit Channel → Integrations → Webhooks → Librarius → Copy Webhook URL.')
      expect(r.err[0]).toContain('Do not delete the webhook once the site has sent replies')
      expect(r.all).not.toContain(OLD_TOKEN)
    }
  })

  it('says its id is unknown when the webhook it found has none, and so cannot give its address', async () => {
    const r = await ask(listed([hook({ id: undefined })]))
    expect(r.code).toBe(1)
    expect(r.out).toEqual([])
    expect(r.err[0]).toContain('(id unknown)')
    expect(r.all).not.toContain(OLD_TOKEN)
    const odd = await ask(listed([hook({ id: 'not an id' })]))
    expect(odd.code).toBe(1)
    expect(odd.err[0]).toContain('(id unknown)')
    expect(odd.err[0]).not.toContain('not an id')
  })

  it('the address and the bot token are printed nowhere else, for any token the webhook has (property)', async () => {
    const token = fc.stringMatching(/^[A-Za-z0-9_-]{8,80}$/).map((s) => `zz${s}`)
    await fc.assert(
      fc.asyncProperty(token, async (secret) => {
        const r = await ask(listed([hook({ token: secret })]))
        expect(r.code).toBe(0)
        expect(count(r.all, secret)).toBe(1)
        expect(r.err.join('\n')).not.toContain(secret)
        expect(r.all).not.toContain(BOT_TOKEN)
        expect(r.out).toEqual([`LIBRARIUS_WEBHOOK_URL=https://discord.com/api/webhooks/${OLD_HOOK}/${secret}`])
      }),
      { numRuns: 40 },
    )
  })
})

describe('runSetup: two webhooks of the same name', () => {
  const listed = (hooks) => ({ [`GET /v10/channels/${FORUM}/webhooks`]: () => json(200, hooks) })
  const SECOND = '200000000000000475'
  const SECOND_TOKEN = 'second-webhook-token-for-the-test_5d6e7f-QRS'

  it('refuses, with exit 1: it lists their ids, prints no address and no token, and makes nothing, with the flag or without', async () => {
    for (const argv of [[], ['--print-existing']]) {
      const r = await run({ argv, routes: listed([hook(), hook({ id: SECOND, token: SECOND_TOKEN, name: 'librarius' })]) })
      expect(r.code, argv.join(' ')).toBe(1)
      expect(r.seen.some((s) => s.key.startsWith('POST'))).toBe(false)
      expect(r.out).toEqual([])
      expect(r.err).toEqual([
        `Setup not run: 2 webhooks named "Librarius" that this bot made are on the Librarius forum (ids ${OLD_HOOK}, ${SECOND}), so it cannot tell which one the site uses. ` +
          'Nothing was made and no address was printed. The site uses the one whose id is in LIBRARIUS_WEBHOOK_URL in server/.env (…/webhooks/<id>/…). ' +
          'Do not delete one that the site has sent replies through: a new webhook cannot edit or delete what it sent.',
      ])
      expect(r.all).not.toContain(OLD_TOKEN)
      expect(r.all).not.toContain(SECOND_TOKEN)
      expect(r.all).not.toContain(BOT_TOKEN)
    }
  })

  it('lists every one of them, in the order Discord gave, among webhooks that are not its own, and an id it cannot read as unknown', async () => {
    const hooks = [
      hook({ id: '200000000000000476', token: 'token-of-a-third-dddd', user: undefined, application_id: BOT }),
      hook({ id: '200000000000000477', name: 'Something else', token: 'token-of-another-hook-eeee' }),
      hook({ id: '200000000000000478', user: { id: OTHER_PERSON }, token: 'token-of-a-stranger-ffff' }),
      hook({ token: undefined }),
      hook({ id: 'not an id', token: 'token-of-a-bent-one-gggg', name: ' LIBRARIUS ' }),
    ]
    const r = await run({ argv: ['--print-existing'], routes: listed(hooks) })
    expect(r.code).toBe(1)
    expect(r.out).toEqual([])
    expect(r.err).toHaveLength(1)
    expect(r.err[0].startsWith(`Setup not run: 3 webhooks named "Librarius" that this bot made are on the Librarius forum (ids 200000000000000476, ${OLD_HOOK}, unknown), so`)).toBe(true)
    expect(r.all).not.toContain('token-')
    expect(r.all).not.toContain('not an id')
    expect(r.all).not.toContain('200000000000000477')
    expect(r.all).not.toContain('200000000000000478')
  })

  it('no token of any of them reaches either output, for any tokens they have (property)', async () => {
    const token = fc.stringMatching(/^[A-Za-z0-9_-]{8,80}$/).map((s) => `zz${s}`)
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(token, { minLength: 2, maxLength: 4 }), fc.boolean(), async (secrets, flag) => {
        const hooks = secrets.map((secret, i) => hook({ id: `20000000000000048${i}`, token: secret }))
        const r = await run({ argv: flag ? ['--print-existing'] : [], routes: listed(hooks) })
        expect(r.code).toBe(1)
        expect(r.out).toEqual([])
        for (const secret of secrets) expect(count(r.all, secret)).toBe(0)
        expect(r.err[0]).toContain(`(ids ${hooks.map((h) => h.id).join(', ')})`)
      }),
      { numRuns: 40 },
    )
  })
})

describe('runSetup: standard output', () => {
  it('carries the one address line or nothing, whatever the arguments, the webhooks there and what Discord answers (property)', async () => {
    const SECRET = 'zz-a-token-for-the-property-0123456789'
    const listing = fc.oneof(
      fc.constant([]),
      fc.constant([hook({ token: SECRET })]),
      fc.constant([hook({ token: undefined })]),
      fc.constant([hook({ token: SECRET }), hook({ id: '200000000000000479', token: SECRET })]),
      fc.constant([hook({ user: { id: OTHER_PERSON }, token: SECRET })]),
    )
    const made = fc.constantFrom(
      () => json(200, { id: NEW_HOOK, token: SECRET }),
      () => json(200, { id: NEW_HOOK }),
      () => json(403, { message: `no ${SECRET}`, code: 50013, token: SECRET }), // a refusal that carries the new webhook's token
      () => new Error('ECONNRESET'),
    )
    const argv = fc.subarray(['--dry-run', '--print-existing'])
    const step = fc.constantFrom('ok', 'me', 'channel', 'list')
    await fc.assert(
      fc.asyncProperty(argv, listing, made, step, async (args, hooks, post, broken) => {
        const routes = {
          [`GET /v10/channels/${FORUM}/webhooks`]: () => (broken === 'list' ? json(500, null) : json(200, hooks)),
          [`POST /v10/channels/${FORUM}/webhooks`]: post,
        }
        if (broken === 'me') routes['GET /v10/users/@me'] = () => json(401, { message: '401: Unauthorized', code: 0 })
        if (broken === 'channel') routes[`GET /v10/channels/${FORUM}`] = () => json(200, forum({ type: 0 }))
        const r = await run({ argv: args, routes })
        expect(r.out.length).toBeLessThanOrEqual(1)
        for (const line of r.out) expect(line).toMatch(/^LIBRARIUS_WEBHOOK_URL=https:\/\/discord\.com\/api\/webhooks\/\d{17,20}\/[\w-]+$/)
        // An address goes out only with exit 0, and never on standard error.
        if (r.out.length === 1) expect(r.code).toBe(0)
        expect(r.err.join('\n')).not.toContain(SECRET)
        expect(r.all).not.toContain(BOT_TOKEN)
      }),
      { numRuns: 120 },
    )
  })
})

describe('runSetup: when the webhook is made', () => {
  const made = (body, status = 200) => ({ [`POST /v10/channels/${FORUM}/webhooks`]: () => json(status, body) })

  it('stops, with exit 1, on a refusal, saying what Discord answered and that nothing was made', async () => {
    const r = await run({ routes: made({ message: 'Missing Permissions', code: 50013 }, 403) })
    expect(r.code).toBe(1)
    expect(r.out).toEqual([])
    expect(r.err).toEqual(['Setup stopped: the webhook could not be made (HTTP 403, code 50013: Missing Permissions).'])
  })

  it('cuts a token out of what Discord said, even the new webhook\'s own', async () => {
    const r = await run({ routes: made({ message: `bad ${HOOK_TOKEN} and ${BOT_TOKEN}`, code: 30007, token: HOOK_TOKEN }, 400) })
    expect(r.code).toBe(1)
    expect(r.all).not.toContain(HOOK_TOKEN)
    expect(r.all).not.toContain(BOT_TOKEN)
    expect(r.err).toEqual(['Setup stopped: the webhook could not be made (HTTP 400, code 30007: bad [token] and [token]).'])
  })

  it('says a webhook may exist when no answer came, because Discord may have made it', async () => {
    const r = await run({ routes: { [`POST /v10/channels/${FORUM}/webhooks`]: () => new Error(`timeout ${API}`) } })
    expect(r.code).toBe(1)
    expect(r.err).toEqual([
      'Setup stopped: the webhook could not be made (no answer (Error)).',
      'If a webhook named "Librarius" is on the Librarius forum now, run this again with --print-existing: it finds that webhook and prints its address, and makes no second one.',
    ])
  })

  it('does not say so for an answer that was a refusal, which made nothing', async () => {
    const r = await run({ routes: made({ message: 'x', code: 0 }, 429) })
    expect(r.err).toHaveLength(1)
  })

  it('stops with exit 1 when what it made has no usable id or token, naming the id and never the token', async () => {
    const bodies = [
      { id: NEW_HOOK },
      { id: NEW_HOOK, token: 'short' },
      { id: NEW_HOOK, token: `${HOOK_TOKEN}/x` },
      { id: NEW_HOOK, token: 12345678 },
      { id: 'x', token: HOOK_TOKEN },
      { token: HOOK_TOKEN },
      { id: 12, token: HOOK_TOKEN },
    ]
    for (const body of bodies) {
      const r = await run({ routes: made(body) })
      expect(r.code, JSON.stringify(body)).toBe(1)
      expect(r.out).toEqual([])
      expect(r.all).not.toContain(HOOK_TOKEN)
      expect(r.err).toHaveLength(1)
      expect(r.err[0].startsWith('Setup stopped: Discord made a webhook but gave no usable address for it.')).toBe(true)
      expect(r.err[0]).toContain('Delete it (Edit Channel → Integrations → Webhooks → Librarius → Delete Webhook: nothing has been sent through it yet) and run this again.')
      expect(r.err[0].includes(`Its id is ${NEW_HOOK}.`)).toBe(body.id === NEW_HOOK)
    }
  })

  it('stops with exit 1 when it answers 200 with something that is not a webhook', async () => {
    for (const body of [null, [], 'x', 12]) {
      const r = await run({ routes: made(body) })
      expect(r.code).toBe(1)
      expect(r.out).toEqual([])
    }
  })

  it('does not treat another 2xx as a made webhook: Discord answers 200', async () => {
    const r = await run({ routes: made({ id: NEW_HOOK, token: HOOK_TOKEN }, 201) })
    expect(r.code).toBe(1)
    expect(r.out).toEqual([])
    expect(r.all).not.toContain(HOOK_TOKEN)
  })

  it('the address and the bot token are printed nowhere else, for any token Discord might give (property)', async () => {
    const token = fc.stringMatching(/^[A-Za-z0-9_-]{8,80}$/).map((s) => `zz${s}`)
    await fc.assert(
      fc.asyncProperty(token, fc.boolean(), async (secret, fails) => {
        const routes = {
          [`POST /v10/channels/${FORUM}/webhooks`]: () => (fails ? json(400, { message: `no ${secret}`, code: 1, token: secret }) : json(200, { id: NEW_HOOK, token: secret })),
        }
        const r = await run({ routes })
        expect(count(r.all, secret)).toBe(fails ? 0 : 1)
        expect(r.all).not.toContain(BOT_TOKEN)
        if (!fails) expect(r.out).toEqual([`LIBRARIUS_WEBHOOK_URL=https://discord.com/api/webhooks/${NEW_HOOK}/${secret}`])
      }),
      { numRuns: 40 },
    )
  })
})
