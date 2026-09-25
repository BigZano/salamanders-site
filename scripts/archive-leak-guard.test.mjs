import { describe, it, expect } from 'vitest'
import { checkPath, checkContent, checkHash } from './archive-leak-guard.mjs'

// Signatures are assembled at runtime so this file never contains them
// literally (the guard would otherwise block committing its own tests).
const K = (name) => '"' + name + '":'
const GUILD = K('guild' + '_id')
const MENTION_ROLES = K('mention' + '_roles')
const TAGS = K('available' + '_tags')

describe('checkPath', () => {
  it.each([
    'archive-export/accolades/data/forum.json',
    'archive-export/.env',
    'public/archive/0123abcd.bin',
    'public/archive-e2e/x.bin',
    'e2e/.archive/lock.json',
    'public/accolades/emoji-1.png',
    'public/rank-requirements/att-1.png',
    'src/data/accolades/index.json',
    'src/data/rank-requirements/threads/1.json',
    'nested/archive-export/x',
    'ARCHIVE-EXPORT/x', // case-insensitive filesystems (Windows host)
    'archive-export-restored/accolades/assets/att-1.png', // unseal recovery output
    'archive-export.bak/link-fixes.json',
  ])('blocks %s', (p) => expect(checkPath(p)).toMatch(/archive/i))

  it.each([
    'src/lib/archive/crypto.js',
    'scripts/archive-leak-guard.mjs',
    'archive.lock.json',
    'docs/superpowers/specs/2026-09-24-legion-archive-design.md',
    'public/favicon.svg',
    'src/data/discord-members.json',
    'src/components/archive/ArchiveGate.vue',
  ])('allows %s', (p) => expect(checkPath(p)).toBeNull())

  it('rejects non-string input rather than allowing it', () => {
    expect(checkPath(undefined)).toMatch(/invalid/i)
    expect(checkPath('')).toMatch(/invalid/i)
  })
})

describe('checkContent', () => {
  it('blocks text carrying two or more Discord export JSON signatures', () => {
    expect(checkContent('x.json', `{${GUILD}"1",${MENTION_ROLES}[]}`)).toMatch(/export/i)
    expect(checkContent('x.js', `a ${TAGS} b ${GUILD}`)).toMatch(/export/i)
  })
  it('allows a single signature (e.g. docs mentioning one field)', () => {
    expect(checkContent('x.md', `the ${GUILD} field`)).toBeNull()
  })
  it('allows ordinary code that uses the fields by property access', () => {
    expect(checkContent('m.js', 'forum.available_tags.map(t => t.guild_id)')).toBeNull()
  })
  it('blocks stray sealed files anywhere; ordinary images pass', () => {
    expect(checkContent('public/x.bin', 'LAR\u0001rest')).toMatch(/sealed/i)
    expect(checkContent('src/assets/hero.png', '\u0089PNG')).toBeNull()
  })
})

describe('checkHash', () => {
  const known = new Set(['a'.repeat(64)])
  it('blocks a file whose bytes equal an export asset, whatever its name', () => {
    expect(checkHash('src/assets/renamed.png', 'a'.repeat(64), known)).toMatch(/export asset/i)
  })
  it('allows unknown hashes and works with an empty known set (CI)', () => {
    expect(checkHash('x.png', 'b'.repeat(64), known)).toBeNull()
    expect(checkHash('x.png', 'a'.repeat(64), new Set())).toBeNull()
  })
})
