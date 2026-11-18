/**
 * How the Librarius's write routes read a request's body: never more than a limit, counted as it arrives.
 *
 * readBounded(request, maxBytes) → { bytes } | { tooLarge: true }. The body is read from the stream and counted, and a
 * body that goes past `maxBytes` is cancelled at once and never held: a client that sends a gigabyte holds the API for
 * `maxBytes`, not for a gigabyte. A Content-Length over the limit is refused without reading anything; one that is smaller
 * than the body, or no number at all, is not believed, since the count is what counts. A request with no body has no bytes.
 *
 * readJsonWithin(request, { maxBytes, tooLarge }) → { body, blank } | { status, error }: as httpReply.js readJson, which it
 * stands in for where the limit is a byte count taken before the body is held (that one reads all of it first). 415 for any
 * type but application/json, 413 with `tooLarge` for more than `maxBytes` bytes. `body` is undefined for text that is not
 * JSON, and `blank` says there was no text at all. Text that is not UTF-8 reads with the replacement character.
 *
 * readPicture(request) → { bytes } | { status, error }: the one file of a multipart/form-data upload. 415 for any other type,
 * 413 for a body past MAX_PICTURE_BYTES and the form around it (FORM_SLACK), or a file past MAX_PICTURE_BYTES, 400 for a form
 * that cannot be read, that is empty, that has anything but exactly one part, that is a text and not a file, or whose file
 * is empty. The file's name and declared type are never looked at, or returned: the bytes alone are judged
 * (librariusUploads.js), and the picture is stored under a name of the Librarius's own.
 */
import { mediaType } from './httpReply.js'

export const MAX_PICTURE_BYTES = 10 * 1024 * 1024
export const FORM_SLACK = 65_536

const COPY = {
  json: 'Send JSON (Content-Type: application/json).',
  type: 'Send the picture as multipart/form-data.',
  large: 'That picture is over 10 MB.',
  form: 'That form could not be read.',
  one: 'Send one picture at a time.',
  empty: 'That file is empty.',
}

export async function readBounded(request, maxBytes) {
  // A missing, empty or odd length is no word about the size: Number('') is 0, and the others are NaN or negative.
  if (Number(request.headers.get('Content-Length')) > maxBytes) return { tooLarge: true }
  if (request.body === null) return { bytes: new Uint8Array(0) }
  const reader = request.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return { tooLarge: true }
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return { bytes }
}

export async function readJsonWithin(request, { maxBytes, tooLarge }) {
  if (mediaType(request) !== 'application/json') return { status: 415, error: COPY.json }
  const read = await readBounded(request, maxBytes)
  if (read.tooLarge) return { status: 413, error: tooLarge }
  const text = new TextDecoder().decode(read.bytes)
  let body
  try {
    body = JSON.parse(text)
  } catch {
    // left undefined
  }
  return { body, blank: text.trim() === '' }
}

export async function readPicture(request) {
  if (mediaType(request) !== 'multipart/form-data') return { status: 415, error: COPY.type }
  const read = await readBounded(request, MAX_PICTURE_BYTES + FORM_SLACK)
  if (read.tooLarge) return { status: 413, error: COPY.large }
  let parts
  try {
    // The runtime reads the form from the bytes already held, so nothing more than the limit is ever in memory.
    const form = await new Response(read.bytes, { headers: { 'Content-Type': request.headers.get('Content-Type') } }).formData()
    parts = [...form.values()]
  } catch {
    return { status: 400, error: COPY.form }
  }
  if (parts.length !== 1 || typeof parts[0] === 'string') return { status: 400, error: COPY.one }
  const [file] = parts
  if (file.size === 0) return { status: 400, error: COPY.empty }
  if (file.size > MAX_PICTURE_BYTES) return { status: 413, error: COPY.large }
  return { bytes: new Uint8Array(await file.arrayBuffer()) }
}
