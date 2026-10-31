import { describe, it, expect, vi } from 'vitest'
import { createCompanyNotablesHandler } from './companyNotablesHandler.js'
import { Upstream } from './discordRoles.js'

// Invented ids and names only: real ones never enter the repo.
const ME = '300000000000000001'
const COMPANIES = { alpha: [['Test Member One', 'A line about them.']], beta: [['Test Member Two']] }

const SIGN_IN = { error: 'Sign in with Discord.' }
const MEMBERS_ONLY = { error: 'Notable members are shown to guild members.' }
const UNREACHABLE = { error: 'Discord could not be reached. Try again.' }

// The membership seam and the store, scripted. `check` gets the request the handler was given.
function setup(check, all = async () => COMPANIES) {
  const store = { all: vi.fn(all) }
  const handle = createCompanyNotablesHandler({ membership: { check: async (request) => check(request) }, store })
  const ask = (path = '/company-notables', method = 'GET', headers = {}) =>
    handle(new Request(`https://api.test${path}`, { method, headers }), new URL(`https://api.test${path}`))
  return { ask, store }
}
const isMember = (member) => () => ({ id: ME, member })
const signedOut = () => null
const failing = (err) => () => {
  throw err
}

describe('a guild member', () => {
  it('gets the stored notables, private and not cached', async () => {
    const { ask, store } = setup(isMember(true))
    const res = await ask()
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await res.json()).toStrictEqual({ companies: COMPANIES })
    expect(store.all).toHaveBeenCalledTimes(1)
  })

  it('gets an empty answer, not an error, when nothing is stored yet', async () => {
    const res = await setup(isMember(true), async () => ({})).ask()
    expect(res.status).toBe(200)
    expect(await res.json()).toStrictEqual({ companies: {} })
  })

  it('does not see its own id echoed', async () => {
    expect(await (await setup(isMember(true)).ask()).text()).not.toContain(ME)
  })

  it('has its own token judged, and a query string changes nothing', async () => {
    const { ask } = setup((request) => ({ id: ME, member: request.headers.get('Authorization') === 'Bearer invented-token' }))
    expect((await ask('/company-notables?x=1', 'GET', { Authorization: 'Bearer invented-token' })).status).toBe(200)
    expect((await ask('/company-notables', 'GET', { Authorization: 'Bearer other-token' })).status).toBe(403)
  })
})

describe('anyone else gets no names, and the store is never asked', () => {
  it('a signed-in non-member is refused', async () => {
    const { ask, store } = setup(isMember(false))
    const res = await ask()
    expect(res.status).toBe(403)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await res.json()).toStrictEqual(MEMBERS_ONLY)
    expect(store.all).not.toHaveBeenCalled()
  })

  it('a caller with no or an invalid token is 401', async () => {
    const { ask, store } = setup(signedOut)
    const res = await ask()
    expect(res.status).toBe(401)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await res.json()).toStrictEqual(SIGN_IN)
    expect(store.all).not.toHaveBeenCalled()
  })

  // Fail closed: only the boolean true is a member. A faulty check that answers with something merely truthy
  // must not open the door.
  it.each([
    ['the string "yes"', 'yes'],
    ['the number 1', 1],
    ['the string "true"', 'true'],
    ['an object', {}],
    ['an array', []],
    ['undefined', undefined],
    ['null', null],
    ['0', 0],
    ['the empty string', ''],
    ['NaN', NaN],
  ])('%s is not a member', async (_label, member) => {
    const { ask, store } = setup(() => ({ id: ME, member }))
    const res = await ask()
    expect(res.status).toBe(403)
    expect(await res.json()).toStrictEqual(MEMBERS_ONLY)
    expect(store.all).not.toHaveBeenCalled()
  })

  it.each([
    ['Discord unreachable', new Upstream('Discord could not be reached.')],
    ['any other failure', new Error('boom')],
  ])('%s is 503, with no detail', async (_label, err) => {
    const { ask, store } = setup(failing(err))
    const res = await ask()
    expect(res.status).toBe(503)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await res.json()).toStrictEqual(UNREACHABLE)
    expect(store.all).not.toHaveBeenCalled()
  })
})

describe('a store failure', () => {
  it('is not turned into an answer: the server’s catch-all logs it', async () => {
    const boom = new Error('database down')
    await expect(setup(isMember(true), async () => Promise.reject(boom)).ask()).rejects.toBe(boom)
  })
})

describe('other requests', () => {
  it.each([
    ['another method', '/company-notables', 'POST'],
    ['a HEAD request', '/company-notables', 'HEAD'],
    ['another path', '/company-notables/extra', 'GET'],
    ['the parent path', '/company', 'GET'],
    ['a longer name', '/company-notables-all', 'GET'],
  ])('%s is not this route’s: it answers null and asks nothing', async (_label, path, method) => {
    const check = vi.fn(isMember(true))
    const { ask, store } = setup(check)
    expect(await ask(path, method)).toBeNull()
    expect(check).not.toHaveBeenCalled()
    expect(store.all).not.toHaveBeenCalled()
  })
})
