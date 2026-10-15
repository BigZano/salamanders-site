// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { useOpenBranches } from './useOpenBranches'

beforeEach(() => {
  window.history.replaceState(null, '', '/roster')
})

describe('useOpenBranches', () => {
  it('starts closed', () => {
    const o = useOpenBranches()
    expect(o.isOpen('company-1')).toBe(false)
    expect(o.open.value.size).toBe(0)
  })

  it('toggle opens, then closes', () => {
    const o = useOpenBranches()
    o.toggle('company-1')
    expect(o.isOpen('company-1')).toBe(true)
    o.toggle('company-1')
    expect(o.isOpen('company-1')).toBe(false)
  })

  it('replaces the set on every change, so watchers see it', () => {
    const o = useOpenBranches()
    const before = o.open.value
    o.toggle('forge')
    expect(o.open.value).not.toBe(before)
  })

  it('openKey is idempotent and does not replace the set when nothing changes', () => {
    const o = useOpenBranches()
    o.openKey('forge')
    const after = o.open.value
    o.openKey('forge')
    expect(o.open.value).toBe(after)
    expect(o.isOpen('forge')).toBe(true)
  })

  it('setAll opens or closes the given keys and leaves the others alone', () => {
    const o = useOpenBranches()
    o.openKey('reclusiam')
    o.setAll(['company-1', 'company-2'], true)
    expect([...o.open.value].sort()).toEqual(['company-1', 'company-2', 'reclusiam'])
    o.setAll(['company-1', 'company-2'], false)
    expect([...o.open.value]).toEqual(['reclusiam'])
  })

  it('allOpen is true only when every given key is open, and false for none', () => {
    const o = useOpenBranches()
    expect(o.allOpen([])).toBe(false)
    o.setAll(['a', 'b'], true)
    expect(o.allOpen(['a', 'b'])).toBe(true)
    expect(o.allOpen(['a', 'b', 'c'])).toBe(false)
  })

  it('ignores a stale key that is no longer in the list', () => {
    const o = useOpenBranches()
    o.setAll(['gone', 'a'], true)
    expect(o.allOpen(['a'])).toBe(true)
  })
})

describe('useOpenBranches: hashKey', () => {
  const at = (hash) => window.history.replaceState(null, '', `/roster${hash}`)

  it('reads #company-3', () => {
    at('#company-3')
    expect(useOpenBranches().hashKey()).toBe('company-3')
  })

  it('decodes an encoded key', () => {
    at('#company%2D3')
    expect(useOpenBranches().hashKey()).toBe('company-3')
  })

  it('ignores the sign-in fragment, an empty hash, and a bad escape, without throwing', () => {
    for (const hash of ['#access_token=abc&expires_in=3600', '#', '', '#%E0%A4%A']) {
      at(hash)
      expect(useOpenBranches().hashKey(), hash).toBeNull()
    }
  })
})
