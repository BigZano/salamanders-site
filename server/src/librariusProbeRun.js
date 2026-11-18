/**
 * The owner's probe of how Discord treats the replies the site will send to the Librarius (batch 2). It posts a short
 * series of test messages through a webhook of its own into the owner's private test forum, never the Librarius, and
 * prints what Discord answered to each, so that the reply limits and the form of a reply rest on measurements. Run it
 * from the host, with the working directory the `server/` folder of the checkout that holds `.env` (Bun reads `.env`
 * from there; a worktree has none), and this file's path after it:
 *
 *   ../node_modules/.bin/bun src/librariusProbeRun.js                 the run
 *   ../node_modules/.bin/bun src/librariusProbeRun.js --automod       the run, and step 7 as well
 *   ../node_modules/.bin/bun src/librariusProbeRun.js --dry-run       prints what it would send; calls nothing
 *
 * Settings: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, LIBRARIUS_CHANNEL_ID and LIBRARIUS_PROBE_CHANNEL_ID (the test forum);
 * DISCORD_API_BASE as everywhere else. It exits 2, before it sends or creates anything, when LIBRARIUS_PROBE_CHANNEL_ID is
 * missing, is not an id or is the Librarius's own channel, when LIBRARIUS_CHANNEL_ID is set but is not an id (the check
 * against it would then pass for nothing), when the token or the guild is missing, when an argument is not one it
 * knows, and when the probe channel is not a forum (type 15), is not in DISCORD_GUILD_ID, or can be seen by @everyone (its
 * overwrites do not deny View Channel to the role whose id is the guild's). It exits 1 when it could not make its webhook
 * or its post, when it stopped for something it did not foresee, when Discord rate limited it for good (see below), and
 * when it could not delete its webhook. A message that Discord refuses is the finding, not a failure: the run goes on and
 * exits 0. Ctrl-C deletes the webhook, if it has made one, and exits 130.
 *
 * It makes a webhook called "Librarius probe" in the probe forum, one post by that webhook, and then sends into the
 * post, 1500 ms or more apart. The site's outbox will keep that distance between every webhook send, not only between
 * the parts of one reply, so a burst here is the fastest the site goes:
 *   1. a Components V2 message: one Container with a 3988-character Text Display (with the 12 characters of the button's
 *      label, 4000 whether or not Discord counts labels), a Separator, a Media Gallery with a 1x1 PNG attached, and a
 *      link button;
 *   2. a V2 message whose two Text Displays total 4001 characters (to see what Discord says to one over the limit);
 *   3. a V2 message that mentions the guild's owner, with `allowed_mentions: { parse: [] }`;
 *   4. a reply of three V2 messages, 11,500 characters in all, then an edit of the first to add jump links to the others;
 *   5. a plain message of exactly 2000 characters with the suppress-embeds flag;
 *   6. three more replies;
 *   7. with --automod only: the first keyword of the guild's first enabled KEYWORD rule that blocks messages and does not
 *      exempt the probe forum, sent twice about 2 s apart: as a V2 Text Display (7a), then as plain content (7b). If
 *      neither is blocked, AutoMod does not filter webhook posts at all. If only 7b is, it does not read V2 text. It also
 *      prints whether that rule exempts the Librarius forum.
 * A 429 is not resent. The next send waits the longer of 1500 ms and what Discord asked (retry_after in the body, else
 * the Retry-After header), at most 60 s; asked for more, or told the limit is global, the probe sends nothing more and
 * leaves the later steps skipped, but still deletes its webhook.
 * The webhook is deleted at the end; the post is left for the owner to look at. Then it prints a table of every call
 * (step, HTTP status, Discord's code and text, milliseconds, message id), the word to search for and the owner's checklist.
 *
 * Secrets: the webhook's id and token exist only inside this process, and a webhook url is never printed. What Discord
 * says is cut of every link and of the tokens before it is printed, and a failure to reach Discord names the kind of
 * error and nothing it carried. The keyword of step 7 is not printed.
 *
 * Exports are for the test: probeConfig, buildV2, fillText, probePng and runProbe do the work. The file runs only when
 * it is the program Bun was started with.
 */
import { deflateSync } from 'node:zlib'
import { isId, scrub } from './librariusText.js'

const DEFAULT_API = 'https://discord.com/api'
const SITE_URL = 'https://sm2salamanders.site/reliquarium/librarius'
const FORUM = 15
const KEYWORD_RULE = 1
const BLOCK_MESSAGE = 1
// The permission View Channel, and the type of an overwrite that is for a role.
const VIEW_CHANNEL = 1n << 10n
const ROLE_OVERWRITE = 0
// The word in message 1 that the owner searches Discord for, in (d).
const SEARCH_WORD = 'quokkaprobe'
// Message flags: IS_COMPONENTS_V2, and SUPPRESS_EMBEDS.
const V2 = 32768
const SUPPRESS_EMBEDS = 4
// Component types.
const ACTION_ROW = 1
const BUTTON = 2
const TEXT_DISPLAY = 10
const MEDIA_GALLERY = 12
const SEPARATOR = 14
const CONTAINER = 17
const LINK_BUTTON = 5
// The space the plan keeps between two sends: the same 1500 ms the site will keep between the parts of a reply.
const GAP_MS = 1500
// The longest the probe waits on a 429. A limit that asks for more is not waited out: the probe stops sending.
const MAX_RETRY_MS = 60_000
// The two keyword messages of step 7 go about 2 s apart, so that an AutoMod alert for one is not taken for the other.
const KEYWORD_GAP_MS = 2000
const TIMEOUT_MS = 15_000
// A text longer than this is shown by its length in a dry run.
const SHOWN_CHARS = 80
const WEBHOOK_TOKEN = /^[\w-]{8,}$/

const CHECKLIST =
  'Open the probe post on desktop and on a phone. (a) Message 1 shows in full, the image sits inside the box, the button works. (b) Message 3 shows your name as a mention and you got no ping. (c) The 3-part reply reads in order with working jump links. (d) Search Discord for a word from message 1: is it found? (e) Your moderators\' AutoMod alert channel shows nothing (or, with --automod, what it shows). (f) Your account has no timeout or warning. Reply with the table and a–f.'

const USAGE = 'Unknown argument. usage: bun src/librariusProbeRun.js [--automod] [--dry-run]'
const DELETE_BY_HAND = 'Edit Channel → Integrations → Webhooks'
const MAYBE_MADE = `If a webhook named "Librarius probe" exists in the probe forum, delete it: ${DELETE_BY_HAND}.`

/** The probe will not run with what it was given. The message names a setting or an argument, never a value. */
export class ProbeRefused extends Error {
  name = 'ProbeRefused'
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

function parseArgs(argv) {
  const flags = { automod: false, dry: false }
  for (const arg of argv) {
    if (arg === '--automod') flags.automod = true
    else if (arg === '--dry-run') flags.dry = true
    else throw new ProbeRefused(USAGE)
  }
  return flags
}

/**
 * → { apiBase, botToken, guildId, probeId, librariusId } from the environment, or throws ProbeRefused. librariusId is
 * null when LIBRARIUS_CHANNEL_ID is unset or empty; when it is set it has to be an id, or the check of the probe forum
 * against it would compare with nothing and pass.
 */
export function probeConfig(env) {
  const probeId = env.LIBRARIUS_PROBE_CHANNEL_ID
  if (probeId === undefined || probeId === '') {
    throw new ProbeRefused('LIBRARIUS_PROBE_CHANNEL_ID is not set. It is the id of the private test forum the probe posts into.')
  }
  if (!isId(probeId)) throw new ProbeRefused('LIBRARIUS_PROBE_CHANNEL_ID is not a Discord channel id (17 to 20 digits).')
  const librarius = env.LIBRARIUS_CHANNEL_ID
  const librariusSet = librarius !== undefined && librarius !== ''
  if (librariusSet && !isId(librarius)) {
    throw new ProbeRefused('LIBRARIUS_CHANNEL_ID is set but is not a Discord channel id (17 to 20 digits), so the probe cannot tell it from its own forum.')
  }
  // Discord reads an id as a number, so a leading zero does not name another channel.
  if (librariusSet && BigInt(probeId) === BigInt(librarius)) {
    throw new ProbeRefused("LIBRARIUS_PROBE_CHANNEL_ID is the Librarius's own channel (LIBRARIUS_CHANNEL_ID). The probe never posts there.")
  }
  const botToken = env.DISCORD_BOT_TOKEN
  if (typeof botToken !== 'string' || botToken === '') throw new ProbeRefused('DISCORD_BOT_TOKEN is not set.')
  const guildId = env.DISCORD_GUILD_ID
  if (!isId(guildId)) throw new ProbeRefused('DISCORD_GUILD_ID is not a Discord guild id (17 to 20 digits).')
  const base = typeof env.DISCORD_API_BASE === 'string' && env.DISCORD_API_BASE !== '' ? env.DISCORD_API_BASE : DEFAULT_API
  return { apiBase: base.replace(/\/+$/, ''), botToken, guildId, probeId, librariusId: librariusSet ? librarius : null }
}

/**
 * → text of exactly `length` characters that starts with `label`: numbered words after it, so that a cut shows where
 * it fell. No line breaks, so that the count is the same however Discord counts them.
 */
export function fillText(label, length) {
  if (!Number.isInteger(length) || length < 0) throw new RangeError('length must be a whole number of at least 0.')
  let text = label
  for (let n = 1; text.length < length; n++) text += ` w${String(n).padStart(4, '0')}`
  return text.slice(0, length)
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes) {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write(type, 4, 'ascii')
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length)
  return chunk
}

/** → the bytes of a valid PNG one pixel by one: 8-bit RGBA, a green that is not transparent. */
export function probePng() {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0) // width
  header.writeUInt32BE(1, 4) // height
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  const pixel = Buffer.from([0, 0x2a, 0x6e, 0x3f, 0xff]) // a filter byte (none), then the four channels
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(pixel)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

/**
 * → the V2 part of a message: `flags` and one Container. `text` is one Text Display, or an array of them. With an
 * `image` (a url, or attachment://name for a file sent with the message) or a `button` ({ label, url }, a link button),
 * a Separator follows the text, then the Media Gallery, then the button's action row.
 */
export function buildV2(text, { image, button } = {}) {
  const inner = (Array.isArray(text) ? text : [text]).map((content) => ({ type: TEXT_DISPLAY, content }))
  if (image || button) inner.push({ type: SEPARATOR, divider: true, spacing: 1 })
  if (image) inner.push({ type: MEDIA_GALLERY, items: [{ media: { url: image } }] })
  if (button) {
    inner.push({
      type: ACTION_ROW,
      components: [{ type: BUTTON, style: LINK_BUTTON, label: button.label, url: button.url }],
    })
  }
  return { flags: V2, components: [{ type: CONTAINER, components: inner }] }
}

// Every send goes through here: no mention is ever parsed from the text, whatever it says.
const sendBody = (payload) => ({ ...payload, allowed_mentions: { parse: [] } })

// A long text is shown by its length, so that a dry run fits a screen and a send is never copied from it.
function shown(value) {
  if (typeof value === 'string') return value.length > SHOWN_CHARS ? `<${value.length} characters>` : value
  if (Array.isArray(value)) return value.map(shown)
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shown(v)]))
  return value
}

// What Discord's field errors say, with where in the body they are: the top-level message of a 400 is only "Invalid Form Body".
function problems(errors, path = [], found = []) {
  if (found.length >= 3 || path.length > 8 || !isObject(errors)) return found
  for (const [key, value] of Object.entries(errors)) {
    if (key === '_errors' && Array.isArray(value)) {
      for (const e of value) {
        if (found.length < 3 && isObject(e) && typeof e.message === 'string') found.push(`${path.join('.') || 'body'}: ${e.message}`)
      }
    } else problems(value, [...path, key], found)
  }
  return found
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

const cell = (value) => String(value).replace(/\s+/g, ' ').replace(/\|/g, '/').trim()
const row = (cells) => `| ${cells.map(cell).join(' | ')} |`

// What a 429 asked for, in ms: retry_after of the body (seconds, maybe fractional), else the Retry-After header, else a
// second. Whether it is a limit on the whole bot, which no wait on one route gets round.
function rateLimit(res, answer) {
  const fromBody = isObject(answer) && typeof answer.retry_after === 'number' ? answer.retry_after : Number.NaN
  const fromHeader = Number.parseFloat(res.headers.get('Retry-After'))
  const seconds = [fromBody, fromHeader].find((v) => v >= 0) ?? 1
  const global = (isObject(answer) && answer.global === true) || res.headers.get('X-RateLimit-Global') === 'true'
  return { retryMs: seconds * 1000, global }
}

// Whether the forum's overwrites deny View Channel to @everyone, the role whose id is the guild's: only then is it private.
function everyoneDenied(channel, guildId) {
  const overwrites = Array.isArray(channel.permission_overwrites) ? channel.permission_overwrites : []
  return overwrites.some(
    (o) =>
      isObject(o) &&
      o.id === guildId &&
      o.type === ROLE_OVERWRITE &&
      typeof o.deny === 'string' &&
      /^\d+$/.test(o.deny) &&
      (BigInt(o.deny) & VIEW_CHANNEL) !== 0n,
  )
}

const NOT_SENT = { ok: false, status: 'skipped', code: '', message: '', ms: 0, body: null }

/**
 * Runs the probe → the exit code (0, 1, 2 or 130, as above). `log` and `warn` print a line to stdout and stderr. The rest
 * are the seams the test controls: the network, the clock, and Ctrl-C (`onInterrupt(handler)` → a function that stops
 * listening, `exit(code)`).
 */
export async function runProbe({
  argv = [],
  env = process.env,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  log = console.log,
  warn = console.error,
  onInterrupt = (handler) => {
    process.on('SIGINT', handler)
    return () => process.off('SIGINT', handler)
  },
  exit = (code) => process.exit(code),
} = {}) {
  let flags
  let config
  try {
    flags = parseArgs(argv)
    config = probeConfig(env)
  } catch (err) {
    if (!(err instanceof ProbeRefused)) throw err
    warn(`Probe not run: ${err.message}`)
    return 2
  }
  const { apiBase, botToken, guildId, probeId, librariusId } = config
  const dry = flags.dry

  // What must not reach the screen even when Discord says it: the webhook's token and the AutoMod keyword. The bot token
  // goes the same way, in scrub. All are cut out before the text is cut to length, so none is left half there.
  const hidden = []
  const clean = (text) => scrub(hidden.reduce((t, [secret, mark]) => t.replaceAll(secret, mark), String(text)), { secret: botToken })
  const hide = (secret, mark) => {
    if (typeof secret === 'string' && secret !== '') hidden.push([secret, mark])
  }

  const rows = []
  let webhook = null
  // Whether the webhook is being made right now, so that a Ctrl-C then can say it may exist.
  let creating = false
  // The words for the table once nothing more may be sent: Discord's limit that the probe will not wait out, or Ctrl-C.
  let halted = null
  let interrupted = false
  // How long the last 429 asked the next send to wait, which that send spends.
  let owedMs = 0

  const webhookRoute = () => (dry ? '/v10/webhooks/{webhook id}/{webhook token}' : `/v10/webhooks/${webhook.id}/${webhook.token}`)

  const describeResult = (r) =>
    r.status === 'net' ? `no answer (${r.message})` : `HTTP ${r.status}${r.code === '' ? '' : `, code ${r.code}`}${r.message === '' ? '' : `: ${r.message}`}`

  // One call to Discord → { ok, status, code, message, ms, body, retryMs, global }. A dry run prints it and answers `placeholder`.
  async function call({ method, path, query, json, file, bot = false }, placeholder) {
    const search = query ? `?${Object.entries(query).map(([k, v]) => `${k}=${v}`).join('&')}` : ''
    if (dry) {
      log(`${method} ${path}${search}${bot ? '  (as the bot)' : ''}`)
      if (json) log(`  body: ${JSON.stringify(shown(json))}`)
      if (file) log(`  file: ${file.name} (${file.type}, ${file.bytes.length} bytes)`)
      return { ok: true, status: 'dry', code: '', message: '', ms: 0, body: placeholder, retryMs: 0, global: false }
    }
    const headers = {}
    if (bot) headers.Authorization = `Bot ${botToken}`
    let body
    if (file) {
      body = new FormData()
      body.set('payload_json', JSON.stringify(json))
      body.set('files[0]', new Blob([file.bytes], { type: file.type }), file.name)
    } else if (json) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(json)
    }
    const started = now()
    let res
    try {
      res = await fetchImpl(`${apiBase}${path}${search}`, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (err) {
      return { ok: false, status: 'net', code: '', message: unreached(err), ms: now() - started, body: null, retryMs: 0, global: false }
    }
    let answer = null
    try {
      answer = await res.json()
    } catch {
      // No body (a 204) or one that is not JSON.
    }
    const code = isObject(answer) && Number.isInteger(answer.code) ? answer.code : ''
    let message = ''
    let limit = { retryMs: 0, global: false }
    if (!res.ok) {
      const said = [isObject(answer) && typeof answer.message === 'string' ? answer.message : '', ...problems(isObject(answer) ? answer.errors : null)]
      message = clean(said.filter(Boolean).join('; ')) || '(no message)'
      if (res.status === 429) {
        limit = rateLimit(res, answer)
        message += ` (retry after ${limit.retryMs / 1000} s${limit.global ? ', global' : ''})`
      }
    }
    return { ok: res.ok, status: res.status, code, message, ms: now() - started, body: answer, ...limit }
  }

  const messageId = (r) => (r.ok && isObject(r.body) && (dry || isId(r.body.id)) ? r.body.id : '')
  const record = (step, r, id = '') => rows.push([step, r.status, r.code, r.message, r.ms, id])
  const skip = (step, reason) => rows.push([step, 'skipped', '', reason, '', ''])

  // The sends into the post keep 1500 ms between them: the pace the site will keep, which also keeps the webhook's own
  // rate limit out of what is measured. A 429 makes the next send wait what Discord asked, if that is longer.
  let lastSend = null
  async function pace(gap = GAP_MS) {
    if (dry) return
    if (lastSend !== null) {
      const wait = Math.max(gap, owedMs) - (now() - lastSend)
      if (wait > 0) await sleep(wait)
    }
    owedMs = 0
    lastSend = now()
  }

  // A 429 is never resent. It makes the next send wait; asked to wait too long, or told the limit is global, the probe
  // sends nothing more.
  function absorb(r) {
    if (r.status !== 429) return
    if (r.global || r.retryMs > MAX_RETRY_MS) {
      halted ??= `stopped: Discord rate limited the probe ${r.global ? 'for the whole bot' : `and asked it to wait ${r.retryMs / 1000} s`}, so nothing more was sent`
    } else owedMs = r.retryMs
  }

  let postId = null

  async function send(step, payload, { file, gap } = {}) {
    if (halted !== null) {
      skip(step, halted)
      return NOT_SENT
    }
    await pace(gap)
    const r = await call(
      {
        method: 'POST',
        path: webhookRoute(),
        query: { wait: 'true', thread_id: postId, with_components: 'true' },
        json: sendBody(payload),
        file,
      },
      { id: '{message id}' },
    )
    record(step, r, messageId(r))
    absorb(r)
    return r
  }

  async function edit(step, id, payload) {
    if (halted !== null) {
      skip(step, halted)
      return NOT_SENT
    }
    await pace()
    const r = await call(
      {
        method: 'PATCH',
        path: `${webhookRoute()}/messages/${id}`,
        query: { thread_id: postId, with_components: 'true' },
        json: sendBody(payload),
      },
      { id },
    )
    record(step, r, messageId(r))
    absorb(r)
    return r
  }

  // The first keyword of the first rule that is enabled, is a KEYWORD rule, blocks the message and does not exempt the
  // probe forum (a rule that only alerts, or that skips this forum, would measure nothing), without the wildcards that
  // Discord lets a keyword begin and end with. With it, whether that rule exempts the Librarius forum (null: not known).
  async function firstKeyword() {
    const r = await call(
      { method: 'GET', path: `/v10/guilds/${guildId}/auto-moderation/rules`, bot: true },
      [{ trigger_type: KEYWORD_RULE, enabled: true, actions: [{ type: BLOCK_MESSAGE }], exempt_channels: [], trigger_metadata: { keyword_filter: ['{first keyword}'] } }],
    )
    if (!r.ok) return { reason: `the AutoMod rules could not be read (${describeResult(r)})` }
    for (const rule of Array.isArray(r.body) ? r.body : []) {
      if (!isObject(rule) || rule.trigger_type !== KEYWORD_RULE || rule.enabled !== true) continue
      if (!Array.isArray(rule.actions) || !rule.actions.some((a) => isObject(a) && a.type === BLOCK_MESSAGE)) continue
      const exempt = Array.isArray(rule.exempt_channels) ? rule.exempt_channels : []
      if (exempt.includes(probeId)) continue
      const filter = isObject(rule.trigger_metadata) && Array.isArray(rule.trigger_metadata.keyword_filter) ? rule.trigger_metadata.keyword_filter : []
      for (const entry of filter) {
        const keyword = typeof entry === 'string' ? entry.replace(/^\*+|\*+$/g, '').trim() : ''
        if (keyword !== '') return { keyword, exemptsLibrarius: librariusId === null ? null : exempt.includes(librariusId) }
      }
    }
    return { reason: 'there is no enabled KEYWORD rule that blocks messages, has a keyword and does not exempt the probe forum' }
  }

  let automodNote = null

  // The webhook goes whatever happened. The post stays.
  async function removeWebhook(target) {
    const gone = await call({ method: 'DELETE', path: `/v10/webhooks/${target.id}`, bot: true }, {})
    record('cleanup: delete webhook', gone)
    if (!gone.ok) {
      warn(`The probe webhook was NOT deleted (${describeResult(gone)}). Delete the webhook called "Librarius probe" in the probe forum: ${DELETE_BY_HAND}.`)
    }
    return gone.ok
  }

  async function onSigint() {
    if (interrupted) {
      exit(130)
      return
    }
    interrupted = true
    halted = 'stopped: interrupted with Ctrl-C'
    const target = webhook
    webhook = null
    if (target !== null) await removeWebhook(target)
    else if (creating) warn(MAYBE_MADE)
    exit(130)
  }

  // Everything from the channel check to the last step → an exit code when it stops early, undefined when it ran through.
  async function steps() {
    if (dry) log('Dry run: nothing is sent. These are the calls the probe would make, in order. A long text is shown by its length.')

    const channel = await call(
      { method: 'GET', path: `/v10/channels/${probeId}`, bot: true },
      { type: FORUM, guild_id: guildId, permission_overwrites: [{ id: guildId, type: ROLE_OVERWRITE, allow: '0', deny: String(VIEW_CHANNEL) }] },
    )
    if (!channel.ok) {
      warn(`Probe not run: the probe channel could not be read (${describeResult(channel)}).`)
      return 1
    }
    if (!isObject(channel.body) || channel.body.type !== FORUM) {
      const type = isObject(channel.body) && Number.isInteger(channel.body.type) ? channel.body.type : 'unknown'
      warn(`Probe not run: the probe channel is not a forum (it is type ${type}).`)
      return 2
    }
    if (channel.body.guild_id !== guildId) {
      warn('Probe not run: the probe channel is not in DISCORD_GUILD_ID.')
      return 2
    }
    if (!everyoneDenied(channel.body, guildId)) {
      warn('Probe not run: everyone can see the probe forum.')
      return 2
    }

    const guild = await call({ method: 'GET', path: `/v10/guilds/${guildId}`, bot: true }, { owner_id: '{owner id}' })
    const owner = guild.ok && isObject(guild.body) && (dry || isId(guild.body.owner_id)) ? guild.body.owner_id : null
    const ownerSkipped = guild.ok ? 'the guild gave no owner id' : `the guild could not be read (${describeResult(guild)})`
    if (interrupted) return 130

    creating = true
    const made = await call(
      { method: 'POST', path: `/v10/channels/${probeId}/webhooks`, json: { name: 'Librarius probe' }, bot: true },
      { id: '{webhook id}', token: '{webhook token}' },
    )
    creating = false
    record('setup: webhook', made)
    if (!dry && isObject(made.body)) hide(made.body.token, '[token]')
    if (!made.ok || !isObject(made.body) || !(dry || isId(made.body.id))) {
      warn(`Probe stopped: the webhook could not be made (${describeResult(made)}).`)
      // It may be there all the same: an answer that never came says nothing about what Discord did.
      warn(MAYBE_MADE)
      return 1
    }
    webhook = { id: made.body.id, token: made.body.token }
    if (!dry && !WEBHOOK_TOKEN.test(webhook.token)) {
      warn('Probe stopped: Discord gave a webhook with no usable token.')
      return 1
    }
    if (interrupted) return 130

    await pace()
    const started = await call(
      {
        method: 'POST',
        path: webhookRoute(),
        query: { wait: 'true' },
        json: sendBody({
          thread_name: `Librarius probe ${new Date(now()).toISOString()}`,
          content: 'Probe post. These messages test how Discord treats the Librarius replies; nothing here is real.',
        }),
      },
      { id: '{post id}', channel_id: '{post id}' },
    )
    record('setup: post', started, messageId(started))
    if (!started.ok || !isObject(started.body) || !(dry || isId(started.body.channel_id))) {
      warn(`Probe stopped: the post could not be made (${describeResult(started)}).`)
      return 1
    }
    postId = started.body.channel_id

    await send(
      '1 V2, 3988 chars, image, button',
      {
        ...buildV2(fillText(`Probe message one, search word ${SEARCH_WORD}: `, 3988), {
          image: 'attachment://probe.png',
          button: { label: 'Open On Site', url: SITE_URL },
        }),
        attachments: [{ id: 0, filename: 'probe.png' }],
      },
      { file: { name: 'probe.png', type: 'image/png', bytes: probePng() } },
    )

    await send('2 V2, 4001 chars in two text displays', buildV2([fillText('Probe message two, over the limit: ', 2000), fillText('Probe message two, the rest: ', 2001)]))

    if (owner === null) skip('3 V2, owner mention', ownerSkipped)
    else await send('3 V2, owner mention', buildV2(`Probe message three, a mention that must not ping: <@${owner}>`))

    // Part 1 is shorter than the others: the two jump links added to it afterwards must still fit in 4000.
    const parts = [3700, 3900, 3900].map((size, i) => fillText(`Part ${i + 1} of 3: `, size))
    const sent = []
    for (const [i, text] of parts.entries()) sent.push(await send(`4 reply part ${i + 1} of 3`, buildV2(text)))
    const ids = sent.map(messageId)
    if (halted === null && ids.every((id) => id !== '')) {
      const link = (id) => `https://discord.com/channels/${guildId}/${postId}/${id}`
      await edit('4 edit of part 1, jump links', ids[0], buildV2(`${parts[0]}\n\nJump to: [part 2](${link(ids[1])}) · [part 3](${link(ids[2])})`))
    } else skip('4 edit of part 1, jump links', halted ?? 'a part of the reply was not sent')

    await send('5 plain, 2000 chars, no embeds', { content: fillText('Probe message five, plain text: ', 2000), flags: SUPPRESS_EMBEDS })

    for (const n of [1, 2, 3]) await send(`6 burst reply ${n} of 3`, buildV2(`Probe message six, burst reply ${n} of 3.`))

    if (flags.automod) {
      const found = halted === null ? await firstKeyword() : { reason: halted }
      if (found.keyword === undefined) skip('7 AutoMod keyword, V2 text and plain content', found.reason)
      else {
        // The same keyword in both forms. Blocked in one and not the other, AutoMod reads one form and not the other;
        // blocked in neither, by a rule that blocks and does not exempt this forum, it does not filter webhook posts at
        // all, and the site's own check is the only filter for both forms.
        hide(found.keyword, '[keyword]')
        if (found.exemptsLibrarius === null) {
          automodNote = 'LIBRARIUS_CHANNEL_ID is not set, so it is not known whether the AutoMod rule of step 7 exempts the Librarius forum.'
        } else if (found.exemptsLibrarius) {
          automodNote = 'The AutoMod rule of step 7 exempts the Librarius forum (LIBRARIUS_CHANNEL_ID), so it will not act there.'
        } else automodNote = 'The AutoMod rule of step 7 does not exempt the Librarius forum (LIBRARIUS_CHANNEL_ID).'
        await send('7a AutoMod keyword, V2 text', buildV2(`Probe message seven, an AutoMod check: ${found.keyword}`))
        await send(
          '7b AutoMod keyword, plain content',
          { content: `Probe message seven, a plain AutoMod check: ${found.keyword}`, flags: SUPPRESS_EMBEDS },
          { gap: KEYWORD_GAP_MS },
        )
      }
    }
    if (interrupted) return 130
    if (halted !== null) {
      warn(`Probe ${halted}. Run it again later.`)
      return 1
    }
    return undefined
  }

  const stopListening = dry ? () => {} : onInterrupt(onSigint)
  let code
  try {
    code = (await steps()) ?? 0
  } catch (err) {
    let said = ''
    try {
      said = `${err?.name}: ${err?.message}`
    } catch {
      // An error whose fields cannot be read says nothing.
    }
    warn(`Probe stopped part way: ${clean(said)}`)
    code = 1
  }

  if (webhook !== null) {
    const target = webhook
    webhook = null
    if (!(await removeWebhook(target))) code ||= 1
  }
  stopListening()

  if (dry) {
    log('Dry run: nothing was sent.')
    return code
  }
  if (postId !== null) log(`Probe post: https://discord.com/channels/${guildId}/${postId}`)
  if (rows.length > 0) {
    log(row(['Step', 'HTTP', 'Code', 'Discord says', 'ms', 'Message id']))
    log(row(['---', '---', '---', '---', '---', '---']))
    for (const r of rows) log(row(r))
  }
  if (postId !== null && halted === null) {
    log('')
    if (automodNote !== null) log(automodNote)
    log(`search word for (d): ${SEARCH_WORD}, and Discord's search index can lag a few minutes`)
    log('')
    log(CHECKLIST)
  }
  return code
}

if (import.meta.main) process.exitCode = await runProbe({ argv: process.argv.slice(2) })
