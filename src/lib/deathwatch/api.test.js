import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../buildsApi', async (real) => ({ ...(await real()), request: vi.fn() }))
import { request } from '../buildsApi'
import { getData, getMe } from './api'

beforeEach(() => vi.resetAllMocks())

describe('getMe', () => {
  it('asks the server who it is, with the token and never from the HTTP cache', async () => {
    request.mockResolvedValue({ access: true, watchCommander: false })
    expect(await getMe('tok')).toEqual({ access: true, watchCommander: false })
    expect(request).toHaveBeenCalledWith('/deathwatch/me', { token: 'tok', cache: 'no-store' })
  })

  it('lets a failed request reach the caller', async () => {
    const err = Object.assign(new Error('nope'), { status: 401 })
    request.mockRejectedValue(err)
    await expect(getMe('tok')).rejects.toBe(err)
  })
})

describe('getData', () => {
  const answer = (status, body, etag) =>
    vi.fn().mockResolvedValue({ status, ok: status < 300, json: async () => body, headers: { get: () => etag } })

  it('sends the token and the last ETag, never from the HTTP cache, and hands back the new one', async () => {
    globalThis.fetch = answer(200, { teams: {} }, '"v2"')
    expect(await getData('tok', '"v1"')).toEqual({ data: { teams: {} }, etag: '"v2"' })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toMatch(/\/deathwatch\/data$/)
    expect(init).toEqual({ headers: { Authorization: 'Bearer tok', 'If-None-Match': '"v1"' }, cache: 'no-store' })
  })

  it('says nothing changed on a 304, and sends no ETag it does not have', async () => {
    globalThis.fetch = answer(304)
    expect(await getData('tok', '')).toBeNull()
    expect(fetch.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer tok' })
  })

  it("throws the server's message with the status", async () => {
    globalThis.fetch = answer(403, { error: 'Restricted to the Deathwatch.' })
    await expect(getData('tok')).rejects.toMatchObject({ message: 'Restricted to the Deathwatch.', status: 403 })
  })
})
