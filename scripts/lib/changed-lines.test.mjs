import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { changedRanges, configText, diffArgs, mutatePatterns, ownTestFiles, parseArgs, runOptions } from './changed-lines.mjs'

// Every path here is invented, and so is every file in the throwaway repositories below.

const modified = (path) => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n`
const ranges = (entries) => new Map(entries)

describe('changedRanges: what a diff added', () => {
  it('gives the added lines of a changed file as ranges of the new file, merging the ones that touch', () => {
    const diff = `${modified('src/a.js')}@@ -2 +2 @@\n-b\n+B\n@@ -3,0 +4,2 @@\n+d\n+e\n@@ -9 +11 @@ function f() {\n-x\n+X\n`
    expect(changedRanges(diff, ['src/a.js'])).toEqual(ranges([['src/a.js', [[2, 2], [4, 5], [11, 11]]]]))
    const touching = `${modified('src/a.js')}@@ -2 +2 @@\n-b\n+B\n@@ -2,0 +3,2 @@\n+c\n+d\n`
    expect(changedRanges(touching, ['src/a.js'])).toEqual(ranges([['src/a.js', [[2, 4]]]]))
  })

  it('reads a count that is left out as one line', () => {
    expect(changedRanges(`${modified('a.js')}@@ -7 +7 @@\n-a\n+b\n`, ['a.js'])).toEqual(ranges([['a.js', [[7, 7]]]]))
  })

  it('takes every line of a new file', () => {
    const diff = 'diff --git a/n.js b/n.js\nnew file mode 100644\nindex 0000000..3333333\n--- /dev/null\n+++ b/n.js\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n'
    expect(changedRanges(diff, ['n.js'])).toEqual(ranges([['n.js', [[1, 3]]]]))
  })

  it('gives nothing for a deleted file, even one the list names', () => {
    const diff = 'diff --git a/gone.js b/gone.js\ndeleted file mode 100644\nindex 4444444..0000000\n--- a/gone.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n'
    expect(changedRanges(diff, ['gone.js'])).toEqual(new Map())
  })

  it('gives nothing for a hunk that only deletes, and still counts the lines of the hunks around it', () => {
    const diff = `${modified('a.js')}@@ -1 +1 @@\n-a\n+A\n@@ -3,2 +2,0 @@\n-c\n-d\n@@ -8 +6 @@\n-h\n+H\n`
    expect(changedRanges(diff, ['a.js'])).toEqual(ranges([['a.js', [[1, 1], [6, 6]]]]))
    expect(changedRanges(`${modified('a.js')}@@ -3,2 +2,0 @@\n-c\n-d\n`, ['a.js'])).toEqual(new Map())
  })

  it('names a renamed file by its new name', () => {
    const diff =
      'diff --git a/old.js b/new.js\nsimilarity index 85%\nrename from old.js\nrename to new.js\nindex 5555555..6666666 100644\n--- a/old.js\n+++ b/new.js\n@@ -3 +3 @@\n-c\n+C\n'
    expect(changedRanges(diff, ['old.js', 'new.js'])).toEqual(ranges([['new.js', [[3, 3]]]]))
    expect(changedRanges(diff, ['old.js'])).toEqual(new Map())
  })

  it('gives nothing for a rename with no change, a mode change or a binary file, and reads the file after each', () => {
    const diff = [
      'diff --git a/r.js b/s.js\nsimilarity index 100%\nrename from r.js\nrename to s.js\n',
      'diff --git a/m.js b/m.js\nold mode 100644\nnew mode 100755\n',
      'diff --git a/p.png b/p.png\nindex 7777777..8888888 100644\nBinary files a/p.png and b/p.png differ\n',
      `${modified('a.js')}@@ -1 +1 @@\n-a\n+A\n`,
    ].join('')
    expect(changedRanges(diff, ['r.js', 's.js', 'm.js', 'p.png', 'a.js'])).toEqual(ranges([['a.js', [[1, 1]]]]))
  })

  it('leaves out the files the list does not name', () => {
    const diff = `${modified('a.js')}@@ -1 +1 @@\n-a\n+A\n${modified('b.js')}@@ -1 +1 @@\n-b\n+B\n${modified('docs/c.md')}@@ -1 +1 @@\n-c\n+C\n`
    expect(changedRanges(diff, ['b.js', 'not-in-the-diff.js'])).toEqual(ranges([['b.js', [[1, 1]]]]))
    expect(changedRanges(diff, [])).toEqual(new Map())
    // The list names whole paths: a file whose path only ends or starts with a listed one is another file.
    expect(changedRanges(diff, ['src/a.js', '.js', 'a', 'docs'])).toEqual(new Map())
  })

  it('reads past a missing newline at the end of either side', () => {
    const diff = `${modified('a.js')}@@ -3 +3,2 @@\n-c\n\\ No newline at end of file\n+c\n+d\n\\ No newline at end of file\n${modified('b.js')}@@ -1 +1 @@\n-a\n+b\n`
    expect(changedRanges(diff, ['a.js', 'b.js'])).toEqual(ranges([['a.js', [[3, 4]]], ['b.js', [[1, 1]]]]))
  })

  it('reads a path with a space in it, which git ends with a tab', () => {
    const diff = 'diff --git a/sp ace.js b/sp ace.js\nindex 1111111..2222222 100644\n--- a/sp ace.js\t\n+++ b/sp ace.js\t\n@@ -2 +2 @@\n-b\n+B\n'
    expect(changedRanges(diff, ['sp ace.js'])).toEqual(ranges([['sp ace.js', [[2, 2]]]]))
  })

  it.each([
    ['a quote', '"b/qu\\"ote.js"', 'qu"ote.js'],
    ['a backslash', '"b/back\\\\slash.js"', 'back\\slash.js'],
    ['a tab', '"b/tab\\tx.js"', 'tab\tx.js'],
    ['a line break', '"b/line\\nbreak.js"', 'line\nbreak.js'],
    ['the other control escapes', '"b/\\a\\b\\v\\f\\r.js"', '\x07\b\v\f\r.js'],
    ['a letter git wrote as octal bytes', '"b/caf\\303\\251.js"', 'café.js'],
    ['a letter git wrote as it is', '"b/café \\"q\\".js"', 'café "q".js'],
    ['bytes that are not UTF-8', '"b/x\\377.js"', 'x�.js'],
  ])('reads a path that git quoted, holding %s', (_, quoted, path) => {
    const diff = `diff --git a/x b/x\n--- a/x\n+++ ${quoted}\n@@ -1 +1 @@\n-a\n+b\n`
    expect(changedRanges(diff, [path])).toEqual(ranges([[path, [[1, 1]]]]))
  })

  it('reads a diff whose lines end in CRLF as it reads one whose lines end in LF', () => {
    const lf = `${modified('crlf.js')}@@ -1,2 +1,3 @@\n-a\r\n-b\r\n+a\r\n+b\r\n+c\r\n\\ No newline at end of file\n`
    const crlf = lf.replaceAll('\n', '\r\n')
    expect(changedRanges(crlf, ['crlf.js'])).toEqual(ranges([['crlf.js', [[1, 3]]]]))
    expect(changedRanges(lf, ['crlf.js'])).toEqual(changedRanges(crlf, ['crlf.js']))
  })

  it('counts context lines, an empty one included, but takes only the added ones', () => {
    const diff = `${modified('a.js')}@@ -4,5 +4,6 @@ x\n d\n-e\n+E\n+F\n\n g\n h\n@@ -20,2 +21,2 @@\n t\n-u\n+U\n`
    expect(changedRanges(diff, ['a.js'])).toEqual(ranges([['a.js', [[5, 6], [22, 22]]]]))
  })

  it('takes added or removed lines that look like headers for lines, not for the start of another file', () => {
    const diff = `${modified('a.js')}@@ -1,3 +1,4 @@\n--- a/evil.js\n-diff --git a/evil.js b/evil.js\n-@@ -1 +1 @@\n++++ b/evil.js\n+@@ -1 +900 @@\n+diff --git a/evil.js b/evil.js\n+\\ No newline at end of file\n`
    expect(changedRanges(diff, ['a.js', 'evil.js'])).toEqual(ranges([['a.js', [[1, 4]]]]))
  })

  it('merges what two sections of one file add, whatever their order', () => {
    const diff = `${modified('a.js')}@@ -5,0 +6,2 @@\n+f\n+g\n${modified('a.js')}@@ -1 +1,3 @@\n-a\n+a\n+b\n+c\n@@ -3,0 +7 @@\n+h\n`
    expect(changedRanges(diff, ['a.js'])).toEqual(ranges([['a.js', [[1, 3], [6, 7]]]]))
  })

  it('gives nothing for an empty diff', () => {
    expect(changedRanges('', ['a.js'])).toEqual(new Map())
    expect(changedRanges('\n', ['a.js'])).toEqual(new Map())
  })

  it('takes a path named like an Object property for a path', () => {
    const diff = `${modified('__proto__')}@@ -1 +1 @@\n-a\n+b\n${modified('constructor')}@@ -1 +1 @@\n-a\n+b\n`
    expect(changedRanges(diff, ['__proto__', 'constructor'])).toEqual(ranges([['__proto__', [[1, 1]]], ['constructor', [[1, 1]]]]))
  })
})

describe('changedRanges: what it refuses', () => {
  it.each([
    ['a diff that is not text', 7],
    ['no diff', undefined],
    ['a list of lines', ['@@ -1 +1 @@']],
  ])('refuses %s', (_, diff) => {
    expect(() => changedRanges(diff, [])).toThrow(TypeError)
    expect(() => changedRanges(diff, [])).toThrow('The diff must be text.')
  })

  it.each([
    ['no list', undefined],
    ['a list that is a string', 'a.js'],
    ['a list holding a number', ['a.js', 7]],
    ['a list holding an empty path', ['']],
    ['a glob', ['src/**/*.js']],
    ['a question mark', ['a?.js']],
    ['a character class', ['a[bc].js']],
    ['a brace list', ['{a,b}.js']],
    ['a negation', ['!a.js']],
    ['a path with a mutation range', ['a.js:1-5']],
    ['a path with a column range', ['a.js:1:2-5:3']],
  ])('refuses a mutate list with %s, since it matches plain paths only', (_, mutate) => {
    expect(() => changedRanges('', mutate)).toThrow(TypeError)
    expect(() => changedRanges('', mutate)).toThrow(/^mutate must be a list of plain file paths/)
  })

  it.each([
    ['a hunk header it cannot read', '@@ garbage @@'],
    ['a hunk header with a letter for a line', '@@ -1 +x @@'],
    ['a hunk header with nothing after the second @@ but a letter', '@@ -1 +1 @@x'],
    ['a hunk header with no space after the old side', '@@ -1+1 @@'],
    ['a hunk header with no space before the new side', '@@ -1 1 @@'],
    ['a combined diff hunk', '@@@ -1 -1 +1 @@@'],
    ['a line number past the safe integers', '@@ -1 +9007199254740993 @@'],
    ['an old line number past the safe integers', '@@ -9007199254740993 +1 @@'],
    ['a count past the safe integers', '@@ -1 +1,9007199254740993 @@'],
    ['an old count past the safe integers', '@@ -1,9007199254740993 +1 @@'],
    ['added lines that start at line 0', '@@ -0,0 +0 @@'],
  ])('throws SyntaxError for %s', (_, header) => {
    // The hunk is otherwise whole, so only the header can be what is refused.
    const diff = `${modified('a.js')}${header}\n-a\n+b\n`
    expect(() => changedRanges(diff, ['a.js'])).toThrow(SyntaxError)
    expect(() => changedRanges(diff, ['a.js'])).toThrow(/^Line 5 of the diff is not a hunk header git writes\.$/)
  })

  it.each([
    ['a hunk before any file', '@@ -1 +1 @@\n-a\n+b\n'],
    ['a hunk after a file section that named no new file', 'diff --git a/p.png b/p.png\nBinary files a/p.png and b/p.png differ\n@@ -1 +1 @@\n-a\n+b\n'],
    ['added lines in a file that was deleted', 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ /dev/null\n@@ -1 +1 @@\n-a\n+b\n'],
    ['a diff that ends inside a hunk', `${modified('a.js')}@@ -1 +1,3 @@\n-a\n+a\n+b\n`],
    // The newline that ends the text is not an empty context line that would make the hunk whole.
    ['a diff that ends inside a hunk where an empty line would fit', `${modified('a.js')}@@ -1,2 +1,2 @@\n a\n`],
    ['a diff that ends inside a hunk, in CRLF', `${modified('a.js')}@@ -1,2 +1,2 @@\n a\n`.replaceAll('\n', '\r\n')],
    ['more added lines than the hunk counted', `${modified('a.js')}@@ -1 +1 @@\n-a\n+a\n+b\n`],
    ['more removed lines than the hunk counted', `${modified('a.js')}@@ -1 +1 @@\n-a\n-b\n+a\n`],
    ['a removed line in a hunk that removes none', `${modified('a.js')}@@ -1,0 +2 @@\n-a\n+b\n`],
    ['an added line in a hunk that adds none', `${modified('a.js')}@@ -1 +0,0 @@\n+b\n-a\n`],
    ['a context line in a hunk that has room only for an added one', `${modified('a.js')}@@ -1,0 +2 @@\n a\n`],
    ['a context line in a hunk that has room only for a removed one', `${modified('a.js')}@@ -1 +0,0 @@\n a\n`],
    ['a line in a hunk that is none of the kinds', `${modified('a.js')}@@ -1 +1 @@\n-a\nxb\n`],
    ['an added line outside a hunk', `${modified('a.js')}+a\n`],
    ['a removed line outside a hunk', `${modified('a.js')}-a\n`],
    ['a context line outside a hunk', `${modified('a.js')} a\n`],
    ['a new path that does not start with b/', 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ a.js\n@@ -1 +1 @@\n-a\n+b\n'],
    ['a new path that is only the prefix', 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/\n@@ -1 +1 @@\n-a\n+b\n'],
    ['a quoted new path that is only the prefix', 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ "b/"\n@@ -1 +1 @@\n-a\n+b\n'],
    ['a quoted new path that does not start with b/', 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ "a.js"\n@@ -1 +1 @@\n-a\n+b\n'],
    ['a quote that is not closed', 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ "b/a.js\n@@ -1 +1 @@\n-a\n+b\n'],
    ['text after the closing quote', 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ "b/a.js"x\n@@ -1 +1 @@\n-a\n+b\n'],
    ['an escape git does not write', 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ "b/a\\q.js"\n@@ -1 +1 @@\n-a\n+b\n'],
    ['an octal escape of two digits', 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ "b/a\\30.js"\n@@ -1 +1 @@\n-a\n+b\n'],
    ['an octal escape past one byte', 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ "b/a\\400.js"\n@@ -1 +1 @@\n-a\n+b\n'],
    ['a backslash that ends the path', 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ "b/a.js\\"\n@@ -1 +1 @@\n-a\n+b\n'],
  ])('throws SyntaxError for %s', (_, diff) => {
    expect(() => changedRanges(diff, ['a.js'])).toThrow(SyntaxError)
  })
})

// --- Diffs written from a model, the way git writes them ---

// Paths of every kind git treats apart: plain, with a space (a tab after it), with what git quotes, and with letters it may
// write as they are or as octal bytes.
const PATHS = ['a.js', 'src/b.js', 'server/src/c d.js', 'q"uote.js', 'back\\slash.js', 'tab\tx.js', 'café.js', 'dir with space/日本.mjs', 'e\nf.js']
const ESCAPES = { '"': '\\"', '\\': '\\\\', '\x07': '\\a', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\v': '\\v', '\f': '\\f', '\r': '\\r' }

function quoted(path, octal) {
  let out = ''
  for (const ch of path) {
    if (ch in ESCAPES) out += ESCAPES[ch]
    else if (octal && ch.codePointAt(0) > 0x7e) out += [...Buffer.from(ch)].map((b) => `\\${b.toString(8).padStart(3, '0')}`).join('')
    else out += ch
  }
  return `"${out}"`
}

// How git names a file: quoted when the name holds what it quotes, as it is otherwise.
function gitName(name, octal) {
  return /["\\\x00-\x1f\x7f]/.test(name) || (octal && /[^\x00-\x7e]/.test(name)) ? quoted(name, octal) : name
}

// And on a --- or +++ line, where a name with a space that is not quoted ends with a tab.
function named(prefix, path, octal) {
  const name = gitName(`${prefix}${path}`, octal)
  return !name.startsWith('"') && path.includes(' ') ? `${name}\t` : name
}

// At least one line the same before each hunk, so that no two hunks' added lines touch (that case has its own test).
const segment = fc.record({
  same: fc.integer({ min: 1, max: 6 }),
  removed: fc.integer({ min: 0, max: 3 }),
  added: fc.integer({ min: 0, max: 3 }),
  context: fc.integer({ min: 0, max: 3 }),
})

const file = fc.record({
  kind: fc.constantFrom('modified', 'new', 'deleted', 'renamed'),
  segments: fc.array(segment, { maxLength: 6 }),
  newLines: fc.integer({ min: 1, max: 5 }),
  marks: fc.array(fc.boolean(), { maxLength: 30 }),
})

// One file's section of a diff, and the ranges of the lines it adds.
function render({ path, oldPath, kind, segments, newLines, marks }, octal) {
  const body = []
  const added = []
  let oldLine = 1
  let newLine = 1
  let mark = 0
  const noNewline = () => {
    if (marks[mark++]) body.push('\\ No newline at end of file')
  }
  if (kind === 'new') {
    body.push(`@@ -0,0 +1${newLines === 1 ? '' : `,${newLines}`} @@`)
    for (let i = 0; i < newLines; i++) body.push(`+new ${i}`)
    noNewline()
    added.push([1, newLines])
  } else if (kind === 'deleted') {
    const lines = Math.max(1, segments.length)
    body.push(`@@ -1${lines === 1 ? '' : `,${lines}`} +0,0 @@`)
    for (let i = 0; i < lines; i++) body.push(`-old ${i}`)
    noNewline()
  } else {
    for (const { same, removed, added: count, context } of segments) {
      oldLine += same
      newLine += same
      if (removed === 0 && count === 0) continue
      const around = Math.min(context, same)
      const oldCount = around + removed
      const newCount = around + count
      const oldStart = oldCount === 0 ? oldLine - 1 : oldLine - around
      const newStart = newCount === 0 ? newLine - 1 : newLine - around
      const side = (start, n) => (n === 1 ? `${start}` : `${start},${n}`)
      body.push(`@@ -${side(oldStart, oldCount)} +${side(newStart, newCount)} @@${marks[mark++] ? ' function context()' : ''}`)
      for (let i = 0; i < around; i++) body.push(marks[mark++] ? '' : ` same ${i}`)
      for (let i = 0; i < removed; i++) body.push(`-removed ${i}`)
      noNewline()
      for (let i = 0; i < count; i++) body.push(`+added ${i}`)
      noNewline()
      if (count > 0) added.push([newLine, newLine + count - 1])
      oldLine += removed
      newLine += count
    }
  }
  const from = kind === 'new' ? '/dev/null' : named('a/', oldPath, octal)
  const to = kind === 'deleted' ? '/dev/null' : named('b/', path, octal)
  const head = [`diff --git ${gitName(`a/${oldPath}`, octal)} ${gitName(`b/${path}`, octal)}`]
  if (kind === 'new') head.push('new file mode 100644')
  if (kind === 'deleted') head.push('deleted file mode 100644')
  if (kind === 'renamed') head.push('similarity index 90%', `rename from ${gitName(oldPath, octal)}`, `rename to ${gitName(path, octal)}`)
  // A rename or a change with nothing in it has no --- and +++ lines.
  if (body.length > 0) head.push('index 1111111..2222222 100644', `--- ${from}`, `+++ ${to}`)
  return { text: [...head, ...body].join('\n'), added: kind === 'deleted' ? [] : added }
}

describe('changedRanges: diffs written from a model', () => {
  it('gives back exactly the added lines of the files the list names, however git wrote the diff', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...PATHS), { minLength: 1, maxLength: PATHS.length }),
        fc.array(file, { minLength: PATHS.length, maxLength: PATHS.length }),
        fc.array(fc.boolean(), { minLength: PATHS.length, maxLength: PATHS.length }),
        fc.boolean(),
        fc.boolean(),
        (paths, files, listed, octal, crlf) => {
          const sections = paths.map((path, i) => render({ ...files[i], path, oldPath: files[i].kind === 'renamed' ? `old/${path}` : path }, octal))
          const text = sections.map((s) => `${s.text}\n`).join('')
          const mutate = [...paths.filter((_, i) => listed[i]), 'never/in/the/diff.js']
          const expected = new Map(
            paths.flatMap((path, i) => (listed[i] && sections[i].added.length > 0 ? [[path, sections[i].added]] : [])),
          )
          expect(changedRanges(crlf ? text.replaceAll('\n', '\r\n') : text, mutate)).toEqual(expected)
        },
      ),
      { numRuns: 400 },
    )
  })
})

describe('changedRanges: any text', () => {
  const LINES = [
    'diff --git a/a.js b/a.js',
    '--- a/a.js',
    '+++ b/a.js',
    '+++ b/b c.js\t',
    '+++ "b/q\\"x.js"',
    '+++ /dev/null',
    '--- /dev/null',
    '@@ -1 +1 @@',
    '@@ -0,0 +1,2 @@',
    '@@ -3,2 +2,0 @@',
    '@@ -1,2 +1,2 @@ ctx',
    '+a',
    '-a',
    ' a',
    '',
    '\\ No newline at end of file',
    'index 1..2 100644',
    'Binary files a/x and b/x differ',
  ]

  it('either throws SyntaxError or gives ranges that are whole, ordered and apart, for listed files only', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.constantFrom(...LINES), fc.string({ maxLength: 12 })), { maxLength: 30 }),
        fc.constantFrom('\n', '\r\n'),
        (lines, eol) => {
          let result
          try {
            result = changedRanges(lines.join(eol), ['a.js', 'b c.js', 'q"x.js'])
          } catch (err) {
            expect(err).toBeInstanceOf(SyntaxError)
            return
          }
          for (const [path, list] of result) {
            expect(['a.js', 'b c.js', 'q"x.js']).toContain(path)
            expect(list.length).toBeGreaterThan(0)
            list.forEach(([start, end], i) => {
              expect(Number.isSafeInteger(start) && Number.isSafeInteger(end)).toBe(true)
              expect(start).toBeGreaterThanOrEqual(1)
              expect(end).toBeGreaterThanOrEqual(start)
              if (i > 0) expect(start).toBeGreaterThan(list[i - 1][1] + 1)
            })
          }
        },
      ),
      { numRuns: 1000 },
    )
  })
})

// --- Against git itself ---

// A throwaway repository, run with none of the caller's git settings or hook variables: the pre-commit hook runs this suite
// with GIT_INDEX_FILE set, which would point these commands at the real repository's index.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'changed-lines-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=Invented', '-c', 'user.email=invented@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  const write = (path, text) => {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  git('-c', 'init.defaultBranch=main', 'init', '-q')
  return { dir, git, write, done: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('changedRanges: on what git writes', () => {
  it('reads the diff that diffArgs asks git for, whatever the git settings, for every hostile kind of path and change', () => {
    const r = repo()
    try {
      const lines = (n, word = 'line') => Array.from({ length: n }, (_, i) => `${word} ${i + 1}\n`).join('')
      r.write('sp ace.js', 'a\nb\nc\n')
      r.write('qu"ote.js', 'q\n')
      r.write('tab\tx.js', 'n\n')
      r.write('café.js', 'e\n')
      r.write('gone.js', 'del\nme\n')
      r.write('crlf.js', 'x\r\ny\r\n')
      r.write('ren.js', lines(8))
      r.write('src/deep.js', lines(10))
      r.git('add', '-A')
      r.git('commit', '-qm', 'base')
      const base = r.git('rev-parse', 'HEAD').trim()
      r.write('sp ace.js', 'a\nB\nc\nd')
      r.git('mv', 'ren.js', 'ren2.js')
      r.write('ren2.js', lines(8).replace('line 3\n', 'LINE 3\n'))
      r.write('qu"ote.js', 'Q\n')
      r.write('tab\tx.js', 'N\n')
      r.git('rm', '-q', 'gone.js')
      r.write('new.js', 'new\nfile\n')
      r.write('café.js', 'E\n')
      r.write('crlf.js', 'x\r\nY\r\nz\r\n')
      r.write('src/deep.js', lines(10).replace('line 2\n', '').replace('line 7\n', 'line 7\nadded\nadded\n'))
      r.git('add', '-A')
      r.git('commit', '-qm', 'change')
      // Settings a maintainer may have, each of which changes what plain `git diff` writes.
      const hostile = ['diff.noprefix=true', 'diff.mnemonicPrefix=true', 'color.ui=always', 'color.diff=always', 'diff.renames=false', 'core.quotePath=true', 'diff.context=5', 'diff.suppressBlankEmpty=true']
      const diff = r.git(...hostile.flatMap((setting) => ['-c', setting]), ...diffArgs(base, 'HEAD'))
      const all = ['sp ace.js', 'qu"ote.js', 'tab\tx.js', 'café.js', 'gone.js', 'crlf.js', 'ren.js', 'ren2.js', 'new.js', 'src/deep.js']
      expect(changedRanges(diff, all)).toEqual(
        new Map([
          ['café.js', [[1, 1]]],
          ['crlf.js', [[2, 3]]],
          ['new.js', [[1, 2]]],
          ['qu"ote.js', [[1, 1]]],
          ['ren2.js', [[3, 3]]],
          ['sp ace.js', [[2, 2], [4, 4]]],
          ['src/deep.js', [[7, 8]]],
          ['tab\tx.js', [[1, 1]]],
        ]),
      )
    } finally {
      r.done()
    }
  })

  it('asks for the diff between the two commits only, with no options a caller could slip in', () => {
    const args = diffArgs('0123abc', 'HEAD')
    expect(args.slice(-3)).toEqual(['0123abc', 'HEAD', '--'])
    expect(args).toContain('--unified=0')
    expect(() => diffArgs('-p', 'HEAD')).toThrow(TypeError)
    expect(() => diffArgs('0123abc', '--output=x')).toThrow(TypeError)
    expect(() => diffArgs('', 'HEAD')).toThrow(TypeError)
    expect(() => diffArgs('0123abc', 7)).toThrow(TypeError)
  })
})

describe('mutatePatterns', () => {
  it('writes one path:start-end pattern per range, the way Stryker reads a range of whole lines', () => {
    expect(mutatePatterns(new Map([['server/src/a b.js', [[3, 3], [7, 12]]], ['src/c.js', [[1, 400]]]]))).toEqual([
      'server/src/a b.js:3-3',
      'server/src/a b.js:7-12',
      'src/c.js:1-400',
    ])
    expect(mutatePatterns(new Map())).toEqual([])
  })

  it('gives every changed line once, in a pattern Stryker accepts (lines start at 1, and the first is not past the last)', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.constantFrom('a.js', 'b c.js'), fc.integer({ min: 1, max: 60 })), { maxLength: 40 }), (picks) => {
        const lines = new Map()
        for (const [path, line] of picks) lines.set(path, [...(lines.get(path) ?? []), line])
        let diff = ''
        for (const [path, list] of lines) {
          diff += modified(path)
          for (const line of [...new Set(list)].sort((a, b) => a - b)) diff += `@@ -${line},0 +${line} @@\n+x\n`
        }
        const seen = new Map()
        for (const pattern of mutatePatterns(changedRanges(diff, ['a.js', 'b c.js']))) {
          const [, path, start, end] = /^(.*):(\d+)-(\d+)$/.exec(pattern)
          expect(Number(start)).toBeGreaterThanOrEqual(1)
          expect(Number(start)).toBeLessThanOrEqual(Number(end))
          for (let line = Number(start); line <= Number(end); line++) seen.set(path, [...(seen.get(path) ?? []), line])
        }
        expect(seen).toEqual(new Map([...lines].map(([path, list]) => [path, [...new Set(list)].sort((a, b) => a - b)])))
      }),
      { numRuns: 300 },
    )
  })
})

describe('ownTestFiles', () => {
  const tracked = [
    'server/src/a.js',
    'server/src/a.test.js',
    'server/src/a.pg.test.js',
    'server/src/a.property.test.js',
    'server/src/ab.test.js',
    'server/src/xa.test.js',
    'server/src/a.js.test.js.bak',
    'server/src/a.test.mjs',
    'server/src/other/a.test.js',
    'server/src/a.d/x.test.js',
    'server/a.test.js',
    'scripts/check.mjs',
    'scripts/check.test.mjs',
    'scripts/lib/check.test.mjs',
    'top.js',
    'top.test.js',
    'src/stores/b.js',
    'src/stores/b.css',
    'src/stores/b.css.test.js',
    'src/lone.js',
    'src/lone.test.ts',
    'src/lone.spec.js',
  ]

  it('finds the test files beside each file that are named for it, and only those', () => {
    expect(ownTestFiles(['server/src/a.js', 'scripts/check.mjs', 'top.js', 'src/stores/b.js'], tracked)).toEqual({
      testFiles: [
        'scripts/check.test.mjs',
        'server/src/a.pg.test.js',
        'server/src/a.property.test.js',
        'server/src/a.test.js',
        'server/src/a.test.mjs',
        'src/stores/b.css.test.js',
        'top.test.js',
      ],
      without: [],
    })
  })

  it('names the files that have no test file of their own', () => {
    expect(ownTestFiles(['src/lone.js', 'server/src/a.js', 'src/missing.js'], tracked)).toEqual({
      testFiles: ['server/src/a.pg.test.js', 'server/src/a.property.test.js', 'server/src/a.test.js', 'server/src/a.test.mjs'],
      without: ['src/lone.js', 'src/missing.js'],
    })
  })

  it('takes a file with no extension, or dots in its directory', () => {
    expect(ownTestFiles(['bin/run', 'v1.2/x.js'], ['bin/run', 'bin/run.test.js', 'v1.2/x.test.js', 'v1.test.js']).testFiles).toEqual([
      'bin/run.test.js',
      'v1.2/x.test.js',
    ])
  })

  it('lists a test file once when two files share it, and gives nothing for no files', () => {
    expect(ownTestFiles(['src/stores/b.js', 'src/stores/b.css'], tracked)).toEqual({ testFiles: ['src/stores/b.css.test.js'], without: [] })
    expect(ownTestFiles([], tracked)).toEqual({ testFiles: [], without: [] })
  })

  it.each([
    ['sources that are not a list', 'a.js', []],
    ['tracked files that are not a list', [], 'a.js'],
    ['a source that is not text', [7], []],
    ['a tracked file that is not text', [], [null]],
  ])('refuses %s', (_, sources, files) => {
    expect(() => ownTestFiles(sources, files)).toThrow(TypeError)
  })
})

describe('runOptions', () => {
  it('runs the ranges with their own test files at a 100% break, on two runners, with a dry run that may take an hour', () => {
    expect(runOptions({ patterns: ['a.js:1-2'], testFiles: ['a.test.js'] })).toEqual({
      mutate: ['a.js:1-2'],
      testFiles: ['a.test.js'],
      vitest: { related: false },
      thresholds: { high: 100, low: 100, break: 100 },
      concurrency: 2,
      reporters: ['clear-text', 'progress-append-only'],
      dryRunTimeoutMinutes: 60,
    })
  })

  it('leaves the choice of tests to vitest related mode when no test files are given', () => {
    const options = runOptions({ patterns: ['a.js:1-2'], testFiles: null })
    expect(options).toEqual({
      mutate: ['a.js:1-2'],
      thresholds: { high: 100, low: 100, break: 100 },
      concurrency: 2,
      reporters: ['clear-text', 'progress-append-only'],
      dryRunTimeoutMinutes: 60,
    })
  })

  it.each([
    ['no patterns', { patterns: [], testFiles: ['a.test.js'] }],
    ['patterns that are not a list', { patterns: 'a.js:1-2', testFiles: null }],
    ['an empty list of test files', { patterns: ['a.js:1-2'], testFiles: [] }],
    ['test files that are not a list', { patterns: ['a.js:1-2'], testFiles: 'a.test.js' }],
    ['a pattern that is not text', { patterns: [7], testFiles: null }],
    ['a test file that is not text', { patterns: ['a.js:1-2'], testFiles: [null] }],
    ['no test files at all', { patterns: ['a.js:1-2'] }],
  ])('refuses %s, which would mutate everything or run every test', (_, input) => {
    expect(() => runOptions(input)).toThrow(TypeError)
  })
})

describe('configText', () => {
  it('writes a config that imports the base and puts the run options over it, keeping the rest of its vitest options', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'changed-config-'))
    try {
      writeFileSync(
        join(dir, 'base.mjs'),
        "export default { testRunner: 'vitest', vitest: { configFile: 'vitest.config.js' }, mutate: ['x.js'], concurrency: 8, ignoreStatic: true }\n",
      )
      const options = runOptions({ patterns: ["it's \"odd\".js:1-2"], testFiles: ['a b.test.js'] })
      writeFileSync(join(dir, 'run.mjs'), configText(pathToFileURL(join(dir, 'base.mjs')).href, options))
      const { default: config } = await import(pathToFileURL(join(dir, 'run.mjs')).href)
      expect(config).toEqual({
        testRunner: 'vitest',
        ignoreStatic: true,
        ...options,
        vitest: { configFile: 'vitest.config.js', related: false },
      })

      writeFileSync(join(dir, 'related.mjs'), configText(pathToFileURL(join(dir, 'base.mjs')).href, runOptions({ patterns: ['a.js:1-1'], testFiles: null })))
      const { default: related } = await import(pathToFileURL(join(dir, 'related.mjs')).href)
      expect(related.vitest).toEqual({ configFile: 'vitest.config.js' })
      expect(related.mutate).toEqual(['a.js:1-1'])
      expect(related.testFiles).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a base that is not a file url', () => {
    expect(() => configText('./stryker.config.mjs', runOptions({ patterns: ['a.js:1-1'], testFiles: null }))).toThrow(TypeError)
    expect(() => configText(7, runOptions({ patterns: ['a.js:1-1'], testFiles: null }))).toThrow(TypeError)
  })
})

describe('parseArgs', () => {
  it('takes the base ref, and --related before or after it', () => {
    expect(parseArgs(['main'])).toEqual({ base: 'main', related: false })
    expect(parseArgs(['origin/feat/x', '--related'])).toEqual({ base: 'origin/feat/x', related: true })
    expect(parseArgs(['--related', 'HEAD~3'])).toEqual({ base: 'HEAD~3', related: true })
  })

  it.each([
    ['no base ref', []],
    ['only the flag', ['--related']],
    ['two base refs', ['main', 'dev']],
    ['an option it does not know', ['main', '--all']],
    ['a ref that git would read as an option', ['--output=/tmp/x']],
    ['a ref that starts with a dash', ['-x']],
    ['an empty ref', ['']],
    ['the flag twice', ['main', '--related', '--related']],
  ])('refuses %s, with the usage', (_, args) => {
    expect(() => parseArgs(args)).toThrow(/^usage: node scripts\/mutation-changed\.mjs <base-ref> \[--related\]/)
  })
})
