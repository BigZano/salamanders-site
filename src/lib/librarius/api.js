/**
 * Client for the Librarius routes (server/src/librariusHandler.js). Every call needs a live Discord token and the
 * server re-checks the reader's roles each time, so nothing is served from the HTTP cache. The token only ever goes in
 * the Authorization header. Each call throws a BuildsApiError carrying the status. Ids are passed as they are and
 * URL-encoded here; the server is the judge of whether one is an id (a post that is none is a 404, a cursor a 400).
 */
import { request } from '../buildsApi'

const get = (path, token) => request(path, { token, cache: 'no-store' })

const postPath = (id) => `/librarius/posts/${encodeURIComponent(id)}`

/** → { access: false } for someone who may not read the forum, else { access: true, ready, tags, roles, guildId, forumId }. */
export const getMe = (token) => get('/librarius/me', token)

/** → { emoji }: the guild's custom emoji. */
export const listEmoji = (token) => get('/librarius/emoji', token)

/** → { posts, people }: the topic list, pinned posts first, then by latest activity. */
export const listPosts = (token) => get('/librarius/posts', token)

/** → { post, lastRead, rev }: lastRead is the newest message the caller has read in it, or null. */
export const getPost = (token, id) => get(postPath(id), token)

/**
 * → { messages, hasOlder, hasNewer, people, rev }: a page, oldest first. With no option it is the newest page;
 * `before` and `after` take the messages on one side of an id, `around` the messages about it. At most one of the three,
 * and `limit` is 1 to 100 (50 when absent). An option that is undefined or null is left out.
 */
export function listMessages(token, id, { before, after, around, limit } = {}) {
  const query = Object.entries({ before, after, around, limit })
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('&')
  return get(`${postPath(id)}/messages${query === '' ? '' : `?${query}`}`, token)
}

/**
 * → { messages, deleted, rev, people } for what changed in a post after the rev `since`, or { reset: true } when more
 * changed than the server will answer at once, which means the post has to be opened again.
 */
export const getChanges = (token, id, since) => get(`${postPath(id)}/changes?since=${encodeURIComponent(since)}`, token)

/** Records how far the caller has read in a post: the id of the newest message read. The server never lowers it. → null */
export const markRead = (token, id, messageId) =>
  request(`${postPath(id)}/read`, { method: 'PUT', token, body: { messageId }, cache: 'no-store' })
