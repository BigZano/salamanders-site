/**
 * The Librarius's own reads of Discord's REST API, with the bot token. Nothing here writes to Discord: the one POST,
 * refreshUrls, only asks for new links to files Discord already holds.
 *
 * gatewayBot()  → { url, remaining, resetAfterMs }: where to connect, and how many connects are left in this window.
 * guild() / channel(id) → the raw object.
 * activeThreads() → the raw threads of the guild that are not archived.
 * archivedThreads(forumId, before | null) → { threads, hasMore }: one page of up to 100 archived public threads of a
 *   forum, newest first. `before` is the archive time of the oldest thread of the page before; null starts at the newest.
 * messagesAfter(channelId, afterId, limit = 100) → raw messages, oldest first (Discord answers newest first). afterId is
 *   a message id, or '0' for the start of the channel.
 * newest(channelId, limit = 100) → raw messages as Discord gives them, newest first.
 * message(channelId, id) → the raw message, or null (404 Unknown Message, code 10008; any other 404 is Upstream).
 * emojis() → the guild's raw emoji.
 * refreshUrls(urls) → Map of each link Discord refreshed to its new one. At most 50 links, or RangeError. A link
 *   Discord did not refresh is not in the Map.
 *
 * Ids are strings of 17 to 20 digits, a limit is a whole number from 1 to 100, and anything else is a TypeError or
 * RangeError before a request: an id goes into the url, so it must be nothing but digits.
 *
 * Rate limits, so the Librarius never crowds the other features off Discord's 50 calls a second:
 * - At most `perSecond` calls in any second across the whole client, counting retries and calls that fail. A call
 *   that would be one too many waits for the oldest of the last `perSecond` to be a second old.
 * - Discord says which bucket an answer counted against (X-RateLimit-Bucket). The client remembers the bucket of each
 *   route; when an answer says none are left (X-RateLimit-Remaining 0), the next call to that bucket waits
 *   X-RateLimit-Reset-After seconds. A bucket is the name Discord gives plus the channel or guild in the path, which
 *   Discord counts apart. A route is the method and path with the message id left out of it, so every message of a
 *   channel is one route; the query is not part of it.
 * - A 429 waits Retry-After seconds and retries once; a second 429 is Upstream. No wait is longer than 30 seconds, so
 *   a header that says an hour cannot park the Librarius. A missing or odd header waits a second.
 *
 * Every failure is Upstream, whose message names a status at most: never the token, a url or anything Discord said.
 * That covers a network error or a timeout, a status other than 200, a reply that is not the JSON it should be, and a
 * client that is not configured (an empty apiBase or botToken, or a guildId that is not an id).
 */
import { Upstream } from './discordRoles.js'

const SNOWFLAKE = /^\d{17,20}$/
// An after cursor is a message id, or '0' for before the first message.
const CURSOR = /^\d{1,20}$/
const GATEWAY_URL = /^wss?:\/\//
const MAX_WAIT_S = 30
const WINDOW_MS = 1000
const MAX_PAGE = 100
const MAX_REFRESH = 50
const UNKNOWN_MESSAGE = 10008 // Discord's JSON error code for a message that does not exist

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const isList = (v) => Array.isArray(v) && v.every(isObject)

const refused = (status, what) => new Upstream(`Discord answered ${status} for ${what}.`)
const unusable = (what) => new Upstream(`Discord answered 200 for ${what}, but not with what the Librarius expected.`)

function needId(value, name) {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value)) throw new TypeError(`${name} must be a Discord id.`)
}

function needLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new RangeError(`limit must be a whole number from 1 to ${MAX_PAGE}.`)
}

// The wait a header asks for, in ms: seconds, possibly fractional. A missing or odd one waits a second.
function waitMs(res, header) {
  const s = Number.parseFloat(res.headers.get(header))
  return Math.min(Number.isFinite(s) && s >= 0 ? s : 1, MAX_WAIT_S) * 1000
}

export function createLibrariusDiscord({
  fetchImpl = fetch,
  apiBase,
  botToken,
  guildId,
  timeoutMs = 10_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  perSecond = 5,
}) {
  if (!Number.isSafeInteger(perSecond) || perSecond < 1) throw new RangeError('perSecond must be a whole number of at least 1.')
  const configured = [apiBase, botToken].every((v) => typeof v === 'string' && v !== '') && typeof guildId === 'string' && SNOWFLAKE.test(guildId)

  // When each of the last perSecond calls goes (or went) out, oldest first. A call takes its place here before it waits
  // for it, so calls made together are spaced out and do not all see the same free second.
  const sends = []
  // The bucket each route was last counted against, and when each bucket that had none left opens again.
  const bucketOf = new Map()
  const opensAt = new Map()

  async function request(url, init) {
    try {
      return await fetchImpl(url, init)
    } catch {
      // Network error, abort or timeout. Drop the original: its message can carry the url.
      throw new Upstream('Discord is unreachable.')
    }
  }

  async function waitForBucket(routeKey) {
    const wait = (opensAt.get(bucketOf.get(routeKey)) ?? 0) - now()
    if (wait > 0) await sleep(wait)
  }

  async function waitForTurn() {
    const t = now()
    const due = sends.length < perSecond ? t : Math.max(t, sends[0] + WINDOW_MS)
    sends.push(due)
    if (sends.length > perSecond) sends.shift()
    if (due > t) await sleep(due - t)
  }

  function learn(routeKey, route, res) {
    const name = res.headers.get('X-RateLimit-Bucket')
    if (!name) return
    // '/v10/channels/<id>/…' → 'channels/<id>': the major parameter, which Discord counts a bucket apart for.
    // Stryker disable next-line StringLiteral: the separator only keeps the two parts apart; the key is as unique without it
    const key = `${name} ${route.split('/').slice(2, 4).join('/')}`
    bucketOf.set(routeKey, key)
    if (Number.parseFloat(res.headers.get('X-RateLimit-Remaining')) === 0) opensAt.set(key, now() + waitMs(res, 'X-RateLimit-Reset-After'))
  }

  /** One call, within the limits. → { status, json }, json null when the body is not JSON. Never a 429. */
  async function send(method, path, { route = path.split('?')[0], headers, body } = {}) {
    if (!configured) throw new Upstream('Librarius reads are not configured.')
    const routeKey = `${method} ${route}`
    for (let attempt = 1; ; attempt++) {
      await waitForBucket(routeKey)
      await waitForTurn()
      // The timeout starts here, so neither a wait for a turn nor an earlier try uses any of it up.
      const res = await request(`${apiBase}${path}`, {
        method,
        headers: { ...headers, Authorization: `Bot ${botToken}` },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      learn(routeKey, route, res)
      // Stryker disable next-line ArrowFunction: a body that is not JSON reads as null or as undefined; every reader treats the two alike
      if (res.status !== 429) return { status: res.status, json: await res.json().catch(() => null) }
      await res.body?.cancel()
      if (attempt === 2) throw new Upstream('Discord is rate limiting the Librarius.')
      await sleep(waitMs(res, 'Retry-After'))
    }
  }

  async function getOk(path, what) {
    const { status, json } = await send('GET', path)
    if (status !== 200) throw refused(status, what)
    return json
  }

  async function getObject(path, what) {
    const json = await getOk(path, what)
    if (!isObject(json)) throw unusable(what)
    return json
  }

  async function getList(path, what) {
    const json = await getOk(path, what)
    if (!isList(json)) throw unusable(what)
    return json
  }

  const guildPath = `/v10/guilds/${guildId}`
  const messagesPath = (channelId) => `/v10/channels/${channelId}/messages`

  return {
    async gatewayBot() {
      const body = await getObject('/v10/gateway/bot', 'the gateway')
      const limit = body.session_start_limit
      if (
        typeof body.url !== 'string' ||
        !GATEWAY_URL.test(body.url) ||
        !isObject(limit) ||
        !Number.isSafeInteger(limit.remaining) ||
        limit.remaining < 0 ||
        !Number.isFinite(limit.reset_after) ||
        limit.reset_after < 0
      ) {
        throw unusable('the gateway')
      }
      return { url: body.url, remaining: limit.remaining, resetAfterMs: limit.reset_after }
    },

    guild: () => getObject(guildPath, 'the guild'),

    async channel(id) {
      needId(id, 'channelId')
      return getObject(`/v10/channels/${id}`, 'a channel')
    },

    async activeThreads() {
      const body = await getObject(`${guildPath}/threads/active`, 'the active threads')
      if (!isList(body.threads)) throw unusable('the active threads')
      return body.threads
    },

    async archivedThreads(forumId, before) {
      needId(forumId, 'forumId')
      if (before !== null && (typeof before !== 'string' || Number.isNaN(Date.parse(before)))) throw new TypeError('before must be a time, or null.')
      const after = before === null ? '' : `&before=${encodeURIComponent(before)}`
      const body = await getObject(`/v10/channels/${forumId}/threads/archived/public?limit=${MAX_PAGE}${after}`, 'the archived threads')
      if (!isList(body.threads) || typeof body.has_more !== 'boolean') throw unusable('the archived threads')
      return { threads: body.threads, hasMore: body.has_more }
    },

    async messagesAfter(channelId, afterId, limit = MAX_PAGE) {
      needId(channelId, 'channelId')
      if (typeof afterId !== 'string' || !CURSOR.test(afterId)) throw new TypeError('afterId must be a message id, or 0.')
      needLimit(limit)
      const page = await getList(`${messagesPath(channelId)}?limit=${limit}&after=${afterId}`, 'a page of messages')
      return page.reverse()
    },

    async newest(channelId, limit = MAX_PAGE) {
      needId(channelId, 'channelId')
      needLimit(limit)
      return getList(`${messagesPath(channelId)}?limit=${limit}`, 'a page of messages')
    },

    async message(channelId, id) {
      needId(channelId, 'channelId')
      needId(id, 'messageId')
      const { status, json } = await send('GET', `${messagesPath(channelId)}/${id}`, { route: `${messagesPath(channelId)}/:id` })
      // Only Unknown Message means the message is gone; any other 404 (Unknown Channel, say) would
      // otherwise read as every message deleted.
      if (status === 404 && json?.code === UNKNOWN_MESSAGE) return null
      if (status !== 200) throw refused(status, 'a message')
      if (!isObject(json)) throw unusable('a message')
      return json
    },

    emojis: () => getList(`${guildPath}/emojis`, 'the emoji'),

    async refreshUrls(urls) {
      if (!Array.isArray(urls) || !urls.every((u) => typeof u === 'string')) throw new TypeError('urls must be a list of strings.')
      if (urls.length > MAX_REFRESH) throw new RangeError(`At most ${MAX_REFRESH} links can be refreshed at once.`)
      if (urls.length === 0) return new Map()
      const { status, json } = await send('POST', '/v10/attachments/refresh-urls', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attachment_urls: urls }),
      })
      if (status !== 200) throw refused(status, 'an attachment refresh')
      const list = json?.refreshed_urls
      if (!Array.isArray(list) || !list.every((e) => isObject(e) && typeof e.original === 'string' && typeof e.refreshed === 'string')) throw unusable('an attachment refresh')
      return new Map(list.map((e) => [e.original, e.refreshed]))
    },
  }
}
