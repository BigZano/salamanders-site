// The Deathwatch area's route table: the four areas, their tabs, and how a URL resolves to them.
// Slugs and labels are the old Watch Fortress site's, verbatim, so its URLs keep their shape beneath
// /deathwatch. Pure, so the router, the hub and the navigation share one source and it can be tested hard.

const tab = (slug, label) => ({ slug, label })

export const AREAS = {
  eventtracker: {
    label: 'Event Tracker',
    blurb: 'Standings, Kill Teams, players and honours',
    tabs: [
      tab('standings', 'Standings'),
      tab('kill-teams', 'Kill Teams'),
      tab('players', 'Players'),
      tab('honour-roll', 'Honour Roll'),
      tab('game-stats', 'Game Stats'),
      tab('scoring', 'Scoring'),
      tab('archive', 'Archive'),
    ],
  },
  armouringhall: {
    label: 'Armouring Hall',
    blurb: 'Specialist armour, standard uniform and heraldry',
    tabs: [tab('standard', 'Standard'), tab('specialist', 'Specialist'), tab('watch-command', 'Watch Command')],
  },
  chronicles: {
    label: 'Chronicles of Valor',
    blurb: 'Deeds and honours of the Watch Fortress',
    tabs: [
      tab('hall-of-champions', 'Hall of Champions'),
      tab('chamber-of-honor', 'Chamber of Honor'),
      tab('player-profiles', 'Player Profiles'),
      tab('in-memoriam', 'In Memoriam'),
      tab('operational-records', 'Operational Records'),
    ],
  },
  manage: {
    label: 'Manage',
    blurb: "The Watch Commander's dashboard",
    tabs: [
      tab('enter-mission', 'Enter mission'),
      tab('manage', 'Manage'),
      tab('checks', 'Checks'),
      tab('records', 'Records'),
      tab('page-texts', 'Page Texts'),
    ],
  },
}

// An Armouring Hall page names one item, e.g. /armouringhall/standard/<item>: lowercase letters and digits
// only, which is what the old site's slugs were reduced to.
const SUB = /^[a-z0-9]{1,40}$/

/**
 * Resolves router params ({ area, tab, sub }) to the page they name, or null for an unknown area.
 * An unknown or missing tab falls back to the area's first; a sub-slug survives only on the Armouring
 * Hall and only if it is well formed. `canonical` is the one path for that page. Params come from the
 * URL, so nothing here trusts their type or indexes an object with them.
 */
export function resolveArea(params) {
  const { area, tab: wanted, sub } = params ?? {}
  if (typeof area !== 'string' || !Object.hasOwn(AREAS, area)) return null
  const { tabs } = AREAS[area]
  const slug = (tabs.find((t) => t.slug === wanted) ?? tabs[0]).slug
  const item = area === 'armouringhall' && typeof sub === 'string' && SUB.test(sub) ? sub : ''
  return { area, tab: slug, sub: item, canonical: `/deathwatch/${area}/${slug}${item ? `/${item}` : ''}` }
}
