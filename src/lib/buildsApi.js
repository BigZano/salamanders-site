/**
 * Client for the shared builds API (see server/). GET is public; POST/DELETE
 * need a live Discord access token (src/lib/discordAuth.js), which the server
 * verifies itself against Discord rather than trusting anything sent here.
 */
const BASE_URL = import.meta.env.VITE_BUILDS_API_URL || 'http://localhost:8787'

class BuildsApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'BuildsApiError'
    this.status = status
  }
}

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const parsed = await res.json().catch(() => null)
    throw new BuildsApiError(parsed?.error || `Request failed (${res.status})`, res.status)
  }
  if (res.status === 204) return null
  return res.json()
}

export const listBuilds = (className) =>
  request(className ? `/builds?class=${encodeURIComponent(className)}` : '/builds')

export const createBuild = (build, token) =>
  request('/builds', { method: 'POST', token, body: build })

export const deleteBuild = (id, token) => request(`/builds/${id}`, { method: 'DELETE', token })

export { BuildsApiError }
