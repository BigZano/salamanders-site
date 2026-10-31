import { describe, expect, it } from 'vitest'
import { STANDARD, UNIFORMS, uniformFor } from './armour'
import { ARMOUR_TEXTS, RW_TEXTS, armourFields, heraldryNotes, noteKey, notesOf, restrictedWargear } from './armourTexts'

describe('armourFields', () => {
  it('names a uniform’s introduction, then each part’s notes, in the order the page shows them', () => {
    expect(armourFields(uniformFor('specialist', 'apothecarion')).map(([k]) => k)).toEqual([
      'ah_apothecarion_lead',
      'ah_apothecarion_helm',
      'ah_apothecarion_pauldrons',
      'ah_apothecarion_wargear',
      'ah_apothecarion_breastplate',
      'ah_apothecarion_gauntlets',
      'ah_apothecarion_greaves',
    ])
  })

  it('has no introduction for the Watch Brother, who has none', () => {
    expect(armourFields(STANDARD[0])[0][0]).toBe('ah_watchbrother_helm')
  })

  it('gives Company Heraldry a note under each of its four sections', () => {
    expect(armourFields(STANDARD[1])).toEqual([
      ['ah_companyheraldry_companies1', 'Battle Companies I–IV: notes (one paragraph per line)'],
      ['ah_companyheraldry_markings', 'Watch Company Markings: notes (one paragraph per line)'],
      ['ah_companyheraldry_companies2', 'Battle Companies V–VII: notes (one paragraph per line)'],
      ['ah_companyheraldry_alternative', 'Alternative Colors: notes (one paragraph per line)'],
    ])
    expect(ARMOUR_TEXTS.ah_companyheraldry_companies1).toBe('')
    expect(ARMOUR_TEXTS.ah_companyheraldry_markings).toBe(
      'Painted Abaddon Black with a Mephiston Red stripe. Fully black markings denote Watch Company Primus.',
    )
  })

  it('labels each text by its uniform and part', () => {
    const [lead, helm] = armourFields(uniformFor('watch-command', 'watchsergeant'))
    expect(lead[1]).toMatch(/^Watch Sergeant: introduction/)
    expect(helm[1]).toMatch(/^Watch Sergeant · Helm: notes/)
  })
})

describe('ARMOUR_TEXTS', () => {
  it('holds the introductions as the page wrote them, linking the uniforms they build on', () => {
    expect(ARMOUR_TEXTS.ah_apothecarion_lead).toBe(
      'In addition to the [standard Watch-Brother Uniform](/deathwatch/armouringhall/standard/watchbrother), Apothecaries and higher-ranking members of the Apothecarion may use the following colors and markings:',
    )
    expect(ARMOUR_TEXTS.ah_watchsergeant_lead).toBe(
      'In addition to the [standard Watch-Brother Uniform](/deathwatch/armouringhall/standard/watchbrother) and the [Specialist](/deathwatch/armouringhall/specialist/apothecarion) markings, Watch Sergeants may use the following colors and markings:',
    )
    expect(ARMOUR_TEXTS.ah_watchspecialist_lead).toBe(
      'In addition to the [Specialist](/deathwatch/armouringhall/specialist/apothecarion) markings, Watch Specialists may use the following colors and markings:',
    )
  })

  it('holds each part’s notes one a line, and a text for every field of every uniform', () => {
    expect(ARMOUR_TEXTS.ah_watchbrother_pauldrons).toBe(
      'Right: the color scheme of your Company of origin (see Company Heraldry).\nLeft: the Deathwatch Pauldron.',
    )
    expect(ARMOUR_TEXTS.ah_watchbrother_breastplate).toBe('')
    const keys = Object.values(UNIFORMS).flatMap((list) => list.flatMap((u) => armourFields(u).map(([k]) => k)))
    expect(Object.keys(ARMOUR_TEXTS).sort()).toEqual([...keys].sort())
  })
})

describe('notesOf', () => {
  const helm = 'Helm'
  const u = uniformFor('specialist', 'librarium')
  it('reads a part’s notes from the page texts, one a line, else the defaults', () => {
    expect(notesOf(undefined, u, helm)).toEqual(['Pattern: Mask Pattern.'])
    expect(notesOf({ [noteKey(u, helm)]: 'One\n\n  Two  \n' }, u, helm)).toEqual(['One', 'Two'])
    expect(notesOf({ [noteKey(u, helm)]: '' }, u, helm)).toEqual([])
  })
})

describe('heraldryNotes', () => {
  it('reads a Company Heraldry section’s paragraphs, one a line, as inline segments, else the defaults', () => {
    expect(heraldryNotes(undefined, 'companies1')).toEqual([])
    expect(heraldryNotes(undefined, 'companies2')).toHaveLength(1)
    expect(heraldryNotes({ ah_companyheraldry_alternative: 'One **bold**\n\nTwo' }, 'alternative')).toEqual([
      [{ k: '', t: 'One ' }, { k: 'b', t: 'bold' }],
      [{ k: '', t: 'Two' }],
    ])
  })
})

describe('restrictedWargear', () => {
  it('reads the old site’s texts by default: heading lines, introduction, two cards and a footnote', () => {
    const r = restrictedWargear()
    expect(r.title).toEqual([{ k: '', t: 'Restricted / Locked Wargear' }])
    expect(r.sub).toEqual([{ k: '', t: 'Wargear that is Restricted or completely Locked from being worn.' }])
    expect(r.heading).toEqual([{ k: '', t: 'Non-Active Deployment' }])
    expect(r.cards.map((c) => [c.set, c.part])).toEqual([
      ['Mark VIII Errant Deathwatch', 'L. Pauldron'],
      ['Deathwatch', 'L. Gauntlet (Heroic)'],
    ])
    expect(r.cards[0].unlock).toContainEqual({ k: 'b', t: 'one (1) Tour of Duty' })
    expect(r.footnote.length).toBeGreaterThan(0)
    // No Discord link in the defaults: its ids may not be in the repo.
    expect(JSON.stringify(RW_TEXTS)).not.toContain('discord.com')
  })

  it('takes what the data holds, drops an empty card, and shows nothing for an empty text', () => {
    const r = restrictedWargear({ rw_h: 'Only a title', rw_c1: '', rw_c2: 'Set\nPiece', rw_f: '', rw_i: 7 })
    expect(r.title).toEqual([{ k: '', t: 'Only a title' }])
    expect(r.sub).toEqual([])
    expect(r.heading).toEqual([])
    expect(r.cards).toEqual([{ set: 'Set', part: 'Piece', unlock: [], proof: [] }])
    expect(r.footnote).toEqual([])
    expect(r.intro.length).toBeGreaterThan(0)
  })
})
