// Owner: Jonathan. Feature: layout and accessibility: no sideways scroll at any phone, tablet or desktop width, and a whole journey
// that works with the keyboard alone.
//
// Run only this file, from the repo root:
//   pnpm --filter jio-frontend exec playwright test tests/e2e/jonathan.spec.js
import { test, expect, signInDemo, dayName, daysAhead } from './fixtures.js'

// Is the element with keyboard focus one a person can see? Not the page itself, and with a size, drawn, and inside the window.
// How to call: await expectFocusVisible(page)
async function expectFocusVisible(page) {
  const seen = await page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body || el === document.documentElement) return 'nothing has focus'
    const box = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    const label = el.getAttribute('aria-label') || el.textContent.trim().slice(0, 40) || el.tagName
    if (box.width < 4 || box.height < 4 || style.visibility === 'hidden' || style.display === 'none') return `focus is on something not drawn: ${label}`
    if (box.bottom <= 0 || box.right <= 0 || box.top >= innerHeight || box.left >= innerWidth) return `focus is outside the window: ${label}`
    return 'visible'
  })
  expect(seen, 'The element with keyboard focus').toBe('visible')
}

// Press a key (Tab by default) until the target has focus, checking after every press that focus is on something visible. Gives
// up after `max` presses, so a control that cannot be reached by keyboard fails the test instead of hanging it.
// How to call: await pressUntilFocused(page, page.getByLabel('Title', { exact: true }))   or   (page, locator, { key: 'Shift+Tab' })
async function pressUntilFocused(page, target, { key = 'Tab', max = 40 } = {}) {
  for (let presses = 1; presses <= max; presses += 1) {
    await page.keyboard.press(key)
    await expectFocusVisible(page)
    if (await target.evaluate((el) => el === document.activeElement)) return presses
  }
  throw new Error(`The target was not reached in ${max} presses of ${key}`)
}

// The widths to check: a small phone, a common phone, the width where the top bar replaces the tab bar (744), a desktop, and a
// phone held sideways (812 by 375).
const SIZES = [
  { name: '320 px wide', width: 320, height: 700 },
  { name: '375 px wide', width: 375, height: 800 },
  { name: '744 px wide', width: 744, height: 900 },
  { name: '1280 px wide', width: 1280, height: 800 },
  { name: '812 by 375, a phone held sideways', width: 812, height: 375 },
]

// How far the page is wider than the window, in pixels. 0 or less means no sideways scroll.
// How to call: await sidewaysOverflow(page) -> 0
const sidewaysOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

// The pages to look at, with what shows when each is ready. They are showcase sessions: "Weekend brunch" is still inviting, "Long
// overdue catch-up lunch" is choosing where to meet (Locate), "Saturday movie and makan" is voting, and "Dessert run after the gym"
// is confirmed (Itinerary).
const PAGES = [
  { name: 'Home', path: '/', ready: (page) => expect(page.getByRole('heading', { level: 1, name: /Hi,\s*Ian/ })).toBeVisible() },
  { name: 'Create', path: '/sessions/new', ready: (page) => expect(page.getByRole('heading', { level: 1, name: 'Create session' })).toBeVisible() },
  { name: 'Invite', path: '/sessions/s1/invite', ready: (page) => expect(page.getByRole('heading', { level: 1, name: 'Invite friends' })).toBeVisible() },
  { name: 'Locate', path: '/sessions/s9', ready: (page) => expect(page.getByRole('list', { name: 'Meeting spots' })).toBeVisible() },
  {
    name: 'Vote',
    path: '/sessions/s4/plan',
    ready: async (page) => {
      await expect(page.getByRole('heading', { level: 1, name: 'Saturday movie and makan' })).toBeVisible()
      // The places have loaded when Eat shows. The question "Confirm dietary needs" opens over them once; answer it if it is open, so
      // the page is measured as a person would see it after that.
      await expect(page.getByRole('region', { name: 'Eat', exact: true })).toBeVisible({ timeout: 20_000 })
      const question = page.getByRole('dialog', { name: 'Confirm dietary needs' })
      if (await question.isVisible()) {
        await question.getByRole('button', { name: 'Confirm' }).click()
        await expect(question).toBeHidden()
      }
    },
  },
  { name: 'Itinerary', path: '/sessions/s7/itinerary', ready: (page) => expect(page.getByRole('list', { name: 'Stops' })).toBeVisible() },
]

test.describe('No sideways scroll', () => {
  // What it proves: at every width from a small phone to a desktop, none of the six main pages is wider than the window, so
  // nobody has to scroll sideways.
  // Starting state: the demo account with the showcase (ten sessions in every state), the browser sized to the width being tested.
  // Steps: for each of Home, Create, Invite, Locate, Vote and Itinerary, open the page, wait until its content shows, then compare
  // the document's scrollWidth with its clientWidth.
  // Checked at the end: scrollWidth is never greater than clientWidth, for each page. The checks are "soft", so one failing page
  // does not hide the others: the report lists every page that overflowed and by how many pixels.
  // Good to know: one test per width, each building the showcase (20 seconds or so), so each has a longer timeout. A real
  // overflow is a finding: it would stay as a failing assertion, marked test.fail() with the bug named, never removed.
  for (const size of SIZES) {
    test(`No sideways scroll on any page at ${size.name}`, async ({ page }) => {
      test.setTimeout(150_000)
      await page.setViewportSize({ width: size.width, height: size.height })
      await signInDemo(page, { showcase: true })
      for (const target of PAGES) {
        await test.step(`${target.name} at ${size.name}`, async () => {
          // Home is where signing in ended; the rest are opened by address, which keeps the signed-in account and its sessions.
          if (target.path !== '/' || page.url() !== new URL('/', page.url()).href) await page.goto(target.path, { waitUntil: 'domcontentloaded' })
          await target.ready(page)
          // Poll: a layout may take a frame or two to settle after the page draws.
          await expect.soft.poll(() => sidewaysOverflow(page), { message: `${target.name} at ${size.name} is wider than the window (px)`, timeout: 3000 }).toBeLessThanOrEqual(0)
        })
      }
    })
  }
})

test.describe('Keyboard only', () => {
  // What it proves: a person who cannot use a mouse can go from Home, through Create, to Invite: every control on the way can be
  // reached with Tab, used with Enter, Space, arrows or typing, and focus is always on something they can see.
  // Starting state: the demo account on Home with no meetups. Signing in is done with the mouse; the journey after it uses only
  // the keyboard (no click, no fill).
  // Steps: Tab to the link "Jio your friends" and press Enter; Tab to the Title and type a title; Tab to the calendar, whose days are
  // one tab stop, move with the arrow keys to Saturday 7 November and press Space; Tab to Next, Shift+Tab back one control and Tab
  // forward again; press Enter on Next; on Invite, Tab to "Invite Darius" and press Space.
  // Checked at the end: after each step the focused element is the expected one (toBeFocused) and is visible; the title holds what
  // was typed; Saturday is pressed; the Invite screen opens for the session; Darius is selected and Send enables.
  // Good to know: the times already have defaults (the next round hour and three hours after), so no time is typed. The "Tab"
  // count between controls is not asserted, only that the target is reached within a few presses, so adding a control to a page
  // does not break the test.
  test('Create a session using only the keyboard', async ({ page }) => {
    await signInDemo(page)
    const next = page.getByRole('button', { name: 'Next', exact: true })

    // 1. Home to Create. Signing in left focus on the "Demo tools" button, at the end of the page, so a first Tab would run off the
    // end. Reload Home, as a person arriving fresh would, so the first Tab starts from the top of the page.
    await page.reload({ waitUntil: 'domcontentloaded' })
    // Wait for the link, not only the heading: until the page's content has drawn, the keys would meet a different Tab order.
    const start = page.getByRole('link', { name: 'Jio your friends' })
    await expect(start).toBeVisible()
    await pressUntilFocused(page, start)
    await expect(start).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { level: 1, name: 'Create session' })).toBeVisible()

    // 2. The title: Tab to it and type.
    const title = page.getByLabel('Title', { exact: true })
    await pressUntilFocused(page, title)
    await expect(title).toBeFocused()
    await page.keyboard.type('Keyboard only trip')
    await expect(title).toHaveValue('Keyboard only trip')

    // 3. The calendar is one tab stop, on today (Wednesday 4 November). Arrows move by a day: three to the right is Saturday.
    const today = page.getByRole('button', { name: dayName(daysAhead(0)) })
    const saturday = page.getByRole('button', { name: dayName(daysAhead(3)) })
    await pressUntilFocused(page, today)
    await expect(today).toBeFocused()
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowRight')
    await expect(saturday).toBeFocused()
    await expectFocusVisible(page)
    await page.keyboard.press('Space')
    await expect(saturday).toHaveAttribute('aria-pressed', 'true')

    // 4. On to Next, which is enabled now. Shift+Tab goes back one control (a time field) and Tab returns to Next.
    await expect(next).toBeEnabled()
    await pressUntilFocused(page, next)
    await expect(next).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expectFocusVisible(page)
    await expect(next).not.toBeFocused()
    await page.keyboard.press('Tab')
    await expect(next).toBeFocused()
    await page.keyboard.press('Enter')

    // 5. Invite: reach a friend and pick them with Space.
    await expect(page.getByRole('heading', { level: 1, name: 'Invite friends' })).toBeVisible()
    await expect(page.getByText('Keyboard only trip', { exact: true })).toBeVisible()
    const darius = page.getByRole('button', { name: 'Invite Darius' })
    await pressUntilFocused(page, darius)
    await expect(darius).toBeFocused()
    await page.keyboard.press('Space')
    await expect(darius).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: 'Send 1 invite' })).toBeEnabled()
  })
})
