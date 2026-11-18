import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fc from 'fast-check'
import { createLinkRefresh } from './librariusLinks.js'
import { linkExpiry } from './librariusParse.js'
import { Upstream } from './discordRoles.js'

// Every id, link and time here is invented. The two ends are in memory: a fake Discord client that keeps the argument
// checks of the real one (at most 50 links; a link it did not refresh is not in the Map) in its own wording, so a test can
// tell whether its refusal or the module's came first, and a fake store that keeps the real store's selection (strictly before the expiry bound, viewed at or after the floor, soonest expiry first, at most
// `limit`) and its argument checks. What a test asserts is what the rows hold afterwards, or what a call answered.
const T0 = Date.parse('2026-11-15T12:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const LINK = /https?:\/\//i
const FRESH_EXPIRY = T0 + 7 * DAY

const iso = (ms) => new Date(ms).toISOString()
const hex = (ms) => Math.floor(ms / SECOND).toString(16)
const attId = (n) => String(300000000000000000n + BigInt(n))
const oldUrl = (n, expiresMs = T0 + MINUTE) =>
  `https://cdn.discordapp.com/attachments/200000000000000410/${attId(n)}/a${n}.png?ex=${hex(expiresMs)}&is=old${n}&hm=oldsig${n}`
const newUrl = (n, expiresMs = FRESH_EXPIRY) =>
  `https://cdn.discordapp.com/attachments/200000000000000410/${attId(n)}/a${n}.png?ex=${hex(expiresMs)}&is=new${n}&hm=newsig${n}`
// The n of a link made by oldUrl.
const nOf = (url) => Number(/\/a(\d+)\.png/.exec(url)[1])
const refreshAll = (url) => newUrl(nOf(url))

/** A stored attachment, as the store's own selection sees it: due soon (a minute) and viewed now, unless said otherwise. */
const row = (n, { expiresMs = T0 + MINUTE, viewedMs = T0 } = {}) => ({
  id: attId(n),
  url: oldUrl(n, expiresMs),
  expiresAt: iso(expiresMs),
  viewedAt: iso(viewedMs),
})

function fakeDiscord({ fresh = refreshAll } = {}) {
  const calls = []
  const discord = {
    calls,
    // (callNumber, urls) → { error } to throw whatever it is (undefined too), or null.
    failure: () => null,
    async refreshUrls(urls) {
      if (!Array.isArray(urls) || !urls.every((u) => typeof u === 'string')) throw new TypeError('the fake wants a list of strings')
      if (urls.length > 50) throw new RangeError('the fake takes at most 50 links')
      calls.push([...urls])
      const failed = discord.failure(calls.length, urls)
      if (failed !== null) throw failed.error
      return new Map(urls.flatMap((u) => (fresh(u) === undefined ? [] : [[u, fresh(u)]])))
    },
  }
  return discord
}

function fakeStore({ rows = [], tombstones = [] } = {}) {
  const store = {
    rows: rows.map((r) => ({ ...r })),
    tombstones: tombstones.map((t) => ({ ...t })),
    selections: [],
    writes: 0,
    // method name → an error to throw before it does anything.
    failures: {},
    // method name → a promise the method waits for before it does anything.
    holds: {},
    async attachmentsToRefresh({ expiringBefore, viewedSince, limit }) {
      store.selections.push({ expiringBefore, viewedSince, limit })
      await store.holds.attachmentsToRefresh
      if ('attachmentsToRefresh' in store.failures) throw store.failures.attachmentsToRefresh
      const before = new Date(expiringBefore).getTime()
      const since = new Date(viewedSince).getTime()
      if (Number.isNaN(before) || Number.isNaN(since)) throw new TypeError('a time must be a Date, an ISO time or epoch milliseconds')
      if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('limit must be a whole number from 1')
      return store.rows
        .filter((r) => Date.parse(r.viewedAt) >= since && Date.parse(r.expiresAt) < before)
        .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))
        .slice(0, limit)
        .map((r) => ({ id: r.id, url: r.url }))
    },
    async updateAttachmentUrls(updates) {
      if ('updateAttachmentUrls' in store.failures) throw store.failures.updateAttachmentUrls
      for (const u of updates) {
        if (!/^\d{17,20}$/.test(u.id)) throw new TypeError('attachment id must be a Discord id')
        if (typeof u.url !== 'string' || u.url === '') throw new TypeError('url must be a non-empty string')
        if (u.expiresAt !== null && (typeof u.expiresAt !== 'string' || Number.isNaN(Date.parse(u.expiresAt)))) {
          throw new TypeError('expiresAt must be a time or null')
        }
      }
      store.writes += 1
      for (const u of updates) {
        const held = store.rows.find((r) => r.id === u.id)
        if (held) Object.assign(held, { url: u.url, expiresAt: u.expiresAt })
      }
    },
    async pruneTombstones(before) {
      if ('pruneTombstones' in store.failures) throw store.failures.pruneTombstones
      const bound = new Date(before).getTime()
      if (Number.isNaN(bound)) throw new TypeError('before must be a Date, an ISO time or epoch milliseconds')
      store.tombstones = store.tombstones.filter((t) => Date.parse(t.deletedAt) >= bound)
    },
  }
  return store
}

/** Timers that do nothing until a test fires them. Ids start at 0, which is false, as any id may be. */
function fakeTimers() {
  const jobs = []
  return {
    jobs,
    setTimeout: (fn, ms) => jobs.push({ fn, ms, over: false }) - 1,
    clearTimeout: (id) => {
      if (jobs[id]) jobs[id].over = true
    },
    live: () => jobs.filter((j) => !j.over),
  }
}

function setup({ rows = [], tombstones = [], fresh, ...options } = {}) {
  const logs = []
  const clock = { t: T0 }
  const store = fakeStore({ rows, tombstones })
  const discord = fakeDiscord({ fresh })
  const timers = fakeTimers()
  const links = createLinkRefresh({ discord, store, now: () => clock.t, timers, log: (...a) => logs.push(a.join(' ')), ...options })
  return { links, store, discord, timers, clock, logs }
}

const held = (store, n) => store.rows.find((r) => r.id === attId(n))
const isFresh = (r, n) => r.url === newUrl(n) && r.expiresAt === iso(FRESH_EXPIRY)
const isUntouched = (r, n, expiresMs = T0 + MINUTE) => r.url === oldUrl(n, expiresMs) && r.expiresAt === iso(expiresMs)

afterEach(() => {
  vi.useRealTimers()
})

describe('runOnce', () => {
  it('refreshes a link that is due, and stores the new link with the expiry that link carries', async () => {
    const w = setup({ rows: [row(1)] })
    await w.links.runOnce()
    expect(held(w.store, 1)).toMatchObject({ url: newUrl(1), expiresAt: iso(FRESH_EXPIRY) })
    expect(w.discord.calls).toEqual([[oldUrl(1)]])
    expect(linkExpiry(newUrl(1))).toBe(iso(FRESH_EXPIRY))
  })

  it('stores a null expiry for a new link that carries none', async () => {
    const w = setup({ rows: [row(1)], fresh: () => 'https://cdn.discordapp.com/attachments/1/2/a.png?no=expiry' })
    await w.links.runOnce()
    expect(held(w.store, 1)).toMatchObject({ url: 'https://cdn.discordapp.com/attachments/1/2/a.png?no=expiry', expiresAt: null })
  })

  it('stores the expiry of each link on its own', async () => {
    const w = setup({
      rows: [row(1), row(2), row(3)],
      fresh: (url) => newUrl(nOf(url), T0 + nOf(url) * DAY),
    })
    await w.links.runOnce()
    for (const n of [1, 2, 3]) expect(held(w.store, n)).toMatchObject({ url: newUrl(n, T0 + n * DAY), expiresAt: iso(T0 + n * DAY) })
  })

  it('leaves alone a link Discord did not refresh, and refreshes the rest of its chunk', async () => {
    const w = setup({ rows: [row(1), row(2), row(3)], fresh: (url) => (nOf(url) === 2 ? undefined : refreshAll(url)) })
    await w.links.runOnce()
    expect(isFresh(held(w.store, 1), 1)).toBe(true)
    expect(isUntouched(held(w.store, 2), 2)).toBe(true)
    expect(isFresh(held(w.store, 3), 3)).toBe(true)
  })

  it('writes nothing when Discord refreshed none', async () => {
    const w = setup({ rows: [row(1), row(2)], fresh: () => undefined })
    await w.links.runOnce()
    expect(w.store.writes).toBe(0)
    expect(isUntouched(held(w.store, 1), 1)).toBe(true)
  })

  it('asks Discord for nothing when no link is due', async () => {
    const w = setup({ rows: [row(1, { expiresMs: T0 + 3 * HOUR })] })
    await w.links.runOnce()
    expect(w.discord.calls).toEqual([])
    expect(w.store.writes).toBe(0)
  })

  describe('which links are due', () => {
    it('asks for links that expire before two hours from now, in posts viewed in the last day, 200 at a time', async () => {
      const w = setup()
      await w.links.runOnce()
      expect(w.store.selections).toEqual([{ expiringBefore: T0 + 2 * HOUR, viewedSince: T0 - DAY, limit: 200 }])
    })

    it('takes the time once per run, and a later run takes it again', async () => {
      const w = setup()
      await w.links.runOnce()
      w.clock.t = T0 + 5 * HOUR
      await w.links.runOnce()
      expect(w.store.selections.map((s) => s.expiringBefore)).toEqual([T0 + 2 * HOUR, T0 + 7 * HOUR])
      expect(w.store.selections.map((s) => s.viewedSince)).toEqual([T0 - DAY, T0 + 5 * HOUR - DAY])
    })

    it('refreshes a link one millisecond short of the bound, and not one at it (the store compares strictly)', async () => {
      const w = setup({ rows: [row(1, { expiresMs: T0 + 2 * HOUR - SECOND }), row(2, { expiresMs: T0 + 2 * HOUR })] })
      await w.links.runOnce()
      expect(isFresh(held(w.store, 1), 1)).toBe(true)
      expect(isUntouched(held(w.store, 2), 2, T0 + 2 * HOUR)).toBe(true)
    })

    it('refreshes a link already expired', async () => {
      const w = setup({ rows: [row(1, { expiresMs: T0 - HOUR })] })
      await w.links.runOnce()
      expect(isFresh(held(w.store, 1), 1)).toBe(true)
    })

    it('refreshes a post viewed exactly a day ago, and not one viewed before that', async () => {
      const w = setup({ rows: [row(1, { viewedMs: T0 - DAY }), row(2, { viewedMs: T0 - DAY - SECOND })] })
      await w.links.runOnce()
      expect(isFresh(held(w.store, 1), 1)).toBe(true)
      expect(isUntouched(held(w.store, 2), 2)).toBe(true)
    })

    it('takes the windows it is given', async () => {
      const w = setup({
        aheadMs: 30 * MINUTE,
        viewedWithinMs: HOUR,
        rows: [
          row(1, { expiresMs: T0 + 29 * MINUTE }),
          row(2, { expiresMs: T0 + 31 * MINUTE }),
          row(3, { viewedMs: T0 - 59 * MINUTE }),
          row(4, { viewedMs: T0 - 61 * MINUTE }),
        ],
      })
      await w.links.runOnce()
      expect(w.store.selections).toEqual([{ expiringBefore: T0 + 30 * MINUTE, viewedSince: T0 - HOUR, limit: 200 }])
      expect([1, 2, 3, 4].map((n) => isFresh(held(w.store, n), n))).toEqual([true, false, true, false])
    })

    it('does one pass of 200 at most, soonest expiry first, and leaves the rest for the next run', async () => {
      const w = setup({ rows: Array.from({ length: 230 }, (_, i) => row(i, { expiresMs: T0 + (i + 1) * SECOND })) })
      await w.links.runOnce()
      expect(w.discord.calls.flat()).toHaveLength(200)
      expect(w.store.rows.filter((r) => r.url.includes('is=new'))).toHaveLength(200)
      expect(isUntouched(held(w.store, 200), 200, T0 + 201 * SECOND)).toBe(true)
      await w.links.runOnce()
      expect(w.store.rows.every((r) => r.url.includes('is=new'))).toBe(true)
    })
  })

  describe('chunking', () => {
    it.each([
      [0, []],
      [1, [1]],
      [49, [49]],
      [50, [50]],
      [51, [50, 1]],
      [100, [50, 50]],
      [101, [50, 50, 1]],
      [150, [50, 50, 50]],
      [200, [50, 50, 50, 50]],
    ])('asks Discord about %i links in chunks of %j', async (count, sizes) => {
      const w = setup({ rows: Array.from({ length: count }, (_, i) => row(i, { expiresMs: T0 + (i + 1) * SECOND })) })
      await w.links.runOnce()
      expect(w.discord.calls.map((c) => c.length)).toEqual(sizes)
      expect(w.store.rows.every((r, i) => isFresh(r, i) || count === 0)).toBe(true)
    })

    it('writes each chunk as it is refreshed, so a later failure keeps what an earlier chunk did', async () => {
      const w = setup({ rows: Array.from({ length: 120 }, (_, i) => row(i, { expiresMs: T0 + (i + 1) * SECOND })) })
      w.discord.failure = (call) => (call === 2 ? { error: new Upstream('Discord is unreachable.') } : null)
      await expect(w.links.runOnce()).resolves.toBeUndefined()
      expect(w.discord.calls.map((c) => c.length)).toEqual([50, 50])
      expect(w.store.rows.slice(0, 50).every((r, i) => isFresh(r, i))).toBe(true)
      expect(w.store.rows.slice(50).every((r, i) => isUntouched(r, i + 50, T0 + (i + 51) * SECOND))).toBe(true)
      expect(w.store.writes).toBe(1)
    })

    it('asks about every due link once, in the order the store gave them, whatever the count', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 0, max: 200 }), async (count) => {
          const w = setup({ rows: Array.from({ length: count }, (_, i) => row(i, { expiresMs: T0 + (i + 1) * SECOND })) })
          await w.links.runOnce()
          expect(w.discord.calls.flat()).toEqual(Array.from({ length: count }, (_, i) => oldUrl(i, T0 + (i + 1) * SECOND)))
          for (const [i, call] of w.discord.calls.entries()) expect(call.length).toBe(i < w.discord.calls.length - 1 ? 50 : count - 50 * i)
        }),
        { numRuns: 60 },
      )
    })

    it('stores exactly the links Discord refreshed, whichever those are', async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(fc.boolean(), { maxLength: 120 }), async (flags) => {
          const w = setup({
            rows: flags.map((_, i) => row(i, { expiresMs: T0 + (i + 1) * SECOND })),
            fresh: (url) => (flags[nOf(url)] ? refreshAll(url) : undefined),
          })
          await w.links.runOnce()
          for (const [i, refreshed] of flags.entries()) {
            expect(isFresh(w.store.rows[i], i) || isUntouched(w.store.rows[i], i, T0 + (i + 1) * SECOND)).toBe(true)
            expect(isFresh(w.store.rows[i], i)).toBe(refreshed)
          }
        }),
        { numRuns: 60 },
      )
    })
  })

  describe('delete notes', () => {
    const note = (messageId, deletedMs) => ({ messageId, deletedAt: iso(deletedMs) })

    it('removes the delete notes older than a day, and keeps the rest', async () => {
      const w = setup({ tombstones: [note('a', T0 - DAY - SECOND), note('b', T0 - DAY), note('c', T0 - DAY + SECOND), note('d', T0)] })
      await w.links.runOnce()
      expect(w.store.tombstones.map((t) => t.messageId)).toEqual(['b', 'c', 'd'])
    })

    it('does so on every run, by the time of that run, even when no link is due', async () => {
      const w = setup({ tombstones: [note('a', T0 - HOUR)] })
      await w.links.runOnce()
      expect(w.store.tombstones).toHaveLength(1)
      w.clock.t = T0 + DAY
      await w.links.runOnce()
      expect(w.store.tombstones).toHaveLength(0)
    })

    it('does so by the time the run began, not the time it ended', async () => {
      const w = setup({ rows: [row(1)], tombstones: [note('a', T0 - DAY - SECOND), note('b', T0)] })
      w.discord.failure = () => {
        w.clock.t += 10 * DAY
        return null
      }
      await w.links.runOnce()
      expect(w.store.tombstones.map((t) => t.messageId)).toEqual(['b'])
      expect(isFresh(held(w.store, 1), 1)).toBe(true)
    })
  })

  describe('failures', () => {
    const rows = () => [row(1), row(2)]
    const stale = () => [note('a', T0 - 2 * DAY)]
    const note = (messageId, deletedMs) => ({ messageId, deletedAt: iso(deletedMs) })

    it('resolves, and goes on to the delete notes, when Discord cannot be reached', async () => {
      const w = setup({ rows: rows(), tombstones: stale() })
      w.discord.failure = () => ({ error: new Upstream('Discord is unreachable.') })
      await expect(w.links.runOnce()).resolves.toBeUndefined()
      expect(w.store.writes).toBe(0)
      expect(w.store.tombstones).toEqual([])
    })

    it('stops asking Discord after the first chunk that fails', async () => {
      const w = setup({ rows: Array.from({ length: 150 }, (_, i) => row(i, { expiresMs: T0 + (i + 1) * SECOND })) })
      w.discord.failure = (call) => (call === 1 ? { error: new Upstream('Discord is unreachable.') } : null)
      await w.links.runOnce()
      expect(w.discord.calls).toHaveLength(1)
    })

    it('resolves, and goes on to the delete notes, when the store cannot say which links are due', async () => {
      const w = setup({ rows: rows(), tombstones: stale() })
      w.store.failures.attachmentsToRefresh = new Error('connection refused')
      await expect(w.links.runOnce()).resolves.toBeUndefined()
      expect(w.discord.calls).toEqual([])
      expect(w.store.tombstones).toEqual([])
    })

    it('resolves, and goes on to the delete notes, when the store refuses the new links', async () => {
      const w = setup({ rows: Array.from({ length: 120 }, (_, i) => row(i, { expiresMs: T0 + (i + 1) * SECOND })), tombstones: stale() })
      w.store.failures.updateAttachmentUrls = new Error('connection refused')
      await expect(w.links.runOnce()).resolves.toBeUndefined()
      expect(w.discord.calls).toHaveLength(1)
      expect(w.store.tombstones).toEqual([])
    })

    it('resolves, with the links already refreshed, when the delete notes cannot be removed', async () => {
      const w = setup({ rows: rows(), tombstones: stale() })
      w.store.failures.pruneTombstones = new Error('connection refused')
      await expect(w.links.runOnce()).resolves.toBeUndefined()
      expect(isFresh(held(w.store, 1), 1)).toBe(true)
      expect(w.store.tombstones).toHaveLength(1)
    })

    it('resolves when everything fails, and when the clock does', async () => {
      const w = setup({ rows: rows() })
      w.store.failures.attachmentsToRefresh = new Error('x')
      w.store.failures.pruneTombstones = new Error('y')
      await expect(w.links.runOnce()).resolves.toBeUndefined()
      const broken = setup({ rows: rows(), now: () => { throw new Error('no clock') } })
      await expect(broken.links.runOnce()).resolves.toBeUndefined()
      expect(broken.store.selections).toEqual([])
    })

    it('tries again on the next run, from where it was', async () => {
      const w = setup({ rows: rows() })
      let down = true
      w.discord.failure = () => (down ? { error: new Upstream('Discord is unreachable.') } : null)
      await w.links.runOnce()
      expect(isUntouched(held(w.store, 1), 1)).toBe(true)
      down = false
      await w.links.runOnce()
      expect(isFresh(held(w.store, 1), 1)).toBe(true)
      expect(isFresh(held(w.store, 2), 2)).toBe(true)
    })

    it('resolves and logs no link, whatever is thrown, and wherever', async () => {
      const link = fc.constantFrom('https://cdn.test/a?sig=secret1', 'http://a.b/secret2', 'HTTPS://UP.PER/x?hm=secret3', 'https://')
      const thrown = fc
        .tuple(fc.string({ maxLength: 80 }), link, fc.string({ maxLength: 300 }), fc.constantFrom('upstream', 'error', 'type', 'string', 'nothing', 'null', 'named'))
        .map(([before, url, after, kind]) => {
          const text = `${before}${url}${after}`
          const named = Object.assign(new Error('x'), { name: `Odd ${url}` })
          return { error: { upstream: new Upstream(text), error: new Error(text), type: new TypeError(text), string: text, nothing: undefined, null: null, named }[kind] }
        })
      await fc.assert(
        fc.asyncProperty(fc.constantFrom('refreshUrls', 'attachmentsToRefresh', 'updateAttachmentUrls', 'pruneTombstones'), thrown, async (where, { error }) => {
          const w = setup({ rows: rows(), tombstones: stale() })
          if (where === 'refreshUrls') w.discord.failure = () => ({ error })
          else w.store.failures[where] = error
          await expect(w.links.runOnce()).resolves.toBeUndefined()
          expect(w.logs.join('\n')).not.toMatch(LINK)
          expect(w.logs.join('\n')).not.toMatch(/secret/)
        }),
        { numRuns: 150 },
      )
    })

    it('logs no link of a Discord CDN host either, with or without its scheme, in any case', async () => {
      const links = [
        'cdn.discordapp.com/attachments/200000000000000410/300000000000000001/a.png?ex=1&is=2&hm=secret',
        'MEDIA.DISCORDAPP.NET/attachments/200000000000000410/300000000000000001/a.png?hm=secret',
        'https://cdn.discordapp.com/attachments/200000000000000410/300000000000000001/a.png?hm=secret',
        'WSS://gateway.test/?v=10&hm=secret',
      ]
      for (const url of links) {
        for (const error of [new Error(`refused ${url} today`), new Upstream(`refused ${url} today`), Object.assign(new Error('x'), { name: `Odd ${url}` })]) {
          const w = setup({ rows: rows(), tombstones: stale() })
          w.store.failures.attachmentsToRefresh = error
          await w.links.runOnce()
          expect(w.logs.join('\n')).not.toMatch(/discordapp|wss:|secret/i)
        }
      }
    })

    it('resolves and goes on to the delete notes when what went wrong cannot be read or printed', async () => {
      const unreadable = Object.defineProperties(new Error('x'), { name: { get: () => { throw new Error('no name') } }, message: { get: () => { throw new Error('no message') } } })
      const symbolic = Object.assign(new Error('x'), { name: Symbol('name'), message: Symbol('message') })
      const hidden = new Proxy({}, { get: () => { throw new Error('trap') } })
      for (const error of [unreadable, symbolic, hidden, Object.create(null)]) {
        for (const where of ['attachmentsToRefresh', 'pruneTombstones']) {
          const w = setup({ rows: rows(), tombstones: stale() })
          w.store.failures[where] = error
          await expect(w.links.runOnce()).resolves.toBeUndefined()
          if (where === 'attachmentsToRefresh') expect(w.store.tombstones).toEqual([])
        }
      }
    })

    it('logs at most 200 characters of what went wrong', async () => {
      for (const error of [new Error('a'.repeat(5000)), new Upstream('b'.repeat(201)), Object.assign(new Error('x'), { name: 'N'.repeat(5000) })]) {
        const w = setup({ rows: rows(), tombstones: stale() })
        w.store.failures.attachmentsToRefresh = error
        await w.links.runOnce()
        expect(Math.max(0, ...w.logs.map((line) => line.length))).toBeLessThan(300)
      }
    })

    it('goes on to the delete notes when what the first step throws is no error at all', async () => {
      for (const error of [undefined, null, 0, '', 'text', {}, Symbol.for('x'), () => {}]) {
        const w = setup({ rows: rows(), tombstones: stale() })
        w.store.failures.attachmentsToRefresh = error
        await expect(w.links.runOnce()).resolves.toBeUndefined()
        expect(w.store.tombstones).toEqual([])
        const d = setup({ rows: rows(), tombstones: stale() })
        d.discord.failure = () => ({ error })
        await expect(d.links.runOnce()).resolves.toBeUndefined()
        expect(d.store.tombstones).toEqual([])
      }
    })

    it('resolves when what the delete notes step throws is no error at all', async () => {
      for (const error of [undefined, null, 0, '', 'text', {}, Symbol.for('x'), () => {}]) {
        const w = setup({ rows: rows(), tombstones: stale() })
        w.store.failures.pruneTombstones = error
        await expect(w.links.runOnce()).resolves.toBeUndefined()
        expect(isFresh(held(w.store, 1), 1)).toBe(true)
      }
    })
  })

  describe('overlap', () => {
    it('shares the run that is going with whoever asks meanwhile', async () => {
      const w = setup({ rows: [row(1)] })
      let release
      w.store.holds.attachmentsToRefresh = new Promise((resolve) => (release = resolve))
      const first = w.links.runOnce()
      const second = w.links.runOnce()
      let done = false
      second.then(() => (done = true))
      await new Promise((r) => setTimeout(r, 5))
      expect(done).toBe(false)
      expect(w.store.selections).toHaveLength(1)
      release()
      await Promise.all([first, second])
      expect(w.store.selections).toHaveLength(1)
      expect(w.discord.calls).toHaveLength(1)
    })

    it('runs again once the earlier run is over, whether it worked or not', async () => {
      const w = setup({ rows: [row(1)] })
      w.store.failures.attachmentsToRefresh = new Error('down')
      await w.links.runOnce()
      await w.links.runOnce()
      delete w.store.failures.attachmentsToRefresh
      await w.links.runOnce()
      await w.links.runOnce()
      expect(w.store.selections).toHaveLength(4)
    })
  })
})

describe('refresh', () => {
  const asked = (...ns) => ns.map((n) => ({ id: attId(n), url: oldUrl(n) }))

  it('answers the new link and its expiry for each attachment, by id', async () => {
    const w = setup()
    const got = await w.links.refresh(asked(1, 2))
    expect(got).toBeInstanceOf(Map)
    expect(got).toEqual(
      new Map([
        [attId(1), { url: newUrl(1), expiresAt: iso(FRESH_EXPIRY) }],
        [attId(2), { url: newUrl(2), expiresAt: iso(FRESH_EXPIRY) }],
      ]),
    )
    expect(w.discord.calls).toEqual([[oldUrl(1), oldUrl(2)]])
  })

  it('answers a null expiry for a new link that carries none', async () => {
    const w = setup({ fresh: () => 'https://cdn.discordapp.com/attachments/1/2/a.png?no=expiry' })
    expect((await w.links.refresh(asked(1))).get(attId(1))).toEqual({ url: 'https://cdn.discordapp.com/attachments/1/2/a.png?no=expiry', expiresAt: null })
  })

  it('leaves out an attachment whose link Discord did not refresh', async () => {
    const w = setup({ fresh: (url) => (nOf(url) === 2 ? undefined : refreshAll(url)) })
    const got = await w.links.refresh(asked(1, 2, 3))
    expect([...got.keys()]).toEqual([attId(1), attId(3)])
  })

  it('ignores whatever else an attachment carries', async () => {
    const w = setup()
    const got = await w.links.refresh([{ id: attId(1), url: oldUrl(1), filename: 'a.png', size: 9, expiresAt: iso(T0) }])
    expect(got.get(attId(1))).toEqual({ url: newUrl(1), expiresAt: iso(FRESH_EXPIRY) })
  })

  it('answers an empty map for no attachments', async () => {
    const w = setup()
    expect(await w.links.refresh([])).toEqual(new Map())
  })

  it('answers an empty map, so the caller keeps the link it has, when Discord cannot be reached', async () => {
    const w = setup()
    w.discord.failure = () => ({ error: new Upstream('Discord is unreachable.') })
    const got = await w.links.refresh(asked(1, 2))
    expect(got).toBeInstanceOf(Map)
    expect(got.size).toBe(0)
  })

  it('does not swallow anything but Upstream', async () => {
    const w = setup()
    for (const error of [new TypeError('bad'), new RangeError('bad'), new Error('boom')]) {
      w.discord.failure = () => ({ error })
      await expect(w.links.refresh(asked(1))).rejects.toBe(error)
    }
  })

  it('takes 50 attachments, and refuses 51 before asking Discord anything', async () => {
    const w = setup()
    expect((await w.links.refresh(asked(...Array.from({ length: 50 }, (_, i) => i)))).size).toBe(50)
    const calls = w.discord.calls.length
    await expect(w.links.refresh(asked(...Array.from({ length: 51 }, (_, i) => i)))).rejects.toThrow(
      new RangeError('At most 50 links can be refreshed at once.'),
    )
    expect(w.discord.calls).toHaveLength(calls)
  })

  it.each([
    ['no list', undefined, 'attachments must be a list.'],
    ['null', null, 'attachments must be a list.'],
    ['an object', { id: attId(1), url: oldUrl(1) }, 'attachments must be a list.'],
    ['a string', 'abc', 'attachments must be a list.'],
    ['a Set', new Set([{ id: attId(1), url: oldUrl(1) }]), 'attachments must be a list.'],
    ['a null item', [null], 'each attachment must have an id and a url, as text.'],
    ['an undefined item', [undefined], 'each attachment must have an id and a url, as text.'],
    ['a string item', ['https://cdn.discordapp.com/x'], 'each attachment must have an id and a url, as text.'],
    ['an item without an id', [{ url: oldUrl(1) }], 'each attachment must have an id and a url, as text.'],
    ['an item with a numeric id', [{ id: 300000000000000001, url: oldUrl(1) }], 'each attachment must have an id and a url, as text.'],
    ['an item without a link', [{ id: attId(1) }], 'each attachment must have an id and a url, as text.'],
    ['an item with a null link', [{ id: attId(1), url: null }], 'each attachment must have an id and a url, as text.'],
    ['an item with a link that is no string', [{ id: attId(1), url: { href: oldUrl(1) } }], 'each attachment must have an id and a url, as text.'],
    ['one bad item after a good one', [{ id: attId(1), url: oldUrl(1) }, { id: attId(2), url: 7 }], 'each attachment must have an id and a url, as text.'],
  ])('refuses %s with a TypeError, before asking Discord anything', async (_, input, message) => {
    const w = setup()
    await expect(w.links.refresh(input)).rejects.toThrow(new TypeError(message))
    expect(w.discord.calls).toEqual([])
  })

  it('writes nothing to the store: the read path only borrows the new links', async () => {
    const w = setup({ rows: [row(1)] })
    await w.links.refresh(asked(1))
    expect(w.store.writes).toBe(0)
    expect(w.store.selections).toEqual([])
    expect(isUntouched(held(w.store, 1), 1)).toBe(true)
  })

  it('answers each attachment its own link, whatever the count and whichever Discord refreshed', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { maxLength: 50 }), async (flags) => {
        const w = setup({ fresh: (url) => (flags[nOf(url)] ? refreshAll(url) : undefined) })
        const got = await w.links.refresh(asked(...flags.keys()))
        expect([...got.keys()]).toEqual([...flags.keys()].filter((n) => flags[n]).map(attId))
        for (const [id, view] of got) expect(view).toEqual({ url: newUrl(Number(BigInt(id) - 300000000000000000n)), expiresAt: iso(FRESH_EXPIRY) })
      }),
      { numRuns: 60 },
    )
  })
})

describe('start and stop', () => {
  const settle = () => new Promise((r) => setTimeout(r, 0))
  /** Fire the one live timer and let its run finish. */
  async function fire(w) {
    const [job] = w.timers.live()
    job.over = true
    job.fn()
    await settle()
  }

  it('starts one timer, which runs at once (a delay of 0), then one every interval after each run', async () => {
    const w = setup({ rows: [row(1)] })
    w.links.start()
    expect(w.timers.live().map((j) => j.ms)).toEqual([0])
    expect(w.store.selections).toEqual([])
    await fire(w)
    expect(isFresh(held(w.store, 1), 1)).toBe(true)
    expect(w.timers.live().map((j) => j.ms)).toEqual([600_000])
    await fire(w)
    expect(w.store.selections).toHaveLength(2)
    expect(w.timers.live().map((j) => j.ms)).toEqual([600_000])
  })

  it('uses the interval it is given', async () => {
    const w = setup({ intervalMs: 1234 })
    w.links.start()
    await fire(w)
    expect(w.timers.live().map((j) => j.ms)).toEqual([1234])
  })

  it('is one timer however many times it is started', async () => {
    const w = setup()
    w.links.start()
    w.links.start()
    w.links.start()
    expect(w.timers.live()).toHaveLength(1)
    await fire(w)
    w.links.start()
    expect(w.timers.live()).toHaveLength(1)
    await fire(w)
    expect(w.store.selections).toHaveLength(2)
  })

  it('does not schedule the next run until the one going has finished, so runs never overlap', async () => {
    const w = setup()
    let release
    w.store.holds.attachmentsToRefresh = new Promise((resolve) => (release = resolve))
    w.links.start()
    const [job] = w.timers.live()
    job.over = true
    job.fn()
    await settle()
    expect(w.timers.live()).toHaveLength(0)
    release()
    await settle()
    expect(w.timers.live().map((j) => j.ms)).toEqual([600_000])
  })

  it('goes on after a run that failed', async () => {
    const w = setup({ rows: [row(1)] })
    w.store.failures.attachmentsToRefresh = new Error('down')
    w.links.start()
    await fire(w)
    expect(w.timers.live().map((j) => j.ms)).toEqual([600_000])
    delete w.store.failures.attachmentsToRefresh
    await fire(w)
    expect(isFresh(held(w.store, 1), 1)).toBe(true)
  })

  it('stops: the pending timer is cleared and nothing is scheduled', async () => {
    const w = setup({ rows: [row(1)] })
    w.links.start()
    await fire(w)
    w.links.stop()
    expect(w.timers.live()).toHaveLength(0)
    await settle()
    expect(w.timers.live()).toHaveLength(0)
  })

  it('stops before the first run', async () => {
    const w = setup({ rows: [row(1)] })
    w.links.start()
    w.links.stop()
    expect(w.timers.live()).toHaveLength(0)
    expect(w.store.selections).toEqual([])
  })

  it('does nothing if a timer it cleared fires anyway', async () => {
    const w = setup({ rows: [row(1)] })
    w.links.start()
    w.links.stop()
    w.timers.jobs[0].fn()
    await settle()
    expect(w.store.selections).toEqual([])
    expect(w.timers.live()).toHaveLength(0)
  })

  it('does not schedule another run when it is stopped during one', async () => {
    const w = setup()
    let release
    w.store.holds.attachmentsToRefresh = new Promise((resolve) => (release = resolve))
    w.links.start()
    w.timers.live()[0].fn()
    await settle()
    w.links.stop()
    release()
    await settle()
    expect(w.timers.live()).toHaveLength(0)
  })

  it('may be stopped when it was never started, and twice', () => {
    const w = setup()
    expect(() => w.links.stop()).not.toThrow()
    w.links.start()
    w.links.stop()
    expect(() => w.links.stop()).not.toThrow()
    expect(w.timers.live()).toHaveLength(0)
  })

  it('may be started again after it was stopped', async () => {
    const w = setup({ rows: [row(1)] })
    w.links.start()
    w.links.stop()
    w.links.start()
    expect(w.timers.live().map((j) => j.ms)).toEqual([0])
    await fire(w)
    expect(isFresh(held(w.store, 1), 1)).toBe(true)
    expect(w.timers.live().map((j) => j.ms)).toEqual([600_000])
  })

  it('is one chain of timers when it is stopped and started during a run', async () => {
    const w = setup()
    let release
    w.store.holds.attachmentsToRefresh = new Promise((resolve) => (release = resolve))
    w.links.start()
    w.timers.live()[0].fn()
    await settle()
    w.links.stop()
    w.links.start()
    expect(w.timers.live().map((j) => j.ms)).toEqual([0])
    w.timers.live()[0].over = true
    w.timers.jobs.at(-1).fn()
    release()
    await settle()
    expect(w.timers.live().map((j) => j.ms)).toEqual([600_000])
    expect(w.store.selections).toHaveLength(1)
  })

  it('uses the global timers and clock when it is given none', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const store = fakeStore({ rows: [row(1)] })
    const links = createLinkRefresh({ discord: fakeDiscord(), store, log: () => {} })
    links.start()
    expect(store.selections).toEqual([])
    await vi.advanceTimersByTimeAsync(0)
    expect(store.selections).toEqual([{ expiringBefore: T0 + 2 * HOUR, viewedSince: T0 - DAY, limit: 200 }])
    expect(isFresh(store.rows[0], 1)).toBe(true)
    await vi.advanceTimersByTimeAsync(599_999)
    expect(store.selections).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(store.selections).toHaveLength(2)
    links.stop()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(store.selections).toHaveLength(2)
  })
})

describe('createLinkRefresh', () => {
  const base = () => ({ discord: fakeDiscord(), store: fakeStore(), log: () => {} })

  it('answers start, stop, runOnce and refresh', () => {
    const links = createLinkRefresh(base())
    for (const name of ['start', 'stop', 'runOnce', 'refresh']) expect(links[name]).toBeTypeOf('function')
  })

  it.each([
    ['no discord', { discord: undefined }, 'discord.refreshUrls must be a function.'],
    ['a null discord', { discord: null }, 'discord.refreshUrls must be a function.'],
    ['a discord without refreshUrls', { discord: {} }, 'discord.refreshUrls must be a function.'],
    ['a discord whose refreshUrls is no function', { discord: { refreshUrls: 'x' } }, 'discord.refreshUrls must be a function.'],
    ['no store', { store: undefined }, 'store.attachmentsToRefresh must be a function.'],
    ['a null store', { store: null }, 'store.attachmentsToRefresh must be a function.'],
    ['a store without attachmentsToRefresh', { store: { updateAttachmentUrls() {}, pruneTombstones() {} } }, 'store.attachmentsToRefresh must be a function.'],
    ['a store without updateAttachmentUrls', { store: { attachmentsToRefresh() {}, pruneTombstones() {} } }, 'store.updateAttachmentUrls must be a function.'],
    ['a store without pruneTombstones', { store: { attachmentsToRefresh() {}, updateAttachmentUrls() {} } }, 'store.pruneTombstones must be a function.'],
    ['a now that is no function', { now: 5 }, 'now must be a function.'],
    ['a null now', { now: null }, 'now must be a function.'],
    ['a log that is no function', { log: 'console' }, 'log must be a function.'],
    ['a null log', { log: null }, 'log must be a function.'],
    ['timers without setTimeout', { timers: { clearTimeout() {} } }, 'timers must have a setTimeout and a clearTimeout function.'],
    ['timers without clearTimeout', { timers: { setTimeout() {} } }, 'timers must have a setTimeout and a clearTimeout function.'],
    ['no timers at all', { timers: null }, 'timers must have a setTimeout and a clearTimeout function.'],
  ])('refuses %s with a TypeError', (_, over, message) => {
    expect(() => createLinkRefresh({ ...base(), ...over })).toThrow(new TypeError(message))
  })

  it('refuses no options at all', () => {
    expect(() => createLinkRefresh()).toThrow(new TypeError('discord.refreshUrls must be a function.'))
    expect(() => createLinkRefresh({})).toThrow(new TypeError('discord.refreshUrls must be a function.'))
  })

  it.each([
    ['intervalMs', 0, 2_147_483_647],
    ['intervalMs', -1, 2_147_483_647],
    ['intervalMs', 1.5, 2_147_483_647],
    ['intervalMs', NaN, 2_147_483_647],
    ['intervalMs', Infinity, 2_147_483_647],
    ['intervalMs', '600000', 2_147_483_647],
    ['intervalMs', null, 2_147_483_647],
    ['intervalMs', 2_147_483_648, 2_147_483_647],
    ['aheadMs', 0, 31_536_000_000],
    ['aheadMs', -1, 31_536_000_000],
    ['aheadMs', 0.5, 31_536_000_000],
    ['aheadMs', NaN, 31_536_000_000],
    ['aheadMs', Infinity, 31_536_000_000],
    ['aheadMs', '7200000', 31_536_000_000],
    ['aheadMs', null, 31_536_000_000],
    ['aheadMs', 31_536_000_001, 31_536_000_000],
    ['viewedWithinMs', 0, 31_536_000_000],
    ['viewedWithinMs', -1, 31_536_000_000],
    ['viewedWithinMs', 0.5, 31_536_000_000],
    ['viewedWithinMs', NaN, 31_536_000_000],
    ['viewedWithinMs', Infinity, 31_536_000_000],
    ['viewedWithinMs', '86400000', 31_536_000_000],
    ['viewedWithinMs', null, 31_536_000_000],
    ['viewedWithinMs', 31_536_000_001, 31_536_000_000],
  ])('refuses a %s of %j with a RangeError', (name, value, max) => {
    expect(() => createLinkRefresh({ ...base(), [name]: value })).toThrow(
      new RangeError(`${name} must be a whole number of milliseconds from 1 to ${max}.`),
    )
  })

  it.each([
    ['intervalMs', 1],
    ['intervalMs', 2_147_483_647],
    ['aheadMs', 1],
    ['aheadMs', 31_536_000_000],
    ['viewedWithinMs', 1],
    ['viewedWithinMs', 31_536_000_000],
  ])('takes a %s of %i', (name, value) => {
    expect(() => createLinkRefresh({ ...base(), [name]: value })).not.toThrow()
  })
})
