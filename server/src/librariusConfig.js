/**
 * The Librarius's settings as index.js reads them from the environment. Pure; never prints a value.
 *
 * librariusConfig(env) → { configured, forumId, report }
 *   configured: whether the Librarius is on. It is when LIBRARIUS_CHANNEL_ID is a Discord channel id (17 to 20 digits,
 *     as a string: a number that prints as one is not one).
 *   forumId: that id, or null when the Librarius is off.
 *   report: null when the variable is unset or empty (the image may ship before the Librarius) or the Librarius is on;
 *     otherwise one line for a startup warning, naming the variable, never its value.
 *
 * repliesConfig(env, apiBase = 'https://discord.com/api') → { webhookUrl, form, reports }
 *   The settings of replying from the site (batch 2), which the Librarius needs only when it is on.
 *   webhookUrl: LIBRARIUS_WEBHOOK_URL when it is an address the webhook client takes (librariusWebhook.js parseWebhookUrl, for this
 *     API base), else null: replies are off, and every write route answers 503. It is a SECRET, and is never in a report.
 *   form: LIBRARIUS_FORM, 'v2' or 'plain' exactly; unset or empty is 'v2' with nothing said, and anything else is 'v2' with a report.
 *   reports: the lines for startup warnings, none of which holds a value: the form first, then why replies are off when they are.
 */
import { DEFAULT_FORM, FORMS } from './librariusForm.js'
import { parseWebhookUrl } from './librariusWebhook.js'

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

const OFF_UNSET = 'Replying from the site is off, so its write routes answer 503: LIBRARIUS_WEBHOOK_URL is not set.'
const OFF_BAD = 'Replying from the site is off, so its write routes answer 503: LIBRARIUS_WEBHOOK_URL is not a Discord webhook address.'
const BAD_FORM = `LIBRARIUS_FORM is neither "${FORMS[0]}" nor "${FORMS[1]}", so replies go out as "${DEFAULT_FORM}".`

/** → whether `value` is an address the webhook client takes for this API base. Any refusal, a bad base included, is a no. */
function isAddress(value, apiBase) {
  try {
    parseWebhookUrl(value, apiBase)
  } catch {
    return false
  }
  return true
}

export function repliesConfig(env, apiBase = 'https://discord.com/api') {
  if (typeof env !== 'object' || env === null) throw new TypeError('env must be an object.')
  const reports = []

  // index.js reads an empty variable as unset.
  const wanted = env.LIBRARIUS_FORM
  const unsetForm = wanted === undefined || wanted === null || wanted === ''
  const form = FORMS.includes(wanted) ? wanted : DEFAULT_FORM
  if (!unsetForm && !FORMS.includes(wanted)) reports.push(BAD_FORM)

  const address = env.LIBRARIUS_WEBHOOK_URL
  if (address === undefined || address === null || address === '') {
    reports.push(OFF_UNSET)
    return { webhookUrl: null, form, reports }
  }
  if (!isAddress(address, apiBase)) {
    reports.push(OFF_BAD)
    return { webhookUrl: null, form, reports }
  }
  return { webhookUrl: address, form, reports }
}
