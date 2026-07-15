import { createRouter, createWebHashHistory } from 'vue-router'
import Landing from './views/Landing.vue'

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
]

export const router = createRouter({
  // Hash history: works on any GitHub Pages path with zero config and no
  // 404 fallback needed. Switch to createWebHistory once a domain is set.
  history: createWebHashHistory(),
  routes,
  scrollBehavior() {
    return { top: 0 }
  },
})

router.afterEach((to) => {
  const t = to.meta?.title
  document.title = t ? `Salamanders — ${t}` : 'Salamanders — SM2 Clan'
})
