import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

// The pull-request workflow runs code from contributors' forks. It must never be given a secret or a
// write token: a fork's pull request gets none, and a workflow that asked for one could not be trusted
// with it. These tests pin that, so a later edit cannot quietly undo the fork-based contributor flow.
const path = new URL('../.github/workflows/pr-check.yml', import.meta.url)
const workflow = existsSync(path) ? readFileSync(path, 'utf8') : ''

const deployPath = new URL('../.github/workflows/deploy.yml', import.meta.url)
const deploy = existsSync(deployPath) ? readFileSync(deployPath, 'utf8') : ''
const CHECK = 'node scripts/check-csp.mjs dist'

// The number of the step (counting the lines that start one, "- ...") that holds the first line with `text`, or -1.
function stepOf(text, workflowText) {
  const lines = workflowText.split('\n')
  const line = lines.findIndex((l) => l.includes(text))
  if (line === -1) return -1
  return lines.slice(0, line + 1).filter((l) => /^\s+- /.test(l)).length - 1
}

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

  it('checks the Content-Security-Policy of the build it just made, in the very next step', () => {
    const build = stepOf('bun run build', workflow)
    expect(build).toBeGreaterThan(-1)
    expect(stepOf(CHECK, workflow)).toBe(build + 1)
  })
})

// The check reads the page with jsdom, a development dependency: so the workflow must have installed those before the check
// (bun install does, unless it is told to leave them out), and in a step of its own before the build as well.
const INSTALL = 'bun install --frozen-lockfile'
const LEAVES_DEV_DEPENDENCIES_OUT = /--production|--omit[= ]dev|--only[= ]prod|NODE_ENV:\s*['"]?production/

describe('the workflows install the development dependencies the check needs', () => {
  it.each([
    ['pr-check', workflow],
    ['deploy', deploy],
  ])('%s installs them, with the lockfile, in an earlier step than the check, and does not leave them out', (_, text) => {
    expect(text).not.toBe('')
    const install = stepOf(INSTALL, text)
    expect(install).toBeGreaterThan(-1)
    expect(install).toBeLessThan(stepOf('bun run build', text))
    expect(install).toBeLessThan(stepOf(CHECK, text))
    expect(text).not.toMatch(LEAVES_DEV_DEPENDENCIES_OUT)
  })

  it('runs the check with node, which jsdom runs in', () => {
    expect(workflow).toMatch(/uses: actions\/setup-node@/)
    expect(deploy).toMatch(/uses: actions\/setup-node@/)
    expect(stepOf('actions/setup-node', workflow)).toBeLessThan(stepOf(CHECK, workflow))
    expect(stepOf('actions/setup-node', deploy)).toBeLessThan(stepOf(CHECK, deploy))
  })
})

describe('deploy workflow', () => {
  it('checks the Content-Security-Policy of the build it ships, in the very next step after the build', () => {
    expect(deploy).not.toBe('')
    const build = stepOf('bun run build', deploy)
    expect(build).toBeGreaterThan(-1)
    expect(stepOf(CHECK, deploy)).toBe(build + 1)
  })

  it('checks it before the build is scanned or uploaded, and builds only the once', () => {
    expect(stepOf(CHECK, deploy)).toBeLessThan(stepOf('scripts/scan-dist.mjs', deploy))
    expect(stepOf(CHECK, deploy)).toBeLessThan(stepOf('upload-pages-artifact', deploy))
    expect(deploy.match(/bun run build/g)).toHaveLength(1)
  })
})
