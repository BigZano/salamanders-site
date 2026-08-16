import { createRouter, createWebHistory } from 'vue-router'
import Landing from './views/Landing.vue'
import { scrubCallbackHash } from './lib/discordAuth'

// Must run before createWebHashHistory() below reads location.hash — see
// discordAuth.js for why this can't just happen in main.js.
scrubCallbackHash()

const routes = [
  { path: '/', name: 'home', component: Landing, meta: { title: 'Home' } },
  {
    path: '/planner',
    name: 'planner',
    component: () => import('./views/Planner.vue'),
    meta: { title: 'Perk Builder' },
  },
  {
    path: '/armoury',
    name: 'armoury',
    component: () => import('./views/Armoury.vue'),
    meta: { title: 'Armoury' },
  },
  {
    path: '/builds',
    name: 'builds',
    component: () => import('./views/Builds.vue'),
    meta: { title: 'Builds' },
  },
  {
    path: '/companies',
    name: 'companies',
    component: () => import('./views/Companies.vue'),
    meta: { title: 'Companies' },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('./views/NotFound.vue'),
    meta: { title: 'Not found' },
  },
]

export const router = createRouter({
  // Clean URLs now that we're on a real domain. GitHub Pages still has no
  // server-side rewrite, so a direct load of a deep route relies on the
  // public/404.html + index.html pair to restore the path before this
  // constructor reads it — see those files for the mechanism.
  history: createWebHistory(),
  routes,
  scrollBehavior() {
    return { top: 0 }
  },
})

router.afterEach((to) => {
  const t = to.meta?.title
  document.title = t ? `Salamanders — ${t}` : 'Salamanders — SM2 Clan'
})
