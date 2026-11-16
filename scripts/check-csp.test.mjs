import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkCsp } from './check-csp.mjs'

const SCRIPT = fileURLToPath(new URL('./check-csp.mjs', import.meta.url))
const INLINE = '<script>alert(1)</script>'
// Worked out with `openssl dgst -sha256 -binary | base64`.
const ALERT = "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='"
const EMPTY = "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='"
// A small policy of the kind the build writes, with wildcard sub-domains, which are allowed.
const GOOD = `default-src 'self'; script-src 'self' ${ALERT}; img-src 'self' data: https://*.discordapp.net https://cdn.discordapp.com; connect-src 'self' https://builds-api.example.test`

const meta = (content, httpEquiv = 'Content-Security-Policy') => `<meta http-equiv="${httpEquiv}" content="${content}" />`
const page = ({ head = '', body = '' } = {}) => `<!doctype html><html lang="en"><head><meta charset="UTF-8" />${head}</head><body>${body}</body></html>`

let dir
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'csp-'))
})
const build = (html) => writeFile(join(dir, 'index.html'), html)
const problems = async (html) => {
  await build(html)
  return checkCsp(dir)
}

describe('checkCsp', () => {
  it('passes a page whose policy lists the hash of its inline script and has no wildcard host or unsafe-eval', async () => {
    expect(await problems(page({ head: meta(GOOD) + INLINE }))).toEqual([])
  })

  it('passes a page with no inline script and a policy with a script-src', async () => {
    expect(await problems(page({ head: meta(GOOD) }))).toEqual([])
  })

  it('fails a page with no policy meta', async () => {
    const found = await problems(page({ head: INLINE }))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/no Content-Security-Policy/)
  })

  it.each([
    ['another http-equiv', meta(GOOD, 'refresh')],
    ['the report-only kind, which blocks nothing', meta(GOOD, 'Content-Security-Policy-Report-Only')],
    ['a space in the http-equiv', meta(GOOD, ' Content-Security-Policy')],
    ['a meta of the name and not the http-equiv', `<meta name="Content-Security-Policy" content="${GOOD}" />`],
    ['a policy only in the body, where a browser ignores it', ''],
  ])('fails a page with %s', async (_, head) => {
    const found = await problems(page({ head: head + INLINE, body: head === '' ? meta(GOOD) : '' }))
    expect(found.some((p) => /no Content-Security-Policy/.test(p))).toBe(true)
  })

  it('reads the http-equiv in any case', async () => {
    expect(await problems(page({ head: meta(GOOD, 'content-security-policy') + INLINE }))).toEqual([])
    expect(await problems(page({ head: meta(GOOD, 'CONTENT-SECURITY-POLICY') + INLINE }))).toEqual([])
    expect(await problems(`<html><head><META HTTP-EQUIV=content-security-policy CONTENT="${GOOD}">${INLINE}</head></html>`)).toEqual([])
  })

  it('reads the policy as the browser reads the attribute: character references are decoded', async () => {
    const encoded = GOOD.replaceAll("'", '&#39;')
    expect(await problems(page({ head: meta(encoded) + INLINE }))).toEqual([])
    expect(await problems(page({ head: meta(encoded.replace('script-src', 'script-src &#39;unsafe-eval&#39;')) + INLINE }))).toHaveLength(1)
  })

  it('fails an inline script whose hash is not in script-src, and names the hash', async () => {
    const found = await problems(page({ head: meta(GOOD) + INLINE + '<script>other()</script>' }))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/inline script 'sha256-[A-Za-z0-9+/]{43}='/)
    expect(found[0]).not.toContain(ALERT)
  })

  it('fails every inline script that is not listed, one finding each', async () => {
    const found = await problems(page({ head: meta(`default-src 'self'; script-src 'self'`) + INLINE + '<script></script>' }))
    expect(found).toHaveLength(2)
    expect(found.join('\n')).toContain(ALERT)
    expect(found.join('\n')).toContain(EMPTY)
  })

  it('fails a script whose hash is only in another directive', async () => {
    expect(await problems(page({ head: meta(`default-src 'self' ${ALERT}; script-src 'self'`) + INLINE }))).toHaveLength(1)
    expect(await problems(page({ head: meta(`default-src 'self'; script-src 'self'; style-src ${ALERT}`) + INLINE }))).toHaveLength(1)
  })

  it('fails a script that differs from the listed one by a space', async () => {
    expect(await problems(page({ head: meta(GOOD) + '<script> alert(1)</script>' }))).toHaveLength(1)
  })

  it('does not ask for the hash of a script that has a src', async () => {
    expect(await problems(page({ head: meta(GOOD) + '<script type="module" crossorigin src="/assets/a.js"></script>' + INLINE }))).toEqual([])
  })

  it('fails a policy with no script-src, since script would then follow a looser rule', async () => {
    const found = await problems(page({ head: meta(`default-src 'self'`) }))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/script-src/)
    expect((await problems(page({ head: meta('') }))).some((p) => /script-src/.test(p))).toBe(true)
    expect((await problems(page({ head: '<meta http-equiv="Content-Security-Policy" />' }))).some((p) => /script-src/.test(p))).toBe(true)
  })

  it("uses the first script-src, as a browser does, and not a later one that would be ignored", async () => {
    expect(await problems(page({ head: meta(`script-src 'self'; script-src 'self' ${ALERT}`) + INLINE }))).toHaveLength(1)
    expect(await problems(page({ head: meta(`script-src 'self' ${ALERT}; script-src 'self'`) + INLINE }))).toEqual([])
  })

  it.each([
    ['script-src', `script-src 'self' ${ALERT} 'unsafe-eval'`],
    ['default-src', `default-src 'self' 'unsafe-eval'; script-src 'self' ${ALERT}`],
    ['a directive that is no script one', `script-src 'self' ${ALERT}; img-src 'unsafe-eval'`],
    ['capitals', `script-src 'self' ${ALERT} 'UNSAFE-EVAL'`],
    ['a later directive of the same name', `script-src 'self' ${ALERT}; script-src 'unsafe-eval'`],
  ])("fails 'unsafe-eval' in %s", async (_, policy) => {
    const found = await problems(page({ head: meta(policy) + INLINE }))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/unsafe-eval/)
  })

  it('does not take a source that only holds the words for the keyword', async () => {
    expect(await problems(page({ head: meta(`${GOOD}; style-src 'self' 'unsafe-inline'; img-src https://unsafe-eval.example.test`) + INLINE }))).toEqual([])
  })

  it.each([
    ['*', '*'],
    ['a wildcard host with a scheme', 'https://*'],
    ['a wildcard host with a port', 'https://*:443'],
    ['a wildcard host with any port', '*:*'],
    ['a wildcard host with a path', 'https://*/x'],
    ['a wildcard in any case of scheme', 'HTTPS://*'],
    ['a wildcard host with another scheme', 'wss://*'],
  ])('fails %s as a source', async (_, source) => {
    for (const name of ['default-src', 'img-src', 'connect-src', 'script-src']) {
      const found = await problems(page({ head: meta(`script-src 'self' ${ALERT}; ${name} ${source}`) + INLINE }))
      expect(found.some((p) => p.includes(name) && p.includes(source))).toBe(true)
    }
  })

  it('allows a wildcard in the sub-domain of a named host, which is not a wildcard host', async () => {
    for (const source of ['https://*.discordapp.net', '*.example.test', 'https://*.r2.cloudflarestorage.com:443', 'https://a.*.test']) {
      expect(await problems(page({ head: meta(`script-src 'self' ${ALERT}; img-src ${source}`) + INLINE }))).toEqual([])
    }
  })

  it('reads a policy with extra white space, empty directives and capitals in a directive name', async () => {
    const policy = `  DEFAULT-SRC   'self' ;;\n SCRIPT-SRC\t'self'  ${ALERT}  ;  `
    expect(await problems(page({ head: meta(policy) + INLINE }))).toEqual([])
    expect(await problems(page({ head: meta(policy.replace(ALERT, "'unsafe-eval'")) + INLINE }))).toHaveLength(2)
  })

  it('judges every policy meta in the head by itself, since a browser holds the page to all of them', async () => {
    expect(await problems(page({ head: meta(GOOD) + meta(GOOD) + INLINE }))).toEqual([])
    expect(await problems(page({ head: meta(GOOD) + meta(`script-src 'self'`) + INLINE }))).toHaveLength(1)
    expect(await problems(page({ head: meta(`script-src 'self'`) + meta(GOOD) + INLINE }))).toHaveLength(1)
    expect(await problems(page({ head: meta(GOOD) + meta(`script-src 'self' ${ALERT} *`) + INLINE }))).toHaveLength(1)
  })

  it('fails a build with no index.html, and says so, instead of throwing', async () => {
    const found = await checkCsp(join(dir, 'nowhere'))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/index\.html/)
    await mkdir(join(dir, 'empty'))
    expect(await checkCsp(join(dir, 'empty'))).toHaveLength(1)
  })

  it('fails a page with no head', async () => {
    const found = await problems(`<html><body>${meta(GOOD)}${INLINE}</body></html>`)
    expect(found.some((p) => /no Content-Security-Policy/.test(p))).toBe(true)
  })
})

describe('check-csp.mjs from the command line', () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

  it('exits 0 for a good build and says which page it checked', async () => {
    await build(page({ head: meta(GOOD) + INLINE }))
    const result = run(dir)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(join(dir, 'index.html'))
  })

  it('exits 1 and lists every finding for a bad build', async () => {
    await build(page({ head: meta(`script-src 'self' *`) + INLINE }))
    const result = run(dir)
    expect(result.status).toBe(1)
    expect(result.stdout).toMatch(/script-src/)
    expect(result.stdout.trim().split('\n')).toHaveLength(2)
  })

  it('exits 1 for a build with no policy', async () => {
    await build(page({ head: INLINE }))
    expect(run(dir).status).toBe(1)
  })

  it('exits 1 for a directory with no index.html', () => {
    expect(run(dir).status).toBe(1)
  })

  it('exits 1 and says how to use it when it is not given a directory', () => {
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/usage/i)
  })
})
