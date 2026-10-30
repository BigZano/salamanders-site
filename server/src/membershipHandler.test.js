import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { createMembershipHandler } from './membershipHandler.js'
import { Upstream } from './discordRoles.js'

// Invented ids only: real user ids never enter the repo.
const ME = '300000000000000001'

const SIGN_IN = { error: 'Sign in with Discord.' }
const UNREACHABLE = { error: 'Discord could not be reached. Try again.' }

// The membership seam, scripted. `check` is whatever the test needs it to be;
// it gets the request the handler was given, so a test can see what was asked.
function setup(check) {
  const handle = createMembershipHandler({ membership: { check: async (request) => check(request) } })
  const ask = (path = '/membership', method = 'GET', headers = {}) =>
    handle(new Request(`https://api.test${path}`, { method, headers }), new URL(`https://api.test${path}`))
  return { ask }
}
const isMember = (member) => () => ({ id: ME, member })
const signedOut = () => null
const failing = (err) => () => {
  throw err
}

describe('a signed-in caller', () => {
  it('a member gets exactly { member: true }', async () => {
    const res = await setup(isMember(true)).ask()
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(await res.json()).toStrictEqual({ member: true })
  })

  it('a non-member gets { member: false }', async () => {
    const res = await setup(isMember(false)).ask()
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(await res.json()).toStrictEqual({ member: false })
  })

  it('the body is the bare answer: the user id appears nowhere in it', async () => {
    const res = await setup(isMember(true)).ask()
    expect(await res.text()).not.toContain(ME)
  })

  it('hands the incoming request to the membership check, so its token is the one judged', async () => {
    const { ask } = setup((request) => ({ id: ME, member: request.headers.get('Authorization') === 'Bearer invented-token' }))
    expect(await (await ask('/membership', 'GET', { Authorization: 'Bearer invented-token' })).json()).toStrictEqual({ member: true })
    expect(await (await ask('/membership', 'GET', { Authorization: 'Bearer other-token' })).json()).toStrictEqual({ member: false })
  })

  it('a query string is ignored: the route still answers', async () => {
    const res = await setup(isMember(true)).ask('/membership?x=1')
    expect(res.status).toBe(200)
    expect(await res.json()).toStrictEqual({ member: true })
  })

  // Fail closed: only the boolean true is a member. A faulty check that
  // answers with something merely truthy must not open the door.
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
  ])('a check that answers member: %s is not a member', async (_label, member) => {
    const res = await setup(isMember(member)).ask()
    expect(res.status).toBe(200)
    expect(await res.json()).toStrictEqual({ member: false })
  })

  it('a check that answers with no member key at all is not a member', async () => {
    const res = await setup(() => ({ id: ME })).ask()
    expect(res.status).toBe(200)
    expect(await res.json()).toStrictEqual({ member: false })
  })

  it('whatever the check answers, the reply is 200 { member: boolean } and true only for true', async () => {
    await fc.assert(
      fc.asyncProperty(fc.anything(), async (member) => {
        const res = await setup(isMember(member)).ask()
        expect(res.status).toBe(200)
        expect(await res.json()).toStrictEqual({ member: member === true })
      }),
    )
  })
})

describe('no sign-in', () => {
  it('no token is 401 { error: "Sign in with Discord." }', async () => {
    const res = await setup(signedOut).ask()
    expect(res.status).toBe(401)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(await res.json()).toStrictEqual(SIGN_IN)
  })
})

describe('Discord cannot answer', () => {
  it.each([
    ['an Upstream', () => new Upstream('Discord is down.')],
    ['a plain Error', () => new Error('socket hang up')],
    ['a TypeError', () => new TypeError('x is not a function')],
  ])('%s is 503 { error: "Discord could not be reached. Try again." }', async (_label, make) => {
    const err = make()
    const res = await setup(failing(err)).ask()
    expect(res.status).toBe(503)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(await res.json()).toStrictEqual(UNREACHABLE)
  })

  it.each([
    ['a string', 'boom'],
    ['undefined', undefined],
    ['null', null],
    ['an object', { message: 'boom' }],
  ])('a check that rejects with %s is still 503', async (_label, thrown) => {
    const res = await setup(failing(thrown)).ask()
    expect(res.status).toBe(503)
    expect(await res.json()).toStrictEqual(UNREACHABLE)
  })

  it('the error text never reaches the caller', async () => {
    const res = await setup(failing(new Error('secret-detail-300000000000000009'))).ask()
    expect(await res.text()).not.toContain('secret-detail')
  })
})

describe('caching', () => {
  it.each([
    ['a member', isMember(true)],
    ['a non-member', isMember(false)],
    ['no token', signedOut],
    ['an Upstream failure', failing(new Upstream('down'))],
    ['a plain failure', failing(new Error('down'))],
  ])('every answer is no-store: %s', async (_label, check) => {
    const res = await setup(check).ask()
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('routing', () => {
  it.each([['/membership/'], ['/membership/x'], ['/membershipx'], ['/Membership'], ['/xmembership'], ['/roster/public'], ['/health'], ['/']])(
    'GET %s is not its business',
    async (path) => {
      expect(await setup(isMember(true)).ask(path)).toBe(null)
    },
  )

  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])('%s /membership is not its business', async (method) => {
    expect(await setup(isMember(true)).ask('/membership', method)).toBe(null)
  })

  it('does not ask Discord anything for a request that is not its own', async () => {
    const { ask } = setup(failing(new Error('the membership check must not run')))
    expect(await ask('/membershipx')).toBe(null)
    expect(await ask('/membership', 'POST')).toBe(null)
  })
})
