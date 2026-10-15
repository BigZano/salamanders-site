// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { router } from './router'

// jsdom has no scrolling; the router's scrollBehavior asks for it after every navigation.
beforeAll(() => {
  window.scrollTo = vi.fn()
})

// /roster was a page of its own; it now lives on /companies, and old links still land.
describe('the retired /roster route', () => {
  it.each([
    ['/roster#company-3', '/companies#third'],
    ['/roster#forge', '/companies#armoury'],
    ['/roster#venerable-dreadnoughts', '/companies#dreadnoughts'],
    ['/roster#unassigned', '/companies#muster'],
    ['/roster#nope', '/companies'],
    ['/roster?scene=denied', '/companies?scene=denied'],
    ['/roster', '/companies'],
  ])('sends %s to %s', async (from, to) => {
    await router.push(from)
    expect(router.currentRoute.value.fullPath).toBe(to)
  })

  it('is a redirect and no longer a named page', () => {
    const route = router.getRoutes().find((r) => r.path === '/roster')
    expect(route.redirect).toBeTypeOf('function')
    expect(route.name).toBeUndefined()
    expect(router.getRoutes().some((r) => r.name === 'roster')).toBe(false)
  })
})
