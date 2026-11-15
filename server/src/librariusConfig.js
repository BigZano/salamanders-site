/**
 * The Librarius's settings as index.js reads them from the environment. Pure; never prints a value.
 *
 * librariusConfig(env) → { configured, forumId, report }
 *   configured: whether the Librarius is on. It is when LIBRARIUS_CHANNEL_ID is a Discord channel id (17 to 20 digits,
 *     as a string: a number that prints as one is not one).
 *   forumId: that id, or null when the Librarius is off.
 *   report: null when the variable is unset or empty (the image may ship before the Librarius) or the Librarius is on;
 *     otherwise one line for a startup warning, naming the variable, never its value.
 */

/** A Discord channel id, as LIBRARIUS_CHANNEL_ID must be. */
const CHANNEL_ID = /^\d{17,20}$/

const REPORT =
  'Librarius is not configured, so every /librarius route answers 503 and the gateway stays off: LIBRARIUS_CHANNEL_ID (not a Discord channel id).'

export function librariusConfig(env) {
  if (typeof env !== 'object' || env === null) throw new TypeError('env must be an object.')
  const value = env.LIBRARIUS_CHANNEL_ID
  // index.js reads an empty variable as unset.
  if (value === undefined || value === null || value === '') return { configured: false, forumId: null, report: null }
  if (typeof value !== 'string' || !CHANNEL_ID.test(value)) return { configured: false, forumId: null, report: REPORT }
  return { configured: true, forumId: value, report: null }
}
