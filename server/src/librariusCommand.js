/**
 * "Delete on site" (batch 2): the message command in the Apps menu of Discord, which points a member at the site to delete what they
 * wrote there. It deletes nothing and sends nothing to the forum. It answers with a reply only the member sees. Interactions arrive on the
 * gateway connection the API already holds (the application must have no Interactions Endpoint URL set), so this module only reads what
 * the gateway dispatches and makes two kinds of call: it makes the command, and answers an interaction.
 *
 * createCommand({ discord, store, guildId, repliesOn, siteUrl = 'https://sm2salamanders.site', timers = { setTimeout, clearTimeout },
 *   now = Date.now, deadlineMs = 1500, log = console.error }) → { dispatch(type, data) → Promise<void> }
 *   `discord` is the Librarius's client (librariusDiscord.js: applicationCommands, createMessageCommand and interactionCallback, which goes
 *   around the client's limits and has a timeout of its own); `store` has messageOfPart and outboxMessage (librariusOutboxStore.js). `repliesOn` is a
 *   function that says whether replying from the site is on now: the command is made whenever the Librarius is, and it is only with the
 *   replies on that it is made in the guild (Ruling B12). It is asked once when the command is made, and must answer true or false then
 *   (a TypeError otherwise): that is what READY goes by, for as long as the API runs. It is asked again for each answer about a reply of
 *   the site, since the replies can go off while the API runs (Discord refuses the webhook, and the outbox stops for good: rB11 M2),
 *   and then anything but true, or a function that throws, is off. `now` is the clock, in milliseconds. dispatch never rejects:
 *   what goes wrong is logged (without a token or a link) and the event is over. Nothing in it can throw: every call to Discord and to the store
 *   is caught. It is for the gateway's onDispatch; it waits for the answer to an interaction (up to `deadlineMs` and the call that sends it),
 *   so a caller that has other work should not hold it up behind this. The gateway hands INTERACTION_CREATE over at once, outside the queue
 *   of its other events (librariusGateway.js), so this is begun when the event comes, and the time it has is counted from then.
 *
 * READY, with the replies on when the command was made: makes sure the guild has the command. It lists the application's commands in the
 * guild (the application's id is in READY) and, only if none is a message command (type 3) named "Delete on site", makes it. It never
 * overwrites the list, since other commands may be there. If Discord refuses the bot the right (403), that is said once and the API goes
 * on without the command; any other failure is said each time and is tried again at the next READY. With the replies off when it was made,
 * READY asks Discord nothing: the command is neither made nor taken away, so one made while they were on is still in the Apps menu, and is
 * still answered.
 *
 * INTERACTION_CREATE of that command in this guild: answers with `POST /interactions/<id>/<token>/callback`, type 4, `flags: 64`
 * (only they see it) and `allowed_mentions: { parse: [] }`, in one of these (the copy is the spec's and Ruling B12's):
 *   - the message is one this member wrote on the site, with the replies on: "This was written on the site. Delete it there:" and the
 *     link `<site>/reliquarium/librarius/<post>#m-<message>`, the post being the one the store has the message in. A later part of a
 *     reply is answered as the reply (the store maps it first, in the same deadline), and linked to the reply;
 *   - the message was written on the site, with the replies off, whoever wrote it: "Deleting from the site is switched off right now. A
 *     moderator can delete this in Discord." Whether they are on is asked once the store has answered, so a member is not sent to a
 *     site whose delete would be refused;
 *   - the message was written in Discord (by anyone): "Written in Discord: use Discord's own Delete.";
 *   - anything else, someone else's message of the site with the replies on, one the Librarius does not hold, or a target that is no
 *     message id (nothing is asked of the store for that one): "Only the author can delete this, on the site."
 * Discord wants the first answer within 3 seconds of the interaction, and the time is spent this way: the store is asked within `deadlineMs`
 * (1500; at most 1900), counted from the moment the event came, and the answer is then sent with a timeout of what is left of 2.8 seconds
 * since then, but never less than a second (CALLBACK_MS): 2,795 ms for an answer sent 5 ms in, 1,100 ms for one sent 1,700 ms in (rB4
 * N3). So the whole is at most 2.8 seconds, or the deadline and a second when the store took most of it, with the rest for the network.
 * If the store has not answered by the deadline, or fails, the answer is "Couldn't check right now; open it on the site:" and a link to
 * the message, from what the interaction says of where it is. The first of the two is the answer, and it is the only one. Anything that
 * is not this command (another type of interaction, another command, another guild) is none of this module's, and is not answered.
 */
import { siteBase } from './librariusWrites.js'
import { describe, isId, isStoreId } from './librariusText.js'

const NAME = 'Delete on site'
const MESSAGE_COMMAND = 3
const APPLICATION_COMMAND = 2
const CHANNEL_MESSAGE = 4
const EPHEMERAL = 64
// The three seconds Discord gives are spent as the store's deadline and then the callback's timeout, and what is left over is the
// network's: the callback has what is left of ANSWER_BY_MS once it is sent, and never less than CALLBACK_MS, and the deadline cannot be
// asked past what leaves the callback its second and 100 ms to spare.
const CALLBACK_MS = 1000
const ANSWER_BY_MS = 2800
const MAX_DEADLINE_MS = 1900
const SITE_URL = 'https://sm2salamanders.site'

const COPY = {
  site: (link) => `This was written on the site. Delete it there: ${link}`,
  discord: "Written in Discord: use Discord's own Delete.",
  off: 'Deleting from the site is switched off right now. A moderator can delete this in Discord.',
  other: 'Only the author can delete this, on the site.',
  fallback: (link) => `Couldn't check right now; open it on the site: ${link}`,
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

export function createCommand({ discord, store, guildId, repliesOn, siteUrl = SITE_URL, timers = { setTimeout, clearTimeout }, now = Date.now, deadlineMs = 1500, log = console.error }) {
  for (const name of ['applicationCommands', 'createMessageCommand', 'interactionCallback']) {
    if (typeof discord?.[name] !== 'function') throw new TypeError(`discord.${name} must be a function.`)
  }
  for (const name of ['outboxMessage', 'messageOfPart']) {
    if (typeof store?.[name] !== 'function') throw new TypeError(`store.${name} must be a function.`)
  }
  if (!isId(guildId)) throw new TypeError('guildId must be a Discord id.')
  if (typeof repliesOn !== 'function') throw new TypeError('repliesOn must be a function.')
  if (typeof now !== 'function') throw new TypeError('now must be a function.')
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_DEADLINE_MS) throw new RangeError(`deadlineMs must be a whole number of milliseconds from 1 to ${MAX_DEADLINE_MS}.`)
  if (typeof log !== 'function') throw new TypeError('log must be a function.')
  const site = siteBase(siteUrl)
  // What READY goes by: whether the replies were on when the command was made.
  const onAtStart = repliesOn()
  if (typeof onAtStart !== 'boolean') throw new TypeError('repliesOn must answer true or false.')

  /** → whether the replies are on now. Anything but true is off, and so is a function that throws: a member is sent to the site only
   * when they can delete there. */
  function onNow() {
    try {
      return repliesOn() === true
    } catch {
      return false
    }
  }

  // Said at most once, so that a bot that may not make the command does not say so at every READY.
  let refusedSaid = false

  /** Say something to the owner. A log that fails changes nothing. */
  function say(text) {
    try {
      // Stryker disable next-line StringLiteral: what is logged is for the owner to read, and no test asserts it
      log(`Librarius command: ${text}`)
    } catch {
      // the log is broken; nothing else is
    }
  }

  async function ensure(applicationId) {
    try {
      const present = await discord.applicationCommands(applicationId)
      if (present.some((c) => c?.name === NAME && c.type === MESSAGE_COMMAND)) return
      if ((await discord.createMessageCommand(applicationId, NAME)) === false && !refusedSaid) {
        refusedSaid = true
        // Stryker disable next-line StringLiteral: as above
        say(`"${NAME}" could not be made: Discord does not let the bot make commands in this server.`)
      }
    } catch (err) {
      // Stryker disable next-line StringLiteral: as above
      say(`"${NAME}" could not be made: ${describe(err)}`)
    }
  }

  /** → the link to a message on the site, or to the list of posts when the post is not known. */
  const linkTo = (postId, messageId) => (postId === null ? `${site}/reliquarium/librarius` : `${site}/reliquarium/librarius/${postId}#m-${messageId}`)

  /**
   * → the answer for a message the member asks about (`targetId` is a message id), from what the store holds of it. A later part of a reply
   * is no message of the store's: the reply it belongs to is what is asked about, and linked to.
   */
  async function answerFor(targetId, memberId) {
    const messageId = await store.messageOfPart(targetId)
    // What goes into a link is checked first.
    if (!isStoreId(messageId)) return COPY.other
    const found = await store.outboxMessage(messageId)
    if (found === null) return COPY.other
    if (found.origin === 'discord') return COPY.discord
    // With the replies off nobody can delete it from the site: it is the same answer for its author and for anyone else. They are
    // asked now, after the store, since they can go off while the API runs.
    if (found.origin === 'site' && !onNow()) return COPY.off
    if (found.origin === 'site' && found.authorId === memberId) return COPY.site(linkTo(found.postId, messageId))
    return COPY.other
  }

  /** → what `lookup` answers, or null if it fails or has not answered in `deadlineMs`: whichever comes first. */
  function within(lookup) {
    return new Promise((resolve) => {
      const timer = timers.setTimeout(() => resolve(null), deadlineMs)
      const over = (value) => {
        timers.clearTimeout(timer)
        resolve(value)
      }
      lookup.then(over, (err) => {
        // Stryker disable next-line StringLiteral: as above
        say(`the message could not be looked up: ${describe(err)}`)
        over(null)
      })
    })
  }

  /** → what to say when the store has not answered: the link to the message, from what the interaction says of where it is. `messageId` is one the store could be asked of. */
  function fallbackFor(d, messageId) {
    // Where the message is, as the interaction says: the channel of the message it names, else the one it was made in.
    const channel = d.data.resolved?.messages?.[messageId]?.channel_id
    const place = isId(channel) ? channel : d.channel_id
    return COPY.fallback(linkTo(isId(place) ? place : null, messageId))
  }

  /** → the callback's timeout: what is left of ANSWER_BY_MS since the event came at `cameAt`, and never less than a second. A clock
   * that has gone back counts as no time spent. */
  const callbackTimeout = (cameAt) => Math.max(CALLBACK_MS, ANSWER_BY_MS - Math.max(0, now() - cameAt))

  async function answer(d, cameAt) {
    // A target that is no message id is none the store holds, and no link is made for it: what goes into a link is checked first.
    const messageId = isStoreId(d.data.target_id) ? d.data.target_id : null
    // Whoever asked, if the interaction says: a missing member is no one, and so no one's message is theirs.
    const memberId = isId(d.member?.user?.id) ? d.member.user.id : null
    let content = COPY.other
    if (messageId !== null) {
      // The store is asked in a Promise of its own: one that throws before it answers is a failure like any other.
      const lookup = new Promise((resolve) => resolve(answerFor(messageId, memberId)))
      content = (await within(lookup)) ?? fallbackFor(d, messageId)
    }
    try {
      await discord.interactionCallback(d.id, d.token, { type: CHANNEL_MESSAGE, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } }, { timeoutMs: callbackTimeout(cameAt) })
    } catch (err) {
      // Stryker disable next-line StringLiteral: as above
      say(`the answer could not be sent: ${describe(err, { secret: d.token })}`)
    }
  }

  return {
    async dispatch(type, d) {
      if (type === 'READY') {
        const applicationId = d?.application?.id
        if (onAtStart && isId(applicationId)) await ensure(applicationId)
      } else if (type === 'INTERACTION_CREATE') {
        // The three seconds are counted from here: the gateway hands the event over the moment it comes.
        const cameAt = now()
        const data = d?.data
        // Only this command, in this guild, and only one that can be answered: it has an id and a token to answer by.
        const ours = d?.type === APPLICATION_COMMAND && d.guild_id === guildId && isObject(data) && data.type === MESSAGE_COMMAND && data.name === NAME
        if (ours && isId(d.id) && typeof d.token === 'string' && d.token !== '') await answer(d, cameAt)
      }
    },
  }
}
