import { describe, it, expect } from 'vitest'
import { snapName, snapFile, decodeDataUrl, listRefs, forgeDevPlugin } from './lib/forge-dev-plugin.mjs'

describe('snapName', () => {
  it('keeps letters, digits, dash and underscore and nothing else', () => {
    expect(snapName('hero phase 0.42')).toBe('hero-phase-0-42')
    expect(snapName('../../etc/passwd')).toBe('etc-passwd')
    expect(snapName('')).toBe('snap')
    expect(snapName(undefined)).toBe('snap')
    expect(snapName('x'.repeat(100))).toHaveLength(60)
  })
})

describe('snapFile', () => {
  it('stamps the name with a compact UTC time', () => {
    expect(snapFile('hero', new Date('2026-11-07T18:04:05.123Z'))).toBe('hero-20261107T180405.png')
  })
})

describe('decodeDataUrl', () => {
  it('decodes a PNG data URL and refuses anything else', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    expect(decodeDataUrl('data:image/png;base64,' + png.toString('base64'))).toEqual(png)
    expect(() => decodeDataUrl('data:text/html;base64,PGI+')).toThrow(/PNG/)
    expect(() => decodeDataUrl('')).toThrow(/PNG/)
  })
})

describe('listRefs', () => {
  it('is empty when the folder is missing', () => {
    expect(listRefs('/no/such/root')).toEqual([])
  })
})

describe('forgeDevPlugin', () => {
  it('runs only under the dev server', () => {
    expect(forgeDevPlugin().apply).toBe('serve')
  })
})
