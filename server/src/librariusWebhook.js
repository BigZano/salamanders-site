/**
 * The Librarius's one webhook (batch 2): the client for the three calls the site makes with it, and the one builder of
 * everything it sends. Nothing else posts to Discord with the webhook, and nothing else builds the body of a message.
 *
 * sendBody({ form, part, username, avatarUrl, mentionIds }) → the JSON body of one message of a reply. `form` is 'v2' or
 *   'plain', `part` is one entry of the form's `toDiscord(...).parts`, `username` is the author's server name (1 to 80
 *   characters, already cleaned), `avatarUrl` is an https link or null (none), `mentionIds` the people the author picked.
 *   V2 is `{ flags: 32768, components }` and plain `{ flags: 4, content }` (4 is suppress-embeds), then `username`,
 *   `avatar_url` (when there is one) and always `allowed_mentions: { parse: [], users }`: nothing is ever parsed out of the
 *   text, so `@everyone`, `@here` and a role are never pinged, and `users` is the picked people, each once and at most 10.
 *   Bad input is a TypeError (a wrong kind of value) or a RangeError (a wrong value), and so is a part that is over what
 *   Discord takes (4000 displayable characters in V2, counting the button's label; 2000 of content in plain), so no
 *   message goes out that Discord would refuse for its length.
 *
 * createWebhookClient({ fetchImpl, url, apiBase, timeoutMs = 15000, newest }) → { id, send, edit, remove, recent }.
 *   `id` is the webhook's id, which is not secret (the token is): Discord names it as `webhook_id` on every message the webhook
 *   posts, so the site can tell those messages from the rest. It is read-only.
 *   `url` is LIBRARIUS_WEBHOOK_URL (see parseWebhookUrl); the calls go to `${apiBase}/v10/webhooks/<id>/<token>`. `newest` is
 *   the bot client's `newest(channelId, limit)`, for recent() only. Every thread and message id is checked to be a Discord
 *   id before anything is sent, a bad one being a TypeError. Each call is one request, with `timeoutMs`, that never follows
 *   a redirect. The client does not sleep and does not retry: what to do after a failure is the outbox's.
 *   send(threadId, body, files) → the message Discord made (`?wait=true&thread_id=&with_components=true`). `body` is
 *     what sendBody built, and only that: any body whose `allowed_mentions` is not `{ parse: [], users: [≤10 ids] }`, or
 *     that holds a field sendBody never sets (`thread_name` would make a new post: the site never makes one), or whose
 *     `flags` and content do not go together (4 with `content` and no `components`, 32768 with `components` and no `content`),
 *     or whose `username` or `avatar_url` is not one sendBody would take, is a RangeError. `files` is [{ name, type, bytes }]: at most 10, each a plain file name, one of the four picture types
 *     (image/png, image/jpeg, image/webp, image/gif) and some bytes. With files the call is multipart: the body, with the
 *     list of files added to it, as `payload_json`, then `files[0]`, `files[1]`…
 *   edit(threadId, messageId, body) → the message. Idempotent. The `username` and `avatar_url` of the body are left out:
 *     an edit cannot change who wrote the message.
 *   remove(threadId, messageId) → undefined. Idempotent: a message that is already gone (404, code 10008) is done.
 *   recent(threadId, limit = 20) → the newest messages of the thread that this webhook posted, newest first, through
 *     `newest` (a TypeError when the client was made without it). It is how the outbox finds out whether a send that
 *     answered `unknown` did land. The thread is checked like any other (a TypeError), and the limit is a whole number from 1 to
 *     100 (a TypeError, or a RangeError). A page that is no list is a WebhookError with no status, and an entry of it that is no
 *     message is left out.
 *
 * Failures are a WebhookError { status, code, fatal, blocked, unknown, threadGone, messageGone, retryAfterMs, global }.
 * `status` is the HTTP status (null when Discord did not answer), `code` Discord's JSON error code when it gave a whole
 * number (else null), and the flags say what to do. A flag is false unless it says otherwise here:
 * - 429, on any call: `retryAfterMs`, from `retry_after` of the body (seconds, fractional) or else the Retry-After header,
 *   else 1000, at most an hour; `global` when the body or X-RateLimit-Global says so. A 429 was not accepted, so a resend
 *   is safe: it is never `unknown`.
 * - `unknown`, on send only: the message may have landed. A timeout, any error the fetch throws (reset, refused, DNS, a
 *   redirect), a 5xx, any status that is neither 2xx nor 4xx, and a 2xx that carries no message. The outbox looks at
 *   recent() before it resends; saying `unknown` too often costs a look, saying it too seldom would post twice. On edit
 *   and remove the same failures are plain failures, status null for no answer: repeating them does no harm.
 * - `blocked`: Discord refused the message by its code: 200000 (message blocked by automatic moderation), 200001 (title blocked by
 *   automatic moderation) or 240000 (message blocked by the harmful links filter). Never retried.
 * - `fatal`: the webhook itself is refused or gone: 401 (whatever the code), or 404 with any code but 10003 and 10008
 *   (Unknown Webhook is 10015; an answer with no code, such as a proxy's, counts too). The outbox stops everything.
 * - `threadGone`: 404 with code 10003 (Unknown Channel): the thread is gone, not the webhook.
 * - `messageGone`: 404 with code 10008 (Unknown Message): the message is gone, not the webhook.
 * - Any other 4xx has only its status and code (400 with code 50083 is an archived thread, say).
 * A WebhookError's text is one of three fixed sentences with the call and the status: it holds nothing Discord said, and
 * never the address or the token, which are secrets. It has no `cause`. The same goes for every other error thrown here.
 *
 * parseWebhookUrl(url, apiBase) → { id, token }: `url` has to be, in full, https://discord.com/api/webhooks/<id>/<token>,
 *   the id 17 to 20 digits and the token 8 to 200 of A-Z a-z 0-9 _ -; or, when `apiBase` is http:// (the e2e mock), that
 *   origin followed by /api/webhooks/<id>/<token>. Anything else, a space or a query or a look-alike host included, is a
 *   RangeError that says nothing of what it was given (a value that is not text is a TypeError).
 * webhookUrl(apiBase, id, token) → the address of a webhook Discord has just made, as parseWebhookUrl takes it back (an id
 *   or a token that is not text is a TypeError, one it would not take a RangeError).
 */
import { FORMS, displayableLength } from './librariusForm.js'
import { isId } from './librariusText.js'

const REAL_PREFIX = 'https://discord.com/api/webhooks/'
// An http(s) address with a host, and what follows it. The origin is the first group.
const API_BASE = /^(https?:\/\/[^\s/?#]+)(?:\/[^\s?#]*)?$/
const TAIL = /^(\d{17,20})\/([A-Za-z0-9_-]{8,200})$/
const BAD_URL = 'The webhook address is not https://discord.com/api/webhooks/<id>/<token>.'

const V2_FLAG = 32768
const SUPPRESS_EMBEDS = 4
const MAX_USERNAME = 80
const MAX_AVATAR = 512
const MAX_MENTIONS = 10
const MAX_FILES = 10
// The most messages Discord gives of a thread in one page.
const MAX_RECENT = 100
// What Discord refuses a message over: the displayable text of a V2 message, the content of a plain one.
const HARD_LIMIT = { v2: 4000, plain: 2000 }
// An id that goes into allowed_mentions: canonical, with no leading zero.
const PERSON = /^[1-9]\d{16,19}$/
const AVATAR = /^https:\/\/[^\s<>/][^\s<>]*$/
const FILE_NAME = /^\w[\w.-]{0,99}$/
const FILE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
// The only fields a message of the site has.
const BODY_KEYS = new Set(['content', 'flags', 'components', 'username', 'avatar_url', 'allowed_mentions'])
const MENTION_KEYS = new Set(['parse', 'users'])
// Discord's codes for a message it refused to post: 200000 (blocked by AutoMod), 200001 (a title blocked by AutoMod), 240000 (blocked by
// the harmful links filter).
const BLOCKED = new Set([200000, 200001, 240000])
const UNKNOWN_CHANNEL = 10003
const UNKNOWN_MESSAGE = 10008
const MAX_WAIT_S = 3600

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const okName = (v) => typeof v === 'string' && v.length >= 1 && v.length <= MAX_USERNAME
const okAvatar = (v) => typeof v === 'string' && v.length <= MAX_AVATAR && AVATAR.test(v)

export class WebhookError extends Error {
  name = 'WebhookError'

  constructor(message, { status = null, code = null, fatal = false, blocked = false, unknown = false, threadGone = false, messageGone = false, retryAfterMs = null, global = false } = {}) {
    super(message)
    this.status = status
    this.code = code
    this.fatal = fatal
    this.blocked = blocked
    this.unknown = unknown
    this.threadGone = threadGone
    this.messageGone = messageGone
    this.retryAfterMs = retryAfterMs
    this.global = global
  }
}

/** → { origin, root } of an API base: where it starts, and the whole of it without the slashes that end it. */
function baseOf(apiBase) {
  if (typeof apiBase !== 'string') throw new TypeError('apiBase must be text.')
  const found = API_BASE.exec(apiBase)
  if (found === null) throw new RangeError('apiBase must be an http:// or https:// address.')
  return { origin: found[1], root: apiBase.replace(/\/+$/, '') }
}

/** → the address prefixes a webhook may have for this API base: the real one, and the mock's when the base is http. */
function prefixesFor(apiBase) {
  const { origin } = baseOf(apiBase)
  return origin.startsWith('http://') ? [REAL_PREFIX, `${origin}/api/webhooks/`] : [REAL_PREFIX]
}

export function parseWebhookUrl(url, apiBase) {
  const prefixes = prefixesFor(apiBase)
  if (typeof url !== 'string') throw new TypeError('The webhook address must be text.')
  const prefix = prefixes.find((p) => url.startsWith(p))
  const tail = prefix === undefined ? null : TAIL.exec(url.slice(prefix.length))
  if (tail === null) throw new RangeError(BAD_URL)
  return { id: tail[1], token: tail[2] }
}

export function webhookUrl(apiBase, id, token) {
  if (typeof id !== 'string' || typeof token !== 'string') throw new TypeError('The webhook id and token must be text.')
  const url = `${prefixesFor(apiBase).at(-1)}${id}/${token}`
  // Only an address that would be taken back is handed out.
  parseWebhookUrl(url, apiBase)
  return url
}

export function sendBody({ form, part, username, avatarUrl = null, mentionIds = [] }) {
  if (!FORMS.includes(form)) throw new RangeError('form must be "v2" or "plain".')
  if (!isObject(part)) throw new TypeError('part must be an object.')
  const body = {}
  if (form === 'v2') {
    if (!Array.isArray(part.components)) throw new TypeError('A v2 part must have components.')
    if (part.components.length === 0) throw new RangeError('A v2 part must have at least one component.')
    body.flags = V2_FLAG
    body.components = part.components
  } else {
    if (part.components !== null) throw new TypeError('A plain part has no components.')
    if (typeof part.text !== 'string') throw new TypeError('A plain part must have text.')
    if (part.text === '') throw new RangeError('A plain part must have some text.')
    body.flags = SUPPRESS_EMBEDS
    body.content = part.text
  }
  if (displayableLength(part) > HARD_LIMIT[form]) throw new RangeError(`A ${form} message holds at most ${HARD_LIMIT[form]} characters.`)

  if (typeof username !== 'string') throw new TypeError('username must be text.')
  if (!okName(username)) throw new RangeError(`username must be 1 to ${MAX_USERNAME} characters.`)
  body.username = username

  if (avatarUrl !== null) {
    if (typeof avatarUrl !== 'string') throw new TypeError('avatarUrl must be text or null.')
    if (!okAvatar(avatarUrl)) throw new RangeError(`avatarUrl must be an https link of at most ${MAX_AVATAR} characters.`)
    body.avatar_url = avatarUrl
  }

  if (!Array.isArray(mentionIds)) throw new TypeError('mentionIds must be a list.')
  for (const id of mentionIds) {
    if (typeof id !== 'string') throw new TypeError('A mention must be a Discord id.')
    if (!PERSON.test(id)) throw new RangeError('A mention must be a Discord id.')
  }
  body.allowed_mentions = { parse: [], users: [...new Set(mentionIds)].slice(0, MAX_MENTIONS) }
  return body
}

function needId(value, name) {
  if (!isId(value)) throw new TypeError(`${name} must be a Discord id.`)
}

/** → the body, when it is one sendBody could have built: only its fields, the flags that go with its content, its name and picture as sendBody takes them, and nobody parsed or pinged but the picked. */
function needBody(body) {
  if (!isObject(body)) throw new TypeError('The body must be one that sendBody built.')
  if (!Object.keys(body).every((key) => BODY_KEYS.has(key))) throw new RangeError('The body holds a field that sendBody never sets.')
  const shown = body.flags === V2_FLAG ? Array.isArray(body.components) && body.components.length > 0 && !Object.hasOwn(body, 'content') : body.flags === SUPPRESS_EMBEDS && typeof body.content === 'string' && body.content !== '' && !Object.hasOwn(body, 'components')
  if (!shown) throw new RangeError('The body must be a v2 message (flags 32768, components) or a plain one (flags 4, content), as sendBody builds them.')
  if (!okName(body.username) || (Object.hasOwn(body, 'avatar_url') && !okAvatar(body.avatar_url))) throw new RangeError('The body must carry the username and avatar_url that sendBody builds.')
  const mentions = body.allowed_mentions
  const users = isObject(mentions) ? mentions.users : undefined
  if (
    !isObject(mentions) ||
    !Object.keys(mentions).every((key) => MENTION_KEYS.has(key)) ||
    !Array.isArray(mentions.parse) ||
    mentions.parse.length !== 0 ||
    (users !== undefined && !(Array.isArray(users) && users.length <= MAX_MENTIONS && users.every((id) => typeof id === 'string' && PERSON.test(id))))
  ) {
    throw new RangeError('The body must carry the allowed_mentions that sendBody builds.')
  }
  return body
}

/** → the files, checked; none when there are none. */
function needFiles(files) {
  if (files === undefined || files === null) return []
  if (!Array.isArray(files)) throw new TypeError('files must be a list.')
  if (files.length > MAX_FILES) throw new RangeError(`At most ${MAX_FILES} files can be sent.`)
  for (const file of files) {
    if (!isObject(file)) throw new TypeError('A file must be { name, type, bytes }.')
    if (typeof file.name !== 'string' || typeof file.type !== 'string' || !(file.bytes instanceof Uint8Array)) throw new TypeError('A file must be { name, type, bytes }.')
    if (!FILE_NAME.test(file.name)) throw new RangeError('A file name must be a plain file name.')
    if (!FILE_TYPES.has(file.type)) throw new RangeError('A file must be a PNG, JPEG, WebP or GIF picture.')
    if (file.bytes.length === 0) throw new RangeError('A file must have some bytes.')
  }
  return files
}

// The body as multipart: the message with the list of its files, then the files themselves, as Discord reads them.
function multipart(body, files) {
  const form = new FormData()
  form.set('payload_json', JSON.stringify({ ...body, attachments: files.map((file, id) => ({ id, filename: file.name })) }))
  for (const [i, file] of files.entries()) form.set(`files[${i}]`, new Blob([file.bytes], { type: file.type }), file.name)
  return form
}

const isMessage = (value) => isObject(value) && isId(value.id)

/** → how long a 429 asks to wait, in ms: retry_after of the body, else the Retry-After header, else a second; at most an hour. */
function waitOf(json, res) {
  const fromBody = typeof json?.retry_after === 'number' ? json.retry_after : Number.NaN
  const fromHeader = Number.parseFloat(res.headers.get('Retry-After'))
  const seconds = [fromBody, fromHeader].find((s) => Number.isFinite(s) && s >= 0) ?? 1
  return Math.round(Math.min(seconds, MAX_WAIT_S) * 1000)
}

export function createWebhookClient({ fetchImpl = fetch, url, apiBase, timeoutMs = 15_000, newest } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be a number above 0.')
  if (newest !== undefined && typeof newest !== 'function') throw new TypeError('newest must be a function.')
  const { id, token } = parseWebhookUrl(url, apiBase)
  const root = `${baseOf(apiBase).root}/v10/webhooks/${id}/${token}`

  /** → the error of an answer that was not a success. `what` is the call: send, edit or delete. */
  function refusal(what, res, json) {
    const status = res.status
    const code = Number.isInteger(json?.code) ? json.code : null
    const text = `Discord answered ${status} to the webhook ${what}.`
    if (status === 429) {
      const global = json?.global === true || res.headers.get('X-RateLimit-Global') === 'true'
      return new WebhookError(text, { status, code, retryAfterMs: waitOf(json, res), global })
    }
    // Not a refusal Discord made: it may have done the work, so a send is unknown.
    if (status < 400 || status >= 500) return new WebhookError(text, { status, code, unknown: what === 'send' })
    const blocked = BLOCKED.has(code)
    const threadGone = status === 404 && code === UNKNOWN_CHANNEL
    const messageGone = status === 404 && code === UNKNOWN_MESSAGE
    const fatal = !blocked && (status === 401 || (status === 404 && !threadGone && !messageGone))
    return new WebhookError(text, { status, code, fatal, blocked, threadGone, messageGone })
  }

  /** One request → { status, json } of a success (json null when the answer has no JSON). Anything else is a WebhookError. */
  async function call(what, method, path, query, { headers = {}, body } = {}) {
    let res
    try {
      res = await fetchImpl(`${root}${path}?${query}`, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
    } catch {
      // The reason may carry the address, and so the token: it is dropped. A send that got no answer may have landed.
      throw new WebhookError(`The webhook ${what} got no answer from Discord.`, { unknown: what === 'send' })
    }
    // Stryker disable next-line ArrowFunction: a body that is not JSON reads as null or as undefined; every reader treats the two alike
    const json = await res.json().catch(() => null)
    if (res.status < 200 || res.status >= 300) throw refusal(what, res, json)
    return { status: res.status, json }
  }

  /** → the message of an answer to a send or an edit. */
  function messageOf(what, { status, json }) {
    if (isMessage(json)) return json
    // Said as it is for a send, which may have landed, and as a plain failure for an edit.
    throw new WebhookError(`Discord answered ${status} to the webhook ${what}, but not with a message.`, { status, unknown: what === 'send' })
  }

  return {
    get id() {
      return id
    },

    async send(threadId, body, files) {
      needId(threadId, 'threadId')
      needBody(body)
      const list = needFiles(files)
      const query = `wait=true&thread_id=${threadId}&with_components=true`
      const request = list.length === 0 ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { body: multipart(body, list) }
      return messageOf('send', await call('send', 'POST', '', query, request))
    },

    async edit(threadId, messageId, body) {
      needId(threadId, 'threadId')
      needId(messageId, 'messageId')
      needBody(body)
      // The name and the picture are the author's, set when the message is made; an edit cannot change them.
      const edited = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'username' && key !== 'avatar_url'))
      const answer = await call('edit', 'PATCH', `/messages/${messageId}`, `thread_id=${threadId}&with_components=true`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edited),
      })
      return messageOf('edit', answer)
    },

    async remove(threadId, messageId) {
      needId(threadId, 'threadId')
      needId(messageId, 'messageId')
      try {
        await call('delete', 'DELETE', `/messages/${messageId}`, `thread_id=${threadId}`)
      } catch (err) {
        // Already gone is what a delete is for.
        if (err.messageGone !== true) throw err
      }
    },

    async recent(threadId, limit = 20) {
      if (newest === undefined) throw new TypeError('recent needs the newest option of createWebhookClient.')
      needId(threadId, 'threadId')
      if (!Number.isInteger(limit)) throw new TypeError('limit must be a whole number.')
      if (limit < 1 || limit > MAX_RECENT) throw new RangeError(`limit must be from 1 to ${MAX_RECENT}.`)
      const page = await newest(threadId, limit)
      if (!Array.isArray(page)) throw new WebhookError('The webhook recent got no list of messages.')
      return page.filter((message) => isObject(message) && message.webhook_id === id)
    },
  }
}
