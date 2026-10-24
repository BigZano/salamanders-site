// Stand-in for a lazily imported component graph in dynamicImportGuard.test.js: the loader has
// to wait for the top-level await, as it does for a component that imports other components.
await new Promise((resolve) => setTimeout(resolve, 40))
globalThis.__slowModuleEvaluated = true
export default 'slow'
