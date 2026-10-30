// The Armouring Hall's uniforms, ported from the old Watch Fortress site (STD, SPECS, WCS and PAINT in app.js).
// Each uniform has a full-figure picture (img), a sprite of part tiles (spr, 11 tiles of 160 × 234), an icon,
// and its parts in two columns (L, R). A part is [title, [[role, paint]], notes, tiles, [x, y] hotspot in %].
// Hotspots were measured on a close framing; `hm` maps them onto the full-body picture.
import apothecarion from '../../components/deathwatch/img/armour/spec-apothecarion.jpg'
import apothecarionParts from '../../components/deathwatch/img/armour/spec-apothecarion-parts.jpg'
import librarium from '../../components/deathwatch/img/armour/spec-librarium.jpg'
import librariumParts from '../../components/deathwatch/img/armour/spec-librarium-parts.jpg'
import mechanicus from '../../components/deathwatch/img/armour/spec-mechanicus.jpg'
import mechanicusParts from '../../components/deathwatch/img/armour/spec-mechanicus-parts.jpg'
import reclusiarc from '../../components/deathwatch/img/armour/spec-reclusiarc.jpg'
import reclusiarcParts from '../../components/deathwatch/img/armour/spec-reclusiarc-parts.jpg'
import brother from '../../components/deathwatch/img/armour/spec-battlebrother.jpg'
import brotherParts from '../../components/deathwatch/img/armour/spec-battlebrother-parts.jpg'
import sergeant from '../../components/deathwatch/img/armour/wc-sergeant.jpg'
import sergeantParts from '../../components/deathwatch/img/armour/wc-sergeant-parts.jpg'
import apothecary from '../../components/deathwatch/img/armour/wc-apothecary.jpg'
import apothecaryParts from '../../components/deathwatch/img/armour/wc-apothecary-parts.jpg'
import librarian from '../../components/deathwatch/img/armour/wc-librarian.jpg'
import librarianParts from '../../components/deathwatch/img/armour/wc-librarian-parts.jpg'
import chaplain from '../../components/deathwatch/img/armour/wc-chaplain.jpg'
import chaplainParts from '../../components/deathwatch/img/armour/wc-chaplain-parts.jpg'
import techmarine from '../../components/deathwatch/img/armour/wc-techmarine.jpg'
import techmarineParts from '../../components/deathwatch/img/armour/wc-techmarine-parts.jpg'
import heraldryParts from '../../components/deathwatch/img/armour/heraldry-parts.jpg'
import icoApothecarion from '../../components/deathwatch/img/armour/ico-apothecarion.png'
import icoLibrarium from '../../components/deathwatch/img/armour/ico-librarium.png'
import icoMechanicus from '../../components/deathwatch/img/armour/ico-mechanicus.png'
import icoReclusiarc from '../../components/deathwatch/img/armour/ico-reclusiarc.png'
import icoBrother from '../../components/deathwatch/img/armour/ico-battlebrother.png'
import icoHeraldry from '../../components/deathwatch/img/armour/ico-heraldry.png'
import icoCommand from '../../components/deathwatch/img/armour/ico-watchcommand.webp'

/** The paints of the in-game Heraldry Editor, as swatch colours. */
export const PAINT = {
  'White Scar': '#f2f2ef',
  'Abaddon Black': '#1d1d1f',
  'Liberator Gold': '#c39a4b',
  'Mephiston Red': '#9a1115',
  Red: '#c8232c',
  'Alaitoc Blue': '#2f5597',
  Wraithbone: '#dbd1b2',
  Silver: '#b9bec4',
  'Averland Sunset': '#e3a92e',
  'Khorne Red': '#b3141b',
  'Warpstone Glow': '#1f7a34',
}

const HM = [0.909, 3.9, 0.91, 4.54]
const PAUL = ['Pauldrons', [], ['Left: the Deathwatch Pauldron.', 'Right: the color scheme of your Company of origin (see Company Heraldry).'], [1, 2], [13, 20]]
const WAR = ['Wargear', [], ['///CLASSIFIED///'], [3, 4], [47, 43]]
const RG = 'Right: Watch Company Marking, depending on your Watch Company.'
const helm = (a, b, t = 'Liberator Gold', lens = 'Mephiston Red') => ['Helm', [['Primary', a], ['Secondary', b], ['Tertiary', t], ['Lenses', lens]], ['Pattern: Mask Pattern.'], [0], [50, 7]]
const chest = (bp, t = 'Liberator Gold') => ['Breastplate', [['Chest primary', 'Abaddon Black'], ['Chest tertiary', t], ['Backpack primary', bp]], [], [5, 6], [47, 20]]
const hand = (c) => ['Gauntlets', [['Right primary', c], ['Right secondary', c]], ['Left: the Deathwatch Gauntlet.'], [7, 8], [7, 50]]
const greave = (rows, left) => ['Greaves', rows, [left, RG], [9, 10], [74, 69]]

// A specialist's armour: the helm and gauntlet in its own colour (wear), the backpack in its role colour (pack), the
// helm's tertiary Silver and its lenses Mephiston Red unless it says otherwise (tert, lens).
const specialist = ({ name, who, img, spr, ico, t, wear, pack, greaves, left, tert = 'Silver', lens }) => ({
  name,
  who,
  img,
  spr,
  ico,
  t,
  hm: HM,
  L: [helm(wear, 'Abaddon Black', tert, lens), PAUL, WAR],
  R: [chest(pack, 'Silver'), hand(wear), greave(greaves, left)],
})

export const SPECIALIST = [
  specialist({
    name: 'Reclusiarc',
    who: 'Chaplains and higher-ranking members of the Reclusiarc',
    img: reclusiarc,
    spr: reclusiarcParts,
    ico: icoReclusiarc,
    t: ['#ffe9a8', '#d6b05c', '#7a5317'],
    wear: 'Wraithbone',
    tert: 'Liberator Gold',
    pack: 'Abaddon Black',
    greaves: [['Veteran Icon primary', 'Abaddon Black'], ['Veteran Icon secondary', 'Wraithbone'], ['Veteran Icon tertiary', 'Wraithbone']],
    left: 'Left: the Veteran Icon (plain pattern), skull and laurel in Wraithbone on Abaddon Black.',
  }),
  specialist({
    name: 'Librarium',
    who: 'Librarians and higher-ranking members of the Librarium',
    img: librarium,
    spr: librariumParts,
    ico: icoLibrarium,
    t: ['#a9c4ff', '#4f78d6', '#1c3477'],
    wear: 'Alaitoc Blue',
    tert: 'Liberator Gold',
    pack: 'Alaitoc Blue',
    greaves: [['Veteran Icon primary', 'Alaitoc Blue'], ['Veteran Icon secondary', 'Averland Sunset'], ['Veteran Icon tertiary', 'Averland Sunset']],
    left: 'Left: the Veteran Icon (plain pattern), skull and laurel in Averland Sunset on Alaitoc Blue.',
  }),
  specialist({
    name: 'Apothecarion',
    who: 'Apothecaries and higher-ranking members of the Apothecarion',
    img: apothecarion,
    spr: apothecarionParts,
    ico: icoApothecarion,
    t: ['#ffffff', '#ecebe6', '#a9aca6'],
    wear: 'White Scar',
    tert: 'Liberator Gold',
    pack: 'White Scar',
    greaves: [['Fire Support Marking primary', 'White Scar'], ['Fire Support Marking secondary', 'Red']],
    left: 'Left: the Fire Support Marking (plain pattern), a red chevron on White Scar.',
  }),
  specialist({
    name: 'Mechanicus',
    who: 'Techmarines and higher-ranking members of the Mechanicus',
    img: mechanicus,
    spr: mechanicusParts,
    ico: icoMechanicus,
    t: ['#ff6a4f', '#d4342c', '#7d0f0c'],
    wear: 'Red',
    tert: 'Liberator Gold',
    pack: 'Red',
    lens: 'Liberator Gold',
    greaves: [['Blank Knee Decal', 'Red']],
    left: 'Left: the Blank Knee Decal (plain pattern) in Red.',
  }),
]

export const STANDARD = [
  {
    name: 'Watch Brother',
    img: brother,
    spr: brotherParts,
    ico: icoBrother,
    t: ['#e2ffd2', '#8fe068', '#2e6b1d'],
    hm: HM,
    L: [
      ['Helm', [['Primary', 'Abaddon Black'], ['Tertiary', 'Silver'], ['Lenses', 'Mephiston Red']], ['Pattern: Mask Pattern.'], [0], [50, 7]],
      ['Pauldrons', [], ['Right: the color scheme of your Company of origin (see Company Heraldry).', 'Left: the Deathwatch Pauldron.'], [1, 2], [13, 20]],
      WAR,
    ],
    R: [
      ['Breastplate', [['Chest primary', 'Abaddon Black'], ['Chest tertiary', 'Silver'], ['Backpack primary', 'Abaddon Black']], [], [5, 6], [47, 20]],
      ['Gauntlets', [['Right primary', 'Abaddon Black']], ['Left: the Deathwatch Gauntlet.'], [7, 8], [7, 50]],
      [
        'Greaves',
        [['Primary', 'Abaddon Black'], ['Right secondary', 'Warpstone Glow']],
        [
          'Right: Greaves Pattern, Warpstone Glow flames on Abaddon Black.',
          'Both greave icon slots follow your company scheme or your specialist role (see Company Heraldry).',
        ],
        [9, 10],
        [74, 69],
      ],
    ],
  },
  { name: 'Company Heraldry', heraldry: true, img: brother, spr: heraldryParts, ico: icoHeraldry, t: ['#e2ffd2', '#8fe068', '#2e6b1d'] },
]

const SERGEANT = {
  name: 'Watch Sergeant',
  command: true,
  who: 'Watch Sergeants',
  img: sergeant,
  spr: sergeantParts,
  ico: icoCommand,
  t: ['#fff1c4', '#d8b25a', '#7a5317'],
  hm: HM,
  // From the in-game Heraldry Editor (screenshots of 19 Oct 2026; the helm and the greaves of 30 Oct 2026).
  // shortcut: the helm's lenses keep the 19 Oct name; the 30 Oct screenshots do not name them.
  L: [
    [
      'Helm',
      [['Primary', 'Khorne Red'], ['Secondary', 'White Scar'], ['Tertiary', 'Liberator Gold'], ['Lenses', 'Liberator Gold']],
      ['Pattern: Mask Pattern.'],
      [0],
      [50, 7],
    ],
    PAUL,
    WAR,
  ],
  R: [
    chest('Abaddon Black', 'Liberator Gold'),
    hand('Abaddon Black'),
    [
      'Greaves',
      [
        ['Right primary', 'Abaddon Black'],
        ['Right secondary', 'Averland Sunset'],
        ['Veteran Icon primary', 'Khorne Red'],
        ['Veteran Icon secondary', 'White Scar'],
        ['Veteran Icon tertiary', 'Warpstone Glow'],
      ],
      [
        'Right: Greaves Pattern, Averland Sunset flames on Abaddon Black; the knee carries your Watch Company Marking (see Company Heraldry).',
        'Left: the Veteran Icon on the knee (plain pattern), a White Scar skull on Khorne Red, ringed in Warpstone Glow.',
      ],
      [9, 10],
      [27, 69],
    ],
  ],
}
// The Watch Command specialists wear the Sergeant's armour with their role's helm (screenshots of 31 Oct 2026), over
// their Specialist uniform (`onSpecialist`, the slug of the Specialist page the introduction links). The screenshots
// have one Wargear tile; the sprite's tile 4 is the Sergeant's and unused.
// shortcut: the paint names are read off the swatches (the screenshots do not name them), matched to the Sergeant's.
// The backpack and the right gauntlet wear the colours of the specialist's own Specialist uniform.
const watchSpecialist = ({ name, who, onSpecialist, img, spr, ico, t, primary, secondary = 'Khorne Red' }) => {
  const own = `in the colours of your [Specialist Uniform](/deathwatch/armouringhall/specialist/${onSpecialist}).`
  return {
    ...SERGEANT,
    name,
    who,
    onSpecialist,
    img,
    spr,
    ico,
    t,
    L: [helm(primary, secondary, 'Liberator Gold', 'Liberator Gold'), PAUL, ['Wargear', [], ['///CLASSIFIED///'], [3], [47, 43]]],
    R: [
      ['Breastplate', [['Chest primary', 'Abaddon Black'], ['Chest tertiary', 'Liberator Gold']], [`Backpack: ${own}`], [5, 6], [47, 20]],
      ['Gauntlets', [], [`Right: ${own}`, 'Left: the Deathwatch Gauntlet.'], [7, 8], [7, 50]],
      SERGEANT.R[2],
    ],
  }
}
const APOTHECARY = watchSpecialist({
  name: 'Watch Apothecary',
  who: 'Watch Apothecaries',
  onSpecialist: 'apothecarion',
  img: apothecary,
  spr: apothecaryParts,
  ico: icoApothecarion,
  t: ['#ffffff', '#ecebe6', '#a9aca6'],
  primary: 'White Scar',
})
const LIBRARIAN = watchSpecialist({
  name: 'Watch Librarian',
  who: 'Watch Librarians',
  onSpecialist: 'librarium',
  img: librarian,
  spr: librarianParts,
  ico: icoLibrarium,
  t: ['#a9c4ff', '#4f78d6', '#1c3477'],
  primary: 'Alaitoc Blue',
})
const CHAPLAIN = watchSpecialist({
  name: 'Watch Chaplain',
  who: 'Watch Chaplains',
  onSpecialist: 'reclusiarc',
  img: chaplain,
  spr: chaplainParts,
  ico: icoReclusiarc,
  t: ['#ffe9a8', '#d6b05c', '#7a5317'],
  primary: 'Wraithbone',
})
const TECHMARINE = watchSpecialist({
  name: 'Watch Techmarine',
  who: 'Watch Techmarines',
  onSpecialist: 'mechanicus',
  img: techmarine,
  spr: techmarineParts,
  ico: icoMechanicus,
  t: ['#ff6a4f', '#d4342c', '#7d0f0c'],
  primary: 'Red',
  secondary: 'White Scar',
})
export const WATCH_COMMAND = [SERGEANT, CHAPLAIN, LIBRARIAN, APOTHECARY, TECHMARINE]

/** The uniforms of each Armouring Hall tab. */
export const UNIFORMS = { standard: STANDARD, specialist: SPECIALIST, 'watch-command': WATCH_COMMAND }

/** A uniform's address segment, as the old site made it: its name in lowercase letters and digits. */
export const itemSlug = (u) => u.name.toLowerCase().replace(/[^a-z0-9]/g, '')

/** The uniform a tab's item slug names, or the tab's first. */
export function uniformFor(tab, sub) {
  const list = Object.hasOwn(UNIFORMS, tab) ? UNIFORMS[tab] : []
  return list.find((u) => itemSlug(u) === sub) ?? list[0]
}

/** A part's hotspot on the picture, in %: mapped through `hm` when the picture is a full figure. */
export const hotspot = (u, [x, y]) => (u.hm ? [u.hm[0] * x + u.hm[1], u.hm[2] * y + u.hm[3]] : [x, y])

/** A note split into its lead word and text ("Left: …" → ['Left', '…']), or null for a plain note. */
export function noteParts(n) {
  const m = n.match(/^(Left|Right|Pattern|Backpack|Both[^:]*):\s*(.*)$/)
  return m ? [m[1], m[2]] : null
}
