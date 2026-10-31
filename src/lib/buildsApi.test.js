import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  request,
  listBuilds,
  createBuild,
  deleteBuild,
  getModeratorStatus,
  getMembership,
  getCompanyNotables,
  BuildsApiError,
} from './buildsApi'
import { getCorrections } from './perksApi'

function mockResponse({ ok = true, status = 200, body = null, jsonThrows = false } = {}) {
  return {
    ok,
    status,
    json: () => (jsonThrows ? Promise.reject(new Error('bad json')) : Promise.resolve(body)),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('listBuilds', () => {
  it('GETs /builds with no query string when no class is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ body: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await listBuilds()
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/builds$/)
    expect(opts.method).toBe('GET')
  })

  it('adds an encoded class filter when given one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ body: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await listBuilds('Heavy & Support')
    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('/builds?class=Heavy%20%26%20Support')
  })

  it('returns the parsed JSON body on success', async () => {
    const builds = [{ id: 1, title: 'Test' }]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ body: builds })))
    await expect(listBuilds()).resolves.toEqual(builds)
  })

  it('resolves against the local dev API by default (no VITE_BUILDS_API_URL configured here)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ body: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await listBuilds()
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8787/builds')
  })

  it('sends no Content-Type header on a bodyless GET', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ body: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await listBuilds()
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Content-Type')
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined()
  })

  it('listBuilds sends the bearer token when given one and none when not', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ body: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await listBuilds(undefined, 'tok-abc')
    await listBuilds('Heavy', 'tok-xyz')
    await listBuilds('Heavy')
    await listBuilds()
    const [withToken, withTokenAndClass, withClassOnly, bare] = fetchMock.mock.calls
    expect(withToken[1].headers.Authorization).toBe('Bearer tok-abc')
    expect(withTokenAndClass[1].headers.Authorization).toBe('Bearer tok-xyz')
    // The token must not displace the class filter, nor leak into the URL.
    expect(withTokenAndClass[0]).toBe('http://localhost:8787/builds?class=Heavy')
    expect(withToken[0]).toBe('http://localhost:8787/builds')
    expect(withClassOnly[1].headers).not.toHaveProperty('Authorization')
    expect(bare[1].headers).not.toHaveProperty('Authorization')
  })
})

describe('createBuild', () => {
  it('POSTs JSON with a Bearer token and Content-Type set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true, status: 201, body: { id: 1 } }))
    vi.stubGlobal('fetch', fetchMock)
    await createBuild({ title: 'x' }, 'tok123')
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/builds$/)
    expect(opts.method).toBe('POST')
    expect(opts.headers['Content-Type']).toBe('application/json')
    expect(opts.headers['Authorization']).toBe('Bearer tok123')
    expect(JSON.parse(opts.body)).toEqual({ title: 'x' })
  })

  it('omits the Authorization header entirely when no token is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ status: 401, ok: false, body: { error: 'nope' } }))
    vi.stubGlobal('fetch', fetchMock)
    await createBuild({ title: 'x' }).catch(() => {})
    const [, opts] = fetchMock.mock.calls[0]
    expect(opts.headers).not.toHaveProperty('Authorization')
  })
})

describe('deleteBuild', () => {
  it('DELETEs with the token and resolves null on a 204 without parsing a (nonexistent) body', async () => {
    // A real 204 has no body — .json() would reject if called. Rejecting here
    // proves resolving null comes from the status check, not from a lucky mock.
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ status: 204, jsonThrows: true }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(deleteBuild(7, 'tok')).resolves.toBeNull()
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/builds\/7$/)
    expect(opts.method).toBe('DELETE')
    expect(opts.headers['Authorization']).toBe('Bearer tok')
  })
})

describe('error handling', () => {
  it('throws a BuildsApiError carrying the server message and status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 403, body: { error: 'Only the poster or a moderator can delete this build.' } })),
    )
    await expect(deleteBuild(1, 'tok')).rejects.toMatchObject({
      name: 'BuildsApiError',
      status: 403,
      message: 'Only the poster or a moderator can delete this build.',
    })
  })

  it('falls back to a generic message when the error body is not valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 500, jsonThrows: true })))
    await expect(listBuilds()).rejects.toMatchObject({ status: 500, message: 'Request failed (500)' })
  })

  it('falls back to a generic message when the error body is valid JSON but has no .error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 404, body: {} })))
    await expect(listBuilds()).rejects.toMatchObject({ status: 404, message: 'Request failed (404)' })
  })

  it('rejects the whole call when fetch itself rejects (network down)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(listBuilds()).rejects.toThrow('network down')
  })

  it('is a real Error subclass so callers can rely on instanceof', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 400, body: { error: 'bad' } })))
    try {
      await listBuilds()
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(BuildsApiError)
      expect(err).toBeInstanceOf(Error)
    }
  })
})

describe('getModeratorStatus', () => {
  it('GETs /builds/moderator with the bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ body: { moderator: true } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(getModeratorStatus('tok')).resolves.toBe(true)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/builds\/moderator$/)
    expect(opts.headers.Authorization).toBe('Bearer tok')
  })

  it('is false unless the server says exactly true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ body: { moderator: 'yes' } })))
    await expect(getModeratorStatus('tok')).resolves.toBe(false)
  })
})

describe('getMembership', () => {
  const answerFor = async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ body })))
    return getMembership('tok')
  }

  it('is true only for { member: true }', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ body: { member: true } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(getMembership('tok-abc')).resolves.toBe(true)
    // It asks the right question, as the caller, and never from a cached answer.
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/membership')
    expect(opts.method).toBe('GET')
    expect(opts.headers.Authorization).toBe('Bearer tok-abc')
    expect(opts.cache).toBe('no-store')
  })

  it('is false for { member: false }', async () => {
    await expect(answerFor({ member: false })).resolves.toBe(false)
  })

  it('is false for "true", 1, null and a missing key', async () => {
    const bodies = [{ member: 'true' }, { member: 1 }, { member: null }, {}]
    const answers = []
    for (const body of bodies) answers.push(await answerFor(body))
    expect(answers).toEqual([false, false, false, false])
  })

  it('is false for other truthy lookalikes and for a body that is not an object', async () => {
    const bodies = [
      { member: [true] },
      { member: {} },
      { member: 'yes' },
      { Member: true },
      { nested: { member: true } },
      null,
      true,
      'member',
      1,
      [true],
      [],
    ]
    const answers = []
    for (const body of bodies) answers.push(await answerFor(body))
    expect(answers).toEqual(bodies.map(() => false))
  })

  it('rejects with BuildsApiError on a 401', async () => {
    // Callers decide what a failed lookup means; it must not be quietly "false".
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 401, body: { error: 'Sign in again.' } })),
    )
    await expect(getMembership('stale')).rejects.toMatchObject({
      name: 'BuildsApiError',
      status: 401,
      message: 'Sign in again.',
    })
    await expect(getMembership('stale')).rejects.toBeInstanceOf(BuildsApiError)
  })

  it('rejects with BuildsApiError on a 503 when Discord cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 503, body: { error: 'Discord is unreachable.' } })),
    )
    await expect(getMembership('tok')).rejects.toMatchObject({ name: 'BuildsApiError', status: 503 })
  })

  it('rejects when fetch itself rejects (network down)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(getMembership('tok')).rejects.toThrow('network down')
  })
})

describe('getCompanyNotables', () => {
  // Invented names only.
  const COMPANIES = { alpha: [['Test Member One', 'A line about them.']], beta: [['Test Member Two']] }
  const answerFor = async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ body })))
    return getCompanyNotables('tok')
  }

  it('asks for the notables as the caller, never from a cached answer, and returns the companies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ body: { companies: COMPANIES } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(getCompanyNotables('tok-abc')).resolves.toStrictEqual(COMPANIES)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/company-notables')
    expect(opts.method).toBe('GET')
    expect(opts.headers.Authorization).toBe('Bearer tok-abc')
    expect(opts.cache).toBe('no-store')
  })

  it('is an empty set for an answer that is not an object of companies', async () => {
    const bodies = [{}, { companies: null }, { companies: 'text' }, { companies: 5 }, { companies: [COMPANIES] }, { company: COMPANIES }, null, 'text', []]
    const answers = []
    for (const body of bodies) answers.push(await answerFor(body))
    expect(answers).toStrictEqual(bodies.map(() => ({})))
  })

  it('rejects with BuildsApiError on a refusal or an outage, so the caller can tell them apart', async () => {
    for (const status of [401, 403, 503]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ ok: false, status, body: { error: 'No.' } })))
      await expect(getCompanyNotables('tok')).rejects.toMatchObject({ name: 'BuildsApiError', status, message: 'No.' })
    }
  })

  it('rejects when fetch itself rejects (network down)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(getCompanyNotables('tok')).rejects.toThrow('network down')
  })
})

describe('request cache mode', () => {
  it('passes a requested cache mode through to fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ body: {} }))
    vi.stubGlobal('fetch', fetchMock)
    await request('/perk-corrections', { cache: 'no-cache' })
    expect(fetchMock.mock.calls[0][1].cache).toBe('no-cache')
  })

  it('leaves fetch on its default cache mode otherwise', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ body: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await listBuilds()
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('cache')
  })

  it('getCorrections always revalidates with the server', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ body: { weapons: {}, classes: {} } }))
    vi.stubGlobal('fetch', fetchMock)
    await getCorrections()
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/perk-corrections$/)
    expect(opts.cache).toBe('no-cache')
  })
})
