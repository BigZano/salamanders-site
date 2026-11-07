import { mkdirSync, writeFileSync, readdirSync, existsSync, createReadStream } from 'node:fs'
import { join, extname } from 'node:path'

/**
 * The forge's dev-server plugin: two tiny endpoints for the playground at /dev/forge. Serve only; never in a build.
 *
 *   POST /__forge/snap   { name, dataUrl }  writes a PNG to .forge/snaps/<name>-<stamp>.png and answers { file }
 *   GET  /__forge/refs                      lists the reference images in docs/design/refs/
 *   GET  /__forge/refs/<file>               serves one of them
 */
export const SNAP_DIR = '.forge/snaps'
export const REF_DIR = 'docs/design/refs'

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/** A file-safe name: letters, digits, dash and underscore, at most 60 characters, never empty. */
export function snapName(name) {
  const base = String(name ?? 'snap')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return base || 'snap'
}

/** The snap's file name: the safe name and a compact UTC stamp, so snaps sort by time and never overwrite. */
export function snapFile(name, now = new Date()) {
  return `${snapName(name)}-${now.toISOString().replace(/[-:.]/g, '').slice(0, 15)}.png`
}

/** The bytes of a PNG data URL; anything else is refused. */
export function decodeDataUrl(url) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(url || '')
  if (!m) throw new Error('expected a PNG data URL')
  return Buffer.from(m[1], 'base64')
}

/** The reference images in the refs folder, by name. */
export function listRefs(root) {
  const dir = join(root, REF_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => MIME[extname(f).toLowerCase()])
    .sort()
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 40e6) reject(new Error('too large'))
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

export function forgeDevPlugin(root = process.cwd()) {
  return {
    name: 'forge-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__forge/snap', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end()
        }
        try {
          const { name, dataUrl } = JSON.parse(await readBody(req))
          const dir = join(root, SNAP_DIR)
          mkdirSync(dir, { recursive: true })
          const file = join(dir, snapFile(name))
          writeFileSync(file, decodeDataUrl(dataUrl))
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ file }))
        } catch (e) {
          res.statusCode = 400
          res.end(String(e.message))
        }
      })
      server.middlewares.use('/__forge/refs', (req, res) => {
        const name = decodeURIComponent((req.url || '/').replace(/^\/+/, '').split('?')[0])
        if (!name) {
          res.setHeader('content-type', 'application/json')
          return res.end(JSON.stringify(listRefs(root)))
        }
        const type = MIME[extname(name).toLowerCase()]
        if (!type || name.includes('..') || name.includes('/') || name.includes('\\')) {
          res.statusCode = 400
          return res.end()
        }
        const file = join(root, REF_DIR, name)
        if (!existsSync(file)) {
          res.statusCode = 404
          return res.end()
        }
        res.setHeader('content-type', type)
        createReadStream(file).pipe(res)
      })
    },
  }
}
