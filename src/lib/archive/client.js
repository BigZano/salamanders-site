/**
 * Browser side of the Legion Archive: get the key from the role-gated API,
 * fetch + decrypt ciphertext from the static site. The key only ever lives
 * in memory (returned to the caller, never stored).
 */
import { deriveKeys, open, opaqueName, keyFromBase64 } from './crypto'

export class ArchiveAccessError extends Error {
  constructor(state, message = state) {
    super(message)
    this.name = 'ArchiveAccessError'
    this.state = state
  }
}

const MIME = { png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

export async function fetchKey({ apiBase, token, fetchImpl = fetch }) {
  if (!token) throw new ArchiveAccessError('signed-out')
  let res
  try {
    res = await fetchImpl(`${apiBase}/archive/key`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
  } catch {
    throw new ArchiveAccessError('unavailable')
  }
  if (res.status === 401) throw new ArchiveAccessError('signed-out')
  if (res.status === 403) throw new ArchiveAccessError('restricted')
  if (!res.ok) throw new ArchiveAccessError('unavailable')
  const body = await res.json().catch(() => null)
  try {
    return { raw: keyFromBase64(body?.key), kid: body?.kid }
  } catch {
    throw new ArchiveAccessError('unavailable')
  }
}

/** A sealed file's URL, versioned by release so a new release never reads a cached old file. */
const sealedUrl = (assetBase, name, version) => `${assetBase}${name}.bin${version ? `?v=${encodeURIComponent(version)}` : ''}`

async function fetchBytes(url, fetchImpl) {
  const res = await fetchImpl(url)
  if (!res.ok) throw new ArchiveAccessError('outdated', `missing ${url}`)
  return new Uint8Array(await res.arrayBuffer())
}

export async function loadArchive({ apiBase, token, expectedKid, assetBase, version = null, fetchImpl = fetch }) {
  if (!expectedKid) throw new ArchiveAccessError('unpublished')
  const { raw, kid } = await fetchKey({ apiBase, token, fetchImpl })
  const keys = await deriveKeys(raw)
  if (kid !== expectedKid || keys.kid !== expectedKid) throw new ArchiveAccessError('outdated')
  let bytes
  try {
    bytes = await fetchBytes(sealedUrl(assetBase, await opaqueName(keys, 'index'), version), fetchImpl)
  } catch (e) {
    throw e instanceof ArchiveAccessError ? e : new ArchiveAccessError('unavailable')
  }
  let index
  try {
    index = JSON.parse(new TextDecoder().decode(await open(keys, 'index', bytes)))
  } catch {
    throw new ArchiveAccessError('integrity')
  }
  if (index?.kid !== keys.kid || index?.format !== 1) throw new ArchiveAccessError('integrity')
  return { keys, index }
}

export async function loadAssetBlob({ keys, assetBase, logicalPath, version = null, fetchImpl = fetch }) {
  const bytes = await fetchBytes(sealedUrl(assetBase, await opaqueName(keys, logicalPath), version), fetchImpl)
  const plain = await open(keys, logicalPath, bytes)
  const ext = logicalPath.split('.').pop().toLowerCase()
  return new Blob([plain], { type: MIME[ext] ?? 'application/octet-stream' })
}
