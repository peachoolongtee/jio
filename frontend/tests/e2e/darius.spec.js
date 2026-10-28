// Owner: Darius. Feature: Home (the meetups on it and the places near them), "Already out?" (a light meetup started from Home),
// and finishing an outing.
//
// Run only this file, from the repo root:
//   pnpm --filter jio-frontend exec playwright test tests/e2e/darius.spec.js
import { test, expect, signInDemo } from './fixtures.js'

test.describe('Home, "Already out?" and finishing an outing', () => {
  // What it proves: "Already out? Find something nearby" starts a light meetup around the area the person picks, lists places
  // near it, lets them open a place, and the meetup is then on Home as a live meetup.
  // Starting state: the demo account on Home with no meetups (only the "Jio your friends" pin and the "Already out?" row).
  // Steps: press "Already out?", search "bugis" in "Where are you?", pick the Bugis area; on "What next?" check the list of places
  // near Bugis and open the first place; close it; go back to Home through the back arrows.
  // Checked at the end: Home says "Your group meets at Bugis" and has a meetup "Out in Bugis", confirmed and live now, with no
  // friends yet, and a "Places near Bugis" section.
  // Good to know: the stub backend lists the places (the app reads them from it); the places' reviews are sample data, as the app says. The light meetup is made for today on the fixed clock, 4 November from 10:00.
  test('"Already out?" starts a light meetup that shows on Home', async ({ page }) => {
    await signInDemo(page)
    await expect(page.getByRole('link', { name: 'Jio your friends' })).toBeVisible()

    // 1. Ask where the person is, and pick an area.
    await page.getByRole('button', { name: /Already out/ }).click()
    const sheet = page.getByRole('dialog', { name: 'Where are you?' })
    await sheet.getByRole('textbox', { name: 'Place or postal code' }).fill('bugis')
    await sheet.getByRole('list', { name: 'Results' }).getByRole('button', { name: /^Bugis/ }).click()

    // 2. The light meetup opens straight on its list of places ("What next?"), around the area.
    await expect(page).toHaveURL(/\/sessions\/[^/]+\/roam$/)
    await expect(page.getByRole('heading', { level: 1, name: 'What next?' })).toBeVisible()
    await expect(page.getByText('Out in Bugis')).toBeVisible()
    const places = page.getByRole('list', { name: /^Places near/ })
    await expect(places.getByRole('listitem').first()).toBeVisible()

    // 3. Open a place: its details open in a dialog named for it. Escape closes it.
    const first = places.getByRole('heading', { level: 4 }).first()
    const placeName = (await first.innerText()).replace(/^Open /, '').trim()
    await places.getByRole('button', { name: `Open ${placeName}` }).click()
    const detail = page.getByRole('dialog', { name: placeName })
    await expect(detail).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(detail).toBeHidden()

    // 4. Back to Home (the arrow goes to the plan first, then Home): the meetup is there, live, with no friends yet.
    await page.getByRole('link', { name: 'Back to Itinerary' }).click()
    await page.getByRole('link', { name: 'Back to Home' }).click()
    await expect(page.getByRole('heading', { level: 1, name: /Hi,\s*Ian/ })).toBeVisible()
    const meetup = page.getByRole('region', { name: 'Out in Bugis' })
    await expect(meetup).toBeVisible()
    await expect(meetup).toContainText('Live now')
    await expect(meetup).toContainText('No friends yet')
    await expect(page.getByRole('region', { name: 'Places near Bugis' })).toBeVisible()
  })

  // What it proves: finishing an outing on its day takes it off Home's current meetups and files it under Past.
  // Starting state: the demo account with the showcase (ten sessions, one in each state). "Chinatown makan crawl" is the showcase's
  // confirmed outing for today (4 November, 09:30 to 15:30), and the fixed clock says it is 10:00, so it is live now.
  // Steps: open it from Home to see "Today's plan"; press the footer's "Finish outing", then "Finish outing" in the question that
  // follows; leave through "Back to Home"; open Sessions and its Past tab.
  // Checked at the end: the plan shows "Completed"; Home no longer lists "Chinatown makan crawl" (nor counts it among the meetups going,
  // 9 become 8); and the Past tab lists it as Completed.
  // Good to know: the showcase takes 20 seconds or so to build, so this test has a longer timeout. The finish pays JioCoins in the
  // browser's own storage (it is a demo), which is why the toast says "+100 points each".
  test('Finishing an outing moves it from Home to Past', async ({ page }) => {
    test.setTimeout(120_000)
    await signInDemo(page, { showcase: true })
    await expect(page.getByText('You have 9 meetups going.')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Chinatown makan crawl Wed 4 Nov/ })).toBeVisible()

    // 1. Open today's outing and finish it.
    await page.getByRole('link', { name: 'Open meetup Chinatown makan crawl' }).click()
    await expect(page.getByRole('heading', { level: 1, name: "Today's plan" })).toBeVisible()
    await page.getByRole('button', { name: 'Finish outing' }).click()
    const question = page.getByRole('dialog', { name: 'Finish outing?' })
    await expect(question).toBeVisible()
    await question.getByRole('button', { name: 'Finish outing' }).click()
    await expect(page.getByText(/^Completed/)).toBeVisible()

    // 2. Home: no longer current.
    await page.getByRole('link', { name: 'Back to Home' }).click()
    await expect(page.getByText('You have 8 meetups going.')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Chinatown makan crawl/ })).toHaveCount(0)

    // 3. Sessions, Past: it is there, finished.
    await page.getByRole('link', { name: 'All meetups' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible()
    await page.getByRole('button', { name: 'Past', exact: true }).click()
    const finished = page.getByRole('link', { name: /Chinatown makan crawl/ })
    await expect(finished).toBeVisible()
    await expect(finished).toContainText('Completed')
  })
})
