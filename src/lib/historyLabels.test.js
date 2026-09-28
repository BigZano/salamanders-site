import { describe, it, expect } from 'vitest'
import { historyLabel } from './historyLabels'

const actor = { id: '1', username: 'tm' }
describe('historyLabel', () => {
  it.each([
    [{ subject: 'perk_correction', action: 'created', actor, snapshot: { target: 'Las Fusil', quality: 'Relic', op: 'remove', perkName: 'Perpetual Velocity' } }, 'tm removed Perpetual Velocity — Las Fusil / Relic'],
    [{ subject: 'perk_correction', action: 'reverted', actor, snapshot: { target: 'Tactical', quality: null, op: 'edit', perkName: 'Stim' } }, 'tm reverted: edited Stim — Tactical'],
    [{ subject: 'build', action: 'deleted', actor, snapshot: { title: 'Melta Bulwark', author: { username: 'poster' } } }, 'tm deleted build "Melta Bulwark" by poster'],
    [{ subject: 'privilege', action: 'revoked', actor, snapshot: { username: 'bad', reason: 'vandalism' } }, 'tm revoked privileges for bad: vandalism'],
    [{ subject: 'privilege', action: 'reinstated', actor, snapshot: { username: 'bad' } }, 'tm reinstated privileges for bad'],
  ])('%#', (event, want) => {
    expect(historyLabel(event)).toBe(want)
  })
})
