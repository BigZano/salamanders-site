import { afterEach, vi } from 'vitest'

// A test that mounts a view with lazy (defineAsyncComponent) children can finish before those imports
// do. vitest 4 tears the environment down at the end of the file and reports every import still in flight
// as an EnvironmentTeardownError, which fails the run even though every test passed (vitest 3 ignored
// them). Settle them between tests; see src/test-utils/dynamicImportGuard.test.js.
afterEach(() => vi.dynamicImportSettled())

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
