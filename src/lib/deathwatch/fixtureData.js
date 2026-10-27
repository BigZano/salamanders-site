/**
 * Stand-in for GET /deathwatch/data in fixture mode (see fixture.js): one running event and one archived tour,
 * so every Event Tracker view and the Manage pages have something to show without the server; ?scene=empty shows
 * none at all. Every name here is invented. Built from a seed, so the numbers are the same on every load.
 */
import { CLASSES, COMPANIES, WEIGHTS, archiveDoc } from './tracker'

const TEAMS = [
  ['Ember Wardens', ['Brother Ashkar', 'Brother Velun', 'Brother Toma']],
  ['Obsidian Pyre', ['Brother Hadrix', 'Brother Senn', 'Brother Ruel']],
  ['Drake Hollow', ['Brother Cassar', 'Brother Idro', 'Brother Faen']],
  ['Cinder Oath', ['Brother Marek', 'Brother Ostin', 'Brother Lyse']],
  ['Ashen Vigil', ['Brother Teodor', 'Brother Quill', 'Brother Banu']],
]

function rng(seed) {
  let s = seed
  return (n) => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s % n
  }
}

function team(id, [n, ro], weeks, r) {
  const m = []
  for (let w = 1; w <= weeks; w++) {
    for (let o = 1; o <= 4; o++) {
      if (r(9) === 0) continue // a slot not entered yet
      const played = o === 4 ? r(3) > 0 : 1
      const gs = r(3) === 0 ? 0 : 1
      const rows = ro.map((p, i) => [p, CLASSES[(id + i + w) % CLASSES.length], gs && i === r(3) ? 1 : 0, 80 + r(160), r(12), 2000 + r(9000), 3000 + r(12000), r(6), 1500 + r(5000), r(3), r(4)])
      m.push([w, o, played ? 1 : 0, 900 + r(600), gs, r(4), Math.min(r(4), 3 - gs), ['A', 'B', '', ''][r(4)], played ? rows : []])
    }
  }
  return { id, n, co: COMPANIES[(id - 1) % COMPANIES.length], ro, ki: id === 4 ? [ro[2]] : [], kw: id === 4 ? { [ro[2]]: 2 } : {}, m }
}

/** The data for a dev scene: nothing at all for `empty`, else the running event and its archive. */
export function fixtureData(scene) {
  if (scene === 'empty') return { teams: {}, cfg: {}, archive: {} }
  const r = rng(18)
  const live = Object.fromEntries(TEAMS.map((t, i) => [String(i + 1), team(i + 1, t, 3, r)]))
  const old = TEAMS.slice(0, 4).map((t, i) => team(i + 1, t, 4, r))
  return {
    teams: live,
    cfg: {
      s: {},
      // The Hall of Relics' Notable Members (notables.js), with invented members as everything here.
      tx: {
        cur_n: 'Deathwatch Tour — Ember Moon',
        nm_i: '*Within the obsidian halls of the fortress, the names of its greatest warriors are forever remembered.*',
        nm_ck: 'Watch Commander of Ebonhold · Sworn in at the Ember Moon',
        nm_c: [
          'Watch Commander Varn Hollis',
          '**Known for:** a proud warrior of the **1st Company**, first onto every drop.',
          '',
          'A warrior of few words, he believes that deeds speak louder than any oath.',
        ].join('\n'),
        nm_hi: '*The names of those who once held command over Ebonhold remain etched within its archives.*',
        nm_h: [
          '## Watch Commanders',
          '- **Watch Commander Varn Hollis:** Ember Moon — *present*',
          '- **Watch Commander Teme Sarr:** ||*Records of appointment lost to the archives*|| — Ember Moon',
          '## Watch Captains',
          '- **Watch Captain Ilo Brask:** Ash Season — Ember Moon',
        ].join('\n'),
        nm_vi: '*Before the fortress stood as a bastion, these warriors forged the foundations of the brotherhood.*',
        nm_vk: 'Former Watch Command',
        nm_v: [
          'Watch Captain Ilo Brask — The Unyielding Brother',
          'A veteran whose command was forged in the fires of war, never one to lead from safety.',
          '',
          'Reclusiarch Teme Sarr — Keeper of the Flame',
          'Kept the rites and the courage of the Watch through the longest tours.',
          '',
          'Watch Captain Quell — ///Classified/// [sealed]',
          'What he did on the Ember Moon stays sealed.',
        ].join('\n'),
        nm_e: '*Not every warrior is worthy of the Long Vigil.*\n\n**ONLY THE ELITE CAN SLAY THE ELITE.**\n\n**SUFFER NOT THE ALIEN TO LIVE!**',
      },
    },
    archive: { e1: archiveDoc(Object.fromEntries(old.map((t) => [t.id, t])), WEIGHTS, 'Deathwatch Tour — Ash Season', new Date('2026-05-30T18:00:00Z')) },
  }
}
