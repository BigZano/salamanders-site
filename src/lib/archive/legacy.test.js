import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  LEGACY_FILE, NAME_MAX, ROLE_NAME_MAX, BLURB_MAX,
  auditLegacy, legacyView, luminance, readableColor, canonicalLegacy,
} from './legacy'

const ROLE_A = '810000000000000001'
const ROLE_B = '810000000000000002'
const USER_A = '820000000000000001'
const USER_B = '820000000000000002'

const valid = () => ({
  snapshot: '2026-10-16T12:00:00.000Z',
  accolades: [
    { roleId: ROLE_A, name: 'Fixture Laurel', color: '#d4a017', blurb: 'One.\n\nTwo.', holders: [{ id: USER_A, name: 'Alpha Holder' }, { id: USER_B, name: 'beta holder' }] },
    { roleId: ROLE_B, name: 'Fixture Ember', color: null, blurb: 'Three.', holders: [] },
  ],
})
const edit = (fn) => {
  const l = valid()
  fn(l)
  return l
}
const deepFreeze = (o) => {
  Object.values(o).forEach((v) => typeof v === 'object' && v !== null && deepFreeze(v))
  return Object.freeze(o)
}

// Values that look like a snowflake only after coercion, or are nearly one.
const BAD_IDS = [
  undefined, null, 810000000000000001, ['810000000000000001'], {}, '', '8100000000000000', '8'.repeat(16), '8'.repeat(21),
  'x810000000000000001', '810000000000000001x', '810000000000000001\n', ' 810000000000000001', '81000000000000000a1',
]
const BAD_TEXT = [undefined, null, 5, ['x'], {}, '', ' x', 'x ', '\u200b', 'a\u200bb', 'a\u202eb', 'a\u0007b', 'a\tb', 'a\nb']
// it.each spreads an array case into several arguments; wrapping each value keeps it whole.
const each = (list) => list.map((v) => [v])

describe('auditLegacy', () => {
  it('accepts a valid payload, including a member under two accolades and a role with no holders', () => {
    expect(auditLegacy(valid())).toEqual([])
    expect(auditLegacy(edit((l) => l.accolades[1].holders.push({ id: USER_A, name: 'Alpha Holder' })))).toEqual([])
  })

  it.each(each([null, undefined, 0, '', 'x', [], true]))('rejects %j as the whole payload', (v) => {
    expect(auditLegacy(v)).toEqual(['legacy: not an object'])
  })

  it.each([
    undefined, null, 42, '', '2026-10-16', '2026-10-16T12:00:00Z', '2026-10-16T12:00:00.000+00:00',
    '2026-13-01T00:00:00.000Z', '2026-02-31T00:00:00.000Z', ' 2026-10-16T12:00:00.000Z', '2026-10-16T12:00:00.000Z\n',
  ])('rejects snapshot %j', (snapshot) => {
    expect(auditLegacy(edit((l) => (l.snapshot = snapshot))).join()).toMatch(/snapshot/)
  })
  it('rejects an extended-year instant and an array that reads like one, and words the problem exactly', () => {
    for (const snapshot of ['+010000-01-01T00:00:00.000Z', ['2026-10-16T12:00:00.000Z']]) {
      expect(auditLegacy(edit((l) => (l.snapshot = snapshot)))).toEqual(['legacy: snapshot is not a UTC instant like 2026-01-02T03:04:05.000Z'])
    }
  })

  it.each(each([undefined, null, [], {}, 'x']))('rejects accolades %j and says only that', (accolades) => {
    expect(auditLegacy(edit((l) => (l.accolades = accolades)))).toEqual(['legacy: accolades must be a non-empty array'])
  })

  it.each(each([null, 5, 'x', [], undefined]))('rejects an accolade that is %j', (a) => {
    expect(auditLegacy(edit((l) => (l.accolades[0] = a)))).toEqual(['accolade 1: not an object'])
  })

  it.each(each(BAD_IDS))('rejects roleId %j', (roleId) => {
    expect(auditLegacy(edit((l) => (l.accolades[0].roleId = roleId))).join()).toMatch(/accolade 1: roleId is not a snowflake/)
  })

  it('rejects a repeated roleId, but reports two bad ids as bad, not as repeated', () => {
    expect(auditLegacy(edit((l) => (l.accolades[1].roleId = ROLE_A)))).toEqual(['accolade 2: roleId appears twice'])
    const both = auditLegacy(edit((l) => ((l.accolades[0].roleId = 'nope'), (l.accolades[1].roleId = 'nope'))))
    expect(both).toEqual(['accolade 1: roleId is not a snowflake', 'accolade 2: roleId is not a snowflake'])
  })

  it.each(each([...BAD_TEXT, 'x'.repeat(ROLE_NAME_MAX + 1)]))('rejects role name %j', (name) => {
    expect(auditLegacy(edit((l) => (l.accolades[0].name = name))).join()).toMatch(/accolade 1: name/)
  })

  it.each(each([undefined, '', 'red', '#fff', '#12345', '#1234567', 'ff0000', '#gg0000', '#FF000G', 5, ['#ff0000'], '#ff0000 ', ' #ff0000']))(
    'rejects color %j',
    (color) => {
      expect(auditLegacy(edit((l) => (l.accolades[0].color = color))).join()).toMatch(/accolade 1: color/)
    },
  )
  it.each(['#FF00aa', '#000000', null])('accepts color %j', (color) => {
    expect(auditLegacy(edit((l) => (l.accolades[0].color = color)))).toEqual([])
  })

  it.each([undefined, null, 5, '', ' x', 'x ', 'x\n', '\nx', 'a\tb', 'a\rb', 'a\u200bb', 'x'.repeat(BLURB_MAX + 1)])('rejects blurb %j', (blurb) => {
    expect(auditLegacy(edit((l) => (l.accolades[0].blurb = blurb))).join()).toMatch(/accolade 1: blurb/)
  })
  it('accepts paragraph breaks in a blurb, and a blurb of exactly the limit', () => {
    expect(auditLegacy(edit((l) => (l.accolades[0].blurb = 'a\n\nb\nc')))).toEqual([])
    expect(auditLegacy(edit((l) => (l.accolades[0].blurb = 'x'.repeat(BLURB_MAX))))).toEqual([])
  })

  it('counts characters, not UTF-16 units, against every limit', () => {
    expect(auditLegacy(edit((l) => (l.accolades[0].holders[0].name = '😀'.repeat(NAME_MAX))))).toEqual([])
    expect(auditLegacy(edit((l) => (l.accolades[0].holders[0].name = '😀'.repeat(NAME_MAX + 1)))).join()).toMatch(/holder 1: name/)
    expect(auditLegacy(edit((l) => (l.accolades[0].name = 'x'.repeat(ROLE_NAME_MAX))))).toEqual([])
    expect(auditLegacy(edit((l) => (l.accolades[0].blurb = '😀'.repeat(BLURB_MAX))))).toEqual([])
  })

  it.each([undefined, null, {}, 'x', 5])('rejects holders %j without throwing', (holders) => {
    expect(auditLegacy(edit((l) => (l.accolades[0].holders = holders)))).toEqual(['accolade 1: holders must be an array'])
  })

  it.each(each([null, 5, 'x', []]))('rejects a holder that is %j', (h) => {
    expect(auditLegacy(edit((l) => (l.accolades[0].holders[0] = h)))).toEqual(['accolade 1, holder 1: not an object'])
  })

  it.each(each(BAD_IDS))('rejects holder id %j', (id) => {
    expect(auditLegacy(edit((l) => (l.accolades[0].holders[0].id = id))).join()).toMatch(/holder 1: id is not a snowflake/)
  })

  it('rejects a repeated holder id within a role, but allows it across roles', () => {
    expect(auditLegacy(edit((l) => (l.accolades[0].holders[1].id = USER_A)))).toEqual(['accolade 1, holder 2: id appears twice'])
    const bad = auditLegacy(edit((l) => ((l.accolades[0].holders[0].id = 'x'), (l.accolades[0].holders[1].id = 'x'))))
    expect(bad).toEqual(['accolade 1, holder 1: id is not a snowflake', 'accolade 1, holder 2: id is not a snowflake'])
  })

  it.each(each([...BAD_TEXT, 'x'.repeat(NAME_MAX + 1)]))('rejects holder name %j', (name) => {
    expect(auditLegacy(edit((l) => (l.accolades[0].holders[0].name = name))).join()).toMatch(/holder 1: name/)
  })

  it('rejects unknown fields at every level, including a smuggled __proto__', () => {
    expect(auditLegacy(edit((l) => (l.extra = 1)))).toEqual(['legacy: has an unknown field'])
    expect(auditLegacy(edit((l) => (l.accolades[0].avatar = 'x')))).toEqual(['accolade 1: has an unknown field'])
    expect(auditLegacy(edit((l) => (l.accolades[0].holders[0].email = 'x')))).toEqual(['accolade 1, holder 1: has an unknown field'])
    const smuggled = JSON.parse(`{"snapshot":"2026-10-16T12:00:00.000Z","accolades":[],"__proto__":{"x":1}}`)
    expect(auditLegacy(smuggled).join()).toMatch(/unknown field/)
  })

  it('reports every problem, not just the first', () => {
    const l = edit((x) => {
      x.snapshot = 'x'
      x.accolades[0].name = ''
      x.accolades[0].holders[0].id = 'x'
      x.accolades[1].blurb = ''
    })
    expect(auditLegacy(l)).toHaveLength(4)
  })

  it('never echoes data into a problem, and never mutates its input', () => {
    const l = edit((x) => (x.accolades[0].holders[0].name = 'SECRET-NAME' + 'x'.repeat(NAME_MAX)))
    expect(JSON.stringify(auditLegacy(l))).not.toContain('SECRET-NAME')
    expect(() => auditLegacy(deepFreeze(valid()))).not.toThrow()
  })

  it('accepts whatever valid parts it is built from (property)', () => {
    const id = fc.stringMatching(/^[1-9]\d{16,19}$/)
    const accolade = fc.record({
      roleId: id,
      name: fc.stringMatching(/^[A-Za-z0-9]{1,100}$/),
      color: fc.oneof(fc.constant(null), fc.stringMatching(/^#[0-9a-f]{6}$/)),
      blurb: fc.stringMatching(/^[A-Za-z0-9]{1,600}$/),
      holders: fc.uniqueArray(fc.record({ id, name: fc.stringMatching(/^[A-Za-z0-9]{1,32}$/) }), { selector: (h) => h.id, maxLength: 20 }),
    })
    fc.assert(
      fc.property(fc.uniqueArray(accolade, { selector: (a) => a.roleId, minLength: 1, maxLength: 8 }), (accolades) => {
        expect(auditLegacy({ snapshot: '2026-10-16T12:00:00.000Z', accolades })).toEqual([])
      }),
    )
  })
})

describe('legacyView', () => {
  it('gives the snapshot date, the accolades in file order, and each one ready to show', () => {
    expect(legacyView(valid())).toEqual({
      snapshotDate: '2026-10-16',
      accolades: [
        {
          roleId: ROLE_A, name: 'Fixture Laurel', color: '#d4a017', paragraphs: ['One.', 'Two.'], countLabel: '2 holders',
          holders: [{ id: USER_A, name: 'Alpha Holder' }, { id: USER_B, name: 'beta holder' }],
        },
        { roleId: ROLE_B, name: 'Fixture Ember', color: null, paragraphs: ['Three.'], countLabel: 'No holders on record', holders: [] },
      ],
    })
  })

  it.each([[0, 'No holders on record'], [1, '1 holder'], [2, '2 holders'], [11, '11 holders']])('labels %i holders as "%s"', (n, label) => {
    const holders = Array.from({ length: n }, (_, i) => ({ id: `82000000000000${String(i).padStart(4, '0')}`, name: `h${i}` }))
    expect(legacyView(edit((l) => (l.accolades[0].holders = holders))).accolades[0].countLabel).toBe(label)
  })

  it('sorts holders by name ignoring case, and ties by id whatever order they arrive in', () => {
    const holders = [
      { id: '820000000000000003', name: 'b' },
      { id: '820000000000000002', name: 'alpha' },
      { id: '820000000000000001', name: 'Alpha' },
      { id: '820000000000000004', name: 'B' },
      { id: '820000000000000005', name: 'c' },
    ]
    const want = ['820000000000000001', '820000000000000002', '820000000000000003', '820000000000000004', '820000000000000005']
    const ids = (hs) => legacyView(edit((l) => (l.accolades[0].holders = hs))).accolades[0].holders.map((h) => h.id)
    expect(ids(holders)).toEqual(want)
    expect(ids([...holders].reverse())).toEqual(want)
  })

  it('splits paragraphs on blank lines only', () => {
    const paras = (blurb) => legacyView(edit((l) => (l.accolades[0].blurb = blurb))).accolades[0].paragraphs
    expect(paras('a\n\nb')).toEqual(['a', 'b'])
    expect(paras('a\n\n\n\nb')).toEqual(['a', 'b'])
    expect(paras('a\nb')).toEqual(['a\nb'])
  })

  it('never mutates its input, and hands back its own holder arrays', () => {
    const l = deepFreeze(valid())
    const view = legacyView(l)
    view.accolades[0].holders.push({ id: 'x', name: 'x' })
    expect(l.accolades[0].holders).toHaveLength(2)
  })

  it('never loses or invents a holder, and the order they arrive in does not matter (property)', () => {
    const holdersArb = fc.uniqueArray(
      fc.record({ id: fc.stringMatching(/^[1-9]\d{16,19}$/), name: fc.stringMatching(/^[A-Za-z0-9]{1,32}$/) }),
      { selector: (h) => h.id, maxLength: 25 },
    )
    fc.assert(
      fc.property(holdersArb, (holders) => {
        const view = (hs) => legacyView(edit((l) => (l.accolades[0].holders = hs))).accolades[0].holders
        const fwd = view(holders)
        expect(view([...holders].reverse())).toEqual(fwd)
        expect(fwd.map((h) => h.id).sort()).toEqual(holders.map((h) => h.id).sort())
      }),
    )
  })
})

describe('luminance and readableColor', () => {
  it('weights the channels like sight does', () => {
    expect(luminance('#000000')).toBe(0)
    expect(luminance('#ffffff')).toBeCloseTo(1, 5)
    expect(luminance('#ff0000')).toBeCloseTo(0.2126, 4)
    expect(luminance('#00ff00')).toBeCloseTo(0.7152, 4)
    expect(luminance('#0000ff')).toBeCloseTo(0.0722, 4)
    expect(luminance('#808080')).toBeCloseTo(0.2195, 3)
    expect(luminance('#FFFFFF')).toBeCloseTo(1, 5)
  })

  it.each(['#ffffff', '#00ff00', '#ff0000', '#5865f2', '#d4a017', '#FFFFFF'])('keeps %s, which reads on the dark inlay', (c) => {
    expect(readableColor(c)).toBe(c)
  })
  it.each(['#000000', '#0000ff', '#8b0000', '#202020', '#1f1e1d'])('drops %s, which would vanish into it', (c) => {
    expect(readableColor(c)).toBeNull()
  })
  it('passes a missing colour through as missing', () => {
    expect(readableColor(null)).toBeNull()
  })
  it('keeps a colour exactly at the threshold and drops one just under', () => {
    expect(readableColor('#6e6e6e', luminance('#6e6e6e'))).toBe('#6e6e6e')
    expect(readableColor('#6e6e6e', luminance('#6e6e6e') + 1e-9)).toBeNull()
  })
})

describe('canonicalLegacy', () => {
  it('is two-space JSON with a trailing newline that parses back to the same payload', () => {
    const text = canonicalLegacy(valid())
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('\n  "snapshot"')
    expect(JSON.parse(text)).toEqual(valid())
  })
  it('names the file the export carries it in', () => {
    expect(LEGACY_FILE).toBe('legacy-accolades.json')
  })
})
