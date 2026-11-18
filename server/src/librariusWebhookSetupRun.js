/**
 * The owner's one-time setup of the Librarius's webhook (batch 2): it makes a webhook called "Librarius" on the Librarius
 * forum with the bot's token, and prints its address, the one value the site's replies need, once. Run it from the host,
 * with the working directory the `server/` folder of the checkout that holds `.env` (Bun reads `.env` from there; a
 * worktree has none), and this file's path after it:
 *
 *   ../node_modules/.bin/bun src/librariusWebhookSetupRun.js              makes the webhook
 *   ../node_modules/.bin/bun src/librariusWebhookSetupRun.js --dry-run    prints what it would call; calls nothing
 *
 * Settings: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID and LIBRARIUS_CHANNEL_ID (the Librarius forum); DISCORD_API_BASE as
 * everywhere else. It exits 2, before it calls anything, when one of them is missing or is not what it should be or when an
 * argument is not one it knows, and again when the channel is not a forum or is not in DISCORD_GUILD_ID. It exits 1 when
 * Discord refused or did not answer, and when a webhook named "Librarius" that this bot made is already on the forum: it
 * then makes nothing and prints that webhook's id and how to delete it by hand (the address of a webhook is shown only when
 * it is made, so a second one is not made beside the first, and an old one is removed by the owner, not here).
 *
 * On success it prints one line to standard output, `LIBRARIUS_WEBHOOK_URL=` and the address, and says on standard error to
 * paste that line into `server/.env` and to rebuild the API. The address is a secret (whoever has it can post as the
 * Librarius), so it is printed nowhere else, and neither is the bot's token. What Discord says in a failure is cut of every
 * link and of the tokens before it is printed, and a failure to reach Discord names the kind of error and nothing it
 * carried. A webhook that may have been made though no answer came is named in the message, for the owner to delete.
 *
 * Exports are for the test: setupConfig and runSetup do the work. The file runs only when it is the program Bun was
 * started with.
 */
import { isId, scrub } from './librariusText.js'
import { webhookUrl } from './librariusWebhook.js'

const DEFAULT_API = 'https://discord.com/api'
const NAME = 'Librarius'
const FORUM = 15
const TIMEOUT_MS = 15_000
const USAGE = 'Unknown argument. usage: bun src/librariusWebhookSetupRun.js [--dry-run]'
const DELETE_BY_HAND = `Edit Channel → Integrations → Webhooks → ${NAME} → Delete Webhook`

/** The setup will not run with what it was given. The message names a setting or an argument, never a value. */
export class SetupRefused extends Error {
  name = 'SetupRefused'
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** → { apiBase, botToken, guildId, channelId } from the environment, or throws SetupRefused. */
export function setupConfig(env) {
  const botToken = env.DISCORD_BOT_TOKEN
  if (typeof botToken !== 'string' || botToken === '') throw new SetupRefused('DISCORD_BOT_TOKEN is not set.')
  if (!isId(env.DISCORD_GUILD_ID)) throw new SetupRefused('DISCORD_GUILD_ID is not a Discord guild id (17 to 20 digits).')
  const channelId = env.LIBRARIUS_CHANNEL_ID
  if (channelId === undefined || channelId === '') throw new SetupRefused('LIBRARIUS_CHANNEL_ID is not set. It is the id of the Librarius forum.')
  if (!isId(channelId)) throw new SetupRefused('LIBRARIUS_CHANNEL_ID is not a Discord channel id (17 to 20 digits).')
  const base = typeof env.DISCORD_API_BASE === 'string' && env.DISCORD_API_BASE !== '' ? env.DISCORD_API_BASE : DEFAULT_API
  return { apiBase: base.replace(/\/+$/, ''), botToken, guildId: env.DISCORD_GUILD_ID, channelId }
}

const word = (value) => (typeof value === 'string' && /^[\w-]{1,40}$/.test(value) ? value : '')

// What a failure to reach Discord may say: the kind of error and its code, never its message, which can carry the url.
function unreached(err) {
  let name = ''
  let code = ''
  try {
    name = word(err?.name)
    code = word(err?.code)
  } catch {
    // An error whose fields cannot be read is named by nothing.
  }
  return [name || 'Error', code].filter(Boolean).join(' ')
}

/**
 * Runs the setup → the exit code (0, 1 or 2, as above). `log` prints a line to standard output and `warn` to standard
 * error. The rest are the seams the test controls: the arguments, the environment and the network.
 */
export async function runSetup({ argv = [], env = process.env, fetchImpl = fetch, log = console.log, warn = console.error } = {}) {
  let config
  try {
    if (!argv.every((arg) => arg === '--dry-run')) throw new SetupRefused(USAGE)
    config = setupConfig(env)
  } catch (err) {
    if (!(err instanceof SetupRefused)) throw err
    warn(`Setup not run: ${err.message}`)
    return 2
  }
  const { apiBase, botToken, guildId, channelId } = config
  const channelPath = `/v10/channels/${channelId}`

  if (argv.includes('--dry-run')) {
    log('Dry run: nothing is called. These are the calls the setup would make, in order, all as the bot.')
    log('GET /v10/users/@me')
    log(`GET ${channelPath}`)
    log(`GET ${channelPath}/webhooks`)
    log(`POST ${channelPath}/webhooks  body: ${JSON.stringify({ name: NAME })}`)
    log("Then it prints LIBRARIUS_WEBHOOK_URL= and the new webhook's address, once. Dry run: nothing was called.")
    return 0
  }

  // What must not reach the screen even when Discord says it: the bot's token, and the new webhook's once there is one.
  const hidden = []
  const clean = (text) => scrub(hidden.reduce((t, secret) => t.replaceAll(secret, '[token]'), String(text)), { secret: botToken })

  // What Discord answered, for a message: the status and code, and what it said, cut of links and tokens at the time it is asked.
  const said = (r) => {
    if (r.status === null) return `no answer (${r.kind})`
    const text = isObject(r.body) && typeof r.body.message === 'string' ? `: ${clean(r.body.message)}` : ''
    const code = isObject(r.body) && Number.isInteger(r.body.code) ? `, code ${r.body.code}` : ''
    return `HTTP ${r.status}${code}${text}`
  }

  // One call as the bot → { status, body } (body null when it is not JSON), or { status: null, kind } when Discord did not answer.
  async function call(method, path, json) {
    let res
    try {
      res = await fetchImpl(`${apiBase}${path}`, {
        method,
        headers: { Authorization: `Bot ${botToken}`, ...(json === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: json === undefined ? undefined : JSON.stringify(json),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      return { status: null, body: null, kind: unreached(err) }
    }
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  const stop = (what, r) => {
    warn(`Setup stopped: ${what} (${said(r)}). Nothing was made.`)
    return 1
  }

  const me = await call('GET', '/v10/users/@me')
  if (me.status !== 200 || !isObject(me.body) || !isId(me.body.id)) return stop('the bot could not be identified', me)

  const channel = await call('GET', channelPath)
  if (channel.status !== 200 || !isObject(channel.body)) return stop('the Librarius channel could not be read', channel)
  if (channel.body.type !== FORUM) {
    warn('Setup not run: LIBRARIUS_CHANNEL_ID is not a forum channel.')
    return 2
  }
  if (channel.body.guild_id !== guildId) {
    warn('Setup not run: the Librarius channel is not in DISCORD_GUILD_ID.')
    return 2
  }

  const listed = await call('GET', `${channelPath}/webhooks`)
  if (listed.status !== 200 || !Array.isArray(listed.body)) return stop('the webhooks of the Librarius channel could not be listed', listed)
  const mine = (hook) =>
    isObject(hook) &&
    typeof hook.name === 'string' &&
    hook.name.trim().toLowerCase() === NAME.toLowerCase() &&
    ((isObject(hook.user) && hook.user.id === me.body.id) || hook.application_id === me.body.id)
  const existing = listed.body.find(mine)
  if (existing !== undefined) {
    warn(
      `Setup not run: a webhook named "${NAME}" that this bot made is already on the Librarius forum (id ${isId(existing.id) ? existing.id : 'unknown'}). ` +
        `Nothing was made. Discord shows a webhook's address only when it is made, so this one's is wherever it was saved (server/.env). ` +
        `To make a new one, delete this one first (${DELETE_BY_HAND}) and run this again.`,
    )
    return 1
  }

  const made = await call('POST', `${channelPath}/webhooks`, { name: NAME })
  if (isObject(made.body) && typeof made.body.token === 'string') hidden.push(made.body.token)
  if (made.status !== 200 || !isObject(made.body)) {
    warn(`Setup stopped: the webhook could not be made (${said(made)}).`)
    // It may be there all the same: an answer that never came says nothing about what Discord did.
    if (made.status === null) warn(`If a webhook named "${NAME}" is on the Librarius forum now, delete it (${DELETE_BY_HAND}) before you run this again.`)
    return 1
  }
  let address
  try {
    address = webhookUrl(apiBase, made.body.id, made.body.token)
  } catch {
    const named = isId(made.body.id) ? ` Its id is ${made.body.id}.` : ''
    warn(`Setup stopped: Discord made a webhook but gave no usable address for it.${named} Delete it (${DELETE_BY_HAND}) and run this again.`)
    return 1
  }

  log(`LIBRARIUS_WEBHOOK_URL=${address}`)
  warn(
    'The webhook is made. Paste the line above into server/.env on the host that runs the API, then rebuild the API. ' +
      'It is a secret: whoever has it can post as the Librarius, so do not paste it anywhere else. Discord does not show it again; ' +
      `if it is lost, delete the webhook (${DELETE_BY_HAND}) and run this again.`,
  )
  return 0
}

if (import.meta.main) process.exitCode = await runSetup({ argv: process.argv.slice(2) })
