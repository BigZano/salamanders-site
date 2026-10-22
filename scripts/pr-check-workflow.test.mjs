import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

// The pull-request workflow runs code from contributors' forks. It must never be given a secret or a
// write token: a fork's pull request gets none, and a workflow that asked for one could not be trusted
// with it. These tests pin that, so a later edit cannot quietly undo the fork-based contributor flow.
const path = new URL('../.github/workflows/pr-check.yml', import.meta.url)
const workflow = existsSync(path) ? readFileSync(path, 'utf8') : ''

describe('pr-check workflow', () => {
  it('runs on pull_request, never pull_request_target', () => {
    // pull_request_target runs with the base repo's secrets against a fork's code.
    expect(workflow).not.toBe('')
    expect(workflow).toMatch(/^\s+pull_request:/m)
    expect(workflow).not.toContain('pull_request_target')
  })

  it('references no secrets', () => {
    expect(workflow).not.toBe('')
    expect(workflow).not.toContain('secrets.')
  })

  it('asks for read access only', () => {
    const block = workflow.match(/^permissions:[ \t]*\r?\n((?:[ \t]+\S.*\r?\n?)+)/m)?.[1] ?? ''
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    expect(lines).toEqual(['contents: read'])
  })

  it('runs the suite and the build', () => {
    expect(workflow).toContain('bun run test')
    expect(workflow).toContain('bun run build')
  })
})
