import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import { loadArchive, loadAssetBlob, ArchiveAccessError } from '../lib/archive/client'
import { createArchive } from '../lib/archive/model'
import { ARCHIVE_KID, ARCHIVE_BASE } from '../lib/archive/buildConfig'
import { API_BASE } from '../lib/buildsApi'

// Kept outside reactive state on purpose: the key must never be serialised
// by devtools or persisted, and blob URLs need revoking on reset.
let keys = null
let inflight = null
// Bumped by reset(): a load that started before a sign-out must not
// install its key or plaintext when it finally resolves.
let generation = 0
const blobs = new Map() // logical path → Promise<blob URL>
const live = new Set() // resolved blob URLs, revoked synchronously on reset

export const useArchive = defineStore('archive', {
  state: () => ({ status: 'idle', error: null, archive: null }),
  actions: {
    load(token, deps = {}) {
      if (this.status === 'ready') return Promise.resolve()
      if (inflight) return inflight
      this.status = 'loading'
      this.error = null
      const gen = generation
      const run = (async () => {
        try {
          const res = await (deps.loadArchive ?? loadArchive)({ apiBase: API_BASE, token, expectedKid: ARCHIVE_KID, assetBase: ARCHIVE_BASE })
          if (gen !== generation) return
          const archive = createArchive(res.index)
          keys = res.keys
          this.archive = markRaw(archive)
          this.status = 'ready'
        } catch (e) {
          if (gen !== generation) return
          keys = null
          this.archive = null
          this.status = 'error'
          this.error = e instanceof ArchiveAccessError ? e.state : 'integrity'
        } finally {
          if (inflight === run) inflight = null
        }
      })()
      inflight = run
      return run
    },
    retry(token, deps) {
      this.reset()
      return this.load(token, deps)
    },
    assetUrl(collectionKey, file, deps = {}) {
      if (!keys) return Promise.reject(new Error('archive not loaded'))
      const logicalPath = `${collectionKey}/assets/${file}`
      if (!blobs.has(logicalPath)) {
        const session = keys
        const p = (deps.loadAssetBlob ?? loadAssetBlob)({ keys, assetBase: ARCHIVE_BASE, logicalPath }).then((b) => {
          const url = URL.createObjectURL(b)
          // Signed out (or reset) while this was decrypting: don't keep it.
          if (keys !== session) URL.revokeObjectURL(url)
          else live.add(url)
          return url
        })
        p.catch(() => blobs.delete(logicalPath))
        blobs.set(logicalPath, p)
      }
      return blobs.get(logicalPath)
    },
    reset() {
      generation++
      inflight = null
      keys = null
      for (const u of live) URL.revokeObjectURL(u)
      live.clear()
      blobs.clear()
      this.$reset()
    },
  },
})
