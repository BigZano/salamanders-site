/**
 * The small helpers the Librarius's modules share: what an error may say in a log or in a status a page shows, one write
 * that the store may refuse, and the check for an id the store can take. Pure: no I/O.
 *
 * Nothing that carries a secret or a signed link may reach a log or a page, so every module words a failure with
 * describe() or scrub() and never by hand. Both cut every link out, cap the text at 200 characters and, when they are
 * given the bot token as `secret`, replace it. They never throw: they are what a failure path calls, and a failure path
 * that fails hides the failure it was reporting.
 *
 * isId(value) → whether it is a Discord snowflake: text of 17 to 20 digits.
 * isStoreId(value) → whether it is a snowflake that also fits the store's bigint (BIGINT_MAX), the only kind the store
 *   takes, so that one id of an event or a request can never make a whole batch fail.
 * scrub(text, { secret }?) → text (anything else is printed first, and nothing is '') with the secret (when it is a non-empty text) replaced by `[token]`, every link cut out
 *   as `[link]` and the whole cut to 200 characters.
 * describe(err, { secret }?) → `Name: message` of anything that was thrown, scrubbed. Something that is no error is
 *   `Error: `, and a name or message that cannot be read or printed (a getter that throws, a Symbol) counts as missing.
 * attempt(write, onRefused) → Promise<boolean>: runs one write of one row. The store refusing it with a TypeError (an id
 *   that does not fit its bigint, say) hands that error to onRefused and answers false; any other failure goes on up.
 *
 * A link is one that starts with http, https, ws or wss and `://` (in any case), or a Discord CDN or media host with a
 * path (`cdn.discordapp.com/…`, `media.discordapp.net/…`), and it runs to the next whitespace. The signed part of an
 * attachment link is in the path and query, so the host name alone, with no path, is left as it is.
 */

const SNOWFLAKE = /^\d{17,20}$/
const MAX_LENGTH = 200
// A scheme, or a Discord CDN or media host with the path that follows it: to the next whitespace, whatever the case.
const LINK = /(?:(?:https?|wss?):\/\/|(?:cdn\.discordapp\.com|media\.discordapp\.net)\/)\S*/gi

/** The most a Postgres bigint holds. */
export const BIGINT_MAX = 9223372036854775807n

export const isId = (value) => typeof value === 'string' && SNOWFLAKE.test(value)

export const isStoreId = (value) => isId(value) && BigInt(value) <= BIGINT_MAX

/** → `value` as text, or `fallback` when it is missing or cannot be printed (an object with no prototype cannot). */
function printed(value, fallback) {
  if (value === undefined || value === null) return fallback
  try {
    return String(value)
  } catch {
    return fallback
  }
}

/** → what `key` of `err` says as text, or `fallback` when it is missing, cannot be read (nothing to read it from, or a getter that throws) or cannot be printed. */
function field(err, key, fallback) {
  try {
    return printed(err[key], fallback)
  } catch {
    return fallback
  }
}

/** → the secret in `options`, or null when there is none that can be used: only a non-empty text is one. Options that are missing, or whose secret cannot be read, have none. */
function secretOf(options) {
  try {
    const { secret } = options
    return typeof secret === 'string' && secret !== '' ? secret : null
  } catch {
    return null
  }
}

/** → the first 200 characters of `text`, with no character cut in two. */
function capped(text) {
  let out = ''
  for (const character of text) {
    if (out.length + character.length > MAX_LENGTH) break
    out += character
  }
  return out
}

export function scrub(text, options) {
  const secret = secretOf(options)
  const whole = printed(text, '')
  const bare = secret === null ? whole : whole.replaceAll(secret, '[token]')
  return capped(bare.replace(LINK, '[link]'))
}

export function describe(err, options) {
  return scrub(`${field(err, 'name', 'Error')}: ${field(err, 'message', '')}`, options)
}

export async function attempt(write, onRefused) {
  if (typeof write !== 'function') throw new TypeError('write must be a function.')
  if (typeof onRefused !== 'function') throw new TypeError('onRefused must be a function.')
  try {
    await write()
    return true
  } catch (err) {
    if (!(err instanceof TypeError)) throw err
    onRefused(err)
    return false
  }
}
