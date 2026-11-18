/**
 * The pictures a member attaches to a Librarius reply, judged and cleaned by their bytes before they go to Discord.
 * Pure: bytes in, bytes or null out; no I/O, no clock, no logging, and no call here throws.
 *
 * sniff(bytes) → 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', or null. It looks at the magic bytes and at
 * nothing else: not a file name, not a declared type. SVG, and every other type, is null, and so is anything that is not
 * a Uint8Array (a Buffer is one). The signatures are the ones the Reliquarium's uploads test (galleryValidate.js
 * sniffImage), but the list of types is this module's own: the Librarius accepts these four and no other, whatever the
 * gallery may come to accept.
 *
 * strip(bytes, type) → a new, plain Uint8Array, or null. `type` is the answer of sniff for those bytes: when it is not,
 * or the bytes are not a whole well-formed picture, the answer is null. The bytes are walked once, by the lengths the
 * format itself gives (never by searching for a name), so metadata-looking bytes inside the image data are image data
 * and stay. What is taken out, and nothing else:
 *   - JPEG: the APP1 segments (EXIF, XMP, whatever their identifier says) and the APP13 segments (Photoshop and IPTC);
 *   - PNG: the tEXt, zTXt, iTXt and eXIf chunks (tIME is harmless and stays);
 *   - WebP: the EXIF and XMP chunks, with the RIFF size and the VP8X flags that announce them put right;
 *   - GIF: the comment extensions (0x21 0xFE).
 * Everything else stays byte for byte, so the image data is identical and an animation stays animated. What follows the
 * end of the picture (the EOI of a JPEG, the IEND of a PNG, the RIFF size of a WebP, the trailer of a GIF) is cut off: it
 * is not part of the picture, and it is where a second picture or a leftover of an editor hides. Checksums are not
 * verified (the PNG CRCs); the structure is.
 *
 * null means malformed: a segment, chunk or block that overruns the buffer, a length that cannot be right, a picture with
 * no image data (a JPEG with no scan, a PNG with no IDAT, a WebP with no picture chunk, a GIF with no image), or one that
 * is cut short (no EOI, IEND or trailer). Every walk moves forward by at least a byte a step, so the work is linear in the
 * size of the input, and no read goes past the end of it.
 */

const bytesOf = (text) => Array.from(text, (c) => c.charCodeAt(0))
/** The four bytes of a name such as 'IHDR' as one number, the way the file stores them. */
const tag = (name) => new DataView(Uint8Array.from(bytesOf(name)).buffer).getUint32(0)

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const GIF87A_SIGNATURE = bytesOf('GIF87a')
const GIF89A_SIGNATURE = bytesOf('GIF89a')
const RIFF_SIGNATURE = bytesOf('RIFF')
const WEBP_SIGNATURE = bytesOf('WEBP')

const JPEG_DROP = new Set([0xe1, 0xed]) // APP1, APP13

const IHDR = tag('IHDR')
const IDAT = tag('IDAT')
const IEND = tag('IEND')
const PNG_DROP = new Set([tag('tEXt'), tag('zTXt'), tag('iTXt'), tag('eXIf')])

const VP8 = tag('VP8 ')
const VP8L = tag('VP8L')
const VP8X = tag('VP8X')
const WEBP_DROP = new Set([tag('EXIF'), tag('XMP ')])
const WEBP_IMAGE = new Set([VP8, VP8L, tag('ANMF')])
// In the first byte of a VP8X chunk: the flag of an EXIF chunk (0x08) and of an XMP chunk (0x04).
const WEBP_METADATA_FLAGS = 0x0c

/**
 * A copy of `b` up to `end` without the ranges in `drops`, a flat list of from, to, from, to... in order. Always a new
 * array: nothing the caller passed in is shared with it or changed.
 */
function without(b, end, drops) {
  let size = end
  for (let i = 0; i < drops.length; i += 2) size -= drops[i + 1] - drops[i]
  const out = new Uint8Array(size)
  let from = 0
  let at = 0
  for (let i = 0; i < drops.length; i += 2) {
    out.set(b.subarray(from, drops[i]), at)
    at += drops[i] - from
    from = drops[i + 1]
  }
  out.set(b.subarray(from, end), at)
  return out
}

/**
 * Where the entropy-coded data of a JPEG scan that starts at `from` ends: the index of the 0xFF of the next marker, or the
 * length of the file when there is none. In that data a 0xFF is followed by 0x00 (a stuffed byte) or by a restart marker
 * (0xD0 to 0xD7), and by any number of 0xFF fill bytes before a marker; anything else after it is a marker.
 */
function endOfScan(b, from) {
  const n = b.length
  for (let i = from; i < n; i++) {
    if (b[i] !== 0xff) continue
    let j = i + 1
    while (j < n && b[j] === 0xff) j++
    if (j === n) break
    const code = b[j]
    if (code !== 0x00 && (code < 0xd0 || code > 0xd7)) return j - 1
    i = j
  }
  return n
}

function stripJpeg(b) {
  const n = b.length
  const view = new DataView(b.buffer, b.byteOffset, b.length)
  const drops = []
  let scanned = false
  let pos = 2 // past the SOI
  while (pos + 1 < n) {
    if (b[pos] !== 0xff) return null
    const code = b[pos + 1]
    if (code === 0xff) {
      pos += 1 // a fill byte before a marker
      continue
    }
    if (code === 0xd9) return scanned ? without(b, pos + 2, drops) : null
    // Nothing but EOI is a marker without a length here: not a stuffed zero, not TEM, not a restart, not a second SOI.
    if (code === 0x00 || code === 0x01 || (code >= 0xd0 && code <= 0xd8)) return null
    // The marker, its length, and an EOI after them at least: a segment that no EOI can follow is cut short.
    if (pos + 6 > n) return null
    const length = view.getUint16(pos + 2) // counts its own two bytes
    if (length < 2) return null
    // A segment that claims more than the file holds leaves `pos` at or past the end, and the walk ends in null.
    const next = pos + 2 + length
    if (JPEG_DROP.has(code)) drops.push(pos, next)
    if (code !== 0xda) {
      pos = next
      continue
    }
    scanned = true
    pos = endOfScan(b, next) // the end of the file, if no marker follows, which ends the walk in null
  }
  return null
}

function stripPng(b) {
  const n = b.length
  const view = new DataView(b.buffer, b.byteOffset, b.length)
  const drops = []
  let data = false
  let pos = 8 // past the signature
  while (pos + 12 <= n) {
    const size = view.getUint32(pos)
    const type = view.getUint32(pos + 4)
    // The length, the type, the data and the CRC: past the end of the file if the chunk lies about its length.
    const end = pos + 12 + size
    if (pos === 8 && (type !== IHDR || size !== 13)) return null
    if (type === IEND) return size === 0 && data ? without(b, end, drops) : null
    if (type === IDAT) data = true
    else if (PNG_DROP.has(type)) drops.push(pos, end)
    pos = end // a chunk that claims more than the file holds ends the walk here, in null
  }
  return null
}

function stripWebp(b) {
  const view = new DataView(b.buffer, b.byteOffset, b.length)
  const end = view.getUint32(4, true) + 8 // the RIFF size does not count the 8 bytes before it
  if (end > b.length) return null
  const drops = []
  let extended = false
  let image = false
  let pos = 12 // past RIFF, the size and WEBP
  while (pos < end) {
    if (pos + 8 > end) return null
    const type = view.getUint32(pos)
    const size = view.getUint32(pos + 4, true)
    const next = pos + 8 + size + (size & 1) // a chunk of odd size is followed by a padding byte
    if (next > end) return null
    if (pos === 12) {
      if (type === VP8X) {
        if (size !== 10) return null
        extended = true
      } else if (type !== VP8 && type !== VP8L) return null
    }
    if (WEBP_DROP.has(type)) drops.push(pos, next)
    else if (WEBP_IMAGE.has(type)) image = true
    pos = next
  }
  if (!image) return null
  const out = without(b, end, drops)
  new DataView(out.buffer).setUint32(4, out.length - 8, true)
  if (extended) out[20] &= ~WEBP_METADATA_FLAGS // the flags are the first byte of the VP8X data, at 12 + 8
  return out
}

/** The bytes of the colour table a packed byte announces: 3 bytes a colour, 2 to the power of (size field + 1) of them. */
const colourTable = (packed) => (packed & 0x80 ? 3 << ((packed & 7) + 1) : 0)

/**
 * Where a chain of data sub-blocks that starts at `from` ends, just past its zero terminator: the length of the file if
 * it never does.
 */
function endOfSubBlocks(b, from) {
  let i = from
  while (i < b.length) {
    const size = b[i]
    if (size === 0) return i + 1
    i += 1 + size
  }
  return b.length
}

function stripGif(b) {
  const n = b.length
  // The smallest GIF with a picture: the header and screen descriptor (13), an image descriptor, its LZW size and an empty
  // chain of sub-blocks (12), and the trailer (1).
  if (n < 26) return null
  const drops = []
  let image = false
  let pos = 13 + colourTable(b[10])
  while (pos < n) {
    const kind = b[pos]
    if (kind === 0x3b) return image ? without(b, pos + 1, drops) : null
    if (kind === 0x21) {
      if (pos + 4 > n) return null // the introducer, the label, the end of the chain and the trailer must still fit
      const next = endOfSubBlocks(b, pos + 2) // past the introducer and the label
      if (b[pos + 1] === 0xfe) drops.push(pos, next)
      pos = next
    } else if (kind === 0x2c) {
      if (pos + 13 > n) return null // the descriptor, the LZW size, the end of its chain and the trailer must still fit
      image = true
      // Past the descriptor, its colour table and the LZW size.
      pos = endOfSubBlocks(b, pos + 11 + colourTable(b[pos + 9]))
    } else return null
  }
  return null // a chain that never ended leaves `pos` at the end of the file, and so does a file with no trailer
}

const STRIPPERS = new Map([
  ['image/jpeg', stripJpeg],
  ['image/png', stripPng],
  ['image/webp', stripWebp],
  ['image/gif', stripGif],
])

/** Whether `signature` sits at `at` in `bytes`, all of it: a file that ends inside the signature does not match. */
const hasAt = (bytes, signature, at = 0) =>
  at + signature.length <= bytes.length && signature.every((v, i) => bytes[at + i] === v)

/** → 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', or null for anything else. Judged by the bytes alone. */
export function sniff(bytes) {
  if (!(bytes instanceof Uint8Array)) return null
  if (hasAt(bytes, JPEG_SIGNATURE)) return 'image/jpeg'
  if (hasAt(bytes, PNG_SIGNATURE)) return 'image/png'
  if (hasAt(bytes, GIF87A_SIGNATURE) || hasAt(bytes, GIF89A_SIGNATURE)) return 'image/gif'
  if (hasAt(bytes, RIFF_SIGNATURE) && hasAt(bytes, WEBP_SIGNATURE, 8)) return 'image/webp'
  return null
}

/** → the picture without its metadata, as a new plain Uint8Array, or null when it is not a whole picture of `type`. */
export function strip(bytes, type) {
  if (sniff(bytes) !== type) return null
  return STRIPPERS.get(type)(bytes)
}
