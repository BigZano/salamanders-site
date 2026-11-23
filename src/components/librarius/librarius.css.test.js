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
    for (const selector of ['.lb-time', '.lb-reply', '.lb-file', '.lb-missing', '.lb-sticker', '.lb-reaction', '.lb-count', '.lb-topic-title', '.lb-topic-latest', '.lb-topic-meta', '.lb-chip', '.lb-sort', '.lb-tag', '.lb-new', '.lb-pin', '.lb-crumbs', '.lb-post-meta', '.lb-notice', '.lb-divider', '.lb-month']) {
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

  it('keeps a table inside the column, scrolling sideways within its own region', () => {
    expect(rule('.lb-msg .md-table-wrap')).toMatch(/overflow-x:\s*auto/)
    expect(rule('.lb-msg .md-table-wrap')).toMatch(/max-width:\s*100%/)
  })

  it.each(['.lb-file', '.lb-reply', '.lb-topic', '.lb-chip', '.lb-sort', '.lb-crumbs a', '.lb-more', '.lb-month'])('%s is a full-size tap target', (selector) => {
    expect(rule(selector), selector).toMatch(/min-height:\s*var\(--tap\)/)
  })

  it.each(['.lb-name', '.lb-body', '.lb-reply-text', '.lb-embed', '.lb-topic-title', '.lb-topic-latest', '.lb-tag', '.lb-post-title', '.lb-crumb-here'])('%s keeps a right-to-left override in its own block', (selector) => {
    expect(rule(selector), selector).toMatch(/unicode-bidi:\s*isolate/)
  })

  it('wraps long words and addresses rather than stretching the page', () => {
    for (const selector of ['.lb-name', '.lb-body', '.lb-file', '.lb-embed', '.lb-topic-title', '.lb-topic-latest', '.lb-tag', '.lb-post-title', '.lb-crumb-here']) expect(rule(selector), selector).toMatch(/overflow-wrap:\s*anywhere/)
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

  it('blurs a spoiler picture, clips the blur to the picture, and puts the word over it', () => {
    expect(rule('.lb-blurred')).toMatch(/filter:\s*blur\(/)
    expect(rule('.lb-spoiler-image')).toMatch(/overflow:\s*hidden/)
    expect(rule('.lb-spoiler-image')).toMatch(/cursor:\s*pointer/)
    expect(rule('.lb-spoiler-image')).toMatch(/position:\s*relative/)
    expect(rule('.lb-spoiler-tag')).toMatch(/position:\s*absolute/)
    expect(rule('.lb-spoiler-tag')).toMatch(/inset:\s*0/)
    expect(rule('.lb-spoiler-tag')).toMatch(/font-size:\s*var\(--text-md\)/)
    expect(rule('.lb-spoiler-thumb .lb-blurred')).toMatch(/filter:\s*blur\(/)
    expect(rule('.lb-spoiler-thumb .lb-spoiler-tag')).toMatch(/font-size:\s*var\(--text-xs\)/)
  })

  it('keeps the thumbnail in a tile that clips it, so a blur stays inside', () => {
    expect(rule('.lb-thumb-wrap')).toMatch(/overflow:\s*hidden/)
    expect(rule('.lb-thumb-wrap')).toMatch(/width:\s*4\.5rem/)
    expect(rule('.lb-thumb')).toMatch(/width:\s*100%/)
    expect(rule('.lb-thumb')).toMatch(/height:\s*100%/)
  })

  it('makes the initials that stand in for a picture a circle, in a message and in a row', () => {
    expect(rule('.lb-initials')).toMatch(/display:\s*flex/)
    expect(rule('.lb-initials')).toMatch(/align-items:\s*center/)
    expect(rule('.lb-initials')).toMatch(/justify-content:\s*center/)
    expect(rule('.lb-poster')).toMatch(/border-radius:\s*var\(--radius-pill\)/)
    expect(rule('.lb-avatar')).toMatch(/border-radius:\s*var\(--radius-pill\)/)
  })

  it('rounds the avatar with the site\'s pill radius, and the boxes with its radii', () => {
    expect(rule('.lb-avatar')).toMatch(/border-radius:\s*var\(--radius-pill\)/)
    expect(rule('.lb-article')).toMatch(/border-radius:\s*var\(--radius-md\)/)
    expect(rule('.lb-reaction')).toMatch(/border-radius:\s*var\(--radius-pill\)/)
  })

  it('keeps the date rail inside its own box on a phone, scrolling sideways, and sticks it at the side from 900px', () => {
    expect(rule('.lb-rail')).toMatch(/overflow-x:\s*auto/)
    expect(css).toMatch(/@media \(min-width: 900px\) \{[^@]*\.lb-rail \{[^}]*position:\s*sticky/)
  })

  it('leaves the rail where the page puts it on a phone (before the thread), and moves it to the right column from 900px with the grid, not with order', () => {
    // The rail comes first in the page, so a keyboard meets it first: nothing here reorders it.
    expect(rule('.lb-rail')).not.toMatch(/\border\s*:/)
    const wide = /@media \(min-width: 900px\) \{([^@]*)\}\s*(?:@media|$)/.exec(withoutComments)?.[1] ?? ''
    expect(wide).not.toMatch(/\border\s*:/)
    expect(wide).toMatch(/\.lb-thread \{[^}]*grid-column:\s*1[^}]*grid-row:\s*1/)
    expect(wide).toMatch(/\.lb-rail \{[^}]*grid-column:\s*2[^}]*grid-row:\s*1/)
  })

  it.each(['.lb-act', '.lb-unedit'])('%s, a button on a message or in the composer, is a full-size tap target', (selector) => {
    expect(rule(selector), selector).toMatch(/min-height:\s*var\(--tap\)/)
  })

  it('sizes the words of what is written on the site, and what is on its way, from the ramp', () => {
    for (const selector of ['.lb-site-tag', '.lb-act', '.lb-locked', '.lb-editing-text', '.lb-dead-pictures', '.lb-spoiled-picture', '.lb-unedit']) {
      expect(rule(selector), selector).toMatch(/font-size:\s*var\(--text-(?:xs|sm|md|base)\)/)
    }
    expect(css).toMatch(/\.lb-state,\s*\.lb-action-error\s*\{[^}]*font-size:\s*var\(--text-sm\)/)
  })

  it('greys what is on its way, and lays a reply on its way out as a message', () => {
    expect(rule('.lb-pending')).toMatch(/opacity:\s*0\.\d+/)
    expect(rule('.lb-outgoing')).toMatch(/grid-template-columns:\s*2\.5rem minmax\(0,\s*1fr\)/)
  })

  it('docks the composer at the end of the page on a phone, and keeps it in view at the foot of the window from 900px, scrolling within itself', () => {
    expect(rule('.lb-dock')).not.toMatch(/position:/)
    const wide = [...withoutComments.matchAll(/@media \(min-width: 900px\) \{([\s\S]*?\n)\}/g)].map((m) => m[1]).join('')
    expect(wide).toMatch(/\.lb-dock \{[^}]*position:\s*sticky[^}]*bottom:\s*0[^}]*max-height:\s*50vh[^}]*overflow-y:\s*auto/)
  })

  it('has no hover rule outside the real-pointer media query: nothing depends on hover', () => {
    expect(css).toContain(':hover')
    expect(withoutHoverMedia(css)).not.toContain(':hover')
  })

  it('has no animation or transition of its own', () => {
    expect(withoutComments).not.toMatch(/\b(?:animation|transition)\b/)
  })
})
