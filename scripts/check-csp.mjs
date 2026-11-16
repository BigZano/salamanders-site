/**
 * Post-build check of the Content-Security-Policy that scripts/csp.mjs puts in index.html (and that public/404.html carries
 * as written): `node scripts/check-csp.mjs dist` exits 1, and says why, unless dist/index.html and dist/404.html each
 *   - have a policy meta tag as a child of <head>, put where a browser puts it: nothing before it that ends the head (an
 *     element a head cannot hold, or text), and no <script>, <link> or <base> before it, which would load or act before the
 *     policy applies; a report-only policy blocks nothing and does not count;
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
 * The page is read with node-html-parser, but the hashes of its inline scripts come from scripts/csp.mjs (the scanner that
 * wrote them into the policy), so what that scanner does not model is not checked here either (see csp.mjs); a browser is
 * what finds such a script, and it shows as a blocked script.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeType, parse } from 'node-html-parser'
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
// What a head can hold besides the three that act before a policy applies (ACTS_BEFORE_THE_POLICY). Anything else makes a
// browser end the head, and what follows is in the body.
const HEAD_ELEMENTS = new Set(['meta', 'noscript', 'style', 'template', 'title'])
const ACTS_BEFORE_THE_POLICY = new Set(['script', 'link', 'base'])
// All a browser reads of the start of a page to find its character encoding.
const CHARSET_WINDOW = 1024
// A character that is not white space to HTML (which has only tab, line feed, form feed, carriage return and space: not the
// no-break space or a vertical tab, which JavaScript's trim() and \s take for white space), and a doctype, which is ignored.
const NOT_HTML_SPACE = /[^\t\n\f\r ]/
const DOCTYPE = /<!doctype[^>]*>/gi

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

/**
 * → what is wrong with some nodes that come before a policy meta (in the head, or before the head, in <html> or ahead of it):
 * text that is not white space and an element a head cannot hold start the body, and a <script>, <link> or <base> acts before
 * the policy does. (A browser starts a head of its own for what comes ahead of <head>.)
 */
function placementFaults(before) {
  const faults = []
  for (const node of before) {
    if (node.nodeType === NodeType.TEXT_NODE) {
      if (NOT_HTML_SPACE.test(node.rawText.replace(DOCTYPE, ''))) faults.push('text comes before the policy meta, which ends the head: a browser puts the meta in the body, and ignores it')
    } else {
      // (The parser leaves comments out, so what is not text is an element.)
      const tag = node.tagName.toLowerCase()
      if (ACTS_BEFORE_THE_POLICY.has(tag)) faults.push(`<${tag}> comes before the policy meta, so it loads or acts before the policy applies`)
      else if (!HEAD_ELEMENTS.has(tag)) faults.push(`<${tag}> comes before the policy meta and ends the head: a browser puts the meta in the body, and ignores it`)
    }
  }
  return faults
}

// (A text node has no tag name.)
/** → what is wrong with where a head sits: what comes before it, at each level up to the page, and any element it is inside. */
function headFaults(head) {
  const faults = []
  for (let node = head; node.parentNode !== null; node = node.parentNode) {
    const parent = node.parentNode
    if (parent.tagName && parent.tagName !== 'HTML') {
      faults.push(`the <head> is inside <${parent.tagName.toLowerCase()}>, where a browser ignores the tag: the policy meta is then in the body, and ignored`)
    }
    faults.push(...placementFaults(parent.childNodes.slice(0, parent.childNodes.indexOf(node))))
  }
  return faults
}

const isPolicyMeta = (node) => node.tagName === 'META' && node.getAttribute('http-equiv')?.toLowerCase() === 'content-security-policy'

/** → what is wrong with one page's policy, as sentences. */
function pageFaults(html) {
  const head = parse(html).querySelector('head')
  const nodes = head?.childNodes
  const policies = nodes?.filter(isPolicyMeta) ?? []
  if (policies.length === 0) return ['no Content-Security-Policy meta tag in <head>']
  const faults = []
  const charset = head.children.find((element) => element.tagName === 'META' && element.hasAttribute('charset'))
  if (charset !== undefined && Buffer.byteLength(html.slice(0, charset.range[1])) > CHARSET_WINDOW) {
    faults.push(`the <meta charset> declaration ends past byte ${CHARSET_WINDOW}, which is all a browser reads for it`)
  }
  faults.push(...headFaults(head))
  const hashes = inlineScriptHashes(html)
  for (const meta of policies) {
    // Stryker disable next-line StringLiteral: a meta with no content is read as a policy with no directives, and any text with none reads the same
    const content = meta.getAttribute('content') ?? ''
    faults.push(...placementFaults(nodes.slice(0, nodes.indexOf(meta))), ...policyFaults(content, hashes))
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
