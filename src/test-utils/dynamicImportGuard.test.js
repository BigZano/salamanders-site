import { describe, it, expect } from 'vitest'

// vitest.setup.js settles in-flight dynamic imports after every test. Without it, a test that mounts a view
// with lazy (defineAsyncComponent) children can end before those imports do; vitest 4 then tears the
// environment down mid-import and fails the whole run with EnvironmentTeardownError, though every test passed.
//
// These two tests depend on running in order, on purpose: the first starts a slow import and ends without
// waiting for it; the second checks that the shared hook already waited.
describe('the shared afterEach hook', () => {
  it('a test may start a lazy import and finish without waiting for it', () => {
    expect(globalThis.__slowModuleEvaluated).toBeUndefined()
    import('./slowModule.js')
    expect(globalThis.__slowModuleEvaluated).toBeUndefined() // still loading when this test ends
  })

  it('has already waited for that import before the next test starts', () => {
    expect(globalThis.__slowModuleEvaluated).toBe(true)
  })
})
