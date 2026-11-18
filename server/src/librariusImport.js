/**
 * The Librarius's import of the forum's whole history, and the catch-up that follows every gateway READY and comes round
 * on a timer. Both are one run, and it only reads Discord and writes the store: the Librarius never writes to Discord.
 *
 * createImport({ discord, store, forumId, windowSize = 100, log = console.error, now = Date.now,
 *   timers = { setTimeout, clearTimeout }, everyMs = 21_600_000, retryMs = [300_000, 600_000, 1_200_000, 1_800_000],
 *   onPostsListed = () => {}, webhookId = null })
 *   → { run() → Promise<void>, start(), stop(), status() → what store.syncStatus() says }
 *
 * `webhookId` is the id of the Librarius's own webhook (batch 2), or null: a message of it is not stored by a run (see write()), nor is
 * one of a webhook that sent a part that is stored (store.ownWebhookIds, read at the start of each run: the webhook may have been
 * replaced, or the address unset), nor one whose id is a stored part (store.knownPartIds).
 *
 * run() never rejects, and what it logs can never fail it: a log that throws is ignored. Everything a run writes is an upsert, a delete of what Discord no longer holds, or a cursor that
 * only moves forward, so one that repeats or is cut short does no harm. Only one run goes at a time: a run asked for while
 * one is going waits for it, and every call made during it shares ONE follow-up run, which starts as soon as the current
 * one ends. The gateway may ask for a catch-up while an earlier run is still working, and what that run has already read
 * may predate the gap, so the follow-up is a whole new pass and not a share of the old one. A call made during the
 * follow-up queues one more. In order, a run:
 *
 * 1. stamps last_run_at; then collects the forum's threads (the active ones of the guild whose parent is the forum, and
 *    every page of the archived ones) and upserts each as it comes; then deletes the stored posts Discord no longer lists.
 *    That delete happens only once every list call has succeeded, so a failed list can never empty the Librarius.
 *    A thread unarchived between the active listing and the archived one is in neither list, so Discord is asked about each
 *    stored post that neither holds before the delete (discord.thread, one question for each such post): one it still
 *    has, in the forum, is kept and taken in as if it had been listed; one it answers is gone (404 Unknown Channel), or
 *    has moved out of the forum, is deleted with its messages and read marks. A question Discord cannot answer ends the
 *    run with nothing deleted.
 *    Then onPostsListed() is called, and waited for, before a single message is read: the live feed reloads the posts it
 *    knows there, so it takes in the live events of a post this run found before the long import of messages. When it
 *    throws, the run ends like any other that fails, and the retry calls it again.
 * 2. for each post, reads the messages after its import cursor (0 before the first read), a page of 100 at a time until a
 *    short page, storing a page's rows and then moving the cursor to the page's last id. A cut-short import resumes from
 *    the cursor it kept.
 * 3. for each post, compares Discord's newest `windowSize` messages with the newest `windowSize` stored. A stored message
 *    that lies between the oldest and the newest of Discord's page but is not in it was deleted: it is deleted here. One
 *    whose edit time (as an instant, whatever its format) differs from Discord's is written again. A stored message
 *    newer than the whole page, or any stored message when the page is empty, may have been deleted while the gateway
 *    was down (the page cannot show that), or may have come in after the page was read, so Discord is asked for that
 *    message itself (discord.message): a message it no longer has is deleted here (a part of a reply of the site takes the whole reply with it,
 *    and the deletion of the parts that are left is queued: store.siteDeleted), one it still has is kept and is
 *    written again if its edit time differs. That is at most `windowSize` questions for a post. A stored message older
 *    than the whole page is out of view and is left alone, unless the page holds fewer messages than `windowSize`: that
 *    page is the whole post, so anything stored that is not on it is gone, and is deleted here (older ones with no
 *    question: only a newer one may have come in after the page was read). That is the limit of the catch-up for a post
 *    of more than `windowSize` messages: one deleted while the gateway was down and older than the window stays until the
 *    post is reimported.
 * 4. sets import_done, last_ok_at and a clear last_error.
 *
 * Any failure ends the run where it stands, with the cursors it has already set: last_error says why, and the next run
 * resumes. It is what describe() of librariusText says of the error (its name and message, every link cut out, at most
 * 200 characters; it never throws, so a thrown value that cannot be read still leaves a record). import_done and
 * last_ok_at are only ever set by a run that finished.
 *
 * start() makes one chain of timers, and stop() ends it. While it is on, one timer is always waiting or a run is going:
 * the catch-up comes round `everyMs` (6 hours) after the last run ended, whoever started that run, and a run that failed
 * is tried again after the next of the `retryMs` steps (5, 10, 20, then every 30 minutes), counting the runs that failed
 * one after another; a run that finishes resets the steps. start() does not run anything itself, since the first run is
 * the caller's to ask for. Starting twice is one chain, and a run that is going when stop() is called finishes and sets
 * no timer. Without start() no timer is set at all, and run() is all there is. stop() does not cancel a follow-up that a
 * call to run() has already queued.
 *
 * One exception to a failure ending the run: the store refusing one row with a TypeError (an id that does not fit its
 * bigint, say) skips that row and goes on. A message the store refuses sends its page again row by row, so only the bad
 * row is lost. A post the store refuses is not read; it is still kept when Discord lists it, so a refused update never
 * deletes a stored post.
 *
 * Discord answering oddly is Upstream: a page of messages that does not move past the cursor, or an archived list that
 * says there is more but gives no earlier time to ask from (without those checks the loops would never end), or a page of
 * the newest messages with an entry that has no usable id (a page is judged by what is not on it, so one that may be
 * missing an entry is not judged at all, and nothing is deleted).
 */
import { Upstream } from './discordRoles.js'
import { parseMessage, parseThread } from './librariusParse.js'
import { attempt as attemptWrite, describe, isId, isStoreId } from './librariusText.js'

// Discord's most for a page of messages, and so for a window.
const PAGE = 100
// The longest a timer can hold: a longer delay makes it fire at once.
const MAX_TIMER_MS = 2_147_483_647
const DISCORD_METHODS = ['activeThreads', 'archivedThreads', 'messagesAfter', 'newest', 'message', 'thread']
const STORE_METHODS = [
  'knownPostIds',
  'upsertPost',
  'deletePostsNotIn',
  'upsertMessages',
  'deleteMessages',
  'importCursor',
  'setImportCursor',
  'windowIds',
  'syncStatus',
  'setSync',
  'ownWebhookIds',
  'knownPartIds',
  'siteDeleted',
]

const instant = (time) => (time == null ? null : new Date(time).toISOString())

/** → the archive time to ask the next page of archived threads from: the oldest one of this page, as Discord wrote it. */
function olderThan(threads, before) {
  let oldest = null
  for (const t of threads) {
    const at = t.thread_metadata?.archive_timestamp
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) continue
    // Discord lists newest first, so of two times in the same millisecond the later one in the list is the older.
    if (oldest === null || Date.parse(at) <= Date.parse(oldest)) oldest = at
  }
  if (oldest === null || oldest === before) throw new Upstream('Discord listed more archived threads but no earlier time to ask from.')
  return oldest
}

const needMs = (value) => Number.isSafeInteger(value) && value >= 1 && value <= MAX_TIMER_MS

export function createImport({
  discord,
  store,
  forumId,
  windowSize = PAGE,
  log = console.error,
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  everyMs = 21_600_000,
  retryMs = [300_000, 600_000, 1_200_000, 1_800_000],
  onPostsListed = () => {},
  webhookId = null,
}) {
  for (const name of DISCORD_METHODS) if (typeof discord?.[name] !== 'function') throw new TypeError(`discord.${name} must be a function.`)
  for (const name of STORE_METHODS) if (typeof store?.[name] !== 'function') throw new TypeError(`store.${name} must be a function.`)
  if (!isId(forumId)) throw new TypeError('forumId must be a Discord id.')
  if (!Number.isInteger(windowSize) || windowSize < 1 || windowSize > PAGE) throw new RangeError(`windowSize must be a whole number from 1 to ${PAGE}.`)
  if (typeof timers?.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') {
    throw new TypeError('timers must have a setTimeout and a clearTimeout function.')
  }
  if (!needMs(everyMs)) throw new RangeError(`everyMs must be a whole number of milliseconds from 1 to ${MAX_TIMER_MS}.`)
  if (!Array.isArray(retryMs) || retryMs.length === 0 || !retryMs.every(needMs)) {
    throw new RangeError(`retryMs must be a non-empty list of whole numbers of milliseconds from 1 to ${MAX_TIMER_MS}.`)
  }
  if (typeof onPostsListed !== 'function') throw new TypeError('onPostsListed must be a function.')
  if (webhookId !== null && !isId(webhookId)) throw new TypeError('webhookId must be a Discord id or null.')

  const stamp = () => new Date(now()).toISOString()
  // What the log does can never fail the run: a log that throws (a closed stderr, say) must not skip what follows it, the
  // count of failures, the timer and the record of what went wrong.
  // Stryker disable next-line ArrowFunction,BlockStatement: what is logged is for the owner to read, and no test asserts it
  const report = (text) => {
    // Stryker disable next-line BlockStatement: as above
    try {
      // Stryker disable next-line StringLiteral: as above
      log(`Librarius import: ${text}`)
    } catch {
      // Nothing is left to say it with.
    }
  }
  // Whether a run is going, the follow-up that calls made during it share (null when none was asked for), and how many runs
  // in a row have failed.
  let running = false
  let followUp = null
  let failures = 0
  // The chain of timers start() made, or null when there is none. A timer answers only for the chain that set it, so a
  // run that outlives a stop() and a start() does not leave two chains.
  let chain = null
  let timer
  // The webhooks that sent a stored part, as the run in hand read them, besides the current one.
  let hooks = new Set()

  /** Do one write of one row. The store refusing it with a TypeError skips the row → false; any other error goes on up. */
  const attempt = (write, what) =>
    // Stryker disable next-line ArrowFunction,StringLiteral: what is logged is for the owner to read, and no test asserts it
    attemptWrite(write, (err) => report(`the store refused ${what}: ${describe(err)}`))

  /**
   * → the ids of the rows that are the site's own: a message of the current webhook, of a webhook that sent a part that is stored (see
   * above), or whose id is a stored part. Only a row whose webhook is not known for ours is asked of the store.
   */
  async function ownIds(rows) {
    const own = new Set()
    const unknown = []
    for (const row of rows) {
      if (row.webhookId !== null && (row.webhookId === webhookId || hooks.has(row.webhookId))) own.add(row.id)
      else if (isStoreId(row.id)) unknown.push(row.id)
    }
    if (unknown.length > 0) for (const id of await store.knownPartIds(unknown)) own.add(id)
    return own
  }

  /**
   * Store the rows of a page, but those of the site's own messages: the parts of a reply of the site are the outbox's, which
   * stores the reply as one message, so an import that stored each part would show a reply in pieces, and one that stored the
   * first over the reply would put the webhook where the member is. One the store refuses fails the whole batch, so the rows
   * then go one at a time.
   */
  async function write(all) {
    const own = await ownIds(all)
    const rows = all.filter((row) => !own.has(row.id))
    // Stryker disable next-line StringLiteral: what is logged is for the owner to read, and no test asserts it
    if (await attempt(() => store.upsertMessages(rows), 'a batch of messages')) return
    // Stryker disable next-line StringLiteral: as above
    for (const row of rows) await attempt(() => store.upsertMessages([row]), `message ${row.id}`)
  }

  async function importPosts() {
    const listed = new Set()
    const imported = new Set()
    const take = async (threads) => {
      for (const raw of threads) {
        const post = parseThread(raw, forumId)
        if (post === null) continue
        if (isStoreId(post.id)) listed.add(post.id)
        // Stryker disable next-line StringLiteral: what is logged is for the owner to read, and no test asserts it
        if (await attempt(() => store.upsertPost(post), `post ${post.id}`)) imported.add(post.id)
      }
    }
    await take(await discord.activeThreads())
    let before = null
    for (;;) {
      const { threads, hasMore } = await discord.archivedThreads(forumId, before)
      await take(threads)
      if (!hasMore) break
      before = olderThan(threads, before)
    }
    // A thread unarchived between the active listing and the archived one is in neither list, though it is there, and the
    // delete below would take its messages and everyone's read marks with it. So Discord is asked about each stored post
    // that neither list holds: one it still has in the forum is taken in as if it had been listed.
    for (const id of await store.knownPostIds()) {
      // A thread Discord no longer has is null, which take() passes over as it does a thread of another forum: the post is
      // then not listed, and so deleted below.
      if (!listed.has(id)) await take([await discord.thread(id)])
    }
    await store.deletePostsNotIn([...listed])
    return [...imported]
  }

  async function importMessages(postId) {
    let cursor = (await store.importCursor(postId)) ?? '0'
    for (;;) {
      const page = await discord.messagesAfter(postId, cursor, PAGE)
      if (page.length === 0) return
      const last = page.at(-1).id
      if (!isId(last) || BigInt(last) <= BigInt(cursor)) throw new Upstream('Discord sent a page of messages that does not follow the last one.')
      await write(page.map((message) => parseMessage(message)).filter((row) => row !== null))
      // Stryker disable next-line StringLiteral: what is logged is for the owner to read, and no test asserts it
      await attempt(() => store.setImportCursor(postId, last), `the cursor of post ${postId}`)
      if (page.length < PAGE) return
      cursor = last
    }
  }

  async function catchUp(postId) {
    const fetched = new Map()
    const page = await discord.newest(postId, windowSize)
    for (const message of page) {
      // What is not on the page is judged gone, so a page with an entry that cannot be read is not one to judge by.
      if (!isId(message.id)) throw new Upstream('Discord sent a page of messages with an entry that has no usable id.')
      fetched.set(message.id, message)
    }
    const onPage = [...fetched.keys()].map(BigInt)
    // A page of fewer messages than were asked for is the whole post: Discord has nothing beyond it.
    const whole = page.length < windowSize
    const gone = []
    const edited = []
    for (const { id, editedAt } of await store.windowIds(postId, windowSize)) {
      let message = fetched.get(id)
      if (message === undefined) {
        const at = BigInt(id)
        // Newer than the whole page, or the page is empty (which every message is newer than). The page cannot say what
        // became of it: it may have been deleted while the gateway was down, or come in after the page was read. So Discord
        // is asked for that message itself, which is at most one question for each message of the window.
        // Stryker disable next-line EqualityOperator: this message is not on the page, so no id of the page equals it
        const newer = onPage.every((p) => p < at)
        // Older than the whole page: out of view, not gone, unless the page is the whole post, which has nothing older.
        // Stryker disable next-line EqualityOperator: as above
        if (!whole && !newer && onPage.every((p) => p > at)) continue
        // Inside the range of the page, or older than a page that is the whole post, and not on it: deleted.
        message = newer ? await discord.message(postId, id) : null
        if (message === null) {
          gone.push(id)
          continue
        }
      }
      const row = parseMessage(message)
      if (row !== null && instant(row.editedAt) !== instant(editedAt)) edited.push(row)
    }
    // A reply of the site whose first part is gone from Discord goes with all its parts: the others are queued for deletion.
    const { plain } = await store.siteDeleted(gone, postId)
    await store.deleteMessages(plain)
    await write(edited)
  }

  async function pass() {
    await store.setSync({ last_run_at: stamp() })
    hooks = await store.ownWebhookIds()
    const posts = await importPosts()
    await onPostsListed()
    for (const id of posts) await importMessages(id)
    for (const id of posts) await catchUp(id)
    await store.setSync({ import_done: true, last_ok_at: stamp(), last_error: null })
  }

  /** The wait before the next run: the catch-up, or after a run that failed the next retry step. */
  const nextDelay = () => (failures === 0 ? everyMs : retryMs[Math.min(failures, retryMs.length) - 1])

  function schedule() {
    timers.clearTimeout(timer)
    const mine = chain
    timer = timers.setTimeout(() => {
      if (chain === mine) run()
    }, nextDelay())
  }

  /** One run, and what follows it: the count of failures, the follow-up that was asked for, or else the next timer. */
  async function execute() {
    let failed = false
    try {
      await pass()
    } catch (err) {
      failed = true
      const said = describe(err)
      // Stryker disable next-line StringLiteral: what is logged is for the owner to read, and no test asserts it
      report(`the run stopped: ${said}`)
      // Writing the failure down may fail too, with the database down; that is only logged, since the run is over.
      const recorded = Promise.resolve().then(() => store.setSync({ last_error: said }))
      // Stryker disable next-line ArrowFunction,StringLiteral: the handler only words a log line, and no test asserts the log
      await recorded.catch((inner) => report(`the failure could not be recorded: ${describe(inner)}`))
    }
    failures = failed ? failures + 1 : 0
    if (chain !== null) schedule()
  }

  /** The run is over: the next one starts if a call asked for it during this one. */
  function finish() {
    running = false
    const waiting = followUp
    followUp = null
    // The follow-up starts in the same breath as the run ends, so no other call can get in between.
    if (waiting !== null) waiting.resolve(launch())
  }

  function launch() {
    timers.clearTimeout(timer)
    running = true
    // Nothing in execute() is meant to throw. If it does anyway (a timer that throws, say), the run still ends, and run()
    // still never rejects.
    return execute().then(finish, finish)
  }

  function run() {
    if (!running) return launch()
    followUp ??= Promise.withResolvers()
    return followUp.promise
  }

  return {
    run,
    status: () => store.syncStatus(),

    start() {
      if (chain !== null) return
      chain = {}
      // A run that is going sets the timer when it ends.
      if (!running) schedule()
    },

    stop() {
      chain = null
      timers.clearTimeout(timer)
    },
  }
}
