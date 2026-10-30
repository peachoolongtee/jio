// Shared set-up for the end-to-end tests. Import `test` and `expect` from here, never from '@playwright/test', so every test gets:
//   - a fresh browser context (its own local storage, so the demo data of one test never reaches another),
//   - the network guard: nothing leaves localhost, and a test fails if anything but a map tile tried to,
//   - a fixed clock, so "today" does not depend on the day the tests run.
// The helpers below (signInDemo and the others) are plain functions, so a test can call them in any order.
//
// How to call:
//   import { test, expect, signInDemo } from './fixtures.js'
//   test('my screen', async ({ page }) => { await signInDemo(page); ... })
import { test as base, expect } from '@playwright/test'

// The hosts the browser may talk to. Everything else is refused.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

// The fixed "now" of every test: Wednesday 4 November 2026, 10:00 in Singapore (02:00 UTC). A fixed time of day well before
// midnight keeps "a start that has already passed today" and "after 23:00 the day starts as tomorrow" out of the way. A day
// a few days ahead is always inside the 90 days a session can be planned ahead.
export const FIXED_NOW = new Date('2026-11-04T02:00:00Z')

// Is this address a map tile? Tiles come from OneMap and are not needed: the map draws without them.
// How to call: isMapTile(new URL('https://www.onemap.gov.sg/maps/tiles/Default/12/3/4.png')) -> true
export function isMapTile(url) {
  return /(^|\.)onemap\.gov\.sg$/.test(url.hostname) && url.pathname.startsWith('/maps/tiles/')
}

// Refuse every request to a host that is not local, and remember what was refused. Tiles are only counted. Anything else is a
// real service the app tried to reach, which the fixture turns into a failed test.
// How to call: const guard = await guardNetwork(context); ...; guard.escaped -> ['https://example.com/x']
export async function guardNetwork(context) {
  const guard = { tiles: 0, escaped: [] }
  await context.route(
    (url) => !LOCAL_HOSTS.has(url.hostname),
    (route) => {
      const url = new URL(route.request().url())
      if (isMapTile(url)) guard.tiles += 1
      else guard.escaped.push(`${route.request().method()} ${url.origin}${url.pathname}`)
      return route.abort('blockedbyclient')
    },
  )
  return guard
}

export const test = base.extend({
  // The time the page believes it is. Change it for one file or describe block with test.use({ fixedNow: new Date('2026-12-24T02:00:00Z') }),
  // or turn the fixed clock off with test.use({ fixedNow: null }).
  fixedNow: [FIXED_NOW, { option: true }],

  // Every test already gets a fresh context from Playwright; this one also has the guard and the clock.
  context: async ({ context }, use, testInfo) => {
    const guard = await guardNetwork(context)
    await use(context)
    if (guard.tiles > 0) testInfo.annotations.push({ type: 'map tiles blocked', description: String(guard.tiles) })
    // Fail the test, not only log: a test that reaches a real service is wrong even when it passes.
    expect(guard.escaped, 'Requests to hosts outside localhost (tests must never use real services)').toEqual([])
  },

  page: async ({ page, fixedNow }, use) => {
    // Time moves on from this moment, so timers and animations still run. Date, and so "today", starts at fixedNow.
    if (fixedNow) await page.clock.install({ time: fixedNow })
    await use(page)
  },
})

export { expect }

// Open the demo tools (the "Demo" button at the bottom of every screen while signed in; development builds only).
// How to call: const tools = await openDemoTools(page); await tools.getByRole('button', { name: 'Reset demo data' }).click()
export async function openDemoTools(page) {
  await page.getByRole('button', { name: 'Demo tools' }).click()
  const tools = page.getByRole('dialog', { name: 'Demo tools' })
  await expect(tools).toBeVisible()
  return tools
}

// Open the app, sign in as the demo account (Ian, with the sample friends: Darius, Jonathan, Nicole, Faith and Darryl),
// clear the demo data so the account starts with no meetups, and end on Home. No real account or service is used: the demo
// account is a local account kept in this browser's storage.
// Options: { showcase: true } loads the showcase instead (ten sessions, one in each state) and keeps it, which takes a few seconds.
// How to call: await signInDemo(page)   or   await signInDemo(page, { showcase: true })
export async function signInDemo(page, { showcase = false } = {}) {
  await page.goto('/signup')
  await page.getByRole('button', { name: showcase ? 'Use the demo account with showcase data' : 'Use the demo account', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Demo tools' })).toBeVisible({ timeout: 30_000 })
  if (!showcase) await resetDemoData(page)
  await expect(page).toHaveURL(/\/$/)
}

// Clear the signed-in demo account's meetups ("Reset demo data" in the demo tools) and go to Home. The account stays signed in.
// How to call: await resetDemoData(page)
export async function resetDemoData(page) {
  const tools = await openDemoTools(page)
  await tools.getByRole('button', { name: 'Reset demo data', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Demo tools' })).toBeHidden()
}

// The day shown in the date picker as a button, from a date as 'yyyy-MM-dd'. The picker names each day in full, for example
// "Saturday 7 November 2026".
// How to call: await page.getByRole('button', { name: dayName('2026-11-07') }).click()
export function dayName(isoDate) {
  const date = new Date(`${isoDate}T00:00:00Z`)
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(date)
    .replace(',', '')
}

// A day counted from the fixed "today" (Singapore), as 'yyyy-MM-dd'. Uses the same fixed time as the clock.
// How to call: daysAhead(3) -> '2026-11-07' with the default clock
export function daysAhead(days, from = FIXED_NOW) {
  const singapore = new Date(from.getTime() + 8 * 3600_000 + days * 86_400_000)
  return singapore.toISOString().slice(0, 10)
}

// Type a time into one of the radial time fields on the Create screen. The fields are labelled "Start time" and "End time";
// digits are enough: "1430" becomes 14:30 when the field is left.
// How to call: await setTime(page, 'Start time', '14:00')
export async function setTime(page, label, time) {
  const field = page.getByLabel(label, { exact: true })
  await field.click()
  await field.fill(time)
  await field.press('Enter')
  await expect(field).toHaveValue(time)
}

// Make the stub backend answer as one of its scenarios for the rest of this test: 'rain' (heavy showers everywhere) or
// 'routing-fail' (every route fails, so travel times are estimates). It adds the header x-jio-scenario to the page's
// calls to the backend only. Call it before the page makes the request, usually before signInDemo.
// How to call: await useScenario(page, 'rain')
export async function useScenario(page, scenario) {
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url())
    if (!LOCAL_HOSTS.has(url.hostname)) return route.fallback()
    return route.continue({ headers: { ...route.request().headers(), 'x-jio-scenario': scenario } })
  })
}

// Make a session the way a person does, from Home: Jio your friends, fill in the form, Next. Ends on the Invite screen of the
// new session and answers its id. Shared by the files that need a session of their own to start from. Options: title, day (a
// yyyy-MM-dd, default three days ahead), and optionally start and end times (otherwise the form's own defaults stay).
// How to call: const id = await createSession(page, { title: 'Team lunch' })
export async function createSession(page, { title, day = daysAhead(3), start, end } = {}) {
  await page.getByRole('link', { name: 'Jio your friends' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Create session' })).toBeVisible()
  await page.getByLabel('Title', { exact: true }).fill(title)
  await page.getByRole('button', { name: dayName(day) }).click()
  if (start) await setTime(page, 'Start time', start)
  if (end) await setTime(page, 'End time', end)
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Invite friends' })).toBeVisible()
  return page.url().match(/\/sessions\/([^/]+)\/invite$/)[1]
}

// From the Invite screen: invite some of the demo account's friends, wait until they have joined, press Next, choose "Find the
// fairest spot" and press Next. Ends on the Locate step. Friends are named as in the list ("Darius").
// How to call: await inviteAndStart(page, ['Darius', 'Nicole'])
export async function inviteAndStart(page, friends) {
  for (const name of friends) await page.getByRole('button', { name: `Select ${name}`, exact: true }).click()
  await page.getByRole('button', { name: `Send ${friends.length} ${friends.length === 1 ? 'invite' : 'invites'}` }).click()
  // The page stays, with each friend under "In this session". In the demo they accept one after another, some seconds apart (time to
  // take an invite back). A friend who has not accepted when the session starts is left out of it, so wait until all have joined.
  await expect(page.locator('.invite__tag', { hasText: 'Joined' })).toHaveCount(friends.length, { timeout: 30_000 })
  await page.getByTestId('invite-onward').click()
  await expect(page.getByRole('heading', { level: 2, name: 'How do you want to pick the meeting point?' })).toBeVisible()
  await page.getByTestId('start-next').click()
  await expect(page.getByRole('group', { name: 'Your locations' })).toBeVisible()
}
