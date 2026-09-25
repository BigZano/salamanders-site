// Node 25+ defines its own localStorage/sessionStorage globals, which shadow
// jsdom's in test files that use the jsdom environment (and are undefined
// without --localstorage-file). Point them back at jsdom's own window — vitest
// exposes the instance as globalThis.jsdom. This works however vitest is
// launched: plain runs, coverage, and Stryker's runner alike.
const dom = globalThis.jsdom
if (dom?.window) {
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true })
  }
}
