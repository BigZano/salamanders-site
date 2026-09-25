// discordAuth deliberately drops the URL hash across sign-in (see its
// tests). The archive keeps exactly one validated message anchor itself.
const KEY = 'salamanders-archive-anchor'
const ANCHOR = /^#m-\d{17,20}$/

export function stashAnchor(hash) {
  if (ANCHOR.test(hash)) sessionStorage.setItem(KEY, hash)
  else sessionStorage.removeItem(KEY)
}
export function takeAnchor() {
  const v = sessionStorage.getItem(KEY)
  sessionStorage.removeItem(KEY)
  return v && ANCHOR.test(v) ? v : null
}
