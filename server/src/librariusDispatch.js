/**
 * Hands each event of the gateway to two handlers that have nothing to do with each other: the live feed (librariusIngest.js) and the
 * "Delete on site" command (librariusCommand.js). The gateway gives events to onDispatch one at a time and waits for each, and the
 * command can take nearly three seconds to answer an interaction, so the command must not stand in front of the feed: the feed's answer
 * is the answer, and the command goes on by itself.
 *
 * alongside(main, aside, onError = console.error) → dispatch(type, data)
 *   dispatch starts `aside(type, data)` first, then answers `main(type, data)` as it is (a promise that fails fails the same for the
 *   gateway, which deals with it). It never waits for `aside`, whatever that answers. When `aside` throws, or answers something that
 *   fails, `onError(err)` is told, once, and nothing else happens: the main handler has run all the same. Nothing `onError` does,
 *   a throw included, can reach the gateway.
 */
export function alongside(main, aside, onError = console.error) {
  if (typeof main !== 'function') throw new TypeError('main must be a function.')
  if (typeof aside !== 'function') throw new TypeError('aside must be a function.')
  if (typeof onError !== 'function') throw new TypeError('onError must be a function.')

  function failed(err) {
    // Stryker disable next-line BlockStatement: a report that throws changes nothing a test can see: the catch is only there so that it cannot reach the gateway
    try {
      onError(err)
    } catch {
      // The log is gone (a closed stderr, say): there is nowhere left to say it.
    }
  }

  return (type, data) => {
    try {
      Promise.resolve(aside(type, data)).catch(failed)
    } catch (err) {
      failed(err)
    }
    return main(type, data)
  }
}
