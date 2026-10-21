import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../buildsApi', () => ({ request: vi.fn() }))
import { request } from '../buildsApi'
import { getMe } from './api'

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
