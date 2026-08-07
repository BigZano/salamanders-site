/**
 * Shared wiki-scraping helpers for the build-time bake scripts.
 *
 * Source policy: Focus/Saber publish patch notes but have never published perk
 * tables, so there is no official structured source for this data. The Fandom
 * wiki is the fallback we actually parse; scripts/check-updates.mjs watches the
 * official Steam announcement feed to tell us when that data may have gone stale.
 */
import { parse } from 'node-html-parser'

export const API = 'https://spacemarine2.fandom.com/api.php'

export const clean = (s) =>
  (s || '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** Parse a wiki page's rendered HTML into a queryable document. */
export async function fetchPage(title) {
  const url = new URL(API)
  Object.entries({
    action: 'parse',
    page: title,
    prop: 'text',
    format: 'json',
    origin: '*',
  }).forEach(([k, v]) => url.searchParams.set(k, v))

  const res = await fetch(url)
  if (!res.ok) throw new Error(`${title}: wiki responded ${res.status}`)
  const json = await res.json()
  if (json.error) throw new Error(`${title}: ${json.error.info}`)
  return parse(json.parse.text['*'])
}

/** The first <table> following the heading whose text contains `label`. */
export function tableAfter(doc, label) {
  const headings = doc.querySelectorAll('h2, h3, h4')
  const start = headings.find((h) => clean(h.text).toLowerCase().includes(label.toLowerCase()))
  if (!start) return null
  let node = start.nextElementSibling
  while (node && !/^h[234]$/i.test(node.tagName || '')) {
    if ((node.tagName || '').toLowerCase() === 'table') return node
    const nested = node.querySelector('table')
    if (nested) return nested
    node = node.nextElementSibling
  }
  return null
}

/** Rows as arrays of cleaned cell text, with the header row dropped. */
export function rowsOf(table) {
  if (!table) return []
  return table
    .querySelectorAll('tr')
    .map((tr) => tr.querySelectorAll('th, td').map((c) => clean(c.text)))
    .filter((cells) => cells.length >= 2)
    .filter((cells) => !/perk name/i.test(cells.join(' ')))
}

/**
 * Expand a table into a dense row/column grid, resolving rowspan and colspan.
 *
 * These wiki tables lean on rowspan constantly (a Quality cell spanning its
 * version rows, a Version cell spanning Hipfiring/Aiming). Reading cells
 * positionally without expanding them silently misaligns every column.
 */
export function gridOf(table) {
  if (!table) return []
  const rows = table.querySelectorAll('tr')
  const grid = []
  const carry = [] // { text, rowsLeft } per column index

  rows.forEach((tr, r) => {
    grid[r] ??= []
    const cells = tr.querySelectorAll('th, td')
    let col = 0
    const place = (text) => {
      while (grid[r][col] !== undefined) col++
      return col
    }

    // Drop in anything still spanning down from earlier rows.
    carry.forEach((c, i) => {
      if (c && c.rowsLeft > 0) {
        grid[r][i] = c.text
        c.rowsLeft--
      }
    })

    for (const cell of cells) {
      const text = clean(cell.text)
      const rowspan = parseInt(cell.getAttribute('rowspan') || '1', 10) || 1
      const colspan = parseInt(cell.getAttribute('colspan') || '1', 10) || 1
      for (let c = 0; c < colspan; c++) {
        const at = place()
        grid[r][at] = text
        if (rowspan > 1) carry[at] = { text, rowsLeft: rowspan - 1 }
        col = at + 1
      }
    }
  })

  return grid.map((row) => Array.from(row, (v) => v ?? ''))
}

/** Grid rows keyed by the header row, as objects. */
export function tableRecords(table) {
  const grid = gridOf(table)
  if (grid.length < 2) return []
  const [head, ...body] = grid
  return body.map((row) => Object.fromEntries(head.map((h, i) => [h, row[i] ?? ''])))
}

export const QUALITIES = ['Standard', 'Master-Crafted', 'Artificer', 'Relic', 'Heroic']

export const normalizeQuality = (s) => {
  const t = clean(s).toLowerCase()
  return QUALITIES.find((q) => t.includes(q.toLowerCase())) || ''
}

/** Wiki tables are rowspan-heavy; be polite between requests. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
