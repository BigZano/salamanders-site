import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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

describe('checkCsp, what comes before the policy meta', () => {
  it.each([
    ['script', ['<script src="/a.js"></script>', '<SCRIPT SRC="/a.js"></SCRIPT>', '<script type="module" src="/a.js"></script>']],
    ['link', ['<link rel="stylesheet" href="/a.css">', '<LINK REL=stylesheet HREF=/a.css>', '<link rel="preload" href="/a.js" as="script" />']],
    ['base', ['<base href="/">', '<BASE HREF="https://evil.test/">', '<base target="_blank">']],
  ])('fails a <%s> in the head before the policy meta, which loads or acts before the policy applies', async (tag, written) => {
    for (const before of written) {
      const found = await problems(page({ head: before + meta(GOOD) + INLINE }))
      expect(found, before).toHaveLength(1)
      expect(found[0]).toContain(`<${tag}> comes before the policy meta, so it loads or acts before the policy applies`)
      expect(found[0]).not.toMatch(/ends the head/)
    }
  })

  it('fails an inline script before the policy meta, and names it as one', async () => {
    const found = await problems(page({ head: INLINE + meta(GOOD) }))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/<script> comes before the policy meta, so it loads or acts/)
  })

  it.each(['div', 'img', 'p', 'a', 'span', 'h1', 'iframe', 'form', 'input', 'button', 'section'])(
    'fails a <%s> in the head before the policy meta, which ends the head, so a browser puts the meta in the body and ignores it',
    async (tag) => {
      const found = await problems(page({ head: `<${tag}>${['img', 'input'].includes(tag) ? '' : `</${tag}>`}${meta(GOOD)}${INLINE}` }))
      expect(found).toHaveLength(1)
      expect(found[0]).toContain(`<${tag}>`)
      expect(found[0]).toMatch(/ends the head/)
    },
  )

  it('fails text in the head before the policy meta, which also ends the head', async () => {
    const found = await problems(page({ head: `some text${meta(GOOD)}${INLINE}` }))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/text comes before the policy meta/)
  })

  it('names every such element, one finding each', async () => {
    const found = await problems(page({ head: `<div></div><script src="/a.js"></script>text<base href="/">${meta(GOOD)}${INLINE}` }))
    expect(found).toHaveLength(4)
  })

  it('allows the charset declaration, a title, other metas, a style, a noscript, a template, comments and white space before it', async () => {
    const before = ['<title>t</title>', '<meta name="viewport" content="width=device-width">', '<style>p { color: red }</style>', '<noscript></noscript>', '<template></template>', '<!-- note -->', '\n  ', '<meta http-equiv="refresh" content="999">']
    for (const one of before) expect(await problems(page({ head: one + meta(GOOD) + INLINE }))).toEqual([])
    expect(await problems(page({ head: before.join('\n') + meta(GOOD) + INLINE }))).toEqual([])
  })

  it('allows a script, a link or a base after the policy meta, where the policy applies to it', async () => {
    expect(await problems(page({ head: `${meta(GOOD)}<base href="/"><link rel="icon" href="/a.png">${INLINE}<script type="module" src="/a.js"></script>` }))).toEqual([])
  })

  it('looks only at what is before each policy meta: a later one may follow a script', async () => {
    const found = await problems(page({ head: `${meta(GOOD)}${INLINE}${meta(GOOD)}` }))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/<script> comes before the policy meta, so it loads or acts/)
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
    ]) {
      expect(await problems(written), written).toEqual([])
    }
  })

  it.each([
    ['an inline script', '<script>alert(1)</script>'],
    ['an external script', '<script src="/evil.js"></script>'],
    ['a stylesheet link', '<link rel="stylesheet" href="/a.css">'],
    ['a base', '<base href="https://evil.test/">'],
    ['a script in capitals', '<SCRIPT SRC="/evil.js"></SCRIPT>'],
  ])('fails %s between <html> and <head>, which a browser puts in an implied head ahead of the policy', async (_, element) => {
    const found = await problems(doc({ inHtml: element }))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/comes before the policy meta, so it loads or acts before the policy applies/)
  })

  it.each([
    ['a script', '<script src="/evil.js"></script>'],
    ['a link', '<link rel="stylesheet" href="/a.css">'],
    ['a base', '<base href="/">'],
  ])('fails %s before <html>, which a browser puts in an implied head', async (_, element) => {
    const found = await problems(doc({ root: `<!doctype html>${element}` }))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/comes before the policy meta, so it loads or acts/)
    expect((await problems(doc({ root: element }))).length).toBe(1)
  })

  it.each(['div', 'img', 'p', 'a', 'span', 'h1', 'iframe', 'form', 'input', 'button', 'section', 'body', 'table'])(
    'fails a <%s> between <html> and <head>, and before <html>, which a browser reads as the start of the body',
    async (tag) => {
      const element = ['img', 'input'].includes(tag) ? `<${tag}>` : `<${tag}></${tag}>`
      for (const written of [doc({ inHtml: element }), doc({ root: `<!doctype html>${element}` }), doc({ root: element })]) {
        const found = await problems(written)
        expect(found, written).toHaveLength(1)
        expect(found[0]).toContain(`<${tag}> comes before the policy meta and ends the head`)
      }
    },
  )

  it.each([
    ['text', 'text'],
    ['a no-break space', ' '],
    ['a no-break space entity', '&nbsp;'],
    ['a vertical tab', '\u000b'],
    ['an em space', ' '],
    ['an ideographic space', '　'],
    ['a byte order mark', '﻿'],
    ['a zero-width space', '​'],
    ['a next line', '\u0085'],
    ['a line separator', ' '],
    ['a character reference', '&#32;'],
    ['white space and then text', ' \n x'],
  ])('fails %s before the head, and after the charset declaration, since it is not white space to HTML and ends the head', async (_, text) => {
    for (const written of [doc({ inHtml: text }), doc({ root: `<!doctype html>${text}` }), doc({ root: text }), doc({ head: text + meta(GOOD) + INLINE }), page({ head: text + meta(GOOD) + INLINE })]) {
      const found = await problems(written)
      expect(found, JSON.stringify(written)).toHaveLength(1)
      expect(found[0]).toMatch(/text comes before the policy meta/)
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
    ['body', '<html><body>', '</body></html>'],
    ['div', '<div>', '</div>'],
    ['div inside html', '<html><div>', '</div></html>'],
    ['p', '<p>', '</p>'],
  ])('fails a head inside a <%s>, where a browser ignores the tag and the meta is in the body', async (tag, open, close) => {
    const written = `<!doctype html>${open}<head>${CHARSET}${meta(GOOD)}${INLINE}</head>${close}`
    const found = await problems(written)
    expect(found.some((p) => /the <head> is inside <(body|div|p)>/.test(p)), found.join('|')).toBe(true)
  })

  it('names each element a head is inside, and says what then happens to the meta', async () => {
    const found = await problems(`<html><body><div><head>${CHARSET}${meta(GOOD)}${INLINE}</head></div></body></html>`)
    expect(found.filter((p) => /the <head> is inside/.test(p))).toHaveLength(2)
    expect(found.join('\n')).toMatch(/the <head> is inside <div>, where a browser ignores the tag: the policy meta is then in the body, and ignored/)
    expect(found.join('\n')).toMatch(/the <head> is inside <body>/)
  })

  it('allows a head inside <html> only: a nested <html> is read as the same one', async () => {
    expect(await problems(`<!doctype html><html><html lang="en"><head>${CHARSET}${meta(GOOD)}${INLINE}</head></html></html>`)).toEqual([])
  })

  it('looks at what is before the head at every level, one finding each', async () => {
    const found = await problems(`<script src="/a.js"></script><html><div></div>text<head>${CHARSET}<base href="/">${meta(GOOD)}${INLINE}</head><body></body></html>`)
    expect(found).toHaveLength(4)
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
