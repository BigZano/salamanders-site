import { describe, it, expect, vi, afterEach } from 'vitest'
import { listBuilds, createBuild, deleteBuild, BuildsApiError } from './buildsApi'

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
