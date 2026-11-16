import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

// The site's Content-Security-Policy, against the production build (the `web-prod` service in docker-compose.yml: `vite build`
// with VITE_BUILDS_API_URL=https://api.e2e.invalid, served by `vite preview`). The policy is a <meta> tag the build writes into
// index.html (scripts/csp.mjs), so it exists only in a built page; the dev server the other specs use has none.
//
// Every page that shows something members, Discord or the gallery's storage supply is visited, signed in as a reader of all of
// it, and the browser's own `securitypolicyviolation` events are counted: there must be none. Nothing leaves the stack. The
// api and Discord's sign-in check are answered here, with invented data, by `context.route`. Every other address a page may ask
// for is answered or refused here too, and its host noted (see `reached`): a picture or a clip, from any host, with a file of the
// mock's own; a clip player's frame, a script or a call, refused. The policy is judged before the network is, so a refusal
// that is the network's (a frame that cannot load) makes no event, and only the policy's own makes one. That an address got
// as far as `reached` is how this spec knows the policy lets it through, so the pages are fed the very addresses it names.
//
// The api and the people in it are invented, as in the other specs: the ids are in the range the Librarius fixtures use. The one
// picture and the one clip that every picture and clip is answered with are the mock's own fixtures.
const fixture = (name) => readFileSync(new URL(`../discord-mock/fixtures/${name}`, import.meta.url))
const PICTURE = fixture('art.png')
const CLIP = fixture('clip.webm')
const PROD = process.env.PROD_URL || 'http://web-prod:4173'
const API = 'https://api.e2e.invalid'
const DISCORD = 'https://discord.com/api'
const TOKEN = 'e2e-csp-token'

const GUILD = '1322056087792521269'
const FORUM = '200000000000000400'
const POST = '200000000000000410'
const READER = '200000000000000402'
const EMOJI = '200000000000000430'
const AUTHOR = '200000000000000440'
const SECOND_AUTHOR = '200000000000000441'
const TAG = '200000000000000420'
const NOW = new Date().toISOString()

// What the picture addresses are, on the hosts the policy names for pictures.
const CDN = 'https://cdn.discordapp.com'
const PROXY = 'https://media.discordapp.net'
const R2 = 'https://e2e-csp.r2.cloudflarestorage.com'

// --- What the api answers, by route ---

const author = (id, name) => ({ id, name, avatar: `${CDN}/avatars/${id}/${'a'.repeat(32)}.png?size=64` })

const MESSAGES = [
  {
    id: POST,
    authorId: AUTHOR,
    authorName: 'E2E Scribe',
    authorAvatar: `${CDN}/avatars/${AUTHOR}/${'a'.repeat(32)}.png?size=64`,
    content: `The opening message, with a custom emoji <:e2e_aquila:${EMOJI}> in it, and **bold** text.`,
    createdAt: NOW,
    editedAt: null,
    replyTo: null,
    attachments: [
      {
        id: '200000000000000451',
        filename: 'e2e-picture.png',
        contentType: 'image/png',
        size: 4096,
        width: 64,
        height: 64,
        url: `${CDN}/attachments/200000000000000450/200000000000000451/e2e-picture.png?ex=7fffffff&is=1&hm=2`,
      },
    ],
    embeds: [
      {
        type: 'link',
        url: 'https://example.invalid/e2e',
        title: 'An embedded link',
        description: 'What the link says about itself.',
        provider: 'E2E',
        thumbnail: { url: `${PROXY}/external/e2e-thumb.png`, width: 64, height: 64 },
        image: { url: `${PROXY}/external/e2e-image.png`, width: 128, height: 64 },
      },
    ],
    stickers: [],
    reactions: [
      { key: `c:${EMOJI}`, id: EMOJI, name: 'e2e_aquila', animated: false, count: 3 },
      { key: 'u:👍', id: null, name: '👍', animated: false, count: 2 },
    ],
    origin: 'discord',
  },
  {
    id: '200000000000000461',
    authorId: SECOND_AUTHOR,
    authorName: 'E2E Archivist',
    authorAvatar: null,
    content: 'A reply, quoting the opening message.',
    createdAt: NOW,
    editedAt: null,
    replyTo: { id: POST, authorId: AUTHOR, authorName: 'E2E Scribe', content: 'The opening message' },
    attachments: [],
    embeds: [],
    stickers: [],
    reactions: [],
    origin: 'discord',
  },
]
const PEOPLE = { [AUTHOR]: { name: 'E2E Scribe', avatar: `${CDN}/avatars/${AUTHOR}/${'a'.repeat(32)}.png?size=64` }, [SECOND_AUTHOR]: { name: 'E2E Archivist', avatar: null } }

const POST_INFO = { id: POST, ownerId: AUTHOR, title: 'E2E Active Post', tagIds: [TAG], pinned: false, locked: false, archived: false, createdAt: NOW, replies: 1 }

const CLIPS = [
  {
    id: 'e2e-clip-stored',
    kind: 'clip',
    source: 'discord',
    media: 'video',
    status: 'approved',
    title: 'A stored clip',
    url: `${R2}/e2e-bucket/clips/e2e-clip.mp4?X-Amz-Algorithm=e2e&X-Amz-Signature=e2e`,
    contentType: 'video/mp4',
    bytes: 2048,
    postedAt: NOW,
    author: { name: 'E2E Scribe' },
  },
  {
    id: 'e2e-clip-youtube',
    kind: 'clip',
    source: 'discord',
    media: 'embed',
    status: 'approved',
    title: 'A YouTube clip',
    url: 'https://youtu.be/e2eCspYT001',
    contentType: null,
    bytes: null,
    postedAt: NOW,
    author: { name: 'E2E Archivist' },
  },
]

const BUILD = {
  id: 'e2e-build',
  title: 'An E2E build',
  className: 'Tactical',
  level: 25,
  prestige: 0,
  role: 'Support',
  notes: 'Invented.',
  author: { id: AUTHOR, displayName: 'E2E Scribe', member: true },
  weapons: { primary: null, secondary: null, melee: null },
  perks: [],
  prestigePicks: [],
  createdAt: NOW,
}

const PUBLIC_ROSTER = {
  fetchedAt: NOW,
  stale: false,
  highCommand: [],
  branches: [
    {
      key: 'company-3',
      kind: 'company',
      label: '3rd',
      number: 3,
      head: { rank: { key: 'captain', label: 'Captain', tier: 1 }, vacant: false, members: [{ name: 'E2E Captain' }] },
      aside: 0,
      rows: [],
    },
  ],
}

/** → [status, body] for a call of the invented api (a body of null is sent as no content), else null, which is answered with 404. */
function answer(method, pathname) {
  const post = new RegExp(`^/librarius/posts/${POST}`)
  const routes = {
    'GET /membership': { member: true },
    'GET /privileges/me': { id: READER, editor: false, historyViewer: false, moderator: false, revoked: false, revoker: null },
    'GET /builds': [BUILD],
    'GET /builds/moderator': { moderator: false },
    'GET /roster/public': PUBLIC_ROSTER,
    'GET /gallery/me': { access: true, approver: false },
    'GET /gallery/clips': { items: CLIPS, next: null },
    'GET /gallery/art': { items: [], next: null },
    'GET /librarius/me': {
      access: true,
      ready: true,
      tags: [{ id: TAG, name: 'E2E Tag' }],
      roles: [{ id: '200000000000000401', name: 'E2E Reader', color: '#3a5246' }],
      guildId: GUILD,
      forumId: FORUM,
    },
    'GET /librarius/emoji': { emoji: [{ id: EMOJI, name: 'e2e_aquila', animated: false }] },
    'GET /librarius/posts': {
      posts: [
        {
          ...POST_INFO,
          lastActivityAt: NOW,
          unread: 1,
          latest: {
            id: '200000000000000461',
            authorId: SECOND_AUTHOR,
            authorName: 'E2E Archivist',
            authorAvatar: null,
            content: 'A reply, with a picture.',
            image: { id: '200000000000000451', url: `${CDN}/attachments/200000000000000450/200000000000000451/e2e-picture.png?ex=7fffffff&is=1&hm=2`, expiresAt: null },
          },
          posterIds: [SECOND_AUTHOR, AUTHOR],
        },
      ],
      people: PEOPLE,
    },
    'GET /deathwatch/me': { access: true, watchCommander: false, deathwatchCommand: false },
    'GET /deathwatch/data': { teams: {}, cfg: {}, archive: {} },
    'GET /deathwatch/deployment': { deployed: false },
  }
  const found = routes[`${method} ${pathname}`]
  if (found !== undefined) return [200, found]
  if (method === 'GET' && pathname === `/librarius/posts/${POST}`) return [200, { post: POST_INFO, lastRead: null, rev: '9' }]
  if (method === 'GET' && post.test(pathname) && pathname.endsWith('/messages')) {
    return [200, { messages: MESSAGES, hasOlder: false, hasNewer: false, people: PEOPLE, rev: '9' }]
  }
  if (method === 'GET' && post.test(pathname) && pathname.endsWith('/changes')) return [200, { messages: [], deleted: [], rev: '9', people: {} }]
  if (method === 'PUT' && post.test(pathname) && pathname.endsWith('/read')) return [204, null]
  return null
}

// --- The browser, with nothing outside it ---

// What a page may do across origins: the site asks with an Authorization header, so it is preflighted.
const CORS = {
  'access-control-allow-origin': new URL(PROD).origin,
  'access-control-allow-headers': 'authorization, content-type, if-none-match',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-expose-headers': 'ETag',
}

/**
 * Sets a context up: answers the api and Discord's sign-in check, answers every picture or clip asked of any other address with
 * the mock's own file and refuses the rest (each noted by host in `reached`), and collects each policy violation in the list it
 * returns. A violation is collected from every page and frame of the context, and survives the page being left.
 */
async function arm(context) {
  const violations = []
  const reached = new Set()
  await context.exposeFunction('reportViolation', (v) => violations.push(v))
  await context.addInitScript(() => {
    window.addEventListener(
      'securitypolicyviolation',
      (e) => window.reportViolation(`${e.effectiveDirective} refused ${e.blockedURI || 'inline'} on ${location.pathname}`),
      true,
    )
  })

  // Routes run last-registered first, so this one, which takes everything else, is the last to be asked. A picture or a clip
  // loads (from the files of the mock), so that the page draws it and a test can find it; a frame, a script or a call is refused.
  await context.route(
    (url) => url.origin !== new URL(PROD).origin,
    (route) => {
      const request = route.request()
      reached.add(new URL(request.url()).hostname)
      if (request.resourceType() === 'image') return route.fulfill({ status: 200, contentType: 'image/png', body: PICTURE })
      if (request.resourceType() === 'media') return route.fulfill({ status: 200, contentType: 'video/webm', body: CLIP })
      return route.abort('failed')
    },
  )
  await context.route(`${DISCORD}/**`, (route) => {
    const { pathname } = new URL(route.request().url())
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const body = pathname === '/api/users/@me' ? { id: READER, username: 'e2e-csp-reader' } : { message: 'Not found' }
    return route.fulfill({ status: pathname === '/api/users/@me' ? 200 : 404, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) })
  })
  await context.route(`${API}/**`, (route) => {
    const request = route.request()
    reached.add(new URL(request.url()).hostname)
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const found = answer(request.method(), new URL(request.url()).pathname)
    if (found === null) return route.fulfill({ status: 404, contentType: 'application/json', headers: CORS, body: JSON.stringify({ error: 'Not found.' }) })
    const [status, body] = found
    if (body === null) return route.fulfill({ status, headers: CORS })
    return route.fulfill({ status, contentType: 'application/json', headers: { ...CORS, ETag: '"e2e"' }, body: JSON.stringify(body) })
  })
  return { violations, reached }
}

/** Signs in on the production site as the reader of everything: the callback of an implicit grant, as the other specs do. */
async function signIn(page) {
  await page.goto(`${PROD}/#access_token=${TOKEN}&expires_in=3600`)
  await expect(page.locator('.auth-name')).toBeVisible()
}

const settle = async (page) => {
  await page.waitForLoadState('networkidle')
  // A violation is an event of its own, a moment after the request that caused it.
  await page.waitForTimeout(500)
}

// --- The pages ---

// Each: where it is, what shows when it has drawn what the api gave it, and what a reader does on it that the policy must allow.
const PAGES = [
  { name: 'the home page', path: '/', ready: (page) => expect(page.locator('.nav-bar')).toBeVisible() },
  { name: 'the perk builder', path: '/planner', ready: (page) => expect(page.getByRole('heading', { name: 'Perk Builder', level: 1 })).toBeVisible() },
  { name: 'the armoury', path: '/armoury', ready: (page) => expect(page.getByRole('heading', { name: 'Weapon Armoury', level: 1 })).toBeVisible() },
  { name: 'the builds', path: '/builds', ready: (page) => expect(page.getByText('An E2E build')).toBeVisible() },
  { name: 'the companies', path: '/companies', ready: (page) => expect(page.getByRole('heading', { name: 'Companies & Sections', level: 1 })).toBeVisible() },
  // The Accolades are sealed and opened with WebCrypto, which a page served over plain http from another host does not have: all
  // that is asked of it here is that it gets as far as its gate.
  { name: 'the accolades', path: '/accolades', ready: (page) => expect(page.locator('main, #app').first()).toBeVisible() },
  {
    name: 'the clips, a stored video and a YouTube player',
    path: '/reliquarium/clips',
    ready: async (page) => {
      const video = page.locator('video.rq-video')
      await expect(video).toHaveAttribute('src', new RegExp(`^${R2}/e2e-bucket/clips/`))
      // It loads: the bucket is one the policy lets a clip be played from.
      await expect.poll(() => video.evaluate((v) => v.readyState)).toBeGreaterThanOrEqual(1)
      const card = page.locator('.rq-card', { hasText: 'A YouTube clip' })
      await card.getByRole('button', { name: 'Play' }).click()
      await expect(card.locator('iframe.rq-frame')).toHaveAttribute('src', 'https://www.youtube.com/embed/e2eCspYT001?rel=0')
    },
    reaches: [new URL(R2).hostname, 'www.youtube.com'],
  },
  {
    name: 'the Librarius topic list, with a picture and avatars from Discord',
    path: '/reliquarium/librarius',
    ready: (page) => expect(page.locator('a.lb-topic', { hasText: 'E2E Active Post' })).toBeVisible(),
    reaches: ['cdn.discordapp.com'],
  },
  {
    name: 'a Librarius post, with a picture, a custom emoji and an embed',
    path: `/reliquarium/librarius/${POST}`,
    ready: async (page) => {
      await expect(page.locator('.lb-msg')).toHaveCount(2)
      await expect(page.locator('img.lb-image')).toHaveAttribute('src', new RegExp(`^${CDN}/attachments/`))
      // In the text, and on the reaction.
      const emoji = page.locator('img.lb-emoji')
      await expect(emoji).toHaveCount(2)
      for (const src of await emoji.evaluateAll((nodes) => nodes.map((node) => node.src))) expect(src).toMatch(new RegExp(`^${CDN}/emojis/${EMOJI}\\.webp`))
      await expect(page.locator('img.lb-embed-thumb')).toHaveAttribute('src', new RegExp(`^${PROXY}/external/`))
    },
    reaches: ['cdn.discordapp.com', 'media.discordapp.net'],
  },
  { name: 'the Deathwatch hub', path: '/deathwatch', ready: (page) => expect(page.getByRole('heading', { name: 'Watch Fortress Ebonhold', level: 1 })).toBeVisible() },
]

test.describe('the production build\'s Content-Security-Policy', () => {
  for (const { name, path, ready, reaches = [] } of PAGES) {
    test(`${name} breaks no part of the policy`, async ({ context, page }) => {
      const { violations, reached } = await arm(context)
      await signIn(page)
      await page.goto(`${PROD}${path}`)
      await ready(page)
      await settle(page)
      expect(violations).toEqual([])
      // The page asked for what the policy was written to let through: the addresses got as far as the network.
      for (const host of reaches) expect([...reached], `${host} was asked for`).toContain(host)
    })
  }

  test('the policy is on the page, is enforced, and the violation probe sees what it refuses', async ({ context, page }) => {
    const { violations } = await arm(context)
    await page.goto(`${PROD}/`)
    await expect(page.locator('.nav-bar')).toBeVisible()

    // The build wrote the policy, with the api address it was given, and nothing that lets a script of the page's own through.
    const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
    expect(policy).toContain("connect-src 'self' https://api.e2e.invalid https://discord.com")
    expect(policy).toMatch(/(^|; )script-src 'self'( 'sha256-[A-Za-z0-9+\/]{43}=')*(;|$)/)
    expect(policy.split(';').find((d) => d.trim().startsWith('script-src'))).not.toContain('unsafe')

    // What it allows goes out: the invented api's origin is the one the policy was given.
    const allowed = await page.evaluate((url) => fetch(url).then((r) => r.status), `${API}/membership`)
    expect(allowed).toBe(200)
    expect(violations).toEqual([])

    // What it does not: a script of the page's own, a picture, a frame and a call, each to somewhere it does not name.
    const outcome = await page.evaluate(async () => {
      window.pwned = false
      const script = document.createElement('script')
      script.textContent = 'window.pwned = true'
      document.body.append(script)
      const img = document.createElement('img')
      img.src = 'https://elsewhere.e2e.invalid/x.png'
      document.body.append(img)
      const frame = document.createElement('iframe')
      frame.src = 'https://elsewhere.e2e.invalid/'
      document.body.append(frame)
      const call = await fetch('https://elsewhere.e2e.invalid/').then(() => 'went out', () => 'refused')
      return { pwned: window.pwned, call }
    })
    expect(outcome).toEqual({ pwned: false, call: 'refused' })
    await expect.poll(() => violations.length).toBeGreaterThanOrEqual(4)
    const directives = violations.map((v) => v.split(' ')[0])
    expect(directives).toEqual(expect.arrayContaining(['script-src-elem', 'img-src', 'frame-src', 'connect-src']))
  })
})
