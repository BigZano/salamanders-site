// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { scrollBehavior } from './motion'

afterEach(() => {
  delete window.matchMedia
})

describe('scrollBehavior', () => {
  it("is 'auto' (no gliding) when the visitor prefers reduced motion", () => {
    window.matchMedia = (query) => ({ matches: query === '(prefers-reduced-motion: reduce)' })
    expect(scrollBehavior()).toBe('auto')
  })

  it("is 'smooth' when motion is welcome", () => {
    window.matchMedia = () => ({ matches: false })
    expect(scrollBehavior()).toBe('smooth')
  })

  it("is 'smooth' where matchMedia does not exist", () => {
    delete window.matchMedia
    expect(scrollBehavior()).toBe('smooth')
  })
})
