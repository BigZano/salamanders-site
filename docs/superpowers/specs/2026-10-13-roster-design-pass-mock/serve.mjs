import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
const root = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2', '.js': 'text/javascript' }
http.createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[\/]+/, '') || 'index.html'
  try {
    const body = await readFile(join(root, path === '' ? 'index.html' : path))
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch { res.writeHead(404); res.end('nope') }
}).listen(5180, () => console.log('mock on 5180'))
