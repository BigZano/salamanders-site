/**
 * Post-build check of the Content-Security-Policy that scripts/csp.mjs puts in index.html (and that public/404.html carries
 * as written): `node scripts/check-csp.mjs dist` exits 1, and says why, unless dist/index.html and dist/404.html each
 *   - have a policy meta tag as an element child of <head>, as a browser builds the page (a report-only policy blocks nothing
 *     and does not count), with nothing before it in the page, in document order, but a <meta charset>, a <title> and a
 *     <meta> with a name or a property (and another policy meta): a <script>, <link>, <base>, <style> or <iframe> there
 *     would load or act before the policy applies, and any other element, or text that is not white space, before it ends the
 *     head, which leaves the meta in the body, where it is ignored;
 *   - have the sha256 of each of their inline scripts in that policy's first script-src (without it the browser blocks the
 *     script, which for 404.html is the deep-link redirect);
 *   - do not weaken the script rules: no 'unsafe-inline', 'unsafe-eval', 'strict-dynamic', 'unsafe-hashes' or
 *     'wasm-unsafe-eval' in script-src, script-src-elem, script-src-attr or default-src, and no scheme-only source (https:,
 *     data:) in those or in object-src or base-uri; 'unsafe-eval' is refused in any directive;
 *   - allow no wildcard host anywhere (a source that is `*`, or `https://*`);
 *   - have object-src 'none' and base-uri 'none', since without them default-src would decide, or <base> would be free;
 *   - have the <meta charset> declaration end within the first 1024 bytes of the file, which is all a browser reads for it.
 * A page can hold more than one policy meta, and a browser holds it to all of them, so each is judged on its own. Where a
 * directive is written twice a browser keeps the first, so the hashes and the two 'none' rules look at the first; the
 * other rules look at every source written.
 *
 * The page is read with jsdom, which parses it by the HTML standard as a browser does (no script is run, and nothing is
 * fetched), so that where things are is where a browser puts them, whatever the page is written like: an element left open,
 * a comment that ends early, a stray end tag. The hashes of the inline scripts are those of the text jsdom finds in them,
 * and they must be the very list scripts/csp.mjs's scanner made the policy from: when the two differ the check fails and
 * names both lists, so that what the scanner does not model (see csp.mjs) shows up here, and is not shared.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { inlineScriptHashes } from './csp.mjs'

const PAGES = ['index.html', '404.html']
// A source whose host is `*`: with or without a scheme, a port and a path. `*.example.test` is a named host and is not this.
const ANY_HOST = /^(?:[a-z][a-z0-9+.-]*:\/\/)?\*(?::(?:\d+|\*))?(?:\/.*)?$/i
const SCHEME_ONLY = /^[a-z][a-z0-9+.-]*:$/i
const SCRIPT_DIRECTIVES = ['script-src', 'script-src-elem', 'script-src-attr']
const NO_WEAKENING_IN = [...SCRIPT_DIRECTIVES, 'default-src']
const NO_SCHEME_ONLY_IN = [...NO_WEAKENING_IN, 'object-src', 'base-uri']
// What takes the strength out of script-src and its kin, and of default-src, which they fall back to. 'unsafe-eval' is refused
// in every directive (see policyFaults).
const WEAKENING = new Set(["'unsafe-inline'", "'strict-dynamic'", "'unsafe-hashes'", "'wasm-unsafe-eval'"])
// All a browser reads of the start of a page to find its character encoding.
const CHARSET_WINDOW = 1024
// A browser drops this at the start of the file before it parses; jsdom, given text, does not.
const BYTE_ORDER_MARK = /^\uFEFF/

/** → [[directive name, [source, …]], …] for a policy, names in lower case. (An empty directive is a name of '' and no sources.) */
const directivesOf = (policy) =>
  policy
    .split(';')
    .map((directive) => directive.trim().split(/\s+/))
    .map(([name, ...sources]) => [name.toLowerCase(), sources])

/** → what is wrong with one policy for a page whose inline scripts have these hashes. */
function policyFaults(policy, hashes) {
  const faults = []
  const directives = directivesOf(policy)
  const first = (name) => directives.find(([n]) => n === name)?.[1]
  const scriptSrc = first('script-src')
  if (scriptSrc === undefined) faults.push('the policy has no script-src')
  else for (const hash of hashes) if (!scriptSrc.includes(hash)) faults.push(`inline script ${hash} is not in script-src, so a browser blocks it`)
  for (const name of ['object-src', 'base-uri']) {
    if (first(name)?.length !== 1 || first(name)[0].toLowerCase() !== "'none'") faults.push(`${name} is not 'none'`)
  }
  for (const [name, sources] of directives) {
    for (const source of sources) {
      const keyword = source.toLowerCase()
      if (keyword === "'unsafe-eval'" || (NO_WEAKENING_IN.includes(name) && WEAKENING.has(keyword))) faults.push(`${name} allows ${keyword}`)
      if (ANY_HOST.test(source)) faults.push(`${name} allows any host (${source})`)
      if (NO_SCHEME_ONLY_IN.includes(name) && SCHEME_ONLY.test(source)) faults.push(`${name} allows every address of a scheme (${source})`)
    }
  }
  return faults
}

const hashOf = (text) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`
const list = (hashes) => (hashes.length === 0 ? '(none)' : hashes.join(' '))

const isPolicyMeta = (element) => element.localName === 'meta' && element.getAttribute('http-equiv')?.toLowerCase() === 'content-security-policy'

// A <meta> that loads nothing and changes nothing: a charset declaration, or a name or a property. A refresh, or any other
// http-equiv, is not (and a policy before another is fine).
const isHarmlessMeta = (element) => isPolicyMeta(element) || (!element.hasAttribute('http-equiv') && ['charset', 'name', 'property'].some((attribute) => element.hasAttribute(attribute)))

/** → what is wrong with the elements that come before a policy meta, in document order (its own ancestors do not count). */
function placementFaults(document, meta) {
  const faults = []
  for (const element of document.querySelectorAll('*')) {
    if (element === meta) break
    if (element.contains(meta) || element.localName === 'title' || (element.localName === 'meta' && isHarmlessMeta(element))) continue
    faults.push(`<${element.localName}> comes before the policy meta: only a charset declaration, a title and a meta with a name or property may, because the policy applies only to what follows it`)
  }
  return faults
}

/** → what is wrong with one page's policy, as sentences. */
function pageFaults(html) {
  const source = html.replace(BYTE_ORDER_MARK, '')
  // (No script is run and nothing is fetched, so there is nothing to close afterwards.)
  const dom = new JSDOM(source, { includeNodeLocations: true })
  const { document } = dom.window
  const policies = [...document.head.children].filter(isPolicyMeta)
  if (policies.length === 0) {
    return [
      [...document.querySelectorAll('meta')].some(isPolicyMeta)
        ? 'no Content-Security-Policy meta tag in <head>: the policy meta of the page is in the <body>, where a browser ignores it, because something before it (an element a head cannot hold, or text that is not white space) ended the head'
        : 'no Content-Security-Policy meta tag in <head>',
    ]
  }
  const faults = []
  const charset = [...document.head.children].find((element) => element.localName === 'meta' && element.hasAttribute('charset'))
  // The byte order mark is bytes of the file too, though it was taken off before the page was read.
  const readFrom = html.length - source.length
  if (charset !== undefined && Buffer.byteLength(html.slice(0, readFrom + dom.nodeLocation(charset).endOffset)) > CHARSET_WINDOW) {
    faults.push(`the <meta charset> declaration ends past byte ${CHARSET_WINDOW}, which is all a browser reads for it`)
  }
  const hashes = [...document.querySelectorAll('script')].filter((script) => !script.hasAttribute('src')).map((script) => hashOf(script.textContent))
  const scanned = inlineScriptHashes(html)
  if (list(scanned) !== list(hashes)) {
    faults.push(`csp.mjs reads the inline scripts of the page as ${list(scanned)}, but an HTML parser reads ${list(hashes)}: a browser runs what the parser reads, so the policy must hold those`)
  }
  for (const meta of policies) {
    // Stryker disable next-line StringLiteral: a meta with no content is read as a policy with no directives, and any text with none reads the same
    const content = meta.getAttribute('content') ?? ''
    faults.push(...placementFaults(document, meta), ...policyFaults(content, hashes))
  }
  return faults
}

/** → the problems with the pages of a build in `dir`, as a list of sentences: empty when the policy is right. */
export async function checkCsp(dir) {
  const found = []
  for (const name of PAGES) {
    const file = join(dir, name)
    const html = await readFile(file, 'utf8').catch(() => null)
    found.push(...(html === null ? [`${file}: not found`] : pageFaults(html).map((fault) => `${file}: ${fault}`)))
  }
  return found
}

/** → { code, stdout, stderr } for the arguments of the command line: the build directory to check. */
export async function main(args) {
  const [dir] = args
  if (dir === undefined) return { code: 1, stderr: 'usage: node scripts/check-csp.mjs <build directory>' }
  const problems = await checkCsp(dir)
  if (problems.length > 0) return { code: 1, stdout: problems.join('\n') }
  return { code: 0, stdout: `csp ok: ${PAGES.map((name) => join(dir, name)).join(', ')}` }
}

// The entry point. Only `node scripts/check-csp.mjs <dir>` runs it, so it is tested as a process (check-csp.test.mjs), which
// neither the coverage run nor the mutation run can see into; what it does is main()'s, and that is tested directly. (Running it
// in a test would load this module again inside the test, and the mutation run could then no longer tell what loads once.)
/* v8 ignore start */
// Stryker disable all: tested as a process, see above
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, stdout, stderr } = await main(process.argv.slice(2))
  if (stdout !== undefined) console.log(stdout)
  if (stderr !== undefined) console.error(stderr)
  process.exit(code)
}
// Stryker restore all
/* v8 ignore stop */
