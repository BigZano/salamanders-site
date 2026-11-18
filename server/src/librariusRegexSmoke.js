/**
 * A check that is run by hand or by a hook, with the runtime of the server: `bun server/src/librariusRegexSmoke.js` (it runs on Node
 * too, and is only worth running on Bun). It is in neither the gated list of vitest.config.js nor the `mutate` list of
 * stryker.config.mjs, and the suite does not run it, for this reason: the suite runs on Node, where a Worker that is terminated stops the
 * regular expression it is in, and Bun's does not (JavaScriptCore finishes the regular expression, which for a pattern with several
 * `.*` is minutes of a core: a member could stack those at 20 tries a minute). The AutoMod check of replies runs the patterns of the rules
 * in a child process that is killed on time instead (librariusSend.js, createRegexRunner), which behaves the same on both, and this
 * script is the proof of it on the runtime that matters.
 *
 * It runs 3 jobs that are over the budget, with a pattern that is linear in Rust and polynomial here (`(?:free|gift).*nitro.*claim.*https?://`
 * over about 4,000 characters of `free nitro claim `), one after the other, and checks that:
 *   - each is refused (answered null, which the caller turns into the 422 "couldn't be checked") within a little over the 250 ms budget;
 *   - no child process of those jobs is alive afterwards, so none of them is burning a core;
 *   - the process itself uses next to no CPU in the second after, which a thread that kept running would not allow;
 *   - a job after them is answered, by a new child.
 * It prints one line for each and exits with 0, or with 1 after a line that starts with FAIL. It takes about 2 seconds. It reads no
 * environment and no file, and prints no text of any pattern or of any member: the pattern here is its own.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { createRegexRunner, spawnRegexWorker, translatePattern } from './librariusSend.js'

const PATTERN = '(?:free|gift).*nitro.*claim.*https?://'
const TEXT = 'free nitro claim '.repeat(235)
const JOBS = 3
// The budget (250 ms) and what a child takes to start and to be killed.
const REFUSED_WITHIN_MS = 400
// What the process may use in a second of doing nothing.
const IDLE_CPU_MS = 100

const failures = []
const say = (line) => console.log(line)
const check = (ok, line) => {
  say(`${ok ? 'ok  ' : 'FAIL'} ${line}`)
  if (!ok) failures.push(line)
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}
const runtime = typeof Bun === 'undefined' ? `node ${process.version}` : `bun ${Bun.version}`
say(`runtime: ${runtime}, ${TEXT.length} characters, ${JOBS} jobs over the budget`)

const source = translatePattern(PATTERN)
check(source !== null, 'the pattern is one that translatePattern() can read')

const children = []
const scan = createRegexRunner(() => {
  const child = spawnRegexWorker()
  children.push({ pid: child.pid, ended: new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))) })
  return child
})

for (let i = 1; i <= JOBS; i++) {
  const started = performance.now()
  const answer = await scan({ rules: [[source]], texts: [TEXT] })
  const took = Math.round(performance.now() - started)
  check(answer === null && took <= REFUSED_WITHIN_MS, `job ${i} was refused (answer ${answer === null ? 'null' : 'NOT null'}) in ${took} ms (at most ${REFUSED_WITHIN_MS})`)
}

check(children.length === JOBS, `each job had a child of its own: ${children.length} children (pids ${children.map((c) => c.pid).join(', ')})`)
const ended = await Promise.race([Promise.all(children.map((c) => c.ended)), sleep(2_000).then(() => null)])
check(ended !== null && ended.every((e) => e.signal === 'SIGKILL'), `every child was ended by SIGKILL: ${JSON.stringify(ended)}`)
const left = children.filter((c) => alive(c.pid))
check(left.length === 0, `no child is alive afterwards (alive: ${left.length})`)

const before = process.cpuUsage()
await sleep(1_000)
const used = process.cpuUsage(before)
const cpuMs = Math.round((used.user + used.system) / 1000)
check(cpuMs <= IDLE_CPU_MS, `the process used ${cpuMs} ms of CPU in the next second (at most ${IDLE_CPU_MS}: idle)`)

const control = await scan({ rules: [['zorp']], texts: ['a zorp'] })
check(control?.found?.start === 2, 'a job after them is answered, by a new child')
if (children.length > JOBS && alive(children[children.length - 1].pid)) process.kill(children[children.length - 1].pid, 'SIGKILL')

say(failures.length === 0 ? 'smoke check passed' : `smoke check FAILED (${failures.length})`)
process.exit(failures.length === 0 ? 0 : 1)
