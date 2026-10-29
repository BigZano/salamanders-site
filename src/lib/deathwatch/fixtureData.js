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
      // The Hall of Relics' Notable Members (notables.js): the old site's texts and links, every member's name invented.
      tx: {
        cur_n: 'Deathwatch Tour — Ember Moon',
        nm_i: "*Within the obsidian halls of Watch Fortress Ebonhold, the names of its greatest warriors are forever remembered. Through countless battles against Hive Fleet Leviathan, these brothers have proven their devotion to the Long Vigil and the defense of Nocturne.*",
        nm_ck: "Watch Commander of Ebonhold · Sworn in October 6th, 2026",
        nm_c: "Watch Commander Varn Hollis\n**Known for:** Hailing from the ancient Germanic lands of Holy Terra, Watch Commander Varn Hollis stands as a proud warrior of the **1st Company, the Firedrakes**.\n\nA warrior of few words, Varn Hollis believes that deeds speak louder than any oath. Whether leading his brothers into battle, answering the call of fortress-wide operations, or pursuing honors upon the battlefield, his presence remains steadfast.\n\nThough reserved in nature, he values the brotherhood forged through battle and stands ready whenever duty calls.\n\nBeyond the battlefield, ancient fortress records speak of his unusual assignment within the 🍎 *CSI Division of Imperial Ration Inspection*. The details of this sacred duty remain classified by order of the Watch Commander.",
        nm_hi: "*The names of those who once held command over Ebonhold remain etched within the fortress's eternal archives.*",
        nm_h: "## Watch Commanders\n- **Watch Commander Varn Hollis:** [October 6th, 2026](https://discord.com/channels/1322056087792521269/1322056090099122259/1557022632359239701) — *present*\n- **Watch Commander Kael Torrin:** [December 9th, 2025](https://discord.com/channels/1322056087792521269/1322056089037967392/1447780703348457512) — [October 6th, 2026](https://discord.com/channels/1322056087792521269/1322056090099122259/1557022632359239701)\n- **Watch Commander Orrin Vael:** *Records of appointment lost to the archives* — [December 9th, 2025](https://discord.com/channels/1322056087792521269/1322056089037967392/1447780703348457512)\n## Watch Captains\n- **Watch Captain Ilo Brask:** [June 23th, 2025](https://discord.com/channels/1322056087792521269/1322056089037967392/1386814432113332285) — [December 9th, 2025](https://discord.com/channels/1322056087792521269/1322056089037967392/1447780703348457512)\n- **Watch Captain Quell:** ///*CLASSIFIED*/// — [June 23th, 2025](https://discord.com/channels/1322056087792521269/1322056089037967392/1386814432113332285)",
        nm_vi: "*Before the fortress stood as a bastion against Leviathan, these warriors forged the foundations of the brotherhood. Their deeds remain a source of strength to those who now carry the black.*",
        nm_vk: "Former Watch Command",
        nm_v: "Watch Captain Ilo Brask — The Unyielding Brother\nA battle-hardened veteran whose leadership was forged in the fires of war. Never one to command from safety, he stood shoulder to shoulder with his brothers, sharing every danger and every victory.\n\nReclusiarch Teme Sarr — Keeper of the Eternal Flame\nA humble yet formidable spiritual guardian of the brotherhood. Through unwavering devotion and tireless service, he strengthened the faith and resolve of those who fought beside him.\n\nBiologis Dax’mor — The Shield of Brotherhood\nThough known for his wit and lighthearted spirit, his loyalty remained beyond question. When danger approached, he was always the first to place his shield between his brothers and certain death.\n\nEpistolary Sel’Varok — The Seeker of Forgotten Truths\nA relentless scholar of forbidden knowledge, ancient history, and the mysteries of the galaxy. Yet no amount of study ever dulled his chainsword or weakened his resolve to purge the enemies of mankind.\n\nWatch Captain Quell — ///Classified/// [sealed]\nThe deeds of this brother lie beyond the reach of the common archives. His records were sealed by order of the Ordo Xenos, and only the Watch Commander may break the seal.",
        nm_e: "*Not every warrior is worthy of the Long Vigil. Only those who have proven themselves through fire, sacrifice, and unwavering loyalty may earn the right to stand among Ebonhold's chosen.*\n\n**ONLY THE ELITE CAN SLAY THE ELITE.**\n\n**WILL YOU TAKE THE BLACK AND STAND AGAINST LEVIATHAN?**\n\n**SUFFER NOT THE ALIEN TO LIVE!**",
      },
    },
    archive: { e1: archiveDoc(Object.fromEntries(old.map((t) => [t.id, t])), WEIGHTS, 'Deathwatch Tour — Ash Season', new Date('2026-05-30T18:00:00Z')) },
  }
}
