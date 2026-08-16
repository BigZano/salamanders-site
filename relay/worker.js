/**
 * Cloudflare Worker relay: browser can't hold a GitHub token, so this is the
 * only piece that does. Build-submission UI POSTs here with no auth; the
 * Worker forwards an authenticated repository_dispatch to GitHub, which wakes
 * discord-members.yml immediately instead of waiting for the next scheduled
 * run. Deploy: `npx wrangler deploy` from this directory, after
 * `npx wrangler secret put GH_DISPATCH_TOKEN`.
 */
const REPO = 'BigZano/salamanders-site'
const ALLOWED_ORIGIN = 'https://buildforge.armorybot.win'

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }))
    if (request.method !== 'POST') {
      return withCors(new Response('Method not allowed', { status: 405 }))
    }
    if (request.headers.get('Origin') !== ALLOWED_ORIGIN) {
      return withCors(new Response('Forbidden', { status: 403 }))
    }

    const res = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'salamanders-build-relay',
      },
      body: JSON.stringify({ event_type: 'build-submitted' }),
    })

    if (!res.ok) {
      console.error(`dispatch failed: ${res.status} ${await res.text()}`)
      return withCors(new Response('Dispatch failed', { status: 502 }))
    }
    return withCors(new Response(null, { status: 204 }))
  },
}

function withCors(res) {
  res.headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
  res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type')
  return res
}
