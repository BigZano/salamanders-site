/**
 * The site's Content-Security-Policy. GitHub Pages cannot send headers, so the policy goes into the built
 * index.html as a <meta http-equiv="Content-Security-Policy"> tag, which the build adds (cspMetaPlugin, wired
 * into vite.config.js) and scripts/check-csp.mjs checks on the finished build.
 *
 * Why: the site shows text and pictures that members wrote in Discord. If any of it ever got past the renderer
 * as markup, the policy is what stops it running, and what stops a page from sending anything to a host this
 * file does not name. Each origin below has a comment saying what loads from it; adding a source is one line here
 * and one in csp.test.mjs, and the reason for it belongs in the comment beside it.
 *
 * What a meta tag cannot do (frame-ancestors, report-uri, sandbox) is left out on purpose.
 *
 * inlineScriptHashes(html) → ["'sha256-<base64>'", …]: one for each <script> in the page that has no src, in the
 *   order they come, of the text a browser reads: entities are left as written, white space is kept (a script of
 *   one space is hashed as that space), and every line break is a single line feed (a browser reads CRLF and a
 *   lone CR that way, so a file with Windows line endings still matches). The page is read the way a browser
 *   reads it where it matters here: a tag name is any case; a script runs to the first "</script" followed by
 *   white space, "/" or ">"; a comment is skipped whole, so a script in one is not one. A page that is not a
 *   string is a TypeError.
 *
 *   It is a scanner, not the whole HTML parser, and these parts of the parsing rules it does not model:
 *     - an abrupt comment (<!--> and <!--->), and a comment closed by --!>: a browser ends the comment there; the scanner
 *       reads on to the next -->, and so reads the scripts in between as comment;
 *     - "<!--" that is only text, in a <title>, a <textarea> or a <style>: the scanner reads a comment there too;
 *     - double-escaped script data (<script><!-- <script> … </script> … </script>): a browser ends the script at the
 *       second end tag; the scanner ends it at the first;
 *     - NUL in a script: a browser reads it as U+FFFD; the scanner hashes the NUL;
 *     - a <script> inside a <title> or a <textarea>, which is only text to a browser: the scanner hashes it.
 *   Every one of these fails closed. In the first four the scanner reads fewer scripts, or another text, than a browser
 *   runs, so the browser finds no hash for the script and blocks it: the page loses a script, it never gains one. In the
 *   last the hash is of text the page's author wrote, and allows no other. In no case is a hash made of text that is not
 *   between a tag and an end tag of the page (csp.test.mjs holds this for any page). scripts/check-csp.mjs gets its hashes
 *   from here, so these blind spots are its too: it cannot find a script this misses, and a browser is what shows one.
 *
 * buildCsp({ apiOrigin, scriptHashes }) → the policy, on one line.
 *   apiOrigin     the origin the builds API answers from: a bare https://host or https://host:port, or, for a build
 *                 from a dev .env (VITE_BUILDS_API_URL=http://localhost:8787), http://localhost or http://127.0.0.1 with
 *                 an optional port and nothing else. Any other text is a TypeError that names VITE_BUILDS_API_URL.
 *                 Left out (undefined) for a build that has no API configured: then the site's calls to the API have
 *                 nowhere to go, and the policy does not pretend otherwise.
 *   scriptHashes  inlineScriptHashes of the page; each must be a sha256 source, or it is a TypeError.
 *
 * injectCsp(html, { apiOrigin }) → the page with the policy for its own inline scripts right after its <meta charset>
 *   declaration (a browser reads that only in the first 1024 bytes of the page, and the policy is long), or as the first
 *   element in <head> when the page has none; everything else as it was. A page with no <head> is an error: it must
 *   not ship without a policy.
 *
 * apiOriginOf(url) → the origin of the address in VITE_BUILDS_API_URL, or undefined when it is not set (or is
 *   empty, which is how the site reads it too). Not an address at all is an error that names the variable.
 *   Whether the origin is one the policy takes is buildCsp's to say.
 *
 * cspMetaPlugin({ apiUrl }) → a Vite plugin that runs injectCsp on the built index.html, for the build only: the
 *   dev server needs inline scripts for hot reload, and e2e runs on it. It reads the address when the page is
 *   made and not before, so a dev server pointed at http://localhost is never stopped by it.
 */
import { createHash } from 'node:crypto'

const SHA256_SOURCE = /^'sha256-[A-Za-z0-9+/]{43}='$/
const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?'
const API_ORIGIN = new RegExp(`^(?:https://${LABEL}(?:\\.${LABEL})*|http://(?:localhost|127\\.0\\.0\\.1))(?::\\d{1,5})?$`)
// What the page is read for, left to right: a comment (to skip), and the tags that matter: a script, the head and the end of
// it, the body (which ends it too) and a meta (for the charset declaration). An attribute value may hold a ">" when it is
// quoted. A name that goes on (<header>, <script-x>) is another tag.
const MARKUP = /<!--[\s\S]*?(?:-->|$)|<(\/?)(script|head|body|meta)(?=[\s/>])((?:"[^"]*"|'[^']*'|[^'">])*)>/gi
// A script's text: up to its end tag, or to the end of the page if it never closes (which a browser does not run).
const SCRIPT_TEXT = /[\s\S]*?(?=<\/script(?=[\s/>])|$)/iy
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g

const sha256Source = (text) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`

const attributeNames = (attributes) => [...attributes.matchAll(ATTRIBUTE)].map(([, name]) => name.toLowerCase())

/**
 * → { scripts: [{ text, external }], headEnd, charsetEnd }: the scripts in the page; where its first <head> tag ends
 * (undefined if none); and where the first <meta charset> in the head ends (undefined if none).
 */
function scan(html) {
  if (typeof html !== 'string') throw new TypeError('html must be a string.')
  const markup = new RegExp(MARKUP)
  const textOf = new RegExp(SCRIPT_TEXT)
  const scripts = []
  let headEnd
  let charsetEnd
  let headOver = false
  for (let found; (found = markup.exec(html)); ) {
    const [, closing, name, attributes] = found
    if (name === undefined) continue
    const tag = name.toLowerCase()
    if (closing === '/') {
      if (tag === 'head') headOver = true
      continue
    }
    if (tag === 'head') {
      headEnd ??= markup.lastIndex
      continue
    }
    if (tag === 'body') {
      headOver = true
      continue
    }
    if (tag === 'meta') {
      if (charsetEnd === undefined && headEnd !== undefined && !headOver && attributeNames(attributes).includes('charset')) charsetEnd = markup.lastIndex
      continue
    }
    textOf.lastIndex = markup.lastIndex
    const body = textOf.exec(html)[0]
    markup.lastIndex += body.length
    scripts.push({ text: body, external: attributeNames(attributes).includes('src') })
  }
  return { scripts, headEnd, charsetEnd }
}

const hashesOf = (scripts) => scripts.filter((script) => !script.external).map((script) => sha256Source(script.text.replace(/\r\n?/g, '\n')))

/** → the sha256 source of each inline script in the page, in order. */
export function inlineScriptHashes(html) {
  return hashesOf(scan(html).scripts)
}

/** → the policy for a page whose inline scripts are `scriptHashes`, calling the API at `apiOrigin`. */
export function buildCsp({ apiOrigin, scriptHashes = [] }) {
  if (apiOrigin !== undefined && !(typeof apiOrigin === 'string' && API_ORIGIN.test(apiOrigin))) {
    throw new TypeError(
      'VITE_BUILDS_API_URL must be a bare https origin, https://host or https://host:port with no path (or, for a build on this machine, http://localhost or http://127.0.0.1 with an optional port).',
    )
  }
  if (!Array.isArray(scriptHashes)) throw new TypeError('scriptHashes must be a list of sha256 sources.')
  for (const hash of scriptHashes) {
    if (typeof hash !== 'string' || !SHA256_SOURCE.test(hash)) throw new TypeError("Every script hash must be a sha256 source, quoted: 'sha256-<base64>'.")
  }
  return [
    "default-src 'self'",
    ['script-src', "'self'", ...scriptHashes].join(' '),
    // Vue and Vue Flow set style attributes, so inline styles stay; scripts are the part that is locked down.
    "style-src 'self' 'unsafe-inline'",
    // Pictures: Discord's CDN (attachments, avatars, emoji), its media proxy (images-ext-N.discordapp.net for an embed's
    // picture) and the gallery's storage bucket (r2.cloudflarestorage.com: the account is the first part of the host, and
    // it differs between deploys). Nothing loads from i.ytimg.com, so it is not named.
    "img-src 'self' data: blob: https://cdn.discordapp.com https://media.discordapp.net https://*.discordapp.net https://*.r2.cloudflarestorage.com",
    // Clips are played from the gallery's bucket, or from Discord's CDN for one that was posted there.
    "media-src 'self' blob: https://cdn.discordapp.com https://media.discordapp.net https://*.r2.cloudflarestorage.com",
    "font-src 'self' data:",
    // The builds API; Discord, to ask who a sign-in is (discordAuth.js); and the Space Marine 2 wiki, which the Armoury asks for the
    // perks of a weapon that the build's baked data does not have yet (wiki.js).
    ['connect-src', "'self'", ...(apiOrigin === undefined ? [] : [apiOrigin]), 'https://discord.com', 'https://spacemarine2.fandom.com'].join(' '),
    // The players of the gallery's clip links (src/lib/gallery/embed.js).
    'frame-src https://www.youtube.com https://clips.twitch.tv https://medal.tv',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "manifest-src 'self'",
  ].join('; ')
}

/** → the page with the policy right after its charset declaration, or first in its <head>. */
export function injectCsp(html, { apiOrigin }) {
  const { scripts, headEnd, charsetEnd } = scan(html)
  const policy = buildCsp({ apiOrigin, scriptHashes: hashesOf(scripts) })
  if (headEnd === undefined) throw new Error('The page has no <head> to put the Content-Security-Policy in.')
  const at = charsetEnd ?? headEnd
  return `${html.slice(0, at)}<meta http-equiv="Content-Security-Policy" content="${policy}" />${html.slice(at)}`
}

/** → the origin of the address, or undefined for no address. */
export function apiOriginOf(url) {
  if (url === undefined || url === '') return undefined
  try {
    return new URL(url).origin
  } catch {
    throw new Error('VITE_BUILDS_API_URL is not an address.')
  }
}

/** → the Vite plugin that gives the built index.html its policy. */
export function cspMetaPlugin({ apiUrl }) {
  return {
    name: 'csp-meta',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) => injectCsp(html, { apiOrigin: apiOriginOf(apiUrl) }),
    },
  }
}
