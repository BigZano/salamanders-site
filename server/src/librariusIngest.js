/**
 * The Librarius's live feed into the store: each event the gateway dispatches (librariusGateway.js) becomes a write to
 * the store, or a note to the guild and access caches that something they hold has changed. Like the import, it only
 * reads Discord and writes the store: it never writes to Discord (the outbox does, and it has its own store methods).
 *
 * createIngest({ store, guild, access, forumId, fetchMessage, onReady, webhookId = null, kickOutbox = () => {}, log = console.error })
 *   → { load() → Promise<void>, dispatch(type, data) → Promise<void>, botUserId() → string | null }
 *
 * `fetchMessage` is discord.message, and `onReady` starts the catch-up (the importer's run). `webhookId` is the id of the
 * Librarius's own webhook (batch 2), or null when there is none: what that webhook posts, the parts of a reply of the site, is
 * the outbox's to store (a reply is one message to the site, however many it is to Discord), so a message of it is never
 * stored from an event. A message is the site's own when its webhook is the current one (the echo of a reply that comes before
 * the outbox has stored it), or one that sent a stored part before (store.ownWebhookIds, read by load(): the webhook may have been
 * replaced, or the address unset, and the old replies are still there), or when its id is a stored part (store.knownPartIds).
 * `kickOutbox` is the outbox's kick (librariusOutbox.js): it tells the outbox that the store may have queued work for it. With
 * the replies off there is no outbox, and it does nothing.
 * The gateway calls
 * dispatch(t, d) for one event at a time and gives up on one that has not settled after 15 seconds, so every handler
 * writes with upserts and deletes that do no harm when they repeat or overlap with the next event's, and none waits for
 * anything long. The one slow thing, the catch-up, is started and not waited for.
 *
 * What it listens to is a set of post ids: the forum's threads. load() fills it from the store, and the thread events
 * add to it (and a thread delete takes from it). It only ever adds on load(), so a thread that came while the posts were
 * being read is not lost, and an id the store no longer holds is harmless: a message is only stored with its post.
 * A message of any other channel is not the Librarius's, so it is dropped. So is one of a thread it has never heard of: a
 * THREAD_CREATE adds the thread, and the next catch-up fills its messages.
 *
 * Events, by type:
 * - READY: notes the bot's own user id, and starts the catch-up without waiting for it. Once the catch-up is over, it
 *   loads the posts again, since it may have found threads that no event told of; without that, a fresh store would
 *   have no thread to listen to until the next restart. A catch-up that throws is only logged, and the posts are loaded
 *   all the same.
 * - THREAD_CREATE, THREAD_UPDATE: stores the thread when its parent is the forum, and listens to it.
 * - THREAD_LIST_SYNC: the same for each thread it lists.
 * - THREAD_DELETE: deletes the post when its parent is the forum, and stops listening to it.
 * - MESSAGE_CREATE, MESSAGE_UPDATE: stores the message, unless it is one of our webhook's (see above). A live update can leave out most of the message (an embed that
 *   was only unfurled), and so a message with no author is read again with fetchMessage: what it answers is stored, and
 *   null, for a message Discord no longer has, deletes it. Neither event touches the reactions of a message that is
 *   stored, since the payload may leave them out, and the counts are the reaction events' to keep. A message that is new
 *   is stored with the reactions it came with.
 * - MESSAGE_DELETE, MESSAGE_DELETE_BULK: delete the messages. A part of a reply of the site takes the whole reply with it
 *   (store.siteDeleted): the reply goes from the store, and the deletion of the parts that are left is queued for the outbox.
 *   The outbox is told (kickOutbox) once the store has answered, and before the plain messages are deleted: one with nothing to do
 *   sleeps until it is told, and the rest of the reply would stay in Discord until the next write from the site. It is told whenever
 *   one of the ids was a part, which is the only time the store queues anything; when it queued nothing after all (every part went at
 *   once, or the reply was left to its edit), the outbox looks, finds nothing new, and sleeps again.
 *   A reply that an edit is on its way for is left to the edit, which is told: the edit may drop the part that was deleted,
 *   and a part it keeps that is gone makes it take the whole reply. The parts an edit drops are removed once it is stored, by a
 *   delete it queues, so each of those removals comes in here as the deletion of a message that is no part of a reply any more.
 *   A message that a re-read finds gone is deleted the same way.
 * - MESSAGE_REACTION_ADD, MESSAGE_REACTION_REMOVE: change one emoji's count by one. A reaction to any part of a reply of
 *   the site counts on the reply (store.messageOfPart), and so does a clear of them. The bot's own reaction is skipped,
 *   since the stored counts leave it out (parseMessage drops the `me` of each one), and so is an emoji that cannot be
 *   keyed, since it would change nothing and still move the message's rev.
 * - MESSAGE_REACTION_REMOVE_ALL: clears every reaction of a message. MESSAGE_REACTION_REMOVE_EMOJI: clears one emoji's,
 *   and does nothing for an emoji that cannot be keyed: the store takes a null key for "clear them all", so it is never
 *   passed on from a key that was not found.
 * - CHANNEL_UPDATE of the forum: forgets the forum, and the verdicts that were drawn from it. GUILD_ROLE_CREATE,
 *   GUILD_ROLE_UPDATE and GUILD_ROLE_DELETE: forget the guild, and the verdicts. The guild goes first, so that no verdict
 *   is read from the old roles after the verdicts are dropped.
 * - GUILD_EMOJIS_UPDATE: gives the guild the new list of emoji.
 * - AUTO_MODERATION_RULE_CREATE, AUTO_MODERATION_RULE_UPDATE and AUTO_MODERATION_RULE_DELETE (which the gateway sends for the
 *   AUTO_MODERATION_CONFIGURATION intent): forget the AutoMod rules a reply from the site is checked against, and nothing else.
 *   No verdict is drawn from them, so the verdicts stay.
 * - Anything else is ignored.
 *
 * Everything an event carries is untrusted. An event that names an id that is no snowflake, or one a bigint cannot hold,
 * is skipped, and so is a row the store refuses with a TypeError (the importer does the same): one bad row never stops
 * the rest of an event. Any other failure, the database being down or Discord being unreachable for a re-read, is given
 * to the gateway, which records it and goes on to the next event; the next catch-up puts right what that event missed.
 *
 * What the catch-up puts right is bounded. A re-read that was given up on may still be running when the delete event for
 * the same message comes, and store the message once more; only the catch-up's window of the newest messages removes it
 * again. An update that only unfurled an embed does not change a message's edit time, so when its re-read failed the
 * catch-up does not find it either.
 */
import { emojiKey, parseMessage, parseThread } from './librariusParse.js'
import { attempt as attemptWrite, describe, isId, isStoreId } from './librariusText.js'

const STORE_METHODS = [
  'knownPostIds',
  'upsertPost',
  'deletePost',
  'upsertMessages',
  'deleteMessages',
  'adjustReaction',
  'clearReactions',
  'siteDeleted',
  'messageOfPart',
  'ownWebhookIds',
  'knownPartIds',
]

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

export function createIngest({ store, guild, access, forumId, fetchMessage, onReady, webhookId = null, kickOutbox = () => {}, log = console.error }) {
  for (const name of STORE_METHODS) if (typeof store?.[name] !== 'function') throw new TypeError(`store.${name} must be a function.`)
  for (const name of ['invalidate', 'setEmoji']) if (typeof guild?.[name] !== 'function') throw new TypeError(`guild.${name} must be a function.`)
  if (typeof access?.forget !== 'function') throw new TypeError('access.forget must be a function.')
  if (typeof fetchMessage !== 'function') throw new TypeError('fetchMessage must be a function.')
  if (typeof onReady !== 'function') throw new TypeError('onReady must be a function.')
  if (!isId(forumId)) throw new TypeError('forumId must be a Discord id.')
  if (webhookId !== null && !isId(webhookId)) throw new TypeError('webhookId must be a Discord id or null.')
  if (typeof kickOutbox !== 'function') throw new TypeError('kickOutbox must be a function.')

  // The ids of the forum's threads.
  const known = new Set()
  // The ids of the webhooks that sent a stored part, as load() last read them: the site's own, besides the current one.
  const hooks = new Set()
  let botId = null
  // Stryker disable next-line ArrowFunction,StringLiteral: what is logged is for the owner to read, and no test asserts it
  const report = (text) => log(`Librarius ingest: ${text}`)

  /** Do one write of one row. The store refusing it with a TypeError skips the row → false; any other error goes on up. */
  const attempt = (write, what) =>
    // Stryker disable next-line ArrowFunction,StringLiteral: what is logged is for the owner to read, and no test asserts it
    attemptWrite(write, (err) => report(`the store refused ${what}: ${describe(err)}`))

  async function load() {
    for (const id of await store.knownPostIds()) known.add(id)
    for (const id of await store.ownWebhookIds()) hooks.add(id)
  }

  // Calls `step` now, and answers a promise that fails when it throws as much as when it rejects.
  const attempted = (step) => new Promise((resolve) => resolve(step()))

  /** The catch-up, then the posts again. Neither failing is more than a log line: it must never reject. */
  async function catchUp() {
    // Stryker disable next-line ArrowFunction,StringLiteral: the handler only words a log line, and no test asserts the log; that the failure is caught is asserted
    await attempted(onReady).catch((err) => report(`the catch-up failed: ${describe(err)}`))
    // Stryker disable next-line ArrowFunction,StringLiteral: as above
    await attempted(load).catch((err) => report(`the posts could not be loaded: ${describe(err)}`))
  }

  function ready(d) {
    if (isId(d.user?.id)) botId = d.user.id
    // Not waited for: it can run for minutes, and the gateway would give up on the event long before.
    catchUp()
  }

  /** Store a thread when it is the forum's, and listen to it from then on. */
  async function keepThread(raw) {
    const post = parseThread(raw, forumId)
    if (post === null) return
    // Stryker disable next-line StringLiteral: what is logged is for the owner to read, and no test asserts it
    if (await attempt(() => store.upsertPost(post), `post ${post.id}`)) known.add(post.id)
  }

  async function threadListSync(d) {
    if (!Array.isArray(d.threads)) return
    for (const raw of d.threads) await keepThread(raw)
  }

  async function threadDelete(d) {
    if (d.parent_id !== forumId || !isStoreId(d.id)) return
    await store.deletePost(d.id)
    known.delete(d.id)
  }

  /** Whether a webhook (the id an event says, or nothing) is one of ours: the current one, or one that sent a part that is stored. */
  const isOurHook = (id) => typeof id === 'string' && (id === webhookId || hooks.has(id))

  /** Whether a message is a part of a reply of the site that is stored: the outbox stored it, and no event stores it again. */
  async function isStoredPart(id) {
    return isStoreId(id) && (await store.knownPartIds([id])).has(id)
  }

  /**
   * Delete messages: the ones that are parts of a reply of the site take the whole reply, and the others go as they are. `plain` is the ids
   * that are no part of one: when it is shorter than `ids`, the store took a reply, and may have queued the deletion of what is left of it.
   * Its transaction is over by then, so the outbox, told now, finds the entry.
   */
  async function forget(ids, postId) {
    const { plain } = await store.siteDeleted(ids, postId)
    if (plain.length < ids.length) kickOutbox()
    await store.deleteMessages(plain)
  }

  /** Store a message of the gateway or of a re-read, when parseMessage makes a row of it, and it is not one of the site's own. */
  async function keepMessage(raw) {
    const row = parseMessage(raw)
    if (row === null || isOurHook(row.webhookId) || (await isStoredPart(row.id))) return
    // Stryker disable next-line StringLiteral: what is logged is for the owner to read, and no test asserts it
    await attempt(() => store.upsertMessages([row], { keepReactions: true }), `message ${row.id}`)
  }

  async function messageCreate(d) {
    if (known.has(d.channel_id)) await keepMessage(d)
  }

  async function messageUpdate(d) {
    if (!known.has(d.channel_id) || isOurHook(d.webhook_id)) return
    if (isObj(d.author)) return keepMessage(d)
    if (!isStoreId(d.id)) return
    const whole = await fetchMessage(d.channel_id, d.id)
    // Only null means Discord no longer has it.
    if (whole === null) await forget([d.id], d.channel_id)
    else await keepMessage(whole)
  }

  async function messageDelete(d) {
    if (known.has(d.channel_id) && isStoreId(d.id)) await forget([d.id], d.channel_id)
  }

  async function messageDeleteBulk(d) {
    if (!known.has(d.channel_id) || !Array.isArray(d.ids)) return
    await forget(d.ids.filter(isStoreId), d.channel_id)
  }

  /** Whether a reaction event is about a message of a post it listens to, with an id the store can take. */
  const aboutKnown = (d) => known.has(d.channel_id) && isStoreId(d.message_id)

  const reactionChange = (delta) => async (d) => {
    if (!aboutKnown(d) || d.user_id === botId || emojiKey(d.emoji) === null) return
    await store.adjustReaction(await store.messageOfPart(d.message_id), d.emoji, delta)
  }

  async function reactionsClear(d) {
    if (aboutKnown(d)) await store.clearReactions(await store.messageOfPart(d.message_id), null)
  }

  async function reactionsClearEmoji(d) {
    const key = emojiKey(d.emoji)
    if (aboutKnown(d) && key !== null) await store.clearReactions(await store.messageOfPart(d.message_id), key)
  }

  function channelUpdate(d) {
    if (d.id !== forumId) return
    guild.invalidate('forum')
    access.forget()
  }

  function rolesChange() {
    guild.invalidate('guild')
    access.forget()
  }

  const rulesChange = () => guild.invalidate('rules')

  const handlers = new Map([
    ['READY', ready],
    ['THREAD_CREATE', keepThread],
    ['THREAD_UPDATE', keepThread],
    ['THREAD_LIST_SYNC', threadListSync],
    ['THREAD_DELETE', threadDelete],
    ['MESSAGE_CREATE', messageCreate],
    ['MESSAGE_UPDATE', messageUpdate],
    ['MESSAGE_DELETE', messageDelete],
    ['MESSAGE_DELETE_BULK', messageDeleteBulk],
    ['MESSAGE_REACTION_ADD', reactionChange(1)],
    ['MESSAGE_REACTION_REMOVE', reactionChange(-1)],
    ['MESSAGE_REACTION_REMOVE_ALL', reactionsClear],
    ['MESSAGE_REACTION_REMOVE_EMOJI', reactionsClearEmoji],
    ['CHANNEL_UPDATE', channelUpdate],
    ['GUILD_ROLE_CREATE', rolesChange],
    ['GUILD_ROLE_UPDATE', rolesChange],
    ['GUILD_ROLE_DELETE', rolesChange],
    ['GUILD_EMOJIS_UPDATE', (d) => guild.setEmoji(d.emojis)],
    ['AUTO_MODERATION_RULE_CREATE', rulesChange],
    ['AUTO_MODERATION_RULE_UPDATE', rulesChange],
    ['AUTO_MODERATION_RULE_DELETE', rulesChange],
  ])

  return {
    load,
    botUserId: () => botId,
    async dispatch(type, data) {
      // An event with no data is the same as one with nothing in it.
      await handlers.get(type)?.(data ?? {})
    },
  }
}
