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
const COPY_OFF = 'Deleting from the site is switched off right now. A moderator can delete this in Discord.'

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
  const command = createCommand({ discord, store, guildId: GUILD, repliesOn: () => true, timers: ft.timers, now: () => ft.now, log: (line) => logged.push(line), ...(w.options ?? {}) })
  return { command, calls, ft, w, logged, discord, store }
}

const content = (t, i = 0) => t.calls.callbacks[i].body.data.content

describe('createCommand: what it needs', () => {
  const parts = () => ({ discord: { applicationCommands() {}, createMessageCommand() {}, interactionCallback() {} }, store: { outboxMessage() {} }, guildId: GUILD, repliesOn: () => true })

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

  it('needs a way to ask whether the replies are on, a function and nothing that only looks like one', () => {
    for (const repliesOn of [undefined, null, 0, 1, '', 'true', true, false, [], {}]) {
      expect(() => createCommand({ ...parts(), repliesOn }), String(repliesOn)).toThrow(new TypeError('repliesOn must be a function.'))
    }
    expect(() => createCommand({ ...parts(), repliesOn: () => false })).not.toThrow()
  })

  it('asks it once at the start, and needs true or false of it then, nothing that only looks like it', () => {
    for (const answer of [undefined, null, 0, 1, '', 'true', 'false', [], {}]) {
      expect(() => createCommand({ ...parts(), repliesOn: () => answer }), String(answer)).toThrow(new TypeError('repliesOn must answer true or false.'))
    }
    expect(() => createCommand({ ...parts(), repliesOn: () => { throw new Error('no outbox to ask') } })).toThrow('no outbox to ask')
  })

  it('needs a clock that is a function, and takes the runtime\'s when it is given none', () => {
    for (const now of [null, 5, 'x', {}]) expect(() => createCommand({ ...parts(), now }), String(now)).toThrow(new TypeError('now must be a function.'))
    expect(() => createCommand({ ...parts(), now: undefined })).not.toThrow()
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

  it('answers with a callback that has what is left of the three seconds to be taken in, and waits for no turn among the other calls, since the three seconds are short', async () => {
    const t = rig()
    await t.command.dispatch('INTERACTION_CREATE', interaction())
    expect(t.calls.options).toStrictEqual([{ timeoutMs: 2800 }])
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

describe('with the replies off (Ruling B12): it is made nowhere, and still answers', () => {
  const off = (over = {}) => rig({ ...over, options: { repliesOn: () => false, ...(over.options ?? {}) } })

  it('makes no command at READY and asks Discord nothing, even when the guild has none', async () => {
    const t = off()
    for (let i = 0; i < 3; i++) await expect(t.command.dispatch('READY', { application: { id: APP } })).resolves.toBeUndefined()
    expect(t.calls.list).toStrictEqual([])
    expect(t.calls.create).toStrictEqual([])
  })

  it('still answers the command that was made while they were on: a message written in Discord is for Discord\'s own Delete, whoever asks', async () => {
    for (const authorId of [ME, OTHER]) {
      const t = off({ messages: new Map([[MSG, stored({ origin: 'discord', authorId })]]) })
      await t.command.dispatch('INTERACTION_CREATE', interaction())
      expect(t.calls.callbacks, authorId).toStrictEqual([
        { id: INTERACTION, token: TOKEN, body: { type: 4, data: { content: COPY_DISCORD, flags: 64, allowed_mentions: { parse: [] } } } },
      ])
    }
  })

  it('tells whoever asks about a reply of the site, its author too, that deleting from the site is off and a moderator can delete it in Discord, with no link', async () => {
    for (const [authorId, member] of [[ME, { user: { id: ME } }], [OTHER, { user: { id: ME } }], [undefined, { user: { id: ME } }], [ME, undefined]]) {
      const t = off({ messages: new Map([[MSG, stored({ authorId })]]) })
      await t.command.dispatch('INTERACTION_CREATE', interaction({ member }))
      expect(content(t), String(authorId)).toBe(COPY_OFF)
      expect(t.calls.stored).toStrictEqual([MSG])
    }
  })

  it('answers the rest as when they are on: a message it does not hold, one of no known origin, and a target that is no message id', async () => {
    const unknown = off({ messages: new Map() })
    await unknown.command.dispatch('INTERACTION_CREATE', interaction())
    expect(content(unknown)).toBe(COPY_OTHER)
    for (const origin of [undefined, null, '', 'SITE', 'webhook', 5]) {
      const t = off({ messages: new Map([[MSG, stored({ origin })]]) })
      await t.command.dispatch('INTERACTION_CREATE', interaction())
      expect(content(t), String(origin)).toBe(COPY_OTHER)
    }
    const noId = off()
    await noId.command.dispatch('INTERACTION_CREATE', withData({ target_id: '../x', resolved: undefined }))
    expect(content(noId)).toBe(COPY_OTHER)
    expect(noId.calls.stored).toStrictEqual([])
  })

  it('answers within the deadline: what it could not check and the link at the deadline, at once when the store fails, and the callback has what is left', async () => {
    const slow = off({ storeGate: new Promise(() => {}) })
    const done = slow.command.dispatch('INTERACTION_CREATE', interaction())
    await flush()
    await slow.ft.advance(1_499)
    expect(slow.calls.callbacks).toStrictEqual([])
    await slow.ft.advance(1)
    await done
    expect(content(slow)).toBe(`${COPY_FALLBACK} ${LINK}`)
    expect(slow.calls.options).toStrictEqual([{ timeoutMs: 1300 }])
    const down = off({ storeFails: true })
    await down.command.dispatch('INTERACTION_CREATE', interaction())
    expect(content(down)).toBe(`${COPY_FALLBACK} ${LINK}`)
    expect(down.calls.options).toStrictEqual([{ timeoutMs: 2800 }])
    expect(down.ft.pending()).toBe(0)
  })

  it('answers only this command in this guild, as when they are on', async () => {
    const t = off()
    for (const d of [interaction({ guild_id: '200000000000000499' }), withData({ name: 'Other' }), interaction({ type: 3 }), interaction({ token: '' })]) {
      await t.command.dispatch('INTERACTION_CREATE', d)
    }
    expect(t.calls.callbacks).toStrictEqual([])
    expect(t.calls.stored).toStrictEqual([])
  })

  it('differs from the replies being on only for a reply of the site (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('site', 'discord', 'webhook', undefined),
        fc.constantFrom(ME, OTHER, undefined),
        fc.constantFrom(ME, OTHER),
        fc.boolean(),
        async (origin, authorId, asker, held) => {
          const world = () => ({ messages: held ? new Map([[MSG, stored({ origin, authorId })]]) : new Map() })
          const on = rig(world())
          const offNow = off(world())
          await on.command.dispatch('INTERACTION_CREATE', interaction({ member: { user: { id: asker } } }))
          await offNow.command.dispatch('INTERACTION_CREATE', interaction({ member: { user: { id: asker } } }))
          const isSite = held && origin === 'site'
          expect(content(offNow)).toBe(isSite ? COPY_OFF : content(on))
          expect(content(on)).toBe(!held ? COPY_OTHER : origin === 'discord' ? COPY_DISCORD : isSite && authorId === asker ? `${COPY_SITE} ${LINK}` : COPY_OTHER)
          expect(offNow.calls.callbacks[0].body.data.flags).toBe(64)
          expect(offNow.calls.callbacks[0].body.data.allowed_mentions).toStrictEqual({ parse: [] })
        },
      ),
      { numRuns: 80 },
    )
  })
})

describe('whether the replies are on is read when the answer is made, not only at the start (rB11 M2)', () => {
  /** A command that is told `flag.on`, which is `start` when it is made and whatever the test sets after that. */
  const live = (over = {}, start = true) => {
    const flag = { on: start }
    const t = rig({ ...over, options: { repliesOn: () => flag.on, ...(over.options ?? {}) } })
    return { ...t, flag }
  }

  it('tells the author of a reply of the site that deleting from the site is off once Discord has refused the webhook, though it was on at the start', async () => {
    const t = live()
    await t.command.dispatch('INTERACTION_CREATE', interaction())
    t.flag.on = false
    await t.command.dispatch('INTERACTION_CREATE', interaction())
    expect([content(t, 0), content(t, 1)]).toStrictEqual([`${COPY_SITE} ${LINK}`, COPY_OFF])
    expect(t.calls.callbacks[1].body).toStrictEqual({ type: 4, data: { content: COPY_OFF, flags: 64, allowed_mentions: { parse: [] } } })
  })

  it('answers a message of Discord\'s, one it does not hold and one of no known origin as before once they have gone off, and anyone\'s reply of the site as off', async () => {
    const cases = [
      [stored({ origin: 'discord' }), COPY_DISCORD],
      [null, COPY_OTHER],
      [stored({ origin: 'webhook' }), COPY_OTHER],
      [stored({ authorId: OTHER }), COPY_OFF],
    ]
    for (const [held, expected] of cases) {
      const t = live({ messages: held === null ? new Map() : new Map([[MSG, held]]) })
      t.flag.on = false
      await t.command.dispatch('INTERACTION_CREATE', interaction())
      expect(content(t), JSON.stringify(held)).toBe(expected)
    }
  })

  it('reads it after the store has answered: replies that go off while the message is looked up are off in the answer', async () => {
    let answer
    const t = live({ storeGate: new Promise((resolve) => (answer = resolve)) })
    const done = t.command.dispatch('INTERACTION_CREATE', interaction())
    await flush()
    t.flag.on = false
    answer(stored())
    await done
    expect(content(t)).toBe(COPY_OFF)
  })

  it('reads it at every answer, and sends the author to the site again when they are back on', async () => {
    const t = live()
    for (const on of [false, true, false, true]) {
      t.flag.on = on
      await t.command.dispatch('INTERACTION_CREATE', interaction())
    }
    expect(t.calls.callbacks.map((c) => c.body.data.content)).toStrictEqual([COPY_OFF, `${COPY_SITE} ${LINK}`, COPY_OFF, `${COPY_SITE} ${LINK}`])
    const offAtStart = live({}, false)
    offAtStart.flag.on = true
    await offAtStart.command.dispatch('INTERACTION_CREATE', interaction())
    expect(content(offAtStart)).toBe(`${COPY_SITE} ${LINK}`)
  })

  it('takes anything but true when the answer is made, and a reading that throws, as off, and still answers', async () => {
    for (const later of [false, undefined, null, 1, 'true', {}, () => true]) {
      const t = live()
      t.flag.on = later
      await expect(t.command.dispatch('INTERACTION_CREATE', interaction())).resolves.toBeUndefined()
      expect(content(t), String(later)).toBe(COPY_OFF)
    }
    const reading = { on: true }
    const throwing = rig({
      options: {
        repliesOn: () => {
          if (reading.on) return true
          throw new Error('the outbox cannot be asked')
        },
      },
    })
    reading.on = false
    await expect(throwing.command.dispatch('INTERACTION_CREATE', interaction())).resolves.toBeUndefined()
    expect(throwing.calls.callbacks.map((c) => c.body.data.content)).toStrictEqual([COPY_OFF])
  })

  it('makes the command at READY by what it was told at the start, whatever it is told later', async () => {
    const wasOn = live()
    wasOn.flag.on = false
    await wasOn.command.dispatch('READY', { application: { id: APP } })
    expect(wasOn.calls.list).toStrictEqual([APP])
    expect(wasOn.calls.create).toStrictEqual([[APP, 'Delete on site']])
    const wasOff = live({}, false)
    wasOff.flag.on = true
    await wasOff.command.dispatch('READY', { application: { id: APP } })
    expect(wasOff.calls.list).toStrictEqual([])
    expect(wasOff.calls.create).toStrictEqual([])
  })

  it('answers with them off at the start just as with them refused later (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('site', 'discord', 'webhook', undefined),
        fc.constantFrom(ME, OTHER, undefined),
        fc.constantFrom(ME, OTHER),
        fc.boolean(),
        async (origin, authorId, asker, held) => {
          const world = () => ({ messages: held ? new Map([[MSG, stored({ origin, authorId })]]) : new Map() })
          const offAtStart = rig({ ...world(), options: { repliesOn: () => false } })
          const refused = live(world())
          refused.flag.on = false
          const ask = interaction({ member: { user: { id: asker } } })
          await offAtStart.command.dispatch('INTERACTION_CREATE', ask)
          await refused.command.dispatch('INTERACTION_CREATE', ask)
          expect(refused.calls.callbacks).toStrictEqual(offAtStart.calls.callbacks)
        },
      ),
      { numRuns: 80 },
    )
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
    const own = createCommand({ discord: t.discord, store: { outboxMessage: () => { throw new Error('sync failure') } }, guildId: GUILD, repliesOn: () => true, timers: t.ft.timers, now: () => t.ft.now, log: () => {} })
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

  it('uses the timers and the clock of the runtime when it is given none', async () => {
    vi.useFakeTimers()
    try {
      const t = rig({ storeGate: new Promise(() => {}), options: { timers: undefined, now: undefined } })
      const done = t.command.dispatch('INTERACTION_CREATE', interaction())
      await vi.advanceTimersByTimeAsync(1_499)
      expect(t.calls.callbacks).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      await done
      expect(t.calls.callbacks).toHaveLength(1)
      expect(t.calls.options).toStrictEqual([{ timeoutMs: 1300 }])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('INTERACTION_CREATE: the callback has what is left of the three seconds (rB4 N3)', () => {
  /** → the callback's timeout for a store that answers `elapsed` ms after the event came, with a deadline that lets it. */
  async function timeoutAfter(elapsed, { deadlineMs = 1900, answer = stored() } = {}) {
    let release
    const t = rig({ storeGate: new Promise((resolve) => (release = resolve)), options: { deadlineMs } })
    const done = t.command.dispatch('INTERACTION_CREATE', interaction())
    await flush()
    if (elapsed > 0) await t.ft.advance(elapsed)
    release(answer)
    await done
    expect(t.calls.callbacks, String(elapsed)).toHaveLength(1)
    return t.calls.options[0].timeoutMs
  }

  it('gives a callback sent 5 ms after the event 2,795 ms, so a slow connection is not cut off with time to spare', async () => {
    expect(await timeoutAfter(5)).toBe(2795)
  })

  it('gives a callback sent 1,700 ms after the event 1,100 ms, so the answer is still due inside the three seconds', async () => {
    expect(await timeoutAfter(1_700)).toBe(1100)
  })

  it('never gives it less than a second, however late it is sent: 1,799 ms in is 1,001, 1,800 is 1,000, and 1,900 is 1,000', async () => {
    expect(await timeoutAfter(1_799)).toBe(1001)
    expect(await timeoutAfter(1_800)).toBe(1000)
    expect(await timeoutAfter(1_900)).toBe(1000)
  })

  it('gives the fallback sent at the store\'s deadline what is left after it', async () => {
    for (const [deadlineMs, left] of [[1_500, 1300], [500, 2300], [1_900, 1000]]) {
      const t = rig({ storeGate: new Promise(() => {}), options: { deadlineMs } })
      const done = t.command.dispatch('INTERACTION_CREATE', interaction())
      await flush()
      await t.ft.advance(deadlineMs)
      await done
      expect(content(t), String(deadlineMs)).toBe(`${COPY_FALLBACK} ${LINK}`)
      expect(t.calls.options, String(deadlineMs)).toStrictEqual([{ timeoutMs: left }])
    }
  })

  it('counts from the moment the event came, not from when the command was made', async () => {
    let release
    const t = rig({ storeGate: new Promise((resolve) => (release = resolve)) })
    await t.ft.advance(60_000)
    const done = t.command.dispatch('INTERACTION_CREATE', interaction())
    await flush()
    await t.ft.advance(5)
    release(stored())
    await done
    expect(t.calls.options).toStrictEqual([{ timeoutMs: 2795 }])
  })

  it('counts each interaction from its own coming, when several are being answered', async () => {
    const gates = []
    const t = rig({ storeGate: undefined })
    t.store.outboxMessage = () => new Promise((resolve) => gates.push(resolve))
    const own = createCommand({ discord: t.discord, store: t.store, guildId: GUILD, repliesOn: () => true, timers: t.ft.timers, now: () => t.ft.now, deadlineMs: 1900, log: () => {} })
    const first = own.dispatch('INTERACTION_CREATE', interaction())
    await flush()
    await t.ft.advance(1_000)
    const second = own.dispatch('INTERACTION_CREATE', interaction({ id: '200000000000000491', token: 'second-token' }))
    await flush()
    await t.ft.advance(200)
    gates[0](stored())
    gates[1](stored())
    await Promise.all([first, second])
    expect(t.calls.callbacks.map((c) => c.id)).toStrictEqual([INTERACTION, '200000000000000491'])
    expect(t.calls.options).toStrictEqual([{ timeoutMs: 1600 }, { timeoutMs: 2600 }])
  })

  it('gives no more than 2,800 ms when the clock goes back while it waits', async () => {
    let release
    const clock = { at: 50_000 }
    const t = rig({ storeGate: new Promise((resolve) => (release = resolve)), options: { now: () => clock.at } })
    const done = t.command.dispatch('INTERACTION_CREATE', interaction())
    await flush()
    clock.at = 49_000
    release(stored())
    await done
    expect(t.calls.options).toStrictEqual([{ timeoutMs: 2800 }])
  })

  it('always gives from 1,000 to 2,800 ms, what is left of 2,800 after the time spent but never less than a second (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 1_900 }), async (elapsed) => {
        const timeoutMs = await timeoutAfter(elapsed)
        expect(timeoutMs).toBe(elapsed >= 1_800 ? 1000 : 2800 - elapsed)
        expect(elapsed + timeoutMs).toBeLessThanOrEqual(2_900)
      }),
      { numRuns: 60 },
    )
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
    const own = createCommand({ discord: odd.discord, store: odd.store, guildId: GUILD, repliesOn: () => true, timers: odd.ft.timers, now: () => odd.ft.now, log: () => {} })
    await expect(own.dispatch('INTERACTION_CREATE', interaction())).resolves.toBeUndefined()
  })

  it('never leaves the token in what it logs, whatever Discord said', async () => {
    const t = rig()
    t.discord.interactionCallback = async () => {
      throw new Error(`https://discord.com/api/v10/interactions/${INTERACTION}/${TOKEN}/callback failed with ${TOKEN}`)
    }
    const logged = []
    const own = createCommand({ discord: t.discord, store: t.store, guildId: GUILD, repliesOn: () => true, timers: t.ft.timers, now: () => t.ft.now, log: (line) => logged.push(line) })
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
