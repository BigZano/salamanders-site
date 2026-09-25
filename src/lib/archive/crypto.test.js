import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { createHash, randomBytes, hkdfSync, createDecipheriv, createCipheriv, createHmac } from 'node:crypto'
import {
  deriveKeys, seal, open, opaqueName, keyFromBase64, keyToBase64, toHex, ArchiveCryptoError,
} from './crypto'

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i)
const OTHER = Uint8Array.from({ length: 32 }, (_, i) => 255 - i)
const enc = (s) => new TextEncoder().encode(s)

async function code(promise) {
  try {
    await promise
  } catch (e) {
    expect(e).toBeInstanceOf(ArchiveCryptoError)
    return e.code
  }
  throw new Error('expected rejection')
}
function syncCode(fn) {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ArchiveCryptoError)
    return e.code
  }
  throw new Error('expected throw')
}

describe('deriveKeys', () => {
  it('kid is the first 16 hex chars of sha256(raw key), computed independently', async () => {
    const { kid } = await deriveKeys(KEY)
    expect(kid).toBe(createHash('sha256').update(KEY).digest('hex').slice(0, 16))
  })
  it('different keys give different kids', async () => {
    expect((await deriveKeys(KEY)).kid).not.toBe((await deriveKeys(OTHER)).kid)
  })
  it.each([
    ['empty', new Uint8Array(0)],
    ['31 bytes', new Uint8Array(31)],
    ['33 bytes', new Uint8Array(33)],
    ['string', 'x'.repeat(32)],
    ['number array', Array(32).fill(1)],
    ['null', null],
    ['Uint16Array', new Uint16Array(16)],
  ])('rejects %s with code KEY', async (_, bad) => {
    expect(await code(deriveKeys(bad))).toBe('KEY')
  })
  it('accepts a Node Buffer (seal script path)', async () => {
    await expect(deriveKeys(Buffer.from(KEY))).resolves.toHaveProperty('kid')
  })
})

describe('seal/open', () => {
  it('round-trips arbitrary bytes under arbitrary logical paths', async () => {
    const keys = await deriveKeys(KEY)
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 2048 }), fc.string({ minLength: 1, maxLength: 80 }), async (data, p) => {
        expect(await open(keys, p, await seal(keys, p, data))).toEqual(data)
      }),
      { numRuns: 150 },
    )
  })
  it('round-trips empty plaintext', async () => {
    const keys = await deriveKeys(KEY)
    expect(await open(keys, 'p', await seal(keys, 'p', new Uint8Array(0)))).toEqual(new Uint8Array(0))
  })
  it('layout is magic ‖ 12-byte nonce ‖ ciphertext ‖ 16-byte tag', async () => {
    const keys = await deriveKeys(KEY)
    const out = await seal(keys, 'p', enc('abc'))
    expect(Array.from(out.subarray(0, 4))).toEqual([0x4c, 0x41, 0x52, 0x01])
    expect(out.length).toBe(4 + 12 + 3 + 16)
  })
  it('never reuses a nonce (and never produces identical output) for identical input', async () => {
    const keys = await deriveKeys(KEY)
    const nonces = new Set()
    for (let i = 0; i < 500; i++) nonces.add(toHex((await seal(keys, 'p', enc('same'))).subarray(4, 16)))
    expect(nonces.size).toBe(500)
  })
  it('every single-bit flip is rejected (FORMAT in the magic, AUTH elsewhere)', async () => {
    const keys = await deriveKeys(KEY)
    const sealed = await seal(keys, 'a/b.png', enc('flip me'))
    for (let byte = 0; byte < sealed.length; byte++) {
      for (let bit = 0; bit < 8; bit++) {
        const t = sealed.slice()
        t[byte] ^= 1 << bit
        expect(await code(open(keys, 'a/b.png', t))).toBe(byte < 4 ? 'FORMAT' : 'AUTH')
      }
    }
  })
  it('wrong key → AUTH', async () => {
    const sealed = await seal(await deriveKeys(KEY), 'p', enc('x'))
    expect(await code(open(await deriveKeys(OTHER), 'p', sealed))).toBe('AUTH')
  })
  it('wrong logical path (swapped file) → AUTH', async () => {
    const keys = await deriveKeys(KEY)
    const sealed = await seal(keys, 'accolades/assets/a.png', enc('x'))
    expect(await code(open(keys, 'accolades/assets/b.png', sealed))).toBe('AUTH')
  })
  it.each([0, 1, 4, 15, 16, 31])('truncation to %i bytes → FORMAT', async (n) => {
    const keys = await deriveKeys(KEY)
    const sealed = await seal(keys, 'p', enc('hello world'))
    expect(await code(open(keys, 'p', sealed.subarray(0, n)))).toBe('FORMAT')
  })
  it('truncation that keeps the header but cuts the tag → AUTH', async () => {
    const keys = await deriveKeys(KEY)
    const sealed = await seal(keys, 'p', enc('hello world'))
    expect(await code(open(keys, 'p', sealed.subarray(0, sealed.length - 1)))).toBe('AUTH')
  })
  it('a future format version byte → FORMAT', async () => {
    const keys = await deriveKeys(KEY)
    const sealed = await seal(keys, 'p', enc('x'))
    sealed[3] = 0x02
    expect(await code(open(keys, 'p', sealed))).toBe('FORMAT')
  })
  it.each([['', 'PATH'], ['x'.repeat(513), 'PATH'], [null, 'PATH'], [42, 'PATH']])(
    'path %j → %s on seal and open',
    async (p, c) => {
      const keys = await deriveKeys(KEY)
      expect(await code(seal(keys, p, enc('x')))).toBe(c)
      expect(await code(open(keys, p, new Uint8Array(40)))).toBe(c)
    },
  )
  it('accepts a 512-char path (boundary)', async () => {
    const keys = await deriveKeys(KEY)
    const p = 'x'.repeat(512)
    expect(await open(keys, p, await seal(keys, p, enc('ok')))).toEqual(enc('ok'))
  })
  it.each([['string', 'abc'], ['array', [1, 2]], ['null', null]])('non-bytes data (%s) → INPUT', async (_, d) => {
    const keys = await deriveKeys(KEY)
    expect(await code(seal(keys, 'p', d))).toBe('INPUT')
    expect(await code(open(keys, 'p', d))).toBe('INPUT')
  })
})

describe('opaqueName', () => {
  it('is 32 lowercase hex, deterministic, and path- and key-sensitive', async () => {
    const a = await deriveKeys(KEY)
    const b = await deriveKeys(OTHER)
    const n = await opaqueName(a, 'accolades/assets/emoji-1.png')
    expect(n).toMatch(/^[0-9a-f]{32}$/)
    expect(await opaqueName(a, 'accolades/assets/emoji-1.png')).toBe(n)
    expect(await opaqueName(a, 'accolades/assets/emoji-2.png')).not.toBe(n)
    expect(await opaqueName(b, 'accolades/assets/emoji-1.png')).not.toBe(n)
  })
  it('rejects bad paths', async () => {
    expect(await code(opaqueName(await deriveKeys(KEY), ''))).toBe('PATH')
  })
})

describe('base64 key codec', () => {
  it('round-trips random 32-byte keys', () => {
    for (let i = 0; i < 50; i++) {
      const k = new Uint8Array(randomBytes(32))
      expect(keyFromBase64(keyToBase64(k))).toEqual(k)
    }
  })
  it.each([
    '', 'AAAA', 'A'.repeat(43), 'A'.repeat(44), `${'A'.repeat(43)}= `, `${'A'.repeat(42)}!=`, null, 7,
    Buffer.alloc(33).toString('base64'),
  ])('rejects %j with code KEY', (s) => {
    expect(syncCode(() => keyFromBase64(s))).toBe('KEY')
  })
  it('keyToBase64 rejects non-32-byte input', () => {
    expect(syncCode(() => keyToBase64(new Uint8Array(31)))).toBe('KEY')
  })
  it('toHex pads single-digit bytes', () => {
    expect(toHex(Uint8Array.of(0, 15, 255))).toBe('000fff')
  })
})

describe('interop with an independent implementation (node:crypto)', () => {
  const nodeKey = (info) => Buffer.from(hkdfSync('sha256', KEY, 'legion-archive', info, 32))

  it('sealed files decrypt with AES-256-GCM under HKDF(key, salt "legion-archive", info "enc")', async () => {
    const keys = await deriveKeys(KEY)
    const sealed = Buffer.from(await seal(keys, 'accolades/assets/a.png', enc('interop')))
    const d = createDecipheriv('aes-256-gcm', nodeKey('enc'), sealed.subarray(4, 16))
    d.setAAD(Buffer.from('1|accolades/assets/a.png'))
    d.setAuthTag(sealed.subarray(sealed.length - 16))
    const plain = Buffer.concat([d.update(sealed.subarray(16, sealed.length - 16)), d.final()])
    expect(plain.toString()).toBe('interop')
  })
  it('files sealed independently open with this module', async () => {
    const nonce = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', nodeKey('enc'), nonce)
    c.setAAD(Buffer.from('1|index'))
    const body = Buffer.concat([c.update('from node'), c.final(), c.getAuthTag()])
    const sealed = new Uint8Array(Buffer.concat([Buffer.from([0x4c, 0x41, 0x52, 0x01]), nonce, body]))
    expect(new TextDecoder().decode(await open(await deriveKeys(KEY), 'index', sealed))).toBe('from node')
  })
  it('opaqueName is HMAC-SHA256 under HKDF(key, info "name"), first 32 hex', async () => {
    const want = createHmac('sha256', nodeKey('name')).update('ranks/assets/x.gif').digest('hex').slice(0, 32)
    expect(await opaqueName(await deriveKeys(KEY), 'ranks/assets/x.gif')).toBe(want)
  })
})

describe('key hygiene and error surface', () => {
  it('derived keys cannot be exported from the CryptoKey objects', async () => {
    const { encKey, nameKey } = await deriveKeys(KEY)
    await expect(globalThis.crypto.subtle.exportKey('raw', encKey)).rejects.toThrow()
    await expect(globalThis.crypto.subtle.exportKey('raw', nameKey)).rejects.toThrow()
  })
  it('an object that stringifies to a valid key is still rejected', () => {
    const sneaky = { toString: () => keyToBase64(KEY) }
    expect(syncCode(() => keyFromBase64(sneaky))).toBe('KEY')
  })
  it('every error is named ArchiveCryptoError and explains itself', async () => {
    const keys = await deriveKeys(KEY)
    const sealed = await seal(keys, 'p', enc('x'))
    const bad = sealed.slice()
    bad[0] = 0
    const cases = [
      [() => deriveKeys(new Uint8Array(1)), /32 bytes/],
      [() => seal(keys, '', enc('x')), /logical path must be a string of 1-512 chars/],
      [() => seal(keys, 'p', 'x'), /Uint8Array/],
      [() => open(keys, 'p', new Uint8Array(3)), /too short/],
      [() => open(keys, 'p', bad), /not a v1/],
      [() => open(keys, 'q', sealed), /failed authentication/],
      [async () => keyFromBase64('x'), /ARCHIVE_KEY must be 32 bytes of base64/],
      [async () => keyToBase64(new Uint8Array(1)), /32 bytes/],
    ]
    for (const [fn, re] of cases) {
      const e = await fn().then(() => null, (err) => err)
      expect(e?.name).toBe('ArchiveCryptoError')
      expect(e.message).toMatch(re)
    }
  })
})
