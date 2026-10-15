// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { profileFor, routeProfiles } from './fireTuning'

describe('volcano route profiles', () => {
  it('/roster has its own profile instead of the unrouted fallback', () => {
    expect(routeProfiles['/roster']).toBeDefined()
    expect(profileFor('/roster')).not.toBe(routeProfiles['*'])
  })

  it('/roster is a calm, low horizon: a long reading page of panels must not sit under a glaring peak', () => {
    const { density, scale } = profileFor('/roster')
    expect(density).toBeLessThanOrEqual(0.6)
    expect(scale).toBeLessThanOrEqual(0.6)
  })
})
