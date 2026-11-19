import { defineStore } from 'pinia'
import * as api from '../lib/librarius/api'
import { STALE, attempt, statusOf, unlessStale } from './asking'
import { useAuth } from './auth'

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
// What the reader writes goes through the server's outbox, and the store follows it: reply(), edit() and remove() queue a reply,
// an edit or a delete, and upload() sends a picture for a reply. `outbox` holds what the reader has on its way in the open post,
// as the server's GET /pending tells it: each entry is sending, then sent once the server lists it no more, or blocked or failed
// with what the reader is told. While any of it is sending the store asks again every PENDING_MS (one ask at a time, never two),
// and it stops when nothing is. A failed one can be tried again (retry()), and a blocked or failed one put away (dismiss()).
//
// A late answer must never land in a state the user has already left, so each kind of call has a generation counter and
// an answer lands only if its counter has not moved since the call was made. load() and reset() move all of them (a new
// session). The counters are:
//   session: load()s, and what load() answers;
//   posts:   the topic list, one loadPosts() at a time;
//   post:    the open post, which openPost() replaces, so that older and newer messages of the post before it never land;
//   poll:    the polls, one at a time, and an openPost() too: a poll for the post before cannot land in the one after;
//   pending: what the reader has on its way, which is the open post's: an openPost() of another post, a post that is gone, load()
//            and reset() move it, so that an answer about the queue of the post before never lands in the one after.
// A poll, older messages, newer messages and a read mark do not replace each other, and all four may be on their way at once.
const gen = { session: 0, posts: 0, post: 0, poll: 0, pending: 0 }

// How often the post page polls, in milliseconds, and so the wait that a start-over the server keeps repeating is doubled from.
export const POLL_MS = 10_000
// The longest the store waits to poll again once the server keeps answering a start-over for the same rev.
const BACKOFF_MAX_MS = 300_000
// How often the queue of what the reader sent is asked about while any of it is sending, in milliseconds.
export const PENDING_MS = 3_000
// Every how many polls the post itself is read again: its title, its lock and its count of replies change in Discord too.
const INFO_EVERY = 6
// The places a reply's pictures go in, 1 to 10 (the server's cap).
const MAX_PICTURES = 10

const COPY = {
  noPost: 'There is no post open to write in.',
  pictureFailed: "Couldn't send the picture. Try again.",
  unknownAnswer: "The server's answer was not one the site knows.",
  notFailed: 'Only a message that failed to send can be tried again.',
  notEnded: 'Only a message that ended without being sent can be put away.',
  editUnknown: "This edit can't be sent again from here: edit the message again.",
}

// By store: the post a start-over was last answered for, the rev it was opened again at, how long the next poll waits if the
// server answers a start-over for that rev again, and until when polls are let go by. Only a start-over that comes with the
// rev the last one opened the post at is ignored: a rev that has changed is news, and begins afresh.
const quiet = new WeakMap()
// By store: how many polls of the open post have asked, { id, n }, so that every INFO_EVERY-th reads the post again.
const beats = new WeakMap()
// By store: the pictures sent for the replies of each post, by post id, as a list of their ids by place: `ids[N - 1]` is the one
// `upload:N` names in the source. The composer gives each picture its place, and gives a place that its text no longer uses to the
// next picture, which takes the place of the one before. A reply that is queued with pictures takes them all, and the places are
// empty again. They are kept through a new load() (the reader's drafts are), not a reset().
const pictures = new WeakMap()
// By store: the following of the open post's queue (see follow()).
const follows = new WeakMap()

const restart = (store) => {
  // Stryker disable next-line UpdateOperator: only restart() moves the session counter, so counting down tells an older answer from a current one as well as counting up
  gen.session++
  gen.posts++
  gen.post++
  gen.poll++
  gen.pending++
  quiet.delete(store)
  beats.delete(store)
  stopFollowing(store)
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
  // What the reader has on its way in the open post, oldest first: { key, kind, state, error, source, createdAt }. `kind` is 'send'
  // (a reply, whose key is the server's own for it), 'edit' or 'delete' (whose key is the message's id); `state` is 'sending', 'sent',
  // 'blocked' or 'failed'; `error` is what the reader is told once it has ended, else null; `source` the text of a reply or an edit
  // when it is known, else null; `createdAt` the server's time for it once the server has listed it, else null.
  outbox: [],
  error: '',
})

// A message id as the routes take it: a snowflake, 17 to 20 digits, kept as a string.
const MESSAGE_ID = /^\d{17,20}$/
const isMessageId = (value) => typeof value === 'string' && MESSAGE_ID.test(value)

// Whoever may not read leaves nothing of the forum behind, and nothing still on its way may land: the status is the only
// thing kept.
function refuse(store, status) {
  restart(store)
  pictures.delete(store)
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
    // A 401 is a sign-in the server no longer takes (the token has run out, or was revoked): the reader is signed out as the server
    // sees them, so that the page asks them to sign in again, rather than the Librarius going from it without a word.
    if (status === 'signin') useAuth().expire()
    refuse(store, status)
    return STALE
  }
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

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
  leavePost(store)
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
  if (store.post?.id !== id) {
    store.post = null
    leavePost(store)
  }
  beats.delete(store)
  const settling = settleFrom(store)
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
  settle(store, settling)
  // What is still on its way is followed again (a new load() stops the following, and keeps the post).
  if (store.outbox.some((e) => e.state === 'sending')) {
    const f = follow(store)
    f.token = token
    schedule(store, f)
  }
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

// Polls the open post for what changed since its rev, as poll() says.
async function pollChanges(store, token) {
  const held = store.post
  if (held === null) return
  // A start-over that came again for the rev the post was opened at is being waited out.
  const kept = quiet.get(store)
  const waiting = kept?.id === held.id && kept.rev === held.rev ? kept : undefined
  if (waiting !== undefined && Date.now() < waiting.until) return
  gen.poll++
  const beat = beats.get(store)
  const count = beat?.id === held.id ? beat.n + 1 : 1
  beats.set(store, { id: held.id, n: count })
  const settling = settleFrom(store)
  let got
  try {
    got = await readOrRefuse(store, () => gen.poll, () => api.getChanges(token, held.id, held.rev))
  } catch (err) {
    return removed(store, err)
  }
  if (got === STALE) return
  if (got.reset === true) {
    // The server was asked from the rev the last start-over opened the post at, and says to start over again: opening it again
    // would only come to the same, so the store asks less and less often, up to five minutes apart. Once it waits five minutes,
    // each start-over opens the post again all the same, once, so that a post the server keeps answering so is never left stale
    // for good; the next ask is five minutes on whether that works or not.
    if (waiting !== undefined && waiting.wait < BACKOFF_MAX_MS) {
      waiting.wait = Math.min(waiting.wait * 2, BACKOFF_MAX_MS)
      waiting.until = Date.now() + waiting.wait
      return
    }
    if (waiting !== undefined) waiting.until = Date.now() + waiting.wait
    // Too much changed to be sent: the run is no use, so the post is opened again around the middle of the run held, so that the
    // reader's window survives, and the rev it was opened at is kept. A rev that is not the one waited on is news, and begins afresh.
    const middle = held.messages[Math.floor(held.messages.length / 2)]
    let landed
    try {
      landed = await open(store, token, held.id, middle?.id)
    } catch (err) {
      return removed(store, err)
    }
    if (landed && store.post.rev !== waiting?.rev) quiet.set(store, { id: held.id, rev: store.post.rev, wait: POLL_MS, until: 0 })
    return
  }
  const post = store.post
  const messages = applyChanges(post.messages, post, withoutOpening(got.messages, post.id), got.deleted)
  post.messages = messages
  // The opening message is updated or removed as any other is, the deletion winning.
  const changed = got.messages.find((message) => message.id === post.id)
  if (changed !== undefined) post.opening = changed
  if (got.deleted.includes(post.id)) post.opening = null
  post.rev = got.rev
  takePeople(store, got)
  settle(store, settling)
  if (count % INFO_EVERY !== 0) return
  // The post's own facts (its title, whether it is locked, its count of replies), read again: only those are taken from the answer.
  let fresh
  try {
    fresh = await readOrRefuse(store, () => gen.poll, () => api.getPost(token, held.id))
  } catch (err) {
    return removed(store, err)
  }
  if (fresh !== STALE && isObject(fresh?.post)) store.post.info = fresh.post
}

// --- what the reader has on its way ---

const KINDS = new Set(['send', 'edit', 'delete'])
// The states the server lists an entry in: a reply that is sent is listed no more.
const LISTED = new Set(['sending', 'blocked', 'failed'])
const MENTION = /<@!?(\d{17,20})>/g
// A picture of the reply, as the parser reads one (librariusMarkdown.js IMAGE): ![text](upload:N), N from 1 to 10.
const PICTURE = /!\[[^[\]\n]*\]\(upload:(10|[1-9])\)/g
// A picture id, as the server gives one.
const PICTURE_ID = /^\d{1,19}$/

/** One entry of the queue to one message, or to one reply: its kind and its key. */
const identity = (e) => `${e.kind}:${e.key}`
const textOrNull = (value) => value === null || typeof value === 'string'
const timeOf = (e) => Date.parse(e.createdAt)

/** → whether `e` is an entry as GET /pending lists one: a reply has its text, an edit or a delete has it or not. */
const isEntry = (e) =>
  isObject(e) &&
  typeof e.key === 'string' &&
  e.key !== '' &&
  KINDS.has(e.kind) &&
  LISTED.has(e.state) &&
  textOrNull(e.error) &&
  (e.kind === 'send' ? typeof e.source === 'string' : textOrNull(e.source)) &&
  typeof e.createdAt === 'string' &&
  !Number.isNaN(timeOf(e))

const entryOf = (e) => ({ key: e.key, kind: e.kind, state: e.state, error: e.error, source: e.source, createdAt: e.createdAt })

/** → the ids of the people a text mentions, `<@id>` or `<@!id>`, once each, in the order they are first mentioned. */
const mentionsIn = (text) => [...new Set(Array.from(text.matchAll(MENTION), (m) => m[1]))]

/** → the highest N of the pictures a text shows, `upload:N`, or 0 for none. */
const lastPicture = (text) => Array.from(text.matchAll(PICTURE), (m) => Number(m[1])).reduce((a, b) => Math.max(a, b), 0)

/** → the name a picture is shown by: its file's, without the type, else "picture". */
function nameOf(file) {
  const name = typeof file.name === 'string' ? file.name.replace(/\.[^.]*$/, '').trim() : ''
  return name === '' ? 'picture' : name
}

/** → the pictures of the replies of a post by place (see `pictures`), made when there are none yet. */
function picturesOf(store, postId) {
  let byPost = pictures.get(store)
  if (byPost === undefined) pictures.set(store, (byPost = new Map()))
  let held = byPost.get(postId)
  if (held === undefined) byPost.set(postId, (held = { ids: [] }))
  return held
}

/** → the ids of the places 1 to `last`, as far as they go with no gap: a picture past a place never held is not one of the reply's. */
function picturesUpTo(ids, last) {
  const run = []
  for (let i = 0; i < last && ids[i] !== undefined; i++) run.push(ids[i])
  return run
}

/** → `mentions`, the ids the composer picked, as a copy; when it gives none, the ids the text mentions. */
function pickedIn(mentions, source) {
  if (mentions === undefined) return mentionsIn(source)
  if (!Array.isArray(mentions) || !mentions.every((id) => typeof id === 'string')) throw new TypeError('mentions is a list of the ids picked, as text.')
  return [...mentions]
}

/**
 * → how the open post's queue is followed, made when there is none:
 *   timer, inFlight: the next ask, waiting or on its way (never both, and never two on their way);
 *   token: the one the last call gave, which the asks to come use;
 *   asked: the asks begun; an entry held when `asked` was n is judged only by asks begun after (`after`, by entry);
 *   changes: the polls for changes, and the reopenings, begun; an entry seen sent is let go of once one begun after it lands (`sentAt`);
 *   cutoff: by entry, the time of the newest of it that is done with (put away, tried again, or older than another of it): the server
 *     lists those for a day, and they are never shown again;
 *   bodies: by entry, what was sent for it, so that a failed one can be sent again as it was.
 */
function follow(store) {
  let f = follows.get(store)
  if (f === undefined) {
    f = { timer: null, inFlight: null, token: null, asked: 0, changes: 0, after: new Map(), sentAt: new Map(), cutoff: new Map(), bodies: new Map() }
    follows.set(store, f)
  }
  return f
}

function stopFollowing(store) {
  clearTimeout(follows.get(store)?.timer)
  follows.delete(store)
}

/** The open post is let go of: nothing of its queue is kept, and nothing about it still on its way may land. */
function leavePost(store) {
  gen.pending++
  stopFollowing(store)
  store.outbox = []
}

/** The entry is done with: the server's listing of it, and of anything older of it, is never shown again. */
function putAway(f, e) {
  if (e.createdAt !== null) f.cutoff.set(identity(e), timeOf(e))
}

/** Asks again in PENDING_MS, when something is sending and no ask is waiting or on its way. */
function schedule(store, f) {
  if (f.inFlight !== null || f.timer !== null) return
  if (!store.outbox.some((e) => e.state === 'sending')) return
  f.timer = setTimeout(() => {
    f.timer = null
    // A failure here is no one's to hear: the next ask tries again while something is sending.
    ask(store, f.token).catch(() => {})
  }, PENDING_MS)
}

/** Asks for the open post's queue now, or answers the ask already on its way: there are never two. → once it has landed. */
function ask(store, token) {
  const f = follow(store)
  if (f.inFlight !== null) return f.inFlight
  clearTimeout(f.timer)
  f.timer = null
  f.token = token
  const n = ++f.asked
  const postId = store.post.id
  let gone = false
  f.inFlight = (async () => {
    try {
      const got = await readOrRefuse(store, () => gen.pending, () => api.getPending(token, postId))
      if (got !== STALE) takePending(store, f, n, got)
    } catch (err) {
      // A post that is gone is the poll's to find, and to tell the page of: there is nothing more to ask about it.
      if (err?.status !== 404) throw err
      gone = true
    } finally {
      f.inFlight = null
      if (!gone && follows.get(store) === f) schedule(store, f)
    }
  })()
  return f.inFlight
}

/**
 * Takes the answer of ask `n`: the newest listing of each entry that is not done with takes the place of what is held of it; an
 * entry held as sending that is listed no more is sent, unless it was held only after the ask began (the server may not have had
 * it yet); one sent stays so; one blocked or failed that is listed no more is over a day old, and goes. An answer that is not what
 * the route sends judges nothing.
 */
function takePending(store, f, n, answer) {
  if (!Array.isArray(answer?.pending)) return
  const newest = new Map()
  for (const e of answer.pending) {
    if (!isEntry(e)) continue
    const id = identity(e)
    if (timeOf(e) <= (f.cutoff.get(id) ?? -Infinity)) continue
    const other = newest.get(id)
    if (other === undefined) {
      newest.set(id, e)
      continue
    }
    const [older, newer] = timeOf(other) < timeOf(e) ? [other, e] : [e, other]
    f.cutoff.set(id, timeOf(older))
    newest.set(id, newer)
  }
  const next = []
  for (const held of store.outbox) {
    const id = identity(held)
    const listed = newest.get(id)
    if (listed !== undefined) {
      next.push(entryOf(listed))
      newest.delete(id)
    } else if (held.state === 'sending' && f.after.get(id) >= n) {
      next.push(held)
    } else if (held.state === 'sending') {
      f.sentAt.set(id, f.changes)
      next.push({ ...held, state: 'sent', error: null })
    } else if (held.state === 'sent') {
      next.push(held)
    }
  }
  for (const listed of newest.values()) next.push(entryOf(listed))
  store.outbox = next
}

/** → what settle() needs of a poll for changes or a reopening that begins now. */
function settleFrom(store) {
  const f = follows.get(store)
  return f === undefined ? null : { f, from: ++f.changes }
}

/** A poll for changes or a reopening has landed: what was seen sent before it began is in the post now, and goes from the queue. */
function settle(store, settling) {
  if (settling === null || follows.get(store) !== settling.f) return
  const { f, from } = settling
  store.outbox = store.outbox.filter((e) => !(e.state === 'sent' && f.sentAt.get(identity(e)) < from))
}

/** → the id of the open post, or a TypeError: everything written is for the post that is open. */
function openId(store) {
  if (store.post === null) throw new TypeError(COPY.noPost)
  return store.post.id
}

/**
 * Sends one write for the post `postId` (`send`, which answers the route's 202) and holds its entry as sending, when that post is
 * still the one open; `body` is what was sent, for a retry, and `replacing` the entries it takes the place of. → a copy of the
 * entry. A refusal is the caller's, as it is: its status, the server's words, and `rule` and `match` of an AutoMod refusal.
 */
async function queue(store, token, postId, kind, send, { source = null, body, replacing = [] } = {}) {
  const mine = gen.pending
  const answer = await send()
  const key = answer?.pending?.key
  if (typeof key !== 'string' || key === '') throw new Error(COPY.unknownAnswer)
  const entry = { key, kind, state: 'sending', error: null, source, createdAt: null }
  if (mine === gen.pending && store.post?.id === postId) {
    const f = follow(store)
    const id = identity(entry)
    f.after.set(id, f.asked)
    if (body !== undefined) f.bodies.set(id, body)
    // It takes the place of what was held of it before (an edit that failed, say), and a delete that of the message's edit.
    const replaced = new Set([id, ...replacing, ...(kind === 'delete' ? [`edit:${key}`] : [])])
    const next = []
    let placed = false
    for (const held of store.outbox) {
      const heldId = identity(held)
      if (!replaced.has(heldId)) next.push(held)
      else {
        putAway(f, held)
        if (heldId === id) {
          next.push(entry)
          placed = true
        }
      }
    }
    if (!placed) next.push(entry)
    store.outbox = next
    f.token = token
    schedule(store, f)
  }
  return { ...entry }
}

/** → the entry of the queue that `which` ({ kind, key }) names, or undefined. */
const heldEntry = (store, which) => store.outbox.find((e) => e.kind === which?.kind && e.key === which?.key)

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
      pictures.delete(this)
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
      return attempt(this, () => pollChanges(this, token))
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

    // Queues a reply in the open post: `source` is its markdown, `replyTo` the id of the message it answers (null for the post),
    // `pingReply: true` pings that message's author too, and `mentions` are the ids of the people picked to mention (the server takes
    // only those it may ping; without the list, the ids the text mentions). The pictures it shows (upload:N, by the place upload() was
    // given) go with it. → the entry it is held under, sending; a refusal rejects (see queue()).
    async reply(token, input) {
      if (!isObject(input) || typeof input.source !== 'string') throw new TypeError('reply takes { source, replyTo, pingReply, mentions }, with the source as text.')
      const { source, replyTo = null } = input
      if (replyTo !== null && !isMessageId(replyTo)) throw new TypeError('replyTo is the id of a message, or null.')
      const mentions = pickedIn(input.mentions, source)
      const postId = openId(this)
      const held = picturesOf(this, postId)
      const shown = lastPicture(source)
      const body = { source, replyTo, pingReply: input.pingReply === true, mentions, uploads: picturesUpTo(held.ids, shown) }
      const entry = await queue(this, token, postId, 'send', () => api.postReply(token, postId, body), { source, body })
      // The pictures went with it: the next reply numbers its own from 1.
      if (shown > 0) held.ids = []
      return entry
    },

    // Queues an edit of one of the reader's own site replies, by its id: `source` is the new text, and `mentions` the people picked,
    // as for reply(). Its pictures are those it was sent with. → the entry, sending.
    async edit(token, messageId, input) {
      if (!isMessageId(messageId)) throw new TypeError('edit takes the id of a message.')
      if (!isObject(input) || typeof input.source !== 'string') throw new TypeError('edit takes { source, mentions }, with the source as text.')
      const mentions = pickedIn(input.mentions, input.source)
      const postId = openId(this)
      const body = { source: input.source, mentions }
      return queue(this, token, postId, 'edit', () => api.editMessage(token, messageId, body), { source: input.source, body })
    },

    // Queues the delete of a message, by its id. → the entry, sending.
    async remove(token, messageId) {
      if (!isMessageId(messageId)) throw new TypeError('remove takes the id of a message.')
      const postId = openId(this)
      return queue(this, token, postId, 'delete', () => api.deleteMessage(token, messageId))
    },

    // Sends a picture for a reply in the open post, to hold at place `n` (1 to 10), which the composer gives it: it is `upload:N` in
    // the source. → { n, name }, `name` being what it is shown by; or { status, error } for one that was not taken, with the server's
    // words (status 0 for a failure of the network, an answer that is no picture's, or no post open). Nothing is tried again here: the
    // composer does that, for a 429 and a 503 only.
    async upload(token, file, n) {
      if (!(file instanceof Blob)) throw new TypeError('upload takes a picture: a File or a Blob.')
      if (!Number.isInteger(n)) throw new TypeError('upload takes the place of the picture, a whole number.')
      if (n < 1 || n > MAX_PICTURES) throw new RangeError('A picture goes in place 1 to 10.')
      if (this.post === null) return { status: 0, error: COPY.noPost }
      const postId = this.post.id
      const held = picturesOf(this, postId)
      let answer
      try {
        answer = await api.uploadPicture(token, file)
      } catch (err) {
        return Number.isInteger(err?.status) ? { status: err.status, error: err.message } : { status: 0, error: COPY.pictureFailed }
      }
      // A picture that arrives after a sign-out is no one's now.
      if (typeof answer?.id !== 'string' || !PICTURE_ID.test(answer.id) || pictures.get(this)?.get(postId) !== held) return { status: 0, error: COPY.pictureFailed }
      held.ids[n - 1] = answer.id
      return { n, name: nameOf(file) }
    },

    // Asks now what the reader has on its way in the open post, and follows it while any of it is sending. The page asks this when
    // it opens a post, so that what was sent before (a page loaded again) is shown. → once the answer has landed.
    pending(token) {
      if (this.post === null) return Promise.resolve()
      return ask(this, token)
    },

    // Sends again an entry that failed, `which` being { kind, key }: a reply or an edit as it was sent (a reply the store did not send
    // itself, with its text and the people it mentions), a delete as it is. → the new entry, which takes the failed one's place.
    async retry(token, which) {
      const held = heldEntry(this, which)
      if (held?.state !== 'failed') throw new RangeError(COPY.notFailed)
      const postId = this.post.id
      const id = identity(held)
      const body = follow(this).bodies.get(id)
      if (held.kind === 'send') {
        const sent = body ?? { source: held.source, replyTo: null, pingReply: false, mentions: mentionsIn(held.source), uploads: [] }
        return queue(this, token, postId, 'send', () => api.postReply(token, postId, sent), { source: sent.source, body: sent, replacing: [id] })
      }
      if (held.kind === 'edit') {
        if (body === undefined) throw new RangeError(COPY.editUnknown)
        return queue(this, token, postId, 'edit', () => api.editMessage(token, held.key, body), { source: body.source, body })
      }
      return queue(this, token, postId, 'delete', () => api.deleteMessage(token, held.key))
    },

    // Puts away an entry that was blocked or failed, `which` being { kind, key }, for good. One that is not held is gone already.
    dismiss(which) {
      const held = heldEntry(this, which)
      if (held === undefined) return
      if (held.state !== 'blocked' && held.state !== 'failed') throw new RangeError(COPY.notEnded)
      putAway(follow(this), held)
      this.outbox = this.outbox.filter((e) => e !== held)
    },
  },
})
