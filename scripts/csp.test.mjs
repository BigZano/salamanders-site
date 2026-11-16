import { describe, it, expect, afterEach } from 'vitest'
import fc from 'fast-check'
import { webcrypto } from 'node:crypto'
import { parse } from 'node-html-parser'
import { inlineScriptHashes, buildCsp, injectCsp, apiOriginOf, cspMetaPlugin } from './csp.mjs'

const API = 'https://builds-api.example.test'
// Worked out with `openssl dgst -sha256 -binary | base64`, not with this module's own code.
const EMPTY = "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='"
const ALERT = "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='"

const sha256 = async (text) => `'sha256-${Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('base64')}'`
const asHash = (bytes) => `'sha256-${Buffer.from(bytes).toString('base64')}'`
const anyHash = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(asHash)
// Any text a script could hold, except where the page would read it as ending the script or opening a comment.
const plainText = fc.string({ unit: 'binary' }).filter((t) => !/<\/script|<!--/i.test(t))

/** A policy cut into its directives: [[name, [source, …]], …], in order. */
const directives = (policy) =>
  policy.split('; ').map((d) => {
    const [name, ...sources] = d.split(' ')
    return [name, sources]
  })
const sourcesOf = (policy, name) => directives(policy).find(([n]) => n === name)?.[1]

describe('inlineScriptHashes', () => {
  it('is the sha256 of the script text, in base64, in the quoted form a policy takes', () => {
    expect(inlineScriptHashes('<script>alert(1)</script>')).toEqual([ALERT])
    expect(inlineScriptHashes('<script></script>')).toEqual([EMPTY])
  })

  it('takes the text exactly as written: whitespace, line breaks and non-ASCII text all count', () => {
    expect(inlineScriptHashes('<script>\n  x\n</script>')).toEqual(["'sha256-1eshTJd1L+Q+NaBPmq2vBA50pk8FF/53YkjxOFk63VY='"])
    expect(inlineScriptHashes('<script>é</script>')).toEqual(["'sha256-SplVfkAzw1Od4utlRyAXytX5VX96BiWgnxw/biumnEw='"])
    expect(inlineScriptHashes('<script> alert(1)</script>')).not.toEqual([ALERT])
    expect(inlineScriptHashes('<script>alert(1) </script>')).not.toEqual([ALERT])
    expect(inlineScriptHashes('<script>a b</script>')).not.toEqual(inlineScriptHashes('<script>a  b</script>'))
  })

  it('does not decode entities, because the browser runs the text as written', async () => {
    expect(inlineScriptHashes('<script>a &amp;&amp; b</script>')).toEqual([await sha256('a &amp;&amp; b')])
  })

  it('takes text with markup-like characters in it whole', async () => {
    const body = 'if (a<b && c>d) { x = "<b>" }'
    expect(inlineScriptHashes(`<script>${body}</script>`)).toEqual([await sha256(body)])
  })

  it('reads every kind of line break as the single line feed a browser reads it as', async () => {
    const lf = await sha256('a\nb\nc')
    expect(inlineScriptHashes('<script>a\nb\nc</script>')).toEqual([lf])
    expect(inlineScriptHashes('<script>a\r\nb\rc</script>')).toEqual([lf])
    expect(inlineScriptHashes('<script>a\r\n\r\nb</script>')).toEqual([await sha256('a\n\nb')])
    expect(inlineScriptHashes('<script>a\n\rb</script>')).toEqual([await sha256('a\n\nb')])
    expect(inlineScriptHashes('<script>a\r\r\nb</script>')).toEqual([await sha256('a\n\nb')])
  })

  it('leaves out a script with a src, however the attribute is written', () => {
    expect(inlineScriptHashes('<script src="/a.js"></script>')).toEqual([])
    expect(inlineScriptHashes('<script SRC=/a.js>alert(1)</script>')).toEqual([])
    expect(inlineScriptHashes('<script src="">alert(1)</script>')).toEqual([])
    expect(inlineScriptHashes('<script type="module" crossorigin src="/assets/index-a1b2.js"></script>')).toEqual([])
  })

  it('keeps a script with another attribute, a module one included', () => {
    expect(inlineScriptHashes('<script type="module">alert(1)</script>')).toEqual([ALERT])
    expect(inlineScriptHashes('<script data-src="x">alert(1)</script>')).toEqual([ALERT])
    expect(inlineScriptHashes('<script nonce="n" defer>alert(1)</script>')).toEqual([ALERT])
  })

  it('gives one hash per script in the order they come, repeats included', () => {
    const page = '<head><script>alert(1)</script><script src="x.js"></script><script></script><script>alert(1)</script></head>'
    expect(inlineScriptHashes(page)).toEqual([ALERT, EMPTY, ALERT])
  })

  it('gives none for a page with no inline script', () => {
    expect(inlineScriptHashes('')).toEqual([])
    expect(inlineScriptHashes('<html><head><title>t</title></head><body><p>alert(1)</p></body></html>')).toEqual([])
  })

  it('leaves out a script in a comment, which the browser never runs, and takes the one after it', () => {
    expect(inlineScriptHashes('<!-- <script>alert(1)</script> --><script></script>')).toEqual([EMPTY])
    expect(inlineScriptHashes('<!--\n<script>alert(1)</script>\n--><!-- --><script>alert(1)</script>')).toEqual([ALERT])
    expect(inlineScriptHashes('<script>alert(1)</script><!-- <script></script>')).toEqual([ALERT])
  })

  it('keeps a script that holds the start of a comment, or a tag of its own, as text', async () => {
    expect(inlineScriptHashes('<script><!-- alert(1) --></script><script></script>')).toEqual([await sha256('<!-- alert(1) -->'), EMPTY])
    expect(inlineScriptHashes('<script>x = "<script>"; y = "<head>"</script><script></script>')).toEqual([await sha256('x = "<script>"; y = "<head>"'), EMPTY])
  })

  it('keeps white space, a script of nothing else included, which a parser may throw away', async () => {
    expect(inlineScriptHashes('<script> </script>')).toEqual([await sha256(' ')])
    expect(inlineScriptHashes('<script>\n\t\n</script>')).toEqual([await sha256('\n\t\n')])
  })

  it('reads a tag in any case, and ends a script at the first end tag a browser would', async () => {
    expect(inlineScriptHashes('<SCRIPT>alert(1)</SCRIPT>')).toEqual([ALERT])
    expect(inlineScriptHashes('<ScRiPt>alert(1)</sCrIpT>')).toEqual([ALERT])
    expect(inlineScriptHashes('<script>alert(1)</script >')).toEqual([ALERT])
    expect(inlineScriptHashes('<script>alert(1)</script\n>')).toEqual([ALERT])
    expect(inlineScriptHashes('<script>alert(1)</script/>')).toEqual([ALERT])
    expect(inlineScriptHashes('<script>alert(1)</script foo="bar">')).toEqual([ALERT])
    expect(inlineScriptHashes('<script\n>alert(1)</script>')).toEqual([ALERT])
    expect(inlineScriptHashes('<script/>alert(1)</script>')).toEqual([ALERT])
    expect(inlineScriptHashes('<script>a</scripts>b</script>')).toEqual([await sha256('a</scripts>b')])
    expect(inlineScriptHashes('<script>a</scrip>b</script>')).toEqual([await sha256('a</scrip>b')])
    expect(inlineScriptHashes('<script>a</ script>b</script>')).toEqual([await sha256('a</ script>b')])
  })

  it('ends a script at the first end tag, and takes the next script after it', () => {
    expect(inlineScriptHashes('<script>alert(1)</script><script></script>')).toEqual([ALERT, EMPTY])
    expect(inlineScriptHashes('<script>alert(1)</script>x</script><script></script>')).toEqual([ALERT, EMPTY])
  })

  it('does not take another tag for a script: a name that goes on is a different name', () => {
    expect(inlineScriptHashes('<scripts>alert(1)</scripts>')).toEqual([])
    expect(inlineScriptHashes('<script-x>alert(1)</script-x>')).toEqual([])
    expect(inlineScriptHashes('<scriptx>alert(1)</scriptx>')).toEqual([])
    expect(inlineScriptHashes('script>alert(1)</script>')).toEqual([])
    expect(inlineScriptHashes('<noscript>alert(1)</noscript>')).toEqual([])
  })

  it('reads attribute values that are quoted, with a ">" or the word src in them, as values', async () => {
    expect(inlineScriptHashes('<script data-x="a>b">alert(1)</script>')).toEqual([ALERT])
    expect(inlineScriptHashes("<script data-x='a>b'>alert(1)</script>")).toEqual([ALERT])
    expect(inlineScriptHashes('<script title="a src=b">alert(1)</script>')).toEqual([ALERT])
    expect(inlineScriptHashes("<script title='a src=b'>alert(1)</script>")).toEqual([ALERT])
    expect(inlineScriptHashes('<script data-x=a src=b>alert(1)</script>')).toEqual([])
    expect(inlineScriptHashes('<script data-x=src>alert(1)</script>')).toEqual([ALERT])
    expect(inlineScriptHashes('<script data-x=asrc>alert(1)</script>')).toEqual([ALERT])
    expect(inlineScriptHashes('<script data-x = src>alert(1)</script>')).toEqual([ALERT])
    expect(inlineScriptHashes('<script title ="a src=b">alert(1)</script>')).toEqual([ALERT])
    expect(inlineScriptHashes('<script title= "a src=b">alert(1)</script>')).toEqual([ALERT])
    expect(inlineScriptHashes('<script title = \'a src=b\' >alert(1)</script>')).toEqual([ALERT])
    expect(inlineScriptHashes('<script data-x="1" src="b">alert(1)</script>')).toEqual([])
    expect(inlineScriptHashes("<script data-x='1' src='b'>alert(1)</script>")).toEqual([])
    expect(inlineScriptHashes('<script src>alert(1)</script>')).toEqual([])
    expect(inlineScriptHashes('<script async src = "b" >alert(1)</script>')).toEqual([])
    expect(inlineScriptHashes('<script\nsrc="b"\n>alert(1)</script>')).toEqual([])
    expect(inlineScriptHashes('<script type=module src=/a.js></script><script>alert(1)</script>')).toEqual([ALERT])
  })

  it('reads a script that never closes as running to the end of the page, as a browser would (and then does not run)', async () => {
    expect(inlineScriptHashes('<script>alert(1)')).toEqual([ALERT])
    expect(inlineScriptHashes('<script>')).toEqual([EMPTY])
  })

  it('reads a comment that never closes as running to the end of the page', () => {
    expect(inlineScriptHashes('<script>alert(1)</script><!-- <script></script>')).toEqual([ALERT])
  })

  it.each([undefined, null, 5, {}, ['<script></script>'], Buffer.from('<script></script>')])('refuses %j, which is not a string', (html) => {
    expect(() => inlineScriptHashes(html)).toThrow(TypeError)
    expect(() => inlineScriptHashes(html)).toThrow(/html must be a string/)
  })

  it('is one sha256 source of 43 base64 characters and a padding sign per script, whatever the texts', () => {
    fc.assert(
      fc.property(fc.array(plainText, { maxLength: 4 }), (bodies) => {
        const hashes = inlineScriptHashes(bodies.map((b) => `<script>${b}</script>`).join('\n'))
        expect(hashes).toHaveLength(bodies.length)
        for (const h of hashes) expect(h).toMatch(/^'sha256-[A-Za-z0-9+/]{43}='$/)
      }),
    )
  })

  it('agrees with an independent sha256 of the text, line breaks read as a browser reads them, for any text', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(plainText, { minLength: 1, maxLength: 3 }), async (bodies) => {
        const page = `<head>${bodies.map((b) => `<script>${b}</script>`).join('<p>x</p>')}</head>`
        expect(inlineScriptHashes(page)).toEqual(await Promise.all(bodies.map((b) => sha256(b.replace(/\r\n?/g, '\n')))))
      }),
    )
  })
})

describe('buildCsp', () => {
  const policy = (...hashes) =>
    [
      "default-src 'self'",
      `script-src 'self'${hashes.map((h) => ` ${h}`).join('')}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://cdn.discordapp.com https://media.discordapp.net https://*.discordapp.net https://*.r2.cloudflarestorage.com https://i.ytimg.com",
      "media-src 'self' blob: https://cdn.discordapp.com https://media.discordapp.net https://*.r2.cloudflarestorage.com",
      "font-src 'self' data:",
      `connect-src 'self' ${API} https://discord.com https://spacemarine2.fandom.com`,
      'frame-src https://www.youtube.com https://clips.twitch.tv https://medal.tv',
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "manifest-src 'self'",
    ].join('; ')

  it('is exactly this policy, on one line, with no semicolon at the end', () => {
    expect(buildCsp({ apiOrigin: API, scriptHashes: [ALERT, EMPTY] })).toBe(policy(ALERT, EMPTY))
  })

  it('has script-src as just self when there is no inline script', () => {
    expect(buildCsp({ apiOrigin: API, scriptHashes: [] })).toBe(policy())
    expect(buildCsp({ apiOrigin: API })).toBe(policy())
  })

  it('leaves the API out of connect-src for a build that has none configured, and stays valid', () => {
    const csp = buildCsp({ scriptHashes: [ALERT] })
    expect(sourcesOf(csp, 'connect-src')).toEqual(["'self'", 'https://discord.com', 'https://spacemarine2.fandom.com'])
    expect(csp).toBe(policy(ALERT).replace(`${API} `, ''))
    expect(buildCsp({ apiOrigin: undefined })).toBe(buildCsp({}))
  })

  it('lets the wiki the Armoury reads live weapon trees from through connect-src, and nowhere else', () => {
    const csp = buildCsp({ apiOrigin: API })
    expect(sourcesOf(csp, 'connect-src')).toContain('https://spacemarine2.fandom.com')
    for (const [name, sources] of directives(csp)) if (name !== 'connect-src') expect(sources).not.toContain('https://spacemarine2.fandom.com')
  })

  it('takes a bare https origin with a host, with or without a port', () => {
    for (const origin of ['https://a', 'https://localhost', API, `${API}:8443`, 'https://127.0.0.1:1', 'https://a-b.c-d.e9:65535', 'https://0.0.0.0:00080']) {
      expect(sourcesOf(buildCsp({ apiOrigin: origin }), 'connect-src')[1]).toBe(origin)
    }
  })

  it.each([
    ['a path', `${API}/v1`],
    ['a trailing slash', `${API}/`],
    ['a query', `${API}?x=1`],
    ['a fragment', `${API}#x`],
    ['http', 'http://builds-api.example.test'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,x'],
    ['no scheme', '//builds-api.example.test'],
    ['no scheme at all', 'builds-api.example.test'],
    ['nothing', ''],
    ['a space', ' '],
    ['no host', 'https://'],
    ['a port and no host', 'https://:443'],
    ['a user', 'https://user@builds-api.example.test'],
    ['an empty port', `${API}:`],
    ['a port that is no number', `${API}:abc`],
    ['a port of six digits', `${API}:123456`],
    ['two ports', `${API}:80:80`],
    ['a second directive after it', `${API}; script-src *`],
    ['a second host after a space', `${API} https://evil.test`],
    ['a second host after a comma', `${API},https://evil.test`],
    ['a wildcard host', 'https://*.example.test'],
    ['a bare wildcard', '*'],
    ['a quote', `${API}'`],
    ['a line break after', `${API}\n`],
    ['a space before', ` ${API}`],
    ['a space after', `${API} `],
    ['a host starting with a hyphen', 'https://-a.test'],
    ['a label ending with a hyphen', 'https://a-.test'],
    ['an empty label', 'https://a..test'],
    ['a leading dot', 'https://.a.test'],
    ['a trailing dot', 'https://a.test.'],
    ['capitals in the host', 'https://BUILDS.example.test'],
    ['capitals in the scheme', 'HTTPS://builds-api.example.test'],
    ['an underscore', 'https://host_name.test'],
    ['non-ASCII text in the host', 'https://exämple.test'],
    ['an IPv6 host', 'https://[::1]'],
    ['a backslash', 'https://a.test\\x'],
  ])('refuses an apiOrigin with %s', (_, apiOrigin) => {
    expect(() => buildCsp({ apiOrigin, scriptHashes: [] })).toThrow(/apiOrigin/)
  })

  it.each([null, 5, true, {}, [], [API]])('refuses an apiOrigin of %j, which is no string', (apiOrigin) => {
    expect(() => buildCsp({ apiOrigin })).toThrow(TypeError)
  })

  it.each([
    ['a second directive', `${ALERT}; script-src *`],
    ['no quotes', 'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='],
    ["'unsafe-inline'", "'unsafe-inline'"],
    ["'unsafe-eval'", "'unsafe-eval'"],
    ["'self'", "'self'"],
    ['a nonce', "'nonce-abc'"],
    ['a wildcard', '*'],
    ['nothing in it', "'sha256-'"],
    ['a short hash', "'sha256-AAAA'"],
    ['a hash with a space in it', "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5 pLsLg4GF+pI='"],
    ['another algorithm', "'sha1-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='"],
    ['a longer algorithm', "'sha384-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='"],
    ['two hashes in one', `${ALERT.slice(0, -1)}' ${EMPTY}`],
    ['no padding', "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI'"],
    ['a long hash', "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pIA='"],
    ['url-safe base64', "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF-pI='"],
    ['a line break', `${ALERT}\n`],
    ['a space before', ` ${ALERT}`],
    ['an empty string', ''],
  ])('refuses a script hash that is %s', (_, hash) => {
    expect(() => buildCsp({ apiOrigin: API, scriptHashes: [ALERT, hash] })).toThrow(/script hash/)
  })

  it.each([null, 'x', ALERT, 5, {}, new Set([ALERT]), { [Symbol.iterator]: () => [ALERT][Symbol.iterator]() }])('refuses scriptHashes that is no list: %j', (scriptHashes) => {
    expect(() => buildCsp({ apiOrigin: API, scriptHashes })).toThrow(TypeError)
    expect(() => buildCsp({ apiOrigin: API, scriptHashes })).toThrow(/list of sha256 sources/)
  })

  it.each([5, null, undefined, [ALERT], { toString: () => ALERT }, new String(ALERT)])('refuses a script hash of %j, which is no string, though some read as a good one', (hash) => {
    expect(() => buildCsp({ apiOrigin: API, scriptHashes: [hash] })).toThrow(TypeError)
    expect(() => buildCsp({ apiOrigin: API, scriptHashes: [hash] })).toThrow(/script hash/)
  })

  it('refuses no arguments at all', () => {
    expect(() => buildCsp()).toThrow(TypeError)
  })

  it('always gives the same twelve directives in the same order, each once, with script-src holding exactly self and the hashes', () => {
    fc.assert(
      fc.property(fc.array(anyHash, { maxLength: 6 }), fc.option(fc.constantFrom(API, `${API}:8443`, 'https://a.b'), { nil: undefined }), (scriptHashes, apiOrigin) => {
        const csp = buildCsp({ apiOrigin, scriptHashes })
        expect(csp).not.toMatch(/[\n;]$/)
        expect(csp).not.toContain('\n')
        expect(directives(csp).map(([name]) => name)).toEqual([
          'default-src', 'script-src', 'style-src', 'img-src', 'media-src', 'font-src', 'connect-src', 'frame-src', 'object-src', 'base-uri', 'form-action', 'manifest-src',
        ])
        expect(sourcesOf(csp, 'script-src')).toEqual(["'self'", ...scriptHashes])
        expect(sourcesOf(csp, 'connect-src')).toEqual(["'self'", ...(apiOrigin ? [apiOrigin] : []), 'https://discord.com', 'https://spacemarine2.fandom.com'])
        expect(csp).not.toContain('unsafe-eval')
        expect(csp).not.toMatch(/(^|[ ;])\*/) // no source is a bare wildcard
      }),
    )
  })

  it('takes every well-formed https origin', () => {
    const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,8}[a-z0-9])?$/)
    fc.assert(
      fc.property(fc.array(label, { minLength: 1, maxLength: 4 }), fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }), (labels, port) => {
        const apiOrigin = `https://${labels.join('.')}${port === undefined ? '' : `:${port}`}`
        expect(sourcesOf(buildCsp({ apiOrigin }), 'connect-src')[1]).toBe(apiOrigin)
      }),
    )
  })

  it('refuses any text that holds a character no origin has, so nothing can ride along in it', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.constantFrom(' ', ';', ',', "'", '"', '\n', '\t', '*', '@', '\\', '?', '#', '<', '>', '(', ')', '=', '_', 'É'), (before, after, bad) => {
        expect(() => buildCsp({ apiOrigin: `${before}${bad}${after}` })).toThrow()
      }),
    )
  })

  it('refuses a valid origin with anything stuck on either end', () => {
    fc.assert(
      fc.property(fc.constantFrom(API, `${API}:8443`), fc.constantFrom(' ', ';', '/', '?', '#', '\n', "'", '*', ',', '@'), fc.boolean(), (origin, extra, atFront) => {
        expect(() => buildCsp({ apiOrigin: atFront ? extra + origin : origin + extra })).toThrow()
      }),
    )
  })

  it('refuses a script hash list with anything that is not a sha256 source among its entries', () => {
    fc.assert(
      fc.property(fc.array(anyHash, { maxLength: 3 }), fc.string(), fc.array(anyHash, { maxLength: 3 }), (before, bad, after) => {
        fc.pre(!/^'sha256-[A-Za-z0-9+/]{43}='$/.test(bad))
        expect(() => buildCsp({ apiOrigin: API, scriptHashes: [...before, bad, ...after] })).toThrow()
      }),
    )
  })
})

describe('injectCsp', () => {
  const PAGE = [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <title>Salamanders</title>',
    '    <script>alert(1)</script>',
    '    <script type="module" crossorigin src="/assets/index-a1b2.js"></script>',
    '  </head>',
    '  <body><div id="app"></div></body>',
    '</html>',
  ].join('\n')
  const META = /<meta http-equiv="Content-Security-Policy" content="[^"]*" ?\/>/

  const metaOf = (html) => parse(html).querySelector('head').firstElementChild

  it('puts the policy in a meta tag that is the first element in the head', () => {
    const out = injectCsp(PAGE, { apiOrigin: API })
    const meta = metaOf(out)
    expect(meta.tagName).toBe('META')
    expect(meta.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(meta.getAttribute('content')).toBe(buildCsp({ apiOrigin: API, scriptHashes: [ALERT] }))
  })

  it('changes nothing else in the page, so no script it hashed is altered', () => {
    const out = injectCsp(PAGE, { apiOrigin: API })
    expect(out.replace(META, '')).toBe(PAGE)
    expect(out.match(new RegExp(META, 'g'))).toHaveLength(1)
    expect(inlineScriptHashes(out)).toEqual([ALERT])
  })

  it("allows the page's own inline scripts and no others", () => {
    const page = PAGE.replace('<script>alert(1)</script>', '<script>alert(1)</script><script></script>')
    expect(sourcesOf(metaOf(injectCsp(page, { apiOrigin: API })).getAttribute('content'), 'script-src')).toEqual(["'self'", ALERT, EMPTY])
  })

  it('has script-src as just self for a page with no inline script', () => {
    const page = PAGE.replace('<script>alert(1)</script>', '')
    expect(sourcesOf(metaOf(injectCsp(page, { apiOrigin: API })).getAttribute('content'), 'script-src')).toEqual(["'self'"])
  })

  it('leaves the API out of connect-src when the build has none', () => {
    expect(sourcesOf(metaOf(injectCsp(PAGE, {})).getAttribute('content'), 'connect-src')).not.toContain(API)
    expect(metaOf(injectCsp(PAGE, { apiOrigin: undefined })).getAttribute('content')).toBe(buildCsp({ scriptHashes: [ALERT] }))
  })

  it('finds the head however it is written, and skips a head tag in a comment', () => {
    const opens = [['head', '<head>'], ['HEAD', '<HEAD>'], ['head', '<HEAD>'], ['Head', '<Head lang="en">'], ['head', '<head data-x="a>b">'], ['head', "<head data-x='a>b'>"], ['head', '<head\n  data-x="1"\n>'], ['head', '<head/>']]
    for (const [name, open] of opens) {
      for (const lead of ['', '<!-- <head> -->', '<!--\n<head lang="x">\n-->', '<script>"<head>"</script>']) {
        const page = `${lead}<html>${open}<meta charset="UTF-8"><script>alert(1)</script></${name}><body></body></html>`
        const policy = buildCsp({ apiOrigin: API, scriptHashes: inlineScriptHashes(page) })
        const at = page.indexOf(open, lead.length) + open.length
        expect(injectCsp(page, { apiOrigin: API })).toBe(`${page.slice(0, at)}<meta http-equiv="Content-Security-Policy" content="${policy}" />${page.slice(at)}`)
      }
    }
  })

  it('puts the policy in the first head of a page that has two, which is the one a browser keeps', () => {
    const page = '<html><head></head><body><head><title>x</title></head></body></html>'
    const out = injectCsp(page, { apiOrigin: API })
    expect(out.indexOf('Content-Security-Policy')).toBe('<html><head><meta http-equiv="'.length)
    expect(out.match(/Content-Security-Policy/g)).toHaveLength(1)
  })

  it('does not take a header element for the head', () => {
    expect(() => injectCsp('<header><script>alert(1)</script></header>', { apiOrigin: API })).toThrow(/head/)
  })

  it('refuses a page with no head, since a policy must not be silently dropped', () => {
    expect(() => injectCsp('<html><body></body></html>', { apiOrigin: API })).toThrow(/head/)
    expect(() => injectCsp('<!-- <head></head> --><html></html>', { apiOrigin: API })).toThrow(/head/)
    expect(() => injectCsp('', { apiOrigin: API })).toThrow(/head/)
  })

  it('refuses an apiOrigin that is not a bare https origin, and so ships no page', () => {
    expect(() => injectCsp(PAGE, { apiOrigin: 'http://localhost:8787' })).toThrow(/apiOrigin/)
    expect(() => injectCsp(PAGE, { apiOrigin: `${API}/v1` })).toThrow(/apiOrigin/)
  })

  it.each([undefined, null, 5, {}])('refuses %j, which is not a page', (html) => {
    expect(() => injectCsp(html, { apiOrigin: API })).toThrow(TypeError)
  })

  it('always leaves the first element of the head as the policy and the rest of the page as it was', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('head', 'HEAD', 'Head'),
        fc.constantFrom('', ' lang="en"', ' data-x="a>b"', " data-x='a>b'", '\n'),
        fc.constantFrom('', '<!-- <head> -->', '<!doctype html>'),
        fc.array(fc.constantFrom('<script>alert(1)</script>', '<script src="/a.js"></script>', '<meta charset="UTF-8">', '<title>t</title>', ''), { maxLength: 4 }),
        (tag, attrs, lead, inner) => {
          const page = `${lead}<html><${tag}${attrs}>${inner.join('\n')}</${tag}><body></body></html>`
          const out = injectCsp(page, { apiOrigin: API })
          expect(out.replace(META, '')).toBe(page)
          const meta = metaOf(out)
          expect(meta.getAttribute('http-equiv')).toBe('Content-Security-Policy')
          expect(meta.getAttribute('content')).toBe(buildCsp({ apiOrigin: API, scriptHashes: inlineScriptHashes(page) }))
        },
      ),
    )
  })
})

describe('apiOriginOf', () => {
  it('is nothing when the address is not set, or is empty, as the site reads it', () => {
    expect(apiOriginOf(undefined)).toBeUndefined()
    expect(apiOriginOf('')).toBeUndefined()
  })

  it('is the origin of the address: the scheme, host and port, and no path', () => {
    expect(apiOriginOf(API)).toBe(API)
    expect(apiOriginOf(`${API}/`)).toBe(API)
    expect(apiOriginOf(`${API}/v1/builds?x=1#y`)).toBe(API)
    expect(apiOriginOf(`${API}:8443/v1`)).toBe(`${API}:8443`)
    expect(apiOriginOf(`${API}:443`)).toBe(API)
    expect(apiOriginOf('HTTPS://Builds-API.Example.test/x')).toBe(API)
  })

  it('leaves a scheme that is not https for buildCsp to refuse, so the build fails and says why', () => {
    expect(apiOriginOf('http://localhost:8787')).toBe('http://localhost:8787')
    expect(() => buildCsp({ apiOrigin: apiOriginOf('http://localhost:8787') })).toThrow(/https/)
    expect(() => buildCsp({ apiOrigin: apiOriginOf('javascript:alert(1)') })).toThrow(/https/)
  })

  it.each(['nonsense', ' ', '/just/a/path', 'https://', 'https://a b.test'])('names the setting when %j is no address', (url) => {
    expect(() => apiOriginOf(url)).toThrow(/VITE_BUILDS_API_URL/)
  })

  it('names the setting for a value that is no string', () => {
    expect(() => apiOriginOf(null)).toThrow(/VITE_BUILDS_API_URL/)
    expect(() => apiOriginOf(5)).toThrow(/VITE_BUILDS_API_URL/)
  })
})

describe('cspMetaPlugin', () => {
  const PAGE = '<html><head><meta charset="UTF-8"><script>alert(1)</script></head><body></body></html>'

  it('is a Vite plugin for the build only, which acts after the other html transforms', () => {
    const plugin = cspMetaPlugin({ apiUrl: API })
    expect(plugin.name).toBe('csp-meta')
    expect(plugin.apply).toBe('build')
    expect(plugin.transformIndexHtml.order).toBe('post')
    expect(typeof plugin.transformIndexHtml.handler).toBe('function')
  })

  it("gives the page a policy for the API's origin, however the address is written", () => {
    for (const apiUrl of [API, `${API}/`, `${API}/v1/x`]) {
      expect(cspMetaPlugin({ apiUrl }).transformIndexHtml.handler(PAGE)).toBe(injectCsp(PAGE, { apiOrigin: API }))
    }
  })

  it('gives a policy with no API when there is no address', () => {
    for (const apiUrl of [undefined, '']) {
      expect(cspMetaPlugin({ apiUrl }).transformIndexHtml.handler(PAGE)).toBe(injectCsp(PAGE, {}))
    }
  })

  it('ignores the context Vite passes along', () => {
    const handler = cspMetaPlugin({ apiUrl: API }).transformIndexHtml.handler
    expect(handler(PAGE, { path: '/index.html', filename: '/x/index.html' })).toBe(injectCsp(PAGE, { apiOrigin: API }))
  })

  it('fails the build, rather than ship a page, for an address that is not https or not an address', () => {
    expect(() => cspMetaPlugin({ apiUrl: 'http://localhost:8787' }).transformIndexHtml.handler(PAGE)).toThrow(/https/)
    expect(() => cspMetaPlugin({ apiUrl: 'nonsense' }).transformIndexHtml.handler(PAGE)).toThrow(/VITE_BUILDS_API_URL/)
  })

  it('is made without looking at the address, so that dev (which needs no policy, and may use http://localhost) is never stopped', () => {
    expect(() => cspMetaPlugin({ apiUrl: 'http://localhost:8787' })).not.toThrow()
    expect(() => cspMetaPlugin({ apiUrl: 'nonsense' })).not.toThrow()
  })
})

describe('vite.config.js', () => {
  const saved = process.env.VITE_BUILDS_API_URL
  afterEach(() => {
    if (saved === undefined) delete process.env.VITE_BUILDS_API_URL
    else process.env.VITE_BUILDS_API_URL = saved
  })

  const pluginFor = async (apiUrl, env = { command: 'build', mode: 'production' }) => {
    process.env.VITE_BUILDS_API_URL = apiUrl
    const { default: config } = await import('../vite.config.js')
    const resolved = await config(env)
    return resolved.plugins.flat(Infinity).find((p) => p?.name === 'csp-meta')
  }

  it("puts the policy in the page for the origin of the build's VITE_BUILDS_API_URL", async () => {
    const plugin = await pluginFor(`${API}/v1`)
    const page = '<html><head><script>alert(1)</script></head></html>'
    expect(plugin.transformIndexHtml.handler(page)).toBe(injectCsp(page, { apiOrigin: API }))
  })

  it('has no API in the policy when the variable is empty', async () => {
    const plugin = await pluginFor('')
    const page = '<html><head></head></html>'
    expect(plugin.transformIndexHtml.handler(page)).toBe(injectCsp(page, {}))
  })

  it('is applied to the build and not the dev server, whatever the dev server is pointed at', async () => {
    const plugin = await pluginFor('http://localhost:8787', { command: 'serve', mode: 'development' })
    expect(plugin.apply).toBe('build')
  })
})
