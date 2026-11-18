/**
 * The thread that runs the regular expressions of the server's AutoMod rules for librariusSend.js (scanInWorker), so that a text
 * made to be slow holds up this thread and never the server. It answers each job it is sent with { found }, the answer of
 * scanPatterns(). All the logic is there, in the gated module, and tested there; this file is only the message loop, which is
 * why it is in neither the gated list of vitest.config.js nor the `mutate` list of stryker.config.mjs: the coverage of a thread
 * is not measured, and what this file does is tested by the answers that come back through it.
 */
import { parentPort } from 'node:worker_threads'
import { scanPatterns } from './librariusSend.js'

parentPort.on('message', (job) => parentPort.postMessage({ found: scanPatterns(job) }))
