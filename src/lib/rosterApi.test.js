import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./buildsApi', () => ({ request: vi.fn() }))
import { request } from './buildsApi'
import { getInfirmary, getRoster } from './rosterApi'

beforeEach(() => vi.resetAllMocks())

describe('rosterApi', () => {
  it('asks /roster with the token and never from the HTTP cache', async () => {
    request.mockResolvedValue({ ok: 1 })
    expect(await getRoster('tok')).toEqual({ ok: 1 })
    expect(request).toHaveBeenCalledWith('/roster', { token: 'tok', cache: 'no-store' })
  })

  it('asks /roster/infirmary the same way', async () => {
    request.mockResolvedValue({ members: [] })
    expect(await getInfirmary('tok')).toEqual({ members: [] })
    expect(request).toHaveBeenCalledWith('/roster/infirmary', { token: 'tok', cache: 'no-store' })
  })

  it('lets errors through for the store to classify', async () => {
    request.mockRejectedValue(Object.assign(new Error('no'), { status: 403 }))
    await expect(getRoster('t')).rejects.toMatchObject({ status: 403 })
  })
})
