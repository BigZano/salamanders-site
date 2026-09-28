import { describe, it, expect, vi } from 'vitest'
import { createBuildModeration } from './buildModeration'
import { Upstream } from './discordRoles'

const ME = { poster: { id: '1', username: 'poster' }, mod: { id: '2', username: 'mod' }, other: { id: '3', username: 'other' } }
const PRIV = { '1': { moderator: false }, '2': { moderator: true }, '3': { moderator: false } }

function setup({ fail = false } = {}) {
  const deleted = []
  const notify = vi.fn()
  const mod = createBuildModeration({
    roles: {
      identify: async (req) => {
        if (fail) throw new Upstream()
        return ME[(req.headers.get('Authorization') || '').slice(7)] || null
      },
    },
    privileges: { forUser: async (u) => PRIV[u.id] },
    store: {
      buildAuthor: async (id) => (id === '7' && !deleted.includes('7') ? { id: '1', username: 'poster' } : null),
      softDeleteBuild: async (id) => {
        deleted.push(id)
        return { id: 7, title: 'Melta Bulwark', author: { id: '1', username: 'poster' } }
      },
    },
    notify,
  })
  const req = (who) => new Request('https://api.test/builds/7', { method: 'DELETE', headers: who ? { Authorization: `Bearer ${who}` } : {} })
  return { mod, notify, deleted, req }
}

describe('build deletion', () => {
  it('poster deletes their own without a ping', async () => {
    const { mod, notify, deleted, req } = setup()
    expect((await mod.remove(req('poster'), '7')).status).toBe(204)
    expect(deleted).toEqual(['7'])
    expect(notify).not.toHaveBeenCalled()
  })

  it('a moderator deletes someone else’s and the webhook hears about it', async () => {
    const { mod, notify, req } = setup()
    expect((await mod.remove(req('mod'), '7')).status).toBe(204)
    expect(notify).toHaveBeenCalledWith('mod deleted build #7 "Melta Bulwark" by poster')
  })

  it('401 / 403 / 404 / 503', async () => {
    const { mod, req } = setup()
    expect((await mod.remove(req(null), '7')).status).toBe(401)
    expect((await mod.remove(req('other'), '7')).status).toBe(403)
    expect((await mod.remove(req('poster'), '8')).status).toBe(404)
    expect((await setup({ fail: true }).mod.remove(req('poster'), '7')).status).toBe(503)
  })

  it('status reports moderator, false when signed out or Discord is down', async () => {
    const { mod, req } = setup()
    expect(await (await mod.status(req('mod'))).json()).toEqual({ moderator: true })
    expect(await (await mod.status(req(null))).json()).toEqual({ moderator: false })
    expect(await (await setup({ fail: true }).mod.status(req('mod'))).json()).toEqual({ moderator: false })
  })
})
