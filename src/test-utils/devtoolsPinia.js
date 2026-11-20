// What Pinia's devtools plugin does to an options store in a dev build (pinia.js patchActionForGrouping): every call of an action
// is given a new Proxy of the store as its `this`, one for each call. The plugin is off under test (NODE_ENV is 'test') and in a
// production build, so a store's tests never meet it unless they put it on, as devtoolsPinia() does.
import { createApp, toRaw } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const handler = {
  get: (...args) => Reflect.get(...args),
  set: (...args) => Reflect.set(...args),
}

/** → a new Proxy of `store`, as the devtools plugin makes one for each call of an action. */
export const trackedStore = (store) => new Proxy(store, handler)

function devtoolsActions({ store, options }) {
  for (const name of Object.keys(options.actions)) {
    const action = toRaw(store)[name]
    store[name] = function (...args) {
      return action.apply(trackedStore(store), args)
    }
  }
}

/**
 * Makes a Pinia whose options stores run their actions as a dev build does, and makes it the active one. It is installed in an app
 * first: a plugin only reaches the stores made after its Pinia has one.
 */
export function devtoolsPinia() {
  const pinia = createPinia()
  createApp({}).use(pinia)
  pinia.use(devtoolsActions)
  setActivePinia(pinia)
  return pinia
}
