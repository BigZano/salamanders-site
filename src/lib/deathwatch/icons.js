// The navigation icons of the original Watch Fortress site, one per view (24 x 24, stroked), plus `menu` for the
// way back to the hub. The shapes are data (icons.json), drawn by <svg> with v-for: this area never renders raw markup.
import icons from './icons.json'

/** The shapes of a view's icon as [tag, attributes] pairs, or [] for a slug that has none. */
export function iconFor(slug) {
  return typeof slug === 'string' && Object.hasOwn(icons, slug) ? icons[slug] : []
}
