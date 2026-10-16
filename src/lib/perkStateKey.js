import weaponList from '../data/weapons.json'

const LISTS = weaponList.fallbackWeapons

/**
 * Where a weapon's perk picks and budget are stored. Picks are keyed by weapon
 * name, which is the weapon itself in every slot it belongs to. The one exception
 * is a weapon sitting in a slot it does not belong to (Tactical's Bolt Rifle as a
 * Secondary): it gets "<weapon> (<Slot>)" so it is configured apart from the same
 * weapon in its own slot. Keeping every other key unchanged means saved builds,
 * share links and stored rows need no migration.
 *
 * Anything that is not a known slot, or a weapon no slot lists, keeps its bare
 * name; a non-string weapon has no key.
 */
export function perkStateKey(slot, weapon) {
  if (typeof weapon !== 'string') return ''
  if (typeof slot !== 'string' || !Object.hasOwn(LISTS, slot)) return weapon
  if (LISTS[slot].includes(weapon)) return weapon
  const belongsElsewhere = Object.values(LISTS).some((names) => names.includes(weapon))
  return belongsElsewhere ? `${weapon} (${slot[0].toUpperCase()}${slot.slice(1)})` : weapon
}
