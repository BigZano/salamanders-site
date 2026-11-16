/**
 * Post-build check of the Content-Security-Policy that scripts/csp.mjs puts in index.html (the pre-push hook runs it on a
 * fresh build): `node scripts/check-csp.mjs dist` exits 1, and says why, unless dist/index.html
 *   - has a policy meta tag as a child of its <head> (a browser ignores one anywhere else, and a report-only one blocks nothing),
 *   - has the sha256 of each of its inline scripts in that policy's script-src (without it the browser blocks the script), and
 *   - has no 'unsafe-eval' and no wildcard host (a source that is `*`, or `https://*`) anywhere in it.
 * A page can hold more than one policy meta, and a browser holds it to all of them, so each is judged on its own. Where a
 * directive is written twice a browser keeps the first, so the hashes are looked for in the first script-src; the other two
 * rules look at every source written.
 *
 * The page is read with a different HTML parser from the one that wrote the policy (node-html-parser here, csp.mjs's own
 * scan there), so that a misreading in one is not shared by both.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'node-html-parser'
import { inlineScriptHashes } from './csp.mjs'

// A source whose host is `*`: with or without a scheme, a port and a path. `*.example.test` is a named host and is not this.
const ANY_HOST = /^(?:[a-z][a-z0-9+.-]*:\/\/)?\*(?::(?:\d+|\*))?(?:\/.*)?$/i

/** → [[directive name, [source, …]], …] for a policy, names in lower case. */
const directivesOf = (policy) =>
  policy
    .split(';')
    .map((directive) => directive.trim().split(/\s+/))
    .filter(([name]) => name !== '')
    .map(([name, ...sources]) => [name.toLowerCase(), sources])

/** → what is wrong with one policy for a page whose inline scripts have these hashes. */
function faultsOf(policy, hashes) {
  const faults = []
  const directives = directivesOf(policy)
  const scriptSrc = directives.find(([name]) => name === 'script-src')?.[1]
  if (scriptSrc === undefined) faults.push('the policy has no script-src')
  else for (const hash of hashes) if (!scriptSrc.includes(hash)) faults.push(`inline script ${hash} is not in script-src, so a browser blocks it`)
  for (const [name, sources] of directives) {
    for (const source of sources) {
      if (source.toLowerCase() === "'unsafe-eval'") faults.push(`${name} allows 'unsafe-eval'`)
      if (ANY_HOST.test(source)) faults.push(`${name} allows any host (${source})`)
    }
  }
  return faults
}

/** → the problems with `<dir>/index.html`, as a list of sentences: empty when the policy is right. */
export async function checkCsp(dir) {
  const file = join(dir, 'index.html')
  const html = await readFile(file, 'utf8').catch(() => null)
  if (html === null) return [`${file}: not found`]
  const policies = (parse(html).querySelector('head')?.children ?? []).filter(
    (element) => element.tagName === 'META' && element.getAttribute('http-equiv')?.toLowerCase() === 'content-security-policy',
  )
  if (policies.length === 0) return [`${file}: no Content-Security-Policy meta tag in <head>`]
  const hashes = inlineScriptHashes(html)
  return policies.flatMap((meta) => faultsOf(meta.getAttribute('content') ?? '', hashes).map((fault) => `${file}: ${fault}`))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2]
  if (dir === undefined) {
    console.error('usage: node scripts/check-csp.mjs <build directory>')
    process.exit(1)
  }
  const problems = await checkCsp(dir)
  if (problems.length > 0) {
    console.log(problems.join('\n'))
    process.exit(1)
  }
  console.log(`csp ok: ${join(dir, 'index.html')}`)
}
