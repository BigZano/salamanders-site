import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkCsp, main } from './check-csp.mjs'
import { buildCsp, inlineScriptHashes } from './csp.mjs'

const SCRIPT = fileURLToPath(new URL('./check-csp.mjs', import.meta.url))
const REAL_404 = readFileSync(new URL('../public/404.html', import.meta.url), 'utf8')
const INLINE = '<script>alert(1)</script>'
// Worked out with `openssl dgst -sha256 -binary | base64`.
const ALERT = "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='"
const EMPTY = "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='"
const NONE = "object-src 'none'; base-uri 'none'"
// What a policy needs besides its script-src: no plug-ins and no <base>. Every fixture has it unless it is the one that does not.
const policy = (head) => `${head}; ${NONE}`
// A small policy of the kind the build writes, with wildcard sub-domains, which are allowed.
const GOOD = policy(`default-src 'self'; script-src 'self' ${ALERT}; img-src 'self' data: blob: https://*.discordapp.net https://cdn.discordapp.com; connect-src 'self' https://builds-api.example.test`)
const CHARSET = '<meta charset="UTF-8" />'

const meta = (content, httpEquiv = 'Content-Security-Policy') => `<meta http-equiv="${httpEquiv}" content="${content}" />`
// The head of a page: the charset declaration first, as the build writes it, then `head`.
const page = ({ head = '', body = '' } = {}) => `<!doctype html><html lang="en"><head>${CHARSET}${head}</head><body>${body}</body></html>`

let dir
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'csp-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})
// Writes the build: index.html as given, and a good 404.html (the real one) unless another is given.
const build = async (index, notFound = REAL_404) => {
  await writeFile(join(dir, 'index.html'), index)
  await writeFile(join(dir, '404.html'), notFound)
}
const problems = async (html, notFound) => {
  await build(html, notFound)
  return checkCsp(dir)
}
const withMeta = (content, extra = '') => page({ head: meta(content) + extra + INLINE })

describe('checkCsp, the pages', () => {
  it('passes a build whose index.html and 404.html both have a good policy', async () => {
    expect(await problems(page({ head: meta(GOOD) + INLINE }))).toEqual([])
  })

  it('passes the 404.html the site ships, with the hash of its own script', async () => {
    expect(inlineScriptHashes(REAL_404)).toHaveLength(1)
    expect(await problems(page({ head: meta(GOOD) + INLINE }), REAL_404)).toEqual([])
  })

  it('fails a build with no 404.html, and says so, instead of throwing', async () => {
    await writeFile(join(dir, 'index.html'), page({ head: meta(GOOD) + INLINE }))
    const found = await checkCsp(dir)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain(join(dir, '404.html'))
    expect(found[0]).toMatch(/not found/)
  })

  it('fails a build with no index.html, and says so, instead of throwing', async () => {
    await writeFile(join(dir, '404.html'), REAL_404)
    const found = await checkCsp(dir)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain(join(dir, 'index.html'))
    expect(await checkCsp(join(dir, 'nowhere'))).toHaveLength(2)
    await mkdir(join(dir, 'empty'))
    expect(await checkCsp(join(dir, 'empty'))).toHaveLength(2)
  })

  it('fails a 404.html with no policy, and names the file', async () => {
    const found = await problems(page({ head: meta(GOOD) + INLINE }), REAL_404.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''))
    expect(found).toHaveLength(1)
    expect(found[0]).toContain(join(dir, '404.html'))
    expect(found[0]).toMatch(/no Content-Security-Policy/)
  })

  it('fails a 404.html whose script is not the one its policy hashes, and says which hash is missing', async () => {
    const edited = REAL_404.replace('location.replace(', 'location.assign(')
    expect(edited).not.toBe(REAL_404)
    const found = await problems(page({ head: meta(GOOD) + INLINE }), edited)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain(join(dir, '404.html'))
    expect(found[0]).toContain(inlineScriptHashes(edited)[0])
    expect(found[0]).toMatch(/not in script-src/)
  })

  it('holds the 404.html to every rule, and says it is that file', async () => {
    const weak = REAL_404.replace("script-src 'self'", "script-src 'unsafe-eval' 'self'")
    const found = await problems(page({ head: meta(GOOD) + INLINE }), weak)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain(join(dir, '404.html'))
    expect(found[0]).toMatch(/unsafe-eval/)
  })

  it('names the file of each finding, when both pages have one', async () => {
    const found = await problems(page({ head: INLINE }), page({ head: INLINE }))
    expect(found).toHaveLength(2)
    expect(found[0]).toContain(join(dir, 'index.html'))
    expect(found[1]).toContain(join(dir, '404.html'))
  })

  it('passes a page with no inline script and a policy with a script-src', async () => {
    expect(await problems(page({ head: meta(GOOD) }))).toEqual([])
  })
})

describe('checkCsp, the policy meta', () => {
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

  it('does not take for a policy a tag that is no meta, however it is written', async () => {
    for (const tag of [`<link http-equiv="Content-Security-Policy" content="${GOOD}">`, `<div http-equiv="Content-Security-Policy" content="${GOOD}"></div>`, `<script http-equiv="Content-Security-Policy" content="${GOOD}" src="/a.js"></script>`]) {
      const found = await problems(page({ head: tag }))
      expect(found.some((p) => /no Content-Security-Policy/.test(p)), tag).toBe(true)
    }
  })

  it('fails a page with no head', async () => {
    const found = await problems(`<html><body>${meta(GOOD)}${INLINE}</body></html>`)
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

  it('judges every policy meta in the head by itself, since a browser holds the page to all of them', async () => {
    expect(await problems(page({ head: meta(GOOD) + meta(GOOD) + INLINE }))).toEqual([])
    expect(await problems(page({ head: meta(GOOD) + meta(policy(`script-src 'self'`)) + INLINE }))).toHaveLength(1)
    expect(await problems(page({ head: meta(policy(`script-src 'self'`)) + meta(GOOD) + INLINE }))).toHaveLength(1)
    expect(await problems(page({ head: meta(GOOD) + meta(policy(`script-src 'self' ${ALERT} *`)) + INLINE }))).toHaveLength(1)
  })
})

// What a page whose policy meta a browser ignores gets told: the meta is in the body, because something ended the head first.
const IN_THE_BODY = /no Content-Security-Policy meta tag in <head>: .*in the <body>.*ended the head/

describe('checkCsp, what comes before the policy meta, in the head', () => {
  it.each([
    ['an inline script', '<script>alert(1)</script>'],
    ['an external script', '<script src="/evil.js"></script>'],
    ['a module script', '<script type="module" src="/evil.js"></script>'],
    ['a script in capitals', '<SCRIPT SRC="/evil.js"></SCRIPT>'],
    ['a stylesheet link', '<link rel="stylesheet" href="/a.css">'],
    ['a preload link', '<link rel="preload" href="/a.js" as="script" />'],
    ['a link in capitals', '<LINK REL=stylesheet HREF=/a.css>'],
    ['a base', '<base href="/">'],
    ['a base in capitals', '<BASE HREF="https://evil.test/">'],
    ['a base for targets', '<base target="_blank">'],
    ['a style', '<style>p { color: red }</style>'],
    ['a noscript', '<noscript></noscript>'],
    ['a template', '<template></template>'],
    ['a refresh', '<meta http-equiv="refresh" content="999">'],
    ['a refresh that has a name', '<meta name="x" http-equiv="refresh" content="0;url=https://evil.test/">'],
    ['a refresh that has a charset', '<meta charset="UTF-8" http-equiv="refresh" content="0">'],
    ['a meta with nothing that says what it is', '<meta content="x">'],
    ['a default-style meta', '<meta http-equiv="default-style" content="x">'],
  ])('fails %s before the policy meta, since the policy applies only to what follows it', async (_, before) => {
    const found = await problems(page({ head: before + meta(GOOD) + INLINE }))
    expect(found, before).toHaveLength(1)
    expect(found[0]).toMatch(/comes before the policy meta: only a charset declaration, a title and a meta with a name or property may/)
    expect(found[0]).toContain(`<${/^<(\w+)/.exec(before)[1].toLowerCase()}>`)
  })

  it('does not take for a harmless meta an element that only has the attribute of one: a charset, a name or a property', async () => {
    for (const before of ['<script src="/a.js" charset="utf-8"></script>', '<link rel="stylesheet" href="/a.css" name="x">', '<base href="/" property="x">', '<style name="x"></style>', '<noscript name="x"></noscript>', '<template property="x"></template>']) {
      const found = await problems(page({ head: before + meta(GOOD) + INLINE }))
      expect(found, before).toHaveLength(1)
      expect(found[0]).toMatch(/comes before the policy meta/)
    }
  })

  it('names every element that comes before it, one finding each', async () => {
    const found = await problems(page({ head: `<base href="/"><script src="/a.js"></script><style></style>${meta(GOOD)}${INLINE}` }))
    expect(found).toHaveLength(3)
    expect(found.map((f) => /<(\w+)>/.exec(f)[1])).toEqual(['base', 'script', 'style'])
  })

  it('allows the charset declaration, a title, a meta with a name or a property, another policy, comments and white space before it', async () => {
    const before = [
      '<title>t</title>',
      '<meta name="viewport" content="width=device-width">',
      '<meta property="og:title" content="t">',
      '<meta charset="UTF-8">',
      meta(GOOD),
      '<!-- note -->',
      '\n  ',
      '\t\f\r ',
    ]
    for (const one of before) expect(await problems(page({ head: one + meta(GOOD) + INLINE })), one).toEqual([])
    expect(await problems(page({ head: before.join('\n') + meta(GOOD) + INLINE }))).toEqual([])
  })

  it.each([
    ['an abrupt <!-->', '<!--><script src="/evil.js"></script>'],
    ['an abrupt <!--->', '<!---><script src="/evil.js"></script>'],
    ['a comment closed by --!>', '<!-- a --!><script src="/evil.js"></script>'],
    ['a comment closed by --!> after text', '<!-- note: it is closed the odd way --!><base href="https://evil.test/">'],
  ])('fails what follows %s, which is no comment to a browser, and a script there runs', async (_, hidden) => {
    const found = await problems(page({ head: hidden + meta(GOOD) + INLINE }))
    // Twice told: what is before the meta, and that csp.mjs's scanner took the scripts after the comment for comment.
    expect(found).toHaveLength(2)
    expect(found.filter((f) => /comes before the policy meta/.test(f))).toHaveLength(1)
    expect(found.filter((f) => /csp\.mjs reads/.test(f))).toHaveLength(1)
  })

  it('judges each policy meta by what is before it: a later one may not follow a script', async () => {
    const found = await problems(page({ head: `${meta(GOOD)}${INLINE}${meta(GOOD)}` }))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/<script> comes before the policy meta/)
  })

  it('allows a script, a link, a base or a style after the policy meta, where the policy applies to it', async () => {
    expect(await problems(page({ head: `${meta(GOOD)}<base href="/"><link rel="icon" href="/a.png"><style></style>${INLINE}<script type="module" src="/a.js"></script>` }))).toEqual([])
  })

  it.each(['div', 'img', 'p', 'a', 'span', 'h1', 'iframe', 'form', 'input', 'button', 'section', 'table', 'object', 'embed', 'video', 'br', 'svg'])(
    'fails a <%s> in the head before the policy meta: it ends the head, and the meta is in the body',
    async (tag) => {
      const element = ['img', 'input', 'embed', 'br'].includes(tag) ? `<${tag}>` : `<${tag}></${tag}>`
      const found = await problems(page({ head: element + meta(GOOD) + INLINE }))
      expect(found, element).toHaveLength(1)
      expect(found[0]).toMatch(IN_THE_BODY)
    },
  )

  it('fails an element that is not closed before the policy meta, however it is written (a parser that tidies it away would not)', async () => {
    for (const open of ['<div>', '<section>', '<a href="/">', '<p>', '<span>', '<ul><li>']) {
      const found = await problems(page({ head: open + meta(GOOD) + INLINE }))
      expect(found, open).toHaveLength(1)
      expect(found[0]).toMatch(IN_THE_BODY)
    }
  })

  it.each([
    ['text', 'some text'],
    ['a no-break space', ' '],
    ['a no-break space entity', '&nbsp;'],
    ['a vertical tab', '\u000b'],
    ['an em space', ' '],
    ['an ideographic space', '　'],
    ['a byte order mark that is not the first character', '﻿'],
    ['a zero-width space', '​'],
    ['a next line', '\u0085'],
    ['a line separator', ' '],
    ['white space and then text', ' \n x'],
  ])('fails %s before the policy meta, which is not white space to HTML: it ends the head', async (_, text) => {
    const found = await problems(page({ head: text + meta(GOOD) + INLINE }))
    expect(found, JSON.stringify(text)).toHaveLength(1)
    expect(found[0]).toMatch(IN_THE_BODY)
  })

  it.each([
    ['a stray </body>', '</body>'],
    ['a stray </br>', '</br>'],
    ['a stray </html>', '</html>'],
  ])('fails %s before the policy meta, which a browser takes for the end of the head', async (_, stray) => {
    const found = await problems(page({ head: stray + meta(GOOD) + INLINE }))
    expect(found, stray).toHaveLength(1)
    expect(found[0]).toMatch(IN_THE_BODY)
  })

  it('does not mind a stray end tag that a browser ignores, nor a </head>, after which a browser still puts a meta in the head', async () => {
    for (const stray of ['</p>', '</div>', '</span>', '</title>', '</script>', '</head>']) {
      expect(await problems(page({ head: stray + meta(GOOD) + INLINE })), stray).toEqual([])
    }
  })

  it('reads a character reference for a space as the space it is', async () => {
    for (const reference of ['&#32;', '&#x20;', '&#9;', '&#10;']) {
      expect(await problems(page({ head: reference + meta(GOOD) + INLINE })), reference).toEqual([])
    }
  })

  it('names the body once, not each thing that came before the meta that ended the head', async () => {
    const found = await problems(page({ head: `<div></div><script src="/a.js"></script>text<base href="/">${meta(GOOD)}${INLINE}` }))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(IN_THE_BODY)
  })

  it('says the same when the policy is only in the body', async () => {
    const found = await problems(`<!doctype html><html><head>${CHARSET}</head><body>${meta(GOOD)}${INLINE}</body></html>`)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(IN_THE_BODY)
  })

  it('says there is none when there is no policy at all, and not that it is in the body', async () => {
    const found = await problems(page({ head: INLINE }))
    expect(found).toEqual([expect.stringMatching(/no Content-Security-Policy meta tag in <head>$/)])
  })
})

describe('checkCsp, what comes before the head', () => {
  // A whole page, with the good policy in its head, and `inHtml` between <html> and <head>, `root` before <html>.
  const doc = ({ root = '<!doctype html>', inHtml = '', open = '<html lang="en">', close = '</html>', head = meta(GOOD) + INLINE } = {}) =>
    `${root}${open}${inHtml}<head>${CHARSET}${head}</head><body></body>${close}`

  it('passes a page whose head follows the doctype, comments and white space', async () => {
    for (const written of [
      doc(),
      doc({ root: '<!DOCTYPE html>' }),
      doc({ root: '<!doctype html public "-//W3C//DTD HTML 4.01//EN">' }),
      doc({ root: '\n<!-- a --><!doctype html>\n<!-- b -->\n', inHtml: '\n  <!-- c -->\t\f\r ' }),
      doc({ root: '' }),
      doc({ root: '', open: '', close: '' }),
      doc({ root: '<!doctype html>\n', open: '<HTML LANG="en">', close: '</HTML>' }),
      doc({ root: '<!doctype html>', inHtml: '<!doctype html>' }),
      doc({ root: '<!doctype html>', inHtml: '<!-->', head: meta(GOOD), open: '<html>' }),
    ]) {
      expect(await problems(written), written).toEqual([])
    }
  })

  it('reads a character reference for a space as a space, and passes a byte order mark that begins the file', async () => {
    for (const written of [doc({ inHtml: '&#32;' }), doc({ root: '&#32;<!doctype html>' }), doc({ root: '﻿<!doctype html>' }), doc({ root: '﻿' }), doc({ root: '﻿<!-- a -->\n' })]) {
      expect(await problems(written), JSON.stringify(written)).toEqual([])
    }
  })

  it.each([
    ['an inline script', '<script>alert(1)</script>'],
    ['an external script', '<script src="/evil.js"></script>'],
    ['a stylesheet link', '<link rel="stylesheet" href="/a.css">'],
    ['a base', '<base href="https://evil.test/">'],
    ['a style', '<style></style>'],
    ['a script in capitals', '<SCRIPT SRC="/evil.js"></SCRIPT>'],
  ])('fails %s between <html> and <head>, and before <html>, which a browser puts in an implied head ahead of the policy', async (_, element) => {
    for (const written of [doc({ inHtml: element }), doc({ root: `<!doctype html>${element}` }), doc({ root: element })]) {
      const found = await problems(written)
      expect(found, written).toHaveLength(1)
      expect(found[0]).toMatch(/comes before the policy meta: only a charset declaration/)
    }
  })

  it.each([
    ['an abrupt <!-->', '<!--><script src="/evil.js"></script>'],
    ['an abrupt <!--->', '<!---><script src="/evil.js"></script>'],
    ['a comment closed by --!>', '<!-- a --!><script src="/evil.js"></script>'],
  ])('fails a script after %s, before the head: the comment is over, and the script is not in it', async (_, hidden) => {
    for (const written of [doc({ inHtml: hidden }), doc({ root: `<!doctype html>${hidden}` }), doc({ root: hidden })]) {
      const found = await problems(written)
      // Twice told: the script before the head, and csp.mjs's scanner, which took what follows the comment for comment.
      expect(found, written).toHaveLength(2)
      expect(found.filter((f) => /<script> comes before the policy meta/.test(f))).toHaveLength(1)
      expect(found.filter((f) => /csp\.mjs reads/.test(f))).toHaveLength(1)
    }
  })

  it.each(['div', 'img', 'p', 'a', 'span', 'h1', 'iframe', 'form', 'input', 'button', 'section', 'body', 'table', 'object', 'embed'])(
    'fails a <%s> between <html> and <head>, and before <html>: it starts the body, and the meta is in it',
    async (tag) => {
      const element = ['img', 'input', 'embed'].includes(tag) ? `<${tag}>` : `<${tag}></${tag}>`
      for (const written of [doc({ inHtml: element }), doc({ root: `<!doctype html>${element}` }), doc({ root: element })]) {
        const found = await problems(written)
        expect(found, written).toHaveLength(1)
        expect(found[0]).toMatch(IN_THE_BODY)
      }
    },
  )

  it('fails an element that is not closed before the head, which a parser that tidies the page would erase', async () => {
    for (const open of ['<div>', '<section>', '<a href="/">', '<p>', '<ul><li>', '<span>']) {
      for (const written of [doc({ inHtml: open }), doc({ root: `<!doctype html>${open}` })]) {
        const found = await problems(written)
        expect(found, written).toHaveLength(1)
        expect(found[0]).toMatch(IN_THE_BODY)
      }
    }
  })

  it('fails a 404.html that has an unclosed element before its head', async () => {
    const found = await problems(page({ head: meta(GOOD) + INLINE }), REAL_404.replace('<head>', '<div><head>'))
    expect(found).toHaveLength(1)
    expect(found[0]).toContain(join(dir, '404.html'))
    expect(found[0]).toMatch(IN_THE_BODY)
  })

  it.each([
    ['text', 'text'],
    ['a no-break space', ' '],
    ['a no-break space entity', '&nbsp;'],
    ['a vertical tab', '\u000b'],
    ['an em space', ' '],
    ['an ideographic space', '　'],
    ['a zero-width space', '​'],
    ['a next line', '\u0085'],
    ['a line separator', ' '],
    ['white space and then text', ' \n x'],
  ])('fails %s before the head, which is not white space to HTML and starts the body', async (_, text) => {
    for (const written of [doc({ inHtml: text }), doc({ root: `<!doctype html>${text}` }), doc({ root: text })]) {
      const found = await problems(written)
      expect(found, JSON.stringify(written)).toHaveLength(1)
      expect(found[0]).toMatch(IN_THE_BODY)
    }
  })

  it('fails a byte order mark that is not the first character of the file', async () => {
    for (const written of [doc({ inHtml: '﻿' }), doc({ root: '<!doctype html>﻿' }), doc({ root: ' ﻿' }), doc({ head: `﻿${meta(GOOD)}${INLINE}` })]) {
      const found = await problems(written)
      expect(found, JSON.stringify(written)).toHaveLength(1)
      expect(found[0]).toMatch(IN_THE_BODY)
    }
  })

  it.each([
    ['a stray </body>', '</body>'],
    ['a stray </br>', '</br>'],
    ['a stray </html>', '</html>'],
  ])('fails %s before the head: a browser starts a head, then the body, for it', async (_, stray) => {
    for (const written of [doc({ inHtml: stray }), doc({ root: `<!doctype html>${stray}` }), doc({ root: stray })]) {
      const found = await problems(written)
      expect(found, written).toHaveLength(1)
      expect(found[0]).toMatch(IN_THE_BODY)
    }
  })

  it('does not mind a stray end tag before the head that a browser ignores', async () => {
    for (const stray of ['</p>', '</div>', '</span>', '</title>']) {
      for (const written of [doc({ inHtml: stray }), doc({ root: `<!doctype html>${stray}` })]) {
        expect(await problems(written), written).toEqual([])
      }
    }
  })

  it('reads text after a doctype in the same stretch of text as text, and a doctype alone as nothing', async () => {
    expect((await problems(doc({ root: '<!doctype html>text' }))).length).toBe(1)
    expect((await problems(doc({ root: '<!doctype html>\n  text' }))).length).toBe(1)
    expect((await problems(doc({ inHtml: '<!doctype html>' }))).length).toBe(0)
    expect((await problems(doc({ head: `<!doctype html>${meta(GOOD)}${INLINE}` }))).length).toBe(0)
    expect((await problems(doc({ head: `text<!doctype html>${meta(GOOD)}${INLINE}` }))).length).toBe(1)
  })

  it('allows every HTML space character before the head', async () => {
    for (const space of ['\t', '\n', '\f', '\r', ' ', ' \t\n\f\r ']) {
      expect(await problems(doc({ root: space, inHtml: space, head: space + meta(GOOD) + INLINE }))).toEqual([])
    }
  })

  it.each([
    ['a body', '<html><body>', '</body></html>'],
    ['a div', '<div>', '</div>'],
    ['a div inside html', '<html><div>', '</div></html>'],
    ['a p', '<p>', '</p>'],
  ])('fails a head inside %s, where a browser ignores the tag and the meta is in the body', async (_, open, close) => {
    const found = await problems(`<!doctype html>${open}<head>${CHARSET}${meta(GOOD)}${INLINE}</head>${close}`)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(IN_THE_BODY)
  })

  it('allows a head inside <html> only: a nested <html> is read as the same one', async () => {
    expect(await problems(`<!doctype html><html><html lang="en"><head>${CHARSET}${meta(GOOD)}${INLINE}</head></html></html>`)).toEqual([])
  })

  it('names each element that comes before the policy meta in the head, when the head has got that far', async () => {
    const found = await problems(`<script src="/a.js"></script><html><head>${CHARSET}<base href="/">${meta(GOOD)}${INLINE}</head><body></body></html>`)
    expect(found).toHaveLength(2)
    expect(found.map((f) => /<(\w+)>/.exec(f)[1])).toEqual(['script', 'base'])
  })

  it('does not count what comes after the head, or is inside it after the policy', async () => {
    expect(await problems(`<!doctype html><html><head>${CHARSET}${meta(GOOD)}${INLINE}</head><div>text</div><script src="/b.js"></script><body></body></html>`)).toEqual([])
  })

  it('holds the 404.html to the same', async () => {
    const found = await problems(page({ head: meta(GOOD) + INLINE }), REAL_404.replace('<head>', '<script src="/evil.js"></script><head>'))
    expect(found).toHaveLength(1)
    expect(found[0]).toContain(join(dir, '404.html'))
    expect(found[0]).toMatch(/<script> comes before the policy meta/)
  })
})

describe('checkCsp, the charset declaration', () => {
  // A page whose <meta charset> ends at byte `end` of the file (the padding is a comment with two-byte characters in it).
  const endingAt = (end, policyMeta = '') => {
    const open = '<!doctype html><html><head><!--'
    const close = `-->${CHARSET}${policyMeta}`
    const pad = end - Buffer.byteLength(open + close) + Buffer.byteLength(policyMeta)
    expect(pad).toBeGreaterThanOrEqual(0)
    return `${open}${'é'.repeat(Math.floor(pad / 2))}${'x'.repeat(pad % 2)}-->${CHARSET}${policyMeta}${INLINE}</head><body></body></html>`
  }

  it('passes a charset declaration that ends at byte 1024, and fails one that ends a byte later', async () => {
    const at = (end) => endingAt(end, meta(GOOD))
    expect(Buffer.byteLength(at(1024).slice(0, at(1024).indexOf(CHARSET) + CHARSET.length))).toBe(1024)
    expect(await problems(at(1024))).toEqual([])
    const found = await problems(at(1025))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/charset.*1024/)
  })

  it('counts bytes, not characters: a page of two-byte characters that is under 1024 characters but not under 1024 bytes fails', async () => {
    const html = endingAt(1100, meta(GOOD))
    expect(html.indexOf(CHARSET) + CHARSET.length).toBeLessThan(1024)
    expect((await problems(html)).some((p) => /charset/.test(p))).toBe(true)
  })

  it('fails a page whose policy is so long that it pushes the charset declaration past 1024 bytes', async () => {
    const long = `${GOOD}; img-src ${'https://a.example.test '.repeat(40)}`
    const found = await problems(`<!doctype html><html><head>${meta(long)}${CHARSET}${INLINE}</head></html>`)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/charset/)
  })

  it('does not ask for a charset declaration, and ignores one in the body', async () => {
    expect(await problems(`<!doctype html><html><head>${meta(GOOD)}${INLINE}</head><body>${CHARSET.padStart(2000, ' ')}</body></html>`)).toEqual([])
  })

  it('does not take the policy meta, or any other tag with a charset attribute, for the declaration, however far into the page it ends', async () => {
    const long = `${GOOD}; img-src ${'https://a.example.test '.repeat(40)}`
    expect(await problems(`<!doctype html><html><head>${meta(long)}${INLINE}</head></html>`)).toEqual([])
    expect(await problems(`<!doctype html><html><head>${meta(long)}<link rel="stylesheet" href="/a.css" charset="utf-8"><script src="/a.js" charset="utf-8"></script>${INLINE}</head></html>`)).toEqual([])
  })

  it('reads the first charset declaration in the head, however its attribute is written', async () => {
    const far = `<!--${'x'.repeat(1100)}-->`
    for (const declaration of ['<meta charset="UTF-8">', '<meta charset=utf-8>', "<META CHARSET='utf-8' />", '<meta data-x="1" CHARSET="x">']) {
      const found = await problems(`<!doctype html><html><head>${far}${declaration}${meta(GOOD)}${INLINE}</head></html>`)
      expect(found.some((p) => /charset/.test(p))).toBe(true)
    }
  })
})

describe('checkCsp, the charset declaration and a byte order mark', () => {
  const endingAt = (end, lead, policyMeta) => {
    const open = `${lead}<!doctype html><html><head><!--`
    const tail = `-->${CHARSET}`
    const pad = end - Buffer.byteLength(open + tail)
    expect(pad).toBeGreaterThanOrEqual(0)
    return `${open}${'x'.repeat(pad)}${tail}${policyMeta}${INLINE}</head><body></body></html>`
  }

  it('counts the three bytes of a byte order mark that begins the file', async () => {
    const withBom = (end) => endingAt(end, '﻿', meta(GOOD))
    expect(Buffer.byteLength(withBom(1024).slice(0, withBom(1024).indexOf(CHARSET) + CHARSET.length))).toBe(1024)
    expect(await problems(withBom(1024))).toEqual([])
    const found = await problems(withBom(1025))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/charset.*1024/)
  })

  it('does not count a mark that is not there', async () => {
    expect(await problems(endingAt(1024, '', meta(GOOD)))).toEqual([])
    expect((await problems(endingAt(1025, '', meta(GOOD)))).length).toBe(1)
  })
})

describe('checkCsp, the script hashes as an HTML parser reads them', () => {
  // The hash as a pattern reads it literally: every character a RegExp gives a meaning to is escaped, the backslash too.
  const escaped = (hash) => hash.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
  const NONE = '\\(none\\)'
  const agree = (scanned, parsed) => new RegExp(`csp\\.mjs reads the inline scripts of the page as ${scanned}, but an HTML parser reads ${parsed}`)

  it('builds its patterns from text that a pattern reads as nothing but that text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        expect(new RegExp(`^${escaped(text)}$`).test(text)).toBe(true)
        expect(new RegExp(`^${escaped(text)}$`).test(`${text}x`)).toBe(false)
      }),
    )
    for (const text of ['\\d', 'a.b', '(x)', '[+/]', '^$', 'a|b', '{1}', '*?']) {
      expect(new RegExp(`^${escaped(text)}$`).test(text)).toBe(true)
      expect(new RegExp(`^${escaped(text)}$`).test(text.replace(/./, 'z'))).toBe(false)
    }
  })

  it('agrees with csp.mjs for a plain page, and says nothing', async () => {
    expect(await problems(page({ head: meta(GOOD) + INLINE }))).toEqual([])
    expect(await problems(page({ head: meta(GOOD) }))).toEqual([])
  })

  it('reads line breaks the way a browser does, as the build does for a CRLF script', async () => {
    const hash = `'sha256-${createHash('sha256').update('a\nb').digest('base64')}'`
    const policyFor = (h) => policy(`default-src 'self'; script-src 'self' ${h}`)
    expect(await problems(page({ head: meta(policyFor(hash)) + '<script>a\r\nb</script>' }))).toEqual([])
    expect(await problems(page({ head: meta(policyFor(hash)) + '<script>a\rb</script>' }))).toEqual([])
  })

  it.each([
    ['an abrupt <!-->', '<!--><script>alert(1)</script>'],
    ['an abrupt <!--->', '<!---><script>alert(1)</script>'],
    ['a comment closed by --!>', '<!-- a --!><script>alert(1)</script>'],
    ['a <!-- that is only text in a <title>', '<title><!--</title><script>alert(1)</script>'],
    ['a <!-- that is only text in a <textarea>', '<textarea><!--</textarea><script>alert(1)</script>'],
    ['a <!-- that is only text in a <style>', '<style><!--</style><script>alert(1)</script>'],
  ])('fails when the scanner of csp.mjs takes a script after %s for a comment, and names both lists', async (_, hidden) => {
    // The script is real, and in the policy; csp.mjs did not see it, so the policy it would have written would not have it.
    const found = await problems(page({ head: meta(GOOD), body: hidden }))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(agree(NONE, escaped(ALERT)))
  })

  it('fails a script that csp.mjs read as another text than a browser does, and also that the policy does not hold the browser’s', async () => {
    const found = await problems(page({ head: meta(GOOD), body: '<script><!--\nwindow.__ran = true // <script>\n//</script>\nvoid 0\n</script>' }))
    expect(found).toHaveLength(2)
    expect(found.some((f) => /csp\.mjs reads the inline scripts of the page as 'sha256-.*, but an HTML parser reads 'sha256-/.test(f))).toBe(true)
    expect(found.some((f) => /inline script 'sha256-[A-Za-z0-9+/]{43}=' is not in script-src/.test(f))).toBe(true)
  })

  it('fails a NUL, which a browser reads as U+FFFD and csp.mjs hashes as it is', async () => {
    const found = await problems(page({ head: meta(GOOD), body: '<script>a\u0000b</script>' }))
    expect(found.some((f) => /csp\.mjs reads/.test(f))).toBe(true)
    expect(found.some((f) => /not in script-src/.test(f))).toBe(true)
  })

  it('fails a script that csp.mjs reads inside a <title> and a browser does not, and names both lists', async () => {
    const found = await problems(page({ head: meta(GOOD) + '<title><script>alert(1)</script></title>' }))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(agree(escaped(ALERT), NONE))
  })

  it('names the lists in full, in the order of the page, when there are several', async () => {
    const found = await problems(page({ head: meta(GOOD) + INLINE, body: '<!--><script></script><script>alert(1)</script>' }))
    expect(found.some((f) => f.includes(`as ${ALERT}, but an HTML parser reads ${ALERT} ${EMPTY} ${ALERT}`))).toBe(true)
  })

  it('requires the hash of each script the parser finds in script-src, whatever csp.mjs found', async () => {
    const found = await problems(page({ head: meta(GOOD) + INLINE, body: '<!--><script>other()</script>' }))
    expect(found.some((f) => /inline script 'sha256-[A-Za-z0-9+/]{43}=' is not in script-src/.test(f))).toBe(true)
    expect(found.some((f) => /csp\.mjs reads/.test(f))).toBe(true)
  })

  it('does not count a script in a template, which no browser runs, though csp.mjs reads it', async () => {
    const found = await problems(page({ head: meta(GOOD) + INLINE, body: '<template><script>other()</script></template>' }))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/csp\.mjs reads/)
  })
})

describe('checkCsp, the script hashes', () => {
  it('fails an inline script whose hash is not in script-src, and names the hash', async () => {
    const found = await problems(withMeta(GOOD, '<script>other()</script>'))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/inline script 'sha256-[A-Za-z0-9+/]{43}='/)
    expect(found[0]).not.toContain(ALERT)
  })

  it('fails every inline script that is not listed, one finding each', async () => {
    const found = await problems(page({ head: meta(policy(`default-src 'self'; script-src 'self'`)) + INLINE + '<script></script>' }))
    expect(found).toHaveLength(2)
    expect(found.join('\n')).toContain(ALERT)
    expect(found.join('\n')).toContain(EMPTY)
  })

  it('fails a script whose hash is only in another directive', async () => {
    expect(await problems(page({ head: meta(policy(`default-src 'self' ${ALERT}; script-src 'self'`)) + INLINE }))).toHaveLength(1)
    expect(await problems(page({ head: meta(policy(`default-src 'self'; script-src 'self'; style-src ${ALERT}`)) + INLINE }))).toHaveLength(1)
  })

  it('fails a script that differs from the listed one by a space', async () => {
    expect(await problems(page({ head: meta(GOOD) + '<script> alert(1)</script>' }))).toHaveLength(1)
  })

  it('does not ask for the hash of a script that has a src', async () => {
    expect(await problems(page({ head: meta(GOOD) + '<script type="module" crossorigin src="/assets/a.js"></script>' + INLINE }))).toEqual([])
  })

  it('fails a policy with no script-src, since script would then follow a looser rule', async () => {
    const found = await problems(page({ head: meta(policy(`default-src 'self'`)) }))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/script-src/)
    expect((await problems(page({ head: meta('') }))).some((p) => /script-src/.test(p))).toBe(true)
    expect((await problems(page({ head: '<meta http-equiv="Content-Security-Policy" />' }))).some((p) => /script-src/.test(p))).toBe(true)
  })

  it('uses the first script-src, as a browser does, and not a later one that would be ignored', async () => {
    expect(await problems(page({ head: meta(policy(`script-src 'self'; script-src 'self' ${ALERT}`)) + INLINE }))).toHaveLength(1)
    expect(await problems(page({ head: meta(policy(`script-src 'self' ${ALERT}; script-src 'self'`)) + INLINE }))).toEqual([])
  })
})

const SCRIPT_DIRECTIVES = ['script-src', 'script-src-elem', 'script-src-attr']

describe('checkCsp, what weakens the script rules', () => {
  const KEYWORDS = ["'unsafe-inline'", "'unsafe-eval'", "'strict-dynamic'", "'unsafe-hashes'", "'wasm-unsafe-eval'"]

  it.each(KEYWORDS)('fails %s in script-src, script-src-elem, script-src-attr and default-src, each by name', async (keyword) => {
    for (const name of [...SCRIPT_DIRECTIVES, 'default-src']) {
      const found = await problems(page({ head: meta(policy(`script-src 'self' ${ALERT}; ${name} ${keyword}`)) + INLINE }))
      expect(found.some((p) => p.includes(name) && p.includes(keyword))).toBe(true)
    }
  })

  it.each(KEYWORDS)('reads %s in capitals too', async (keyword) => {
    const found = await problems(page({ head: meta(policy(`script-src 'self' ${ALERT} ${keyword.toUpperCase()}`)) + INLINE }))
    expect(found).toHaveLength(1)
  })

  it('allows unsafe-inline in style-src, which the site needs for its style attributes, and anywhere that is no script rule', async () => {
    const found = await problems(page({ head: meta(`${GOOD}; style-src 'self' 'unsafe-inline'; img-src 'unsafe-inline'; font-src 'strict-dynamic' 'unsafe-hashes' 'wasm-unsafe-eval'`) + INLINE }))
    expect(found).toEqual([])
  })

  it("fails 'unsafe-eval' in a directive that is no script one, as the policy has none of it anywhere", async () => {
    const found = await problems(page({ head: meta(`${GOOD}; img-src 'unsafe-eval'`) + INLINE }))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/img-src allows 'unsafe-eval'/)
  })

  it("fails 'unsafe-eval' in a later directive of the same name, which a browser ignores but a page should not carry", async () => {
    expect(await problems(page({ head: meta(policy(`script-src 'self' ${ALERT}; script-src 'unsafe-eval'`)) + INLINE }))).toHaveLength(1)
  })

  it.each(['https:', 'http:', 'data:', 'blob:', 'wss:', 'filesystem:', 'HTTPS:', 'x+y.z-1:'])('fails the scheme-only source %s in the directives that run script or hold plug-ins and <base>', async (source) => {
    for (const name of [...SCRIPT_DIRECTIVES, 'default-src', 'object-src', 'base-uri']) {
      const found = await problems(page({ head: meta(`default-src 'self'; script-src 'self' ${ALERT}; ${NONE}; ${name} ${source}`) + INLINE }))
      expect(found.some((p) => p.includes(name) && p.includes(source) && /scheme/.test(p))).toBe(true)
    }
  })

  it('allows a scheme-only source where the site needs one: img-src, media-src, font-src and connect-src', async () => {
    for (const name of ['img-src', 'media-src', 'font-src', 'connect-src', 'frame-src', 'style-src']) {
      expect(await problems(page({ head: meta(`${GOOD}; ${name} 'self' data: blob: https:`) + INLINE }))).toEqual([])
    }
  })

  it('does not take for a scheme-only source one that has a host, a keyword, a hash or a port', async () => {
    for (const source of ['https://a.test', 'a.test', 'localhost:8787', "'self'", ALERT, 'https://*.a.test', '*.a.test:443', 'https://a.test:']) {
      expect(await problems(page({ head: meta(`${GOOD}; script-src-elem 'self' ${ALERT} ${source}`) + INLINE }))).toEqual([])
    }
  })

  it.each([
    ['*', '*'],
    ['a wildcard host with a scheme', 'https://*'],
    ['a wildcard host with a port', 'https://*:443'],
    ['a wildcard host with any port', '*:*'],
    ['a wildcard host with a path', 'https://*/x'],
    ['a wildcard host with a long path', 'https://*/some/long/path'],
    ['a wildcard in any case of scheme', 'HTTPS://*'],
    ['a wildcard host with another scheme', 'wss://*'],
  ])('fails %s as a source', async (_, source) => {
    for (const name of ['default-src', 'img-src', 'connect-src', 'script-src', 'font-src', 'frame-src']) {
      const found = await problems(page({ head: meta(`script-src 'self' ${ALERT}; ${NONE}; ${name} ${source}`) + INLINE }))
      expect(found.some((p) => p.includes(name) && p.includes(source))).toBe(true)
    }
  })

  it('allows a wildcard in the sub-domain of a named host, which is not a wildcard host', async () => {
    for (const source of ['https://*.discordapp.net', '*.example.test', 'https://*.r2.cloudflarestorage.com:443', 'https://a.*.test', 'https://a.test/*', 'https://a.test:443/a/*', 'a.test*']) {
      expect(await problems(page({ head: meta(policy(`script-src 'self' ${ALERT}; img-src ${source}`)) + INLINE }))).toEqual([])
    }
  })

  it('does not take a source that only holds the words for a keyword', async () => {
    expect(await problems(page({ head: meta(`${GOOD}; style-src 'self' 'unsafe-inline'; img-src https://unsafe-eval.example.test https://unsafe-inline.example.test`) + INLINE }))).toEqual([])
  })

  it.each(['object-src', 'base-uri'])("fails a policy with no %s of 'none': missing, loosened, or with something beside it", async (name) => {
    const without = GOOD.replace(`${NONE}`, NONE.split('; ').filter((d) => !d.startsWith(name)).join('; '))
    for (const [what, content] of [
      ['missing', without],
      ["'self'", `${without}; ${name} 'self'`],
      ['a host', `${without}; ${name} https://a.test`],
      ["'none' and another", `${without}; ${name} 'none' 'self'`],
      ['nothing', `${without}; ${name}`],
      ['the loosened one first', `${without}; ${name} 'self'; ${name} 'none'`],
    ]) {
      const found = await problems(page({ head: meta(content) + INLINE }))
      expect(found.some((p) => p.includes(`${name} is not 'none'`)), what).toBe(true)
    }
  })

  it.each(['object-src', 'base-uri'])("passes %s 'none' in any case, and when a later one is looser, which a browser ignores", async (name) => {
    const without = GOOD.replace(`${NONE}`, NONE.split('; ').filter((d) => !d.startsWith(name)).join('; '))
    expect(await problems(page({ head: meta(`${without}; ${name.toUpperCase()} 'NONE'`) + INLINE }))).toEqual([])
    expect(await problems(page({ head: meta(`${without}; ${name} 'none'; ${name} 'self'`) + INLINE }))).toEqual([])
  })

  it('reads a policy with extra white space, empty directives and capitals in a directive name', async () => {
    const written = `  DEFAULT-SRC   'self' ;;\n SCRIPT-SRC\t'self'  ${ALERT}  ;  OBJECT-SRC   'none';BASE-URI \t 'none' ;  `
    expect(await problems(page({ head: meta(written) + INLINE }))).toEqual([])
    expect(await problems(page({ head: meta(written.replace(ALERT, "'unsafe-eval'")) + INLINE }))).toHaveLength(2)
  })

  it('holds the whole policy the build writes to every rule, and finds it good', async () => {
    const built = buildCsp({ apiOrigin: 'https://builds-api.example.test', scriptHashes: inlineScriptHashes(INLINE) })
    expect(await problems(page({ head: meta(built) + INLINE }))).toEqual([])
    expect(await problems(page({ head: meta(buildCsp({ scriptHashes: inlineScriptHashes(INLINE) })) + INLINE }))).toEqual([])
  })

  it('finds a fault whenever one source of the build policy is swapped for a weakening', () => {
    const built = buildCsp({ apiOrigin: 'https://builds-api.example.test', scriptHashes: [ALERT] })
    return fc.assert(
      fc.asyncProperty(fc.constantFrom('*', 'https:', "'unsafe-inline'", "'unsafe-eval'", "'strict-dynamic'", "'unsafe-hashes'", "'wasm-unsafe-eval'", 'data:', 'https://*'), fc.constantFrom(...SCRIPT_DIRECTIVES, 'default-src'), async (weak, name) => {
        const weakened = `${built}; ${name} ${weak}`
        expect((await problems(page({ head: meta(weakened) + INLINE }))).length).toBeGreaterThan(0)
      }),
      { numRuns: 60 },
    )
  })
})

describe('main', () => {
  it('is code 0 and says which pages it checked, for a good build', async () => {
    await build(page({ head: meta(GOOD) + INLINE }))
    const result = await main([dir])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`csp ok: ${join(dir, 'index.html')}, ${join(dir, '404.html')}`)
    expect(result.stderr).toBeUndefined()
  })

  it('is code 1 and lists every finding, one a line, for a bad build', async () => {
    await build(page({ head: meta(policy(`script-src 'self' *`)) + INLINE }))
    const result = await main([dir])
    expect(result.code).toBe(1)
    expect(result.stdout.split('\n')).toHaveLength(2)
    expect(result.stdout).toMatch(/script-src/)
    expect(result.stderr).toBeUndefined()
  })

  it('is code 1 and says how to use it when it is not given a directory', async () => {
    const result = await main([])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/usage/i)
    expect(result.stdout).toBeUndefined()
  })

  it('looks only at the first argument', async () => {
    await build(page({ head: meta(GOOD) + INLINE }))
    expect((await main([dir, join(dir, 'nowhere')])).code).toBe(0)
  })
})

describe('check-csp.mjs run as a script', () => {
  // As a real process, which is how the pre-push hook and the workflows run it.
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

  it('exits 0 for a good build and prints which pages it checked', async () => {
    await build(page({ head: meta(GOOD) + INLINE }))
    const result = run(dir)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`csp ok: ${join(dir, 'index.html')}, ${join(dir, '404.html')}\n`)
    expect(result.stderr).toBe('')
  })

  it('exits 1 and prints every finding, a line each, for a bad build', async () => {
    await build(page({ head: meta(policy(`script-src 'self' *`)) + INLINE }))
    const result = run(dir)
    expect(result.status).toBe(1)
    expect(result.stdout.trim().split('\n')).toHaveLength(2)
    expect(result.stdout).toMatch(/script-src/)
    expect(result.stderr).toBe('')
  })

  it('exits 1 for a build with no policy, and for a directory with no pages', async () => {
    await build(page({ head: INLINE }))
    expect(run(dir).status).toBe(1)
    expect(run(join(dir, 'nowhere')).status).toBe(1)
  })

  it('exits 1 and prints how to use it, and nothing else, when it is not given a directory', () => {
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/usage/i)
    expect(result.stdout).toBe('')
  })

  it('does nothing when it is only imported by something else', async () => {
    const importer = join(dir, 'importer.mjs')
    await writeFile(importer, `import { main } from ${JSON.stringify(SCRIPT)}\nconsole.log(typeof main)\n`)
    const result = spawnSync(process.execPath, [importer, dir], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('function\n')
    expect(result.stderr).toBe('')
  })
})
