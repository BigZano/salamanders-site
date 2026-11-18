import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { sniff as sniffBytes, strip as stripBytes } from './librariusUploads.js'

// Every picture here is built in code, and every location, name and payload in it is invented.

/**
 * The same bytes behind a Proxy that throws on any read outside them. The module must never read past the end of what it
 * is given, and in JavaScript that read would otherwise be a quiet undefined. Anything that is not bytes passes as it is.
 */
const guard = (value) => {
  if (!(value instanceof Uint8Array)) return value
  return new Proxy(value, {
    get(target, key) {
      if (typeof key === 'string' && String(Number(key)) === key) {
        const at = Number(key)
        if (!Number.isInteger(at) || at < 0 || at >= target.length) throw new RangeError(`read at ${key} of ${target.length}`)
      }
      const found = Reflect.get(target, key, target)
      return typeof found === 'function' ? found.bind(target) : found
    },
  })
}
const sniff = (bytes) => sniffBytes(guard(bytes))
const strip = (bytes, type) => stripBytes(guard(bytes), type)

const PNG = 'image/png'
const JPEG = 'image/jpeg'
const WEBP = 'image/webp'
const GIF = 'image/gif'

// ---------------------------------------------------------------------------------------------- byte helpers

/** One array from numbers, byte arrays and nested lists of either. */
const cat = (...parts) => {
  const flat = parts.flat(Infinity).map((p) => (typeof p === 'number' ? [p] : p))
  const out = new Uint8Array(flat.reduce((n, a) => n + a.length, 0))
  let at = 0
  for (const a of flat) {
    out.set(a, at)
    at += a.length
  }
  return out
}
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0))
const be16 = (n) => [(n >> 8) & 0xff, n & 0xff]
const be32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
const le16 = (n) => [n & 0xff, (n >> 8) & 0xff]
const le32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
const hex = (u) => Buffer.from(u.buffer, u.byteOffset, u.length).toString('hex')
const has = (haystack, needle) => Buffer.from(haystack.buffer, haystack.byteOffset, haystack.length).includes(needle)

/** The stripped bytes must be exactly `expected`. A diff of the hex says where they part. */
const expectBytes = (actual, expected) => {
  expect(actual).not.toBeNull()
  expect(hex(actual)).toBe(hex(expected))
}

/** What the phone's location looks like inside a picture. The marker text is how a test finds it. */
const GPS_MARK = ascii('GPSLatitude')
const EXIF_GPS = cat(
  ascii('Exif\0\0'),
  [0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08],
  ascii('GPSLatitudeRef=N;GPSLatitude=51/1,30/1,26/1;GPSLongitudeRef=W;GPSLongitude=0/1,7/1,39/1;'),
)
const XMP_GPS = ascii('<x:xmpmeta xmlns:x="adobe:ns:meta/"><exif:GPSLatitude>51,30.4N</exif:GPSLatitude></x:xmpmeta>')

// Image data with bytes that look like the metadata the strippers hunt for. They are data, and must stay.
const TRAP = cat(ascii('Exif\0\0'), ascii('tEXt'), ascii('eXIf'), ascii('XMP '), ascii('EXIF'), ascii('NOTGPS'))

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (u8) => {
  let c = 0xffffffff
  for (const x of u8) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------------------------- JPEG builders

const seg = (code, payload = []) => {
  const p = cat(payload)
  return cat([0xff, code], be16(p.length + 2), p)
}
const SOI = [0xff, 0xd8]
const EOI = [0xff, 0xd9]
const SOS_HEADER = seg(0xda, [1, 1, 0, 0, 63, 0])
const JFIF = seg(0xe0, [ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0])
const DQT = seg(0xdb, [0, Array.from({ length: 64 }, (_, i) => i + 1)])
const SOF0 = seg(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0])
const DHT = seg(0xc4, [0, new Array(16).fill(0), 0])
const ICC = seg(0xe2, [ascii('ICC_PROFILE\0'), 1, 1, new Array(20).fill(0x33)])
const COMMENT = seg(0xfe, ascii('made with an invented tool'))
const APP1_EXIF = seg(0xe1, EXIF_GPS)
const APP1_XMP = seg(0xe1, [ascii('http://ns.adobe.com/xap/1.0/\0'), XMP_GPS])
const APP13 = seg(0xed, [ascii('Photoshop 3.0\0'), ascii('8BIM'), ascii('GPSLatitude caption')])
const SCAN = cat([0x12, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0xff, 0x00, 0xe1, 0x00, 0x08], TRAP, [0xff, 0xd3, 0x11])
const BASE_HEADER = [JFIF, DQT, SOF0, DHT]

/** A whole JPEG: the header segments, then one scan (its own SOS header and entropy data), then what follows it. */
const jpeg = (header = BASE_HEADER, scan = SCAN, after = []) => cat(SOI, header, SOS_HEADER, scan, after, EOI)

// ---------------------------------------------------------------------------------------------- PNG builders

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const chunk = (type, data = []) => {
  const d = cat(data)
  return cat(be32(d.length), ascii(type), d, be32(crc32(cat(ascii(type), d))))
}
const IHDR = chunk('IHDR', [be32(2), be32(2), 8, 6, 0, 0, 0])
const IDAT = chunk('IDAT', cat([0x78, 0x9c], TRAP, [1, 2, 3, 4, 5, 6, 7, 8]))
const IEND = chunk('IEND')
const png = (...chunks) => cat(PNG_SIG, chunks)
const PNG_METADATA = [
  chunk('tEXt', ascii('Comment\0GPSLatitude=51.5')),
  chunk('zTXt', [ascii('Raw profile type exif\0\0'), GPS_MARK]),
  chunk('iTXt', [ascii('XML:com.adobe.xmp\0\0\0\0\0'), XMP_GPS]),
  chunk('eXIf', EXIF_GPS),
]

// ---------------------------------------------------------------------------------------------- WebP builders

const riff = (type, data = []) => {
  const d = cat(data)
  return cat(ascii(type), le32(d.length), d, d.length & 1 ? [0] : [])
}
const webp = (...chunks) => {
  const body = cat(ascii('WEBP'), chunks)
  return cat(ascii('RIFF'), le32(body.length), body)
}
const FLAG = { icc: 0x20, alpha: 0x10, exif: 0x08, xmp: 0x04, anim: 0x02 }
const vp8x = (flags) => riff('VP8X', [flags, 0, 0, 0, 1, 0, 0, 1, 0, 0])
const VP8 = riff('VP8 ', cat([0x10, 0x20, 0x30], TRAP, [0x01]))
const VP8L = riff('VP8L', cat([0x2f, 0x00], TRAP))
const EXIF_CHUNK = riff('EXIF', EXIF_GPS)
const XMP_CHUNK = riff('XMP ', XMP_GPS)

// ---------------------------------------------------------------------------------------------- GIF builders

/** The data cut into sub-blocks of at most 255 bytes, each with its size byte in front, and no terminator. */
const blocksOf = (data) => {
  const d = cat(data)
  const out = []
  for (let i = 0; i < d.length; i += 255) out.push(Math.min(255, d.length - i), d.subarray(i, i + 255))
  return cat(out)
}
const subBlocks = (data) => cat(blocksOf(data), 0)
/** An extension: its label, then each payload as sub-blocks, then the one terminator. */
const ext = (label, ...payloads) => cat([0x21, label], payloads.map(blocksOf), 0)
const GIF_HEAD = (version = '89a') => cat(ascii(`GIF${version}`), le16(2), le16(2), [0x80, 0, 0], [255, 0, 0, 0, 0, 255])
const frame = (data = [1, 2, 3, 4], { lct = false } = {}) =>
  cat([0x2c], le16(0), le16(0), le16(2), le16(2), [lct ? 0x80 : 0], lct ? [9, 9, 9, 8, 8, 8] : [], [2], subBlocks(data))
const GCE = ext(0xf9, [0x00, 0x0a, 0x00, 0x00]) // one sub-block of four bytes: a delay of 10 ticks
const NETSCAPE = ext(0xff, ascii('NETSCAPE2.0'), [1, 0, 0])
const GIF_COMMENT = ext(0xfe, ascii('location: GPSLatitude 51.5'))
const FRAME_TRAP = frame(cat(TRAP, [0x21, 0xfe, 0x03, 0x41, 0x42, 0x43, 0x00, 0x3b, 0x2c]))
const gif = (...items) => cat(GIF_HEAD(), items, [0x3b])

// ---------------------------------------------------------------------------------------------- fixtures by type

const SAMPLE = {
  [JPEG]: () => jpeg([JFIF, APP1_EXIF, DQT, APP1_XMP, SOF0, APP13, DHT]),
  [PNG]: () => png(IHDR, ...PNG_METADATA, IDAT, IEND),
  [WEBP]: () => webp(vp8x(FLAG.exif | FLAG.xmp), VP8, EXIF_CHUNK, XMP_CHUNK),
  [GIF]: () => gif(GIF_COMMENT, GCE, FRAME_TRAP, GIF_COMMENT),
}
const CLEAN = {
  [JPEG]: () => jpeg(),
  [PNG]: () => png(IHDR, IDAT, IEND),
  [WEBP]: () => webp(vp8x(0), VP8),
  [GIF]: () => gif(GCE, FRAME_TRAP),
}
const TYPES = [JPEG, PNG, WEBP, GIF]

// ================================================================================================= the guard itself

describe('the guard the tests read through', () => {
  it('lets every index in range through, and throws for the one past the end, a negative one and a fraction', () => {
    const view = guard(Uint8Array.of(7, 8, 9))
    expect([view[0], view[1], view[2], view.length]).toEqual([7, 8, 9, 3])
    expect(() => view[3]).toThrow(RangeError)
    expect(() => view[-1]).toThrow(RangeError)
    expect(() => view[1.5]).toThrow(RangeError)
    expect(() => view[100]).toThrow(RangeError)
    expect(Array.from(view.subarray(1))).toEqual([8, 9])
    expect(view instanceof Uint8Array).toBe(true)
    expect(guard('text')).toBe('text')
  })

  it('is what stands between a read past the end and a quiet undefined', () => {
    // a stand-in that reads one byte beyond: the guard turns it into a failure
    const lazy = (bytes) => bytes[bytes.length]
    expect(lazy(Uint8Array.of(1, 2))).toBeUndefined()
    expect(() => lazy(guard(Uint8Array.of(1, 2)))).toThrow(RangeError)
  })
})

// ================================================================================================= sniff

describe('sniff', () => {
  it('names each of the four types by its signature, and the signature alone is enough', () => {
    expect(sniff(Uint8Array.of(0xff, 0xd8, 0xff))).toBe(JPEG)
    expect(sniff(Uint8Array.from(PNG_SIG))).toBe(PNG)
    expect(sniff(ascii('GIF87a'))).toBe(GIF)
    expect(sniff(ascii('GIF89a'))).toBe(GIF)
    expect(sniff(cat(ascii('RIFF'), [0, 0, 0, 0], ascii('WEBP')))).toBe(WEBP)
  })

  it('names the real pictures of every format, whatever follows the signature', () => {
    for (const type of TYPES) {
      expect(sniff(SAMPLE[type]())).toBe(type)
      expect(sniff(CLEAN[type]())).toBe(type)
    }
  })

  it('is null for a signature one byte short, and for every signature with one byte changed', () => {
    const signatures = [
      Uint8Array.of(0xff, 0xd8, 0xff),
      Uint8Array.from(PNG_SIG),
      ascii('GIF87a'),
      ascii('GIF89a'),
      cat(ascii('RIFF'), [0, 0, 0, 0], ascii('WEBP')),
    ]
    for (const sig of signatures) {
      expect(sniff(sig.subarray(0, sig.length - 1))).toBeNull()
      for (let i = 0; i < sig.length; i++) {
        if (i >= 4 && i < 8 && sig.length === 12) continue // the RIFF size is any size
        const bent = Uint8Array.from(sig)
        bent[i] ^= 0x01
        expect(sniff(bent)).toBeNull()
      }
    }
  })

  it('refuses near misses of GIF and of RIFF', () => {
    expect(sniff(ascii('GIF88a'))).toBeNull()
    expect(sniff(ascii('GIF89b'))).toBeNull()
    expect(sniff(ascii('gif89a'))).toBeNull()
    expect(sniff(cat(ascii('RIFF'), [0, 0, 0, 0], ascii('WAVE')))).toBeNull()
    expect(sniff(cat(ascii('RIFF'), [0, 0, 0, 0], ascii('AVI ')))).toBeNull()
    expect(sniff(cat(ascii('RIFX'), [0, 0, 0, 0], ascii('WEBP')))).toBeNull()
    expect(sniff(cat(ascii('WEBP'), [0, 0, 0, 0], ascii('RIFF')))).toBeNull()
  })

  it('never accepts a vector or a document, and never an image it can name only by file name', () => {
    const refused = [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>',
      '<!doctype html><title>x</title>',
      '%PDF-1.7',
      'BM\0\0\0\0',
      '\0\0\0\x18ftypavif',
      '\0\0\0\x18ftypheic',
      'II*\0',
      'MM\0*',
      '',
    ]
    for (const text of refused) expect(sniff(ascii(text))).toBeNull()
    expect(sniff(new Uint8Array(0))).toBeNull()
    expect(sniff(new Uint8Array(64))).toBeNull()
  })

  it('judges the bytes and nothing that rides along with them', () => {
    const svg = ascii('<svg xmlns="http://www.w3.org/2000/svg"/>')
    svg.name = 'cat.png'
    svg.type = 'image/png'
    expect(sniff(svg)).toBeNull()
    const real = CLEAN[PNG]()
    real.name = 'cat.svg'
    real.type = 'image/svg+xml'
    expect(sniff(real)).toBe(PNG)
  })

  it('takes bytes only: anything else is null, never a throw', () => {
    const jpegArray = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]
    const hostile = [
      undefined,
      null,
      0,
      12,
      NaN,
      true,
      '',
      '\xff\xd8\xff\xe0',
      'GIF89a......',
      jpegArray,
      { 0: 0xff, 1: 0xd8, 2: 0xff, length: 12 },
      Uint8Array.from(jpegArray).buffer,
      new DataView(Uint8Array.from(jpegArray).buffer),
      new Uint16Array(Uint8Array.from(jpegArray).buffer),
      () => 0,
      Symbol('x'),
      {
        get length() {
          throw new Error('no')
        },
      },
    ]
    for (const value of hostile) expect(sniff(value)).toBeNull()
  })

  it('takes a Buffer, and a view into a bigger array, by what the view holds', () => {
    expect(sniff(Buffer.from(CLEAN[PNG]()))).toBe(PNG)
    expect(sniff(Buffer.from(CLEAN[JPEG]()))).toBe(JPEG)
    const window = cat([0, 0, 0], CLEAN[GIF](), [0xff, 0xd8, 0xff])
    expect(sniff(window.subarray(3, 3 + CLEAN[GIF]().length))).toBe(GIF)
    // the signature sits just before the view starts: it is not part of it
    const before = cat(Uint8Array.from(PNG_SIG), [1, 2, 3, 4])
    expect(sniff(before.subarray(8))).toBeNull()
    expect(sniff(before.subarray(0, 7))).toBeNull()
  })

  it('names any bytes that start with a signature, and nothing that does not', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (tail) => {
        expect(sniff(cat([0xff, 0xd8, 0xff], tail))).toBe(JPEG)
        expect(sniff(cat(PNG_SIG, tail))).toBe(PNG)
        expect(sniff(cat(ascii('GIF87a'), tail))).toBe(GIF)
        expect(sniff(cat(ascii('GIF89a'), tail))).toBe(GIF)
      }),
    )
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 4, maxLength: 4 }), fc.uint8Array({ maxLength: 32 }), (size, tail) => {
        expect(sniff(cat(ascii('RIFF'), size, ascii('WEBP'), tail))).toBe(WEBP)
      }),
    )
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 40 }), (any) => {
        const type = sniff(any)
        const known = [
          [0xff, 0xd8, 0xff],
          PNG_SIG,
          [...ascii('GIF87a')],
          [...ascii('GIF89a')],
        ].some((sig) => sig.every((b, i) => any[i] === b))
        const riffWebp =
          any.length >= 12 && [...ascii('RIFF')].every((b, i) => any[i] === b) && [...ascii('WEBP')].every((b, i) => any[8 + i] === b)
        expect(type === null).toBe(!known && !riffWebp)
        if (type !== null) expect(TYPES).toContain(type)
      }),
      { numRuns: 500 },
    )
  })
})

// ================================================================================================= strip: the call

describe('strip: what it takes and what it gives', () => {
  it('is null when the declared type is not what the bytes are, for every pair of different types', () => {
    for (const bytesOf of TYPES) {
      for (const declared of TYPES) {
        if (bytesOf !== declared) expect(strip(CLEAN[bytesOf](), declared)).toBeNull()
      }
    }
  })

  it('is null for a type that is not one of the four, and for no type at all', () => {
    const bytes = CLEAN[PNG]()
    for (const type of ['image/svg+xml', 'image/avif', 'image/bmp', 'IMAGE/PNG', 'image/png ', 'png', '', '__proto__', 'constructor', undefined, null, 7, {}, [PNG]]) {
      expect(strip(bytes, type)).toBeNull()
    }
  })

  it('trusts the bytes: a body that would parse as another type is refused when its signature says otherwise', () => {
    // a PNG's chunks after a JPEG's signature
    const pngBody = cat(IHDR, IDAT, IEND)
    expect(strip(cat([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0], pngBody), PNG)).toBeNull()
    // a GIF's blocks after a PNG's signature, and a WebP's chunks after a GIF's
    const gifBody = cat([255, 0, 0, 0, 0, 255], FRAME_TRAP, [0x3b]) // a colour table, a frame, the trailer
    expect(strip(cat(PNG_SIG, [0, 0, 0x80, 0, 0], gifBody), GIF)).toBeNull()
    expect(strip(cat(ascii('GIF89a'), [0, 0], pngBody), PNG)).toBeNull()
    // a WebP's header and chunks after a JPEG's signature
    const webpChunks = cat(vp8x(0), VP8)
    expect(strip(cat([0xff, 0xd8, 0xff, 0x00], le32(webpChunks.length + 4), ascii('WEBP'), webpChunks), WEBP)).toBeNull()
  })

  it('is null for what is not bytes, never a throw', () => {
    for (const value of [undefined, null, 0, '', 'GIF89a......', [0xff, 0xd8, 0xff, 0xd9], {}, new ArrayBuffer(16), new DataView(new ArrayBuffer(16))]) {
      for (const type of TYPES) expect(strip(value, type)).toBeNull()
    }
  })

  it('returns a plain Uint8Array of its own, for a plain array, a Buffer or a view into a bigger one', () => {
    for (const type of TYPES) {
      const input = SAMPLE[type]()
      const expected = CLEAN[type]()
      for (const given of [input, Buffer.from(input), cat([7, 7], input, [8, 8]).subarray(2, 2 + input.length)]) {
        const before = hex(given)
        const out = strip(given, type)
        expectBytes(out, expected)
        expect(Object.getPrototypeOf(out)).toBe(Uint8Array.prototype)
        expect(out.byteOffset).toBe(0)
        expect(out.buffer.byteLength).toBe(out.length)
        expect(hex(given)).toBe(before) // the input is left alone
      }
    }
  })

  it('never hands back the input, nor memory it shares, even when there was nothing to strip', () => {
    for (const type of TYPES) {
      const input = CLEAN[type]()
      const before = hex(input)
      const out = strip(input, type)
      expectBytes(out, input)
      expect(out).not.toBe(input)
      out.fill(0xaa)
      expect(hex(input)).toBe(before)
    }
  })

  it('leaves a picture with nothing to strip unchanged, byte for byte', () => {
    for (const type of TYPES) expectBytes(strip(CLEAN[type](), type), CLEAN[type]())
  })

  it('takes the metadata out of the sample of every type, and the GPS with it', () => {
    for (const type of TYPES) {
      expect(has(SAMPLE[type](), GPS_MARK)).toBe(true)
      const out = strip(SAMPLE[type](), type)
      expectBytes(out, CLEAN[type]())
      expect(has(out, GPS_MARK)).toBe(false)
    }
  })

  it('every strict prefix of a picture is refused, never a throw and never half a picture', () => {
    for (const type of TYPES) {
      const whole = SAMPLE[type]()
      for (let len = 0; len < whole.length; len++) expect(strip(whole.subarray(0, len), type)).toBeNull()
      expect(strip(whole, type)).not.toBeNull()
    }
  })
})

// ================================================================================================= JPEG

describe('strip: JPEG', () => {
  it('drops APP1 (EXIF and XMP) and APP13, and keeps the rest of the file byte for byte', () => {
    const input = jpeg([JFIF, APP1_EXIF, DQT, APP1_XMP, SOF0, APP13, DHT, COMMENT, ICC])
    const out = strip(input, JPEG)
    expectBytes(out, jpeg([JFIF, DQT, SOF0, DHT, COMMENT, ICC]))
    expect(has(out, GPS_MARK)).toBe(false)
    expect(has(out, ascii('Exif'))).toBe(true) // the scan data still carries those letters: it is image data
    expect(has(out, ascii('Photoshop'))).toBe(false)
    expect(has(out, ascii('xap'))).toBe(false)
  })

  it('drops APP1 whatever its identifier says, and whatever it holds', () => {
    const payloads = [
      EXIF_GPS,
      ascii('http://ns.adobe.com/xap/1.0/\0<x/>'),
      ascii('Foo\0'),
      ascii('Exif'),
      ascii('exif\0\0'),
      Uint8Array.of(0x00),
      Uint8Array.of(),
      new Uint8Array(1000).fill(0xff),
      cat(SOI, JFIF, SOS_HEADER, [1, 2], EOI), // an embedded thumbnail, EOI and all
    ]
    for (const payload of payloads) expectBytes(strip(jpeg([JFIF, seg(0xe1, payload), DQT]), JPEG), jpeg([JFIF, DQT]))
  })

  it('treats every marker as the table says: only APP1 and APP13 go', () => {
    const OFF = new Set([0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xff, 0x00, 0x01])
    for (let code = 0; code < 256; code++) {
      const input = jpeg([JFIF, seg(code, [0xaa, 0xbb, 0xcc]), DQT])
      const out = strip(input, JPEG)
      if (OFF.has(code)) expect(out, `marker ${code.toString(16)}`).toBeNull()
      else if (code === 0xe1 || code === 0xed) expectBytes(out, jpeg([JFIF, DQT]))
      else expectBytes(out, input)
    }
  })

  it('keeps the scan data byte for byte: stuffed bytes, restart markers and look-alikes of metadata', () => {
    const scan = cat(
      [0xff, 0x00, 0xff, 0x00, 0xff, 0x00],
      [0xff, 0xd0, 0x01, 0xff, 0xd1, 0x02, 0xff, 0xd7, 0x03],
      [0xff, 0x00, 0xe1, 0x00, 0x08],
      ascii('Exif\0\0'),
      [0xff, 0x00, 0xed, 0x00, 0x08],
      [0xff, 0x00, 0xff, 0xd2, 0x44],
    )
    const out = strip(jpeg([JFIF, APP1_EXIF, DQT], scan), JPEG)
    expectBytes(out, jpeg([JFIF, DQT], scan))
  })

  it('finds metadata after the first scan too, and keeps every scan of a progressive file', () => {
    const second = cat(SOS_HEADER, [0x21, 0xff, 0x00, 0x22])
    const input = cat(SOI, JFIF, DQT, SOF0, SOS_HEADER, SCAN, APP1_EXIF, DHT, APP13, second, APP1_XMP, EOI)
    const expected = cat(SOI, JFIF, DQT, SOF0, SOS_HEADER, SCAN, DHT, second, EOI)
    const out = strip(input, JPEG)
    expectBytes(out, expected)
    expect(has(out, GPS_MARK)).toBe(false)
  })

  it('keeps fill bytes before a marker, as they are', () => {
    const input = cat(SOI, JFIF, [0xff, 0xff], DQT, [0xff], APP1_EXIF, [0xff, 0xff, 0xff], SOF0, SOS_HEADER, SCAN, [0xff, 0xff], EOI)
    expectBytes(strip(input, JPEG), cat(SOI, JFIF, [0xff, 0xff], DQT, [0xff], [0xff, 0xff, 0xff], SOF0, SOS_HEADER, SCAN, [0xff, 0xff], EOI))
  })

  it('does not stop at an EOI that sits inside a segment it keeps or drops', () => {
    const inside = seg(0xfe, [1, 2, 0xff, 0xd9, 3, 4])
    const input = jpeg([JFIF, inside, APP1_EXIF, DQT])
    expectBytes(strip(input, JPEG), jpeg([JFIF, inside, DQT]))
  })

  it('drops what follows the final EOI: a hidden second picture, motion data, anything', () => {
    const hidden = cat(SOI, APP1_EXIF, SOS_HEADER, SCAN, EOI, ascii('GPSLatitude tail'))
    for (const trailing of [hidden, [0], [0xff], [0xff, 0xd9], new Uint8Array(500).fill(0x41)]) {
      const out = strip(cat(jpeg(), trailing), JPEG)
      expectBytes(out, jpeg())
      expect(has(out, GPS_MARK)).toBe(false)
    }
  })

  it('ends at the first EOI after a scan, not at a later one', () => {
    const doubled = cat(jpeg(), EOI)
    expectBytes(strip(doubled, JPEG), jpeg())
  })

  it('is null for a JPEG with no scan, however the rest looks', () => {
    expect(strip(cat(SOI, JFIF, DQT, SOF0, EOI), JPEG)).toBeNull()
    expect(strip(cat(SOI, EOI), JPEG)).toBeNull()
    expect(strip(cat(SOI, [0xff], EOI), JPEG)).toBeNull()
    expect(strip(cat(SOI, JFIF, APP1_EXIF), JPEG)).toBeNull()
    expect(strip(cat(SOI, [0xff, 0xe0]), JPEG)).toBeNull()
  })

  it('is null for a JPEG that is not finished: no EOI, a scan that runs to the end', () => {
    expect(strip(cat(SOI, JFIF, SOS_HEADER, [0x12, 0x34, 0x56]), JPEG)).toBeNull()
    expect(strip(cat(SOI, JFIF, SOS_HEADER), JPEG)).toBeNull()
    expect(strip(cat(SOI, JFIF, SOS_HEADER, [0x12, 0xff]), JPEG)).toBeNull()
    expect(strip(cat(SOI, JFIF, SOS_HEADER, [0x12, 0xff, 0xff, 0xff]), JPEG)).toBeNull()
    expect(strip(cat(SOI, JFIF, SOS_HEADER, [0x12, 0xff, 0x00]), JPEG)).toBeNull()
    expect(strip(cat(SOI, JFIF, SOS_HEADER, [0x12, 0xff, 0xd0, 0x00]), JPEG)).toBeNull()
    expect(strip(cat(SOI, JFIF, SOS_HEADER, SCAN, [0xff, 0xff]), JPEG)).toBeNull()
  })

  it('is null for a segment that says it is longer than the file, by one byte or by a lot', () => {
    const exact = jpeg([JFIF, APP1_EXIF])
    const at = exact.length - EOI.length - SOS_HEADER.length - SCAN.length - APP1_EXIF.length
    expect(at).toBeGreaterThan(0)
    const room = exact.length - at - 2 // what the file holds from the length field to the end
    for (const claim of [room + 1, room + 2, 0x7fff, 0x8000, 0xfffe, 0xffff]) {
      const bad = Uint8Array.from(exact)
      bad.set(be16(claim), at + 2)
      expect(strip(bad, JPEG), `claim ${claim}`).toBeNull()
    }
    // the same lengths on a segment that would be kept
    const kept = jpeg([JFIF, seg(0xe2, [1, 2, 3])])
    const keptAt = kept.length - EOI.length - SOS_HEADER.length - SCAN.length - 7
    const bad = Uint8Array.from(kept)
    bad.set(be16(0xffff), keptAt + 2)
    expect(strip(bad, JPEG)).toBeNull()
  })

  it('is null for a segment length below 2, which cannot even hold itself', () => {
    for (const code of [0xe0, 0xe1, 0xed, 0xdb, 0xfe]) {
      for (const claim of [0, 1]) {
        const input = cat(SOI, [0xff, code], be16(claim), [1, 2, 3, 4], SOS_HEADER, SCAN, EOI)
        expect(strip(input, JPEG), `${code.toString(16)} claims ${claim}`).toBeNull()
      }
    }
  })

  it('takes a segment of length 2, which holds nothing, and drops it when it is APP1', () => {
    expectBytes(strip(jpeg([JFIF, seg(0xe1), DQT]), JPEG), jpeg([JFIF, DQT]))
    expectBytes(strip(jpeg([JFIF, seg(0xe2), DQT]), JPEG), jpeg([JFIF, seg(0xe2), DQT]))
  })

  it('accepts a segment that ends exactly at the end of the file only if the file is finished', () => {
    expect(strip(cat(SOI, JFIF, [0xff, 0xe1, 0x00, 0x04, 0xaa]), JPEG)).toBeNull() // one byte short of its own length
    expect(strip(cat(SOI, JFIF, [0xff, 0xe1, 0x00, 0x04, 0xaa, 0xbb]), JPEG)).toBeNull() // fits, but no scan and no EOI
    expect(strip(cat(SOI, JFIF, [0xff, 0xe1, 0x00]), JPEG)).toBeNull() // the length field is cut
    expect(strip(cat(SOI, JFIF, [0xff, 0xe1]), JPEG)).toBeNull() // no length at all
    expect(strip(cat(SOI, JFIF, [0xff]), JPEG)).toBeNull()
  })

  it('is null for an SOS header whose length is below 2', () => {
    for (const claim of [0, 1]) expect(strip(cat(SOI, JFIF, [0xff, 0xda], be16(claim), SCAN, EOI), JPEG), `claim ${claim}`).toBeNull()
  })

  it('reads the byte after an 0xFF in a scan as the format says, for every byte value', () => {
    for (let code = 0; code < 256; code++) {
      const input = cat(SOI, JFIF, SOS_HEADER, [0x12, 0xff, code, 0x34], EOI)
      const out = strip(input, JPEG)
      if (code === 0x00 || (code >= 0xd0 && code <= 0xd7)) expectBytes(out, input) // data: a stuffed byte, a restart
      else if (code === 0xd9) expectBytes(out, cat(SOI, JFIF, SOS_HEADER, [0x12, 0xff, 0xd9])) // the end, early
      else expect(out, `code ${code.toString(16)}`).toBeNull() // a marker that has no business here, or a length that overruns
    }
  })

  it('knows fill bytes inside a scan: they come before the marker or the stuffed byte that ends them', () => {
    for (const scan of [[0x12, 0xff, 0xff, 0x00, 0x34], [0x12, 0xff, 0xff, 0xff, 0xd3, 0x34], [0x12, 0xff, 0xff, 0xd0], [0x12, 0xff, 0xff, 0xff, 0x00]]) {
      expectBytes(strip(jpeg([JFIF], scan), JPEG), jpeg([JFIF], scan))
    }
    expectBytes(strip(jpeg([JFIF], [0x12, 0xff, 0xff, 0xff], [APP1_EXIF]), JPEG), jpeg([JFIF], [0x12, 0xff, 0xff, 0xff]))
  })

  it('ends a scan at any marker that is not a restart: a table or a second scan straight after it', () => {
    const input = cat(SOI, JFIF, SOS_HEADER, SCAN, DHT, APP13, DQT, SOS_HEADER, SCAN, seg(0xc4, [1]), EOI)
    expectBytes(strip(input, JPEG), cat(SOI, JFIF, SOS_HEADER, SCAN, DHT, DQT, SOS_HEADER, SCAN, seg(0xc4, [1]), EOI))
  })

  it('takes an empty segment as the last thing before the EOI, and drops it when it is APP1', () => {
    expectBytes(strip(cat(SOI, JFIF, SOS_HEADER, SCAN, seg(0xdb), EOI), JPEG), cat(SOI, JFIF, SOS_HEADER, SCAN, seg(0xdb), EOI))
    expectBytes(strip(cat(SOI, JFIF, SOS_HEADER, SCAN, seg(0xe1), EOI), JPEG), cat(SOI, JFIF, SOS_HEADER, SCAN, EOI))
  })

  it('is null for bytes where a marker has to be, and for markers that cannot stand there', () => {
    expect(strip(cat(SOI, JFIF, [0x00], DQT, SOS_HEADER, SCAN, EOI), JPEG)).toBeNull()
    expect(strip(cat(SOI, JFIF, [0xaa, 0xbb], SOS_HEADER, SCAN, EOI), JPEG)).toBeNull()
    expect(strip(cat(SOI, JFIF, [0xff, 0x00], SOS_HEADER, SCAN, EOI), JPEG)).toBeNull()
    expect(strip(cat(SOI, JFIF, [0xff, 0xd0], SOS_HEADER, SCAN, EOI), JPEG)).toBeNull()
    expect(strip(cat(SOI, JFIF, [0xff, 0xd8], SOS_HEADER, SCAN, EOI), JPEG)).toBeNull()
    expect(strip(cat(SOI, JFIF, [0xff, 0x01], SOS_HEADER, SCAN, EOI), JPEG)).toBeNull()
    // after a scan
    expect(strip(cat(SOI, JFIF, SOS_HEADER, SCAN, [0xff, 0xd8], EOI), JPEG)).toBeNull()
  })

  it('stays linear on a scan made of nothing but 0xFF, and on one made of nothing but stuffing', () => {
    const run = new Uint8Array(2_000_000).fill(0xff)
    expect(strip(cat(SOI, JFIF, SOS_HEADER, run), JPEG)).toBeNull()
    expectBytes(strip(cat(SOI, JFIF, SOS_HEADER, run, [0xd9]), JPEG), cat(SOI, JFIF, SOS_HEADER, run, [0xd9]))
  })

  it('is null for a header made of a million fill bytes with no marker after them', () => {
    expect(strip(cat(SOI, new Uint8Array(1_000_000).fill(0xff)), JPEG)).toBeNull()
  })
})

// ================================================================================================= PNG

describe('strip: PNG', () => {
  it('drops tEXt, zTXt, iTXt and eXIf, and keeps IHDR, IDAT and IEND exactly', () => {
    const input = png(IHDR, PNG_METADATA[0], IDAT, PNG_METADATA[1], PNG_METADATA[2], IDAT, PNG_METADATA[3], IEND)
    const out = strip(input, PNG)
    expectBytes(out, png(IHDR, IDAT, IDAT, IEND))
    expect(has(out, GPS_MARK)).toBe(false)
    expect(has(out, ascii('GPSLatitudeRef'))).toBe(false)
  })

  it('keeps the image data intact even when it looks like metadata', () => {
    const lookAlike = chunk('IDAT', cat(be32(5), ascii('tEXt'), ascii('Comment'), be32(0), be32(4), ascii('eXIf'), GPS_MARK))
    const out = strip(png(IHDR, PNG_METADATA[0], lookAlike, IEND), PNG)
    expectBytes(out, png(IHDR, lookAlike, IEND))
    expect(has(out, GPS_MARK)).toBe(true) // inside the IDAT: image data, not ours to touch
  })

  it('keeps every other chunk, tIME and the animation chunks included, so an animated PNG stays animated', () => {
    const kept = [
      'tIME',
      'pHYs',
      'gAMA',
      'cHRM',
      'sRGB',
      'iCCP',
      'sBIT',
      'bKGD',
      'PLTE',
      'tRNS',
      'hIST',
      'sPLT',
      'acTL',
      'fcTL',
      'fdAT',
      'oFFs',
      'zzzz',
      'TEXT',
      'text',
      'Exif',
      'exif',
      'EXIf',
      'eXIF',
      'tEXT',
    ]
    for (const type of kept) {
      const input = png(IHDR, chunk(type, [1, 2, 3]), IDAT, IEND)
      expectBytes(strip(input, PNG), input)
    }
    const apng = png(
      IHDR,
      chunk('acTL', [be32(2), be32(0)]),
      chunk('fcTL', new Array(26).fill(1)),
      IDAT,
      chunk('fcTL', new Array(26).fill(2)),
      chunk('fdAT', [be32(2), 1, 2, 3]),
      PNG_METADATA[0],
      IEND,
    )
    expectBytes(strip(apng, PNG), png(IHDR, chunk('acTL', [be32(2), be32(0)]), chunk('fcTL', new Array(26).fill(1)), IDAT, chunk('fcTL', new Array(26).fill(2)), chunk('fdAT', [be32(2), 1, 2, 3]), IEND))
  })

  it('drops the four chunk types and no other, at any place between IHDR and IEND', () => {
    const dropped = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf'])
    for (const type of ['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'iCCP', 'IDAT', 'abcd']) {
      const mid = chunk(type, GPS_MARK)
      const input = png(IHDR, mid, IDAT, IEND)
      const out = strip(input, PNG)
      expectBytes(out, dropped.has(type) ? png(IHDR, IDAT, IEND) : input)
    }
  })

  it('drops metadata chunks with no data, and keeps empty chunks that are not metadata', () => {
    expectBytes(strip(png(IHDR, chunk('tEXt'), chunk('zTXt'), chunk('iTXt'), chunk('eXIf'), IDAT, IEND), PNG), png(IHDR, IDAT, IEND))
    const empty = png(IHDR, chunk('tIME'), chunk('abcd'), chunk('IDAT'), IDAT, IEND)
    expectBytes(strip(empty, PNG), empty)
  })

  it('leaves the CRCs as they are: it checks the structure, not the checksums', () => {
    const badCrc = Uint8Array.from(png(IHDR, chunk('pHYs', [1, 2, 3, 4]), IDAT, IEND))
    badCrc[PNG_SIG.length + IHDR.length + 12 + 1] ^= 0xff // the second byte of the pHYs chunk's CRC
    expectBytes(strip(badCrc, PNG), badCrc)
  })

  it('drops what follows IEND: leftover bytes, a second picture, anything', () => {
    const leftover = png(IHDR, IDAT, IEND, ascii('GPSLatitude left in the file by an editor'))
    const second = png(IHDR, PNG_METADATA[0], IDAT, IEND, cat(PNG_SIG, IHDR, IDAT, IEND))
    for (const input of [leftover, second, cat(png(IHDR, IDAT, IEND), [0]), cat(png(IHDR, IDAT, IEND), new Uint8Array(100_000))]) {
      const out = strip(input, PNG)
      expectBytes(out, png(IHDR, IDAT, IEND))
      expect(has(out, GPS_MARK)).toBe(false)
    }
  })

  it('is null for a PNG that does not start with an IHDR of 13 bytes', () => {
    expect(strip(png(IDAT, IEND), PNG)).toBeNull()
    expect(strip(png(PNG_METADATA[0], IHDR, IDAT, IEND), PNG)).toBeNull()
    expect(strip(png(chunk('IHDR', new Array(12).fill(0)), IDAT, IEND), PNG)).toBeNull()
    // thirteen bytes of something else first
    expect(strip(png(chunk('tEXt', new Array(13).fill(0x41)), IHDR, IDAT, IEND), PNG)).toBeNull()
    expect(strip(png(chunk('IDAT', new Array(13).fill(0x41)), IDAT, IEND), PNG)).toBeNull()
    expect(strip(png(chunk('IHDX', new Array(13).fill(0)), IDAT, IEND), PNG)).toBeNull()
    expect(strip(png(chunk('IHDR', new Array(14).fill(0)), IDAT, IEND), PNG)).toBeNull()
    expect(strip(png(IEND), PNG)).toBeNull()
    expect(strip(png(), PNG)).toBeNull()
    expect(strip(cat(PNG_SIG), PNG)).toBeNull()
  })

  it('is null for a PNG with no image data, or no end', () => {
    expect(strip(png(IHDR, IEND), PNG)).toBeNull()
    expect(strip(png(IHDR, PNG_METADATA[0], IEND), PNG)).toBeNull()
    expect(strip(png(IHDR, IDAT), PNG)).toBeNull()
    expect(strip(png(IHDR, IDAT, PNG_METADATA[0]), PNG)).toBeNull()
    expect(strip(png(IHDR, IDAT, IEND.subarray(0, 11)), PNG)).toBeNull()
  })

  it('is null for an IEND that is not empty', () => {
    expect(strip(png(IHDR, IDAT, chunk('IEND', ascii('GPSLatitude'))), PNG)).toBeNull()
    expect(strip(png(IHDR, IDAT, chunk('IEND', [0])), PNG)).toBeNull()
  })

  it('is null for a chunk length that overruns the file: by one, by a lot, and near and above 2^31', () => {
    const base = png(IHDR, PNG_METADATA[0], IDAT, IEND)
    const at = PNG_SIG.length + IHDR.length // the tEXt chunk's length field
    const own = PNG_METADATA[0].length - 12
    expect(Buffer.from(base).readUInt32BE(at)).toBe(own)
    const room = base.length - at - 12 // the most a chunk here can claim
    for (const claim of [room + 1, room + 2, own + 100_000, 0x7ffffffe, 0x7fffffff, 0x80000000, 0x80000001, 0xfffffffe, 0xffffffff]) {
      const bad = Uint8Array.from(base)
      bad.set(be32(claim), at)
      expect(strip(bad, PNG), `claim ${claim}`).toBeNull()
    }
    // and on a chunk that would be kept, or the last one
    for (const claim of [0x7fffffff, 0x80000000, 0xffffffff]) {
      const bad = Uint8Array.from(base)
      bad.set(be32(claim), at + PNG_METADATA[0].length) // the IDAT's length
      expect(strip(bad, PNG), `claim ${claim}`).toBeNull()
      const badEnd = Uint8Array.from(base)
      badEnd.set(be32(claim), base.length - 12)
      expect(strip(badEnd, PNG), `claim ${claim}`).toBeNull()
    }
  })

  it('takes a chunk that claims exactly what is left, and not one byte more', () => {
    const base = Uint8Array.from(png(IHDR, IDAT, IEND))
    expectBytes(strip(base, PNG), base)
    const tight = png(IHDR, IDAT, chunk('tEXt', [1, 2, 3]))
    expect(strip(tight, PNG)).toBeNull() // no IEND, but the tEXt itself fits to the last byte
    expect(strip(tight.subarray(0, tight.length - 1), PNG)).toBeNull()
    expect(strip(cat(png(IHDR, IDAT), [0, 0, 0, 0, ...ascii('IEND'), 0xae, 0x42, 0x60]), PNG)).toBeNull()
  })

  it('is null for a header cut anywhere inside a chunk header, and for a length field of 0 with no room for a CRC', () => {
    for (let cut = 1; cut < 12; cut++) {
      expect(strip(cat(png(IHDR, IDAT), IEND.subarray(0, cut)), PNG), `cut ${cut}`).toBeNull()
    }
    expect(strip(png(IHDR, IDAT, [0, 0, 0, 0], ascii('IEND')), PNG)).toBeNull()
  })

  it('does not loop on a file of zero-length chunks, and still reaches the end', () => {
    const zeros = new Uint8Array(12 * 50_000) // a chunk each: length 0, type 0, crc 0
    expect(strip(png(IHDR, IDAT, zeros), PNG)).toBeNull()
    expectBytes(strip(png(IHDR, IDAT, zeros, IEND), PNG), png(IHDR, IDAT, zeros, IEND))
  })
})

// ================================================================================================= WebP

describe('strip: WebP', () => {
  const sizeField = (webpBytes) => Buffer.from(webpBytes).readUInt32LE(4)

  it('drops EXIF and XMP and fixes the RIFF size, the VP8X flags for them included', () => {
    const input = webp(vp8x(FLAG.exif | FLAG.xmp), VP8, EXIF_CHUNK, XMP_CHUNK)
    const out = strip(input, WEBP)
    expectBytes(out, webp(vp8x(0), VP8))
    expect(sizeField(out)).toBe(out.length - 8)
    expect(has(out, GPS_MARK)).toBe(false)
  })

  it('writes the RIFF size of the shorter file, wherever the dropped chunks were', () => {
    const chunks = [vp8x(FLAG.exif), EXIF_CHUNK, riff('ICCP', [1, 2, 3]), XMP_CHUNK, VP8, EXIF_CHUNK]
    const out = strip(webp(...chunks), WEBP)
    expectBytes(out, webp(vp8x(0), riff('ICCP', [1, 2, 3]), VP8))
    expect(sizeField(out)).toBe(out.length - 8)
    expect(out.length % 2).toBe(0)
  })

  it('clears the EXIF and XMP flags and keeps every other flag, for all 256 flag bytes', () => {
    for (let flags = 0; flags < 256; flags++) {
      const out = strip(webp(vp8x(flags), VP8, EXIF_CHUNK), WEBP)
      expectBytes(out, webp(vp8x(flags & ~(FLAG.exif | FLAG.xmp) & 0xff), VP8))
      expect(out[20]).toBe(flags & 0xf3)
    }
  })

  it('leaves the rest of the VP8X chunk, the canvas size, alone', () => {
    const wide = riff('VP8X', [FLAG.exif, 9, 9, 9, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66])
    expectBytes(strip(webp(wide, VP8, EXIF_CHUNK), WEBP), webp(riff('VP8X', [0, 9, 9, 9, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]), VP8))
  })

  it('drops the padding byte of an odd-sized dropped chunk, and keeps the padding of an odd kept one', () => {
    const oddExif = riff('EXIF', [1, 2, 3])
    expect(oddExif.length).toBe(12)
    const oddKept = riff('ICCP', [1, 2, 3, 4, 5])
    expect(oddKept.length).toBe(14)
    expectBytes(strip(webp(vp8x(FLAG.exif | FLAG.icc), oddKept, VP8, oddExif), WEBP), webp(vp8x(FLAG.icc), oddKept, VP8))
    const oddImage = riff('VP8 ', [1, 2, 3, 4, 5])
    expectBytes(strip(webp(vp8x(0), oddImage, oddExif), WEBP), webp(vp8x(0), oddImage))
  })

  it('keeps every other chunk, so an animated WebP stays animated', () => {
    const kept = [riff('ICCP', [1, 2]), riff('ANIM', [0, 0, 0, 0, 0, 0]), riff('ALPH', [1, 2, 3, 4]), riff('ANMF', cat(new Array(16).fill(1), VP8)), riff('ANMF', cat(new Array(16).fill(2), VP8L)), riff('abcd', [1]), riff('exif', [1]), riff('Exif', [1]), riff('xmp ', [1]), riff('XMP\0', [1])]
    const animated = webp(vp8x(FLAG.anim | FLAG.alpha | FLAG.exif), ...kept, EXIF_CHUNK, XMP_CHUNK)
    expectBytes(strip(animated, WEBP), webp(vp8x(FLAG.anim | FLAG.alpha), ...kept))
  })

  it('takes a lossless image, and a plain lossy one with no VP8X, and changes neither', () => {
    expectBytes(strip(webp(VP8L), WEBP), webp(VP8L))
    expectBytes(strip(webp(VP8), WEBP), webp(VP8))
    expectBytes(strip(webp(VP8, EXIF_CHUNK), WEBP), webp(VP8))
    expectBytes(strip(webp(VP8L, XMP_CHUNK), WEBP), webp(VP8L))
  })

  it('keeps look-alikes inside the image data', () => {
    const tricky = riff('VP8 ', cat(riff('EXIF', [1, 2]), ascii('XMP '), le32(2), GPS_MARK, [0]))
    const out = strip(webp(vp8x(FLAG.exif), tricky, EXIF_CHUNK), WEBP)
    expectBytes(out, webp(vp8x(0), tricky))
    expect(has(out, GPS_MARK)).toBe(true)
  })

  it('drops an empty EXIF or XMP chunk', () => {
    expectBytes(strip(webp(vp8x(FLAG.exif | FLAG.xmp), VP8, riff('EXIF'), riff('XMP ')), WEBP), webp(vp8x(0), VP8))
  })

  it('drops what lies beyond the RIFF size: trailing bytes are not part of the picture', () => {
    for (const trailing of [[0], [1, 2, 3], ascii('GPSLatitude'), cat(ascii('EXIF'), le32(4), [1, 2, 3, 4])]) {
      const out = strip(cat(webp(VP8), trailing), WEBP)
      expectBytes(out, webp(VP8))
      expect(has(out, GPS_MARK)).toBe(false)
    }
  })

  it('is null for a RIFF size that claims more than the file holds, by one or by a lot', () => {
    const base = webp(vp8x(0), VP8)
    const real = base.length - 8
    for (const claim of [real + 1, real + 2, real + 1000, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff]) {
      const bad = Uint8Array.from(base)
      bad.set(le32(claim), 4)
      expect(strip(bad, WEBP), `claim ${claim}`).toBeNull()
    }
  })

  it('is null for a RIFF size too small to hold the chunks it carries, and for an odd one', () => {
    const base = webp(vp8x(0), VP8)
    const real = base.length - 8
    for (const claim of [0, 1, 3, 4, 5, 8, 12, 17, 18, 21, 28, real - 2, real - 1, real - 8]) {
      const bad = Uint8Array.from(base)
      bad.set(le32(claim), 4)
      expect(strip(bad, WEBP), `claim ${claim}`).toBeNull()
    }
  })

  it('takes a RIFF size that ends the file early between chunks, and drops the rest', () => {
    const keep = webp(vp8x(0), VP8)
    const longer = cat(keep, EXIF_CHUNK)
    longer.set(le32(keep.length - 8), 4)
    expectBytes(strip(longer, WEBP), keep)
  })

  it('is null for a chunk size that overruns the RIFF, even when the file has the bytes', () => {
    const base = webp(vp8x(0), VP8, EXIF_CHUNK)
    const vp8At = 12 + vp8x(0).length
    for (const claim of [VP8.length - 8 + 1, VP8.length - 8 + 2, VP8.length + EXIF_CHUNK.length, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff]) {
      const bad = Uint8Array.from(base)
      bad.set(le32(claim), vp8At + 4)
      expect(strip(bad, WEBP), `claim ${claim}`).toBeNull()
    }
    const exifAt = vp8At + VP8.length
    for (const claim of [EXIF_CHUNK.length - 8 + 1, 0x7fffffff, 0x80000000, 0xffffffff]) {
      const bad = Uint8Array.from(base)
      bad.set(le32(claim), exifAt + 4)
      expect(strip(bad, WEBP), `claim ${claim}`).toBeNull()
    }
  })

  it('is null for a chunk that fits only without its padding byte, and for a chunk header cut short', () => {
    const noPad = webp(vp8x(0), VP8, riff('EXIF', [1, 2, 3]).subarray(0, 11))
    expect(strip(noPad, WEBP)).toBeNull()
    expect(strip(webp(vp8x(0), VP8, ascii('EXIF').subarray(0, 4)), WEBP)).toBeNull()
    expect(strip(webp(vp8x(0), VP8, cat(ascii('EXIF'), [0, 0, 0])), WEBP)).toBeNull()
    expect(strip(webp(vp8x(0), VP8, [0]), WEBP)).toBeNull()
    for (let cut = 1; cut < 8; cut++) expect(strip(webp(VP8, EXIF_CHUNK.subarray(0, cut)), WEBP), `cut ${cut}`).toBeNull()
  })

  it('takes a last chunk that fits to the very last byte', () => {
    expectBytes(strip(webp(vp8x(FLAG.icc), riff('ICCP', [1, 2, 3, 4]), VP8), WEBP), webp(vp8x(FLAG.icc), riff('ICCP', [1, 2, 3, 4]), VP8))
    expectBytes(strip(webp(vp8x(0), VP8, EXIF_CHUNK), WEBP), webp(vp8x(0), VP8))
  })

  it('is null for a WebP with no image, or whose first chunk is not a picture chunk', () => {
    expect(strip(webp(), WEBP)).toBeNull()
    expect(strip(webp(vp8x(0)), WEBP)).toBeNull()
    expect(strip(webp(vp8x(FLAG.exif), EXIF_CHUNK), WEBP)).toBeNull()
    expect(strip(webp(EXIF_CHUNK), WEBP)).toBeNull()
    expect(strip(webp(EXIF_CHUNK, VP8), WEBP)).toBeNull()
    expect(strip(webp(riff('abcd', [1]), VP8), WEBP)).toBeNull()
    expect(strip(webp(riff('ANMF', [1, 2, 3])), WEBP)).toBeNull()
    expect(strip(webp(riff('ALPH', [1, 2, 3]), VP8), WEBP)).toBeNull()
  })

  it('counts an animation frame as a picture', () => {
    const frameOnly = webp(vp8x(FLAG.anim), riff('ANMF', [1, 2, 3, 4]))
    expectBytes(strip(frameOnly, WEBP), frameOnly)
  })

  it('is null for a VP8X chunk that is not 10 bytes', () => {
    for (const size of [0, 1, 9, 11, 12, 100]) {
      expect(strip(webp(riff('VP8X', new Array(size).fill(0)), VP8), WEBP), `size ${size}`).toBeNull()
    }
  })

  it('is null for a header that is only the RIFF header, and for a file cut inside it', () => {
    expect(strip(cat(ascii('RIFF'), le32(4), ascii('WEBP')), WEBP)).toBeNull()
    expect(strip(cat(ascii('RIFF'), le32(0), ascii('WEBP')), WEBP)).toBeNull()
    expect(strip(cat(ascii('RIFF'), le32(5), ascii('WEBP'), [0]), WEBP)).toBeNull()
  })
})

// ================================================================================================= GIF

describe('strip: GIF', () => {
  it('drops comment extensions, and keeps the frames, their timing and the looping block exactly', () => {
    const input = gif(NETSCAPE, GIF_COMMENT, GCE, frame([1, 2, 3]), GIF_COMMENT, GCE, frame([4, 5, 6], { lct: true }), GIF_COMMENT)
    const out = strip(input, GIF)
    expectBytes(out, gif(NETSCAPE, GCE, frame([1, 2, 3]), GCE, frame([4, 5, 6], { lct: true })))
    expect(has(out, GPS_MARK)).toBe(false)
  })

  it('drops a comment of many sub-blocks, an empty one, and one that holds bytes that look like block starts', () => {
    const many = ext(0xfe, new Uint8Array(700).fill(0x41), ascii('GPSLatitude'))
    const empty = ext(0xfe)
    const lookAlike = ext(0xfe, [0x3b, 0x2c, 0x21, 0xf9, 0x04, 0x00, 0x21, 0xfe, 0x00])
    for (const comment of [many, empty, lookAlike, ext(0xfe, [1])]) {
      expectBytes(strip(gif(comment, frame(), comment), GIF), gif(frame()))
    }
  })

  it('keeps the other extensions, including XMP and ICC application blocks, as the brief says', () => {
    const others = [
      GCE,
      NETSCAPE,
      ext(0xff, ascii('ANIMEXTS1.0'), [1, 0, 0]),
      ext(0xff, ascii('XMP DataXMP'), ascii('<x:xmpmeta/>')),
      ext(0xff, ascii('ICCRGBG1012'), [1, 2, 3]),
      ext(0x01, [12, 0, 0, 0, 0, 2, 0, 2, 0, 1, 1, 0, 0], ascii('hi')),
      ext(0x00, [1]),
      ext(0xfd, [1]),
      ext(0xff, [1]),
      ext(0xf9, [4, 0, 0, 0, 0]),
    ]
    for (const other of others) {
      const input = gif(other, frame())
      expectBytes(strip(input, GIF), input)
    }
  })

  it('drops only the comment extension label, 0xFE', () => {
    for (let label = 0; label < 256; label++) {
      const input = gif(ext(label, [9, 9, 9]), frame())
      expectBytes(strip(input, GIF), label === 0xfe ? gif(frame()) : input)
    }
  })

  it('does not touch bytes inside an image, whatever they look like', () => {
    const input = gif(GIF_COMMENT, FRAME_TRAP, GIF_COMMENT)
    const out = strip(input, GIF)
    expectBytes(out, gif(FRAME_TRAP))
    expect(has(out, ascii('Exif'))).toBe(true)
  })

  it('takes both versions', () => {
    for (const version of ['87a', '89a']) {
      const input = cat(GIF_HEAD(version), GIF_COMMENT, frame(), [0x3b])
      expectBytes(strip(input, GIF), cat(GIF_HEAD(version), frame(), [0x3b]))
    }
  })

  it('knows a global colour table of every size, and a file with none', () => {
    for (let size = 0; size < 8; size++) {
      const table = new Array(3 * 2 ** (size + 1)).fill(0x55)
      const head = cat(ascii('GIF89a'), le16(2), le16(2), [0x80 | size, 0, 0], table)
      expectBytes(strip(cat(head, GIF_COMMENT, frame(), [0x3b]), GIF), cat(head, frame(), [0x3b]))
      // the same without the flag: the bytes of the table are then blocks, which are not
      const flagless = cat(ascii('GIF89a'), le16(2), le16(2), [size, 0, 0], table)
      expect(strip(cat(flagless, frame(), [0x3b]), GIF)).toBeNull()
    }
    const bare = cat(ascii('GIF89a'), le16(2), le16(2), [0x00, 0, 0])
    expectBytes(strip(cat(bare, GIF_COMMENT, frame(), [0x3b]), GIF), cat(bare, frame(), [0x3b]))
    // a flag-less size field is ignored: only the flag says there is a table
    const noFlagBits = cat(ascii('GIF89a'), le16(2), le16(2), [0x07, 0, 0])
    expectBytes(strip(cat(noFlagBits, frame(), [0x3b]), GIF), cat(noFlagBits, frame(), [0x3b]))
  })

  it('knows a local colour table of every size, and the flag bits that are not table bits', () => {
    for (let size = 0; size < 8; size++) {
      const table = new Array(3 * 2 ** (size + 1)).fill(0x66)
      const withTable = cat([0x2c], le16(0), le16(0), le16(2), le16(2), [0x80 | size], table, [2], subBlocks([1, 2, 3]))
      expectBytes(strip(gif(GIF_COMMENT, withTable), GIF), gif(withTable))
    }
    // interlace (0x40), sort (0x20) and reserved bits must not change the table size
    for (const flags of [0x40, 0x20, 0x18, 0x07, 0x78]) {
      const noTable = cat([0x2c], le16(0), le16(0), le16(2), le16(2), [flags], [2], subBlocks([1, 2, 3]))
      expectBytes(strip(gif(GIF_COMMENT, noTable), GIF), gif(noTable))
    }
  })

  it('drops what follows the trailer', () => {
    for (const trailing of [[0], ascii('GPSLatitude'), cat(GIF_HEAD(), GIF_COMMENT, frame(), [0x3b]), [0x3b], [0x21, 0xfe]]) {
      const out = strip(cat(gif(frame()), trailing), GIF)
      expectBytes(out, gif(frame()))
      expect(has(out, GPS_MARK)).toBe(false)
    }
  })

  it('is null for a GIF with no trailer, or with no image', () => {
    expect(strip(cat(GIF_HEAD(), frame()), GIF)).toBeNull()
    expect(strip(cat(GIF_HEAD(), frame(), GIF_COMMENT), GIF)).toBeNull()
    expect(strip(cat(GIF_HEAD(), [0x3b]), GIF)).toBeNull()
    expect(strip(gif(GIF_COMMENT, GCE), GIF)).toBeNull()
    expect(strip(gif(), GIF)).toBeNull()
    expect(strip(GIF_HEAD(), GIF)).toBeNull()
  })

  it('is null for an unterminated sub-block chain, in a comment, in any extension and in an image', () => {
    const open = (head, blocks) => cat(GIF_HEAD(), head, blocks) // nothing closes it
    expect(strip(open([0x21, 0xfe], [3, 1, 2, 3]), GIF)).toBeNull()
    expect(strip(open([0x21, 0xfe], [3, 1, 2, 3, 3, 1, 2, 3]), GIF)).toBeNull()
    expect(strip(open([0x21, 0xfe], [255, ...new Array(255).fill(7)]), GIF)).toBeNull()
    expect(strip(open([0x21, 0xff], [11, ...ascii('NETSCAPE2.0')]), GIF)).toBeNull()
    expect(strip(open([0x21, 0xf9], [4, 0, 0, 0, 0]), GIF)).toBeNull()
    expect(strip(cat(GIF_HEAD(), [0x2c], le16(0), le16(0), le16(2), le16(2), [0, 2], [3, 1, 2, 3]), GIF)).toBeNull()
    // a trailer inside an unterminated chain is data, not a trailer
    expect(strip(open([0x21, 0xfe], [4, 1, 2, 3, 0x3b]), GIF)).toBeNull()
    expect(strip(open([0x21, 0xfe], [1, 0x3b]), GIF)).toBeNull()
    expect(strip(open([0x21, 0xfe], []), GIF)).toBeNull()
  })

  it('is null for a sub-block that says it is longer than the file, by one byte and by a lot', () => {
    for (const claim of [4, 5, 100, 254, 255]) {
      expect(strip(cat(GIF_HEAD(), [0x21, 0xfe, claim, 1, 2, 3], [0x3b]), GIF), `claim ${claim}`).toBeNull()
    }
    // the chain ends exactly at the end of the file, with no terminator
    expect(strip(cat(GIF_HEAD(), [0x21, 0xfe, 3, 1, 2, 3]), GIF)).toBeNull()
    expect(strip(cat(GIF_HEAD(), frame(), [0x21, 0xfe, 3, 1, 2, 3]), GIF)).toBeNull()
  })

  it('is null for a sub-block that swallows the trailer', () => {
    expect(strip(cat(GIF_HEAD(), [0x21, 0xfe, 2, 1, 2], [0x3b]), GIF)).toBeNull()
    expect(strip(cat(GIF_HEAD(), frame(), [0x21, 0xfe, 5, 1, 2, 3, 4], [0x3b]), GIF)).toBeNull()
  })

  it('is null for a byte that starts no block, and for the cut-off pieces of a block', () => {
    expect(strip(cat(GIF_HEAD(), [0x00], frame(), [0x3b]), GIF)).toBeNull()
    expect(strip(cat(GIF_HEAD(), [0x01], frame(), [0x3b]), GIF)).toBeNull()
    expect(strip(cat(GIF_HEAD(), [0xff], frame(), [0x3b]), GIF)).toBeNull()
    expect(strip(cat(GIF_HEAD(), frame(), [0x00, 0x3b]), GIF)).toBeNull()
    expect(strip(cat(GIF_HEAD(), [0x21]), GIF)).toBeNull()
    expect(strip(cat(GIF_HEAD(), [0x21, 0xfe]), GIF)).toBeNull()
    expect(strip(cat(GIF_HEAD(), [0x2c, 0, 0, 0, 0, 2, 0, 2, 0]), GIF)).toBeNull() // the descriptor is a byte short
    expect(strip(cat(GIF_HEAD(), [0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0]), GIF)).toBeNull() // and then no LZW size
    expect(strip(cat(GIF_HEAD(), [0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0, 2]), GIF)).toBeNull() // and no data
  })

  it('is null for a colour table that runs past the end, global or local', () => {
    expect(strip(cat(ascii('GIF89a'), le16(2), le16(2), [0xf7, 0, 0], new Array(767).fill(1)), GIF)).toBeNull()
    expect(strip(cat(ascii('GIF89a'), le16(2), le16(2), [0xf7, 0, 0], new Array(768).fill(1)), GIF)).toBeNull()
    expect(strip(cat(ascii('GIF89a'), le16(2), le16(2), [0xf7, 0, 0], new Array(768).fill(1), [0x3b]), GIF)).toBeNull()
    expect(strip(cat(GIF_HEAD(), [0x2c], le16(0), le16(0), le16(2), le16(2), [0xff], new Array(767).fill(1)), GIF)).toBeNull()
    expect(strip(cat(ascii('GIF89a'), le16(2), le16(2)), GIF)).toBeNull()
    expect(strip(cat(ascii('GIF89a'), le16(2), le16(2), [0x80, 0]), GIF)).toBeNull()
  })

  it('takes the smallest GIF there is, 26 bytes, with no colour table and an empty picture', () => {
    const smallest = cat(ascii('GIF89a'), le16(1), le16(1), [0, 0, 0], [0x2c], le16(0), le16(0), le16(1), le16(1), [0], [2, 0], [0x3b])
    expect(smallest.length).toBe(26)
    expectBytes(strip(smallest, GIF), smallest)
    expect(strip(smallest.subarray(0, 25), GIF)).toBeNull()
    expectBytes(strip(cat(smallest, [0x3b]), GIF), smallest)
    // the same at the end of a longer file
    const late = gif(GCE, frame([]))
    expectBytes(strip(late, GIF), late)
  })

  it('is null for every GIF shorter than the smallest, whatever its header says', () => {
    const header = cat(ascii('GIF89a'), le16(1), le16(1), [0, 0, 0])
    for (let len = 6; len < 26; len++) expect(strip(cat(header, new Uint8Array(20)).subarray(0, len), GIF)).toBeNull()
    for (let len = 6; len < 26; len++) expect(strip(cat(ascii('GIF87a'), new Uint8Array(20)).subarray(0, len), GIF)).toBeNull()
  })

  it('takes a comment, even an empty one, as the last block before the trailer', () => {
    expectBytes(strip(gif(frame(), ext(0xfe)), GIF), gif(frame()))
    expectBytes(strip(gif(frame(), ext(0xfe, [1])), GIF), gif(frame()))
    expectBytes(strip(gif(frame(), ext(0xf9)), GIF), gif(frame(), ext(0xf9)))
    expect(strip(cat(GIF_HEAD(), frame(), [0x21, 0xfe, 0]), GIF)).toBeNull() // and no trailer after it
    expect(strip(cat(GIF_HEAD(), frame(), [0x21, 0xfe]), GIF)).toBeNull()
    expect(strip(cat(GIF_HEAD(), frame(), [0x21]), GIF)).toBeNull()
  })

  it('takes a header that is the whole file but for the trailer and a frame, at the smallest sizes', () => {
    const small = cat(ascii('GIF89a'), le16(1), le16(1), [0, 0, 0], frame([1]), [0x3b])
    expectBytes(strip(small, GIF), small)
  })
})

// ================================================================================================= properties

describe('strip: properties over generated pictures', () => {
  const dataBytes = fc.uint8Array({ maxLength: 40 })
  const fillCount = fc.integer({ min: 0, max: 2 })

  // JPEG: pieces are segments (any marker that has a length) and scans; metadata ones are expected to go.
  const jpegCode = fc.oneof(
    fc.constantFrom(0xe0, 0xe1, 0xe1, 0xed, 0xed, 0xe2, 0xfe, 0xdb, 0xc0, 0xc4, 0xdd),
    fc.integer({ min: 2, max: 0xfe }).filter((c) => c < 0xd0 || c > 0xda),
  )
  const entropy = fc
    .array(
      fc.oneof(
        fc.integer({ min: 0, max: 255 }).map((v) => (v === 0xff ? [0xff, 0x00] : [v])),
        fc.integer({ min: 0xd0, max: 0xd7 }).map((r) => [0xff, r]),
      ),
      { maxLength: 40 },
    )
    .map((parts) => cat(parts))
  const jpegPiece = fc.oneof(
    { weight: 4, arbitrary: fc.record({ code: jpegCode, payload: dataBytes, fill: fillCount }).map((s) => ({ kind: 'seg', ...s })) },
    { weight: 1, arbitrary: entropy.map((data) => ({ kind: 'scan', data })) },
  )
  const jpegCase = fc
    .record({ head: fc.array(jpegPiece, { maxLength: 8 }), scan: entropy, tail: fc.array(jpegPiece, { maxLength: 6 }), junk: dataBytes })
    .map(({ head, scan, tail, junk }) => ({ pieces: [...head, { kind: 'scan', data: scan }, ...tail], junk }))
  const jpegOf = (pieces, keep, junk = []) =>
    cat(
      SOI,
      pieces.map((p) => {
        if (p.kind === 'scan') return [SOS_HEADER, p.data]
        // fill bytes before a segment stay, even when the segment goes
        return [new Array(p.fill).fill(0xff), keep && (p.code === 0xe1 || p.code === 0xed) ? [] : seg(p.code, p.payload)]
      }),
      EOI,
      junk,
    )

  // PNG: IHDR, any chunks, at least one IDAT, IEND.
  const pngType = fc.oneof(
    fc.constantFrom('tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'pHYs', 'IDAT', 'IDAT', 'acTL', 'fdAT', 'iCCP'),
    fc.stringMatching(/^[a-zA-Z]{4}$/).filter((t) => !['IHDR', 'IEND'].includes(t)),
  )
  const pngCase = fc.record({
    mid: fc.array(fc.record({ type: pngType, data: dataBytes }), { maxLength: 10 }),
    junk: dataBytes,
  })
  const pngOf = (mid, keep, junk = []) =>
    cat(PNG_SIG, IHDR, mid.filter((c) => !(keep && ['tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(c.type))).map((c) => chunk(c.type, c.data)), IDAT, IEND, junk)

  // WebP: VP8X, any chunks and a picture.
  const webpType = fc.oneof(
    fc.constantFrom('EXIF', 'EXIF', 'XMP ', 'XMP ', 'ICCP', 'ALPH', 'ANIM', 'ANMF', 'VP8 ', 'VP8L'),
    fc.stringMatching(/^[a-zA-Z ]{4}$/).filter((t) => !['VP8X', 'RIFF'].includes(t)),
  )
  const webpCase = fc.record({
    flags: fc.integer({ min: 0, max: 255 }),
    mid: fc.array(fc.record({ type: webpType, data: dataBytes }), { maxLength: 10 }),
    junk: dataBytes,
  })
  const webpOf = (flags, mid, keep, junk = []) =>
    cat(
      webp(vp8x(keep ? flags & 0xf3 : flags), mid.filter((c) => !(keep && ['EXIF', 'XMP '].includes(c.type))).map((c) => riff(c.type, c.data)), VP8),
      junk,
    )

  // GIF: any extensions and frames, at least one frame.
  const gifItem = fc.oneof(
    fc.record({ kind: fc.constant('comment'), data: fc.array(dataBytes, { maxLength: 3 }) }),
    fc.record({ kind: fc.constant('ext'), label: fc.integer({ min: 0, max: 255 }).filter((l) => l !== 0xfe), data: fc.array(dataBytes, { maxLength: 3 }) }),
    fc.record({ kind: fc.constant('frame'), data: dataBytes, lct: fc.boolean() }),
  )
  const gifCase = fc.record({ items: fc.array(gifItem, { maxLength: 8 }), junk: dataBytes })
  const gifOf = (items, keep, junk = []) =>
    cat(
      GIF_HEAD(),
      items.map((i) => {
        if (i.kind === 'frame') return frame(i.data, { lct: i.lct })
        if (i.kind === 'comment') return keep ? [] : ext(0xfe, ...i.data)
        return ext(i.label, ...i.data)
      }),
      frame([9]),
      [0x3b],
      junk,
    )

  it('JPEG: what comes out is the input minus APP1 and APP13 and what follows the EOI', () => {
    fc.assert(
      fc.property(jpegCase, ({ pieces, junk }) => {
        const input = jpegOf(pieces, false, junk)
        expectBytes(strip(input, JPEG), jpegOf(pieces, true))
      }),
      { numRuns: 300 },
    )
  })

  it('PNG: what comes out is the input minus the four text and EXIF chunks and what follows IEND', () => {
    fc.assert(
      fc.property(pngCase, ({ mid, junk }) => {
        expectBytes(strip(pngOf(mid, false, junk), PNG), pngOf(mid, true))
      }),
      { numRuns: 300 },
    )
  })

  it('WebP: what comes out is the input minus EXIF and XMP, with the size and the flags right', () => {
    fc.assert(
      fc.property(webpCase, ({ flags, mid, junk }) => {
        expectBytes(strip(webpOf(flags, mid, false, junk), WEBP), webpOf(flags, mid, true))
      }),
      { numRuns: 300 },
    )
  })

  it('GIF: what comes out is the input minus comment extensions and what follows the trailer', () => {
    fc.assert(
      fc.property(gifCase, ({ items, junk }) => {
        expectBytes(strip(gifOf(items, false, junk), GIF), gifOf(items, true))
      }),
      { numRuns: 300 },
    )
  })

  it('stripping twice is stripping once, for every generated picture of every type', () => {
    const once = (bytes, type) => {
      const first = strip(bytes, type)
      expect(first).not.toBeNull()
      expectBytes(strip(first, type), first)
    }
    fc.assert(fc.property(jpegCase, ({ pieces, junk }) => once(jpegOf(pieces, false, junk), JPEG)), { numRuns: 200 })
    fc.assert(fc.property(pngCase, ({ mid, junk }) => once(pngOf(mid, false, junk), PNG)), { numRuns: 200 })
    fc.assert(fc.property(webpCase, ({ flags, mid, junk }) => once(webpOf(flags, mid, false, junk), WEBP)), { numRuns: 200 })
    fc.assert(fc.property(gifCase, ({ items, junk }) => once(gifOf(items, false, junk), GIF)), { numRuns: 200 })
  })

  it('stripping twice is stripping once, for whatever survives a hit on a picture, and a result is always a picture', () => {
    const samples = TYPES.flatMap((type) => [SAMPLE[type](), CLEAN[type]()].map((bytes) => ({ type, bytes })))
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: samples.length - 1 }),
        fc.array(fc.record({ at: fc.nat(), value: fc.integer({ min: 0, max: 255 }) }), { minLength: 1, maxLength: 4 }),
        fc.nat(),
        fc.boolean(),
        (which, hits, cutBy, cut) => {
          const { type, bytes } = samples[which]
          let hurt = Uint8Array.from(bytes)
          for (const { at, value } of hits) hurt[at % hurt.length] = value
          if (cut) hurt = hurt.subarray(0, hurt.length - (cutBy % hurt.length))
          const first = strip(hurt, type)
          if (first === null) return
          expect(first.length).toBeLessThanOrEqual(hurt.length)
          expect(sniff(first)).toBe(type)
          expectBytes(strip(first, type), first)
        },
      ),
      { numRuns: 1500 },
    )
  })

  it('whatever follows a signature, a result is null or a picture that survives a second strip, and nothing throws', () => {
    const heads = {
      [JPEG]: [0xff, 0xd8, 0xff],
      [PNG]: PNG_SIG,
      [GIF]: [...ascii('GIF89a')],
    }
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (tail) => {
        for (const type of [JPEG, PNG, GIF]) {
          const input = cat(heads[type], tail)
          const out = strip(input, type)
          if (out !== null) expectBytes(strip(out, type), out)
        }
        const web = cat(ascii('RIFF'), le32(tail.length + 4), ascii('WEBP'), tail)
        const out = strip(web, WEBP)
        if (out !== null) expectBytes(strip(out, WEBP), out)
      }),
      { numRuns: 1500 },
    )
  })

  it('whatever the bytes of a header and its first chunk, a result is null or valid', () => {
    // structured garbage: real headers with generated chunk streams, so the parsers go deep before they fail
    fc.assert(
      fc.property(fc.array(fc.record({ size: fc.integer({ min: 0, max: 40 }), data: dataBytes, type: fc.uint8Array({ minLength: 4, maxLength: 4 }) }), { maxLength: 8 }), (chunks) => {
        const pngStream = cat(PNG_SIG, chunks.map((c) => cat(be32(c.size), c.type, c.data)))
        const webStream = cat(ascii('WEBP'), chunks.map((c) => cat(c.type, le32(c.size), c.data)))
        const gifStream = cat(ascii('GIF89a'), le16(2), le16(2), [0, 0, 0], chunks.map((c) => cat([0x21, c.type[0]], [c.size], c.data, [0])), [0x3b])
        const jpegStream = cat(SOI, chunks.map((c) => cat([0xff, c.type[0]], be16(c.size), c.data)), EOI)
        for (const [bytes, type] of [
          [pngStream, PNG],
          [cat(ascii('RIFF'), le32(webStream.length), webStream), WEBP],
          [gifStream, GIF],
          [jpegStream, JPEG],
        ]) {
          const out = strip(bytes, type)
          if (out !== null) expectBytes(strip(out, type), out)
        }
      }),
      { numRuns: 1000 },
    )
  })
})

// ================================================================================================= work bound

// Under Stryker every statement is instrumented and these 10 MB runs take seconds each, once for every mutant. They guard the
// size of the work, which no mutant of the walks changes without also breaking a small case (a walk that does not advance is
// a hang, which Stryker counts as a kill), so the mutation run leaves them out.
describe.skipIf(process.env.STRYKER_MUTATOR_WORKER)('strip: the work is bounded by the size of the input', () => {
  const TEN_MB = 10 * 1024 * 1024
  const timed = (fn) => {
    const start = performance.now()
    const result = fn()
    return { result, ms: performance.now() - start }
  }
  /** `unit` repeated to fill about `size` bytes. */
  const repeat = (unit, size) => {
    const copies = Math.floor(size / unit.length)
    const out = new Uint8Array(copies * unit.length)
    for (let i = 0; i < copies; i++) out.set(unit, i * unit.length)
    return { bytes: out, copies }
  }
  // The worst of these takes about a third of a second, and a quadratic scan would take minutes.
  const BUDGET_MS = 3000
  const LONG = { timeout: 60_000 }
  it('a 10 MB JPEG whose scan is dense with stuffed bytes', LONG, () => {
    const scan = new Uint8Array(TEN_MB - 400)
    for (let i = 0; i < scan.length; i += 2) scan[i] = 0xff // FF 00 FF 00 ...
    const { result, ms } = timed(() => stripBytes(jpeg([JFIF, APP1_EXIF, DQT], scan), JPEG))
    expect(ms).toBeLessThan(BUDGET_MS)
    expectBytes(result, jpeg([JFIF, DQT], scan))
  })

  it('a 10 MB PNG of tiny metadata chunks side by side with tiny kept ones', LONG, () => {
    const text = chunk('tEXt', [1])
    const { bytes, copies } = repeat(cat(text, chunk('pHYs', [1])), TEN_MB - 200)
    const input = png(IHDR, IDAT, bytes, IEND)
    const { result, ms } = timed(() => stripBytes(input, PNG))
    expect(ms).toBeLessThan(BUDGET_MS)
    expect(result.length).toBe(input.length - copies * text.length)
  })

  it('a 10 MB PNG that is nothing but empty comment chunks', LONG, () => {
    const { bytes } = repeat(chunk('tEXt'), TEN_MB - 200)
    const { result, ms } = timed(() => stripBytes(png(IHDR, IDAT, bytes, IEND), PNG))
    expect(ms).toBeLessThan(BUDGET_MS)
    expectBytes(result, png(IHDR, IDAT, IEND))
  })

  it('a 10 MB WebP of empty EXIF chunks', LONG, () => {
    const { bytes } = repeat(riff('EXIF'), TEN_MB - 200)
    const { result, ms } = timed(() => stripBytes(webp(vp8x(FLAG.exif), VP8, bytes), WEBP))
    expect(ms).toBeLessThan(BUDGET_MS)
    expectBytes(result, webp(vp8x(0), VP8))
  })

  it('a 10 MB GIF of three-byte comment extensions', LONG, () => {
    const { bytes } = repeat(ext(0xfe), TEN_MB - 200)
    const { result, ms } = timed(() => stripBytes(cat(GIF_HEAD(), bytes, frame(), [0x3b]), GIF))
    expect(ms).toBeLessThan(BUDGET_MS)
    expectBytes(result, gif(frame()))
  })

  it('a GIF comment of a hundred thousand one-byte sub-blocks', LONG, () => {
    const { bytes } = repeat(Uint8Array.of(1, 0), 200_000)
    const { result, ms } = timed(() => stripBytes(cat(GIF_HEAD(), [0x21, 0xfe], bytes, [0], frame(), [0x3b]), GIF))
    expect(ms).toBeLessThan(BUDGET_MS)
    expectBytes(result, gif(frame()))
  })
})
