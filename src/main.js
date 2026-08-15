import { createApp } from 'vue'
import { createPinia } from 'pinia'
import '@fontsource-variable/oswald'
import './style.css'
import App from './App.vue'
import { router } from './router'
import { finishSignIn } from './lib/discordAuth'

// The hash fragment itself is already scrubbed by the time this file's own
// body runs (router.js does that first — see scrubCallbackHash there). This
// just finishes the identify + membership check before mounting.
finishSignIn().finally(() => {
  createApp(App).use(createPinia()).use(router).mount('#app')
})
