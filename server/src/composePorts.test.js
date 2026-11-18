import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// The compose file is the deployment's front door, so its text is pinned like schema.sql is in librariusSchema.test.js:
// the API is published on the host's loopback alone (the Cloudflare tunnel and the owner's curl both run on the host),
// and the Librarius's forum id reaches it from server/.env.
const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')

/** → the lines of one service: from its `  name:` line to the next line indented no deeper than 2, or the end. */
function serviceLines(name) {
  const lines = compose.split(/\r?\n/)
  const start = lines.findIndex((l) => l === `  ${name}:`)
  if (start === -1) return []
  const body = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith('   ')) break
    body.push(line)
  }
  return body
}

/** → the entries of a service's `ports:` list, quotes taken off; empty when it publishes none. */
function portsOf(name) {
  const body = serviceLines(name)
  const at = body.findIndex((l) => l === '    ports:')
  if (at === -1) return []
  const entries = []
  for (const line of body.slice(at + 1)) {
    if (line.trim().startsWith('#')) continue
    const item = /^ {6}- (.*)$/.exec(line)
    if (item === null) break
    entries.push(item[1].replace(/^(['"])(.*)\1$/, '$2'))
  }
  return entries
}

/** → the variable names of a service's `environment:` block with their values, as written. */
function environmentOf(name) {
  const env = {}
  for (const line of serviceLines(name)) {
    const pair = /^ {6}([A-Z][A-Z0-9_]*): (.*)$/.exec(line)
    if (pair !== null) env[pair[1]] = pair[2]
  }
  return env
}

describe('server/docker-compose.yml', () => {
  it('has the api and db services the helpers read', () => {
    expect(serviceLines('api').length).toBeGreaterThan(10)
    expect(serviceLines('db').length).toBeGreaterThan(5)
    expect(serviceLines('nothing-of-the-kind')).toEqual([])
  })

  it('publishes the api on the host loopback alone', () => {
    expect(portsOf('api')).toEqual(['127.0.0.1:8787:8787'])
  })

  it('never publishes a port without a host address, for any service', () => {
    const wide = [...portsOf('api'), ...portsOf('db')].filter((entry) => !entry.startsWith('127.0.0.1:'))
    expect(wide).toEqual([])
    // Nor in a form the helpers do not read: the bare pair, with or without quotes, anywhere in the file.
    expect(compose).not.toMatch(/(?<![\d.:])8787:8787/)
  })

  it('does not publish the database at all', () => {
    expect(portsOf('db')).toEqual([])
  })

  it('hands the api the forum id from server/.env, empty when unset', () => {
    expect(environmentOf('api').LIBRARIUS_CHANNEL_ID).toBe('${LIBRARIUS_CHANNEL_ID:-}')
  })

  it('gives the forum id to the api and to nothing else', () => {
    expect(environmentOf('db').LIBRARIUS_CHANNEL_ID).toBeUndefined()
    expect(compose.match(/LIBRARIUS_CHANNEL_ID: /g)).toHaveLength(1)
  })

  it('hands the api the webhook address and the form from server/.env, empty when unset', () => {
    expect(environmentOf('api').LIBRARIUS_WEBHOOK_URL).toBe('${LIBRARIUS_WEBHOOK_URL:-}')
    expect(environmentOf('api').LIBRARIUS_FORM).toBe('${LIBRARIUS_FORM:-}')
  })

  it('gives the webhook address and the form to the api and to nothing else, and never as a value', () => {
    expect(environmentOf('db').LIBRARIUS_WEBHOOK_URL).toBeUndefined()
    expect(environmentOf('db').LIBRARIUS_FORM).toBeUndefined()
    expect(compose.match(/LIBRARIUS_WEBHOOK_URL: /g)).toHaveLength(1)
    expect(compose.match(/LIBRARIUS_FORM: /g)).toHaveLength(1)
    // The address is a secret: nothing in the file may look like one.
    expect(compose).not.toMatch(/\/api\/webhooks\//)
  })
})
