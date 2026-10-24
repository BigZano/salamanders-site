import { describe, it, expect } from 'vitest'
import { SCENES, sceneOf } from './scenes'

describe('SCENES', () => {
  it('names the six gate states and the two data scenes a designer can ask for', () => {
    expect(SCENES).toEqual(['allowed', 'commander', 'denied', 'signin', 'checking', 'unavailable', 'empty', 'active-event'])
  })
})

describe('sceneOf', () => {
  it.each([
    ['allowed', 'allowed', false],
    ['commander', 'allowed', true],
    ['denied', 'denied', false],
    ['signin', 'signin', false],
    ['checking', 'checking', false],
    ['unavailable', 'unavailable', false],
    ['empty', 'allowed', true],
    ['active-event', 'allowed', true],
  ])('turns the %s scene into status %s (commander: %s)', (name, status, commander) => {
    expect(sceneOf(name)).toEqual({ _fixture: true, scene: name, status, commander })
  })

  it('gives the allowed scene for an unknown or non-string name', () => {
    for (const name of ['bogus', '', '1', '__proto__', 'constructor', undefined, null, 5, ['denied']]) {
      expect(sceneOf(name), String(name)).toEqual({ _fixture: true, scene: 'allowed', status: 'allowed', commander: false })
    }
  })
})
