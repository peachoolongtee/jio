// Owner: Darius. Feature: Home (the meetups on it and the places near them), "Already out?" (a light meetup started from Home),
// and finishing an outing.
//
// Run only this file, from the repo root:
//   pnpm --filter jio-frontend exec playwright test tests/e2e/darius.spec.js
import { test, expect, signInDemo } from './fixtures.js'

test.describe('Home, "Already out?" and finishing an outing', () => {
  // What it proves: "Already out? Find something nearby" starts a light meetup around the area the person picks and opens its
  // itinerary, which lists places near it until the first stop is in (so the itinerary and "What next?" are one page); a place
  // opens, a tick proposes it, and the meetup is then on Home as a live meetup.
  // Starting state: the demo account on Home with no meetups (only the "Jio your friends" pin and the "Already out?" row).
  // Steps: press "Already out?", search "bugis" in "Where are you?", pick the Bugis area; on the itinerary check the list of
  // places near Bugis and open the first place; close it; propose it with the tick; go back to Home with the back arrow.
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

    // 2. The light meetup opens on its itinerary, which lists the places around the area while it has no stops.
    await expect(page).toHaveURL(/\/sessions\/[^/]+\/itinerary$/)
    await expect(page.getByRole('heading', { level: 1, name: "Today's plan" })).toBeVisible()
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

    // 4. Propose it with the tick: the card says so, and the cross takes it back. It waits above the list for the host.
    await places.getByRole('button', { name: `Propose ${placeName} as the next stop` }).click()
    await expect(places.getByRole('button', { name: `Take back your proposal of ${placeName}` })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: 'Proposed stops' })).toBeVisible()

    // 5. Back to Home: the meetup is there, live, with no friends yet.
    await page.getByRole('link', { name: 'Back to Home' }).click()
    await expect(page.getByRole('heading', { level: 1, name: /Hi,\s*Ian/ })).toBeVisible()
    const meetup = page.getByRole('region', { name: 'Out in Bugis' })
    await expect(meetup).toBeVisible()
    await expect(meetup).toContainText('Live now')
    await expect(meetup).toContainText('No friends yet')
    await expect(page.getByRole('region', { name: 'Places near Bugis' })).toBeVisible()
  })

  // What it proves: finishing an outing on its day asks how it was, and takes it off Home's current meetups and files it under Past.
  // Starting state: the demo account with the showcase (ten sessions, one in each state). "Chinatown makan crawl" is the showcase's
  // confirmed outing for today (4 November, 09:30 to 15:30), and the fixed clock says it is 10:00, so it is live now.
  // Steps: open it from Home's meetup card to see "Today's plan"; press the footer's "Finish outing", then "Finish outing" in the
  // question that follows; on "How was it?" give it 5 stars and save; open Sessions and its Past tab.
  // Checked at the end: "How was it?" says the outing is finished; saving goes Home, which no longer lists "Chinatown makan crawl"
  // (nor counts it among the meetups going, 9 become 8); and the Past tab lists it as Completed.
  // Good to know: the showcase takes 20 seconds or so to build, so this test has a longer timeout. The finish pays JioCoins in the
  // browser's own storage (it is a demo), which is why "How was it?" says "+100 JioCoins each". The meetup is opened from its card
  // (meetup-detail), not by name alone: the pointer can rest over its pin on the map, whose small card has the same link.
  test('Finishing an outing moves it from Home to Past', async ({ page }) => {
    test.setTimeout(120_000)
    await signInDemo(page, { showcase: true })
    await expect(page.getByText('You have 9 meetups going.')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Chinatown makan crawl Wed 4 Nov/ })).toBeVisible()

    // 1. Open today's outing and finish it. The pointer can be left resting on a map pin, whose popover carries a second
    // "Open meetup" link with the same name; move it away and wait until only the detail card's link is left.
    await page.mouse.move(0, 0)
    const openMeetup = page.getByRole('link', { name: 'Open meetup Chinatown makan crawl' })
    await expect(openMeetup).toHaveCount(1)
    await openMeetup.click()
    await expect(page.getByRole('heading', { level: 1, name: "Today's plan" })).toBeVisible()
    await page.getByRole('button', { name: 'Finish outing' }).click()
    const question = page.getByRole('dialog', { name: 'Finish outing?' })
    await expect(question).toBeVisible()
    await question.getByRole('button', { name: 'Finish outing' }).click()

    // 2. "How was it?": it says the outing is finished; 5 stars, and save.
    await expect(page).toHaveURL(/\/sessions\/[^/]+\/review$/)
    await expect(page.getByRole('heading', { level: 1, name: 'How was it?' })).toBeVisible()
    await expect(page.getByText(/^Outing finished\. \+100 JioCoins each/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save review' })).toBeDisabled()
    await page.getByRole('radiogroup', { name: 'Chinatown makan crawl, stars' }).getByRole('radio', { name: '5 stars' }).click()
    await page.getByRole('button', { name: 'Save review' }).click()

    // 3. Home: no longer current.
    await expect(page.getByText('You have 8 meetups going.')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Chinatown makan crawl/ })).toHaveCount(0)

    // 4. Sessions, Past: it is there, finished.
    await page.getByRole('link', { name: 'All meetups' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible()
    await page.getByRole('button', { name: 'Past', exact: true }).click()
    const finished = page.getByRole('link', { name: /Chinatown makan crawl/ })
    await expect(finished).toBeVisible()
    await expect(finished).toContainText('Completed')
  })
})
