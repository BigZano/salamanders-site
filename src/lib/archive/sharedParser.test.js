import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// The site bundles server/src/librariusMarkdown.js (through ./markdown.js) so the Archive, the Librarius and the composer
// read Discord's text the way the server does. An import there would drag a server module (pg, node:crypto, a secret)
// into the browser bundle, or break the build, so the parser must stay free of imports and requires.
describe('the markdown parser the site shares with the server', () => {
  const source = readFileSync(new URL('../../../server/src/librariusMarkdown.js', import.meta.url), 'utf8')

  it('is the file markdown.js hands on, and nothing else is in markdown.js', () => {
    const facade = readFileSync(new URL('./markdown.js', import.meta.url), 'utf8')
    expect(facade.trim()).toBe("export * from '../../../server/src/librariusMarkdown.js'")
    expect(source).toContain('export function parse(')
    expect(source).toContain('export function parseInline(')
    expect(source).toContain('export function plainText(')
    expect(source).toContain('export function walk(')
  })

  it('has no import or require lines', () => {
    const lines = source.split(/\r?\n/)
    expect(lines.filter((line) => /^\s*import[\s{*'"(]/.test(line))).toEqual([])
    expect(lines.filter((line) => line.includes('require('))).toEqual([])
    expect(source).not.toMatch(/\bimport\(/)
  })
})
