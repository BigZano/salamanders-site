/** builds row → API shape. Shared by index.js and historyStore.js (deleted-build snapshots). */
export const rowToBuild = (r) => ({
  id: r.id,
  title: r.title,
  role: r.role,
  notes: r.notes,
  className: r.class_name,
  level: r.level,
  prestige: r.prestige,
  prestigePicks: r.prestige_picks,
  perks: r.perks,
  perkIds: r.perk_ids,
  justifications: r.justifications,
  weapons: r.weapons,
  weaponPerks: r.weapon_perks,
  author: { id: r.author_discord_id, username: r.author_discord_username },
  createdAt: r.created_at,
})

/**
 * A build as the public API sends it: the author is named by their Discord
 * display name (see displayNames.js), never the username stored with the row.
 */
export const publicBuild = (build, nameFor) => ({
  ...build,
  author: { id: build.author.id, displayName: nameFor(build.author.id) },
})
