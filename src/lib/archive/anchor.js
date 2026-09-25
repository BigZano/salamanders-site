// discordAuth deliberately drops the URL hash across sign-in (see its
// tests). The archive keeps exactly one validated message anchor itself,
// bound to the page it came from so it can never land on another thread.
const KEY = 'salamanders-archive-anchor'
const ANCHOR = /^#m-\d{17,20}$/
const ARCHIVE_PATH = /^\/(accolades|ranks)(\/\d{17,20})?$/

export function stashAnchor(path, hash) {
  if (ARCHIVE_PATH.test(path) && ANCHOR.test(hash)) sessionStorage.setItem(KEY, JSON.stringify({ path, hash }))
  else sessionStorage.removeItem(KEY)
}

export function takeAnchor(path) {
  const raw = sessionStorage.getItem(KEY)
  sessionStorage.removeItem(KEY)
  let v = null
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  return v?.path === path && ANCHOR.test(v?.hash) ? v.hash : null
}

export function clearAnchor() {
  sessionStorage.removeItem(KEY)
}
