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
const ADOBE = seg(0xee, [ascii('Adobe'), 0, 100, 0, 0, 0, 0, 1])
const APP13 = seg(0xed, [ascii('Photoshop 3.0\0'), ascii('8BIM'), ascii('GPSLatitude caption')])
const SCAN = cat([0x12, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0xff, 0x00, 0xe1, 0x00, 0x08], TRAP, [0xff, 0xd3, 0x11])
const BASE_HEADER = [JFIF, DQT, SOF0, DHT]
/**
 * An APP0 that is a JFXX extension with a thumbnail coded as a JPEG (code 0x10): a whole small picture inside the segment,
 * with an EXIF of its own that holds an invented location.
 */
const jfxxThumbnail = () =>
  seg(0xe0, [ascii('JFXX\0'), 0x10, SOI, seg(0xe1, [ascii('Exif\0\0'), LOCATION]), DQT, SOF0, DHT, SOS_HEADER, [0x12, 0x34], EOI])
/** An APP0 that is a JFIF header with a thumbnail of its own, as RGB pixels: here the pixels spell an invented location. */
const jfifThumbnail = () => {
  const pixels = cat(LOCATION, new Array((3 - (LOCATION.length % 3)) % 3).fill(0))
  return seg(0xe0, [ascii('JFIF\0'), 1, 2, 0, 0, 1, 0, 1, pixels.length / 3, 1, pixels])
}

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
/** The chunks a PNG keeps besides IHDR and IEND, which stand first and last: the picture, its colours, its movement. */
const PNG_KEPT = ['IDAT', 'PLTE', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCv', 'cLLi', 'bKGD', 'pHYs', 'acTL', 'fcTL', 'fdAT', 'tIME']
const PNG_METADATA = [
  chunk('tEXt', ascii('Comment\0GPSLatitude=51.5')),
  chunk('zTXt', [ascii('Raw profile type exif\0\0'), GPS_MARK]),
  chunk('iTXt', [ascii('XML:com.adobe.xmp\0\0\0\0\0'), XMP_GPS]),
  chunk('eXIf', EXIF_GPS),
]

// ---------------------------------------------------------------------------------------------- WebP builders

const riff = (type, data = []) => {
  const d = cat(data)
  return cat(typeof type === 'string' ? ascii(type) : type, le32(d.length), d, d.length & 1 ? [0] : [])
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
/** The 258 bytes that end an XMP packet in a GIF: whichever of its bytes a reader takes for a sub-block size, it ends here. */
const XMP_MAGIC_TRAILER = cat(1, Array.from({ length: 255 }, (_, i) => 255 - i), 0, 0)
const XMP_PACKET = ascii('<x:xmpmeta><exif:GPSLatitude>51,30.4N</exif:GPSLatitude></x:xmpmeta>')
/** The XMP application extension as Photoshop writes it: the 11-byte id, the packet as it is, then the magic trailer. */
/** Any XMP packet: bytes of anything but 0, which a reader that takes them for a sub-block size would take for the end. */
const xmpPacket = (maxLength) => fc.uint8Array({ maxLength }).map((bytes) => bytes.map((x) => x || 1))
const xmpExt = (packet = XMP_PACKET) => cat([0x21, 0xff, 11], ascii('XMP DataXMP'), packet, XMP_MAGIC_TRAILER)

// ---------------------------------------------------------------------------------------------- EXIF builders

const u16 = (little, n) => (little ? [n & 0xff, (n >> 8) & 0xff] : [(n >> 8) & 0xff, n & 0xff])
const u32 = (little, n) => (little ? le32(n) : be32(n))
const ifdEntry = (little, tagId, type, count, value) => cat(u16(little, tagId), u16(little, type), u32(little, count), value)
const shortValue = (little, n) => cat(u16(little, n), [0, 0])
const orient = (little, value) => ifdEntry(little, 0x0112, 3, 1, shortValue(little, value))
/** A TIFF block: the header (with `ifdField` as the offset of IFD0), IFD0 at 8 with `entries`, then `after`. */
const tiff = ({ little = false, entries = [], ifdField = 8, count = entries.length, next = 0, pad = true, after = [], order = null }) =>
  cat(order ?? ascii(little ? 'II' : 'MM'), u16(little, 42), u32(little, ifdField), u16(little, count), entries, pad ? u32(little, next) : [], after)
/** What a phone writes: make, orientation, date, maker note, a GPS IFD, and a thumbnail IFD with an orientation of its own. */
const gpsTiff = (little, value) => {
  const ifd0 = 2 + 5 * 12 + 4
  const make = ascii('Acme Phone\0')
  const date = ascii('2026:11:17 12:00:00\0')
  const note = cat(ascii('GPSLatitude=51.5030N;'), new Array(20).fill(0x7e))
  const makeAt = 8 + ifd0
  const dateAt = makeAt + make.length
  const noteAt = dateAt + date.length
  const gpsAt = noteAt + note.length
  const gps = cat(
    u16(little, 2),
    ifdEntry(little, 1, 2, 2, [0x4e, 0, 0, 0]),
    ifdEntry(little, 2, 5, 3, u32(little, gpsAt + 2 + 24 + 4)),
    u32(little, 0),
    [0, 0, 0, 51, 0, 0, 0, 1, 0, 0, 0, 30, 0, 0, 0, 1, 0, 0, 0, 26, 0, 0, 0, 1],
  )
  const thumbAt = gpsAt + gps.length
  const thumb = cat(u16(little, 1), orient(little, 3), u32(little, 0), [0xff, 0xd8, 0xff, 0xd9])
  return tiff({
    little,
    entries: [
      ifdEntry(little, 0x010f, 2, make.length, u32(little, makeAt)),
      orient(little, value),
      ifdEntry(little, 0x0132, 2, date.length, u32(little, dateAt)),
      ifdEntry(little, 0x8825, 4, 1, u32(little, gpsAt)),
      ifdEntry(little, 0x927c, 7, note.length, u32(little, noteAt)),
    ],
    next: thumbAt,
    after: [make, date, note, gps, thumb],
  })
}
/** The one thing that may stay of an EXIF, written out by hand: IFD0 with the orientation only, in the original's byte order. */
const MIN_TIFF = (little, value) =>
  little
    ? [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, value, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
    : [0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, value, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
const MIN_APP1 = (little, value) => cat([0xff, 0xe1, 0x00, 0x22], ascii('Exif\0\0'), MIN_TIFF(little, value))
const MIN_WEBP_EXIF = (little, value) => cat(ascii('EXIF'), [26, 0, 0, 0], MIN_TIFF(little, value))
const exifApp1 = (t) => seg(0xe1, [ascii('Exif\0\0'), t])
const exifChunk = (t, prefixed = false) => riff('EXIF', prefixed ? [ascii('Exif\0\0'), t] : t)

// ---------------------------------------------------------------------------------------------- fixtures by type

const SAMPLE = {
  [JPEG]: () => jpeg([JFIF, APP1_EXIF, DQT, APP1_XMP, SOF0, APP13, DHT]),
  [PNG]: () => png(IHDR, ...PNG_METADATA, IDAT, IEND),
  [WEBP]: () => webp(vp8x(FLAG.exif | FLAG.xmp), VP8, EXIF_CHUNK, XMP_CHUNK),
  [GIF]: () => gif(GIF_COMMENT, GCE, xmpExt(), FRAME_TRAP, GIF_COMMENT),
}
const CLEAN = {
  [JPEG]: () => jpeg(),
  [PNG]: () => png(IHDR, IDAT, IEND),
  [WEBP]: () => webp(vp8x(0), VP8),
  [GIF]: () => gif(GCE, FRAME_TRAP),
}
const TYPES = [JPEG, PNG, WEBP, GIF]

// ---------------------------------------------------------------------------------------------- containers that must go

/** An invented place and an invented author, the way any metadata container might carry them. */
const LOCATION = ascii('GPSLatitude=0/1,0/1,0/1;GPSLongitude=0/1,0/1,0/1;author=Nobody Invented')
/** A C2PA manifest as its JUMBF box would hold it, with an assertion that names the place and the author. */
const C2PA = cat(ascii('jumb'), ascii('c2pa'), ascii('stds.exif'), LOCATION)

/**
 * Every container of metadata that a picture of each type may carry and that must not reach Discord, named as the format
 * names it. Each is a function: the bytes are built where the test runs.
 */
const CONTAINERS = {
  [PNG]: [
    ['caBX, the C2PA manifest', () => chunk('caBX', C2PA)],
    ['zxIf, the compressed EXIF', () => chunk('zxIf', [be32(LOCATION.length), LOCATION])],
    ['eXIf', () => chunk('eXIf', EXIF_GPS)],
    ['tEXt', () => PNG_METADATA[0]],
    ['zTXt', () => PNG_METADATA[1]],
    ['iTXt', () => PNG_METADATA[2]],
    ['an unknown private chunk', () => chunk('prVt', LOCATION)],
    ['an unknown public chunk', () => chunk('abCd', LOCATION)],
    ['hIST', () => chunk('hIST', LOCATION)],
    ['sPLT', () => chunk('sPLT', [ascii('name\0'), 8, LOCATION])],
    ['oFFs', () => chunk('oFFs', LOCATION)],
    ['iDOT, the chunk of a phone', () => chunk('iDOT', LOCATION)],
    ['dSIG', () => chunk('dSIG', LOCATION)],
    ['an empty unknown chunk with a lowercase name', () => chunk('zzzz')],
    ['a chunk named as a kept one, but in lowercase', () => chunk('time', LOCATION)],
  ],
  [WEBP]: [
    ['C2PA, the manifest', () => riff('C2PA', C2PA)],
    ['XMP', () => XMP_CHUNK],
    ['the EXIF of a picture with no orientation', () => EXIF_CHUNK],
    ['an unknown chunk', () => riff('abcd', LOCATION)],
    ['an unknown chunk of one odd byte', () => riff('abcd', [1])],
    ['a chunk named in bytes that are no letters', () => riff(Uint8Array.of(0, 1, 0xfe, 0xff), LOCATION)],
    ['a chunk named as a kept one, but in lowercase', () => riff('iccp', LOCATION)],
    ['a chunk named as a kept one, but for its last byte', () => riff('VP8\0', LOCATION)],
    ['a chunk named as a kept one, but for its fourth letter', () => riff('ICCQ', LOCATION)],
    ['a second XMP', () => riff('XMP ', XMP_GPS)],
  ],
  [GIF]: [
    ['MGK8BIM0000, the Photoshop resources ImageMagick writes', () => ext(0xff, ascii('MGK8BIM0000'), LOCATION)],
    ['MGKIPTC0000, the IPTC ImageMagick writes', () => ext(0xff, ascii('MGKIPTC0000'), LOCATION)],
    ['XMP', () => xmpExt(LOCATION)],
    ['an unknown application', () => ext(0xff, ascii('INVENTED000'), LOCATION)],
    ['an application that is NETSCAPE2.0 but for its version', () => ext(0xff, ascii('NETSCAPE2.1'), LOCATION)],
    ['a comment', () => ext(0xfe, LOCATION)],
    ['a plain text extension', () => ext(0x01, [12, 0, 0, 0, 0, 2, 0, 2, 0, 1, 1, 0, 0], LOCATION)],
    ['an extension of a label nobody defined', () => ext(0x42, LOCATION)],
    ['an application extension with nothing in it', () => ext(0xff)],
  ],
  [JPEG]: [
    ['APP0 of a JFXX extension, whose thumbnail is a JPEG with an EXIF of its own', jfxxThumbnail],
    ['APP0 of a JFIF that carries a thumbnail', jfifThumbnail],
    ['APP0 of a JFIF with more after its header', () => seg(0xe0, [ascii('JFIF\0'), 1, 2, 0, 0, 1, 0, 1, 0, 0, LOCATION])],
    ['APP0 of an identifier nobody defined', () => seg(0xe0, [ascii('INVT\0'), LOCATION])],
    ['APP2 of FlashPix (FPXR)', () => seg(0xe2, [ascii('FPXR\0'), LOCATION])],
    ['APP2 of the Multi-Picture Format (MPF)', () => seg(0xe2, [ascii('MPF\0'), LOCATION])],
    ['APP2 with an empty payload', () => seg(0xe2)],
    ['APP2 that is ICC_PROFILE but for its terminator', () => seg(0xe2, [ascii('ICC_PROFILE'), 1, 1, LOCATION])],
    ['APP1 of an EXIF with no orientation', () => APP1_EXIF],
    ['APP1 of an XMP', () => APP1_XMP],
    ['APP3 (Meta)', () => seg(0xe3, [ascii('Meta\0'), LOCATION])],
    ['APP11, the JUMBF box of a C2PA manifest', () => seg(0xeb, [ascii('JP\0\0'), C2PA])],
    ['APP12', () => seg(0xec, [ascii('Ducky'), LOCATION])],
    ['APP13 (Photoshop, with the IPTC)', () => APP13],
    ['APP15', () => seg(0xef, LOCATION)],
    ['a comment', () => seg(0xfe, LOCATION)],
  ],
}
/** The picture with `cs` (containers) in it twice: among the header and after the image data, or either side of it. */
const WITH = {
  [JPEG]: (cs) => cat(SOI, JFIF, cs, DQT, SOF0, DHT, SOS_HEADER, SCAN, cs, EOI),
  [PNG]: (cs) => png(IHDR, cs, IDAT, cs, IEND),
  [WEBP]: (cs) => webp(vp8x(0), cs, VP8, cs),
  [GIF]: (cs) => gif(cs, GCE, FRAME_TRAP, cs),
}
/** The bytes of the image itself in each of those pictures: the part that must come out as it went in. */
const IMAGE_DATA = { [JPEG]: () => cat(SOS_HEADER, SCAN), [PNG]: () => IDAT, [WEBP]: () => VP8, [GIF]: () => FRAME_TRAP }

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
  it('drops APP1 (EXIF and XMP), APP13 and comments, and keeps the rest of the file byte for byte', () => {
    const input = jpeg([JFIF, APP1_EXIF, DQT, APP1_XMP, SOF0, APP13, DHT, COMMENT, ICC, ADOBE])
    const out = strip(input, JPEG)
    expectBytes(out, jpeg([JFIF, DQT, SOF0, DHT, ICC, ADOBE]))
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

  it('treats every marker as the table says: APP14 stays, so do a JFIF APP0 and an ICC APP2, every other APPn and COM go', () => {
    const OFF = new Set([0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xff, 0x00, 0x01])
    const GONE = new Set([0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xef, 0xfe])
    for (let code = 0; code < 256; code++) {
      const input = jpeg([JFIF, seg(code, [0xaa, 0xbb, 0xcc]), DQT])
      const out = strip(input, JPEG)
      if (OFF.has(code)) expect(out, `marker ${code.toString(16)}`).toBeNull()
      else if (GONE.has(code)) expectBytes(out, jpeg([JFIF, DQT]))
      else expectBytes(out, input)
    }
  })

  it('keeps the JFIF, ICC profile and Adobe segments, whose bytes the picture is read by', () => {
    const kept = [JFIF, ICC, ADOBE, seg(0xee)]
    for (const segment of kept) expectBytes(strip(jpeg([segment, DQT]), JPEG), jpeg([segment, DQT]))
    expectBytes(strip(jpeg([ADOBE, JFIF, ICC]), JPEG), jpeg([ADOBE, JFIF, ICC]))
  })

  it('keeps an APP0 only when it is a JFIF header with no thumbnail: JFIF and a zero byte, at a length of 16', () => {
    const id = ascii('JFIF\0')
    // whatever its version, units, densities and thumbnail size say: at this length there is no room for a thumbnail
    const rests = [[1, 1, 0, 0, 1, 0, 1, 0, 0], [1, 2, 1, 0, 72, 0, 72, 0, 0], [0xff, 0xd9, 0xff, 0xd9, 0xff, 0xd9, 0xff, 0, 0], new Array(9).fill(0), [1, 2, 0, 0, 1, 0, 1, 4, 4]]
    for (const rest of rests) {
      const header = seg(0xe0, [id, rest])
      expect(header.length).toBe(18) // the marker and a length of 16
      expectBytes(strip(jpeg([header, DQT]), JPEG), jpeg([header, DQT]))
      expectBytes(strip(jpeg([DQT, header, SOF0]), JPEG), jpeg([DQT, header, SOF0]))
    }
    // every way to be one byte off in the identifier
    for (let at = 0; at < id.length; at++) {
      for (const change of [(x) => x ^ 0x20, (x) => x ^ 0x01, (x) => (x === 0 ? 0xff : 0)]) {
        const bent = Uint8Array.from(id)
        bent[at] = change(bent[at])
        expectBytes(strip(jpeg([JFIF, seg(0xe0, [bent, 1, 1, 0, 0, 1, 0, 1, 0, 0]), DQT]), JPEG), jpeg([JFIF, DQT]))
      }
    }
    // the identifier a byte further in, or a JFXX, at the length of a JFIF with no thumbnail
    expectBytes(strip(jpeg([JFIF, seg(0xe0, [0, id, 1, 0, 0, 1, 0, 1, 0, 0]), DQT]), JPEG), jpeg([JFIF, DQT]))
    expectBytes(strip(jpeg([JFIF, seg(0xe0, [ascii('JFXX\0'), 0x10, 1, 1, 0, 0, 1, 0, 1]), DQT]), JPEG), jpeg([JFIF, DQT]))
    // the identifier at any other length: cut short, or with more behind it (a thumbnail, a padding byte, anything)
    for (let size = 0; size <= 40; size++) {
      if (size === 9) continue
      const other = seg(0xe0, [id, new Array(size).fill(0)])
      expectBytes(strip(jpeg([JFIF, other, DQT]), JPEG), jpeg([JFIF, DQT]))
    }
    for (let keep = 0; keep < id.length; keep++) expectBytes(strip(jpeg([JFIF, seg(0xe0, id.subarray(0, keep)), DQT]), JPEG), jpeg([JFIF, DQT]))
  })

  it('drops an APP0 that is a JFXX extension, and the thumbnail inside it with its EXIF and its location', () => {
    for (const header of [[JFIF, jfxxThumbnail(), DQT, SOF0, DHT], [jfxxThumbnail(), JFIF, DQT, SOF0, DHT]]) {
      const input = jpeg(header)
      expect(has(input, GPS_MARK)).toBe(true)
      const out = strip(input, JPEG)
      expectBytes(out, jpeg())
      expect(has(out, GPS_MARK)).toBe(false)
      expect(has(out, ascii('JFXX'))).toBe(false)
      expect(has(out, ascii('Exif\0\0GPS'))).toBe(false)
      expectBytes(strip(out, JPEG), out)
    }
  })

  it('drops an APP0 that is a JFIF with a thumbnail, and keeps the JFIF with none beside it', () => {
    const input = jpeg([JFIF, jfifThumbnail(), DQT, SOF0, DHT])
    expect(has(input, GPS_MARK)).toBe(true)
    const out = strip(input, JPEG)
    expectBytes(out, jpeg())
    expect(has(out, GPS_MARK)).toBe(false)
    // a picture whose only APP0 has a thumbnail has no APP0 left, and decoders need none
    expectBytes(strip(jpeg([jfifThumbnail(), DQT, SOF0, DHT]), JPEG), jpeg([DQT, SOF0, DHT]))
  })

  it('keeps an APP2 only when its payload starts with ICC_PROFILE and a zero byte, and whatever follows them', () => {
    const id = ascii('ICC_PROFILE\0')
    for (const rest of [[], [1], [1, 1], new Array(300).fill(0x33), LOCATION]) {
      const profile = seg(0xe2, [id, rest])
      expectBytes(strip(jpeg([JFIF, profile, DQT]), JPEG), jpeg([JFIF, profile, DQT]))
    }
    // every way to be one byte off: a byte changed, a byte missing, a byte first, the id further in, a shorter payload
    for (let at = 0; at < id.length; at++) {
      for (const change of [(x) => x ^ 0x20, (x) => x ^ 0x01, (x) => (x === 0 ? 0xff : 0)]) {
        const bent = Uint8Array.from(id)
        bent[at] = change(bent[at])
        expectBytes(strip(jpeg([JFIF, seg(0xe2, [bent, LOCATION]), DQT]), JPEG), jpeg([JFIF, DQT]))
      }
      expectBytes(strip(jpeg([JFIF, seg(0xe2, [id.subarray(0, at), LOCATION]), DQT]), JPEG), jpeg([JFIF, DQT]))
    }
    for (const lead of [[0], [0x20], [0xff], [0xe2]]) expectBytes(strip(jpeg([JFIF, seg(0xe2, [lead, id, 1, 1]), DQT]), JPEG), jpeg([JFIF, DQT]))
    expectBytes(strip(jpeg([JFIF, seg(0xe2, [id.subarray(1), 1]), DQT]), JPEG), jpeg([JFIF, DQT]))
  })

  it('does not take the identifier from a segment that is too short to hold it, whatever follows', () => {
    // the first bytes of an ICC_PROFILE\0 payload, then the next segment: its marker is 0xFF, which no identifier holds
    const id = ascii('ICC_PROFILE\0')
    for (let keep = 0; keep < id.length; keep++) {
      const cut = cat([0xff, 0xe2], be16(2 + keep), id.subarray(0, keep))
      expectBytes(strip(cat(SOI, JFIF, cut, DQT, SOS_HEADER, SCAN, EOI), JPEG), jpeg([JFIF, DQT]))
    }
    // an APP2 that ends the file's segments just before the scan
    expectBytes(strip(cat(SOI, JFIF, [0xff, 0xe2], be16(2 + 11), id.subarray(0, 11), SOS_HEADER, SCAN, EOI), JPEG), jpeg([JFIF], SCAN))
  })

  it('drops the FlashPix and Multi-Picture APP2 and the others like them, with every location they carry', () => {
    for (const name of ['FPXR\0', 'MPF\0', 'ICC_PROFIL\0', 'ICC-PROFILE\0', 'XMP\0', 'Exif\0\0', 'JFIF\0', 'Adobe']) {
      const out = strip(jpeg([JFIF, seg(0xe2, [ascii(name), LOCATION]), DQT]), JPEG)
      expectBytes(out, jpeg([JFIF, DQT]))
      expect(has(out, GPS_MARK)).toBe(false)
    }
  })

  it('does not keep an ICC profile that sits in any other APPn', () => {
    const profile = [ascii('ICC_PROFILE\0'), 1, 1, LOCATION]
    for (const code of [0xe1, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xef, 0xfe]) {
      expectBytes(strip(jpeg([JFIF, seg(code, profile), DQT]), JPEG), jpeg([JFIF, DQT]))
    }
  })

  it('drops every APPn but a JFIF APP0, APP14 and an ICC APP2, and the comment, wherever they stand', () => {
    for (const code of [0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xef, 0xfe]) {
      const gone = seg(code, ascii('GPSLatitude=51.5'))
      const out = strip(cat(SOI, gone, JFIF, SOS_HEADER, SCAN, gone, EOI), JPEG)
      expectBytes(out, jpeg([JFIF]))
      expect(has(out, GPS_MARK)).toBe(false)
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
    const inside = seg(0xe0, [ascii('JFIF\0'), 1, 2, 0, 0xff, 0xd9, 0xff, 0xd9, 0, 0])
    const insideIcc = seg(0xe2, [ascii('ICC_PROFILE\0'), 0xff, 0xd9, 3, 4])
    const input = jpeg([inside, seg(0xe0, [1, 0xff, 0xd9, 2]), APP1_EXIF, insideIcc, DQT, seg(0xe2, [1, 0xff, 0xd9, 2]), seg(0xfe, [1, 0xff, 0xd9, 2])])
    expectBytes(strip(input, JPEG), jpeg([inside, insideIcc, DQT]))
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
    const kept = jpeg([JFIF, seg(0xee, [1, 2, 3])])
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

  it('takes a segment of length 2, which holds nothing, and drops it when it is APP1 or APP0', () => {
    expectBytes(strip(jpeg([JFIF, seg(0xe1), DQT]), JPEG), jpeg([JFIF, DQT]))
    expectBytes(strip(jpeg([JFIF, seg(0xe0), DQT]), JPEG), jpeg([JFIF, DQT])) // an APP0 with nothing in it is no JFIF
    expectBytes(strip(jpeg([JFIF, seg(0xee), DQT]), JPEG), jpeg([JFIF, seg(0xee), DQT]))
    expectBytes(strip(jpeg([JFIF, seg(0xe2), DQT]), JPEG), jpeg([JFIF, DQT])) // an APP2 with no profile is no ICC
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

// ================================================================================================= EXIF: which way up

/** Every way an EXIF can fail to yield an orientation of 2 to 8, as TIFF blocks. Each must come out as no EXIF at all. */
const hostileTiffs = () => {
  const out = []
  for (const little of [false, true]) {
    const order = little ? 'II' : 'MM'
    const add = (label, bytes) => out.push([`${order} ${label}`, cat(bytes)])
    const good = tiff({ little, entries: [orient(little, 6)] })
    const exactFit = 8 + 2 + 12
    expect(good.length).toBe(exactFit + 4)
    // cut anywhere in the header, the count or the entry
    for (let cut = 0; cut < exactFit; cut++) add(`cut at ${cut}`, good.subarray(0, cut))
    // the header lies about where IFD0 is
    for (const at of [0, 1, 2, 4, 7, 9, 10, 11, 12, 13, good.length - 2, good.length - 1, good.length, good.length + 1, 4096, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff]) {
      add(`IFD0 at ${at}`, tiff({ little, entries: [orient(little, 6)], ifdField: at }))
    }
    // the count lies
    for (const count of [0, 2, 3, 0x100, 0x7fff, 0x8000, 0xffff]) add(`count ${count}`, tiff({ little, entries: [orient(little, 6)], count }))
    // the entry is not an orientation: a wrong type, a wrong count, a value out of range
    for (const type of [0, 1, 2, 4, 5, 6, 7, 8, 9, 12, 0xffff]) add(`type ${type}`, tiff({ little, entries: [ifdEntry(little, 0x0112, type, 1, shortValue(little, 6))] }))
    for (const count of [0, 2, 3, 0xffff, 0x10000, 0x7fffffff, 0xffffffff]) add(`orientation count ${count}`, tiff({ little, entries: [ifdEntry(little, 0x0112, 3, count, shortValue(little, 6))] }))
    for (const value of [0, 1, 9, 10, 255, 256, 0x0600, 0x0100, 0x8000, 0xffff]) add(`value ${value}`, tiff({ little, entries: [orient(little, value)] }))
    for (const tagId of [0, 0x0111, 0x0113, 0x1201, 0x0012, 0x8112, 0xffff]) add(`tag ${tagId}`, tiff({ little, entries: [ifdEntry(little, tagId, 3, 1, shortValue(little, 6))] }))
    // the count claims entries the block is too short to hold, though it holds the orientation's
    const filler = ifdEntry(little, 0x010f, 3, 1, shortValue(little, 1))
    const claimed = tiff({ little, entries: [orient(little, 6), filler, filler], pad: false })
    for (let cut = exactFit; cut < claimed.length; cut++) add(`three entries cut at ${cut}`, claimed.subarray(0, cut))
    add('no entries', tiff({ little }))
    add('exact fit, but not an orientation', tiff({ little, entries: [ifdEntry(little, 0x010f, 3, 1, shortValue(little, 6))], pad: false }))
    // the first entry with the tag decides, and a bad one is bad even if a good one follows
    add('a bad orientation first', tiff({ little, entries: [ifdEntry(little, 0x0112, 4, 1, shortValue(little, 6)), orient(little, 6)] }))
    add('a one first', tiff({ little, entries: [orient(little, 1), orient(little, 6)] }))
    // the orientation of the thumbnail's IFD is not the picture's
    const ifd1At = 8 + 2 + 12 + 4
    add('only in IFD1', tiff({ little, entries: [ifdEntry(little, 0x010f, 3, 1, shortValue(little, 1))], next: ifd1At, after: [u16(little, 1), orient(little, 6), u32(little, 0)] }))
    // IFD0 that points to itself as the next IFD, and with a one
    add('a loop, orientation 1', tiff({ little, entries: [orient(little, 1)], next: 8 }))
    // a TIFF whose byte order or magic is wrong
    add('order IM', tiff({ little, entries: [orient(little, 6)], order: ascii('IM') }))
    add('order XX', tiff({ little, entries: [orient(little, 6)], order: ascii('XX') }))
    add('order ii', tiff({ little, entries: [orient(little, 6)], order: ascii(little ? 'ii' : 'mm') }))
    add('order swapped', tiff({ little, entries: [orient(little, 6)], order: ascii(little ? 'MM' : 'II') }))
  }
  for (const magic of [0, 41, 43, 0x2a00]) {
    for (const little of [false, true]) {
      const t = Uint8Array.from(tiff({ little, entries: [orient(little, 6)] }))
      t.set(u16(little, magic), 2)
      out.push([`magic ${magic}`, t])
    }
  }
  return out
}

describe('strip: a photo keeps which way up it goes (JPEG)', () => {
  it('writes back an APP1 of the orientation alone, for each of 2 to 8 and both byte orders, in the place of the original', () => {
    for (const little of [false, true]) {
      for (let value = 2; value <= 8; value++) {
        const input = jpeg([JFIF, exifApp1(gpsTiff(little, value)), DQT, APP1_XMP, SOF0])
        const out = strip(input, JPEG)
        expectBytes(out, jpeg([JFIF, MIN_APP1(little, value), DQT, SOF0]))
        expectBytes(strip(out, JPEG), out) // and the next strip leaves it as it is
      }
    }
  })

  it('writes exactly these bytes for an orientation of 6, in either byte order', () => {
    expect(hex(MIN_APP1(false, 6))).toBe('ffe10022457869660000' + '4d4d002a00000008' + '0001' + '0112' + '0003' + '00000001' + '0006' + '0000' + '00000000')
    expect(hex(MIN_APP1(true, 6))).toBe('ffe10022457869660000' + '49492a0008000000' + '0100' + '1201' + '0300' + '01000000' + '0600' + '0000' + '00000000')
    expectBytes(strip(jpeg([exifApp1(gpsTiff(false, 6))]), JPEG), jpeg([MIN_APP1(false, 6)]))
    expectBytes(strip(jpeg([exifApp1(gpsTiff(true, 6))]), JPEG), jpeg([MIN_APP1(true, 6)]))
  })

  it('leaves nothing of a GPS-laden EXIF but the orientation: no GPS, no maker note, no date, no thumbnail', () => {
    for (const little of [false, true]) {
      const input = jpeg([JFIF, exifApp1(gpsTiff(little, 6)), DQT])
      expect(has(input, GPS_MARK)).toBe(true)
      const out = strip(input, JPEG)
      expectBytes(out, jpeg([JFIF, MIN_APP1(little, 6), DQT]))
      for (const gone of [GPS_MARK, ascii('Acme'), ascii('2026:'), Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)]) {
        expect(has(out, gone)).toBe(false)
      }
    }
  })

  it('writes the same bytes whatever else the original EXIF held, and whatever the pad bytes of the value were', () => {
    const wanted = jpeg([MIN_APP1(false, 3)])
    const variants = [
      tiff({ entries: [orient(false, 3)] }),
      tiff({ entries: [ifdEntry(false, 0x010f, 3, 1, shortValue(false, 9)), orient(false, 3), ifdEntry(false, 0x0131, 3, 1, shortValue(false, 9))] }),
      tiff({ entries: [ifdEntry(false, 0x0112, 3, 1, [0, 3, 0xff, 0xff])] }),
      tiff({ entries: [orient(false, 3)], pad: false }),
      tiff({ entries: [orient(false, 3)], after: new Uint8Array(500).fill(0x41) }),
      tiff({ entries: [orient(false, 3)], next: 0xffffff }),
      tiff({ entries: [orient(false, 3)], next: 8 }),
    ]
    for (const variant of variants) expectBytes(strip(jpeg([exifApp1(variant)]), JPEG), wanted)
  })

  it('takes the first entry of IFD0 with the tag, wherever it stands among many', () => {
    const many = Array.from({ length: 3000 }, (_, i) => ifdEntry(false, 0x0200 + (i % 100), 3, 1, shortValue(false, 1)))
    expectBytes(strip(jpeg([exifApp1(tiff({ entries: [...many, orient(false, 8)] }))]), JPEG), jpeg([MIN_APP1(false, 8)]))
    expectBytes(strip(jpeg([exifApp1(tiff({ entries: [orient(false, 2), ...many] }))]), JPEG), jpeg([MIN_APP1(false, 2)]))
    expectBytes(strip(jpeg([exifApp1(tiff({ entries: [orient(false, 2), orient(false, 7)] }))]), JPEG), jpeg([MIN_APP1(false, 2)]))
  })

  it('writes nothing for an orientation of 1, for none, and for a value outside 2 to 8', () => {
    for (const little of [false, true]) {
      for (const value of [1, 0, 9, 0xffff]) expectBytes(strip(jpeg([JFIF, exifApp1(gpsTiff(little, value)), DQT]), JPEG), jpeg([JFIF, DQT]))
    }
    expectBytes(strip(jpeg([JFIF, APP1_EXIF, DQT]), JPEG), jpeg([JFIF, DQT])) // GPS and nothing else
  })

  it('writes nothing for an EXIF that is malformed in any way, and never throws', () => {
    for (const [label, bytes] of hostileTiffs()) {
      const out = strip(jpeg([JFIF, exifApp1(bytes), DQT]), JPEG)
      expect(out, label).not.toBeNull()
      expect(hex(out), label).toBe(hex(jpeg([JFIF, DQT])))
    }
  })

  it('is not taken in by an IFD0 that lies over the header and whose entries read as an orientation', () => {
    // IFD0 "at 4": its count is the first half of its own offset, and its second entry is the orientation
    const crafted = cat(ascii('II'), [42, 0], [4, 0, 0, 0], new Array(10).fill(0), orient(true, 6), new Array(54 - 30).fill(0))
    expect(crafted.length).toBe(54)
    expectBytes(strip(jpeg([JFIF, exifApp1(crafted), DQT]), JPEG), jpeg([JFIF, DQT]))
    expectBytes(strip(webp(vp8x(FLAG.exif), VP8, exifChunk(crafted)), WEBP), webp(vp8x(0), VP8))
  })

  it('takes the shortest EXIF there is: IFD0 whose entries end the file with no next-IFD pointer', () => {
    for (const little of [false, true]) {
      const exact = tiff({ little, entries: [orient(little, 6)], pad: false })
      expect(exact.length).toBe(22)
      expectBytes(strip(jpeg([exifApp1(exact)]), JPEG), jpeg([MIN_APP1(little, 6)]))
      expectBytes(strip(jpeg([exifApp1(exact.subarray(0, 21))]), JPEG), jpeg([]))
    }
  })

  it('needs the Exif identifier with its two zeros, and the TIFF right behind it', () => {
    const t = tiff({ entries: [orient(false, 6)] })
    for (const id of ['Exif\0\xff', 'Exif\0', 'Exif', 'EXIF\0\0', 'exif\0\0', 'xif\0\0\0', 'Exif\0 ', ' Exif\0\0', '']) {
      expectBytes(strip(jpeg([JFIF, seg(0xe1, [ascii(id), t]), DQT]), JPEG), jpeg([JFIF, DQT]))
    }
    expectBytes(strip(jpeg([JFIF, seg(0xe1, t), DQT]), JPEG), jpeg([JFIF, DQT])) // no identifier at all
    expectBytes(strip(jpeg([JFIF, seg(0xe1, [ascii('Exif\0\0'), [0], t]), DQT]), JPEG), jpeg([JFIF, DQT])) // a byte between
    expectBytes(strip(jpeg([JFIF, seg(0xe1, ascii('Exif\0\0')), DQT]), JPEG), jpeg([JFIF, DQT])) // nothing behind it
    // the XMP and every other APP1 can carry a TIFF-looking block, and are dropped
    expectBytes(strip(jpeg([JFIF, seg(0xe1, [ascii('http://ns.adobe.com/xap/1.0/\0'), t]), DQT]), JPEG), jpeg([JFIF, DQT]))
  })

  it('does not read an Exif identifier that lies in the next segment, nor past its own end', () => {
    // an APP1 of length 2 followed by a segment that spells the identifier and holds an orientation is not an EXIF
    const next = seg(0xee, [ascii('Exif\0\0'), tiff({ entries: [orient(false, 6)] })])
    expectBytes(strip(cat(SOI, JFIF, [0xff, 0xe1, 0x00, 0x02], next, SOS_HEADER, SCAN, EOI), JPEG), cat(SOI, JFIF, next, SOS_HEADER, SCAN, EOI))
    // a segment whose length ends in the middle of the identifier, and in the middle of the TIFF header
    for (const keep of [0, 3, 5, 6, 7, 10, 13]) {
      const payload = cat(ascii('Exif\0\0'), tiff({ entries: [orient(false, 6)] })).subarray(0, keep)
      expectBytes(strip(jpeg([JFIF, seg(0xe1, payload), DQT]), JPEG), jpeg([JFIF, DQT]))
    }
  })

  it('is null, not a throw, for an EXIF segment that claims more than the file holds', () => {
    const exif = exifApp1(gpsTiff(false, 6))
    const input = cat(SOI, JFIF, exif)
    const bad = Uint8Array.from(input)
    bad.set(be16(0xffff), SOI.length + JFIF.length + 2)
    expect(strip(bad, JPEG)).toBeNull()
    for (const cutAt of [4, 12, 20, 40, exif.length - 1]) {
      expect(strip(cat(SOI, JFIF, exif.subarray(0, cutAt)), JPEG), `cut ${cutAt}`).toBeNull()
    }
  })

  it('writes nothing for an EXIF that sits in any other segment: only APP1 is an EXIF', () => {
    const t = tiff({ entries: [orient(false, 6)] })
    for (const code of [0xe0, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xef, 0xfe]) {
      expectBytes(strip(jpeg([JFIF, seg(code, [ascii('Exif\0\0'), t]), DQT]), JPEG), jpeg([JFIF, DQT]))
    }
    const kept = seg(0xee, [ascii('Exif\0\0'), t])
    expectBytes(strip(jpeg([kept, DQT]), JPEG), jpeg([kept, DQT])) // kept as it is, whatever it holds
    expectBytes(strip(jpeg([seg(0xe2, [ascii('Exif\0\0'), t]), DQT]), JPEG), jpeg([DQT])) // an APP2 that is no ICC profile is dropped
  })

  it('writes one APP1 at most: the first EXIF with a usable orientation, the rest are dropped', () => {
    const a = exifApp1(gpsTiff(false, 6))
    const b = exifApp1(gpsTiff(true, 3))
    const none = exifApp1(gpsTiff(false, 1))
    expectBytes(strip(jpeg([JFIF, a, b, DQT]), JPEG), jpeg([JFIF, MIN_APP1(false, 6), DQT]))
    expectBytes(strip(jpeg([JFIF, b, DQT, a]), JPEG), jpeg([JFIF, MIN_APP1(true, 3), DQT]))
    expectBytes(strip(jpeg([JFIF, none, DQT, b, a]), JPEG), jpeg([JFIF, DQT, MIN_APP1(true, 3)]))
    expectBytes(strip(jpeg([JFIF, APP1_XMP, a, APP13, b]), JPEG), jpeg([JFIF, MIN_APP1(false, 6)]))
    expectBytes(strip(jpeg([JFIF, none, none, DQT]), JPEG), jpeg([JFIF, DQT]))
  })

  it('writes the APP1 where the EXIF stood: first in the file, after a scan, between fill bytes', () => {
    const e = exifApp1(gpsTiff(false, 8))
    expectBytes(strip(jpeg([e, JFIF, DQT]), JPEG), jpeg([MIN_APP1(false, 8), JFIF, DQT]))
    expectBytes(strip(cat(SOI, JFIF, SOS_HEADER, SCAN, e, DQT, EOI), JPEG), cat(SOI, JFIF, SOS_HEADER, SCAN, MIN_APP1(false, 8), DQT, EOI))
    expectBytes(strip(cat(SOI, JFIF, [0xff, 0xff], e, [0xff], DQT, SOS_HEADER, SCAN, EOI), JPEG), cat(SOI, JFIF, [0xff, 0xff], MIN_APP1(false, 8), [0xff], DQT, SOS_HEADER, SCAN, EOI))
    expectBytes(strip(cat(SOI, JFIF, e, SOS_HEADER, SCAN, EOI), JPEG), cat(SOI, JFIF, MIN_APP1(false, 8), SOS_HEADER, SCAN, EOI))
    // the last thing before the EOI at the very end
    expectBytes(strip(cat(SOI, JFIF, SOS_HEADER, SCAN, e, EOI), JPEG), cat(SOI, JFIF, SOS_HEADER, SCAN, MIN_APP1(false, 8), EOI))
  })

  it('leaves the scan, and every kept segment, byte for byte while it rewrites the EXIF', () => {
    const input = jpeg([JFIF, exifApp1(gpsTiff(true, 5)), ICC, ADOBE, DQT, SOF0, APP13, DHT])
    expectBytes(strip(input, JPEG), jpeg([JFIF, MIN_APP1(true, 5), ICC, ADOBE, DQT, SOF0, DHT]))
  })

  it('rewrites an EXIF that is itself the output of a strip to the same bytes', () => {
    for (const little of [false, true]) {
      for (let value = 2; value <= 8; value++) {
        const once = jpeg([MIN_APP1(little, value)])
        expectBytes(strip(once, JPEG), once)
      }
    }
  })
})

describe('strip: a photo keeps which way up it goes (WebP)', () => {
  const FLAGS = FLAG.icc | FLAG.alpha | FLAG.anim

  it('writes back an EXIF chunk of the orientation alone, for each of 2 to 8 and both byte orders, with the flag set', () => {
    for (const little of [false, true]) {
      for (let value = 2; value <= 8; value++) {
        const input = webp(vp8x(FLAG.icc), VP8, exifChunk(gpsTiff(little, value)), XMP_CHUNK)
        const out = strip(input, WEBP)
        expectBytes(out, webp(vp8x(FLAG.icc | FLAG.exif), VP8, MIN_WEBP_EXIF(little, value)))
        expectBytes(strip(out, WEBP), out)
      }
    }
  })

  it('writes exactly these bytes for an orientation of 6, in either byte order, and no padding byte', () => {
    expect(hex(MIN_WEBP_EXIF(false, 6))).toBe('45584946' + '1a000000' + '4d4d002a00000008' + '0001' + '0112' + '0003' + '00000001' + '0006' + '0000' + '00000000')
    expect(hex(MIN_WEBP_EXIF(true, 6))).toBe('45584946' + '1a000000' + '49492a0008000000' + '0100' + '1201' + '0300' + '01000000' + '0600' + '0000' + '00000000')
    expectBytes(strip(webp(vp8x(0), VP8, exifChunk(gpsTiff(false, 6))), WEBP), webp(vp8x(FLAG.exif), VP8, MIN_WEBP_EXIF(false, 6)))
    expectBytes(strip(webp(vp8x(0), VP8, exifChunk(gpsTiff(true, 6))), WEBP), webp(vp8x(FLAG.exif), VP8, MIN_WEBP_EXIF(true, 6)))
  })

  it('leaves nothing of a GPS-laden EXIF but the orientation', () => {
    for (const little of [false, true]) {
      const input = webp(vp8x(FLAG.exif | FLAG.xmp), VP8, exifChunk(gpsTiff(little, 6)), XMP_CHUNK)
      const out = strip(input, WEBP)
      expectBytes(out, webp(vp8x(FLAG.exif), VP8, MIN_WEBP_EXIF(little, 6)))
      for (const gone of [GPS_MARK, ascii('Acme'), ascii('2026:')]) expect(has(out, gone)).toBe(false)
      expect(Buffer.from(out).readUInt32LE(4)).toBe(out.length - 8)
    }
  })

  it('takes an EXIF chunk that carries the Exif identifier too, and writes it back without', () => {
    for (const little of [false, true]) {
      expectBytes(strip(webp(vp8x(FLAG.exif), VP8, exifChunk(gpsTiff(little, 3), true)), WEBP), webp(vp8x(FLAG.exif), VP8, MIN_WEBP_EXIF(little, 3)))
    }
    // the identifier is optional, but a wrong one is a wrong TIFF
    expectBytes(strip(webp(vp8x(FLAG.exif), VP8, riff('EXIF', [ascii('Exif\0\xff'), gpsTiff(false, 3)])), WEBP), webp(vp8x(0), VP8))
    expectBytes(strip(webp(vp8x(FLAG.exif), VP8, riff('EXIF', [ascii('Exif\0\0'), ascii('Exif\0\0'), gpsTiff(false, 3)])), WEBP), webp(vp8x(0), VP8))
  })

  it('sets the EXIF flag only when it writes a chunk, and always clears the XMP flag, for every flag byte', () => {
    for (let flags = 0; flags < 256; flags++) {
      const wrote = strip(webp(vp8x(flags), VP8, exifChunk(gpsTiff(false, 6)), XMP_CHUNK), WEBP)
      expect(wrote[20], `flags ${flags} with an orientation`).toBe((flags & 0xf3) | FLAG.exif)
      expectBytes(wrote, webp(vp8x((flags & 0xf3) | FLAG.exif), VP8, MIN_WEBP_EXIF(false, 6)))
      for (const value of [1, 9]) {
        const none = strip(webp(vp8x(flags), VP8, exifChunk(gpsTiff(true, value)), XMP_CHUNK), WEBP)
        expect(none[20], `flags ${flags} with ${value}`).toBe(flags & 0xf3)
        expectBytes(none, webp(vp8x(flags & 0xf3), VP8))
      }
    }
  })

  it('keeps every other flag and chunk, an animation included', () => {
    const kept = [riff('ICCP', [1, 2]), riff('ANIM', [0, 0, 0, 0, 0, 0]), riff('ALPH', [1, 2, 3, 4]), riff('ANMF', cat(new Array(16).fill(1), VP8))]
    const input = webp(vp8x(FLAGS | FLAG.xmp), ...kept, riff('abcd', [1]), exifChunk(gpsTiff(false, 6)), XMP_CHUNK)
    expectBytes(strip(input, WEBP), webp(vp8x(FLAGS | FLAG.exif), ...kept, MIN_WEBP_EXIF(false, 6)))
  })

  it('writes nothing for an orientation of 1, for none, and for a value outside 2 to 8', () => {
    for (const little of [false, true]) {
      for (const value of [1, 0, 9, 0xffff]) expectBytes(strip(webp(vp8x(FLAG.exif), VP8, exifChunk(gpsTiff(little, value))), WEBP), webp(vp8x(0), VP8))
    }
    expectBytes(strip(webp(vp8x(FLAG.exif), VP8, EXIF_CHUNK), WEBP), webp(vp8x(0), VP8))
  })

  it('writes nothing for an EXIF that is malformed in any way, and never throws', () => {
    for (const [label, bytes] of hostileTiffs()) {
      for (const prefixed of [false, true]) {
        const out = strip(webp(vp8x(FLAG.exif), VP8, exifChunk(bytes, prefixed)), WEBP)
        expect(out, label).not.toBeNull()
        expect(hex(out), label).toBe(hex(webp(vp8x(0), VP8)))
      }
    }
  })

  it('writes nothing when there is no VP8X chunk to carry the flag: a bare picture has no EXIF', () => {
    expectBytes(strip(webp(VP8, exifChunk(gpsTiff(false, 6))), WEBP), webp(VP8))
    expectBytes(strip(webp(VP8L, exifChunk(gpsTiff(true, 6)), XMP_CHUNK), WEBP), webp(VP8L))
  })

  it('writes nothing for an XMP chunk that holds a TIFF block with an orientation, and keeps only the ICC chunk of those that do', () => {
    const t = gpsTiff(false, 6)
    for (const body of [t, cat(ascii('Exif\0\0'), t)]) {
      expectBytes(strip(webp(vp8x(FLAG.exif), VP8, riff('XMP ', body)), WEBP), webp(vp8x(0), VP8))
      expectBytes(strip(webp(vp8x(FLAG.exif), VP8, riff('ICCP', body)), WEBP), webp(vp8x(0), VP8, riff('ICCP', body)))
      for (const name of ['abcd', 'EXIf', 'exif']) expectBytes(strip(webp(vp8x(FLAG.exif), VP8, riff(name, body)), WEBP), webp(vp8x(0), VP8))
    }
  })

  it('takes an EXIF chunk of odd size, with its padding byte, and one of the shortest size', () => {
    const odd = riff('EXIF', cat(gpsTiff(false, 6), [0x41]))
    expect(odd.length % 2).toBe(0)
    expectBytes(strip(webp(vp8x(0), VP8, odd), WEBP), webp(vp8x(FLAG.exif), VP8, MIN_WEBP_EXIF(false, 6)))
    expectBytes(strip(webp(vp8x(0), VP8, exifChunk(tiff({ little: true, entries: [orient(true, 4)], pad: false }))), WEBP), webp(vp8x(FLAG.exif), VP8, MIN_WEBP_EXIF(true, 4)))
  })

  it('writes one chunk at most, in the place of the first usable EXIF, and drops the rest', () => {
    const a = exifChunk(gpsTiff(false, 6))
    const b = exifChunk(gpsTiff(true, 3))
    const none = exifChunk(gpsTiff(false, 1))
    expectBytes(strip(webp(vp8x(FLAG.exif), a, VP8, b), WEBP), webp(vp8x(FLAG.exif), MIN_WEBP_EXIF(false, 6), VP8))
    expectBytes(strip(webp(vp8x(FLAG.exif), none, VP8, XMP_CHUNK, b, a), WEBP), webp(vp8x(FLAG.exif), VP8, MIN_WEBP_EXIF(true, 3)))
    expectBytes(strip(webp(vp8x(FLAG.exif), none, VP8, none), WEBP), webp(vp8x(0), VP8))
  })

  it('is null, not a throw, for an EXIF chunk that claims more than the RIFF holds', () => {
    const base = webp(vp8x(FLAG.exif), VP8, exifChunk(gpsTiff(false, 6)))
    const at = 12 + vp8x(0).length + VP8.length
    for (const claim of [base.length, 0x7fffffff, 0xffffffff]) {
      const bad = Uint8Array.from(base)
      bad.set(le32(claim), at + 4)
      expect(strip(bad, WEBP), `claim ${claim}`).toBeNull()
    }
    for (let len = 1; len < base.length - at; len++) expect(strip(base.subarray(0, at + len), WEBP), `cut ${len}`).toBeNull()
  })

  it('rewrites an EXIF chunk that is itself the output of a strip to the same bytes', () => {
    for (const little of [false, true]) {
      for (let value = 2; value <= 8; value++) {
        const once = webp(vp8x(FLAG.exif), VP8, MIN_WEBP_EXIF(little, value))
        expectBytes(strip(once, WEBP), once)
      }
    }
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

  it('keeps the chunks on its list, tIME and the animation chunks included, so an animated PNG stays animated', () => {
    for (const type of PNG_KEPT) {
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

  it('keeps a chunk on its list at any place, and one of no data', () => {
    for (const type of PNG_KEPT) {
      for (const data of [[], [1], new Array(300).fill(7)]) {
        const input = png(IHDR, chunk(type, data), IDAT, chunk(type, data), IEND)
        expectBytes(strip(input, PNG), input)
      }
    }
  })

  it('keeps what the list names and nothing near it: a name one byte off is dropped, or refuses the file when it is critical', () => {
    const kept = new Set(PNG_KEPT)
    for (const name of PNG_KEPT) {
      for (let at = 0; at < 4; at++) {
        for (const change of [(x) => x ^ 0x20, (x) => x + 1, (x) => x - 1]) {
          const bytes = Uint8Array.from(ascii(name))
          bytes[at] = change(bytes[at])
          const near = String.fromCharCode(...bytes)
          const input = png(IHDR, chunk(near, LOCATION), IDAT, IEND)
          const out = strip(input, PNG)
          const label = `${name} as ${JSON.stringify(near)}`
          if (kept.has(near)) expectBytes(out, input)
          else if (bytes[0] >= 0x61 && bytes[0] <= 0x7a) expectBytes(out, png(IHDR, IDAT, IEND))
          else expect(out, label).toBeNull()
        }
      }
    }
  })

  it('drops every chunk that is not on the list and has a lowercase first letter, whatever it is called and wherever it stands', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 4, maxLength: 4 }),
        fc.integer({ min: 0x61, max: 0x7a }),
        fc.uint8Array({ maxLength: 40 }),
        fc.integer({ min: 0, max: 2 }),
        (name, first, data, place) => {
          const type = Uint8Array.from([first, name[1], name[2], name[3]])
          if (PNG_KEPT.includes(String.fromCharCode(...type))) return
          const metadata = cat(be32(data.length), type, data, be32(crc32(cat(type, data))))
          const input = [png(IHDR, metadata, IDAT, IEND), png(IHDR, IDAT, metadata, IDAT, IEND), png(IHDR, IDAT, metadata, IEND)][place]
          const expected = [png(IHDR, IDAT, IEND), png(IHDR, IDAT, IDAT, IEND), png(IHDR, IDAT, IEND)][place]
          expectBytes(strip(input, PNG), expected)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('refuses a file with an unknown critical chunk, before the first IDAT, between two, and after the last', () => {
    for (const name of ['ABCD', 'Exif', 'TEXT', 'EXIf', 'XMP ', 'C2PA', 'Zzzz', 'AAAA', 'IHDx', 'IDAt', 'IENd', 'PLTe', 'CABX']) {
      const critical = chunk(name, LOCATION)
      expect(strip(png(IHDR, critical, IDAT, IEND), PNG), `${name} first`).toBeNull()
      expect(strip(png(IHDR, IDAT, critical, IDAT, IEND), PNG), `${name} between`).toBeNull()
      expect(strip(png(IHDR, IDAT, critical, IEND), PNG), `${name} last`).toBeNull()
      expect(strip(png(IHDR, PNG_METADATA[0], IDAT, IEND, critical), PNG), `${name} past the end`).not.toBeNull()
    }
  })

  it('judges a chunk by its first byte: a to z may be dropped, any other byte makes it critical and refuses the file', () => {
    for (let first = 0; first < 256; first++) {
      const type = Uint8Array.of(first, 0x62, 0x43, 0x64)
      const odd = cat(be32(3), type, [1, 2, 3], be32(crc32(cat(type, [1, 2, 3]))))
      const out = strip(png(IHDR, odd, IDAT, IEND), PNG)
      if (first >= 0x61 && first <= 0x7a) expectBytes(out, png(IHDR, IDAT, IEND))
      else expect(out, `first byte ${first.toString(16)}`).toBeNull()
    }
  })

  it('refuses a critical chunk of no data, and one that is longer than the file, without a throw', () => {
    expect(strip(png(IHDR, chunk('ABCD'), IDAT, IEND), PNG)).toBeNull()
    const bad = Uint8Array.from(png(IHDR, chunk('ABCD', [1, 2]), IDAT, IEND))
    bad.set(be32(0xffffffff), PNG_SIG.length + IHDR.length)
    expect(strip(bad, PNG)).toBeNull()
  })

  it('drops metadata chunks with no data, and keeps empty chunks that are on the list', () => {
    expectBytes(strip(png(IHDR, chunk('tEXt'), chunk('zTXt'), chunk('iTXt'), chunk('eXIf'), chunk('abcd'), IDAT, IEND), PNG), png(IHDR, IDAT, IEND))
    const empty = png(IHDR, chunk('tIME'), chunk('pHYs'), chunk('IDAT'), IDAT, IEND)
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
    const kept = new Uint8Array(12 * 50_000)
    for (let i = 0; i < kept.length; i += 12) kept.set(ascii('tIME'), i + 4) // a chunk each: length 0, then the name, crc 0
    expect(strip(png(IHDR, IDAT, kept), PNG)).toBeNull()
    expectBytes(strip(png(IHDR, IDAT, kept, IEND), PNG), png(IHDR, IDAT, kept, IEND))
    // the same chunks with a name of no letters at all are critical, and refuse the file
    expect(strip(png(IHDR, IDAT, new Uint8Array(12 * 50_000), IEND), PNG)).toBeNull()
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
    const kept = [riff('ICCP', [1, 2]), riff('ANIM', [0, 0, 0, 0, 0, 0]), riff('ALPH', [1, 2, 3, 4]), riff('ANMF', cat(new Array(16).fill(1), VP8)), riff('ANMF', cat(new Array(16).fill(2), VP8L))]
    const others = [riff('abcd', [1]), riff('exif', [1]), riff('Exif', [1]), riff('xmp ', [1]), riff('XMP\0', [1]), riff('C2PA', C2PA)]
    const animated = webp(vp8x(FLAG.anim | FLAG.alpha | FLAG.exif), ...kept, EXIF_CHUNK, XMP_CHUNK, ...others)
    expectBytes(strip(animated, WEBP), webp(vp8x(FLAG.anim | FLAG.alpha), ...kept))
  })

  it('keeps the chunks on its list, each of them, at any place after the first, and one of no data', () => {
    for (const name of ['VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF', 'ICCP']) {
      for (const data of [[], [1], [1, 2], new Array(301).fill(7)]) {
        const chunkOf = riff(name, data)
        const input = webp(vp8x(0), chunkOf, VP8, chunkOf)
        expectBytes(strip(input, WEBP), input)
      }
    }
    const second = riff('VP8X', new Array(10).fill(0))
    expectBytes(strip(webp(vp8x(0), VP8, second), WEBP), webp(vp8x(0), VP8, second))
  })

  it('keeps what the list names and nothing near it: a name one byte off is dropped', () => {
    const names = ['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']
    for (const name of names) {
      for (let at = 0; at < 4; at++) {
        for (const change of [(x) => x ^ 0x20, (x) => x + 1, (x) => x - 1, () => 0]) {
          const near = Uint8Array.from(ascii(name))
          near[at] = change(near[at])
          if (names.includes(String.fromCharCode(...near)) || String.fromCharCode(...near) === 'EXIF') continue
          expectBytes(strip(webp(vp8x(0), VP8, riff(near, LOCATION)), WEBP), webp(vp8x(0), VP8))
        }
      }
    }
  })

  it('drops a chunk of any name that is not on the list, and fixes the RIFF size and the flags for it', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 4, maxLength: 4 }), fc.uint8Array({ maxLength: 40 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 2 }), (name, data, flags, place) => {
        const known = ['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP', 'EXIF']
        if (known.includes(String.fromCharCode(...name))) return
        const other = riff(name, data)
        const input = [webp(vp8x(flags), other, VP8), webp(vp8x(flags), VP8, other), webp(vp8x(flags), VP8, other, other)][place]
        const out = strip(input, WEBP)
        expectBytes(out, webp(vp8x(flags & 0xf3), VP8))
        expect(sizeField(out)).toBe(out.length - 8)
      }),
      { numRuns: 500 },
    )
  })

  it('drops a C2PA chunk whatever the flags say, and leaves the flags alone: no flag stands for it', () => {
    for (let flags = 0; flags < 256; flags++) {
      const out = strip(webp(vp8x(flags), VP8, riff('C2PA', C2PA)), WEBP)
      expectBytes(out, webp(vp8x(flags & 0xf3), VP8))
    }
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

  it('keeps the graphic control extension, and the three application extensions of its list, exactly', () => {
    const kept = [
      GCE,
      NETSCAPE,
      ext(0xff, ascii('ANIMEXTS1.0'), [1, 0, 0]),
      ext(0xff, ascii('ICCRGBG1012'), [1, 2, 3]),
      ext(0xf9, [4, 0, 0, 0, 0]),
      ext(0xf9),
      ext(0xff, ascii('NETSCAPE2.0')),
      ext(0xff, ascii('NETSCAPE2.0'), new Uint8Array(700).fill(0x33), [1, 2, 3]),
      ext(0xff, ascii('ICCRGBG1012'), new Uint8Array(300).fill(0x44)),
    ]
    for (const other of kept) {
      const input = gif(other, frame())
      expectBytes(strip(input, GIF), input)
    }
  })

  it('keeps an extension of its list at any place: before the first image, between two, and after the last', () => {
    for (const keptExt of [GCE, NETSCAPE, ext(0xff, ascii('ANIMEXTS1.0'), [1, 0, 0]), ext(0xff, ascii('ICCRGBG1012'), [1, 2, 3])]) {
      const input = gif(keptExt, frame(), keptExt, frame([5, 6]), keptExt)
      expectBytes(strip(input, GIF), input)
    }
  })

  it('drops every extension but those: plain text, comment, XMP, MGK8BIM0000 and MGKIPTC0000, and every label nobody defined', () => {
    for (let label = 0; label < 256; label++) {
      for (const data of [[[9, 9, 9]], [[1], [2]], []]) {
        const input = gif(ext(label, ...data), frame())
        expectBytes(strip(input, GIF), label === 0xf9 ? input : gif(frame()))
      }
    }
  })

  it('judges an application extension by its identifier, whole, and by the first sub-block of the extension alone', () => {
    const ids = ['NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012']
    for (const id of ids) {
      for (let at = 0; at < id.length; at++) {
        for (const change of [(x) => x ^ 0x20, (x) => x ^ 0x01, () => 0, () => 0xff]) {
          const bent = Uint8Array.from(ascii(id))
          bent[at] = change(bent[at])
          if (ids.includes(String.fromCharCode(...bent))) continue
          expectBytes(strip(gif(ext(0xff, bent, [1, 0, 0]), frame()), GIF), gif(frame()))
        }
      }
      // the identifier is the whole first sub-block: one byte more, one byte less, the same bytes in the second sub-block
      expectBytes(strip(gif(cat([0x21, 0xff, 12], ascii(id), [0x41, 0]), frame()), GIF), gif(frame()))
      expectBytes(strip(gif(cat([0x21, 0xff, 10], ascii(id).subarray(0, 10), [1, 0, 0]), frame()), GIF), gif(frame()))
      expectBytes(strip(gif(cat([0x21, 0xff, 12], ascii(id).subarray(0, 10), [0x41, 0x42, 0]), frame()), GIF), gif(frame()))
      expectBytes(strip(gif(ext(0xff, [1], ascii(id)), frame()), GIF), gif(frame()))
      // the same identifier under a label that is not 0xFF
      for (const label of [0x01, 0xf9, 0xfe, 0xfd, 0x00]) {
        const input = gif(ext(label, ascii(id), [1, 0, 0]), frame())
        expectBytes(strip(input, GIF), label === 0xf9 ? input : gif(frame()))
      }
    }
  })

  it('drops MGK8BIM0000 and MGKIPTC0000, the blocks ImageMagick writes the editor data into, and the location in them', () => {
    for (const id of ['MGK8BIM0000', 'MGKIPTC0000', 'MGKICC00000', 'MGKEXIF0000']) {
      const input = gif(NETSCAPE, ext(0xff, ascii(id), LOCATION, new Uint8Array(400).fill(0x55)), GCE, frame(), ext(0xff, ascii(id), [1]))
      const out = strip(input, GIF)
      expectBytes(out, gif(NETSCAPE, GCE, frame()))
      expect(has(out, GPS_MARK)).toBe(false)
    }
  })

  it('drops the XMP application extension, in the form Photoshop writes it and as plain sub-blocks', () => {
    const asBlocks = ext(0xff, ascii('XMP DataXMP'), XMP_PACKET, new Uint8Array(600).fill(0x41))
    for (const xmp of [xmpExt(), xmpExt(new Uint8Array(0)), xmpExt(new Uint8Array(300).fill(0x20)), xmpExt(Uint8Array.of(1)), asBlocks, ext(0xff, ascii('XMP DataXMP'))]) {
      const out = strip(gif(xmp, frame(), xmp, GCE, xmp), GIF)
      expectBytes(out, gif(frame(), GCE))
      expect(has(out, GPS_MARK)).toBe(false)
    }
  })

  it('finds the end of an XMP extension whatever its packet holds, the packet being read as sub-block sizes', () => {
    fc.assert(
      fc.property(xmpPacket(600), (packet) => {
        expectBytes(strip(gif(GCE, xmpExt(packet), frame(), xmpExt(packet)), GIF), gif(GCE, frame()))
      }),
      { numRuns: 300 },
    )
  })

  it('drops an application extension that only looks like XMP, as it drops every one that is not on the list', () => {
    const lookAlikes = [
      ext(0xff, ascii('XMP DataXMQ'), [1, 0, 0]),
      ext(0xff, ascii('xmp DataXMP'), [1, 0, 0]),
      ext(0xff, ascii('XMP DataXM'), [1, 0, 0]),
      ext(0xff, ascii('XMP DataXMPP'), [1, 0, 0]),
      ext(0xff, ascii('XMP Data'), [1, 0, 0]),
      ext(0x01, ascii('XMP DataXMP'), [1, 0, 0]),
      ext(0xfd, ascii('XMP DataXMP'), [1, 0, 0]),
      cat([0x21, 0xff, 12], ascii('XMP DataXMP'), [0x41], [1, 0, 0]),
      cat([0x21, 0xff, 10], ascii('XMP DataXM'), [1, 0, 0]),
    ]
    for (const other of lookAlikes) expectBytes(strip(gif(other, frame()), GIF), gif(frame()))
  })

  it('keeps the looping and ICC extensions while it drops the XMP one next to them', () => {
    const input = gif(NETSCAPE, xmpExt(), ext(0xff, ascii('ANIMEXTS1.0'), [1, 0, 0]), GIF_COMMENT, ext(0xff, ascii('ICCRGBG1012'), [1, 2, 3]), GCE, frame(), GCE, frame())
    expectBytes(strip(input, GIF), gif(NETSCAPE, ext(0xff, ascii('ANIMEXTS1.0'), [1, 0, 0]), ext(0xff, ascii('ICCRGBG1012'), [1, 2, 3]), GCE, frame(), GCE, frame()))
  })

  it('is null for an XMP extension that never ends, or is cut anywhere', () => {
    const whole = gif(frame(), xmpExt())
    for (let len = 26; len < whole.length; len++) expect(strip(whole.subarray(0, len), GIF), `cut ${len}`).toBeNull()
    expect(strip(cat(GIF_HEAD(), frame(), [0x21, 0xff, 11], ascii('XMP DataXMP'), XMP_PACKET), GIF)).toBeNull()
    expect(strip(cat(GIF_HEAD(), frame(), [0x21, 0xff, 11], ascii('XMP DataXMP')), GIF)).toBeNull()
    expect(strip(cat(GIF_HEAD(), frame(), [0x21, 0xff, 11], ascii('XMP DataXM')), GIF)).toBeNull()
    expect(strip(cat(GIF_HEAD(), frame(), [0x21, 0xff, 11]), GIF)).toBeNull()
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

// ================================================================================================= keep lists

describe('strip: a picture keeps only what it needs to be seen', () => {
  for (const type of TYPES) {
    for (const [label, build] of CONTAINERS[type]) {
      it(`${type}: ${label} goes, with whatever it carries, and the image data comes out as it went in`, () => {
        const input = WITH[type]([build()])
        expect(input.length).toBeGreaterThan(CLEAN[type]().length)
        const out = strip(input, type)
        expectBytes(out, CLEAN[type]())
        expect(has(out, GPS_MARK)).toBe(false)
        expect(has(out, LOCATION)).toBe(false)
        expect(has(out, IMAGE_DATA[type]())).toBe(true)
        expectBytes(strip(out, type), out) // and stripping what came out changes nothing
      })
    }

    it(`${type}: all of them in one picture go, and nothing of them stays`, () => {
      const all = CONTAINERS[type].map(([, build]) => build())
      const input = WITH[type](all)
      expect(has(input, GPS_MARK)).toBe(true)
      const out = strip(input, type)
      expectBytes(out, CLEAN[type]())
      expect(has(out, GPS_MARK)).toBe(false)
      expectBytes(strip(out, type), out)
    })
  }

  it('drops a container whole, whatever kept chunks and blocks its bytes spell inside it', () => {
    const inside = {
      [PNG]: chunk('caBX', [IDAT, chunk('IEND'), LOCATION]),
      [WEBP]: riff('C2PA', [VP8, LOCATION]),
      [GIF]: ext(0xff, ascii('MGK8BIM0000'), frame(), [0x3b], NETSCAPE, LOCATION),
      [JPEG]: seg(0xeb, [JFIF, SOS_HEADER, EOI, LOCATION]),
    }
    for (const type of TYPES) {
      const out = strip(WITH[type]([inside[type]]), type)
      expectBytes(out, CLEAN[type]())
      expect(has(out, GPS_MARK)).toBe(false)
    }
  })

  it('refuses what it cannot keep and cannot drop: a PNG chunk that is critical and unknown', () => {
    const out = strip(WITH[PNG]([chunk('CAbX', C2PA)]), PNG)
    expect(out).toBeNull()
  })

  it('leaves the image data byte for byte, and everything it keeps in place, when containers stand among it', () => {
    const colours = {
      [PNG]: [chunk('pHYs', [1, 2, 3, 4]), chunk('iCCP', [ascii('icc\0\0'), 9, 9]), chunk('tIME', [1, 2, 3, 4, 5, 6, 7]), chunk('acTL', [be32(2), be32(0)])],
      [WEBP]: [riff('ICCP', [1, 2, 3]), riff('ANIM', [0, 0, 0, 0, 0, 0]), riff('ALPH', [1, 2, 3, 4, 5])],
      [GIF]: [NETSCAPE, ext(0xff, ascii('ANIMEXTS1.0'), [1, 0, 0]), ext(0xff, ascii('ICCRGBG1012'), [1, 2, 3, 4])],
      [JPEG]: [JFIF, ICC, ADOBE, seg(0xe0, [ascii('JFIF\0'), 1, 2, 1, 0, 72, 0, 72, 0, 0])],
    }
    const place = {
      [PNG]: (middle) => png(IHDR, middle, IDAT, IEND),
      [WEBP]: (middle) => webp(vp8x(0), middle, VP8),
      [GIF]: (middle) => gif(middle, GCE, FRAME_TRAP),
      [JPEG]: (middle) => cat(SOI, middle, DQT, SOF0, SOS_HEADER, SCAN, EOI),
    }
    for (const type of TYPES) {
      const containers = CONTAINERS[type].map(([, build]) => build())
      const stays = containers.map((_, i) => colours[type][i % colours[type].length])
      const out = strip(place[type](containers.flatMap((c, i) => [c, stays[i]])), type)
      expectBytes(out, place[type](stays))
      expect(has(out, GPS_MARK)).toBe(false)
      expect(has(out, IMAGE_DATA[type]())).toBe(true)
    }
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
  // an EXIF, with an orientation that may be right, or 1, or none, or nonsense, in either byte order
  const exifSpec = fc.record({
    little: fc.boolean(),
    orientation: fc.oneof(fc.integer({ min: 2, max: 8 }), fc.constantFrom(0, 1, 9, 0xffff)),
    extra: fc.array(dataBytes, { maxLength: 3 }),
    fill: fillCount,
  })
  const exifTiff = ({ little, orientation, extra }) =>
    tiff({
      little,
      entries: [ifdEntry(little, 0x010f, 3, 1, shortValue(little, 9)), orient(little, orientation)],
      after: extra,
    })
  const jpegPiece = fc.oneof(
    { weight: 4, arbitrary: fc.record({ code: jpegCode, payload: dataBytes, fill: fillCount }).map((s) => ({ kind: 'seg', ...s })) },
    { weight: 2, arbitrary: exifSpec.map((s) => ({ kind: 'exif', ...s })) },
    { weight: 1, arbitrary: entropy.map((data) => ({ kind: 'scan', data })) },
    // an APP2 that does hold an ICC profile: the one APP2 that stays
    { weight: 1, arbitrary: fc.record({ payload: dataBytes, fill: fillCount }).map(({ payload, fill }) => ({ kind: 'seg', code: 0xe2, payload: cat(ascii('ICC_PROFILE\0'), payload), fill })) },
    // an APP0 that is a JFIF header with no thumbnail (9 bytes after the identifier), the one APP0 that stays, or one near it
    {
      weight: 1,
      arbitrary: fc
        .record({ id: fc.constantFrom('JFIF\0', 'JFIF\0', 'JFXX\0', 'JFIF '), rest: fc.oneof(fc.uint8Array({ minLength: 9, maxLength: 9 }), dataBytes), fill: fillCount })
        .map(({ id, rest, fill }) => ({ kind: 'seg', code: 0xe0, payload: cat(ascii(id), rest), fill })),
    },
  )
  const jpegCase = fc
    .record({ head: fc.array(jpegPiece, { maxLength: 8 }), scan: entropy, tail: fc.array(jpegPiece, { maxLength: 6 }), junk: dataBytes })
    .map(({ head, scan, tail, junk }) => ({ pieces: [...head, { kind: 'scan', data: scan }, ...tail], junk }))
  const JPEG_GONE = new Set([0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xef, 0xfe])
  const ICC_ID = ascii('ICC_PROFILE\0')
  const isIcc = (p) => p.code === 0xe2 && ICC_ID.every((x, i) => p.payload[i] === x)
  const JFIF_ID = ascii('JFIF\0')
  const isJfif = (p) => p.code === 0xe0 && p.payload.length === 14 && JFIF_ID.every((x, i) => p.payload[i] === x)
  const goes = (p) => (JPEG_GONE.has(p.code) && !isIcc(p)) || (p.code === 0xe0 && !isJfif(p))
  const jpegOf = (pieces, keep, junk = []) => {
    let written = false
    return cat(
      SOI,
      pieces.map((p) => {
        if (p.kind === 'scan') return [SOS_HEADER, p.data]
        // fill bytes before a segment stay, even when the segment goes
        const fill = new Array(p.fill).fill(0xff)
        if (p.kind === 'exif') {
          if (!keep) return [fill, exifApp1(exifTiff(p))]
          if (written || p.orientation < 2 || p.orientation > 8) return [fill]
          written = true // the first usable EXIF stands for all of them
          return [fill, MIN_APP1(p.little, p.orientation)]
        }
        return [fill, keep && goes(p) ? [] : seg(p.code, p.payload)]
      }),
      EOI,
      junk,
    )
  }

  // PNG: IHDR, any chunks, at least one IDAT, IEND.
  const pngType = fc.oneof(
    fc.constantFrom('tEXt', 'zTXt', 'iTXt', 'eXIf', 'caBX', 'zxIf', 'tIME', 'pHYs', 'IDAT', 'IDAT', 'acTL', 'fdAT', 'iCCP'),
    fc.stringMatching(/^[a-z][a-zA-Z]{3}$/), // an ancillary chunk of any name: it stays only if it is on the list
  )
  const pngCase = fc.record({
    mid: fc.array(fc.record({ type: pngType, data: dataBytes }), { maxLength: 10 }),
    junk: dataBytes,
  })
  const pngOf = (mid, keep, junk = []) =>
    cat(PNG_SIG, IHDR, mid.filter((c) => !(keep && !PNG_KEPT.includes(c.type))).map((c) => chunk(c.type, c.data)), IDAT, IEND, junk)

  // WebP: VP8X, any chunks and a picture.
  const webpType = fc.oneof(
    fc.constantFrom('EXIF', 'EXIF', 'XMP ', 'XMP ', 'ICCP', 'ALPH', 'ANIM', 'ANMF', 'VP8 ', 'VP8L'),
    fc.stringMatching(/^[a-zA-Z ]{4}$/).filter((t) => !['VP8X', 'RIFF'].includes(t)),
  )
  const webpPiece = fc.oneof(
    { weight: 4, arbitrary: fc.record({ type: webpType, data: dataBytes }) },
    { weight: 2, arbitrary: exifSpec.map((s) => ({ type: 'EXIF', exif: s })) },
  )
  const webpCase = fc.record({
    flags: fc.integer({ min: 0, max: 255 }),
    mid: fc.array(webpPiece, { maxLength: 10 }),
    junk: dataBytes,
  })
  const webpOf = (flags, mid, keep, junk = []) => {
    let written = false
    const chunks = mid.flatMap((c) => {
      if (c.exif) {
        if (!keep) return [exifChunk(exifTiff(c.exif), c.exif.fill === 1)]
        if (written || c.exif.orientation < 2 || c.exif.orientation > 8) return []
        written = true
        return [MIN_WEBP_EXIF(c.exif.little, c.exif.orientation)]
      }
      return keep && !['VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF', 'ICCP'].includes(c.type) ? [] : [riff(c.type, c.data)]
    })
    return cat(webp(vp8x(keep ? (flags & 0xf3) | (written ? FLAG.exif : 0) : flags), chunks, VP8), junk)
  }

  // GIF: any extensions and frames, at least one frame.
  const gifItem = fc.oneof(
    fc.record({ kind: fc.constant('comment'), data: fc.array(dataBytes, { maxLength: 3 }) }),
    fc.record({ kind: fc.constant('ext'), label: fc.integer({ min: 0, max: 255 }).filter((l) => l !== 0xfe), data: fc.array(dataBytes, { maxLength: 3 }) }),
    // an application extension of the list, with any data behind its identifier: the one kind that stays besides the GCE
    fc.record({ kind: fc.constant('app'), id: fc.constantFrom('NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012'), data: fc.array(dataBytes, { maxLength: 3 }) }),
    // an application extension of an identifier made of any 11 bytes, which goes unless it is one of the three
    fc.record({ kind: fc.constant('other'), id: fc.uint8Array({ minLength: 11, maxLength: 11 }), data: fc.array(dataBytes, { maxLength: 3 }) }),
    fc.record({ kind: fc.constant('frame'), data: dataBytes, lct: fc.boolean() }),
    fc.record({ kind: fc.constant('xmp'), packet: xmpPacket(300) }),
  )
  const isListed = (id) => ['NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012'].includes(String.fromCharCode(...id))
  const gifCase = fc.record({ items: fc.array(gifItem, { maxLength: 8 }), junk: dataBytes })
  const gifOf = (items, keep, junk = []) =>
    cat(
      GIF_HEAD(),
      items.map((i) => {
        if (i.kind === 'frame') return frame(i.data, { lct: i.lct })
        if (i.kind === 'comment') return keep ? [] : ext(0xfe, ...i.data)
        if (i.kind === 'xmp') return keep ? [] : xmpExt(i.packet)
        if (i.kind === 'app') return ext(0xff, ascii(i.id), ...i.data)
        if (i.kind === 'other') return keep && !isListed(i.id) ? [] : ext(0xff, i.id, ...i.data)
        return keep && i.label !== 0xf9 ? [] : ext(i.label, ...i.data)
      }),
      frame([9]),
      [0x3b],
      junk,
    )

  it('JPEG: what comes out is the input minus every APPn but a JFIF in 0, 14 and an ICC profile in 2, the comments, what follows the EOI, and an EXIF cut down to its orientation', () => {
    fc.assert(
      fc.property(jpegCase, ({ pieces, junk }) => {
        const input = jpegOf(pieces, false, junk)
        expectBytes(strip(input, JPEG), jpegOf(pieces, true))
      }),
      { numRuns: 300 },
    )
  })

  it('PNG: what comes out is the input minus every chunk that is not on the list, and what follows IEND', () => {
    fc.assert(
      fc.property(pngCase, ({ mid, junk }) => {
        expectBytes(strip(pngOf(mid, false, junk), PNG), pngOf(mid, true))
      }),
      { numRuns: 300 },
    )
  })

  it('WebP: what comes out is the input minus every chunk that is not on the list and all of the EXIF but its orientation, with the size and the flags right', () => {
    fc.assert(
      fc.property(webpCase, ({ flags, mid, junk }) => {
        expectBytes(strip(webpOf(flags, mid, false, junk), WEBP), webpOf(flags, mid, true))
      }),
      { numRuns: 300 },
    )
  })

  it('GIF: what comes out is the input minus every extension but the graphic control and those of the list, and what follows the trailer', () => {
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

  it('a 10 MB JPEG of empty APP3 segments, and one of APP2 segments that nearly spell an ICC profile', LONG, () => {
    const empty = repeat(seg(0xe3), TEN_MB - 400)
    const first = timed(() => stripBytes(jpeg([JFIF, empty.bytes]), JPEG))
    expect(first.ms).toBeLessThan(BUDGET_MS)
    expectBytes(first.result, jpeg([JFIF]))
    const nearly = repeat(seg(0xe2, [ascii('ICC_PROFILE'), 1]), TEN_MB - 400)
    const second = timed(() => stripBytes(jpeg([JFIF, nearly.bytes]), JPEG))
    expect(second.ms).toBeLessThan(BUDGET_MS)
    expectBytes(second.result, jpeg([JFIF]))
  })

  it('a 10 MB PNG of empty chunks that are not on the list', LONG, () => {
    const { bytes } = repeat(chunk('abcd'), TEN_MB - 200)
    const { result, ms } = timed(() => stripBytes(png(IHDR, IDAT, bytes, IEND), PNG))
    expect(ms).toBeLessThan(BUDGET_MS)
    expectBytes(result, png(IHDR, IDAT, IEND))
  })

  it('a 10 MB WebP of empty chunks that are not on the list', LONG, () => {
    const { bytes } = repeat(riff('abcd'), TEN_MB - 200)
    const { result, ms } = timed(() => stripBytes(webp(vp8x(0), VP8, bytes), WEBP))
    expect(ms).toBeLessThan(BUDGET_MS)
    expectBytes(result, webp(vp8x(0), VP8))
  })

  it('a 10 MB GIF of application extensions that nearly are one of the list', LONG, () => {
    const { bytes } = repeat(ext(0xff, ascii('NETSCAPE2.1')), TEN_MB - 200)
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
