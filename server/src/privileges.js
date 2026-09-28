/**
 * Who may do what above a normal member: edit perks, read the version
 * history, delete other people's builds, revoke those powers. See the roles
 * table in docs/superpowers/specs/2026-09-27-perk-corrections-design.md.
 *
 * Master of the Forge and Legion Hierarchy stand on even footing: neither can
 * revoke the other; only an Administrator can. A revocation turns someone back
 * into a normal member; Administrators cannot be revoked.
 */
export const ROLE_IDS = {
  techmarine: process.env.TECHMARINE_ROLE_ID || '1322056087859499042',
  mechadendrite: process.env.MECHADENDRITE_ROLE_ID || '1362522277677240521',
  forge: process.env.FORGE_ROLE_ID || '1322056087867883565',
  hierarchy: process.env.HIERARCHY_ROLE_ID || '1322056087880597522',
}

export function privilegesFrom({ roles, admin, revoked }, ids = ROLE_IDS) {
  const has = (k) => (roles || []).includes(ids[k])
  const isAdmin = !!admin
  const out = !isAdmin && !!revoked
  const editor = !out && (isAdmin || has('techmarine') || has('mechadendrite') || has('forge') || has('hierarchy'))
  return {
    admin: isAdmin,
    editor,
    historyViewer: editor,
    moderator: !out && (isAdmin || has('techmarine') || has('mechadendrite') || has('forge')),
    revoked: out,
    revoker: out ? null : isAdmin ? 'admin' : has('forge') ? 'forge' : null,
  }
}

export function mayRevoke(actor, target, ids = ROLE_IDS) {
  if (!actor?.revoker || !target || target.admin || actor.id === target.id) return false
  if (actor.revoker === 'admin') return true
  const t = (k) => (target.roles || []).includes(ids[k])
  return (t('techmarine') || t('mechadendrite')) && !t('forge') && !t('hierarchy')
}

/** Live lookups (Discord + open revocation). Throws Upstream like discordRoles.js. */
export function createPrivileges({ roles, store, ids = ROLE_IDS }) {
  return {
    async forUser(user) {
      const held = await roles.rolesOf(user.id)
      if (!held) return { id: user.id, ...privilegesFrom({ roles: [], admin: false, revoked: false }, ids) }
      const admin = await roles.isAdmin(user.id, held)
      const revoked = !!(await store.openRevocation(user.id))
      return { id: user.id, ...privilegesFrom({ roles: held, admin, revoked }, ids) }
    },
    async target(discordId) {
      const held = await roles.rolesOf(discordId)
      if (!held) return null
      return { id: discordId, roles: held, admin: await roles.isAdmin(discordId, held) }
    },
  }
}
