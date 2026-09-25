// @vitest-environment jsdom
/**
 * Local-only: renders every thread of the real, gitignored export through
 * the actual archive components. Skipped in CI (no archive-export/). Never
 * prints content — failures report thread ids only.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import ArchiveView from '../../views/ArchiveView.vue'
import { useArchive } from '../../stores/archive'
import { useAuth } from '../../stores/auth'
import { readExport } from '../../../scripts/lib/archive-seal.mjs'
import { parse } from '../../lib/archive/markdown'
import { liveRefs } from '../../lib/archive/prune'
import { classifyHref } from '../../lib/archive/model'

const present = existsSync('archive-export/.env')

describe.skipIf(!present)('real export renders (local only)', () => {
  let index
  beforeAll(async () => {
    ;({ index } = await readExport('archive-export'))
    index.kid = 'local'
  })

  it('every thread of both collections renders with in-site links only', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuth().member = { id: '1', username: 'u', isMember: true }
    const archive = useArchive()
    await archive.load('t', { loadArchive: async () => ({ keys: {}, index }) })
    expect(archive.status).toBe('ready')
    archive.assetUrl = () => new Promise(() => {}) // images stay pending; not under test here

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:c(accolades|ranks)/:threadId(\\d{17,20})?', component: ArchiveView }],
    })
    let threads = 0
    let routeLinks = 0
    const tocLinked = new Set()
    for (const col of archive.archive.collections.values()) {
      for (const threadId of col.threads.keys()) {
        await router.push(`/${col.key}/${threadId}`)
        const w = mount(ArchiveView, { props: { collectionKey: col.key, threadId }, global: { plugins: [router, pinia] } })
        await flushPromises()
        expect(w.find('.arch-thread').exists(), `thread ${threadId}`).toBe(true)
        for (const a of w.findAll('a')) {
          const href = a.attributes('href') ?? ''
          expect(href, `thread ${threadId}`).not.toMatch(/discord(app)?\.com|discord\.gg/i)
          if (href.startsWith('/')) {
            routeLinks++
            const [path, hash] = href.split('#')
            const [, key, target] = path.split('/')
            const targetCol = archive.archive.collections.get(key)
            // A bare /<collection> link (the header's way back) lands on its table of contents.
            expect(targetCol?.threads.has(target ?? targetCol?.tocThreadId), `thread ${threadId} → ${href}`).toBe(true)
            if (hash) expect(targetCol.threads.get(target).messages.some((m) => `m-${m.id}` === hash), `thread ${threadId} → ${href}`).toBe(true)
          }
        }
        // Pruning never drops a live link: every one in the source is rendered (plus the ToC overlay's entries).
        const kind = (h) => classifyHref(h, archive.archive).kind
        const isToc = threadId === col.tocThreadId
        const want = col.threads.get(threadId).messages.reduce((n, m) => n + liveRefs(parse(m.content ?? ''), kind).length, 0) + (isToc ? col.toc.insert.length : 0)
        expect(w.findAll('.arch-msg a').length, `thread ${threadId}`).toBe(want)
        if (isToc) {
          expect(w.find('.arch-img-attachment').exists(), `toc ${threadId}`).toBe(false)
          for (const a of w.findAll('a')) tocLinked.add((a.attributes('href') ?? '').split('#')[0])
        }
        w.unmount()
        threads++
      }
    }
    expect(threads).toBe(40)
    expect(routeLinks).toBeGreaterThanOrEqual(300)
    // Every thread is reachable from its table of contents, unless the overlay deliberately hides it.
    for (const col of archive.archive.collections.values()) {
      for (const id of col.threads.keys()) {
        if (id !== col.tocThreadId && !col.toc.hide.includes(id)) expect(tocLinked.has(`/${col.key}/${id}`), `unreachable: ${col.key}/${id}`).toBe(true)
      }
    }
  }, 120_000)
})
