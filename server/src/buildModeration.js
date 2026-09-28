/**
 * Build deletion: the poster may delete their own; a moderator (Admin, Master
 * of the Forge, Mechadendrite Expert, Techmarine, and not revoked — see
 * privileges.js) may delete anyone's. Deletes are soft and land in the
 * version history; a moderator deleting someone else's build pings the
 * webhook.
 */
import { Upstream } from './discordRoles.js'

export function createBuildModeration({ roles, privileges, store, notify = () => {} }) {
  return {
    async status(request) {
      try {
        const user = await roles.identify(request)
        return reply(200, { moderator: user ? (await privileges.forUser(user)).moderator : false })
      } catch {
        return reply(200, { moderator: false })
      }
    },

    async remove(request, id) {
      try {
        const user = await roles.identify(request)
        if (!user) return reply(401, { error: 'Sign in with Discord to delete a build.' })
        const author = await store.buildAuthor(id)
        if (!author) return reply(404, { error: 'Not found.' })
        const own = author.id === user.id
        if (!own && !(await privileges.forUser(user)).moderator) {
          return reply(403, { error: 'Only the poster or a moderator can delete this build.' })
        }
        const build = await store.softDeleteBuild(id, user)
        if (build === 'missing') return reply(404, { error: 'Not found.' })
        if (!own) notify(`${user.username} deleted build #${build.id} "${build.title}" by ${build.author.username}`)
        return new Response(null, { status: 204 })
      } catch (err) {
        if (err instanceof Upstream) return reply(503, { error: 'Discord could not be reached. Try again.' })
        throw err
      }
    },
  }
}

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}
