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
 * and stay.
 *
 * What stays is a list, not what is left over once a list of known metadata has gone: a container of metadata that this
 * file has never heard of (a C2PA manifest, an editor's private chunk, a block that a newer version of the format adds)
 * is dropped with the rest, and only what a picture needs to be seen stays, in each format:
 *   - JPEG: the segments that are not APPn or COM (the tables, the frame, the scans) stay, and of the APPn three: APP0
 *     when it is a JFIF header with no thumbnail (its payload starts with "JFIF\0" and its length is 16, which leaves no
 *     room for one), APP2 when its payload starts with "ICC_PROFILE\0" (the colour profile) and APP14 (Adobe, which says
 *     how the colour channels are to be read). Every other APPn goes: APP0 of a JFXX extension or of a JFIF that carries a
 *     thumbnail (a small copy of the picture, perhaps from before it was cropped, and in a JFXX a whole JPEG with an EXIF
 *     of its own), APP1 with its EXIF and XMP, APP2 of FlashPix (FPXR) and of the Multi-Picture Format (MPF), APP11 (the
 *     JUMBF of C2PA), APP13 and the rest. So does the comment (COM). No decoder needs an APP0;
 *   - PNG: IHDR, PLTE, IDAT and IEND (the picture), tRNS, cHRM, gAMA, iCCP, sBIT, sRGB, cICP, mDCv, cLLi and bKGD (how it is
 *     coloured), pHYs (its size), acTL, fcTL and fdAT (its movement) and tIME stay. Every other chunk goes: the text chunks,
 *     eXIf, zxIf, caBX (C2PA), and every one that no one has heard of. A chunk that is not on the list and is critical (its
 *     first letter is not a lowercase one) cannot be dropped without breaking the picture, so the file is refused;
 *   - WebP: VP8, VP8L, VP8X, ALPH, ANIM, ANMF and ICCP stay. Every other chunk goes: the XMP chunk, the EXIF chunk, C2PA, and
 *     the unknown. The RIFF size is put right, and so are the VP8X flags that announce an EXIF or an XMP chunk;
 *   - GIF: the graphic control extensions (0xF9) stay, and of the application extensions the three that tell how the
 *     picture moves and what colour it is: NETSCAPE2.0 and ANIMEXTS1.0 (the looping) and ICCRGBG1012 (the ICC profile).
 *     Every other extension goes: the comment (0xFE), the plain text (0x01), the XMP, ImageMagick's MGK8BIM0000 and
 *     MGKIPTC0000, and every label and application that no one has heard of.
 * What of an EXIF survives is its orientation, because a photo taken upright on a phone is stored sideways with only this
 * tag saying which way up it goes. When the EXIF of a JPEG (its APP1) or of a WebP (its EXIF chunk) has an Orientation
 * (tag 0x0112) of 2 to 8 in IFD0, an EXIF of that alone is written back where it stood: the TIFF header in the original's
 * byte order, IFD0 with the one entry, and no next IFD. Nothing else of the original goes into it: no GPS, no maker note,
 * no date, no thumbnail. An orientation of 1 (the default), none, a value out of range, or an EXIF that is malformed in
 * any way writes nothing. The first EXIF that yields an orientation is the one used, and only one is written. A WebP gets
 * the EXIF flag in its VP8X only when a chunk is written, and a WebP with no VP8X cannot carry one. A PNG's eXIf is
 * dropped whole.
 * What stays of a kept chunk, segment or block is its bytes as they were, so the image data is identical and an animation
 * stays animated; the lists are of what stays, not of what is inside it. What follows the end of the picture (the EOI of a
 * JPEG, the IEND of a PNG, the RIFF size of a WebP, the trailer of a GIF) is cut off: it is not part of the picture, and it
 * is where a second picture or a leftover of an editor hides. Checksums are not verified (the PNG CRCs); the structure is.
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

const APP0 = 0xe0
const APP1 = 0xe1
const APP2 = 0xe2
const APP14 = 0xee
const APP15 = 0xef
const COM = 0xfe
const ICC_ID = bytesOf('ICC_PROFILE\0') // what the payload of an APP2 starts with when it holds a colour profile
const JFIF_ID = bytesOf('JFIF\0') // what the payload of an APP0 starts with when it is a JFIF header
// The length of a JFIF APP0 with no thumbnail: the length's own 2 bytes, the identifier (5), the version (2), the units
// (1), the two densities (4) and the thumbnail's width and height (2). A thumbnail's pixels would come after them.
const JFIF_LENGTH = 16
const EXIF_ID = bytesOf('Exif\0\0')
const ORIENTATION_TAG = 0x0112
const TIFF_SHORT = 3

const LOWERCASE_A = 0x61
const LOWERCASE_Z = 0x7a

const IHDR = tag('IHDR')
const IDAT = tag('IDAT')
const IEND = tag('IEND')
// The chunks a PNG keeps: the picture, how it is coloured, how large it is, how it moves, and when it was made.
const PNG_KEEP = new Set(
  ['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCv', 'cLLi', 'bKGD', 'pHYs', 'acTL', 'fcTL', 'fdAT', 'tIME'].map(tag),
)

const VP8 = tag('VP8 ')
const VP8L = tag('VP8L')
const VP8X = tag('VP8X')
const WEBP_EXIF = tag('EXIF')
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP'].map(tag))
const WEBP_IMAGE = new Set([VP8, VP8L, tag('ANMF')])
// In the first byte of a VP8X chunk: the flag of an EXIF chunk (0x08) and of an XMP chunk (0x04).
const WEBP_EXIF_FLAG = 0x08
const WEBP_METADATA_FLAGS = 0x0c

const GRAPHIC_CONTROL = 0xf9
const APPLICATION = 0xff
// The application identifier and authentication code, 11 bytes, of the application extensions a GIF keeps.
const GIF_KEEP = ['NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012'].map(bytesOf)

/** Whether `signature` sits at `at` in `bytes`, all of it: a file that ends inside the signature does not match. */
const hasAt = (bytes, signature, at = 0) =>
  at + signature.length <= bytes.length && signature.every((v, i) => bytes[at + i] === v)

/** What goes in the place of a dropped range: `bytes`, where the dropped range starts at `at`. Never for more than one. */
const NO_PATCH = { at: NaN, bytes: new Uint8Array(0) }

/**
 * The orientation (2 to 8) that the TIFF block at b[from, to) holds in IFD0, with the byte order the block is written in:
 * { little, value }, or null for none, for a 1, and for a block that is malformed in any way. Only IFD0 is read: the next
 * IFD (the thumbnail's, whose orientation is its own) and every sub-IFD are never followed, so no pointer can loop, and
 * the first entry with the tag decides. The entries must lie inside the block.
 */
function orientationOf(b, from, to) {
  const length = to - from
  if (length < 22) return null // the header (8), a count (2) and one entry (12) at the least
  const view = new DataView(b.buffer, b.byteOffset + from, length)
  const order = view.getUint16(0)
  const little = order === 0x4949
  if (!little && order !== 0x4d4d) return null
  if (view.getUint16(2, little) !== 42) return null
  const ifd = view.getUint32(4, little)
  if (ifd < 8 || ifd + 14 > length) return null // not over the header, and with room for the count and an entry
  const count = view.getUint16(ifd, little)
  if (ifd + 2 + count * 12 > length) return null
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (view.getUint16(entry, little) !== ORIENTATION_TAG) continue
    if (view.getUint16(entry + 2, little) !== TIFF_SHORT || view.getUint32(entry + 4, little) !== 1) return null
    const value = view.getUint16(entry + 8, little) // a SHORT sits at the start of the 4 bytes of the value field
    return value >= 2 && value <= 8 ? { little, value } : null
  }
  return null
}

/** The TIFF block of an EXIF that holds the orientation and nothing else: 26 bytes, IFD0 with one entry, no next IFD. */
function orientationTiff({ little, value }) {
  const out = new Uint8Array(26)
  const view = new DataView(out.buffer)
  view.setUint16(0, little ? 0x4949 : 0x4d4d)
  view.setUint16(2, 42, little)
  view.setUint32(4, 8, little) // IFD0 follows the header
  view.setUint16(8, 1, little) // one entry
  view.setUint16(10, ORIENTATION_TAG, little)
  view.setUint16(12, TIFF_SHORT, little)
  view.setUint32(14, 1, little)
  view.setUint16(18, value, little) // the rest of the value field, and the offset of the next IFD, stay zero
  return out
}

/** The patch for an APP1 at b[pos, next) if it is an EXIF with a usable orientation, else NO_PATCH. */
function jpegPatch(b, pos, next) {
  if (!hasAt(b, EXIF_ID, pos + 4)) return NO_PATCH
  const found = orientationOf(b, pos + 4 + EXIF_ID.length, next)
  if (found === null) return NO_PATCH
  const tiff = orientationTiff(found)
  const out = new Uint8Array(4 + EXIF_ID.length + tiff.length) // the marker, the length, the identifier and the TIFF
  out.set([0xff, APP1])
  new DataView(out.buffer).setUint16(2, out.length - 2)
  out.set(EXIF_ID, 4)
  out.set(tiff, 4 + EXIF_ID.length)
  return { at: pos, bytes: out }
}

/** The patch for an EXIF chunk at b[pos, end) (end is the end of its data) if it has a usable orientation, else NO_PATCH. */
function webpPatch(b, pos, end) {
  // The chunk holds the TIFF block as it is; a writer that puts the JPEG's identifier before it is tolerated.
  const from = hasAt(b, EXIF_ID, pos + 8) ? pos + 8 + EXIF_ID.length : pos + 8
  const found = orientationOf(b, from, end)
  if (found === null) return NO_PATCH
  const tiff = orientationTiff(found)
  const out = new Uint8Array(8 + tiff.length) // the name, the size and the TIFF; its size is even, so no padding byte
  out.set(bytesOf('EXIF'))
  new DataView(out.buffer).setUint32(4, tiff.length, true)
  out.set(tiff, 8)
  return { at: pos, bytes: out }
}

/**
 * A copy of `b` up to `end` without the ranges in `drops`, a flat list of from, to, from, to... in order. Always a new
 * array: nothing the caller passed in is shared with it or changed. `patch.bytes` go where the dropped range that starts
 * at `patch.at` was.
 */
function without(b, end, drops, patch) {
  let size = end + patch.bytes.length
  for (let i = 0; i < drops.length; i += 2) size -= drops[i + 1] - drops[i]
  const out = new Uint8Array(size)
  let from = 0
  let at = 0
  for (let i = 0; i < drops.length; i += 2) {
    out.set(b.subarray(from, drops[i]), at)
    at += drops[i] - from
    if (drops[i] === patch.at) {
      out.set(patch.bytes, at)
      at += patch.bytes.length
    }
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

/**
 * Whether the segment at b[pos] of `length` with the marker `code` goes: the comment, and every APPn but APP14 (Adobe), the
 * APP0 that is a JFIF header with no thumbnail and the APP2 that holds an ICC profile. An identifier that is cut short by
 * the end of its segment does not match: the byte that follows a segment is 0xFF, which no identifier holds.
 */
function dropsJpeg(b, pos, code, length) {
  if (code === COM) return true
  if (code === APP0) return length !== JFIF_LENGTH || !hasAt(b, JFIF_ID, pos + 4)
  if (code < APP1 || code > APP15 || code === APP14) return false
  return code !== APP2 || !hasAt(b, ICC_ID, pos + 4)
}

function stripJpeg(b) {
  const n = b.length
  const view = new DataView(b.buffer, b.byteOffset, b.length)
  const drops = []
  let patch = NO_PATCH
  let scanned = false
  let pos = 2 // past the SOI
  while (pos + 1 < n) {
    if (b[pos] !== 0xff) return null
    const code = b[pos + 1]
    if (code === 0xff) {
      pos += 1 // a fill byte before a marker
      continue
    }
    if (code === 0xd9) return scanned ? without(b, pos + 2, drops, patch) : null
    // Nothing but EOI is a marker without a length here: not a stuffed zero, not TEM, not a restart, not a second SOI.
    if (code === 0x00 || code === 0x01 || (code >= 0xd0 && code <= 0xd8)) return null
    // The marker, its length, and an EOI after them at least: a segment that no EOI can follow is cut short.
    if (pos + 6 > n) return null
    const length = view.getUint16(pos + 2) // counts its own two bytes
    if (length < 2) return null
    // A segment that claims more than the file holds leaves `pos` at or past the end, and the walk ends in null.
    const next = pos + 2 + length
    if (dropsJpeg(b, pos, code, length)) {
      drops.push(pos, next)
      // The first EXIF with an orientation to keep is the one that does. It must lie inside the file, with an EOI after it.
      if (code === APP1 && patch === NO_PATCH && next + 2 <= n) patch = jpegPatch(b, pos, next)
    }
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
    if (type === IEND) return size === 0 && data ? without(b, end, drops, NO_PATCH) : null
    if (type === IDAT) data = true
    else if (!PNG_KEEP.has(type)) {
      // Off the list: an ancillary chunk (its first letter is a lowercase one) goes, and a critical one cannot go without
      // breaking the picture, so the file is not taken.
      if (type >>> 24 < LOWERCASE_A || type >>> 24 > LOWERCASE_Z) return null
      drops.push(pos, end)
    }
    pos = end // a chunk that claims more than the file holds ends the walk here, in null
  }
  return null
}

function stripWebp(b) {
  const view = new DataView(b.buffer, b.byteOffset, b.length)
  const end = view.getUint32(4, true) + 8 // the RIFF size does not count the 8 bytes before it
  if (end > b.length) return null
  const drops = []
  let patch = NO_PATCH
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
    if (!WEBP_KEEP.has(type)) {
      drops.push(pos, next)
      // Only a VP8X can announce an EXIF chunk, so only a file with one can have one written.
      if (type === WEBP_EXIF && extended && patch === NO_PATCH) patch = webpPatch(b, pos, pos + 8 + size)
    } else if (WEBP_IMAGE.has(type)) image = true
    pos = next
  }
  if (!image) return null
  const out = without(b, end, drops, patch)
  new DataView(out.buffer).setUint32(4, out.length - 8, true)
  // The flags are the first byte of the VP8X data, at 12 + 8: neither metadata flag stays, and the EXIF one is set again
  // when a chunk was written.
  if (extended) out[20] = (out[20] & ~WEBP_METADATA_FLAGS) | (patch === NO_PATCH ? 0 : WEBP_EXIF_FLAG)
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

/**
 * Whether the extension at `pos` stays: a graphic control extension, or an application extension whose first sub-block is
 * exactly the 11 bytes of the identifier of one on the list.
 */
const keepsExtension = (b, pos) =>
  b[pos + 1] === GRAPHIC_CONTROL ||
  (b[pos + 1] === APPLICATION && b[pos + 2] === GIF_KEEP[0].length && GIF_KEEP.some((id) => hasAt(b, id, pos + 3)))

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
    if (kind === 0x3b) return image ? without(b, pos + 1, drops, NO_PATCH) : null
    if (kind === 0x21) {
      if (pos + 4 > n) return null // the introducer, the label, the end of the chain and the trailer must still fit
      const next = endOfSubBlocks(b, pos + 2) // past the introducer and the label
      if (!keepsExtension(b, pos)) drops.push(pos, next)
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
