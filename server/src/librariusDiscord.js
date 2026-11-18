/**
 * The Librarius's own calls to Discord's REST API, with the bot token. Almost all of them read. The writes are the POST of
 * refreshUrls, which only asks for new links to files Discord already holds, and the two calls the outbox makes (batch 2):
 * setArchived and deleteMessage. Nothing the site's members write goes through here: that is the webhook's.
 *
 * gatewayBot()  → { url, remaining, resetAfterMs }: where to connect, and how many connects are left in this window.
 * guild() / channel(id) → the raw object.
 * activeThreads() → the raw threads of the guild that are not archived.
 * archivedThreads(forumId, before | null) → { threads, hasMore }: one page of up to 100 archived public threads of a
 *   forum, newest first. `before` is the archive time of the oldest thread of the page before; null starts at the newest.
 * messagesAfter(channelId, afterId, limit = 100) → raw messages, oldest first: sorted by id here, whatever order Discord
 *   answered in (it answers newest first). afterId is a message id, or '0' for the start of the channel.
 * newest(channelId, limit = 100) → raw messages as Discord gives them, newest first.
 *   Both make the page Upstream when a message of it has an id that is not a Discord id: it cannot be put in order, and a
 *   page that may be missing an entry is not one the catch-up can tell what Discord holds from.
 * thread(id) → the raw thread, or null (404 Unknown Channel, code 10003; any other 404 is Upstream).
 *   channel(id) is Upstream for a deleted thread, as for any other failure; the import has to tell the two apart before it
 *   deletes a post.
 * message(channelId, id) → the raw message, or null (404 Unknown Message, code 10008; any other 404 is Upstream).
 * emojis() → the guild's raw emoji.
 * applicationCommands(applicationId) → the raw commands the application has in the guild (`GET /applications/<app>/guilds/<id>/commands`).
 * createMessageCommand(applicationId, name) → true once the guild has a message command (type 3) of that name, false when Discord
 *   refuses with 403 (the bot may not make commands in this server); any other failure is Upstream. It creates one command and never
 *   overwrites the list, since other commands may be there ("Delete on site" is made this way, librariusCommand.js).
 * interactionCallback(interactionId, token, body) → undefined once Discord took the reply to an interaction (`POST /interactions/<id>/
 *   <token>/callback`, which must come within 3 seconds of the interaction). `token` is the interaction's, and goes only in the address:
 *   no error says it. The callback needs no authority of the bot's, and is counted by the limits as the route of that interaction.
 * autoModRules() → the guild's raw AutoMod rules (`GET /guilds/<id>/auto-moderation/rules`, which the bot may read with Manage Server).
 *   A site reply is checked against them before it is sent (librariusSend.js automodMatcher).
 * setArchived(threadId, archived) → true when the thread was set (`PATCH /channels/<id>` with `{ archived }`), false when
 *   Discord refused with 403 (the thread is locked, or the bot may not manage it); any other failure is Upstream. The outbox
 *   unarchives a thread to edit in it, and archives it again.
 * deleteMessage(channelId, messageId) → undefined once the message is gone: deleted, or already not there (404 Unknown
 *   Message, code 10008). It is how a message that a person wrote in Discord is deleted from the site. Any other failure is
 *   Upstream, and so is a 404 of another code (Unknown Channel, say).
 * refreshUrls(urls) → Map of each link Discord refreshed to its new one. At most 50 links, or RangeError. A link
 *   Discord did not refresh is not in the Map, and neither is one it answered with that is not on Discord's CDN
 *   attachments path: a refreshed link is stored and handed to a browser, so it has to pass the check an attachment's
 *   url passes when a message is parsed (attachmentUrl, in librariusParse), and it comes back as that check
 *   normalises it. The caller's old link stays for any that is left out.
 * withMaxWait(ms) → the same client, for a caller that will wait that long for its turn (see below). It has every call
 *   above and shares everything with this client: the calls a second, what it knows of the buckets and a pause for a
 *   global 429. It is the only difference.
 *
 * Ids are strings of 17 to 20 digits, a limit is a whole number from 1 to 100, and anything else is a TypeError or
 * RangeError before a request: an id goes into the url, so it must be nothing but digits.
 *
 * Rate limits, so the Librarius never crowds the other features off Discord's 50 calls a second:
 * - At most `perSecond` calls in any second across the whole client, counting retries and calls that fail. A call
 *   that would be one too many waits for the oldest of the last `perSecond` to be a second old, unless that is more than
 *   `maxWaitMs` (5 seconds unless the options say otherwise) away: then it is an Upstream at once, which sends nothing
 *   and takes no place in the queue. Without that, calls made faster than they can go would queue for ever. A caller
 *   that can wait longer, such as the import, asks for `withMaxWait(ms)`. A wait for a bucket or for a 429 is not
 *   counted against `maxWaitMs`: each has its own cap of 30 seconds.
 * - Discord says which bucket an answer counted against (X-RateLimit-Bucket). The client remembers the bucket of each
 *   route; when an answer says none are left (X-RateLimit-Remaining 0), the next call to that bucket waits
 *   X-RateLimit-Reset-After seconds. A bucket is the name Discord gives plus the channel or guild in the path, which
 *   Discord counts apart. A route is the method and path with the message id left out of it, so every message of a
 *   channel is one route; the query is not part of it.
 * - A 429 waits Retry-After seconds and retries once; a second 429 is Upstream. No wait is longer than 30 seconds, so
 *   a header that says an hour cannot park the Librarius. A missing or odd header waits a second. A 429 that says it is
 *   global (X-RateLimit-Global: true) is Discord's limit for the whole bot, not for one route, so every call made
 *   in that time waits for it too, not only the one that was refused.
 *
 * gatewayBot() takes the address only as one the gateway client can connect to: wss://, or ws:// as well when apiBase
 * is http:// (the e2e mock), and a session start limit that resets in more than a day (the longest window Discord
 * uses) is not Discord talking.
 *
 * Every failure is Upstream, whose message names a status at most: never the token, a url or anything Discord said.
 * That covers a network error or a timeout, a status other than 200, a reply that is not the JSON it should be, and a
 * client that is not configured (an empty apiBase or botToken, or a guildId that is not an id).
 */
import { Upstream } from './discordRoles.js'
import { attachmentUrl } from './librariusParse.js'
import { isId } from './librariusText.js'

// An after cursor is a message id, or '0' for before the first message.
const CURSOR = /^\d{1,20}$/
const WSS_ONLY = /^wss:\/\//
const WS_OR_WSS = /^wss?:\/\//
// The longest window Discord resets a session start limit in.
const MAX_SESSION_RESET_MS = 86_400_000
const MAX_WAIT_S = 30
const WINDOW_MS = 1000
const MAX_PAGE = 100
const MAX_REFRESH = 50
const MAX_COMMAND_NAME = 32
const MESSAGE_COMMAND = 3 // the type of a command that shows in the Apps menu of a message
const INTERACTION_TOKEN = /^[A-Za-z0-9._-]{1,512}$/
const UNKNOWN_MESSAGE = 10008 // Discord's JSON error code for a message that does not exist
const UNKNOWN_CHANNEL = 10003 // and for a channel, a thread included

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const isList = (v) => Array.isArray(v) && v.every(isObject)

const refused = (status, what) => new Upstream(`Discord answered ${status} for ${what}.`)
const unusable = (what) => new Upstream(`Discord answered 200 for ${what}, but not with what the Librarius expected.`)

function needId(value, name) {
  if (!isId(value)) throw new TypeError(`${name} must be a Discord id.`)
}

function needMaxWait(ms) {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError('maxWaitMs must be a number of at least 0.')
  return ms
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
  maxWaitMs = 5_000,
}) {
  if (!Number.isSafeInteger(perSecond) || perSecond < 1) throw new RangeError('perSecond must be a whole number of at least 1.')
  needMaxWait(maxWaitMs)
  const configured = [apiBase, botToken].every((v) => typeof v === 'string' && v !== '') && isId(guildId)

  // When each of the last perSecond calls goes (or went) out, oldest first. A call takes its place here before it waits
  // for it, so calls made together are spaced out and do not all see the same free second.
  const sends = []
  // The bucket each route was last counted against, and when each bucket that had none left opens again.
  const bucketOf = new Map()
  const opensAt = new Map()
  // When a global 429 lets every call go again, on the clock `now` reads.
  let pausedUntil = 0

  async function request(url, init) {
    try {
      return await fetchImpl(url, init)
    } catch {
      // Network error, abort or timeout. Drop the original: its message can carry the url.
      throw new Upstream('Discord is unreachable.')
    }
  }

  // Waits for the global pause and for the route's bucket, whichever opens later.
  async function waitForOpening(routeKey) {
    const opens = Math.max(pausedUntil, opensAt.get(bucketOf.get(routeKey)) ?? 0)
    const wait = opens - now()
    if (wait > 0) await sleep(wait)
  }

  async function waitForTurn(maxWait) {
    const t = now()
    const due = sends.length < perSecond ? t : Math.max(t, sends[0] + WINDOW_MS)
    // Before the place is taken, so that a call turned away leaves the queue as it was.
    if (due - t > maxWait) throw new Upstream('Too many Librarius calls are waiting to reach Discord.')
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

  /** One call, within the limits and willing to wait `maxWait` ms for its turn. → { status, json }, json null when the body is not JSON. Never a 429. */
  async function sendWithin(maxWait, method, path, { route = path.split('?')[0], headers, body } = {}) {
    if (!configured) throw new Upstream('Librarius reads are not configured.')
    const routeKey = `${method} ${route}`
    for (let attempt = 1; ; attempt++) {
      await waitForOpening(routeKey)
      await waitForTurn(maxWait)
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
      const retryAfter = waitMs(res, 'Retry-After')
      // A global limit is Discord's for the whole bot, so every call waits it out, not only this one.
      if (res.headers.get('X-RateLimit-Global') === 'true') pausedUntil = Math.max(pausedUntil, now() + retryAfter)
      await res.body?.cancel()
      if (attempt === 2) throw new Upstream('Discord is rate limiting the Librarius.')
      await sleep(retryAfter)
    }
  }

  /** The calls, for a caller that will wait `maxWait` ms for its turn. They all share the state above. */
  function reader(maxWait) {
    const send = (method, path, options) => sendWithin(maxWait, method, path, options)

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

    // A page of messages, every one with an id. An entry that has none cannot be put in order, and a page with one is not
    // whole: the catch-up deletes what it does not find on a page, so a page that may be missing an entry is not read at all.
    async function getMessages(path) {
      const page = await getList(path, 'a page of messages')
      if (!page.every((m) => isId(m.id))) throw unusable('a page of messages')
      return page
    }

    const guildPath = `/v10/guilds/${guildId}`
    const messagesPath = (channelId) => `/v10/channels/${channelId}/messages`

    return {
      async gatewayBot() {
        const body = await getObject('/v10/gateway/bot', 'the gateway')
        const limit = body.session_start_limit
        // Only wss:// is a gateway Discord runs. The e2e mock is plain http and so is its gateway, so ws:// is allowed there.
        const schemes = apiBase.startsWith('http://') ? WS_OR_WSS : WSS_ONLY
        if (
          typeof body.url !== 'string' ||
          !schemes.test(body.url) ||
          !isObject(limit) ||
          !Number.isSafeInteger(limit.remaining) ||
          limit.remaining < 0 ||
          !Number.isFinite(limit.reset_after) ||
          limit.reset_after < 0 ||
          limit.reset_after > MAX_SESSION_RESET_MS
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

      async thread(id) {
        needId(id, 'threadId')
        const { status, json } = await send('GET', `/v10/channels/${id}`)
        // Only Unknown Channel means the thread is gone; a thread the bot cannot see (403) or any failure of Discord's
        // would otherwise read as a thread deleted, and a deleted thread takes its messages and read marks with it.
        if (status === 404 && json?.code === UNKNOWN_CHANNEL) return null
        if (status !== 200) throw refused(status, 'a thread')
        if (!isObject(json)) throw unusable('a thread')
        return json
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
        const page = await getMessages(`${messagesPath(channelId)}?limit=${limit}&after=${afterId}`)
        // Discord answers newest first, but the import's cursor moves to the last message of the page, so the order is the
        // client's to guarantee and not Discord's to promise.
        return page.sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)))
      },

      async newest(channelId, limit = MAX_PAGE) {
        needId(channelId, 'channelId')
        needLimit(limit)
        return getMessages(`${messagesPath(channelId)}?limit=${limit}`)
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

      autoModRules: () => getList(`${guildPath}/auto-moderation/rules`, 'the AutoMod rules'),

      async applicationCommands(applicationId) {
        needId(applicationId, 'applicationId')
        return getList(`/v10/applications/${applicationId}/guilds/${guildId}/commands`, "the application's commands")
      },

      async createMessageCommand(applicationId, name) {
        needId(applicationId, 'applicationId')
        if (typeof name !== 'string' || name.length < 1 || name.length > MAX_COMMAND_NAME) throw new TypeError(`name must be a text of 1 to ${MAX_COMMAND_NAME} characters.`)
        const { status } = await send('POST', `/v10/applications/${applicationId}/guilds/${guildId}/commands`, {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, type: MESSAGE_COMMAND }),
        })
        if (status === 200 || status === 201) return true
        // The bot may not make commands in this server: a thing for the owner to put right, not a failure of Discord's.
        if (status === 403) return false
        throw refused(status, 'a command')
      },

      async interactionCallback(interactionId, token, body) {
        needId(interactionId, 'interactionId')
        if (typeof token !== 'string' || !INTERACTION_TOKEN.test(token)) throw new TypeError('token must be an interaction token.')
        if (!isObject(body)) throw new TypeError('body must be an object.')
        // The token is the credential of this one interaction: it goes in the address and nowhere else, and not into the route, which is
        // what the limits are counted by. A callback has a bucket of its own for each interaction, so each interaction is its own route.
        const { status } = await send('POST', `/v10/interactions/${interactionId}/${token}/callback`, {
          route: `/v10/interactions/${interactionId}/:token/callback`,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (status !== 204 && status !== 200) throw refused(status, 'an interaction reply')
      },

      async setArchived(threadId, archived) {
        needId(threadId, 'threadId')
        if (typeof archived !== 'boolean') throw new TypeError('archived must be true or false.')
        const { status } = await send('PATCH', `/v10/channels/${threadId}`, {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived }),
        })
        if (status === 403) return false
        if (status !== 200) throw refused(status, 'a thread change')
        return true
      },

      async deleteMessage(channelId, messageId) {
        needId(channelId, 'channelId')
        needId(messageId, 'messageId')
        const { status, json } = await send('DELETE', `${messagesPath(channelId)}/${messageId}`, { route: `${messagesPath(channelId)}/:id` })
        // Gone is what a delete is for, but only a gone message: another 404 (Unknown Channel) is not one.
        if (status === 204 || (status === 404 && json?.code === UNKNOWN_MESSAGE)) return
        throw refused(status, 'a message delete')
      },

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
        // A link that is not on the CDN attachments path is left out, as the parser leaves out an attachment with one.
        const kept = list.map((e) => [e.original, attachmentUrl(e.refreshed)]).filter(([, link]) => link !== null)
        return new Map(kept)
      },

      withMaxWait: (ms) => reader(needMaxWait(ms)),
    }
  }

  return reader(maxWaitMs)
}
