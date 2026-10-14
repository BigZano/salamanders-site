import { describe, it, expect } from 'vitest'
import { listDrift } from './drift.mjs'

const item = (key, text) => ({ key, text })

describe('listDrift', () => {
  it('reports nothing for identical lists', () => {
    const a = [item('Fast Reload', 'Reload 10% faster'), item('Elite Hunter', 'Deal 50% more damage')]
    expect(listDrift(a, [...a])).toEqual({ added: [], removed: [], changed: [] })
  })

  it('calls a change numeric when the numbers differ', () => {
    const r = listDrift([item('Able Precision', 'Lasts for 5 seconds')], [item('Able Precision', 'Lasts for 10 seconds')])
    expect(r.changed).toEqual([
      { key: 'Able Precision', old: 'Lasts for 5 seconds', new: 'Lasts for 10 seconds', kind: 'numeric' },
    ])
  })

  it('calls a change wording when the numbers are the same', () => {
    const r = listDrift(
      [item('Fast Reload', 'Reload all Weapons 10% faster')],
      [item('Fast Reload', 'This Weapon reloads 10% faster')],
    )
    expect(r.changed).toHaveLength(1)
    expect(r.changed[0].kind).toBe('wording')
  })

  it('compares decimals as numbers, not digit runs', () => {
    const r = listDrift([item('A', 'Deal 1.5 damage')], [item('A', 'Deal 15 damage')])
    expect(r.changed[0].kind).toBe('numeric')
  })

  it('splits keys that exist on one side only into added and removed', () => {
    const r = listDrift([item('Old', 'x 1'), item('Same', 'y')], [item('Same', 'y'), item('New', 'z 2')])
    expect(r.added).toEqual(['New'])
    expect(r.removed).toEqual(['Old'])
    expect(r.changed).toEqual([])
  })

  it('treats a whitespace-only difference as no change', () => {
    expect(listDrift([item('A', 'Deal  5 damage')], [item('A', 'Deal 5 damage ')]).changed).toEqual([])
  })
})
