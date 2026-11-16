import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { snowflakeAt, timeOf } from './snowflake'

const EPOCH_MS = 1420070400000
// The 42 bits of milliseconds a snowflake holds: the last instant it can name is this far past the epoch.
const MAX_OFFSET_MS = 2 ** 42 - 1
const FIRST = new Date('2015-01-01T00:00:00.000Z')
const LAST = new Date('2100-12-31T23:59:59.999Z')
const aDate = () => fc.date({ min: FIRST, max: LAST, noInvalidDate: true })

describe('snowflakeAt', () => {
  it('names the epoch itself 0, and each millisecond after it 2^22 further on', () => {
    expect(snowflakeAt(new Date(EPOCH_MS))).toBe('0')
    expect(snowflakeAt(new Date(EPOCH_MS + 1))).toBe('4194304')
    expect(snowflakeAt(new Date(EPOCH_MS + 2))).toBe('8388608')
  })

  it('matches the example in the documentation of the Discord API', () => {
    // The documented snowflake 175928847299117063 was made at 2016-04-30T11:18:25.796Z; its low 22 bits (worker,
    // process and sequence) are not part of a date, so the date's own snowflake is the same id with them cleared.
    expect(snowflakeAt(new Date('2016-04-30T11:18:25.796Z'))).toBe('175928847298985984')
  })

  it('answers a string of digits, never a number or a BigInt', () => {
    fc.assert(
      fc.property(aDate(), (date) => {
        const id = snowflakeAt(date)
        expect(typeof id).toBe('string')
        expect(id).toMatch(/^(0|[1-9]\d*)$/)
      }),
    )
  })

  it('is exact for dates far past 2^53 as a snowflake (no float rounding)', () => {
    // 2099-12-31T00:00:00.000Z: ms past the epoch times 2^22 is well over Number.MAX_SAFE_INTEGER.
    const date = new Date('2099-12-31T00:00:00.000Z')
    const expected = ((BigInt(date.getTime()) - BigInt(EPOCH_MS)) * 4194304n).toString()
    expect(snowflakeAt(date)).toBe(expected)
    expect(BigInt(expected) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true)
  })

  it('keeps time order: a later date never names a smaller id', () => {
    fc.assert(
      fc.property(aDate(), aDate(), (a, b) => {
        const [x, y] = [snowflakeAt(a), snowflakeAt(b)]
        expect(BigInt(x) < BigInt(y)).toBe(a.getTime() < b.getTime())
        expect(BigInt(x) === BigInt(y)).toBe(a.getTime() === b.getTime())
      }),
    )
  })

  it('accepts the last instant a snowflake can hold, and refuses the one after it', () => {
    expect(snowflakeAt(new Date(EPOCH_MS + MAX_OFFSET_MS))).toBe(((2n ** 42n - 1n) << 22n).toString())
    expect(() => snowflakeAt(new Date(EPOCH_MS + MAX_OFFSET_MS + 1))).toThrow(new RangeError('That date is outside the years a snowflake can name.'))
  })

  it('refuses a date before the epoch, even by one millisecond', () => {
    expect(() => snowflakeAt(new Date(EPOCH_MS - 1))).toThrow(new RangeError('That date is outside the years a snowflake can name.'))
    expect(() => snowflakeAt(new Date('1999-01-01T00:00:00Z'))).toThrow(RangeError)
    expect(() => snowflakeAt(new Date(0))).toThrow(RangeError)
    expect(() => snowflakeAt(new Date(-8.64e15))).toThrow(RangeError)
  })

  it('refuses a date after the last the Date type holds, too', () => {
    expect(() => snowflakeAt(new Date(8.64e15))).toThrow(RangeError)
  })

  it('refuses an invalid date', () => {
    expect(() => snowflakeAt(new Date('not a date'))).toThrow(new TypeError('snowflakeAt takes a valid Date.'))
    expect(() => snowflakeAt(new Date(NaN))).toThrow(TypeError)
  })

  it.each([
    ['a number', EPOCH_MS + 1000],
    ['an ISO string', '2020-01-01T00:00:00.000Z'],
    ['a numeric string', String(EPOCH_MS + 1000)],
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['an object that only looks like a date', { getTime: () => EPOCH_MS + 1000 }],
    ['a BigInt', BigInt(EPOCH_MS + 1000)],
    ['an array', [EPOCH_MS + 1000]],
    ['a Symbol', Symbol('date')],
    ['a function', () => new Date(EPOCH_MS + 1000)],
  ])('refuses %s, which is no Date', (_name, value) => {
    expect(() => snowflakeAt(value)).toThrow(new TypeError('snowflakeAt takes a valid Date.'))
  })
})

describe('timeOf', () => {
  it('reads the documented example', () => {
    expect(timeOf('175928847299117063')).toEqual(new Date('2016-04-30T11:18:25.796Z'))
  })

  it('reads 0 as the epoch and ignores the low 22 bits', () => {
    expect(timeOf('0')).toEqual(new Date(EPOCH_MS))
    expect(timeOf('4194303')).toEqual(new Date(EPOCH_MS))
    expect(timeOf('4194304')).toEqual(new Date(EPOCH_MS + 1))
  })

  it('answers a Date', () => {
    expect(timeOf('175928847299117063')).toBeInstanceOf(Date)
  })

  it('reads the largest id a snowflake can be, 20 digits, as the last instant it can name', () => {
    expect(timeOf('18446744073709551615')).toEqual(new Date(EPOCH_MS + MAX_OFFSET_MS))
  })

  it('round-trips with snowflakeAt over 2015 to 2100, to the millisecond', () => {
    fc.assert(
      fc.property(aDate(), (date) => {
        expect(timeOf(snowflakeAt(date)).getTime()).toBe(date.getTime())
      }),
    )
  })

  it('round-trips the first and the last instants of the range, which the generator reaches only by luck', () => {
    for (const date of [FIRST, new Date(FIRST.getTime() + 1), LAST, new Date(EPOCH_MS + MAX_OFFSET_MS)]) {
      expect(timeOf(snowflakeAt(date)).getTime()).toBe(date.getTime())
    }
  })

  it('reads any id with the same time bits as the same instant, whatever its low 22 bits', () => {
    fc.assert(
      fc.property(aDate(), fc.bigInt({ min: 0n, max: 4194303n }), (date, low) => {
        const id = (BigInt(snowflakeAt(date)) + low).toString()
        expect(timeOf(id).getTime()).toBe(date.getTime())
      }),
    )
  })

  it('keeps time order: a larger id is never an earlier time', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), (a, b) => {
        const [x, y] = [timeOf(a.toString()).getTime(), timeOf(b.toString()).getTime()]
        if (a < b) expect(x).toBeLessThanOrEqual(y)
        if (a > b) expect(x).toBeGreaterThanOrEqual(y)
      }),
    )
  })

  it('refuses an id past 64 bits, by one', () => {
    expect(() => timeOf('18446744073709551616')).toThrow(new RangeError('That id is wider than 64 bits.'))
    expect(() => timeOf('99999999999999999999')).toThrow(RangeError)
  })

  it.each([
    ['empty', ''],
    ['a space', ' '],
    ['letters', 'abc'],
    ['a sign', '-1'],
    ['a plus sign', '+175928847299117063'],
    ['a decimal', '1.5'],
    ['an exponent', '1e18'],
    ['hex', '0x1f'],
    ['padded with a space', ' 175928847299117063'],
    ['a trailing newline', '175928847299117063\n'],
    ['an embedded newline', '1759288472\n99117063'],
    ['a digit with a letter', '17592884729911706a'],
    ['full-width digits', '１７５９２８８４７２９９１１７０６３'],
    ['Arabic-Indic digits', '١٧٥٩٢٨٨٤٧٢٩٩١١٧٠٦٣'],
    ['21 digits', '123456789012345678901'],
    ['a long run of digits', '9'.repeat(5000)],
  ])('refuses %s, which is no id', (_name, value) => {
    expect(() => timeOf(value)).toThrow(new TypeError('timeOf takes an id: a string of digits.'))
  })

  it.each([
    ['a number', 175928847299117063],
    ['a small number', 0],
    ['a BigInt', 175928847299117063n],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
    ['an array holding an id', ['175928847299117063']],
    ['a String object', new String('175928847299117063')],
    ['an object that prints as an id', { toString: () => '175928847299117063' }],
    ['a Symbol', Symbol('id')],
  ])('refuses %s, ids being strings', (_name, value) => {
    expect(() => timeOf(value)).toThrow(new TypeError('timeOf takes an id: a string of digits.'))
  })
})
