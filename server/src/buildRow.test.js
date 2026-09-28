import { describe, it, expect } from 'vitest'
import { rowToBuild, publicBuild } from './buildRow'

const row = {
  id: 7, title: 'Melta Bulwark', role: 'Frontline', notes: 'n', class_name: 'Bulwark', level: 25, prestige: 2,
  prestige_picks: [], perks: {}, perk_ids: {}, justifications: {}, weapons: {}, weapon_perks: {},
  author_discord_id: '75633559351595008', author_discord_username: 'secret-handle', created_at: 't',
}

describe('publicBuild', () => {
  it('names the author by display name and never carries the username', () => {
    const seen = []
    const out = publicBuild(rowToBuild(row), (id) => (seen.push(id), 'Vulkan'))
    expect(seen).toEqual(['75633559351595008'])
    expect(out.author).toEqual({ id: '75633559351595008', displayName: 'Vulkan' })
    expect(JSON.stringify(out)).not.toContain('secret-handle')
    expect(JSON.stringify(out)).not.toContain('username')
  })

  it('keeps every other build field as rowToBuild shaped it', () => {
    const { author: _a, ...rest } = rowToBuild(row)
    const { author: _b, ...pub } = publicBuild(rowToBuild(row), () => 'x')
    expect(pub).toEqual(rest)
  })

  it('does not modify the build it was given', () => {
    const b = rowToBuild(row)
    publicBuild(b, () => 'x')
    expect(b.author).toEqual({ id: '75633559351595008', username: 'secret-handle' })
  })
})
