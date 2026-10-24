import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Text in the Deathwatch area comes from documents the Watch Commander types, so it must only ever be shown
// by normal Vue interpolation, never turned into markup (`v-html`, `innerHTML` and friends). The old site
// built its pages from innerHTML strings; this guard keeps that out of the port. It scans the area's source
// (not tests) and also checks that it can actually find a violation, so it cannot pass by looking nowhere.
const SRC = fileURLToPath(new URL('../../', import.meta.url))
const SCANNED = [
  'components/deathwatch',
  'views/deathwatch',
  'lib/deathwatch',
  'stores/deathwatch.js',
  'components/company/DeathwatchBanner.vue',
]
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

describe('no raw markup in the Deathwatch area', () => {
  it('finds nothing in the area', () => {
    const files = SCANNED.flatMap((p) => sourceFilesUnder(join(SRC, p)))
    expect(files.length).toBeGreaterThan(0) // it is looking at real files
    expect(violations(files)).toEqual([])
  })

  it('would find a violation if there were one', () => {
    scratch = mkdtempSync(join(tmpdir(), 'dw-guard-'))
    for (const sink of SINKS) writeFileSync(join(scratch, `${sink}.vue`), `<template><p ${sink}="x" /></template>`)
    writeFileSync(join(scratch, 'clean.vue'), '<template><p>{{ text }}</p></template>')
    const found = violations(sourceFilesUnder(scratch))
    expect(found).toHaveLength(SINKS.length)
    expect(found.join('\n')).not.toContain('clean.vue')
  })
})
