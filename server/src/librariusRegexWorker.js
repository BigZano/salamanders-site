/**
 * The child process that runs the regular expressions of the server's AutoMod rules for librariusSend.js (createRegexRunner), so that
 * a text made to be slow holds up this process and never the server, and so that the server can kill it when it is not done in time. It
 * says { ready: true } once it can read jobs, and answers each job it is sent with answerJob() (`{ found }`, or `{ failed: true }`). All
 * the logic is there, in the gated module, and tested there; this file is only the message loop, which is why it is in neither the gated
 * list of vitest.config.js nor the `mutate` list of stryker.config.mjs: the coverage of another process is not measured, and what this file
 * does is tested by the answers that come back through it, with a real child, in the tests of createRegexRunner.
 */
import { answerJob } from './librariusSend.js'

process.on('message', (job) => process.send(answerJob(job)))
process.send({ ready: true })
