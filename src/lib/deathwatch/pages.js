// Where a Deathwatch view lives: one file per view, src/views/deathwatch/pages/<area>/<tab>.vue, named by the
// slugs in areas.js. A port (or the Watch Commander's pull request) replaces a view by replacing its file, and
// nothing shared has to change. Each is its own lazy chunk.
const pages = import.meta.glob('../../views/deathwatch/pages/*/*.vue')

/**
 * The lazy loader of the view for an area and a tab, or null when there is none. The slugs come from the URL, so
 * they are only used as one exact key into the files found above: nothing else can name a file, and nothing on
 * Object.prototype can answer.
 */
export function pageLoader(area, tab) {
  if (typeof area !== 'string' || typeof tab !== 'string') return null
  const key = `../../views/deathwatch/pages/${area}/${tab}.vue`
  return Object.hasOwn(pages, key) ? pages[key] : null
}
