// Verified offline perk data for two weapons, lifted from the original planner.
// Used when the wiki fetch fails so the Armoury always has working examples.
export const WEAPON_FALLBACKS = {
  'Auto Bolt Rifle': {
    budget: 7,
    intro: [
      'A rapid-firing bolt rifle suited to close and medium-range engagements.',
    ],
    perks: [
      ['Honed Precision', 'Standard', "Equipped Weapon's Maximum Spread decreases by 50% when firing without aiming"],
      ['Extended Magazine', 'Standard', 'Magazine size increases by 15% of the maximum'],
      ['Close Combat', 'Master-Crafted', 'Enemies at a distance of no more than 15 metres take 15% more Damage'],
      ['Magazine Restoration', 'Master-Crafted', 'When Health drops below 30%, Ammo Reserve is restored by a full Magazine. Cooldown is 30 seconds.'],
      ['Fast Reload', 'Master-Crafted', 'Reload all Weapons 10% faster'],
      ['Perpetual Penetration', 'Master-Crafted', 'Each shot penetrates 1 additional target'],
      ['Head Hunter', 'Artificer', 'Headshots deal 10% more Damage'],
      ['Divine Might', 'Artificer', 'Damage increases by 10%'],
      ['Elite Hunter', 'Artificer', 'After killing a Majoris-level or higher enemy with a Melee Weapon, Headshots deal 50% more Damage for 10 seconds'],
      ['Great Might', 'Artificer', 'Damage increases by 10% against Terminus-level enemies'],
      ['Rapid Health', 'Relic', 'When Health is below 30%, killing 7 enemies in rapid succession restores Health by 10%'],
      ['Rampage', 'Relic', 'After killing 7 enemies in rapid succession, deal 25% more Damage for 10 seconds'],
      ['Recoupment', 'Relic', 'A Majoris-level or higher headshot kill restores 1 Armour Segment. Cooldown is 15 seconds'],
      ['Increased Capacity', 'Relic', 'Maximum Ammo Reserve increases by 20%'],
    ],
  },
  Chainsword: {
    budget: 11,
    intro: [
      'A reliable, versatile melee weapon with balanced crowd-clearing and single-target performance.',
    ],
    perks: [
      ['Armoured Strength', 'Standard', 'If you have Armour remaining, Melee Damage increases by 10%'],
      ['Perpetual Strength', 'Standard', 'Melee Damage increases by 5%'],
      ['Crushing Heel', 'Master-Crafted', 'Enemies hit by Stomp deal 30% less Damage for 4 seconds. Cooldown is 10 seconds.'],
      ['Swift Recovery', 'Master-Crafted', 'Heavy Attacks restore 100% more Contested Health.'],
      ['Perpetual Strength', 'Master-Crafted', 'Melee Damage increases by 5%'],
      ['Reverberating Impact', 'Artificer', 'Stomp area-of-effect radius increases by 50%'],
      ['Saw Blade', 'Artificer', 'Light Combo length increases from 4 to 5 strikes'],
      ['Trampling Stride', 'Artificer', 'After performing a Stomp, hold the attack button to perform an additional Stomp'],
      ['Combined Onslaught', 'Artificer', 'Light Combo attacks deal 10% more Melee Damage'],
      ['Heavy Onslaught', 'Artificer', 'Heavy Attacks deal 15% more Melee Damage'],
      ['Full Throttle', 'Artificer', 'Replaces Punch with a chargeable Full Throttle attack'],
      ['Hard Target', 'Artificer', 'Take 15% less Ranged Damage while performing a Light Combo'],
      ['Minoris Slayer', 'Artificer', 'Melee Damage against Minoris enemies increases by 20%'],
      ['Majoris Slayer', 'Relic', 'Melee Damage against Majoris enemies increases by 10%'],
      ['Extremis Slayer', 'Relic', 'Melee Damage against Extremis enemies increases by 15%'],
      ['Kill Streak', 'Relic', 'Rapid Light Combo kills prevent Heavy Hit control loss for 5 seconds'],
      ['Momentum Gain', 'Relic', 'Consecutive Light Attacks increase Light Attack Damage'],
      ['Fistfight', 'Heroic', 'Adds an additional heavy attack after Quick Punch and improves heavy attacks'],
      ['Fury of Chogoris', 'Heroic', 'Adrenaline Surge can stack to 3 with adjusted damage bonuses'],
    ],
  },
}

// Normalise a fallback entry to the same shape as a wiki fetch result.
export function fallbackWeaponData(name) {
  const f = WEAPON_FALLBACKS[name]
  if (!f) return null
  return {
    intro: f.intro,
    budget: f.budget,
    live: false,
    perks: f.perks.map(([n, quality, description]) => ({ name: n, quality, description })),
  }
}
