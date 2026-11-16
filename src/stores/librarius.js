import { defineStore } from 'pinia'
import * as api from '../lib/librarius/api'

// What the Librarius pages show: whether the signed-in user may read it (the answer to GET /librarius/me), the topic
// list, the people it names, and the one post that is open with the messages loaded so far. It only decides what to
// show; the server enforces every read and write again. Statuses: idle, checking, allowed, importing, denied, signin,
// unavailable.
//
// The open post holds a run of its messages, oldest first, with no gap and no id twice. `hasOlder` and `hasNewer` say
// whether more lie beyond the run; loadOlder() and loadNewer() grow it; poll() keeps it up to date from `rev`, the number
// the server's changes are asked from. Only opening a post and polling move `rev`: a page carries the rev it was read at,
// but it holds no word of what changed in the messages already held, so taking it would skip those changes.
//
// A late answer must never land in a state the user has already left, so each kind of call has a generation counter and
// an answer lands only if its counter has not moved since the call was made. load() and reset() move all of them (a new
// session). The counters are:
//   session: load()s, and what load() answers;
//   posts:   the topic list, one loadPosts() at a time;
//   post:    the open post, which openPost() replaces, so that older and newer messages of the post before it never land;
//   poll:    the polls, one at a time, and an openPost() too: a poll for the post before cannot land in the one after.
// A poll, older messages, newer messages and a read mark do not replace each other, and all four may be on their way at once.
const gen = { session: 0, posts: 0, post: 0, poll: 0 }

const restart = () => {
  // Stryker disable next-line UpdateOperator: only restart() moves the session counter, so counting down tells an older answer from a current one as well as counting up
  gen.session++
  gen.posts++
  gen.post++
  gen.poll++
}

const statusOf = (err) => (err?.status === 401 ? 'signin' : err?.status === 403 ? 'denied' : 'unavailable')

const initial = () => ({
  status: 'idle',
  // The answer to /librarius/me while the reader may read: its tags, roles, guildId and forumId, and whether the import is done.
  me: null,
  posts: [],
  // Everyone the answers have named, { id: { name, avatar } }, the newest answer winning.
  people: {},
  // { id, info, messages, hasOlder, hasNewer, rev, lastRead } once a post is open, else null. `lastRead` is the newest
  // message the reader has read, and it is where an opened post is put.
  post: null,
  error: '',
})

// A message id as the routes take it: a snowflake, 17 to 20 digits, kept as a string.
const MESSAGE_ID = /^\d{17,20}$/

const STALE = Symbol('stale')

// → what `ask` answers, or STALE if `now()` (a generation counter) moved while it was asked for. A failure that arrives
// then is dropped too, not thrown.
async function unlessStale(now, ask) {
  const then = now()
  try {
    const got = await ask()
    return then === now() ? got : STALE
  } catch (err) {
    if (then === now()) throw err
    return STALE
  }
}

// Whoever may not read leaves nothing of the forum behind, and nothing still on its way may land: the status is the only
// thing kept.
function refuse(store, status) {
  restart()
  store.$patch((state) => Object.assign(state, initial(), { status }))
}

// Asks, as unlessStale does, and a 403 (the reader's role is gone: the server re-checks it on every read) takes the page away
// and counts as stale, so that nothing is left to land.
async function readOrRefuse(store, now, ask) {
  try {
    return await unlessStale(now, ask)
  } catch (err) {
    if (err?.status !== 403) throw err
    refuse(store, 'denied')
    return STALE
  }
}

// Runs one action: the message of a failure is kept in `error` for the page to show, and the failure goes on to the caller.
async function attempt(store, run) {
  store.error = ''
  try {
    return await run()
  } catch (err) {
    store.error = err?.message || 'Something went wrong.'
    throw err
  }
}

// Null counts as a table here: spreading it adds nothing.
const isTable = (value) => typeof value === 'object' && !Array.isArray(value)

// Keeps the people an answer names. Spreading copies a key called __proto__ as a plain key, so it changes no prototype.
function takePeople(store, answer) {
  if (isTable(answer.people)) store.people = { ...store.people, ...answer.people }
}

// Message ids are compared as BigInts: they are wider than a Number holds, and as text they would sort "9" after "10".
const idOf = (message) => BigInt(message.id)

// Orders [id, message] pairs by id. Ids are unique by now, so no two compare equal.
// Stryker disable next-line EqualityOperator: no two ids are equal, so `<` and `<=` order every pair alike
const byId = ([a], [b]) => (a < b ? -1 : 1)

// → the messages oldest first.
const ordered = (messages) =>
  messages
    .map((message) => [idOf(message), message])
    .sort(byId)
    .map(([, message]) => message)

// → the messages held with those a page brought, oldest first and one to an id. A message in both is the one held: it may
// have been changed by a poll since the page was read, and the next poll sends what a page may have missed.
function mergePage(held, page) {
  const byId = new Map()
  for (const message of page) byId.set(message.id, message)
  for (const message of held) byId.set(message.id, message)
  return ordered([...byId.values()])
}

// → the messages held with what a poll answered: a message that is held is replaced by its new version, and one that is
// deleted goes. A message that is not held is added when it falls where the run has no gap: among the held, after the
// newest when nothing newer lies unloaded, or before the oldest when nothing older does. Otherwise it is the edit of a
// message outside the run, or a new one that loadNewer() will reach in order, and is left out.
function applyChanges(held, { hasOlder, hasNewer }, changed, deleted) {
  const byId = new Map(held.map((message) => [message.id, message]))
  // Only a message that is not held is asked about, so it never equals the id of the first or of the last held.
  const joins = (message) => {
    const id = idOf(message)
    // Stryker disable next-line EqualityOperator: an id equal to the newest held is held, and never gets here
    if (held.length === 0 || id > idOf(held[held.length - 1])) return !hasNewer
    // Stryker disable next-line EqualityOperator: an id equal to the oldest held is held, and never gets here
    if (id < idOf(held[0])) return !hasOlder
    return true
  }
  for (const message of changed) {
    if (byId.has(message.id) || joins(message)) byId.set(message.id, message)
  }
  for (const id of deleted) byId.delete(id)
  return ordered([...byId.values()])
}

// → the later of two ids (as numbers), where null is none. Two that are equal are the same text, and either is the answer.
// Stryker disable next-line EqualityOperator: equal ids are the same text, so `>` and `>=` answer alike
const later = (a, b) => (a === null ? b : b === null ? a : BigInt(b) > BigInt(a) ? b : a)

// → the earlier of two revs (as numbers). Two that are equal are the same text, and either is the answer.
// Stryker disable next-line EqualityOperator: equal revs are the same text, so `<` and `<=` answer alike
const earlier = (a, b) => (BigInt(b) < BigInt(a) ? b : a)

// Opens a post: the post itself, then a page of its messages around the reader's place or else the newest page. Asked for
// the post that is open (a poll was told to start over), it keeps showing it until the new one lands, and it keeps the
// reader's place if that is further on than the server knows (its report may not have landed).
async function open(store, token, id) {
  gen.post++
  gen.poll++
  if (store.post?.id !== id) store.post = null
  const found = await readOrRefuse(store, () => gen.post, () => api.getPost(token, id))
  if (found === STALE) return
  const lastRead = later(found.lastRead, store.post?.id === id ? store.post.lastRead : null)
  const page = await readOrRefuse(
    store,
    () => gen.post,
    () => api.listMessages(token, id, lastRead === null ? {} : { around: lastRead }),
  )
  if (page === STALE) return
  // The rev is the earlier of the two, so that whatever changed between the two reads is sent again by the next poll.
  const rev = earlier(found.rev, page.rev)
  store.post = {
    id,
    info: found.post,
    messages: page.messages,
    hasOlder: page.hasOlder === true,
    hasNewer: page.hasNewer === true,
    rev,
    lastRead,
  }
  takePeople(store, page)
}

// One side of the held run: the cursor the server takes, the flag it answers, and which held message the page starts from.
const SIDES = {
  older: { cursor: 'before', flag: 'hasOlder', edge: (messages) => messages[0] },
  newer: { cursor: 'after', flag: 'hasNewer', edge: (messages) => messages[messages.length - 1] },
}

// Loads the page beyond one end of the run and merges it in. It does nothing when nothing lies that way.
async function loadBeyond(store, token, side) {
  const { cursor, flag, edge } = SIDES[side]
  const held = store.post
  if (held === null || !held[flag] || held.messages.length === 0) return
  const page = await readOrRefuse(
    store,
    () => gen.post,
    () => api.listMessages(token, held.id, { [cursor]: edge(held.messages).id }),
  )
  if (page === STALE) return
  const post = store.post
  const messages = mergePage(post.messages, page.messages)
  post.messages = messages
  post[flag] = page[flag] === true
  takePeople(store, page)
}

export const useLibrarius = defineStore('librarius', {
  state: initial,
  actions: {
    async load(token) {
      restart()
      const mine = gen.session
      if (!token) return refuse(this, 'signin')
      this.status = 'checking'
      this.error = ''
      try {
        const me = await api.getMe(token)
        if (mine !== gen.session) return
        // Only a plain `true` counts: anything else fails closed.
        if (me?.access !== true) return refuse(this, 'denied')
        this.me = me
        this.status = me.ready === true ? 'allowed' : 'importing'
      } catch (err) {
        if (mine !== gen.session) return
        const status = statusOf(err)
        // An outage takes no one's page away; a refusal does.
        if (status === 'unavailable') this.status = status
        else refuse(this, status)
      }
    },

    reset() {
      restart()
      this.$patch((state) => Object.assign(state, initial()))
    },

    loadPosts(token) {
      return attempt(this, async () => {
        gen.posts++
        const got = await readOrRefuse(this, () => gen.posts, () => api.listPosts(token))
        if (got === STALE) return
        this.posts = got.posts
        takePeople(this, got)
      })
    },

    openPost(token, id) {
      return attempt(this, () => open(this, token, id))
    },

    loadOlder(token) {
      return attempt(this, () => loadBeyond(this, token, 'older'))
    },

    loadNewer(token) {
      return attempt(this, () => loadBeyond(this, token, 'newer'))
    },

    poll(token) {
      return attempt(this, async () => {
        const held = this.post
        if (held === null) return
        gen.poll++
        const got = await readOrRefuse(this, () => gen.poll, () => api.getChanges(token, held.id, held.rev))
        if (got === STALE) return
        // Too much changed to be sent: the run is no use, so the post is opened again, at the reader's place.
        if (got.reset === true) return open(this, token, held.id)
        const post = this.post
        const messages = applyChanges(post.messages, post, got.messages, got.deleted)
        post.messages = messages
        post.rev = got.rev
        takePeople(this, got)
      })
    },

    // Reports how far the reader has read, when it is further than the mark held. The mark is kept at once, so that a
    // lower id is never sent after a higher one while that one is on its way, and is put back if the report fails.
    markRead(token, messageId) {
      return attempt(this, async () => {
        if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) throw new TypeError('markRead takes the id of a message.')
        const post = this.post
        if (post === null) return
        if (post.lastRead !== null && BigInt(messageId) <= BigInt(post.lastRead)) return
        const before = post.lastRead
        post.lastRead = messageId
        try {
          await readOrRefuse(this, () => gen.post, () => api.markRead(token, post.id, messageId))
        } catch (err) {
          if (post.lastRead === messageId) post.lastRead = before
          throw err
        }
      })
    },
  },
})
