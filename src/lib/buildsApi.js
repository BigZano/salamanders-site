/**
 * Client for the shared builds API (see server/). GET is public; POST/DELETE
 * need a live Discord access token (src/lib/discordAuth.js), which the server
 * verifies itself against Discord rather than trusting anything sent here.
 */
export const API_BASE = import.meta.env.VITE_BUILDS_API_URL || 'http://localhost:8787'

class BuildsApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'BuildsApiError'
    this.status = status
  }
}

export async function request(path, { method = 'GET', token, body, cache } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // fetch's cache mode, only when asked, so other calls keep the default.
    ...(cache ? { cache } : {}),
  })

  if (!res.ok) {
    const parsed = await res.json().catch(() => null)
    throw new BuildsApiError(parsed?.error || `Request failed (${res.status})`, res.status)
  }
  if (res.status === 204) return null
  return res.json()
}

// The token is optional: signed in, the server also flags which authors are
// members; without one the list is the same, just without that flag.
export const listBuilds = (className, token) =>
  request(className ? `/builds?class=${encodeURIComponent(className)}` : '/builds', { token })

export const createBuild = (build, token) =>
  request('/builds', { method: 'POST', token, body: build })

export const deleteBuild = (id, token) => request(`/builds/${id}`, { method: 'DELETE', token })

/** Whether the signed-in caller may delete anyone's build. Advisory only. */
export const getModeratorStatus = async (token) =>
  (await request('/builds/moderator', { token }))?.moderator === true

/**
 * Whether the signed-in caller is a chapter member, as the server sees it. True
 * only for an answer of exactly `true`. A failed lookup (401, 503, network)
 * rejects rather than reading as "not a member": the caller decides what that means.
 */
export const getMembership = async (token) =>
  (await request('/membership', { token, cache: 'no-store' }))?.member === true

export { BuildsApiError }
