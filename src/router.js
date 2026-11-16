import { createRouter, createWebHistory } from 'vue-router'
import Landing from './views/Landing.vue'
import { scrubCallbackHash } from './lib/discordAuth'
import { legacyRosterTarget } from './lib/companyKeys'
import { deathwatchRedirect } from './lib/deathwatch/redirect'
import { DEATHWATCH_SHOWS_MOUNTAIN } from './lib/deathwatch/mountain'

// Must run before createWebHashHistory() below reads location.hash — see
// discordAuth.js for why this can't just happen in main.js.
scrubCallbackHash()

// Loaded on demand, and the one page for both Reliquarium routes, so a tab and a post are never two page loads.
const reliquarium = () => import('./views/Reliquarium.vue')

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
    path: '/reports',
    name: 'reports',
    component: () => import('./views/Reports.vue'),
    meta: { title: 'Reports' },
  },
  {
    path: '/reports/review',
    name: 'reports-review',
    component: () => import('./views/ReportsReview.vue'),
    meta: { title: 'Report Review' },
  },
  // The Librarius and the members' galleries of clips and art. The tab is part of the address so a tab can be linked;
  // the page itself falls back to the first tab the person may see for one they may not (the Librarius, else Clips).
  {
    path: '/reliquarium/:tab(librarius|clips|art|submit|mine|review)?',
    name: 'reliquarium',
    component: reliquarium,
    meta: { title: 'Reliquarium' },
  },
  // One post of the Librarius, on the same page as the tabs: the page shows the post in place of the list.
  {
    path: '/reliquarium/librarius/:postId(\\d{17,20})',
    name: 'reliquarium-post',
    component: reliquarium,
    meta: { title: 'Reliquarium' },
  },
  {
    path: '/history',
    name: 'history',
    component: () => import('./views/History.vue'),
    meta: { title: 'Version History' },
  },
  // The roster moved onto /companies; old links (and bookmarks, with their #branch-key) still land.
  { path: '/roster', redirect: legacyRosterTarget },
  {
    path: '/accolades/legacy',
    name: 'legacy-accolades',
    component: () => import('./views/LegacyAccolades.vue'),
    meta: { title: 'Legacy Accolades', ashOver: true },
  },
  // Watch Fortress Ebonhold: the Deathwatch community's area. The layout puts the theme and the access gate
  // around every page under it, so nothing below needs to check access itself. The area pages' addresses
  // are kept canonical by deathwatchRedirect, the router.beforeEach guard registered below.
  {
    path: '/deathwatch',
    component: () => import('./views/deathwatch/DeathwatchLayout.vue'),
    // (`deathfire`: whether Mount Deathfire is drawn behind these pages. Deathwatch is off planet, so it is not,
    // unless its keeper flips the switch in lib/deathwatch/mountain.js. `ashOver` then brings the ash back with it.)
    meta: { title: 'Watch Fortress Ebonhold', ashOver: true, deathfire: DEATHWATCH_SHOWS_MOUNTAIN },
    children: [
      { path: '', name: 'deathwatch', component: () => import('./views/deathwatch/DeathwatchHub.vue') },
      {
        path: ':area/:tab?/:sub?',
        name: 'deathwatch-area',
        component: () => import('./views/deathwatch/DeathwatchArea.vue'),
      },
    ],
  },
  ...[
    { key: 'accolades', title: 'Accolades' },
    { key: 'ranks', title: 'Ranks' },
  ].map(({ key, title }) => ({
    path: `/${key}/:threadId(\\d{17,20})?`,
    name: key,
    component: () => import('./views/ArchiveView.vue'),
    props: (r) => ({ collectionKey: key, threadId: r.params.threadId || null }),
    // Near ash falls over the plaque, not behind it (MountDeathfire).
    meta: { title, ashOver: true },
  })),
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('./views/NotFound.vue'),
    meta: { title: 'Not found' },
  },
]

// The Librarius's two addresses, as they scroll: a post, and the topic list. A trailing slash is the same address. (/reliquarium
// with no tab is not the list: for someone who may read the galleries only it is the Clips, and that goes to the top as ever.)
const LIBRARIUS_POST = /^\/reliquarium\/librarius\/\d{17,20}\/?$/
const LIBRARIUS_LIST = /^\/reliquarium\/librarius\/?$/

export const router = createRouter({
  // Clean URLs now that we're on a real domain. GitHub Pages still has no
  // server-side rewrite, so a direct load of a deep route relies on the
  // public/404.html + index.html pair to restore the path before this
  // constructor reads it — see those files for the mechanism.
  history: createWebHistory(),
  routes,
  // Legion Archive threads scroll to their own #m-<id> anchors once decrypted
  // content has rendered (see ArchiveThread.vue); same-page hash changes
  // are left to them.
  scrollBehavior(to, from, savedPosition) {
    // A Librarius post (see PostPage.vue) puts the reader where they mean to be once its messages are there: at the message
    // its address names, else at the divider, else at the newest message, and on Back at the one that was topmost. A jump
    // to the top here would come first, and a jump to a saved position would be to a page that is not yet tall enough.
    if (LIBRARIUS_POST.test(to.path)) return false
    // The topic list, on Back, is where the reader left it: the store still holds its rows, so the page is tall at once.
    if (savedPosition && LIBRARIUS_LIST.test(to.path)) return savedPosition
    if (to.hash && to.path === from.path) return false
    // /companies#third is scrolled to by the page itself: as soon as its story is there, and again when
    // the roster has changed the layout above it. A jump to the top here would undo the first of those.
    if (to.hash && to.path === '/companies') return false
    return { top: 0 }
  },
})

// One address for every Deathwatch page, on entry and on a change of tab alike (see redirect.js).
router.beforeEach(deathwatchRedirect)

router.afterEach((to) => {
  const t = to.meta?.title
  document.title = t ? `Salamanders — ${t}` : 'Salamanders — SM2 Clan'
})
