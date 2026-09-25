// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('../lib/discordAuth', async (orig) => ({ ...(await orig()), beginSignIn: vi.fn() }))
const { useAuth } = await import('./auth')
const { takeAnchor } = await import('../lib/archive/anchor')

beforeEach(() => {
  setActivePinia(createPinia())
  sessionStorage.clear()
})

describe('auth.signIn keeps the archive message anchor, whichever button started it', () => {
  it('on an archive thread with a message hash, the anchor is stashed for that page', () => {
    history.replaceState(null, '', '/ranks/200000000000000001#m-200000000000000011')
    useAuth().signIn()
    expect(takeAnchor('/ranks/200000000000000001')).toBe('#m-200000000000000011')
  })
  it('elsewhere nothing is stashed', () => {
    history.replaceState(null, '', '/builds#m-200000000000000011')
    useAuth().signIn()
    expect(takeAnchor('/builds')).toBeNull()
  })
})
