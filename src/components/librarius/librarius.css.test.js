import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { withoutHoverMedia } from '../../test-utils/css'

// What a message promises on a phone (nothing wider than the column, links a finger can hit, nothing that needs a hover)
// and how text from Discord is kept from disturbing what is beside it, pinned in the one stylesheet. The motion rules
// are swept by motionPolicy.test.js.
const css = readFileSync(fileURLToPath(new URL('./librarius.css', import.meta.url)), 'utf8')
const rule = (selector) => new RegExp(`(?:^|\\n)${selector.replace(/[.[\]()*>:]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('librarius.css', () => {
  it('starts every class it styles with lb-, or styles a markdown class only inside a message', () => {
    const selectors = [...withoutComments.matchAll(/(?:^|\})\s*([^{}@]+)\{/g)].flatMap((m) => m[1].split(','))
    expect(selectors.length).toBeGreaterThan(20)
    for (const selector of selectors.map((s) => s.trim()).filter(Boolean)) {
      expect(selector, selector).toMatch(/\.lb-|^(?:\d+%|from|to)$/)
    }
  })

  it('writes no colour as a literal hex code: the site\'s tokens, or rgba over them', () => {
    expect(withoutComments).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('sets no type size in pixels, rems or ems of its own on the text it shows: the ramp\'s tokens', () => {
    for (const selector of ['.lb-time', '.lb-reply', '.lb-file', '.lb-missing', '.lb-sticker', '.lb-reaction', '.lb-count']) {
      expect(rule(selector), selector).toMatch(/font-size:\s*var\(--text-(?:xs|sm|md|base)\)/)
    }
  })

  it('keeps a picture inside the column, at its own shape', () => {
    expect(rule('.lb-image')).toMatch(/max-width:\s*100%/)
    expect(rule('.lb-image')).toMatch(/height:\s*auto/)
    expect(rule('.lb-image')).toMatch(/width:\s*auto/)
    expect(css).toMatch(/\.lb-embed-thumb,\s*\.lb-embed-image\s*\{[^}]*max-width:\s*100%[^}]*height:\s*auto/)
  })

  it('keeps a code block inside the column, scrolling sideways within itself', () => {
    expect(rule('.lb-msg .md-pre')).toMatch(/overflow-x:\s*auto/)
    expect(rule('.lb-main')).toMatch(/min-width:\s*0/)
    expect(rule('.lb-msg')).toMatch(/grid-template-columns:\s*2\.5rem minmax\(0,\s*1fr\)/)
  })

  it.each(['.lb-file', '.lb-reply'])('%s is a full-size tap target', (selector) => {
    expect(rule(selector), selector).toMatch(/min-height:\s*var\(--tap\)/)
  })

  it.each(['.lb-name', '.lb-body', '.lb-reply-text', '.lb-embed'])('%s keeps a right-to-left override in its own block', (selector) => {
    expect(rule(selector), selector).toMatch(/unicode-bidi:\s*isolate/)
  })

  it('wraps long words and addresses rather than stretching the page', () => {
    for (const selector of ['.lb-name', '.lb-body', '.lb-file', '.lb-embed']) expect(rule(selector), selector).toMatch(/overflow-wrap:\s*anywhere/)
  })

  it('hides a spoiler from the eye until it is shown', () => {
    expect(rule('.lb-msg .md-spoiler')).toMatch(/color:\s*transparent/)
    expect(rule('.lb-msg .md-spoiler *')).toMatch(/visibility:\s*hidden/)
    expect(rule('.lb-msg .md-spoiler.is-shown *')).toMatch(/visibility:\s*visible/)
  })

  it('sets an article apart as a panel, with a larger body', () => {
    expect(rule('.lb-article')).toMatch(/border:\s*1px solid var\(--color-ash\)/)
    expect(rule('.lb-article')).toMatch(/padding:/)
    expect(rule('.lb-article .lb-body')).toMatch(/font-size:\s*var\(--text-base\)/)
  })

  it('rounds the avatar with the site\'s pill radius, and the boxes with its radii', () => {
    expect(rule('.lb-avatar')).toMatch(/border-radius:\s*var\(--radius-pill\)/)
    expect(rule('.lb-article')).toMatch(/border-radius:\s*var\(--radius-md\)/)
    expect(rule('.lb-reaction')).toMatch(/border-radius:\s*var\(--radius-pill\)/)
  })

  it('has no hover rule outside the real-pointer media query: nothing depends on hover', () => {
    expect(css).toContain(':hover')
    expect(withoutHoverMedia(css)).not.toContain(':hover')
  })

  it('has no animation or transition of its own', () => {
    expect(withoutComments).not.toMatch(/\b(?:animation|transition)\b/)
  })
})
