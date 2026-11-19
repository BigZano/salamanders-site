/**
 * Client for the Librarius routes (server/src/librariusHandler.js). Every call needs a live Discord token and the
 * server re-checks the reader's roles each time, so nothing is served from the HTTP cache. The token only ever goes in
 * the Authorization header. Each call rejects with a BuildsApiError carrying the status. A post or message id that is no
 * snowflake (a string of 17 to 20 digits) is refused here, before anything is sent, with a TypeError: an id goes into the
 * path, and `.` or `..` would climb out of it. The server judges the rest (a post that is not there is a 404, a cursor
 * that does not fit a bigint a 400).
 *
 * The writes (a reply, an edit, a delete, a picture) reject the same way, and a refusal keeps more of what the server said: the
 * error carries `rule` and `match` too when the body has them (an AutoMod refusal, 422: the rule's name, and where its words are
 * in the source), so that the composer can say which rule it was and select the words.
 */
import { API_BASE, BuildsApiError, request } from '../buildsApi'

const SNOWFLAKE = /^\d{17,20}$/

const get = (path, token) => request(path, { token, cache: 'no-store' })

// → `value`, when it is an id; else a TypeError naming `what`.
function snowflake(value, what) {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value)) throw new TypeError(`${what} must be an id: a string of 17 to 20 digits.`)
  return value
}

const postPath = (id) => `/librarius/posts/${snowflake(id, 'The post id')}`
const messagePath = (id) => `/librarius/messages/${snowflake(id, 'The message id')}`

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A write: `json` is sent as a JSON body, `form` (FormData) as it is, with the type the browser gives it (the type carries the
 * boundary of the parts). → the answer, null for an empty one, or a BuildsApiError with the status and the server's words, which
 * also carries `rule` and `match` when the server's body says them.
 */
async function write(path, { method, token, json, form }) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (json !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${API_BASE}${path}`, { method, headers, body: json !== undefined ? JSON.stringify(json) : form, cache: 'no-store' })
  if (!res.ok) {
    const parsed = await res.json().catch(() => null)
    const body = isObject(parsed) ? parsed : {}
    const words = typeof body.error === 'string' && body.error !== '' ? body.error : `Request failed (${res.status})`
    const err = new BuildsApiError(words, res.status)
    if ('rule' in body) err.rule = body.rule
    if ('match' in body) err.match = body.match
    throw err
  }
  if (res.status === 204) return null
  return res.json()
}

/** → { access: false } for someone who may not read the forum, else { access: true, ready, tags, roles, guildId, forumId }. */
export const getMe = (token) => get('/librarius/me', token)

/**
 * → the members a mention may pick whose name has `q`, or whose id is `q`: [{ id, name, avatar }], 10 at most, of those who may
 * read the Librarius (an answer of any other shape is none). The server takes `q` of 1 to 32 characters, and 30 searches a minute.
 */
export async function searchMembers(token, q) {
  if (typeof q !== 'string') throw new TypeError('The search must be text.')
  const members = (await get(`/librarius/members?q=${encodeURIComponent(q)}`, token))?.members
  return Array.isArray(members) ? members : []
}

/** → { emoji }: the guild's custom emoji. */
export const listEmoji = (token) => get('/librarius/emoji', token)

/** → { posts, people }: the topic list, pinned posts first, then by latest activity. */
export const listPosts = (token) => get('/librarius/posts', token)

/** → { post, lastRead, rev }: lastRead is the newest message the caller has read in it, or null. */
export const getPost = async (token, id) => get(postPath(id), token)

/**
 * → { messages, hasOlder, hasNewer, people, rev }: a page, oldest first. With no option it is the newest page;
 * `before` and `after` take the messages on one side of an id, `around` the messages about it. At most one of the three,
 * and `limit` is 1 to 100 (50 when absent). An option that is undefined or null is left out; a cursor that is given must
 * be an id.
 */
export async function listMessages(token, id, { before, after, around, limit } = {}) {
  const path = postPath(id)
  const query = Object.entries({ before, after, around, limit })
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => `${name}=${encodeURIComponent(name === 'limit' ? value : snowflake(value, name))}`)
    .join('&')
  return get(`${path}/messages${query === '' ? '' : `?${query}`}`, token)
}

/**
 * → { messages, deleted, rev, people } for what changed in a post after the rev `since`, or { reset: true } when more
 * changed than the server will answer at once, which means the post has to be opened again.
 */
export const getChanges = async (token, id, since) => get(`${postPath(id)}/changes?since=${encodeURIComponent(since)}`, token)

/** Records how far the caller has read in a post: the id of the newest message read. The server never lowers it. → null */
export const markRead = async (token, id, messageId) =>
  request(`${postPath(id)}/read`, { method: 'PUT', token, body: { messageId: snowflake(messageId, 'messageId') }, cache: 'no-store' })

/**
 * → { pending: [{ key, kind, state, error, source, createdAt }] }: the caller's own replies, edits and deletes of a post that are
 * not done, oldest first. `state` is 'sending', 'blocked' or 'failed', and `error` what the member is told once one has ended.
 */
export const getPending = async (token, id) => get(`${postPath(id)}/pending`, token)

/**
 * Queues a reply in a post: `reply` is { source, replyTo, pingReply, mentions, uploads } as the route takes it.
 * → { pending: { key, state: 'sending' } }.
 */
export const postReply = async (token, id, reply) => write(`${postPath(id)}/messages`, { method: 'POST', token, json: reply })

/** Queues an edit of one of the caller's own site replies: `edit` is { source, mentions }. → { pending: { key, state } }. */
export const editMessage = async (token, messageId, edit) => write(messagePath(messageId), { method: 'PATCH', token, json: edit })

/** Queues the delete of a message. → { pending: { key, state } }. */
export const deleteMessage = async (token, messageId) => write(messagePath(messageId), { method: 'DELETE', token })

/** Sends one picture (a File or a Blob), the one part of a form. → { id }: the id the server holds it under. */
export async function uploadPicture(token, file) {
  const form = new FormData()
  form.append('file', file)
  return write('/librarius/uploads', { method: 'POST', token, form })
}
