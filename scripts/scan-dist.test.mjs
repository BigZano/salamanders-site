import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanDir, sentinelsFrom } from './scan-dist.mjs'
import { writeFixture, SENTINEL } from './archive-fixture.mjs'

const K = (n) => '"' + n + '":'
let d
beforeEach(async () => {
  d = await mkdtemp(join(tmpdir(), 'dist-'))
  await mkdir(join(d, 'archive'), { recursive: true })
  await mkdir(join(d, 'assets'), { recursive: true })
})

describe('scanDir', () => {
  it('a clean build (ciphertext + normal assets) passes', async () => {
    await writeFile(join(d, 'archive', 'a'.repeat(32) + '.bin'), 'LAR\u0001xxxx')
    await writeFile(join(d, 'assets', 'hero-abc.png'), '\u0089PNG....')
    await writeFile(join(d, 'assets', 'index.js'), 'forum.available_tags.map(t=>t)')
    expect(await scanDir(d)).toEqual([])
  })
  it.each([
    ['plaintext PNG under archive/', 'archive/x.png', '\u0089PNG\r\n'],
    ['plaintext GIF under archive/', 'archive/x.gif', 'GIF89a'],
    ['plaintext JSON under archive/', 'archive/x.bin', '{"a":1}'],
    ['a non-opaque name under archive/', 'archive/emoji-1.bin', 'LAR\u0001'],
    ['export JSON anywhere', 'assets/data.json', `{${K('guild' + '_id')}"1",${K('mention' + '_roles')}[]}`],
    ['export JSON inlined in a bundle', 'assets/index.js', `x=${JSON.stringify(`${K('available' + '_tags')}[],${K('applied' + '_tags')}[]`)}`],
    ['legacy plaintext dirs copied from public/', 'accolades/emoji-1.png', 'x'],
  ])('flags %s', async (_, rel, body) => {
    await mkdir(join(d, rel, '..'), { recursive: true })
    await writeFile(join(d, rel), body, 'latin1')
    expect((await scanDir(d)).length).toBeGreaterThan(0)
  })
  it('flags local sentinels (content strings from the real export)', async () => {
    await writeFile(join(d, 'assets', 'index.js'), `x="${SENTINEL}-accolades"`)
    expect(await scanDir(d, { sentinels: [`${SENTINEL}-accolades`] })).toHaveLength(1)
  })
  it('sentinelsFrom samples thread names, message ids, and asset file names from an export', async () => {
    const exp = await mkdtemp(join(tmpdir(), 'exp-'))
    await writeFixture(exp)
    const s = await sentinelsFrom(exp)
    expect(s).toEqual(expect.arrayContaining(['Fixture ToC', '100000000000000011', 'emoji-fixture.png']))
    expect(s).not.toContain('1322056087792521269') // guild id is public
  })
  it('drops sentinels that already appear in public source (generic names are not leaks)', async () => {
    const exp = await mkdtemp(join(tmpdir(), 'exp-'))
    await writeFixture(exp)
    const s = await sentinelsFrom(exp, { publicText: 'const pages = ["Fixture Ranks"]' })
    expect(s).not.toContain('Fixture Ranks')
    expect(s).toContain('Fixture ToC')
  })
})
