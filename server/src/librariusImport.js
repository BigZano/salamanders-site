/**
 * The Librarius's import of the forum's whole history, and the catch-up that follows every gateway READY. Both are one
 * run, and it only reads Discord and writes the store: the Librarius never writes to Discord.
 *
 * createImport({ discord, store, forumId, windowSize = 100, log = console.error, now = Date.now })
 *   → { run() → Promise<void>, status() → what store.syncStatus() says }
 *
 * run() never rejects, and calls made while a run is going share it: the gateway may ask for a catch-up while an earlier
 * run, or an event handler, is still working. Everything a run writes is an upsert, a delete of what Discord no longer
 * holds, or a cursor that only moves forward, so one that repeats, overlaps or is cut short does no harm. In order, a run:
 *
 * 1. stamps last_run_at; then collects the forum's threads (the active ones of the guild whose parent is the forum, and
 *    every page of the archived ones) and upserts each as it comes; then deletes the stored posts Discord no longer lists.
 *    That delete happens only once every list call has succeeded, so a failed list can never empty the Librarius.
 * 2. for each post, reads the messages after its import cursor (0 before the first read), a page of 100 at a time until a
 *    short page, storing a page's rows and then moving the cursor to the page's last id. A cut-short import resumes from
 *    the cursor it kept.
 * 3. for each post, compares Discord's newest `windowSize` messages with the newest `windowSize` stored. A stored message
 *    that lies between the oldest and the newest of Discord's page but is not in it was deleted: it is deleted here. One
 *    whose edit time (as an instant, whatever its format) differs from Discord's is written again. A stored message
 *    older than the whole page is out of view and is left alone, and so is one newer than the page, which may have come
 *    in after the page was read. That is the limit of the catch-up: a message deleted while the gateway was down and
 *    older than the window stays until the post is reimported.
 * 4. sets import_done, last_ok_at and a clear last_error.
 *
 * Any failure ends the run where it stands, with the cursors it has already set: last_error says why, and the next run
 * resumes. It is the Upstream message when Discord was the trouble (with every link cut out, and at most 200
 * characters), and otherwise only the name of the error, since a database error can carry what must not be shown.
 * import_done and last_ok_at are only ever set by a run that finished.
 *
 * One exception: the store refusing one row with a TypeError (an id that does not fit its bigint, say) skips that row and
 * goes on. A message the store refuses sends its page again row by row, so only the bad row is lost. A post the store
 * refuses is not read; it is still kept when Discord lists it, so a refused update never deletes a stored post.
 *
 * Discord answering oddly is Upstream: a page of messages that does not move past the cursor, or an archived list that
 * says there is more but gives no earlier time to ask from. Without that check the loops would never end.
 */
import { Upstream } from './discordRoles.js'
import { parseMessage, parseThread } from './librariusParse.js'

const SNOWFLAKE = /^\d{17,20}$/
const BIGINT_MAX = 9223372036854775807n
// Discord's most for a page of messages, and so for a window.
const PAGE = 100
const MAX_ERROR = 200
const DISCORD_METHODS = ['activeThreads', 'archivedThreads', 'messagesAfter', 'newest']
const STORE_METHODS = [
  'upsertPost',
  'deletePostsNotIn',
  'upsertMessages',
  'deleteMessages',
  'importCursor',
  'setImportCursor',
  'windowIds',
  'syncStatus',
  'setSync',
]

const isId = (v) => typeof v === 'string' && SNOWFLAKE.test(v)
const fitsStore = (id) => BigInt(id) <= BIGINT_MAX
const withoutLinks = (text) => text.replace(/https?:\/\/\S*/gi, '[link]')
// For the log: the name and what the error says, with any link (a signed CDN one, say) cut out.
// Stryker disable next-line StringLiteral,LogicalOperator,MethodExpression: this only words a log line, and no test asserts the log; the link cut is asserted
const describe = (err) => withoutLinks(`${err?.name ?? 'Error'}: ${err?.message ?? ''}`).slice(0, MAX_ERROR)
// For last_error, which a page of the site may show: Discord's own trouble, and nothing else.
const note = (err) =>
  withoutLinks(err instanceof Upstream ? err.message || 'Discord is unavailable.' : `The Librarius import failed (${err?.name ?? 'Error'}).`).slice(0, MAX_ERROR)
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

export function createImport({ discord, store, forumId, windowSize = PAGE, log = console.error, now = Date.now }) {
  for (const name of DISCORD_METHODS) if (typeof discord?.[name] !== 'function') throw new TypeError(`discord.${name} must be a function.`)
  for (const name of STORE_METHODS) if (typeof store?.[name] !== 'function') throw new TypeError(`store.${name} must be a function.`)
  if (!isId(forumId)) throw new TypeError('forumId must be a Discord id.')
  if (!Number.isInteger(windowSize) || windowSize < 1 || windowSize > PAGE) throw new RangeError(`windowSize must be a whole number from 1 to ${PAGE}.`)

  const stamp = () => new Date(now()).toISOString()
  // Stryker disable next-line ArrowFunction,StringLiteral: what is logged is for the owner to read, and no test asserts it
  const report = (text) => log(`Librarius import: ${text}`)
  let current = null

  /** Do one write of one row. The store refusing it with a TypeError skips the row → false; any other error goes on up. */
  async function attempt(write, what) {
    try {
      await write()
      return true
    } catch (err) {
      if (!(err instanceof TypeError)) throw err
      // Stryker disable next-line StringLiteral: what is logged is for the owner to read, and no test asserts it
      report(`the store refused ${what}: ${describe(err)}`)
      return false
    }
  }

  /** Store the rows of a page. One the store refuses fails the whole batch, so the rows then go one at a time. */
  async function write(rows) {
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
        if (fitsStore(post.id)) listed.add(post.id)
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
    for (const message of await discord.newest(postId, windowSize)) if (isId(message.id)) fetched.set(message.id, message)
    const onPage = [...fetched.keys()].map(BigInt)
    const gone = []
    const edited = []
    for (const { id, editedAt } of await store.windowIds(postId, windowSize)) {
      const at = BigInt(id)
      // Older or newer than the whole page: out of view, not gone.
      if (onPage.every((p) => p > at) || onPage.every((p) => p < at)) continue
      const message = fetched.get(id)
      if (message === undefined) {
        gone.push(id)
        continue
      }
      const row = parseMessage(message)
      if (row !== null && instant(row.editedAt) !== instant(editedAt)) edited.push(row)
    }
    await store.deleteMessages(gone)
    await write(edited)
  }

  async function pass() {
    await store.setSync({ last_run_at: stamp() })
    const posts = await importPosts()
    for (const id of posts) await importMessages(id)
    for (const id of posts) await catchUp(id)
    await store.setSync({ import_done: true, last_ok_at: stamp(), last_error: null })
  }

  async function execute() {
    try {
      await pass()
    } catch (err) {
      // Stryker disable next-line StringLiteral: what is logged is for the owner to read, and no test asserts it
      report(`the run stopped: ${describe(err)}`)
      // Writing the failure down may fail too, with the database down; that is only logged, since the run is over.
      const recorded = Promise.resolve().then(() => store.setSync({ last_error: note(err) }))
      // Stryker disable next-line ArrowFunction,StringLiteral: the handler only words a log line, and no test asserts the log
      await recorded.catch((inner) => report(`the failure could not be recorded: ${describe(inner)}`))
    }
  }

  return {
    run() {
      current ??= execute().finally(() => {
        current = null
      })
      return current
    },
    status: () => store.syncStatus(),
  }
}
