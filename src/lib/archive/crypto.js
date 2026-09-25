/**
 * Legion Archive sealing. Runs unchanged in the browser (decrypt) and in
 * Node/Bun (seal script, tests) via WebCrypto. Layout of a sealed file:
 *   "LAR" 0x01 ‖ 12-byte nonce ‖ AES-256-GCM ciphertext ‖ 16-byte tag
 * AAD binds each file to "<format>|<logical path>" so ciphertexts can't be
 * swapped between names. See docs/superpowers/specs/2026-09-24-legion-archive-design.md.
 */
export const FORMAT_VERSION = 1
const MAGIC = Uint8Array.of(0x4c, 0x41, 0x52, FORMAT_VERSION)
const NONCE_BYTES = 12
const TAG_BYTES = 16
const MAX_PATH = 512
const KEY_B64 = /^[A-Za-z0-9+/]{43}=$/
const enc = new TextEncoder()
const subtle = () => globalThis.crypto.subtle

export class ArchiveCryptoError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ArchiveCryptoError'
    this.code = code
  }
}

function isBytes(v) {
  return v instanceof Uint8Array
}
function assertPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH) {
    throw new ArchiveCryptoError('PATH', `logical path must be a string of 1-${MAX_PATH} chars`)
  }
}
function assertBytes(v) {
  if (!isBytes(v)) throw new ArchiveCryptoError('INPUT', 'expected a Uint8Array')
}
const aad = (p) => enc.encode(`${FORMAT_VERSION}|${p}`)

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function deriveKeys(raw) {
  if (!isBytes(raw) || raw.length !== 32) throw new ArchiveCryptoError('KEY', 'archive key must be exactly 32 bytes')
  const base = await subtle().importKey('raw', raw, 'HKDF', false, ['deriveKey'])
  const hkdf = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('legion-archive'), info: enc.encode(info) })
  const encKey = await subtle().deriveKey(hkdf('enc'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const nameKey = await subtle().deriveKey(hkdf('name'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
  const kid = toHex(new Uint8Array(await subtle().digest('SHA-256', raw))).slice(0, 16)
  return { encKey, nameKey, kid }
}

export async function seal(keys, path, data) {
  assertPath(path)
  assertBytes(data)
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const ct = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(path), tagLength: 128 }, keys.encKey, data),
  )
  const out = new Uint8Array(MAGIC.length + NONCE_BYTES + ct.length)
  out.set(MAGIC, 0)
  out.set(nonce, MAGIC.length)
  out.set(ct, MAGIC.length + NONCE_BYTES)
  return out
}

export async function open(keys, path, sealed) {
  assertPath(path)
  assertBytes(sealed)
  if (sealed.length < MAGIC.length + NONCE_BYTES + TAG_BYTES) throw new ArchiveCryptoError('FORMAT', 'sealed data too short')
  for (let i = 0; i < MAGIC.length; i++) {
    if (sealed[i] !== MAGIC[i]) throw new ArchiveCryptoError('FORMAT', 'not a v1 Legion Archive file')
  }
  const nonce = sealed.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES)
  try {
    return new Uint8Array(
      await subtle().decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aad(path), tagLength: 128 },
        keys.encKey,
        sealed.subarray(MAGIC.length + NONCE_BYTES),
      ),
    )
  } catch {
    throw new ArchiveCryptoError('AUTH', 'archive file failed authentication (wrong key, wrong name, or tampered)')
  }
}

export async function opaqueName(keys, path) {
  assertPath(path)
  return toHex(new Uint8Array(await subtle().sign('HMAC', keys.nameKey, enc.encode(path)))).slice(0, 32)
}

export function keyFromBase64(s) {
  if (typeof s !== 'string' || !KEY_B64.test(s)) throw new ArchiveCryptoError('KEY', 'ARCHIVE_KEY must be 32 bytes of base64')
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

export function keyToBase64(bytes) {
  if (!isBytes(bytes) || bytes.length !== 32) throw new ArchiveCryptoError('KEY', 'archive key must be exactly 32 bytes')
  return btoa(String.fromCharCode(...bytes))
}
