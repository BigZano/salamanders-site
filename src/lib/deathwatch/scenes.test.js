import { describe, it, expect } from 'vitest'
import { SCENES, sceneOf } from './scenes'

describe('SCENES', () => {
  it('names the seven gate states and the two data scenes a designer can ask for', () => {
    expect(SCENES).toEqual(['allowed', 'commander', 'command', 'denied', 'signin', 'checking', 'unavailable', 'empty', 'active-event'])
  })
})

describe('sceneOf', () => {
  it.each([
    ['allowed', 'allowed', false, false],
    ['commander', 'allowed', true, true],
    ['command', 'allowed', false, true],
    ['denied', 'denied', false, false],
    ['signin', 'signin', false, false],
    ['checking', 'checking', false, false],
    ['unavailable', 'unavailable', false, false],
    ['empty', 'allowed', true, true],
    ['active-event', 'allowed', true, true],
  ])('turns the %s scene into status %s (commander: %s, command: %s)', (name, status, commander, command) => {
    expect(sceneOf(name)).toEqual({ _fixture: true, scene: name, status, commander, command })
  })

  it('gives the allowed scene for an unknown or non-string name', () => {
    for (const name of ['bogus', '', '1', '__proto__', 'constructor', undefined, null, 5, ['denied']]) {
      expect(sceneOf(name), String(name)).toEqual({ _fixture: true, scene: 'allowed', status: 'allowed', commander: false, command: false })
    }
  })
})
