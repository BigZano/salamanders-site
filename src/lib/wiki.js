// Space Marine 2 wiki client — ported from the original planner's fetch/parse
// helpers. Runs client-side (uses DOMParser + fetch with anonymous CORS).
export const API = 'https://spacemarine2.fandom.com/api.php'
export const WIKI = 'https://spacemarine2.fandom.com/wiki/'

export const QUALITIES = ['Standard', 'Master-Crafted', 'Artificer', 'Relic', 'Heroic']

export const clean = (s) =>
  (s || '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim()
export const slug = (s) =>
  (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
export const normalizeQuality = (s) => {
  const t = clean(s).toLowerCase()
  return QUALITIES.find((q) => t.includes(q.toLowerCase())) || ''
}

const docFrom = (html) => new DOMParser().parseFromString(html, 'text/html')
const findHeading = (doc, label) =>
  [...doc.querySelectorAll('h2,h3,h4')].find((h) =>
    clean(h.textContent).toLowerCase().includes(label.toLowerCase()),
  )
const nextTable = (heading) => {
  let n = heading?.nextElementSibling
  while (n && !/^H[234]$/.test(n.tagName)) {
    if (n.tagName === 'TABLE') return n
    const nested = n.querySelector?.('table')
    if (nested) return nested
    n = n.nextElementSibling
  }
  return null
}

async function api(params) {
  const url = new URL(API)
  Object.entries({ ...params, format: 'json', origin: '*' }).forEach(([k, v]) =>
    url.searchParams.set(k, v),
  )
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(url.toString(), { mode: 'cors', signal: controller.signal })
    if (!res.ok) throw new Error('Wiki request failed')
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// Parse the "Perk List" table into a flat list of { name, quality, description }.
function parsePerks(doc) {
  const table = nextTable(findHeading(doc, 'Perk List'))
  if (!table) return []
  const out = []
  let quality = ''
  ;[...table.querySelectorAll('tr')].forEach((tr) => {
    const cells = [...tr.querySelectorAll(':scope > th,:scope > td')]
    if (cells.length < 2) return
    const texts = cells.map((c) => clean(c.textContent))
    if (/perk name|description/i.test(texts.join(' ')) && tr.querySelector('th')) return
    const rowQuality = normalizeQuality(texts[0])
    if (rowQuality) quality = rowQuality
    let name, description
    if (rowQuality && cells.length >= 3) {
      name = texts[1]
      description = texts.slice(2).join(' ')
    } else {
      name = texts[cells.length - 2]
      description = texts[cells.length - 1]
    }
    if (!name || !description || name === description || name.length > 100) return
    out.push({ name, quality: quality || 'Unknown', description })
  })
  return out
}

function deriveBudget(doc) {
  const h = findHeading(doc, 'In-game shown stats') || findHeading(doc, 'Versions')
  const table = nextTable(h)
  if (!table) return 10
  let rows = 0
  ;[...table.querySelectorAll('tr')].forEach((tr) => {
    if ([...tr.querySelectorAll(':scope > td')].length >= 2) rows++
  })
  return Math.max(1, Math.min(30, rows || 10))
}

function intro(doc) {
  const firstH2 = doc.querySelector('h2')
  const out = []
  let n = doc.body.firstElementChild
  while (n && n !== firstH2) {
    if (n.tagName === 'P') {
      const t = clean(n.textContent)
      if (t) out.push(t)
    }
    n = n.nextElementSibling
  }
  return out.slice(0, 3)
}

const CACHE_PREFIX = 'sal-weapon-v1:'

// Fetch a weapon's perks + budget + intro from the wiki (24h localStorage cache).
export async function fetchWeapon(name) {
  const cacheKey = CACHE_PREFIX + name
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey))
    if (c && Date.now() - c.t < 86400000) return c.d
  } catch {}

  const parsed = await api({ action: 'parse', page: name, prop: 'text' })
  const doc = docFrom(parsed.parse.text['*'])
  const perks = parsePerks(doc)
  if (!perks.length) throw new Error('No perk data found on the wiki page')
  const d = { intro: intro(doc), perks, budget: deriveBudget(doc), live: true }
  try {
    localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), d }))
  } catch {}
  return d
}
