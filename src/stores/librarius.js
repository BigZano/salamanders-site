import { defineStore } from 'pinia'
import * as api from '../lib/librarius/api'
import { STALE, attempt, statusOf, unlessStale } from './asking'

// What the Librarius pages show: whether the signed-in user may read it (the answer to GET /librarius/me), the topic
// list, the people it names, and the one post that is open with the messages loaded so far. It only decides what to
// show; the server enforces every read and write again. Statuses: idle, checking, allowed, importing, denied, signin,
// unavailable.
//
// The open post holds a run of its messages, oldest first, with no gap and no id twice, and the post's opening message
// apart from it. `hasOlder` and `hasNewer` say
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

// How often the post page polls, in milliseconds, and so the wait that a start-over the server keeps repeating is doubled from.
export const POLL_MS = 10_000
// The longest the store waits to poll again once the server keeps answering a start-over for the same rev.
const BACKOFF_MAX_MS = 300_000

// By store: the post a start-over was last answered for, the rev it was opened again at, how long the next poll waits if the
// server answers a start-over for that rev again, and until when polls are let go by. Only a start-over that comes with the
// rev the last one opened the post at is ignored: a rev that has changed is news, and begins afresh.
const quiet = new WeakMap()

const restart = (store) => {
  // Stryker disable next-line UpdateOperator: only restart() moves the session counter, so counting down tells an older answer from a current one as well as counting up
  gen.session++
  gen.posts++
  gen.post++
  gen.poll++
  quiet.delete(store)
}

const initial = () => ({
  status: 'idle',
  // The answer to /librarius/me while the reader may read: its tags, roles, guildId and forumId, and whether the import is done.
  me: null,
  posts: [],
  // Everyone the answers have named, { id: { name, avatar } }, the newest answer winning.
  people: {},
  // { id, info, opening, earliest, messages, hasOlder, hasNewer, rev, lastRead } once a post is open, else null. `opening` is
  // the post's own first message (its id is the post's), or null when there is none: it is kept apart from `messages`, so
  // that the page can pin it on top, and it is never in `messages` too. `earliest` is the id of the oldest message after it,
  // as it was when the post was opened, or null when that is not known: a run that holds it has nothing older to load, though
  // the server counts the pinned opening message as older. `lastRead` is the newest message the reader has read, and it is
  // where an opened post is put.
  post: null,
  error: '',
})

// A message id as the routes take it: a snowflake, 17 to 20 digits, kept as a string.
const MESSAGE_ID = /^\d{17,20}$/
const isMessageId = (value) => typeof value === 'string' && MESSAGE_ID.test(value)

// Whoever may not read leaves nothing of the forum behind, and nothing still on its way may land: the status is the only
// thing kept.
function refuse(store, status) {
  restart(store)
  store.$patch((state) => Object.assign(state, initial(), { status }))
}

// Asks, as unlessStale does, and a refusal takes the page away and counts as stale, so that nothing is left to land: a 403
// (the reader's role is gone: the server re-checks it on every read) is denied, and a 401 (the sign-in has expired) is signin.
async function readOrRefuse(store, now, ask) {
  try {
    return await unlessStale(now, ask)
  } catch (err) {
    const status = statusOf(err)
    if (status === 'unavailable') throw err
    refuse(store, status)
    return STALE
  }
}

// Null counts as a table here: spreading it adds nothing.
const isTable = (value) => typeof value === 'object' && !Array.isArray(value)

// Keeps the people an answer names. Spreading copies a key called __proto__ as a plain key, so it changes no prototype.
function takePeople(store, answer) {
  if (isTable(answer.people)) store.people = { ...store.people, ...answer.people }
}

// A poll that was answered 404 found its post gone: it was deleted in Discord, and the server no longer holds it. The post is
// let go of, and nothing of it that is still on its way may land. → true. Any other failure is the caller's, and goes on up.
function removed(store, err) {
  if (err?.status !== 404) throw err
  // Stryker disable next-line UpdateOperator: only that the counter moves tells an older answer from a current one, as in restart()
  gen.post++
  // Stryker disable next-line UpdateOperator: as above
  gen.poll++
  store.post = null
  return true
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

// → the messages without the one that has the post's own id: that is the post's opening message, which is held apart.
const withoutOpening = (messages, postId) => messages.filter((message) => message.id !== postId)

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

// → whether the run reaches back to `earliest`, the oldest message after the opening one (null when it is not known): only the
// opening message is older then, and it is pinned apart, so there is nothing older to load.
const holdsEarliest = (messages, earliest) => typeof earliest === 'string' && messages.length > 0 && idOf(messages[0]) <= BigInt(earliest)

// Opens a post: the post itself, then a page of its messages around `around` (a message id the caller names, to jump to a
// date), else around the reader's place, else the newest page, and, asked for with the page, the post's opening message
// (the first message after the one before the post's own id). The opening message is kept as `opening`, and is not in the
// run: an answer that is not what the routes send, or whose first message is not the post's own, leaves it null.
// Asked for the post that is open (a poll was told to start over, or the reader jumped), it keeps showing it until the new
// one lands, and it keeps the reader's place if that is further on than the server knows (its report may not have landed):
// a jump moves the page, never the mark. The question about the opening message asks for the first two messages: the opening
// one, and the one after it, which is what `earliest` is. → whether the post landed.
async function open(store, token, id, around) {
  gen.post++
  gen.poll++
  if (store.post?.id !== id) store.post = null
  const found = await readOrRefuse(store, () => gen.post, () => api.getPost(token, id))
  if (found === STALE) return false
  const lastRead = later(found.lastRead, store.post?.id === id ? store.post.lastRead : null)
  const anchor = around ?? lastRead
  const [page, first] = await Promise.all([
    readOrRefuse(
      store,
      () => gen.post,
      () => api.listMessages(token, id, anchor === null ? {} : { around: anchor }),
    ),
    readOrRefuse(
      store,
      () => gen.post,
      () => api.listMessages(token, id, { after: String(BigInt(id) - 1n), limit: 2 }),
    ),
  ])
  if (page === STALE || first === STALE) return false
  // The rev is the earliest of the answers, so that whatever changed between the reads is sent again by the next poll. The
  // answer about the opening message may have none.
  const rev = [page.rev, first?.rev].filter((r) => r !== undefined).reduce(earlier, found.rev)
  // Stryker disable next-line ArrayDeclaration: a row that is no message has no id, so none and a row of nonsense name nothing alike
  const rows = Array.isArray(first?.messages) ? first.messages : []
  const earliest = rows.map((row) => row?.id).find((rowId) => isMessageId(rowId) && rowId !== id) ?? null
  const messages = withoutOpening(page.messages, id)
  store.post = {
    id,
    info: found.post,
    opening: rows[0]?.id === id ? rows[0] : null,
    earliest,
    messages,
    hasOlder: page.hasOlder === true && !holdsEarliest(messages, earliest),
    hasNewer: page.hasNewer === true,
    rev,
    lastRead,
  }
  takePeople(store, page)
  takePeople(store, first ?? {})
  return true
}

// One side of the held run: the cursor the server takes, the flag it answers, which held message the page starts from, and
// whether more lies that way once the page is merged in (`answered` is what the server said).
const SIDES = {
  older: {
    cursor: 'before',
    flag: 'hasOlder',
    edge: (messages) => messages[0],
    more: (post, messages, answered) => answered === true && !holdsEarliest(messages, post.earliest),
  },
  newer: {
    cursor: 'after',
    flag: 'hasNewer',
    edge: (messages) => messages[messages.length - 1],
    more: (_post, _messages, answered) => answered === true,
  },
}

// Loads the page beyond one end of the run and merges it in. It does nothing when nothing lies that way.
async function loadBeyond(store, token, side) {
  const { cursor, flag, edge, more } = SIDES[side]
  const held = store.post
  if (held === null || !held[flag] || held.messages.length === 0) return
  const page = await readOrRefuse(
    store,
    () => gen.post,
    () => api.listMessages(token, held.id, { [cursor]: edge(held.messages).id }),
  )
  if (page === STALE) return
  const post = store.post
  const messages = mergePage(post.messages, withoutOpening(page.messages, post.id))
  post.messages = messages
  post[flag] = more(post, messages, page[flag])
  takePeople(store, page)
}

export const useLibrarius = defineStore('librarius', {
  state: initial,
  actions: {
    async load(token) {
      restart(this)
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
      restart(this)
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

    // `around`, a message id, opens the post on the page about that message instead of about the reader's place.
    openPost(token, id, { around } = {}) {
      return attempt(this, async () => {
        if (around !== undefined && around !== null && !isMessageId(around)) {
          throw new TypeError('openPost takes the id of a message to open around.')
        }
        await open(this, token, id, around)
      })
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
        // A start-over that came again for the rev the post was opened at is being waited out.
        const kept = quiet.get(this)
        const waiting = kept?.id === held.id && kept.rev === held.rev ? kept : undefined
        if (waiting !== undefined && Date.now() < waiting.until) return
        gen.poll++
        let got
        try {
          got = await readOrRefuse(this, () => gen.poll, () => api.getChanges(token, held.id, held.rev))
        } catch (err) {
          return removed(this, err)
        }
        if (got === STALE) return
        if (got.reset === true) {
          // The server was asked from the rev the last start-over opened the post at, and says to start over again: opening it
          // again would only come to the same, so the store asks less and less often, up to five minutes apart.
          if (waiting !== undefined) {
            waiting.wait = Math.min(waiting.wait * 2, BACKOFF_MAX_MS)
            waiting.until = Date.now() + waiting.wait
            return
          }
          // Too much changed to be sent: the run is no use, so the post is opened again around the middle of the run held,
          // so that the reader's window survives, and the rev it was opened at is kept.
          const middle = held.messages[Math.floor(held.messages.length / 2)]
          let landed
          try {
            landed = await open(this, token, held.id, middle?.id)
          } catch (err) {
            return removed(this, err)
          }
          if (landed) quiet.set(this, { id: held.id, rev: this.post.rev, wait: POLL_MS, until: 0 })
          return
        }
        const post = this.post
        const messages = applyChanges(post.messages, post, withoutOpening(got.messages, post.id), got.deleted)
        post.messages = messages
        // The opening message is updated or removed as any other is, the deletion winning.
        const changed = got.messages.find((message) => message.id === post.id)
        if (changed !== undefined) post.opening = changed
        if (got.deleted.includes(post.id)) post.opening = null
        post.rev = got.rev
        takePeople(this, got)
      })
    },

    // Reports how far the reader has read, when it is further than the mark held. The mark is kept at once, so that a
    // lower id is never sent after a higher one while that one is on its way, and is put back if the report fails.
    markRead(token, messageId) {
      return attempt(this, async () => {
        if (!isMessageId(messageId)) throw new TypeError('markRead takes the id of a message.')
        const post = this.post
        if (post === null) return
        if (post.lastRead !== null && BigInt(messageId) <= BigInt(post.lastRead)) return
        const before = post.lastRead
        const session = gen.session
        post.lastRead = messageId
        // A report that fails puts the mark held before it back, on the post open now if it is this one (it may have been opened
        // again meanwhile, keeping the mark) and unless a higher mark has replaced it since. Another session's post is its own.
        const putBack = () => {
          const current = this.post
          // Stryker disable next-line OptionalChaining: with no post open the answer is stale (the post was left), and a failure thrown here is dropped as stale
          if (session === gen.session && current?.id === post.id && current.lastRead === messageId) current.lastRead = before
        }
        await readOrRefuse(
          this,
          () => gen.post,
          async () => {
            try {
              return await api.markRead(token, post.id, messageId)
            } catch (err) {
              putBack()
              throw err
            }
          },
        )
      })
    },
  },
})
