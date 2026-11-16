// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { router } from './router'
import { DEATHWATCH_SHOWS_MOUNTAIN } from './lib/deathwatch/mountain'

// The Reliquarium is a lazy route, and the first test to ask for it would load it, and every gated module under it,
// inside that test. A gated module that loads inside a test has its top-level constants counted as covered by that test,
// and the mutation run then reports each constant a survivor. Loading it here, with the file, keeps them static.
await import('./views/Reliquarium.vue')

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

// The Librarius lists the posts at /reliquarium/librarius and opens one at /reliquarium/librarius/<post>. A post scrolls itself:
// to the message its address names, else to the divider, else to the newest message, and on Back to the message that was topmost.
// A jump to the top here, after any of those, would undo it. The list, on Back, goes where the reader left it.
describe('scroll behaviour: the Librarius', () => {
  const scroll = (to, from, saved) => router.options.scrollBehavior(to, from, saved)
  const POST = '200000000000000402'
  const SAVED = { left: 0, top: 640 }

  it('leaves every post to the page itself, with a hash or without, arriving or going Back', () => {
    for (const hash of ['', '#m-200000000000000450']) {
      for (const path of [`/reliquarium/librarius/${POST}`, `/reliquarium/librarius/${POST}/`]) {
        expect(scroll({ path, hash }, { path: '/reliquarium/librarius', hash: '' }), path + hash).toBe(false)
        expect(scroll({ path, hash }, { path: '/' , hash: '' }, SAVED), path + hash).toBe(false)
        expect(scroll({ path, hash }, { path, hash: '' }), path + hash).toBe(false)
      }
    }
  })

  it('leaves a post that is reached from another post to the page too', () => {
    expect(scroll({ path: '/reliquarium/librarius/200000000000000403', hash: '' }, { path: `/reliquarium/librarius/${POST}`, hash: '' })).toBe(false)
  })

  it('takes the topic list back to where it was left, on Back', () => {
    for (const path of ['/reliquarium/librarius', '/reliquarium/librarius/', '/reliquarium', '/reliquarium/']) {
      expect(scroll({ path, hash: '' }, { path: `/reliquarium/librarius/${POST}`, hash: '' }, SAVED), path).toBe(SAVED)
    }
  })

  it('takes the topic list to the top when it is arrived at rather than gone Back to', () => {
    for (const path of ['/reliquarium/librarius', '/reliquarium']) {
      expect(scroll({ path, hash: '' }, { path: '/' , hash: '' }, null), path).toEqual({ top: 0 })
      expect(scroll({ path, hash: '' }, { path: '/' , hash: '' }), path).toEqual({ top: 0 })
    }
  })

  it('does not take a saved position to any other page, as it never did', () => {
    for (const path of ['/reliquarium/clips', '/reliquarium/art', '/builds', '/reliquarium/librarius/abc', '/reliquarium/librarius/x/y']) {
      expect(scroll({ path, hash: '' }, { path: '/', hash: '' }, SAVED), path).toEqual({ top: 0 })
    }
  })

  it('takes only an address that is a Librarius post, not one that merely starts like it', () => {
    for (const path of [
      '/reliquarium/librarius/2000000000000004', // 16 digits
      '/reliquarium/librarius/2000000000000004020000', // 22 digits
      '/reliquarium/librarius/20000000000000040a',
      `/reliquarium/librarius/${POST}/extra`,
      `/reliquarium/clips/${POST}`,
      `/librarius/${POST}`,
    ]) {
      expect(scroll({ path, hash: '' }, { path: '/', hash: '' }), path).toEqual({ top: 0 })
    }
  })
})

describe('the Legacy Accolades route', () => {
  it('is its own page, and the thread route still takes thread ids', () => {
    expect(router.resolve('/accolades/legacy').name).toBe('legacy-accolades')
    expect(router.resolve('/accolades/legacy').meta).toMatchObject({ title: 'Legacy Accolades', ashOver: true })
    expect(router.resolve('/accolades').name).toBe('accolades')
    expect(router.resolve('/accolades/200000000000000001').name).toBe('accolades')
  })
})

describe('the Deathwatch routes', () => {
  it('draws no mountain behind Deathwatch, which is off planet, unless its keeper flips the one switch', () => {
    expect(DEATHWATCH_SHOWS_MOUNTAIN).toBe(false)
    expect(router.resolve('/deathwatch').meta.deathfire).toBe(DEATHWATCH_SHOWS_MOUNTAIN)
    expect(router.resolve('/deathwatch/eventtracker/players').meta.deathfire).toBe(DEATHWATCH_SHOWS_MOUNTAIN)
    // (the ash over the page is still marked, so the switch brings the veil back with the mountain)
    expect(router.resolve('/deathwatch').meta.ashOver).toBe(true)
    for (const path of ['/', '/builds', '/accolades', '/accolades/legacy']) expect(router.resolve(path).meta).not.toHaveProperty('deathfire')
  })

  it('has a hub and an area page under one parent, which carries the title and the ash over the plaque', () => {
    expect(router.resolve('/deathwatch').name).toBe('deathwatch')
    expect(router.resolve('/deathwatch').meta).toMatchObject({ title: 'Watch Fortress Ebonhold', ashOver: true })
    expect(router.resolve('/deathwatch/eventtracker/players').name).toBe('deathwatch-area')
    expect(router.resolve('/deathwatch/eventtracker/players').meta).toMatchObject({ title: 'Watch Fortress Ebonhold', ashOver: true })
  })

  it.each([
    ['/deathwatch', '/deathwatch'],
    ['/deathwatch/eventtracker/players', '/deathwatch/eventtracker/players'],
    ['/deathwatch/eventtracker', '/deathwatch/eventtracker/standings'],
    ['/deathwatch/eventtracker/', '/deathwatch/eventtracker/standings'],
    ['/deathwatch/eventtracker/nonsense', '/deathwatch/eventtracker/standings'],
    ['/deathwatch/armouringhall', '/deathwatch/armouringhall/standard/watchbrother'],
    ['/deathwatch/armouringhall/standard/companyheraldry', '/deathwatch/armouringhall/standard/companyheraldry'],
    ['/deathwatch/armouringhall/standard/battlebrother', '/deathwatch/armouringhall/standard/watchbrother'],
    ['/deathwatch/armouringhall/standard/A%20B', '/deathwatch/armouringhall/standard/watchbrother'],
    ['/deathwatch/armouringhall/specialist/nope', '/deathwatch/armouringhall/specialist/reclusiarc'],
    ['/deathwatch/armouringhall/specialist/A%20B', '/deathwatch/armouringhall/specialist/reclusiarc'],
    ['/deathwatch/armouringhall/watch-command/watchbrother', '/deathwatch/armouringhall/watch-command/watchsergeant'],
    ['/deathwatch/armouringhall/restricted-wargear/anything', '/deathwatch/armouringhall/restricted-wargear'],
    ['/deathwatch/chronicles', '/deathwatch/chronicles/hall-of-champions'],
    ['/deathwatch/administratum', '/deathwatch/administratum/enter-mission'],
  ])('takes %s to %s', async (from, to) => {
    await router.push(from)
    expect(router.currentRoute.value.fullPath).toBe(to)
  })

  it('keeps the query and the hash when it canonicalizes, so a ?scene= fixture survives', async () => {
    await router.push('/deathwatch/eventtracker?scene=denied#top')
    expect(router.currentRoute.value.fullPath).toBe('/deathwatch/eventtracker/standings?scene=denied#top')
  })

  it('answers an unknown area, or one in another case, with the not-found page at the address typed', async () => {
    for (const path of ['/deathwatch/nope', '/deathwatch/EventTracker/players', '/deathwatch/__proto__', '/deathwatch/constructor/x', '/deathwatch/nope/A%20B']) {
      await router.push(path)
      expect(router.currentRoute.value.name, path).toBe('not-found')
      expect(router.currentRoute.value.fullPath, path).toBe(path)
    }
  })
})

describe('the Reliquarium route', () => {
  it.each([
    ['/reliquarium', undefined],
    ['/reliquarium/librarius', 'librarius'],
    ['/reliquarium/clips', 'clips'],
    ['/reliquarium/art', 'art'],
    ['/reliquarium/submit', 'submit'],
    ['/reliquarium/mine', 'mine'],
    ['/reliquarium/review', 'review'],
  ])('takes %s, with the tab %s', (path, tab) => {
    const route = router.resolve(path)
    expect(route.name).toBe('reliquarium')
    expect(route.params.tab).toBe(tab)
    expect(route.meta.title).toBe('Reliquarium')
  })

  it('sends any other tab to the not-found page', () => {
    expect(router.resolve('/reliquarium/gallery').name).toBe('not-found')
    expect(router.resolve('/reliquarium/clips/extra').name).toBe('not-found')
  })

  it('loads the page on demand, so it is a chunk of its own and not part of the first load', () => {
    const route = router.getRoutes().find((r) => r.name === 'reliquarium')
    expect(route.components.default).toBeTypeOf('function')
    expect(route.components.default.length).toBe(0)
  })
})

describe('the Librarius post route', () => {
  const POST = '200000000000000402'

  it('takes a post by its id, and names it', () => {
    const route = router.resolve(`/reliquarium/librarius/${POST}`)
    expect(route.name).toBe('reliquarium-post')
    expect(route.params.postId).toBe(POST)
    expect(route.meta.title).toBe('Reliquarium')
  })

  it('takes ids of 17 to 20 digits, and no others', () => {
    for (const digits of [17, 18, 19, 20]) {
      expect(router.resolve(`/reliquarium/librarius/${'1'.repeat(digits)}`).name, String(digits)).toBe('reliquarium-post')
    }
    for (const digits of [1, 16, 21, 40]) {
      expect(router.resolve(`/reliquarium/librarius/${'1'.repeat(digits)}`).name, String(digits)).toBe('not-found')
    }
  })

  it('sends anything else under it to the not-found page', () => {
    for (const rest of ['abc', '20000000000000040a', '-20000000000000040', '2000000000000004.2', `${POST}/extra`, '%32%30%30', '__proto__']) {
      expect(router.resolve(`/reliquarium/librarius/${rest}`).name, rest).toBe('not-found')
    }
  })

  it('keeps the hash that names a message', () => {
    const route = router.resolve(`/reliquarium/librarius/${POST}#m-200000000000000450`)
    expect(route.name).toBe('reliquarium-post')
    expect(route.hash).toBe('#m-200000000000000450')
  })

  it('shares the Reliquarium page with the tabs, so that opening a post is no new page load', () => {
    const tab = router.getRoutes().find((r) => r.name === 'reliquarium')
    const post = router.getRoutes().find((r) => r.name === 'reliquarium-post')
    expect(post.components.default).toBeTypeOf('function')
    expect(post.components.default.length).toBe(0)
    expect(tab.components.default).toBeTypeOf('function')
  })

  it('resolves to the very component the tabs use, so that moving between a tab and a post keeps the page and its checks', async () => {
    await router.push('/reliquarium/clips')
    const tab = router.currentRoute.value.matched[0].components.default
    await router.push(`/reliquarium/librarius/${POST}`)
    const post = router.currentRoute.value.matched[0].components.default
    expect(router.currentRoute.value.name).toBe('reliquarium-post')
    expect(tab).toBeTypeOf('object')
    expect(post).toBe(tab)
  })

  it('does not make the post address a tab', () => {
    expect(router.resolve(`/reliquarium/librarius/${POST}`).params.tab).toBeUndefined()
  })
})
