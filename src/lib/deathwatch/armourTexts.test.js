import { describe, expect, it } from 'vitest'
import { STANDARD, UNIFORMS, uniformFor } from './armour'
import { inline } from './notables'
import { ARMOUR_TEXTS, LEGACY_KEYS, RW_TEXTS, armourFields, heraldryNotes, leadOf, legacyText, noteKey, notesOf, replacedKeys, restrictedWargear } from './armourTexts'

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

  it('gives Company Heraldry a note for every company, the markings and the alternative colours', () => {
    expect(armourFields(STANDARD[1])).toEqual([
      ['ah_companyheraldry_companies', 'Battle Companies: notes (one paragraph per line)'],
      ['ah_companyheraldry_markings', 'Watch Company Markings: notes (one paragraph per line)'],
      ['ah_companyheraldry_alternative', 'Alternative Colors: notes (one paragraph per line)'],
    ])
    expect(ARMOUR_TEXTS.ah_companyheraldry_companies).toBe(
      "These colors follow the standards of each Battle-Brother's own Company and also appear in the regular uniform guidelines.",
    )
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
      'In addition to the [standard Watch-Brother Uniform](/deathwatch/armouringhall/standard/watchbrother), Watch Sergeants may use the following colors and markings:',
    )
    expect(ARMOUR_TEXTS.ah_watchapothecary_lead).toBe(
      'In addition to the [Specialist Uniform](/deathwatch/armouringhall/specialist/apothecarion), Watch Apothecaries may use the following colors and markings:',
    )
    expect(ARMOUR_TEXTS.ah_watchlibrarian_lead).toBe(
      'In addition to the [Specialist Uniform](/deathwatch/armouringhall/specialist/librarium), Watch Librarians may use the following colors and markings:',
    )
    expect(ARMOUR_TEXTS.ah_watchtechmarine_breastplate).toBe('Backpack: in the colours of your [Specialist Uniform](/deathwatch/armouringhall/specialist/mechanicus).')
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
    expect(heraldryNotes(undefined, 'alternative')).toEqual([])
    expect(heraldryNotes(undefined, 'companies')).toHaveLength(1)
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

// Review of #53: texts stored under the keys the hall used before 2.0 must not silently disappear.
describe('the keys before Armouring Hall 2.0', () => {
  const apothecary = uniformFor('watch-command', 'watchapothecary')
  const SPECIALISTS = ['watchapothecary', 'watchlibrarian', 'watchchaplain', 'watchtechmarine']

  it('maps Company Heraldry’s two Battle Companies notes to the one, and the Watch Specialist to each of the four', () => {
    expect(LEGACY_KEYS.ah_companyheraldry_companies).toEqual(['ah_companyheraldry_companies1', 'ah_companyheraldry_companies2'])
    for (const s of SPECIALISTS) {
      expect(LEGACY_KEYS[`ah_${s}_lead`], s).toEqual(['ah_watchspecialist_lead'])
      expect(LEGACY_KEYS[`ah_${s}_helm`], s).toEqual(['ah_watchspecialist_helm'])
    }
    // Nothing else had an older key.
    const owners = new Set(Object.keys(LEGACY_KEYS).map((k) => k.split('_')[1]))
    expect([...owners].sort()).toEqual(['companyheraldry', ...SPECIALISTS].sort())
  })

  it('shows an old Battle Companies note, both halves in page order, until the new key is stored', () => {
    const tx = { ah_companyheraldry_companies1: 'First.', ah_companyheraldry_companies2: 'Second.' }
    expect(heraldryNotes(tx, 'companies')).toEqual([inline('First.'), inline('Second.')])
    expect(legacyText(tx, 'ah_companyheraldry_companies')).toBe('First.\nSecond.')
    expect(legacyText({ ...tx, ah_companyheraldry_companies: 'New.' }, 'ah_companyheraldry_companies')).toBe('First.\nSecond.')
    expect(heraldryNotes({ ...tx, ah_companyheraldry_companies: 'New.' }, 'companies')).toEqual([inline('New.')])
  })

  it('keeps an emptied old note emptied, without a blank line beside the other', () => {
    expect(legacyText({ ah_companyheraldry_companies1: '', ah_companyheraldry_companies2: '' }, 'ah_companyheraldry_companies')).toBe('')
    expect(heraldryNotes({ ah_companyheraldry_companies1: '', ah_companyheraldry_companies2: '' }, 'companies')).toEqual([])
    expect(legacyText({ ah_companyheraldry_companies1: '  ', ah_companyheraldry_companies2: 'B' }, 'ah_companyheraldry_companies')).toBe('B')
  })

  it('shows an old Watch Specialist text on each specialist, until that one has its own', () => {
    const tx = { ah_watchspecialist_helm: 'Old helm note.', ah_watchspecialist_lead: 'Old lead.' }
    expect(notesOf(tx, apothecary, 'Helm')).toEqual(['Old helm note.'])
    expect(leadOf(tx, apothecary)).toEqual(inline('Old lead.'))
    expect(notesOf({ ...tx, ah_watchapothecary_helm: 'Mine.' }, apothecary, 'Helm')).toEqual(['Mine.'])
    expect(notesOf(tx, uniformFor('watch-command', 'watchlibrarian'), 'Helm')).toEqual(['Old helm note.'])
  })

  it('reads only text, and nothing when no old key is stored or the key never had one', () => {
    expect(legacyText({ ah_watchspecialist_helm: 7 }, 'ah_watchapothecary_helm')).toBeUndefined()
    expect(legacyText({}, 'ah_watchapothecary_helm')).toBeUndefined()
    expect(legacyText(undefined, 'ah_watchapothecary_helm')).toBeUndefined()
    expect(legacyText({ ah_watchspecialist_helm: 'x' }, 'ah_librarium_helm')).toBeUndefined()
    expect(legacyText({ __proto__: 'x' }, '__proto__')).toBeUndefined()
    expect(notesOf({}, apothecary, 'Helm')).toEqual(ARMOUR_TEXTS.ah_watchapothecary_helm.split('\n').filter(Boolean))
  })

  it('lets a save drop only the old keys no other new key reads', () => {
    expect(replacedKeys('ah_companyheraldry_companies')).toEqual(['ah_companyheraldry_companies1', 'ah_companyheraldry_companies2'])
    expect(replacedKeys('ah_watchapothecary_helm')).toEqual([])
    expect(replacedKeys('ah_librarium_helm')).toEqual([])
    expect(replacedKeys('__proto__')).toEqual([])
  })
})
