import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadFixture } from './fixture'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('loadFixture', () => {
  it('is null unless VITE_DEATHWATCH_FIXTURE is set', async () => {
    vi.stubEnv('VITE_DEATHWATCH_FIXTURE', '')
    expect(await loadFixture()).toBe(null)
  })

  it('is null in a production build even when the flag is set', async () => {
    // The literal DEV check is what lets the build drop the fixture, so it never reaches visitors.
    vi.stubEnv('VITE_DEATHWATCH_FIXTURE', 'commander')
    vi.stubEnv('DEV', false)
    expect(await loadFixture()).toBe(null)
  })

  it('shows the allowed scene for 1 and for an unknown name', async () => {
    for (const v of ['1', 'bogus']) {
      vi.stubEnv('VITE_DEATHWATCH_FIXTURE', v)
      expect(await loadFixture()).toMatchObject({ _fixture: true, scene: 'allowed' })
    }
  })

  it('takes the scene from the flag when it names one', async () => {
    vi.stubEnv('VITE_DEATHWATCH_FIXTURE', 'denied')
    expect(await loadFixture()).toMatchObject({ scene: 'denied', status: 'denied' })
  })

  it('lets ?scene= on the page URL override the flag', async () => {
    vi.stubEnv('VITE_DEATHWATCH_FIXTURE', '1')
    vi.stubGlobal('location', { search: '?scene=commander' })
    expect(await loadFixture()).toMatchObject({ scene: 'commander', status: 'allowed', commander: true })
    vi.stubGlobal('location', { search: '?other=1' })
    expect(await loadFixture()).toMatchObject({ scene: 'allowed' })
  })

  it('copes with there being no location at all', async () => {
    vi.stubEnv('VITE_DEATHWATCH_FIXTURE', 'unavailable')
    vi.stubGlobal('location', undefined)
    expect(await loadFixture()).toMatchObject({ scene: 'unavailable' })
  })
})
