/**
 * What the Librarius gives the Legion Archive's markdown renderer (ArchiveMarkdown) to turn Discord's text into the
 * page: where a link goes, how a custom emoji looks, and what a mention is called. Every address that reaches the page
 * passes through here, and Discord's text is untrusted, so each is one of three things: a route in this site, an
 * external https link, or plain text.
 *
 * createRenderCtx({ guildId, postTitles, people, roles }) → { link(href), emoji(node), mention(node) }
 *   guildId     the guild the Librarius is in: a snowflake string.
 *   postTitles  a Map of post id → title, for every post the site knows. A link or mention is one of ours only for these.
 *   people      { member id: { name, avatar } }, as the Librarius routes answer them.
 *   roles       [{ id, name, color }], as /librarius/me answers them; color is "#rrggbb" or null.
 *   The tables are read when the functions are called, not copied, so one made early sees what is added to them later.
 *   An argument of the wrong kind is a TypeError.
 *
 * link(href) → { kind: 'route', to } for a Discord link, or a channel mention (<#id>), that names a post in postTitles:
 *   to is /reliquarium/librarius/<post>, then #m-<message> when it names a message. A link takes its guild from its
 *   address, and it must be guildId; a channel mention is of the guild it is written in, so it names none.
 *   → { kind: 'external', href } for any other https address, Discord's own included (href is the text as it was given).
 *   → { kind: 'text' } for anything else: javascript:, data:, http: and every other scheme, an address with white space,
 *   a control character or an invisible one in it, and anything that is no string.
 *
 * mention(node) → { label, color }. A member is "@name" from `people`, else "@unknown-member". A role is "@name" in its
 *   colour (null unless it is "#rrggbb"), else "@unknown-role". A channel is the title of the post, else "#channel".
 *
 * emoji(node) → the <img> of the emoji on Discord's CDN, 48 pixels, a gif when it is animated and a webp when it is not;
 *   or ":name:" as text when its id is no id, since no address is made from one.
 *
 * httpsUrl(url) → url when it is an https address of the kind link() takes as external, else null.
 * attachmentUrl(url) → the address, as the browser reads it, when it is on Discord's CDN under /attachments/, else null.
 * proxyImageUrl(url) → the address, as the browser reads it, when it is on Discord's media proxy, else null. The page
 *   shows an attachment or an embed's picture only from an address one of these two has passed.
 */
import { h } from 'vue'
import { parseDiscordRef } from '../archive/links'

const SNOWFLAKE = /^\d{17,20}$/
const CHANNEL_MENTION = /^<#\d{17,20}>$/
// https://, a first character that is no separator, white space, control or format (invisible) character, and the rest
// without any of those. The u flag makes \p{Cc} and \p{Cf} mean the control and format characters.
const HTTPS_URL = /^https:\/\/[^\p{Cc}\p{Cf}\s/?#\\][^\p{Cc}\p{Cf}\s]*$/iu
const ROLE_COLOR = /^#[0-9a-f]{6}$/i
const EMOJI_NAME = /^\w{1,32}$/
const CDN_ATTACHMENTS = 'https://cdn.discordapp.com/attachments/'
const MEDIA_PROXY = /^https:\/\/(?:media|images-ext-\d+)\.discordapp\.net\//
const POST_ROUTE = '/reliquarium/librarius/'

const isTable = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const named = (value) => typeof value === 'string' && value !== ''
// An entry the table has itself: an id that is the name of something on Object.prototype finds nothing.
const entry = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined)

/** → the address when it is an https address with a host and nothing invisible in it, else null. */
export const httpsUrl = (url) => (typeof url === 'string' && HTTPS_URL.test(url) ? url : null)

/** → the link, normalised, when it starts with `prefix` both as written and once parsed (which stops `/../`), else null. */
function under(url, prefix) {
  if (typeof url !== 'string' || !url.startsWith(prefix)) return null
  // The prefix names the scheme and host, so what follows can be any text and `new URL` cannot throw.
  const href = new URL(url).href
  return href.startsWith(prefix) ? href : null
}

/** → the address when it is on Discord's CDN under /attachments/, else null. */
export const attachmentUrl = (url) => under(url, CDN_ATTACHMENTS)

/** → the address, as the browser reads it, when it is on Discord's media proxy, else null. */
// The text names the scheme and host before anything else is read, so `new URL` cannot throw on what passes.
export const proxyImageUrl = (url) => (typeof url === 'string' && MEDIA_PROXY.test(url) ? new URL(url).href : null)

/** → the context ArchiveMarkdown renders with. */
export function createRenderCtx({ guildId, postTitles, people, roles }) {
  if (typeof guildId !== 'string' || !SNOWFLAKE.test(guildId)) throw new TypeError('guildId must be a snowflake: a string of 17 to 20 digits.')
  if (!(postTitles instanceof Map)) throw new TypeError('postTitles must be a Map of post id to title.')
  if (!isTable(people)) throw new TypeError('people must be an object of member id to { name, avatar }.')
  if (!Array.isArray(roles)) throw new TypeError('roles must be a list of { id, name, color }.')

  function link(href) {
    const ref = parseDiscordRef(href)
    if (ref !== null && postTitles.has(ref.channelId) && (ref.guildId === guildId || CHANNEL_MENTION.test(href.trim()))) {
      return { kind: 'route', to: `${POST_ROUTE}${ref.channelId}${ref.messageId === null ? '' : `#m-${ref.messageId}`}` }
    }
    return httpsUrl(href) === null ? { kind: 'text' } : { kind: 'external', href }
  }

  function emoji(node) {
    const name = typeof node.name === 'string' && EMOJI_NAME.test(node.name) ? node.name : 'emoji'
    if (typeof node.id !== 'string' || !SNOWFLAKE.test(node.id)) return `:${name}:`
    return h('img', {
      src: `https://cdn.discordapp.com/emojis/${node.id}.${node.animated === true ? 'gif' : 'webp'}?size=48`,
      alt: `:${name}:`,
      class: 'lb-emoji',
      loading: 'lazy',
    })
  }

  function mention(node) {
    if (node.kind === 'user') {
      const name = entry(people, node.id)?.name
      return { label: `@${named(name) ? name : 'unknown-member'}`, color: null }
    }
    if (node.kind === 'role') {
      const role = roles.find((r) => r?.id === node.id)
      if (!named(role?.name)) return { label: '@unknown-role', color: null }
      return { label: `@${role.name}`, color: typeof role.color === 'string' && ROLE_COLOR.test(role.color) ? role.color : null }
    }
    const title = node.kind === 'channel' ? postTitles.get(node.id) : undefined
    return { label: named(title) ? title : '#channel', color: null }
  }

  return { link, emoji, mention }
}
