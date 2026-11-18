/**
 * "Delete on site" (batch 2): the message command in the Apps menu of Discord, which points a member at the site to delete what they
 * wrote there. It deletes nothing and sends nothing to the forum. It answers with a reply only the member sees. Interactions arrive on the
 * gateway connection the API already holds (the application must have no Interactions Endpoint URL set), so this module only reads what
 * the gateway dispatches and makes two kinds of call: it makes the command, and answers an interaction.
 *
 * createCommand({ discord, store, guildId, siteUrl = 'https://sm2salamanders.site', timers = { setTimeout, clearTimeout },
 *   deadlineMs = 2000, log = console.error }) → { dispatch(type, data) → Promise<void> }
 *   `discord` is the Librarius's client (librariusDiscord.js: applicationCommands, createMessageCommand, withMaxWait and, on what
 *   that gives, interactionCallback); `store` has outboxMessage (librariusOutboxStore.js). dispatch never rejects: what goes wrong
 *   is logged (without a token or a link) and the event is over. Nothing in it can throw: every call to Discord and to the store is caught. It is for the gateway's onDispatch; it waits for the answer to an
 *   interaction (up to `deadlineMs` and the call that sends it), so a caller that has other work should not hold it up behind this.
 *
 * READY: makes sure the guild has the command. It lists the application's commands in the guild (the application's id is in READY)
 * and, only if none is a message command (type 3) named "Delete on site", makes it. It never overwrites the list, since other
 * commands may be there. If Discord refuses the bot the right (403), that is said once and the API goes on without the command; any
 * other failure is said each time and is tried again at the next READY.
 *
 * INTERACTION_CREATE of that command in this guild: answers with `POST /interactions/<id>/<token>/callback`, type 4, `flags: 64`
 * (only they see it) and `allowed_mentions: { parse: [] }`, in one of these (the copy is the spec's):
 *   - the message is one this member wrote on the site: "This was written on the site. Delete it there:" and the link
 *     `<site>/reliquarium/librarius/<post>#m-<message>`, the post being the one the store has the message in;
 *   - the message was written in Discord (by anyone): "Written in Discord: use Discord's own Delete.";
 *   - anything else, someone else's message of the site, or one the Librarius does not hold: "Only the author can delete this, on the site."
 * The store is asked within `deadlineMs` (2 seconds: Discord wants the first answer within 3). If it has not answered then, or fails,
 * the answer is "Couldn't check right now; open it on the site:" and a link to the message, from what the interaction says of where it
 * is. The first of the two is the answer, and it is the only one. Anything that is not this command (another type of interaction,
 * another command, another guild) is none of this module's, and is not answered.
 */
import { siteBase } from './librariusWrites.js'
import { describe, isId, isStoreId } from './librariusText.js'

const NAME = 'Delete on site'
const MESSAGE_COMMAND = 3
const APPLICATION_COMMAND = 2
const CHANNEL_MESSAGE = 4
const EPHEMERAL = 64
// The three seconds Discord gives, less what the call that answers takes: the deadline cannot be asked past this.
const MAX_DEADLINE_MS = 2900
// How long the client may make the callback wait for its turn among the Librarius's other calls.
const CALLBACK_WAIT_MS = 1000
const SITE_URL = 'https://sm2salamanders.site'

const COPY = {
  site: (link) => `This was written on the site. Delete it there: ${link}`,
  discord: "Written in Discord: use Discord's own Delete.",
  other: 'Only the author can delete this, on the site.',
  fallback: (link) => `Couldn't check right now; open it on the site: ${link}`,
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

export function createCommand({ discord, store, guildId, siteUrl = SITE_URL, timers = { setTimeout, clearTimeout }, deadlineMs = 2000, log = console.error }) {
  for (const name of ['applicationCommands', 'createMessageCommand', 'withMaxWait']) {
    if (typeof discord?.[name] !== 'function') throw new TypeError(`discord.${name} must be a function.`)
  }
  if (typeof store?.outboxMessage !== 'function') throw new TypeError('store.outboxMessage must be a function.')
  if (!isId(guildId)) throw new TypeError('guildId must be a Discord id.')
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_DEADLINE_MS) throw new RangeError(`deadlineMs must be a whole number of milliseconds from 1 to ${MAX_DEADLINE_MS}.`)
  if (typeof log !== 'function') throw new TypeError('log must be a function.')
  const site = siteBase(siteUrl)

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

  /** → the answer for a message the member asks about, from what the store holds of it. */
  async function answerFor(messageId, memberId) {
    if (!isStoreId(messageId)) return COPY.other
    const found = await store.outboxMessage(messageId)
    if (found === null) return COPY.other
    if (found.origin === 'discord') return COPY.discord
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

  async function answer(d) {
    const data = d.data
    const messageId = data.target_id
    // Whoever asked, if the interaction says: a missing member is no one, and so no one's message is theirs.
    const memberId = isId(d.member?.user?.id) ? d.member.user.id : null
    // Where the message is, as the interaction says: the channel of the message it names, else the one it was made in.
    const channel = data.resolved?.messages?.[messageId]?.channel_id
    const place = isId(channel) ? channel : d.channel_id
    const fallback = COPY.fallback(linkTo(isId(place) ? place : null, messageId))
    // The store is asked in a Promise of its own: one that throws before it answers is a failure like any other.
    const lookup = new Promise((resolve) => resolve(answerFor(messageId, memberId)))
    const content = (await within(lookup)) ?? fallback
    try {
      await discord.withMaxWait(CALLBACK_WAIT_MS).interactionCallback(d.id, d.token, { type: CHANNEL_MESSAGE, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } })
    } catch (err) {
      // Stryker disable next-line StringLiteral: as above
      say(`the answer could not be sent: ${describe(err, { secret: d.token })}`)
    }
  }

  return {
    async dispatch(type, d) {
      if (type === 'READY') {
        const applicationId = d?.application?.id
        if (isId(applicationId)) await ensure(applicationId)
      } else if (type === 'INTERACTION_CREATE') {
        const data = d?.data
        // Only this command, in this guild, and only one that can be answered: it has an id and a token to answer by.
        const ours = d?.type === APPLICATION_COMMAND && d.guild_id === guildId && isObject(data) && data.type === MESSAGE_COMMAND && data.name === NAME
        if (ours && isId(d.id) && typeof d.token === 'string' && d.token !== '') await answer(d)
      }
    },
  }
}
