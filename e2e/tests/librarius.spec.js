import { test, expect } from '@playwright/test'

// The Librarius pages against the e2e stack: the site (dev server), the api, postgres and discord-mock, which stands in for
// Discord (the forum, its posts, and a gateway the api listens to). The tokens and ids are the invented ones in
// e2e/discord-mock/server.js. Same fragment-callback sign-in as the other browser specs.
//
// librarius-api.spec.js runs at the same time, in another worker, as the same librarian. It only READS the active post
// (...410) and does all its writing in the archived one (...411), so this file may read the active post and post into it, and
// must not count anything in the archived one. The active post starts with 230 messages: its own and 229 replies.
//
// Nothing leaves the stack: the page may reach the site, the api and the mock, and any other address (the CDN links of the
// attachments the mock hands out, say) is refused before it goes anywhere.
//
// The librarian has read nothing when the run begins, so the first opening of the active post is the newest page; the tests
// run in order, and once the librarian has read something a later opening is around the message read to instead (the live test
// sets that to the newest message itself, so that it does not depend on what the page happened to have in view).
const API = process.env.API_URL || 'http://api:8787'
const MOCK = process.env.DISCORD_MOCK_URL || 'http://discord-mock:4400'

const GUILD = '1322056087792521269'
const FORUM = '200000000000000400'
const ACTIVE = '200000000000000410'
const ARCHIVED = '200000000000000411'

const LIBRARIAN = 'test-librarian-token'
const SHUT_OUT = 'test-shut-out-token'

const RUN = Date.now().toString(36)

async function signIn(page, token) {
  await page.goto(`/#access_token=${token}&expires_in=3600`)
  await expect(page.locator('.auth-name')).toBeVisible()
}

const reliquariumLink = (page) => page.locator('.nav-links').getByRole('link', { name: 'Reliquarium' })
const topic = (page, title) => page.locator('a.lb-topic', { hasText: title })
// What the api holds as the librarian's read mark in the active post, as the api says it.
async function lastRead(request) {
  const res = await request.get(`${API}/librarius/posts/${ACTIVE}`, { headers: { Authorization: `Bearer ${LIBRARIAN}` } })
  expect(res.status()).toBe(200)
  return (await res.json()).lastRead
}

test.describe('Librarius pages', () => {
  test.describe.configure({ mode: 'serial' })

  // The api is importing the forum when the stack comes up, and the pages answer "being brought over" until it is done.
  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(90_000)
    const request = await playwright.request.newContext()
    try {
      const done = async () => {
        const res = await request.get(`${API}/librarius/me`, { headers: { Authorization: `Bearer ${LIBRARIAN}` } })
        return res.status() === 200 && (await res.json()).ready
      }
      await expect.poll(done, { timeout: 75_000, intervals: [500], message: 'the import is done' }).toBe(true)
    } finally {
      await request.dispose()
    }
  })

  test.beforeEach(async ({ context }) => {
    await context.route(
      (url) => !['localhost', 'api', 'discord-mock'].includes(url.hostname),
      (route) => route.abort('failed'),
    )
  })

  test('a reader without the Legion role gets the Reliquarium with the Librarius tab, and no other', async ({ page }) => {
    await signIn(page, LIBRARIAN)
    // The nav offers the Reliquarium, and none of the member pages that the Legion role opens.
    await expect(reliquariumLink(page)).toBeVisible()
    await expect(page.locator('.nav-links').getByRole('link', { name: 'Accolades' })).toHaveCount(0)
    await expect(page.locator('.nav-links').getByRole('link', { name: 'Reports' })).toHaveCount(0)

    await page.goto('/reliquarium')
    const tabs = page.getByRole('navigation', { name: 'Reliquarium sections' }).getByRole('link')
    await expect(tabs).toHaveText(['Librarius'])
    await expect(tabs).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('.lb-topics')).toBeVisible()
    // The galleries are shut to them: nothing of Clips, Artwork, Submit or Mine is on the page.
    await expect(page.locator('.rq-grid, .rq-card')).toHaveCount(0)
  })

  test('someone the forum shuts out is turned away, with no tab and no nav link', async ({ page }) => {
    // They hold the reader role, but a member overwrite on the forum denies them View Channel.
    await signIn(page, SHUT_OUT)
    await expect(reliquariumLink(page)).toHaveCount(0)
    await page.goto('/reliquarium')
    await expect(page.getByText('Restricted to the XVIIIth Legion.')).toBeVisible()
    await expect(page.locator('.rq-tabs')).toHaveCount(0)
    await expect(page.locator('.lb-topics')).toHaveCount(0)
    // Said again now that the page has answered: the link was absent before sign-in settled, and must not have come back since.
    await expect(reliquariumLink(page)).toHaveCount(0)
    // A link straight to a post says no all the same.
    await page.goto(`/reliquarium/librarius/${ACTIVE}`)
    await expect(page.getByText('Restricted to the XVIIIth Legion.')).toBeVisible()
    await expect(page.locator('.lb-msg')).toHaveCount(0)
  })

  test('the topic list shows both posts, the archived one behind "Show archived"', async ({ page }) => {
    await signIn(page, LIBRARIAN)
    await page.goto('/reliquarium/librarius')
    const active = topic(page, 'E2E Active Post')
    await expect(active).toBeVisible()
    await expect(active).toHaveAttribute('href', `/reliquarium/librarius/${ACTIVE}`)
    await expect(active.locator('.lb-tag')).toHaveText('E2E Tag')
    // The newest message (reply 229) is the Archivist's, and the row says so.
    await expect(active).toContainText('E2E Archivist')
    await expect(active).toContainText('E2E message 229')

    const archived = topic(page, 'E2E Archived Post')
    await expect(archived).toHaveCount(0)
    const show = page.getByRole('button', { name: /^Show archived/ })
    await expect(show).toHaveText('Show archived (1)')
    await show.click()
    await expect(archived).toBeVisible()
    await expect(archived).toHaveAttribute('href', `/reliquarium/librarius/${ARCHIVED}`)
    await expect(page.getByRole('button', { name: /^Hide archived/ })).toBeVisible()
    await page.getByRole('button', { name: /^Hide archived/ }).click()
    await expect(archived).toHaveCount(0)

    // Posts are started in Discord, in the forum itself.
    await expect(page.getByRole('link', { name: /Start a post in Discord/ })).toHaveAttribute('href', `https://discord.com/channels/${GUILD}/${FORUM}`)
  })

  test('a post opens on its newest 50 messages with its opening message pinned on top, and Load older brings the rest', async ({ page, request }) => {
    test.setTimeout(90_000)
    expect(await lastRead(request), 'a fresh stack: the librarian has read nothing yet').toBeNull()

    await signIn(page, LIBRARIAN)
    await page.goto('/reliquarium/librarius')
    await topic(page, 'E2E Active Post').click()
    await expect(page).toHaveURL(new RegExp(`/reliquarium/librarius/${ACTIVE}$`))

    const messages = page.locator('.lb-thread .lb-msg')
    // The opening message, above "Load older", and the newest 50 replies below it.
    await expect(messages).toHaveCount(51)
    await expect(messages.first()).toHaveAttribute('id', `m-${ACTIVE}`)
    await expect(messages.first()).toHaveClass(/lb-article/)
    await expect(messages.first()).toContainText('E2E opening message')
    await expect(messages.last()).toContainText('E2E message 229')
    await expect(page.locator('.lb-post-title')).toHaveText('E2E Active Post')
    await expect(page.locator('.lb-post-meta')).toContainText('E2E Tag')
    await expect(page.locator('.lb-post-meta')).toContainText('229 replies')

    // "Open in Discord" is the post's own link in the guild.
    const discord = page.getByRole('link', { name: /Open in Discord/ })
    await expect(discord).toHaveAttribute('href', `https://discord.com/channels/${GUILD}/${ACTIVE}`)
    await expect(discord).toHaveAttribute('target', '_blank')
    await expect(discord).toHaveAttribute('rel', /noopener/)

    // A reply to a message that is not on the page quotes it: who wrote it, and what it said.
    const quoting = page.locator('.lb-msg', { hasText: 'E2E message 228 quoting message 3' })
    await expect(quoting.locator('.lb-reply')).toContainText('replying to E2E Archivist')
    await expect(quoting.locator('.lb-reply-quote')).toHaveText('E2E message 3')
    // An attachment that is not on Discord's CDN never reached the page, and one that is, though its link was about to lapse, did.
    const offCdn = page.locator('.lb-msg', { hasText: 'E2E message 227 with an attachment' })
    await expect(offCdn).toBeVisible()
    await expect(offCdn.locator('.lb-attachment')).toHaveCount(0)
    await expect(page.locator('.lb-msg', { hasText: 'E2E message 226 with an attachment' }).locator('.lb-attachment')).toHaveCount(1)
    await expect(page.locator('.lb-attachment')).toHaveCount(1)

    const older = page.getByRole('button', { name: 'Load older' })
    await older.click()
    await expect(messages).toHaveCount(101)
    // Four pages bring everything back to the first reply: 229 replies in all, and the opening message once.
    for (let pages = 1; (await older.count()) > 0; pages++) {
      expect(pages, 'pages of older messages').toBeLessThan(8)
      await older.click()
      await expect.poll(() => messages.count()).toBeGreaterThan(50 * pages + 51)
    }
    await expect(messages).toHaveCount(230)
    await expect(older).toHaveCount(0)

    const ids = await messages.evaluateAll((nodes) => nodes.map((node) => node.id))
    expect(new Set(ids).size, 'no message twice').toBe(ids.length)
    expect(ids[0]).toBe(`m-${ACTIVE}`)
    const numbers = ids.map((id) => BigInt(id.slice(2)))
    expect(numbers).toEqual([...numbers].sort((a, b) => (a < b ? -1 : 1)))
    // The text of the message itself, whole: "E2E message 1", and not one of the many (10, 11, 100...) that start with it.
    await expect(messages.nth(1).locator('.lb-body')).toHaveText('E2E message 1')

    // Reading it through marks it read: the browser's PUT is allowed to the api from the site's address, and the api keeps it.
    await expect.poll(() => lastRead(request), { timeout: 15_000, message: 'the page reports what it was read to' }).not.toBeNull()
    expect(ids).toContain(`m-${await lastRead(request)}`)
  })

  test('a message posted in Discord appears on the open post within 15 seconds', async ({ page, request }) => {
    test.setTimeout(90_000)
    // A post opens around the message the reader has read to. The page's own report of that is whatever was in view when what was in
    // view last changed, which after the test above is among the oldest messages, so it is set here to the newest message: the page
    // opens at the end of the post, as a reader who is up to date does, and takes a new message in. (A post opened with newer
    // messages beyond the page holds a gap, and would not.)
    const newestPage = await request.get(`${API}/librarius/posts/${ACTIVE}/messages?limit=1`, { headers: { Authorization: `Bearer ${LIBRARIAN}` } })
    const [newest] = (await newestPage.json()).messages
    const marked = await request.put(`${API}/librarius/posts/${ACTIVE}/read`, { headers: { Authorization: `Bearer ${LIBRARIAN}` }, data: { messageId: newest.id } })
    expect(marked.status()).toBe(204)

    await signIn(page, LIBRARIAN)
    await page.goto(`/reliquarium/librarius/${ACTIVE}`)
    const messages = page.locator('.lb-thread .lb-msg')
    await expect(messages.first()).toHaveAttribute('id', `m-${ACTIVE}`)
    await expect(messages.last()).toHaveAttribute('id', `m-${newest.id}`)
    await expect(page.getByRole('button', { name: 'Load newer' })).toHaveCount(0)
    const held = await messages.count()

    // The mock sends it down the gateway, and the api stores it; the page asks for what changed every 10 seconds. The gateway
    // may be down for a few seconds when it is sent: librarius-api.spec.js, in another worker, drops it to test the catch-up. A
    // message sent then is not told to the api at all, and comes back only when the api has reconnected and caught up, and the
    // page has polled: so the mock counts the drops, and a drop that came before the message was posted is one it is told of.
    const gateway = async () => (await request.get(`${MOCK}/__test/librarius/gateway`)).json()
    let before
    await expect
      .poll(async () => ((before = await gateway()).ready), { timeout: 30_000, message: 'the api is on the gateway' })
      .toBeGreaterThan(0)

    const text = `E2E browser live message ${RUN}`
    // By the Scribe, one of the two who wrote the seeded messages.
    const posted = await request.post(`${MOCK}/__test/librarius/message`, { data: { post: ACTIVE, content: text, authorId: '200000000000000440' } })
    expect(posted.status()).toBe(200)
    const dropped = (await gateway()).drops !== before.drops
    const live = page.locator('.lb-msg', { hasText: text })
    // 15 seconds: the page's poll (10) and what the api needs. After a drop: 3 down, a backoff of up to 4, the catch-up run, and a poll.
    await expect(live).toBeVisible({ timeout: dropped ? 30_000 : 15_000 })
    await expect(live.locator('.lb-body')).toHaveText(text)
    await expect(messages).toHaveCount(held + 1)
  })
})
