import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'
import { createCommand } from './librariusCommand.js'
import { Upstream } from './discordRoles.js'

// Invented ids, all in the 400-499 range (members 300000000000000xxx). None of them is a real guild, member, message or application.
const GUILD = '200000000000000400'
const POST = '200000000000000410'
const OTHER_POST = '200000000000000411'
const MSG = '200000000000000430'
const APP = '200000000000000480'
const COMMAND = '200000000000000481'
const INTERACTION = '200000000000000490'
const TOKEN = 'aW50ZXJhY3Rpb246_Invented-token.0123456789'
const ME = '300000000000000101'
const OTHER = '300000000000000102'
const SITE = 'https://sm2salamanders.site'
const LINK = `${SITE}/reliquarium/librarius/${POST}#m-${MSG}`

const COPY_SITE = 'This was written on the site. Delete it there:'
const COPY_DISCORD = "Written in Discord: use Discord's own Delete."
const COPY_OTHER = 'Only the author can delete this, on the site.'
const COPY_FALLBACK = "Couldn't check right now; open it on the site:"

const interaction = (over = {}) => ({
  id: INTERACTION,
  application_id: APP,
  type: 2,
  token: TOKEN,
  guild_id: GUILD,
  channel_id: POST,
  member: { user: { id: ME } },
  data: { id: COMMAND, name: 'Delete on site', type: 3, target_id: MSG, resolved: { messages: { [MSG]: { id: MSG, channel_id: POST } } } },
  ...over,
})
const withData = (over) => interaction({ data: { ...interaction().data, ...over } })

const stored = (over = {}) => ({ id: MSG, postId: POST, authorId: ME, origin: 'site', ...over })

const flush = () => new Promise((resolve) => setImmediate(resolve))

/** A timer set the test runs by hand: `advance(ms)` runs what is due, as that much time passing would. */
function fakeTimers() {
  const t = { now: 0, list: [], cleared: 0 }
  t.timers = {
    setTimeout: (fn, ms) => {
      const handle = { fn, due: t.now + ms, live: true }
      t.list.push(handle)
      return handle
    },
    clearTimeout: (handle) => {
      t.cleared++
      handle.live = false
    },
  }
  t.advance = async (ms) => {
    t.now += ms
    for (const h of t.list.filter((x) => x.live && x.due <= t.now)) {
      h.live = false
      h.fn()
    }
    await flush()
  }
  t.pending = () => t.list.filter((h) => h.live).length
  return t
}

/** A command over fakes: `world` says what the store holds and what Discord does. */
function rig(over = {}) {
  const ft = fakeTimers()
  const w = { messages: new Map([[MSG, stored()]]), commands: [], callbackFails: false, listFails: false, createAnswer: true, ...over }
  const calls = { list: [], create: [], callbacks: [], options: [], stored: [] }
  const discord = {
    interactionCallback: async (id, token, body, options) => {
      calls.callbacks.push({ id, token, body: structuredClone(body) })
      calls.options.push(structuredClone(options))
      if (w.callbackFails) throw new Upstream('Discord answered 404 for an interaction reply.')
    },
    applicationCommands: async (app) => {
      calls.list.push(app)
      if (w.listFails) throw new Upstream('Discord answered 500 for the application\'s commands.')
      return structuredClone(w.commands)
    },
    createMessageCommand: async (app, name) => {
      calls.create.push([app, name])
      if (w.createFails) throw new Upstream('Discord answered 500 for a command.')
      return w.createAnswer
    },
  }
  const store = {
    outboxMessage: async (id) => {
      calls.stored.push(id)
      if (w.storeGate) return w.storeGate
      if (w.storeFails) throw new Error('the database is down')
      return w.messages.get(id) ?? null
    },
  }
  const logged = []
  const command = createCommand({ discord, store, guildId: GUILD, timers: ft.timers, log: (line) => logged.push(line), ...(w.options ?? {}) })
  return { command, calls, ft, w, logged, discord, store }
}

const content = (t, i = 0) => t.calls.callbacks[i].body.data.content

describe('createCommand: what it needs', () => {
  const parts = () => ({ discord: { applicationCommands() {}, createMessageCommand() {}, interactionCallback() {} }, store: { outboxMessage() {} }, guildId: GUILD })

  it('takes a Discord client and a store that have what it calls', () => {
    expect(() => createCommand(parts())).not.toThrow()
  })

  it('needs each function it calls', () => {
    for (const name of ['applicationCommands', 'createMessageCommand', 'interactionCallback']) {
      for (const bad of [undefined, null, 5, 'x']) {
        const p = parts()
        p.discord[name] = bad
        expect(() => createCommand(p), `${name} ${String(bad)}`).toThrow(new TypeError(`discord.${name} must be a function.`))
      }
    }
    const p = parts()
    p.store.outboxMessage = undefined
    expect(() => createCommand(p)).toThrow(new TypeError('store.outboxMessage must be a function.'))
    expect(() => createCommand({ ...parts(), discord: undefined })).toThrow(new TypeError('discord.applicationCommands must be a function.'))
    expect(() => createCommand({ ...parts(), store: null })).toThrow(new TypeError('store.outboxMessage must be a function.'))
  })

  it('needs a guild that is an id', () => {
    for (const guildId of [undefined, null, '', '123', 5, `${GUILD}1x`, ` ${GUILD}`]) {
      expect(() => createCommand({ ...parts(), guildId }), String(guildId)).toThrow(new TypeError('guildId must be a Discord id.'))
    }
  })

  it('needs a deadline of whole milliseconds from 1 to 1900, which leaves the second the callback may take inside the three seconds Discord gives', () => {
    for (const deadlineMs of [0, -1, 1.5, Number.NaN, Infinity, '1500', null, 1901, 2900]) {
      expect(() => createCommand({ ...parts(), deadlineMs }), String(deadlineMs)).toThrow(new RangeError('deadlineMs must be a whole number of milliseconds from 1 to 1900.'))
    }
    expect(() => createCommand({ ...parts(), deadlineMs: 1 })).not.toThrow()
    expect(() => createCommand({ ...parts(), deadlineMs: 1900 })).not.toThrow()
  })

  it('needs a site that is an https address', () => {
    expect(() => createCommand({ ...parts(), siteUrl: 'http://site.test' })).toThrow(RangeError)
    expect(() => createCommand({ ...parts(), siteUrl: 'https://site.test/' })).not.toThrow()
  })

  it('needs a log that is a function', () => {
    for (const log of [null, 5, 'x']) expect(() => createCommand({ ...parts(), log }), String(log)).toThrow(new TypeError('log must be a function.'))
  })
})

describe('READY: the command is made when it is not there', () => {
  const ready = (t, d = { application: { id: APP }, user: { id: '300000000000000001' } }) => t.command.dispatch('READY', d)

  it('makes it once when the guild has none of that name, as a message command', async () => {
    const t = rig()
    await ready(t)
    expect(t.calls.list).toStrictEqual([APP])
    expect(t.calls.create).toStrictEqual([[APP, 'Delete on site']])
  })

  it('makes none when it is there', async () => {
    const t = rig({ commands: [{ id: COMMAND, application_id: APP, name: 'Delete on site', type: 3 }] })
    await ready(t)
    expect(t.calls.list).toStrictEqual([APP])
    expect(t.calls.create).toStrictEqual([])
  })

  it('makes it when the guild has other commands, and when one of that name is of another type, and touches the others not at all', async () => {
    const t = rig({
      commands: [
        { id: '200000000000000482', name: 'Something else', type: 3 },
        { id: '200000000000000483', name: 'Delete on site', type: 1 },
        { id: '200000000000000484', name: 'Delete on site', type: 2 },
        { id: '200000000000000485', name: 'delete on site', type: 3 },
        { id: '200000000000000486', name: 'Delete on site ', type: 3 },
        { id: '200000000000000487', type: 3 },
        null,
      ],
    })
    await ready(t)
    expect(t.calls.create).toStrictEqual([[APP, 'Delete on site']])
  })

  it('asks again at the next READY, and makes it only if it is still not there', async () => {
    const t = rig()
    await ready(t)
    t.w.commands = [{ id: COMMAND, name: 'Delete on site', type: 3 }]
    await ready(t)
    expect(t.calls.list).toStrictEqual([APP, APP])
    expect(t.calls.create).toHaveLength(1)
  })

  it('keeps going, and says it once, when Discord refuses the bot the right to make commands', async () => {
    const t = rig({ createAnswer: false })
    await expect(ready(t)).resolves.toBeUndefined()
    await ready(t)
    await ready(t)
    expect(t.calls.create).toHaveLength(3)
    // It is for the owner to read, once; the brief asks that it is not repeated at every READY.
    expect(t.logged).toHaveLength(1)
    expect(t.logged[0]).not.toContain(APP)
  })

  it('never rejects, whatever Discord does, and tells of it', async () => {
    const down = rig({ listFails: true })
    await expect(ready(down)).resolves.toBeUndefined()
    expect(down.calls.create).toStrictEqual([])
    expect(down.logged).toHaveLength(1)
    const noCreate = rig({ createFails: true })
    await expect(ready(noCreate)).resolves.toBeUndefined()
  })

  it('never rejects for a log that throws', async () => {
    const t = rig({ listFails: true, options: { log: () => { throw new Error('the log is broken') } } })
    await expect(ready(t)).resolves.toBeUndefined()
  })

  it('asks Discord nothing when READY carries no application id, or one that is no id', async () => {
    for (const d of [{}, undefined, null, 'x', 5, [], { application: null }, { application: {} }, { application: { id: 5 } }, { application: { id: '123' } }, { application: [APP] }, { application: { id: `${APP}1x` } }]) {
      const t = rig()
      await expect(t.command.dispatch('READY', d), JSON.stringify(d)).resolves.toBeUndefined()
      expect(t.calls.list, JSON.stringify(d)).toStrictEqual([])
      expect(t.calls.create, JSON.stringify(d)).toStrictEqual([])
    }
  })

  it('never lists or creates for any other event', async () => {
    const t = rig()
    for (const type of ['RESUMED', 'MESSAGE_CREATE', 'GUILD_CREATE', 'ready', 'READY ', '', undefined, null, 5, {}]) {
      await t.command.dispatch(type, { application: { id: APP } })
    }
    expect(t.calls.list).toStrictEqual([])
  })

  it('answers no interaction that comes under another event, whatever it holds', async () => {
    const t = rig()
    for (const type of ['READY ', 'MESSAGE_CREATE', 'INTERACTION_UPDATE', 'interaction_create', '', undefined, null, 5, {}]) {
      await t.command.dispatch(type, interaction())
    }
    expect(t.calls.callbacks).toStrictEqual([])
    expect(t.calls.stored).toStrictEqual([])
  })

  it('never overwrites the list: it only lists and creates one', async () => {
    const t = rig()
    await ready(t)
    expect(Object.keys(t.discord).sort()).toStrictEqual(['applicationCommands', 'createMessageCommand', 'interactionCallback'])
  })
})

describe('INTERACTION_CREATE: the three answers', () => {
  it('sends the author of a message written on the site to the site, with the link to that message', async () => {
    const t = rig()
    await t.command.dispatch('INTERACTION_CREATE', interaction())
    expect(t.calls.callbacks).toStrictEqual([
      { id: INTERACTION, token: TOKEN, body: { type: 4, data: { content: `${COPY_SITE} ${LINK}`, flags: 64, allowed_mentions: { parse: [] } } } },
    ])
    expect(t.calls.stored).toStrictEqual([MSG])
  })

  it('tells anyone who asks about a message written in Discord to use Discord\'s own Delete, its author and others alike', async () => {
    for (const authorId of [ME, OTHER]) {
      const t = rig({ messages: new Map([[MSG, stored({ origin: 'discord', authorId })]]) })
      await t.command.dispatch('INTERACTION_CREATE', interaction())
      expect(content(t), authorId).toBe(COPY_DISCORD)
    }
  })

  it('tells anyone but the author of a message of the site that only the author can delete it', async () => {
    const t = rig({ messages: new Map([[MSG, stored({ authorId: OTHER })]]) })
    await t.command.dispatch('INTERACTION_CREATE', interaction())
    expect(content(t)).toBe(COPY_OTHER)
  })

  it('tells them the same for a message the Librarius does not hold, a message of another channel', async () => {
    const t = rig({ messages: new Map() })
    await t.command.dispatch('INTERACTION_CREATE', interaction())
    expect(content(t)).toBe(COPY_OTHER)
  })

  it('tells the same to someone whose interaction names no member, who is no author of anything', async () => {
    const t = rig()
    for (const member of [undefined, null, {}, { user: null }, { user: {} }, { user: { id: 5 } }, 'x']) {
      await t.command.dispatch('INTERACTION_CREATE', interaction({ member }))
    }
    expect(t.calls.callbacks.map((c) => c.body.data.content)).toStrictEqual(Array(7).fill(COPY_OTHER))
  })

  it('does not take a message of the site that has no author for one that is the member\'s', async () => {
    const t = rig({ messages: new Map([[MSG, stored({ authorId: undefined })]]) })
    await t.command.dispatch('INTERACTION_CREATE', interaction({ member: { user: {} } }))
    expect(content(t)).toBe(COPY_OTHER)
  })

  it('tells the same for a message that is neither of the site nor of Discord', async () => {
    for (const origin of [undefined, null, '', 'SITE', 'webhook', 5]) {
      const t = rig({ messages: new Map([[MSG, stored({ origin })]]) })
      await t.command.dispatch('INTERACTION_CREATE', interaction())
      expect(content(t), String(origin)).toBe(COPY_OTHER)
    }
  })

  it('takes the link from the post the store has the message in, not from what the interaction says', async () => {
    const t = rig({ messages: new Map([[MSG, stored({ postId: OTHER_POST })]]) })
    await t.command.dispatch('INTERACTION_CREATE', interaction())
    expect(content(t)).toBe(`${COPY_SITE} ${SITE}/reliquarium/librarius/${OTHER_POST}#m-${MSG}`)
  })

  it('takes the site it was given, without its trailing slash', async () => {
    const t = rig({ options: { siteUrl: 'https://other.example//' } })
    await t.command.dispatch('INTERACTION_CREATE', interaction())
    expect(content(t)).toBe(`${COPY_SITE} https://other.example/reliquarium/librarius/${POST}#m-${MSG}`)
  })

  it('always answers privately, with no mention that can ping, whatever it says', async () => {
    const cases = [
      rig(),
      rig({ messages: new Map([[MSG, stored({ origin: 'discord' })]]) }),
      rig({ messages: new Map([[MSG, stored({ authorId: OTHER })]]) }),
      rig({ messages: new Map() }),
      rig({ storeFails: true }),
    ]
    for (const t of cases) {
      await t.command.dispatch('INTERACTION_CREATE', interaction())
      const [{ body }] = t.calls.callbacks
      expect(body.type).toBe(4)
      expect(body.data.flags).toBe(64)
      expect(body.data.allowed_mentions).toStrictEqual({ parse: [] })
      expect(Object.keys(body).sort()).toStrictEqual(['data', 'type'])
      expect(Object.keys(body.data).sort()).toStrictEqual(['allowed_mentions', 'content', 'flags'])
    }
  })

  it('answers with a callback that has a second of its own to be taken in, and waits for no turn among the other calls, since the three seconds are short', async () => {
    const t = rig()
    await t.command.dispatch('INTERACTION_CREATE', interaction())
    expect(t.calls.options).toStrictEqual([{ timeoutMs: 1000 }])
  })

  it('answers each interaction apart, when several come together', async () => {
    const t = rig({ messages: new Map([[MSG, stored()], ['200000000000000431', stored({ id: '200000000000000431', origin: 'discord' })]]) })
    await Promise.all([
      t.command.dispatch('INTERACTION_CREATE', interaction()),
      t.command.dispatch('INTERACTION_CREATE', interaction({ id: '200000000000000491', token: 'second-token', data: { ...interaction().data, target_id: '200000000000000431', resolved: undefined } })),
    ])
    const byId = Object.fromEntries(t.calls.callbacks.map((c) => [c.id, c]))
    expect(byId[INTERACTION].body.data.content).toBe(`${COPY_SITE} ${LINK}`)
    expect(byId['200000000000000491'].token).toBe('second-token')
    expect(byId['200000000000000491'].body.data.content).toBe(COPY_DISCORD)
  })
})

describe('INTERACTION_CREATE: what is not its own', () => {
  it('answers nothing, and asks the store nothing, for an interaction that is not this command in this guild', async () => {
    const t = rig()
    const not = [
      interaction({ type: 1 }),
      interaction({ type: 3 }),
      interaction({ type: 4 }),
      interaction({ type: 5 }),
      interaction({ type: '2' }),
      interaction({ type: undefined }),
      interaction({ guild_id: '200000000000000499' }),
      interaction({ guild_id: undefined }),
      interaction({ guild_id: null }),
      interaction({ data: undefined }),
      interaction({ data: null }),
      interaction({ data: [] }),
      interaction({ data: 'x' }),
      withData({ name: 'delete on site' }),
      withData({ name: 'Delete on site ' }),
      withData({ name: 'Other' }),
      withData({ name: undefined }),
      withData({ type: 1 }),
      withData({ type: 2 }),
      withData({ type: '3' }),
      withData({ type: undefined }),
    ]
    for (const d of not) await t.command.dispatch('INTERACTION_CREATE', d)
    expect(t.calls.callbacks).toStrictEqual([])
    expect(t.calls.stored).toStrictEqual([])
  })

  it('answers nothing for an interaction it has no id or token to answer, and asks the store nothing', async () => {
    const t = rig()
    for (const over of [{ id: undefined }, { id: '123' }, { id: 5 }, { id: null }, { token: undefined }, { token: 5 }, { token: null }, { token: '' }]) {
      await t.command.dispatch('INTERACTION_CREATE', interaction(over))
    }
    expect(t.calls.callbacks).toStrictEqual([])
    expect(t.calls.stored).toStrictEqual([])
  })

  it('answers that only the author can delete it, without asking the store, when the target is no message id', async () => {
    const t = rig()
    for (const target_id of [undefined, null, 5, '', 'abc', '123', '99999999999999999999', `${MSG}x`]) {
      await t.command.dispatch('INTERACTION_CREATE', withData({ target_id, resolved: undefined }))
    }
    expect(t.calls.callbacks.map((c) => c.body.data.content)).toStrictEqual(Array(8).fill(COPY_OTHER))
    expect(t.calls.stored).toStrictEqual([])
  })

  it('puts a target that is no message id into no link, whatever the store does: it is told the plain answer, with no link and no id in it', async () => {
    const hostile = ['1/../x', `${MSG}#m-1`, `${MSG}\n`, '../../x', 'javascript:alert(1)', `${MSG}/${MSG}`, '200000000000000430?x=1', `<@${ME}>`, '1'.repeat(17) + 'x']
    for (const options of [{ storeFails: true }, { storeGate: new Promise(() => {}) }]) {
      for (const target_id of hostile) {
        const t = rig(options)
        await t.command.dispatch('INTERACTION_CREATE', withData({ target_id, resolved: { messages: { [target_id]: { id: target_id, channel_id: OTHER_POST } } } }))
        expect(content(t), target_id).toBe(COPY_OTHER)
        expect(t.calls.stored, target_id).toStrictEqual([])
        expect(t.calls.callbacks, target_id).toHaveLength(1)
        expect(t.ft.pending(), target_id).toBe(0)
      }
    }
  })

  it('does nothing for data that is no object at all, and never throws', async () => {
    const t = rig()
    for (const d of [undefined, null, 'x', 5, [], true]) await expect(t.command.dispatch('INTERACTION_CREATE', d)).resolves.toBeUndefined()
    expect(t.calls.callbacks).toStrictEqual([])
  })
})

describe('INTERACTION_CREATE: the three seconds', () => {
  it('answers with what it could not check and the link when the store has not answered by the deadline, and not before', async () => {
    const never = new Promise(() => {})
    const t = rig({ storeGate: never })
    const done = t.command.dispatch('INTERACTION_CREATE', interaction())
    await flush()
    await t.ft.advance(1_499)
    expect(t.calls.callbacks).toStrictEqual([])
    await t.ft.advance(1)
    await done
    expect(t.calls.callbacks).toStrictEqual([
      { id: INTERACTION, token: TOKEN, body: { type: 4, data: { content: `${COPY_FALLBACK} ${LINK}`, flags: 64, allowed_mentions: { parse: [] } } } },
    ])
  })

  it('takes the deadline it was given', async () => {
    const t = rig({ storeGate: new Promise(() => {}), options: { deadlineMs: 500 } })
    const done = t.command.dispatch('INTERACTION_CREATE', interaction())
    await flush()
    await t.ft.advance(499)
    expect(t.calls.callbacks).toHaveLength(0)
    await t.ft.advance(1)
    await done
    expect(t.calls.callbacks).toHaveLength(1)
  })

  it('answers once, with what it has found, when the store answers just before the deadline, and sets no answer after it', async () => {
    let release
    const t = rig({ storeGate: new Promise((resolve) => (release = resolve)) })
    const done = t.command.dispatch('INTERACTION_CREATE', interaction())
    await flush()
    await t.ft.advance(1_499)
    release(stored({ origin: 'discord' }))
    await done
    expect(t.calls.callbacks.map((c) => c.body.data.content)).toStrictEqual([COPY_DISCORD])
    expect(t.ft.pending()).toBe(0)
    await t.ft.advance(10_000)
    expect(t.calls.callbacks).toHaveLength(1)
  })

  it('answers once, with the fallback, when the store answers only after the deadline', async () => {
    let release
    const t = rig({ storeGate: new Promise((resolve) => (release = resolve)) })
    const done = t.command.dispatch('INTERACTION_CREATE', interaction())
    await flush()
    await t.ft.advance(1_500)
    await done
    release(stored())
    await flush()
    expect(t.calls.callbacks.map((c) => c.body.data.content)).toStrictEqual([`${COPY_FALLBACK} ${LINK}`])
  })

  it('answers the fallback at once, not at the deadline, when the store fails, and answers once', async () => {
    const t = rig({ storeFails: true })
    await t.command.dispatch('INTERACTION_CREATE', interaction())
    expect(t.calls.callbacks.map((c) => c.body.data.content)).toStrictEqual([`${COPY_FALLBACK} ${LINK}`])
    expect(t.ft.pending()).toBe(0)
    await t.ft.advance(10_000)
    expect(t.calls.callbacks).toHaveLength(1)
  })

  it('answers the fallback at once, with a link to the site, for a store that throws before it answers', async () => {
    const t = rig()
    const own = createCommand({ discord: t.discord, store: { outboxMessage: () => { throw new Error('sync failure') } }, guildId: GUILD, timers: t.ft.timers, log: () => {} })
    await own.dispatch('INTERACTION_CREATE', interaction())
    expect(t.calls.callbacks.map((c) => c.body.data.content)).toStrictEqual([`${COPY_FALLBACK} ${LINK}`])
  })

  it('links the fallback to the message of the interaction, in the channel it names, else the post of the interaction, else the list', async () => {
    const cases = [
      [interaction(), `${SITE}/reliquarium/librarius/${POST}#m-${MSG}`],
      [withData({ resolved: { messages: { [MSG]: { id: MSG, channel_id: OTHER_POST } } } }), `${SITE}/reliquarium/librarius/${OTHER_POST}#m-${MSG}`],
      [withData({ resolved: undefined }), `${SITE}/reliquarium/librarius/${POST}#m-${MSG}`],
      [withData({ resolved: { messages: {} } }), `${SITE}/reliquarium/librarius/${POST}#m-${MSG}`],
      [withData({ resolved: { messages: { [MSG]: { id: MSG, channel_id: 5 } } } }), `${SITE}/reliquarium/librarius/${POST}#m-${MSG}`],
      [withData({ resolved: { messages: { [MSG]: null } } }), `${SITE}/reliquarium/librarius/${POST}#m-${MSG}`],
      [withData({ resolved: { messages: null } }), `${SITE}/reliquarium/librarius/${POST}#m-${MSG}`],
      [withData({ resolved: 'x' }), `${SITE}/reliquarium/librarius/${POST}#m-${MSG}`],
      [{ ...withData({ resolved: undefined }), channel_id: undefined }, `${SITE}/reliquarium/librarius`],
      [{ ...withData({ resolved: undefined }), channel_id: 'x' }, `${SITE}/reliquarium/librarius`],
      [{ ...withData({ resolved: undefined, target_id: 'abc' }) }, null],
    ]
    for (const [d, link] of cases) {
      const t = rig({ storeFails: true })
      await t.command.dispatch('INTERACTION_CREATE', d)
      if (link === null) expect(content(t)).toBe(COPY_OTHER)
      else expect(content(t), JSON.stringify(d.data.resolved)).toBe(`${COPY_FALLBACK} ${link}`)
    }
  })

  it('uses the timers of the runtime when it is given none', async () => {
    vi.useFakeTimers()
    try {
      const t = rig({ storeGate: new Promise(() => {}), options: { timers: undefined } })
      const done = t.command.dispatch('INTERACTION_CREATE', interaction())
      await vi.advanceTimersByTimeAsync(1_499)
      expect(t.calls.callbacks).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      await done
      expect(t.calls.callbacks).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('INTERACTION_CREATE: when the answer cannot be given', () => {
  it('never rejects when Discord refuses the callback, and does not answer twice', async () => {
    const t = rig({ callbackFails: true })
    await expect(t.command.dispatch('INTERACTION_CREATE', interaction())).resolves.toBeUndefined()
    expect(t.calls.callbacks).toHaveLength(1)
    expect(t.logged.join('\n')).not.toContain(TOKEN)
  })

  it('never rejects for a callback that throws what is no error, or for a log that throws', async () => {
    const t = rig({ options: { log: () => { throw new Error('the log is broken') } }, callbackFails: true })
    await expect(t.command.dispatch('INTERACTION_CREATE', interaction())).resolves.toBeUndefined()
    const odd = rig()
    odd.discord.interactionCallback = () => Promise.reject(null)
    const own = createCommand({ discord: odd.discord, store: odd.store, guildId: GUILD, timers: odd.ft.timers, log: () => {} })
    await expect(own.dispatch('INTERACTION_CREATE', interaction())).resolves.toBeUndefined()
  })

  it('never leaves the token in what it logs, whatever Discord said', async () => {
    const t = rig()
    t.discord.interactionCallback = async () => {
      throw new Error(`https://discord.com/api/v10/interactions/${INTERACTION}/${TOKEN}/callback failed with ${TOKEN}`)
    }
    const logged = []
    const own = createCommand({ discord: t.discord, store: t.store, guildId: GUILD, timers: t.ft.timers, log: (line) => logged.push(line) })
    await own.dispatch('INTERACTION_CREATE', interaction())
    expect(logged.length).toBeGreaterThan(0)
    for (const line of logged) expect(line).not.toContain(TOKEN)
  })

  it('never rejects for an event of any kind or any shape (property)', async () => {
    const t = rig()
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('READY', 'INTERACTION_CREATE', 'OTHER', undefined), fc.anything(), async (type, d) => {
        await expect(t.command.dispatch(type, d)).resolves.toBeUndefined()
      }),
      { numRuns: 200 },
    )
  })

  it('never rejects for an interaction that is nearly this one, whatever else is wrong with it (property)', async () => {
    const t = rig()
    const odd = fc.anything()
    await fc.assert(
      fc.asyncProperty(odd, odd, odd, odd, async (member, data, token, id) => {
        const base = interaction()
        const d = fc.sample(fc.boolean(), 1)[0] ? { ...base, member, token, id } : { ...base, data: { ...base.data, ...(typeof data === 'object' && data !== null ? data : {}) }, member }
        await expect(t.command.dispatch('INTERACTION_CREATE', d)).resolves.toBeUndefined()
      }),
      { numRuns: 150 },
    )
  })
})
