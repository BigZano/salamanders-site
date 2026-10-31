// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import companies from '../data/companies.json'

// The Notable Server Members on the Companies page: real names, kept on the server and shown to a signed-in guild
// member only. The roster is not under test here, so its requests simply never answer. Invented names only.
let auth
vi.mock('../stores/auth', () => ({ useAuth: () => auth }))
vi.mock('../lib/rosterApi', () => ({
  getRoster: vi.fn(() => new Promise(() => {})),
  getInfirmary: vi.fn(() => new Promise(() => {})),
  getPublicRoster: vi.fn(() => new Promise(() => {})),
}))
vi.mock('../lib/buildsApi', async (importOriginal) => ({ ...(await importOriginal()), getCompanyNotables: vi.fn() }))
import { getCompanyNotables } from '../lib/buildsApi'
import Companies from './Companies.vue'

const member = () => reactive({ token: 'tok', member: { id: '200000000000000001', isMember: true }, signedIn: true, signIn: vi.fn() })
const nonMember = () => reactive({ token: 'tok', member: { id: '200000000000000002', isMember: false }, signedIn: true, signIn: vi.fn() })
const signedOut = () => reactive({ token: null, member: null, signedIn: false, signIn: vi.fn() })

const withCards = companies.filter((c) => c.sections.some((s) => s.notables))
const [A, B, C] = withCards
const refused = (status) => Object.assign(new Error('refused'), { status })
const ANSWER = { [A.id]: [['Test Member One', 'A line about them.']], [C.id]: [['Test Member Two', 'Another line.', 'And one more.']] }
const NOTE = 'Notable server members are shown to signed-in guild members.'
const AGAIN = 'Sign in again to see the notable server members.'
const heading = (c) => c.sections.find((s) => s.notables).h

const mounted = []
const render = async () => {
  const w = mount(Companies, { attachTo: document.body })
  mounted.push(w)
  await flushPromises()
  return w
}
const article = (w, c) => w.get(`#${c.id}`)

beforeEach(() => {
  setActivePinia(createPinia())
  getCompanyNotables.mockReset()
  getCompanyNotables.mockResolvedValue(ANSWER)
  auth = member()
  window.history.replaceState(null, '', '/companies')
})
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()))

describe('Companies: the notable members', () => {
  it('a signed-in guild member gets the cards, company by company, and no heading over nothing', async () => {
    const w = await render()
    expect(getCompanyNotables).toHaveBeenCalledWith('tok')
    expect(article(w, A).findAll('.member-name').map((n) => n.text())).toEqual(['Test Member One'])
    expect(article(w, C).findAll('.member-name').map((n) => n.text())).toEqual(['Test Member Two'])
    expect(article(w, C).findAll('.member-blurb').map((n) => n.text())).toEqual(['Another line.', 'And one more.'])
    // the server had none for B: its notables section is left out, the rest of its story stays
    expect(article(w, B).text()).not.toContain(heading(B))
    expect(article(w, B).find('.member').exists()).toBe(false)
    expect(article(w, B).find('.notables-note').exists()).toBe(false)
    expect(article(w, B).find('.block').exists()).toBe(true)
  })

  it('a visitor who is signed out is not asked, and sees the note where the cards go', async () => {
    auth = signedOut()
    const w = await render()
    expect(getCompanyNotables).not.toHaveBeenCalled()
    expect(w.findAll('.notables-note')).toHaveLength(withCards.length)
    expect(w.get('.notables-note').text()).toBe(NOTE)
    expect(w.find('.member').exists()).toBe(false)
    expect(article(w, A).text()).toContain(heading(A))
  })

  it('a signed-in visitor the server says is not a guild member sees the note, with no names', async () => {
    auth = nonMember()
    getCompanyNotables.mockRejectedValue(refused(403))
    const w = await render()
    expect(w.findAll('.notables-note')).toHaveLength(withCards.length)
    expect(w.get('.notables-note').text()).toBe(NOTE)
    expect(w.find('.member').exists()).toBe(false)
  })

  it('a stored flag of false does not hide the cards from someone the server says is a member', async () => {
    auth = nonMember()
    const w = await render()
    expect(w.findAll('.member')).toHaveLength(2)
    expect(w.find('.notables-note').exists()).toBe(false)
  })

  it('someone who still looks signed in but whose token has run out is told to sign in again', async () => {
    auth = reactive({ token: null, member: { id: '200000000000000001', isMember: true }, signedIn: true, signIn: vi.fn() })
    const w = await render()
    expect(w.findAll('.notables-note')).toHaveLength(withCards.length)
    expect(w.get('.notables-note').text()).toBe(AGAIN)
    expect(w.find('.member').exists()).toBe(false)
  })

  it('a token the server no longer takes is told the same', async () => {
    getCompanyNotables.mockRejectedValue(refused(401))
    const w = await render()
    expect(w.get('.notables-note').text()).toBe(AGAIN)
    expect(w.find('.member').exists()).toBe(false)
  })

  it('a token with no member behind it is not asked either', async () => {
    auth = reactive({ token: 'tok', member: null, signedIn: false, signIn: vi.fn() })
    const w = await render()
    expect(getCompanyNotables).not.toHaveBeenCalled()
    expect(w.findAll('.notables-note')).toHaveLength(withCards.length)
    expect(w.find('.member').exists()).toBe(false)
  })

  it('a member the server refuses gets the same note, with no names', async () => {
    getCompanyNotables.mockRejectedValue(refused(403))
    const w = await render()
    expect(w.get('.notables-note').text()).toBe(NOTE)
    expect(w.find('.member').exists()).toBe(false)
  })

  it('a server that cannot be reached says so, with no names', async () => {
    getCompanyNotables.mockRejectedValue(refused(503))
    const w = await render()
    expect(w.get('.notables-note').text()).toBe('The notable server members could not be loaded. Try again later.')
    expect(w.find('.member').exists()).toBe(false)
  })

  it('the cards go the moment the member signs out', async () => {
    const w = await render()
    expect(w.findAll('.member')).toHaveLength(2)
    auth.member = null
    auth.token = null
    await flushPromises()
    expect(w.find('.member').exists()).toBe(false)
    expect(w.text()).not.toContain('Test Member One')
    expect(w.findAll('.notables-note')).toHaveLength(withCards.length)
  })

  it('leaves the search alone: it finds companies by title, subtitle and keywords, not by a member’s name', async () => {
    const w = await render()
    await w.get('.c-search').setValue('Test Member One')
    expect(w.find('.c-empty').exists()).toBe(true)
  })
})
