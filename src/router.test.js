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

describe('scroll behaviour', () => {
  const scroll = (to, from) => router.options.scrollBehavior(to, from)

  it('leaves a /companies#… landing to the page, which scrolls once its story is there', () => {
    // a jump to the top here, after the page's own scroll to #third, would undo it
    expect(scroll({ path: '/companies', hash: '#third' }, { path: '/' })).toBe(false)
    expect(scroll({ path: '/companies', hash: '#muster' }, { path: '/builds' })).toBe(false)
  })

  it('still goes to the top of /companies without a fragment, and of every other page', () => {
    expect(scroll({ path: '/companies', hash: '' }, { path: '/' })).toEqual({ top: 0 })
    expect(scroll({ path: '/builds', hash: '' }, { path: '/' })).toEqual({ top: 0 })
  })

  it('keeps the archive threads as they were: another page with a hash goes to the top, a same-page hash change is left alone', () => {
    expect(scroll({ path: '/accolades/200000000000000001', hash: '#m-5' }, { path: '/' })).toEqual({ top: 0 })
    expect(scroll({ path: '/accolades/200000000000000001', hash: '#m-6' }, { path: '/accolades/200000000000000001' })).toBe(false)
  })
})
