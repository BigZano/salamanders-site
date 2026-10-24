import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('../lib/deathwatch/api', () => ({ getData: vi.fn(), writeDoc: vi.fn() }))
import { getData, writeDoc } from '../lib/deathwatch/api'
import { useDeathwatchData } from './deathwatchData'

const DATA = { teams: { 1: { id: 1, n: 'Alpha', ro: [], m: [] } }, cfg: { s: { base: 400 } }, archive: {} }

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
})

describe('deathwatchData store', () => {
  it('loads the documents and keeps the ETag', async () => {
    getData.mockResolvedValue({ data: DATA, etag: '"v1"' })
    const s = useDeathwatchData()
    await s.load('tok')
    expect(s).toMatchObject({ status: 'ready', teams: DATA.teams, cfg: DATA.cfg, etag: '"v1"' })
    expect(getData).toHaveBeenCalledWith('tok', '')
  })

  it('asks with the last ETag, and keeps what it has when nothing changed', async () => {
    getData.mockResolvedValueOnce({ data: DATA, etag: '"v1"' }).mockResolvedValueOnce(null)
    const s = useDeathwatchData()
    await s.load('tok')
    await s.load('tok')
    expect(getData).toHaveBeenLastCalledWith('tok', '"v1"')
    expect(s.teams).toEqual(DATA.teams)
  })

  it('shows an error only when nothing has loaded yet', async () => {
    const s = useDeathwatchData()
    getData.mockRejectedValueOnce(new Error('Restricted to the Deathwatch.'))
    await s.load('tok')
    expect(s).toMatchObject({ status: 'error', error: 'Restricted to the Deathwatch.' })
    getData.mockResolvedValueOnce({ data: DATA, etag: '"v1"' }).mockRejectedValueOnce(new Error('down'))
    await s.load('tok')
    await s.load('tok')
    expect(s).toMatchObject({ status: 'ready', teams: DATA.teams })
  })

  it('drops an answer that a later load has overtaken', async () => {
    let first
    getData.mockReturnValueOnce(new Promise((r) => (first = r))).mockResolvedValueOnce({ data: DATA, etag: '"v2"' })
    const s = useDeathwatchData()
    const slow = s.load('tok')
    await s.load('tok')
    first({ data: { teams: {}, cfg: {}, archive: {} }, etag: '"v1"' })
    await slow
    expect(s.etag).toBe('"v2"')
  })

  it('writes to the server, shows the change at once, then refetches', async () => {
    getData.mockResolvedValue({ data: DATA, etag: '"v1"' })
    writeDoc.mockResolvedValue({ ok: true })
    const s = useDeathwatchData()
    await s.load('tok')
    await s.write('tok', 'teams', 2, { id: 2, n: 'Beta' })
    expect(writeDoc).toHaveBeenCalledWith('tok', 'teams', 2, { id: 2, n: 'Beta' })
    expect(s.teams[2].n).toBe('Beta')
    expect(getData).toHaveBeenCalledTimes(2)
    await s.write('tok', 'teams', 2, null)
    expect(s.teams[2]).toBeUndefined()
  })

  it('changes nothing here when the server refuses the write', async () => {
    writeDoc.mockRejectedValue(Object.assign(new Error('Only the Watch Commander can do that.'), { status: 403 }))
    const s = useDeathwatchData()
    await expect(s.write('tok', 'teams', 2, { id: 2 })).rejects.toThrow('Only the Watch Commander')
    expect(s.teams).toEqual({})
  })

  it('forgets everything on reset', async () => {
    getData.mockResolvedValue({ data: DATA, etag: '"v1"' })
    const s = useDeathwatchData()
    await s.load('tok')
    s.reset()
    expect(s).toMatchObject({ status: 'idle', teams: {}, etag: '' })
  })
})
