import { test, expect } from '@playwright/test'

// Replying from the site's own pages against the e2e stack: the composer docked under a post, what a reply becomes in Discord
// (discord-mock, which keeps what reached the webhook), and the reply as the page then shows it, edited and deleted from the page.
// The tokens, ids and words are the invented ones in e2e/discord-mock/server.js. Same fragment-callback sign-in as the other
// browser specs, and nothing leaves the stack.
//
// librarius-write.spec.js may run at the same time, in another worker: it writes in the write post (...412), and this file in the
// compose post (...413), as the illuminator, who writes nowhere else. The two share the api's one outbox, which makes a webhook call
// at most every 1.5 s, so a wait for Discord is long. Both lock the locked post (...414), and neither opens it again.
const API = process.env.API_URL || 'http://api:8787'
const MOCK = process.env.DISCORD_MOCK_URL || 'http://discord-mock:4400'

const COMPOSE = '200000000000000413'
const LOCKED = '200000000000000414'
const ILLUMINATOR = { token: 'test-illuminator-token', id: '200000000000000407', name: 'illuminator-tester' }

const RUN = Date.now().toString(36)
const SITE = `https://sm2salamanders.site/reliquarium/librarius/${COMPOSE}`
const BUTTON_ROW = { type: 1, components: [{ type: 2, style: 5, label: 'Open On Site', url: SITE }] }
// How long what the page sends may take to reach Discord and come back: the outbox's queue, then the page's poll (every 10 s).
const SENT = { timeout: 60_000 }
// A picture of one pixel, which the api takes (PNG, judged by its bytes).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const as = (token) => ({ Authorization: `Bearer ${token}` })

async function signIn(page, token) {
  await page.goto(`/#access_token=${token}&expires_in=3600`)
  await expect(page.locator('.auth-name')).toBeVisible()
}

const mock = async (request, path) => (await request.get(`${MOCK}${path}`)).json()
const webhook = (request) => mock(request, '/__test/librarius/webhook')

/** The texts a message of the webhook shows: the Text Displays of its components, at any depth, and its content. */
function textsOf(body) {
  const texts = typeof body.content === 'string' ? [body.content] : []
  const walk = (list) => {
    for (const c of list ?? []) {
      if (c.type === 10) texts.push(c.content)
      walk(c.components)
    }
  }
  walk(body.components)
  return texts
}
const says = (body, words) => textsOf(body).some((text) => text.includes(words))

test.describe('Librarius composer', () => {
  // The tests run in order, in one worker (the second edits the reply the first made), and one that fails does not stop the rest.
  // The composer is docked at the foot of the window from 900px: a tall window keeps a short post's messages clear of it.
  test.use({ viewport: { width: 1280, height: 1000 } })

  // The api is importing the forum when the stack comes up, and the pages answer "being brought over" until it is done.
  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(90_000)
    const request = await playwright.request.newContext()
    try {
      const done = async () => {
        const res = await request.get(`${API}/librarius/me`, { headers: { Authorization: `Bearer ${ILLUMINATOR.token}` } })
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

  // What the tests below pass from one to the next: the reply they made.
  let replyId

  test('a reply written in the composer goes to Discord as Components V2, and comes back to the page with the site tag', async ({ page, request }) => {
    test.setTimeout(120_000)
    await signIn(page, ILLUMINATOR.token)
    await page.goto(`/reliquarium/librarius/${COMPOSE}`)
    await expect(page.locator('.lb-thread .lb-msg').first()).toContainText('E2E Compose Post: the opening message')
    const composer = page.locator('.lb-dock .lb-composer')
    await expect(composer).toBeVisible()
    await expect(page.locator('.lb-locked')).toHaveCount(0)

    const words = `E2E composed reply ${RUN}`
    const source = `${words}, with *a word* leaning`
    await composer.getByRole('textbox', { name: 'Your reply, in markdown' }).fill(source)
    const send = composer.locator('.lb-send')
    await expect(send).toHaveText('Reply')
    await send.click()
    // On its way: shown under the thread as the reader's, greyed, until it is sent.
    const outgoing = page.locator('article.lb-outgoing', { hasText: words })
    await expect(outgoing).toBeVisible()

    // In Discord: one V2 message, the text and the footer that names the writer, the button to the post on the site, and no pings.
    await expect.poll(async () => (await webhook(request)).executes.filter((e) => e.threadId === COMPOSE && says(e.body, words)).length, { ...SENT, intervals: [500] }).toBe(1)
    const sent = (await webhook(request)).executes.find((e) => e.threadId === COMPOSE && says(e.body, words))
    expect(sent.body).toEqual({
      flags: 32768,
      components: [{ type: 17, components: [{ type: 10, content: `${source}\n-# <@${ILLUMINATOR.id}>` }, BUTTON_ROW] }],
      username: ILLUMINATOR.name,
      allowed_mentions: { parse: [], users: [] },
    })
    replyId = sent.messageId

    // Back on the page as a message of the thread, under the writer's name, tagged as the site's and drawn from its source.
    const message = page.locator(`#m-${replyId}`)
    await expect(message).toBeVisible(SENT)
    await expect(message).toHaveClass(/lb-msg/)
    await expect(message.locator('.lb-head .lb-name')).toHaveText(ILLUMINATOR.name)
    await expect(message.locator('.lb-site-tag')).toHaveText('site')
    await expect(message.locator('.lb-body em')).toHaveText('a word')
    await expect(outgoing).toHaveCount(0, SENT)
    // The composer is empty again, ready for the next.
    await expect(composer.getByRole('textbox', { name: 'Your reply, in markdown' })).toHaveValue('')
  })

  test('its writer edits it, and then deletes it, from the page', async ({ page, request }) => {
    test.setTimeout(150_000)
    expect(replyId, 'the reply of the test before').toBeTruthy()
    await signIn(page, ILLUMINATOR.token)
    await page.goto(`/reliquarium/librarius/${COMPOSE}`)
    const message = page.locator(`#m-${replyId}`)
    await expect(message).toBeVisible()

    await message.getByRole('button', { name: 'Edit your reply' }).click()
    const composer = page.locator('.lb-dock .lb-composer')
    await expect(composer.locator('.lb-editing')).toContainText('Editing your reply')
    const box = composer.getByRole('textbox', { name: 'Your reply, in markdown' })
    await expect(box).toHaveValue(`E2E composed reply ${RUN}, with *a word* leaning`)
    const edited = `E2E composed reply ${RUN}, edited on the page`
    await box.fill(edited)
    await expect(composer.locator('.lb-send')).toHaveText('Save edit')
    await composer.locator('.lb-send').click()

    // Edited in Discord in place, and on the page once the poll brings it.
    await expect
      .poll(async () => (await webhook(request)).edits.filter((e) => e.messageId === replyId && says(e.body, edited)).length, { ...SENT, intervals: [500] })
      .toBe(1)
    await expect(message.locator('.lb-body')).toHaveText(edited, SENT)
    await expect(composer.locator('.lb-editing')).toHaveCount(0)

    // Deleted after the browser's own "are you sure", from Discord and then from the page.
    page.once('dialog', async (dialog) => {
      expect(dialog.type()).toBe('confirm')
      expect(dialog.message()).toBe('Delete this message? It goes from Discord too.')
      await dialog.accept()
    })
    await message.getByRole('button', { name: `Delete ${ILLUMINATOR.name}'s message` }).click()
    await expect
      .poll(async () => (await webhook(request)).deletes.some((d) => d.messageId === replyId && d.found), { ...SENT, intervals: [500] })
      .toBe(true)
    await expect(message).toHaveCount(0, SENT)
  })

  test('a reply with the server\'s AutoMod word is refused in the composer, and nothing of it reaches Discord', async ({ page, request }) => {
    await signIn(page, ILLUMINATOR.token)
    await page.goto(`/reliquarium/librarius/${COMPOSE}`)
    const composer = page.locator('.lb-dock .lb-composer')
    const box = composer.getByRole('textbox', { name: 'Your reply, in markdown' })
    const words = `E2E refused composition ${RUN}`
    await box.fill(`${words}: a grimbleflax`)
    const refusal = page.waitForResponse((res) => res.url().endsWith(`/librarius/posts/${COMPOSE}/messages`) && res.request().method() === 'POST')
    await composer.locator('.lb-send').click()
    expect((await refusal).status()).toBe(422)
    await expect(composer.locator('.lb-composer-error')).toHaveText(
      'Blocked by the server\'s AutoMod rule "E2E Banned Word". The words it matched are selected in your reply.',
    )
    // What was written stays to be changed, the matched word selected, and nothing went on its way.
    await expect(box).toHaveValue(`${words}: a grimbleflax`)
    expect(await box.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe('grimbleflax')
    await expect(page.locator('article.lb-outgoing')).toHaveCount(0)
    const log = await webhook(request)
    expect([...log.executes, ...log.refused].filter((e) => says(e.body, words))).toEqual([])
    // Leave no draft behind.
    await box.fill('')
  })

  test('a locked post has no composer, and says it is locked', async ({ page, request }) => {
    test.setTimeout(60_000)
    // Locked in Discord: the gateway's THREAD_UPDATE (or, after a drop, the catch-up) tells the api.
    const locked = await request.post(`${MOCK}/__test/librarius/lock/${LOCKED}`, { data: { locked: true } })
    expect(locked.status()).toBe(200)
    const post = async () => (await (await request.get(`${API}/librarius/posts/${LOCKED}`, { headers: { Authorization: `Bearer ${ILLUMINATOR.token}` } })).json()).post
    await expect.poll(async () => (await post()).locked, { timeout: 30_000 }).toBe(true)

    await signIn(page, ILLUMINATOR.token)
    await page.goto(`/reliquarium/librarius/${LOCKED}`)
    await expect(page.locator('.lb-thread .lb-msg').first()).toContainText('E2E Locked Post: the opening message')
    await expect(page.locator('.lb-dock .lb-locked')).toHaveText('This post is locked.')
    await expect(page.locator('.lb-composer')).toHaveCount(0)
    // Nor anything else that writes: no Reply or Quote on its messages.
    await expect(page.locator('.lb-actions')).toHaveCount(0)
  })
  test('a picture inside a spoiler is refused in the composer, in the server\'s words, until it is outside the bars', async ({ page }) => {
    await signIn(page, ILLUMINATOR.token)
    await page.goto(`/reliquarium/librarius/${COMPOSE}`)
    const composer = page.locator('.lb-dock .lb-composer')
    const box = composer.getByRole('textbox', { name: 'Your reply, in markdown' })
    const send = composer.locator('.lb-send')
    await composer.locator('input[type="file"]').setInputFiles({ name: 'e2e-map.png', mimeType: 'image/png', buffer: PNG })
    await expect(box).toHaveValue(/!\[e2e-map\]\(upload:1\)/, SENT)
    await box.fill('||![e2e-map](upload:1)||')
    await expect(composer.locator('.lb-spoiled-picture')).toHaveText("A picture can't go inside a spoiler yet: put it outside the bars.")
    await expect(send).toBeDisabled()
    await box.fill(`![e2e-map](upload:1) ||E2E spoiled ${RUN}||`)
    await expect(composer.locator('.lb-spoiled-picture')).toHaveCount(0)
    await expect(send).toBeEnabled()
    // Leave no draft behind.
    await box.fill('')
  })

  // What the next test deletes: the reply this one sends.
  let retriedId

  test('a reply that failed is sent once when Retry is pressed twice, and stays put away after a reload', async ({ page, request }) => {
    test.setTimeout(150_000)
    await signIn(page, ILLUMINATOR.token)
    await page.goto(`/reliquarium/librarius/${COMPOSE}`)
    // Discord refuses the next message in the post (403, as it would a post locked on its way).
    expect((await request.post(`${MOCK}/__test/librarius/refuse-next/${COMPOSE}`, { data: {} })).status()).toBe(200)
    const composer = page.locator('.lb-dock .lb-composer')
    const words = `E2E retried reply ${RUN}`
    await composer.getByRole('textbox', { name: 'Your reply, in markdown' }).fill(words)
    await composer.locator('.lb-send').click()
    const outgoing = page.locator('article.lb-outgoing', { hasText: words })
    await expect(outgoing.locator('.lb-state')).toContainText("Couldn't send. Try again.", SENT)

    // Pressed twice before the first press is answered: one reply.
    await outgoing.getByRole('button', { name: 'Try the reply again' }).dblclick()
    const made = async () => (await webhook(request)).executes.filter((e) => e.threadId === COMPOSE && says(e.body, words))
    await expect.poll(async () => (await made()).length, { ...SENT, intervals: [500] }).toBe(1)
    const message = page.locator('.lb-thread .lb-msg', { hasText: words })
    await expect(message).toHaveCount(1, SENT)
    await expect(outgoing).toHaveCount(0, SENT)
    retriedId = (await made())[0].messageId
    // The server still lists the failed one for a day: after a reload the page shows the reply once, and no Retry.
    const listed = page.waitForResponse((res) => res.url().endsWith(`/librarius/posts/${COMPOSE}/pending`))
    await page.reload()
    await listed
    await expect(message).toHaveCount(1)
    await expect(page.locator('article.lb-outgoing', { hasText: words })).toHaveCount(0)
    expect(await made()).toHaveLength(1)
  })

  // The owner's ruling (2026-11-22): a member who is timed out may still delete their own reply.
  test('a writer who is timed out has no composer, and is still offered Delete on their own reply, which goes', async ({ page, request }) => {
    test.setTimeout(150_000)
    expect(retriedId, 'the reply of the test before').toBeTruthy()
    const timeout = (until) => request.post(`${MOCK}/__test/librarius/timeout/${ILLUMINATOR.id}`, { data: { until } })
    try {
      expect((await timeout(new Date(Date.now() + 3_600_000).toISOString())).status()).toBe(200)
      const can = async () => (await (await request.get(`${API}/librarius/me`, { headers: as(ILLUMINATOR.token) })).json()).can
      await expect.poll(can, { timeout: 60_000, intervals: [1000], message: 'the api sees the timeout' }).toMatchObject({ reply: false, delete: true })

      await signIn(page, ILLUMINATOR.token)
      await page.goto(`/reliquarium/librarius/${COMPOSE}`)
      const message = page.locator(`#m-${retriedId}`)
      await expect(message).toBeVisible()
      await expect(page.locator('.lb-composer')).toHaveCount(0)
      await expect(message.locator('.lb-actions button')).toHaveText(['Delete'])
      // Nothing on another's message.
      await expect(page.locator('.lb-thread .lb-msg').first().locator('.lb-actions')).toHaveCount(0)
      page.once('dialog', (dialog) => dialog.accept())
      await message.getByRole('button', { name: `Delete ${ILLUMINATOR.name}'s message` }).click()
      await expect.poll(async () => (await webhook(request)).deletes.some((d) => d.messageId === retriedId && d.found), { ...SENT, intervals: [500] }).toBe(true)
      await expect(message).toHaveCount(0, SENT)
    } finally {
      await timeout(null)
    }
  })

  // The route's root is a stacking context of its own, under the site's sticky header: full screen in it, the header hid the
  // composer's top bar, and with it every way out on a phone.
  test('on a phone, full screen covers the site\'s header, and its own top bar takes it back', async ({ page, request }) => {
    test.setTimeout(90_000)
    // The timeout of the test before is lifted: the composer is offered again once the api sees it.
    const can = async () => (await (await request.get(`${API}/librarius/me`, { headers: as(ILLUMINATOR.token) })).json()).can
    await expect.poll(can, { timeout: 60_000, intervals: [1000] }).toMatchObject({ reply: true })
    // Signed in at the usual width, whose bar shows the name, and then a phone's.
    await signIn(page, ILLUMINATOR.token)
    await page.setViewportSize({ width: 390, height: 740 })
    await page.goto(`/reliquarium/librarius/${COMPOSE}`)
    const composer = page.locator('section.lb-composer')
    await expect(composer).toBeVisible()
    await composer.getByRole('button', { name: 'Full screen' }).click()
    await expect(composer).toHaveClass(/lb-composer-full/)
    const head = composer.locator('.lb-composer-head')
    expect((await head.boundingBox()).y).toBeLessThan(30)
    // What is at the middle of "Replying in" is the composer's own, not the header's.
    const where = await composer.locator('.lb-composer-where').boundingBox()
    expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.lb-composer') !== null, [where.x + where.width / 2, where.y + where.height / 2])).toBe(true)
    // Playwright clicks only what would take the click: the button is not under the header.
    await composer.getByRole('button', { name: 'Full screen' }).click({ timeout: 5_000 })
    await expect(composer).not.toHaveClass(/lb-composer-full/)
    await expect(page.locator('.lb-dock .lb-composer')).toBeVisible()
    await expect(composer.getByRole('textbox', { name: 'Your reply, in markdown' })).toBeFocused()
  })
})
