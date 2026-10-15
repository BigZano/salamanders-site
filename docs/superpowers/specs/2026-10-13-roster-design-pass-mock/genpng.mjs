import zlib from 'node:zlib'
import { writeFileSync } from 'node:fs'
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]) }
function png(w, h, seed) {
  const raw = Buffer.alloc((1 + w * 3) * h)
  let s = seed * 9301 + 49297
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280)
  const base = [rnd() * 200 + 30, rnd() * 200 + 30, rnd() * 200 + 30]
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0
    for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) raw[y * (1 + w * 3) + 1 + x * 3 + c] = Math.max(0, Math.min(255, base[c] + (x - y) * 0.8 + (rnd() - 0.5) * 70))
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
for (let i = 0; i < 220; i++) writeFileSync(`av/${i}.png`, png(64, 64, i + 1))
console.log('done', png(64, 64, 1).length, 'bytes each')
