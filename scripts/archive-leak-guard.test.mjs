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
    'archive-export/legacy-accolades.json',
    'legacy-accolades.json', // a snapshot written with --out somewhere not ignored
    'restore/legacy-accolades.json', // `unseal <dest>` into a folder of the operator's choosing
    'tmp/Legacy-Accolades.backup.JSON',
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
    'scripts/snapshot-legacy-accolades.mjs',
    'src/lib/archive/legacy.js',
    'docs/superpowers/specs/2026-10-16-legacy-accolades-design.md',
    'docs/superpowers/specs/2026-09-24-legion-archive-design.md',
    'public/favicon.svg',
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

// The Deathwatch tracker keeps real names in the server's database only. Everything that can carry them out of
// it (the Manage pages' "Download backup" file, the old site's data file, backups and config, the .7z archives it
// was handed over in) must never reach the public repo.
describe('checkPath: Deathwatch tracker data', () => {
  it.each([
    'deathwatch-backup-2026-10-24.json', // the Manage pages' "Download backup" file
    'Downloads/deathwatch-backup-2026-10-16.json', // the old site's, same name
    'DEATHWATCH-BACKUP-2026-10-24.JSON', // case-insensitive filesystems (Windows host)
    'data/deathwatch-data.json', // the old site's live data file
    'dist/data/deathwatch-data.json',
    'data/backups/deathwatch-data-2026-10-16.json',
    'data-backup/1.json', // its rolling backups
    'deathwatch-tracker/data-backup/7.json',
    'config.php', // its config held the old shared passwords
    'deathwatch-tracker/dist/config.php',
    'Config.PHP',
    'dist.7z', // the archives it was handed over in
    'deathwatch-tracker.7z',
    'Downloads/DIST.7Z',
  ])('blocks %s', (p) => expect(checkPath(p)).toMatch(/^Deathwatch data/))

  it.each([
    'config.example.php', // the template, with no passwords
    'old-config.php', // only a file named exactly config.php is the real one
    'src/lib/deathwatch/fixtureData.js',
    'src/lib/deathwatch/download.js',
    'src/lib/deathwatch/deathwatch-data.js', // source, not a JSON dump
    'src/views/deathwatch/pages/manage/manage.vue',
    'server/src/deathwatchStore.js',
    'docs/handoff/2026-10-20-deathwatch-contributing.md',
    'docs/handoff/deathwatch-backup-restore.md', // a note about backups is not a backup
    'predeathwatch-backup-1.json', // the name must start the file name
    'src/metadata-backup/restore.js', // only a folder named exactly data-backup
    'docs/notes.7z.md', // only a file that ends in .7z
  ])('allows %s', (p) => expect(checkPath(p)).toBeNull())
})

// The guild's member list is held by Discord and asked for live by the server; no copy of it belongs in the repo.
describe('checkPath: the guild member list', () => {
  it.each([
    'src/data/discord-members.json', // where the role sync used to write it
    'discord-members.json',
    'public/data/discord-members.json',
    'SRC/DATA/DISCORD-MEMBERS.JSON', // case-insensitive filesystems (Windows host)
    'src/data/discord-members.2026-10-30.json', // a dated copy
  ])('blocks %s', (p) => expect(checkPath(p)).toMatch(/^member list must never be committed/))

  it.each([
    'src/data/companies.json',
    'server/src/membership.js',
    'scripts/discord-members.mjs', // only a .json file is a list
    'docs/discord-members.json.md',
    'src/data/prediscord-members.json', // the name must start the file name
  ])('allows %s', (p) => expect(checkPath(p)).toBeNull())
})

describe('checkContent: Deathwatch tracker dumps', () => {
  // Kill Team document keys, assembled at runtime like the Discord ones above.
  const RO = K('r' + 'o')
  const KI = K('k' + 'i')
  const KW = K('k' + 'w')

  it('blocks text carrying two or more Kill Team keys, whatever the file is called', () => {
    expect(checkContent('my-notes.txt', `{"teams":[{${RO}[],${KI}[]}]}`)).toMatch(/Deathwatch tracker dump \(2 Kill Team keys/)
    expect(checkContent('x.json', `${KW}{} ${RO}[]`)).toMatch(/Deathwatch/)
    expect(checkContent('x.json', `${RO}[] ${KI}[] ${KW}{}`)).toMatch(/\(3 Kill Team keys/)
  })
  it('names the file so the problem can be found', () => {
    expect(checkContent('where/it/is.txt', `${RO} ${KI}`)).toContain('where/it/is.txt')
  })
  it('allows a single key, and code that spells the keys without quotes', () => {
    expect(checkContent('x.md', `a ${RO} field`)).toBeNull()
    expect(checkContent('m.js', 'const t = { id: 1, ro: [], ki: [], kw: {} }; t.ro.push(n)')).toBeNull()
  })
})
