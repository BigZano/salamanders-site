// The Deathwatch area's route table: the six areas, their tabs, and how a URL resolves to them.
// Slugs and labels are the old Watch Fortress site's, verbatim, so its URLs keep their shape beneath
// /deathwatch. Pure, so the router, the hub and the navigation share one source and it can be tested hard.

const tab = (slug, label) => ({ slug, label })

export const AREAS = {
  eventtracker: {
    label: 'Event Tracker',
    blurb: 'Track events, standings, and your kill team’s progress.',
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
    blurb: 'Explore armour sets, chapter colours, and heraldry.',
    // `items`: a tab's uniforms, in the picker's order (armour.test.js keeps them in step with armour.js), so the
    // address always names the one shown.
    tabs: [
      { slug: 'standard', label: 'Standard', items: ['watchbrother', 'companyheraldry'] },
      { slug: 'specialist', label: 'Specialist', items: ['reclusiarc', 'librarium', 'apothecarion', 'mechanicus'] },
      // Only Deathwatch Command (and the Watch Commander) see this tab (DeathwatchNav, DeathwatchArea).
      { slug: 'watch-command', label: 'Watch Command', command: true, items: ['watchsergeant', 'watchchaplain', 'watchlibrarian', 'watchapothecary', 'watchtechmarine'] },
      tab('restricted-wargear', 'Restricted Wargear'),
    ],
  },
  chronicles: {
    label: 'Chronicles of Valor',
    blurb: 'Discover the deeds, victories, and honours of the Watch.',
    tabs: [
      tab('hall-of-champions', 'Hall of Champions'),
      tab('chamber-of-honor', 'Chamber of Honor'),
      tab('player-profiles', 'Player Profiles'),
      tab('in-memoriam', 'In Memoriam'),
      tab('operational-records', 'Operational Records'),
    ],
  },
  // The old site's Hall of Relics, at its old address. The Relics are still to come.
  hallofrelics: {
    label: 'Hall of Relics',
    blurb: 'Honour the warriors who shaped the history of Ebonhold.',
    tabs: [tab('notable-members', 'Notable Members'), tab('fortress-lore', 'Fortress Lore')],
  },
  // The old site's Recruitment, at its old address: the hub's Enlist button goes here.
  recruitment: {
    label: 'Recruitment',
    blurb: 'Terms of Service and requirements for the Watch',
    tabs: [tab('terms-of-service', 'Terms of Service'), tab('requirements', 'Requirements')],
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

/**
 * Resolves router params ({ area, tab, sub }) to the page they name, or null for an unknown area.
 * An unknown or missing tab falls back to the area's first. A sub-slug survives only if it is one of the tab's
 * items (an Armouring Hall uniform); anything else becomes the tab's first item, or nothing on a tab with none.
 * `canonical` is the one path for that page. Params come from the URL, so nothing here trusts their type or
 * indexes an object with them.
 */
export function resolveArea(params) {
  const { area, tab: wanted, sub } = params ?? {}
  if (typeof area !== 'string' || !Object.hasOwn(AREAS, area)) return null
  const { tabs } = AREAS[area]
  const { slug, items = [] } = tabs.find((t) => t.slug === wanted) ?? tabs[0]
  const item = items.includes(sub) ? sub : (items[0] ?? '')
  return { area, tab: slug, sub: item, canonical: `/deathwatch/${area}/${slug}${item ? `/${item}` : ''}` }
}
