/**
 * The owner's one-time setup of the Librarius's webhook (batch 2): it makes a webhook called "Librarius" on the Librarius
 * forum with the bot's token, and prints its address, the one value the site's replies need. Run it from the host, by
 * hand and not through an assistant or a script that keeps what it prints, with the working directory the `server/`
 * folder of the checkout that holds `.env` (Bun reads `.env` from there; a worktree has none), and this file's path after
 * it:
 *
 *   ../node_modules/.bin/bun src/librariusWebhookSetupRun.js                     makes the webhook
 *   ../node_modules/.bin/bun src/librariusWebhookSetupRun.js --print-existing    also prints the address of one that is there
 *   ../node_modules/.bin/bun src/librariusWebhookSetupRun.js --dry-run           says what it would call; calls nothing
 *
 * Settings: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID and LIBRARIUS_CHANNEL_ID (the Librarius forum); DISCORD_API_BASE as
 * everywhere else. It exits 2, before it calls anything, when one of them is missing or is not what it should be or when an
 * argument is not one it knows, and again when the channel is not a forum or is not in DISCORD_GUILD_ID. It exits 1 when
 * Discord refused or did not answer, when two or more webhooks named "Librarius" that this bot made are on the forum (it
 * lists their ids, and cannot tell which one the site uses), and when one is there, its address was asked for, and Discord
 * gave no usable address for it. A webhook that is already there is not made again. Its address is printed only with
 * --print-existing: Discord lists the address of a webhook of this kind to the bot that may manage webhooks, so that run
 * prints it, the same one as ever, and makes nothing; without the flag the run gives its id, says how to print the
 * address, and exits 0. A second webhook would be another sender: a webhook can edit and delete only its own messages, so
 * once the site has sent replies through the first, this one must never be deleted (nor a new one put in its place) to
 * get its address back.
 *
 * Standard output carries one line at most, `LIBRARIUS_WEBHOOK_URL=` and the address, and only when the run exits 0, so
 * it can go straight into a file, as the README has it (`>> .env`). Everything else goes to standard error: where the line is (in
 * `server/.env` when it went there, else above) and that the API is rebuilt after, the dry run, every refusal. The address is a secret (whoever has it can post as the
 * Librarius), so it is printed nowhere else, and neither is the bot's token. What Discord says in a failure is cut of
 * every link and of the tokens before it is printed, and a failure to reach Discord names the kind of error and nothing it
 * carried. A webhook that may have been made though no answer came is found by running this again with --print-existing.
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
const DRY_RUN = '--dry-run'
const PRINT_EXISTING = '--print-existing'
const USAGE = `Unknown argument. usage: bun src/librariusWebhookSetupRun.js [${DRY_RUN}] [${PRINT_EXISTING}]`
const WEBHOOKS_PAGE = `Edit Channel → Integrations → Webhooks → ${NAME}`
const KEEP_IT = 'Do not delete the webhook once the site has sent replies: a new webhook cannot edit or delete what this one sent.'
// Where the line with the address is. The README runs this with standard output added to server/.env (`>> .env`), so the line is in the
// file and never on the screen: "the line above" would point at nothing.
const THE_LINE = 'is the one line on standard output, LIBRARIUS_WEBHOOK_URL=…'
const IN_ENV = "with >> .env (the README's way) that line is now the last of server/.env, so check that grep -c '^LIBRARIUS_WEBHOOK_URL=' .env says 1"

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
    if (!argv.every((arg) => arg === DRY_RUN || arg === PRINT_EXISTING)) throw new SetupRefused(USAGE)
    config = setupConfig(env)
  } catch (err) {
    if (!(err instanceof SetupRefused)) throw err
    warn(`Setup not run: ${err.message}`)
    return 2
  }
  const { apiBase, botToken, guildId, channelId } = config
  const channelPath = `/v10/channels/${channelId}`
  const printExisting = argv.includes(PRINT_EXISTING)

  if (argv.includes(DRY_RUN)) {
    warn('Dry run: nothing is called. These are the calls the setup would make, in order, all as the bot.')
    warn('GET /v10/users/@me')
    warn(`GET ${channelPath}`)
    warn(`GET ${channelPath}/webhooks`)
    warn(`POST ${channelPath}/webhooks  body: ${JSON.stringify({ name: NAME })}  (only when no webhook named "${NAME}" that this bot made is there)`)
    warn(
      printExisting
        ? 'Then it prints LIBRARIUS_WEBHOOK_URL= and the address of the webhook it made, or of the one that is there already, on standard output.'
        : `Then it prints LIBRARIUS_WEBHOOK_URL= and the address of the webhook it made, on standard output. Of a webhook that is there already it prints the id, and the address only with ${PRINT_EXISTING}.`,
    )
    warn('Dry run: nothing was called.')
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
  const idOf = (hook) => (isId(hook.id) ? hook.id : 'unknown')
  const ours = listed.body.filter(mine)
  if (ours.length > 1) {
    warn(
      `Setup not run: ${ours.length} webhooks named "${NAME}" that this bot made are on the Librarius forum (ids ${ours.map(idOf).join(', ')}), so it cannot tell which one the site uses. ` +
        'Nothing was made and no address was printed. The site uses the one whose id is in LIBRARIUS_WEBHOOK_URL in server/.env (…/webhooks/<id>/…). ' +
        'Do not delete one that the site has sent replies through: a new webhook cannot edit or delete what it sent.',
    )
    return 1
  }
  const existing = ours[0]
  if (existing !== undefined) {
    const id = idOf(existing)
    if (!printExisting) {
      warn(`A ${NAME} webhook is there (id ${id}). Run again with ${PRINT_EXISTING} to print its address.`)
      warn(`Nothing was made. ${KEEP_IT}`)
      return 0
    }
    let found = null
    if (typeof existing.token === 'string') {
      hidden.push(existing.token)
      try {
        found = webhookUrl(apiBase, existing.id, existing.token)
      } catch {
        // Discord gave no address that the client takes: it is said below.
      }
    }
    if (found === null) {
      warn(
        `Setup not run: a webhook named "${NAME}" that this bot made is already on the Librarius forum (id ${id}), but Discord gave no usable address for it. ` +
          `Nothing was made. Copy its address from ${WEBHOOKS_PAGE} → Copy Webhook URL. ${KEEP_IT}`,
      )
      return 1
    }
    log(`LIBRARIUS_WEBHOOK_URL=${found}`)
    warn(
      `A webhook named "${NAME}" that this bot made is already on the Librarius forum (id ${id}), so none was made. Its address, the address of the webhook this command made on an earlier run, ${THE_LINE}: ` +
        `${IN_ENV}; without >> .env, the line is above: put it into server/.env if it is not there. It is a secret: whoever has it can post as the Librarius, so do not paste it anywhere else. ${KEEP_IT}`,
    )
    return 0
  }

  const made = await call('POST', `${channelPath}/webhooks`, { name: NAME })
  if (isObject(made.body) && typeof made.body.token === 'string') hidden.push(made.body.token)
  if (made.status !== 200 || !isObject(made.body)) {
    warn(`Setup stopped: the webhook could not be made (${said(made)}).`)
    // It may be there all the same: an answer that never came says nothing about what Discord did.
    if (made.status === null) warn(`If a webhook named "${NAME}" is on the Librarius forum now, run this again with ${PRINT_EXISTING}: it finds that webhook and prints its address, and makes no second one.`)
    return 1
  }
  let address
  try {
    address = webhookUrl(apiBase, made.body.id, made.body.token)
  } catch {
    const named = isId(made.body.id) ? ` Its id is ${made.body.id}.` : ''
    warn(`Setup stopped: Discord made a webhook but gave no usable address for it.${named} Delete it (${WEBHOOKS_PAGE} → Delete Webhook: nothing has been sent through it yet) and run this again.`)
    return 1
  }

  log(`LIBRARIUS_WEBHOOK_URL=${address}`)
  warn(
    `The webhook is made. Its address ${THE_LINE}: ${IN_ENV}; without >> .env, the line is above: put it into server/.env on the host that runs the API. Then rebuild the API. ` +
      'It is a secret: whoever has it can post as the Librarius, so do not paste it anywhere else. ' +
      `If it is lost, run this again with ${PRINT_EXISTING} (it prints the address of the webhook that is there) or copy it from ${WEBHOOKS_PAGE} → Copy Webhook URL. ${KEEP_IT}`,
  )
  return 0
}

if (import.meta.main) process.exitCode = await runSetup({ argv: process.argv.slice(2) })
