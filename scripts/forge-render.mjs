#!/usr/bin/env node
/**
 * Renders the volcano headlessly: a grid of PNGs across viewports, moon phases and lava presets for looking at, and a
 * smoke and performance check (--smoke, --throttle) for the lava shader's budget. It needs a dev server running
 * (npm run dev) and a local Chrome; it speaks the Chrome DevTools Protocol directly, so it has no dependencies.
 *
 *   node scripts/forge-render.mjs [--base http://127.0.0.1:5191] [--out .forge/grid]
 *        [--paths / /armoury] [--sizes phone,tablet,desktop] [--phases 0.1,0.42,0.7]
 *        [--presets crust=0.3,crust=1] [--throttle 4] [--smoke] [--verbose] [--gpu] [--chrome <path>]
 *
 * Each grid page is pictured at 120 s, frozen; it opens 24 s early (the lava's heat sim starts cold) and is stepped 720
 * frozen frames to get there, so a run takes about half a minute per entry. With --smoke each path and size also gets an
 * ignition entry: two seconds after a cold load, the sheet's head lit and the first arm's toe still dark.
 * Chrome runs one renderer process at below-normal priority, one entry at a time. Do not edit files under the dev
 * server's root while it runs: the server reloads the page and the burn is lost (the run then says so).
 *
 * A preset is query params the volcano reads in dev (crust, heat, viscosity, cracks, foldScale, breakoutRate);
 * join several with & (and quote it). Exit code: 0 when every entry rendered with the lava shader live (as asked), no
 * page raised a console error and every probe passed; 2 when no Chrome was found; 1 for everything else.
 *
 * Git Bash turns a bare "/" argument into a Windows path: set MSYS_NO_PATHCONV=1 there, or use PowerShell.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { constants as osConstants, setPriority, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  chromeArgs,
  chromeCandidates,
  findChrome,
  judge,
  judgeIgnition,
  lavaWanted,
  lowerPriorityCommand,
  parseArgs,
  plan,
  probe,
  probeRects,
} from './lib/forge-render.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// How long a page may take to bring the volcano up, and how long the lava shader gets to fade in once it has (it
// cross-fades over a second, and the screenshot should not catch it half way).
const READY_MS = 15000
const SETTLE_MS = 2000
// Frames the frozen page is stepped to measure the draw cost when its burn did not already time them: the stats are
// written once per 30 frames over a window of 60.
const STEP_FRAMES = 60
const STEP_MS = 60000
// How long each burned frame may take before the burn is called stuck: a stepped frame waits for the page's 30 fps gate,
// and a software-GL desktop under a CPU throttle runs well below that.
const BURN_FRAME_MS = 400

// ---------------------------------------------------------------------------------------------------------- DevTools

/** A minimal DevTools Protocol client over the browser's WebSocket. Commands to a page carry its sessionId. */
async function connect(url) {
  const ws = new WebSocket(url)
  await new Promise((ok, fail) => {
    ws.onopen = ok
    ws.onerror = () => fail(new Error(`could not open the DevTools socket at ${url}`))
  })
  let next = 0
  let closed = false
  const pending = new Map()
  const listeners = new Set()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id === undefined) {
      for (const l of listeners) l(msg)
      return
    }
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.fail(new Error(`${p.method}: ${msg.error.message}`))
    else p.ok(msg.result)
  }
  ws.onclose = () => {
    closed = true
    for (const p of pending.values()) p.fail(new Error(`${p.method}: the DevTools socket closed`))
    pending.clear()
  }
  return {
    send(method, params = {}, sessionId) {
      return new Promise((ok, fail) => {
        // a closed socket answers nothing: fail now instead of after the 60 s timer
        if (closed) return fail(new Error(`${method}: the DevTools socket closed`))
        const id = ++next
        const timer = setTimeout(() => {
          pending.delete(id)
          fail(new Error(`${method} timed out`))
        }, 60000)
        pending.set(id, {
          method,
          ok: (v) => (clearTimeout(timer), ok(v)),
          fail: (e) => (clearTimeout(timer), fail(e)),
        })
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      })
    },
    on(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    close() {
      try {
        ws.close()
      } catch {
        // already closed
      }
    },
  }
}

/** Starts Chrome and resolves with the browser's DevTools WebSocket URL, read from the line it prints on stderr. */
function launch(chromePath, profileDir, gpu) {
  const chrome = spawn(chromePath, chromeArgs({ profileDir, gpu }), { stdio: ['ignore', 'ignore', 'pipe'] })
  // Below-normal at once: on Windows the processes Chrome starts from here on inherit it.
  try {
    setPriority(chrome.pid, osConstants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    // the process may already have gone; the ready promise below reports that
  }
  const ready = new Promise((ok, fail) => {
    let seen = ''
    let found = false
    const timer = setTimeout(() => fail(new Error('Chrome did not report a DevTools port within 20 s')), 20000)
    chrome.stderr.on('data', (d) => {
      if (found) return
      seen += d
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(seen)
      if (!m) return
      found = true
      clearTimeout(timer)
      ok(m[1])
    })
    chrome.once('error', (e) => (clearTimeout(timer), fail(e)))
    chrome.once('exit', (code) => (clearTimeout(timer), fail(new Error(`Chrome exited (${code}) before it was ready:\n${seen.trim()}`))))
  })
  return { chrome, ready }
}

// ------------------------------------------------------------------------------------------------ what runs in the page

// The volcano is up when it has hung `__forge` on the window and is either frozen (a ?t= page draws nothing per frame,
// so it never reports frames) or has reported some.
const READY = 'Boolean(window.__forge) && (window.__forge.frozen || window.__forge.stats.fps > 0)'
// The lava shader's chunk has arrived (a lazy import, so a cold dev server can take a while to transform it).
const LAVA_FETCHED = "performance.getEntriesByType('resource').some((e) => e.name.includes('lavaShader') && e.responseEnd > 0)"
const STATS = 'JSON.stringify(window.__forge.stats)'
const GEOMETRY = 'JSON.stringify(window.__forge.actions.geometry())'
const FROZEN = 'window.__forge.frozen'
const STEP = (n) => `(window.__forge.step = ${n}, true)`
const STEPPED = 'window.__forge.step === 0'
const LAVA_LIVE = 'window.__forge.actions.geometry().lava'
const TIME = 'window.__forge.actions.time()'
const HAS_STATS = 'window.__forge.stats.fps > 0'

/**
 * The pixels of each rect (in viewport CSS px) from the volcano's canvas, as base64 RGBA. The canvas is copied to a
 * canvas of our own first, so the volcano's context is not touched, and each rect is scaled to the canvas's device px.
 */
const readRects = (rects) => `(() => {
  const src = document.querySelector('.deathfire canvas')
  if (!src) return null
  const copy = document.createElement('canvas')
  copy.width = src.width
  copy.height = src.height
  const ctx = copy.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(src, 0, 0)
  const k = src.width / window.innerWidth
  const base64 = (b) => {
    let s = ''
    for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192))
    return btoa(s)
  }
  const out = {}
  for (const [name, r] of Object.entries(${JSON.stringify(rects)})) {
    const x = Math.max(0, Math.floor(r.x * k))
    const y = Math.max(0, Math.floor(r.y * k))
    const w = Math.min(src.width, Math.ceil((r.x + r.w) * k)) - x
    const h = Math.min(src.height, Math.ceil((r.y + r.h) * k)) - y
    out[name] = w > 0 && h > 0 ? { w, h, data: base64(ctx.getImageData(x, y, w, h).data) } : { w: 0, h: 0, data: '' }
  }
  return out
})()`

// ------------------------------------------------------------------------------------------------------------ one page

/** Evaluates an expression in the page and returns its value; a throw in the page throws here. */
async function evaluate(cdp, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

/** Polls an expression every 100 ms until it is truthy; false if `ms` runs out first. A page that is mid-navigation just reads as not yet. */
async function waitFor(cdp, sessionId, expression, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      if (await evaluate(cdp, sessionId, expression)) return true
    } catch {
      // the page has no context yet
    }
    await sleep(100)
  }
  return false
}

/** Renders one planned entry. Never throws: whatever went wrong is in `failures`, and a failed entry writes no PNG. */
async function renderEntry(cdp, entry, opts) {
  const result = { name: entry.name, png: null, stats: null, probes: null, rects: null, verdict: null, errors: [], ignored: [], failures: [] }
  const baseOrigin = new URL(opts.base).origin
  let targetId = null
  let off = () => {}
  try {
    targetId = (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId
    const sessionId = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId
    const send = (method, params) => cdp.send(method, params, sessionId)

    // Anything the page reports as an error fails the entry, except a failed request to some other origin (the API
    // server on :8787 is usually not running next to the dev server, and that says nothing about the volcano).
    off = cdp.on((msg) => {
      if (msg.sessionId !== sessionId) return
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails
        result.errors.push(`exception: ${d.exception?.description ?? d.text}`)
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        result.errors.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`)
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        const e = msg.params.entry
        const line = `${e.text}${e.url ? ` (${e.url})` : ''}`
        if (e.source === 'network' && e.url && new URL(e.url).origin !== baseOrigin) result.ignored.push(line)
        else result.errors.push(`log: ${line}`)
      }
    })

    await send('Emulation.setDeviceMetricsOverride', {
      width: entry.width,
      height: entry.height,
      deviceScaleFactor: entry.deviceScaleFactor,
      mobile: entry.mobile,
    })
    if (opts.throttle) await send('Emulation.setCPUThrottlingRate', { rate: opts.throttle })
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Log.enable')

    const nav = await send('Page.navigate', { url: opts.base + entry.url })
    if (nav.errorText) {
      result.failures.push(`navigation failed: ${nav.errorText}`)
      return result
    }
    if (!(await waitFor(cdp, sessionId, READY, READY_MS))) {
      result.failures.push(`the volcano (window.__forge) was not up after ${READY_MS / 1000} s`)
      return result
    }
    // The shader is a lazy chunk: give it the chance to arrive, then the second it takes to fade in.
    const wantLava = lavaWanted(entry.url)
    const fetched = wantLava ? await waitFor(cdp, sessionId, LAVA_FETCHED, READY_MS) : true
    if (wantLava) await waitFor(cdp, sessionId, LAVA_LIVE, READY_MS)
    await sleep(SETTLE_MS)

    // Burn: the page opened `burn` frames before its second, with the sim cold. Step it there a frame at a time, so the
    // picture shows the flow as it stands at that second (as far as the cap allows), not a cold sim.
    if (entry.burn > 0 && (await evaluate(cdp, sessionId, FROZEN))) {
      await evaluate(cdp, sessionId, STEP(entry.burn))
      const limit = Math.max(STEP_MS, entry.burn * BURN_FRAME_MS)
      if (!(await waitFor(cdp, sessionId, STEPPED, limit))) result.failures.push(`the burn of ${entry.burn} frames did not finish in ${limit / 1000} s`)
    }
    // A page that reloaded mid-burn (the dev server's hot reload, say) opens cold at its first second: say so, rather
    // than picture a cold sim as if it were the flow at this one.
    const clock = await evaluate(cdp, sessionId, TIME)
    if (Math.abs(clock - entry.at) > 0.05) result.failures.push(`the clock is at ${clock.toFixed(2)} s, not ${entry.at} s: the burn did not run`)

    const shot = await send('Page.captureScreenshot', { format: 'png' })
    result.png = Buffer.from(shot.data, 'base64')

    // Whether the shader is really painting decides what the picture and the draw timings are of (the ribbons otherwise),
    // so it is checked for every entry, not only with --smoke.
    const geometry = JSON.parse(await evaluate(cdp, sessionId, GEOMETRY))
    if (wantLava === true && !geometry.lava) result.failures.push(fetched ? 'shader not live (the layer was not built, or was dropped)' : `shader not live (its chunk was not fetched in ${READY_MS / 1000} s)`)
    if (wantLava === false && geometry.lava) result.failures.push('shader live although the page asked for lava=0')

    if (opts.smoke || entry.kind === 'ignite') {
      const rects = probeRects(geometry)
      if (!rects) result.failures.push('smoke: the volcano has no sheet and arm to probe')
      else {
        result.rects = rects
        const pixels = await evaluate(cdp, sessionId, readRects(rects))
        if (!pixels) result.failures.push('smoke: no volcano canvas (.deathfire canvas)')
        else {
          result.probes = Object.fromEntries(
            Object.entries(pixels).map(([name, p]) => [name, probe(Buffer.from(p.data, 'base64'), p.w, p.h, { x: 0, y: 0, w: p.w, h: p.h })]),
          )
          const ignite = entry.kind === 'ignite'
          result.verdict = ignite ? judgeIgnition(result.probes) : judge(result.probes)
          if (!result.verdict.ok) {
            const failed = Object.keys(result.verdict).filter((k) => k !== 'ok' && !result.verdict[k])
            result.failures.push(`${ignite ? 'ignition' : 'smoke'}: ${failed.join(', ')} failed`)
          }
        }
      }
    }

    // The burn's frames are timed by the volcano itself. A page that burned too few to fill the stats is stepped some
    // more (after the screenshot, so the picture is still of the second asked for).
    if ((await evaluate(cdp, sessionId, FROZEN)) && !(await evaluate(cdp, sessionId, HAS_STATS))) {
      await evaluate(cdp, sessionId, STEP(STEP_FRAMES))
      if (!(await waitFor(cdp, sessionId, STEPPED, STEP_MS))) result.failures.push(`${STEP_FRAMES} stepped frames did not finish in ${STEP_MS / 1000} s`)
    }
    result.stats = JSON.parse(await evaluate(cdp, sessionId, STATS))
  } catch (err) {
    result.failures.push(err.message)
  } finally {
    off()
    if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
  return result
}

// ----------------------------------------------------------------------------------------------------------- reporting

const ms = (v) => `${v.toFixed(2)} ms`
const box = (r) => `${r.x.toFixed(0)},${r.y.toFixed(0)} ${r.w.toFixed(0)}x${r.h.toFixed(0)} px`
const rgb = (p) => `rgb ${p.mean.map((c) => c.toFixed(0)).join(',')} max ${p.max}${p.bright ? ' bright' : ''}`

function line(result, nameWidth, smoke) {
  const cols = [result.name.padEnd(nameWidth)]
  if (result.stats) cols.push(ms(result.stats.draw).padStart(10), ms(result.stats.max).padStart(10), `${result.stats.fps.toFixed(1)} fps`.padStart(8))
  else cols.push('-'.padStart(10), '-'.padStart(10), '-'.padStart(8))
  if (smoke) cols.push(result.verdict ? Object.keys(result.verdict).filter((k) => k !== 'ok').map((k) => `${k} ${result.verdict[k] ? 'ok' : 'FAIL'}`).join('  ') : 'probes -')
  if (result.failures.length || result.errors.length) cols.push('FAILED')
  return cols.join('  ')
}

function details(result, verbose) {
  const out = []
  if (verbose && result.probes) for (const [k, p] of Object.entries(result.probes)) out.push(`    ${k.padEnd(8)} ${rgb(p)}  at ${box(result.rects[k])}`)
  for (const f of result.failures) out.push(`    ! ${f}`)
  for (const e of result.errors) out.push(`    ! ${e}`)
  if (verbose) for (const i of result.ignored) out.push(`    (ignored, other origin) ${i}`)
  if (result.failures.length && result.probes && !verbose) for (const [k, p] of Object.entries(result.probes)) out.push(`    ${k.padEnd(8)} ${rgb(p)}  at ${box(result.rects[k])}`)
  return out
}

// ---------------------------------------------------------------------------------------------------------------- main

/** Runs lowerPriorityCommand's command, if this platform has one, and waits for it; a failure only warns. */
function lowerPriority(profileName) {
  const command = lowerPriorityCommand(profileName, process.platform)
  if (!command) return Promise.resolve()
  return new Promise((done) => {
    const p = spawn(command.cmd, command.args, { stdio: 'ignore', windowsHide: true })
    p.once('error', (e) => {
      console.warn(`could not lower Chrome's priority: ${e.message}`)
      done()
    })
    p.once('exit', () => done())
  })
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const entries = plan(opts)

  const chromePath = opts.chrome ?? findChrome(process.env, existsSync)
  if (!chromePath || !existsSync(chromePath)) {
    console.error(`Chrome not found${opts.chrome ? ` at ${opts.chrome}` : ''}. Looked at:\n  ${chromeCandidates(opts.chrome ? { CHROME: opts.chrome } : process.env).join('\n  ')}\nSet CHROME or pass --chrome <path>.`)
    return 2
  }

  const out = resolve(opts.out)
  mkdirSync(out, { recursive: true })
  const profile = mkdtempSync(join(tmpdir(), 'forge-render-'))
  const { chrome, ready } = launch(chromePath, profile, opts.gpu)
  // The belt: however this process ends, Chrome does not outlive it. Registered at once, before anything is awaited.
  process.on('exit', () => {
    try {
      chrome.kill()
    } catch {
      // already gone
    }
  })
  process.on('SIGINT', () => process.exit(130))
  process.on('SIGTERM', () => process.exit(143))

  let cdp = null
  const results = []
  try {
    // `ready` is awaited first, inside the try, so a Chrome that exits at once is reported cleanly and the profile
    // folder is still removed by the finally below.
    const wsUrl = await ready
    // Chrome has started its children by now: drop every process of this run to below-normal. Windows only, so no
    // wait anywhere else.
    if (lowerPriorityCommand(basename(profile), process.platform)) {
      await sleep(1000)
      await lowerPriority(basename(profile))
    }
    cdp = await connect(wsUrl)
    const nameWidth = Math.max(4, ...entries.map((e) => e.name.length))
    console.log(`${'name'.padEnd(nameWidth)}  ${'draw-mean'.padStart(10)}  ${'draw-worst'.padStart(10)}  ${'fps'.padStart(8)}${opts.smoke ? '  probes' : ''}`)
    for (const entry of entries) {
      const result = await renderEntry(cdp, entry, opts)
      if (result.png) writeFileSync(join(out, `${entry.name}.png`), result.png)
      results.push(result)
      console.log(line(result, nameWidth, opts.smoke))
      for (const d of details(result, opts.verbose)) console.log(d)
    }
  } finally {
    // Ask Chrome to close, give it a moment, then make sure; only then is its profile folder free to delete.
    if (cdp) await Promise.race([cdp.send('Browser.close').catch(() => {}), sleep(2000)])
    cdp?.close()
    const gone = new Promise((ok) => (chrome.exitCode !== null || chrome.signalCode !== null ? ok() : chrome.once('exit', ok)))
    await Promise.race([gone, sleep(2000)])
    chrome.kill()
    await Promise.race([gone, sleep(2000)])
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // Windows can hold a file a moment longer; the folder is in the temp directory
    }
  }

  const failed = results.filter((r) => r.failures.length || r.errors.length)
  const written = results.filter((r) => r.png).length
  console.log(`\n${written} of ${entries.length} rendered to ${out}; ${failed.length} failed${opts.throttle ? `; CPU throttled ${opts.throttle}x` : ''}`)
  return failed.length ? 1 : 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    console.error(err.message)
    process.exitCode = 1
  },
)
