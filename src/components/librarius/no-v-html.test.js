import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The Librarius shows what Discord sends (post titles, message text, names, link addresses, embeds), so all of it must only
// ever be shown by normal Vue interpolation, never turned into markup (`v-html`, `innerHTML` and friends). This scans the
// area's source (not tests) and also checks that it can actually find a violation, so it cannot pass by looking nowhere.
// Same guard as the Reliquarium gallery's.
const SRC = fileURLToPath(new URL('../../', import.meta.url))
const SCANNED = ['components/librarius', 'lib/librarius', 'stores/librarius.js']
const SINKS = ['v-html', 'innerHTML', 'outerHTML', 'insertAdjacentHTML']

const sourceFilesUnder = (path) => {
  if (!existsSync(path)) return []
  if (statSync(path).isFile()) return /\.(vue|js)$/.test(path) && !/\.test\.js$/.test(path) ? [path] : []
  return readdirSync(path).flatMap((name) => sourceFilesUnder(join(path, name)))
}
const violations = (paths) =>
  paths.flatMap((file) => {
    const text = readFileSync(file, 'utf8')
    return SINKS.filter((sink) => text.includes(sink)).map((sink) => `${file}: ${sink}`)
  })

let scratch
afterEach(() => scratch && rmSync(scratch, { recursive: true, force: true }))

describe('no raw markup in the Librarius', () => {
  it('finds nothing in the area', () => {
    const files = SCANNED.flatMap((p) => sourceFilesUnder(join(SRC, p)))
    expect(files.length).toBeGreaterThanOrEqual(8) // it is looking at real files: the components, the lib and the store
    expect(files.some((f) => f.endsWith('PostPage.vue'))).toBe(true)
    expect(files.some((f) => f.endsWith('TopicList.vue'))).toBe(true)
    expect(files.some((f) => f.endsWith('LibMessage.vue'))).toBe(true)
    expect(files.some((f) => f.endsWith('render.js'))).toBe(true)
    expect(files.some((f) => f.endsWith('stores/librarius.js'))).toBe(true)
    expect(violations(files)).toEqual([])
  })

  it('would find a violation if there were one', () => {
    scratch = mkdtempSync(join(tmpdir(), 'lb-guard-'))
    for (const sink of SINKS) writeFileSync(join(scratch, `${sink}.vue`), `<template><p ${sink}="x" /></template>`)
    writeFileSync(join(scratch, 'clean.vue'), '<template><p>{{ text }}</p></template>')
    const found = violations(sourceFilesUnder(scratch))
    expect(found).toHaveLength(SINKS.length)
    expect(found.join('\n')).not.toContain('clean.vue')
  })
})
