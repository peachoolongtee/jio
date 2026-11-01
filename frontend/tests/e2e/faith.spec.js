// Owner: Faith. Feature: meeting-area fairness (the list of meeting spots, ranked by the longest trip) and place search (the
// "Where you start" sheet).
//
// Run only this file, from the repo root:
//   pnpm --filter jio-frontend exec playwright test tests/e2e/faith.spec.js
import { test, expect, signInDemo, createSession, inviteAndStart, openDemoTools } from './fixtures.js'

// Search for a place in the start sheet. The stub backend answers every address search with the same address, the Supreme Court
// Building (postal code 178879), which the app places in the City Hall area, so "supreme court" finds exactly one place.
// How to call: await searchAndPick(page, 'supreme court', /Supreme Court Building/)
async function searchAndPick(page, text, resultName) {
  await page.getByRole('button', { name: /^Starting from/ }).click()
  const sheet = page.getByRole('dialog', { name: 'Where you start' })
  await expect(sheet.getByText('Friends see the area name only')).toBeVisible()
  await sheet.getByRole('textbox', { name: 'Place or postal code' }).fill(text)
  // The address search runs about 300 ms after the last key, so the result appears a moment later.
  await sheet.getByRole('list', { name: 'Results' }).getByRole('button', { name: resultName }).click()
  await expect(sheet).toBeHidden()
}

test.describe('Meeting area and place search', () => {
  // What it proves: a person can set where they start by searching for a place, and the group sees only the area, never the
  // exact place.
  // Starting state: the demo account on Home with no meetups, then a session of three (Ian, Darius, Nicole) made through the
  // forms and started with "Find the fairest spot", so it is on the Locate step with nobody's start set.
  // Steps: open "Starting from", search "supreme court", pick the Supreme Court Building.
  // Checked at the end: Ian's own row says "Starting from Supreme Court Building" (only he sees that); the People list shows his
  // area, City Hall, and nowhere on the page's People card or the map pins does the exact place appear; the count goes to 1 of 3.
  test('Set a start by searching: the group sees the area, not the place', async ({ page }) => {
    await signInDemo(page)
    await createSession(page, { title: 'Search for a start' })
    await inviteAndStart(page, ['Darius', 'Nicole'])
    await expect(page.getByRole('button', { name: 'Starting from Add where you are starting' })).toBeVisible()

    await searchAndPick(page, 'supreme court', /Supreme Court Building/)

    // His own row keeps the exact place.
    await expect(page.getByRole('button', { name: 'Starting from Supreme Court Building' })).toBeVisible()
    // The group's People card knows the area only.
    const people = page.getByRole('region', { name: 'People', exact: true })
    await expect(people.getByRole('link', { name: /^Ian \(host\)\s+City Hall/ })).toBeVisible()
    await expect(people.getByRole('region', { name: 'Locations: 1 of 3' })).toBeVisible()
    await expect(people).not.toContainText('Supreme Court')
    await expect(page.getByRole('region', { name: 'Meeting area map' })).not.toContainText('Supreme Court')
  })

  // What it proves: when people start far apart, the meeting spots are listed fairest first: the first spot has the "Fairest" tag
  // and the shortest longest-trip, every spot shows each person's minutes, and the button to confirm names the first spot.
  // Starting state: the same session as above (Ian, Darius, Nicole, on the Locate step). Ian starts at City Hall by search; the
  // demo tools then submit the friends' starts from their home areas, Darius in Bugis and Nicole in Tampines, which is far east.
  // Steps: set the start, open Demo tools, "Simulate friends submitting locations" (it spreads them over about 3 seconds), close.
  // Checked at the end: three spots in the list "Meeting spots"; "Fairest" on the first only; the "Longest trip" minutes never
  // go down the list; each spot's "More details" dialog lists You, Darius and Nicole with minutes; the footer says "Confirm <first spot>".
  // Good to know: it does not assert which areas come out or the minutes, only their order, since those come from the planner's
  // stub routes. A spot's "Leading" tag (most approvals) would replace "Fairest", but nobody approves anything here.
  test('The fairest spot is first, with each person\'s minutes', async ({ page }) => {
    await signInDemo(page)
    await createSession(page, { title: 'Far apart' })
    await inviteAndStart(page, ['Darius', 'Nicole'])
    await searchAndPick(page, 'supreme court', /Supreme Court Building/)

    const tools = await openDemoTools(page)
    await tools.getByRole('button', { name: 'Simulate friends submitting locations' }).click()
    // The friends' starts arrive one after another; the tools' note says so when it is over.
    await expect(tools.getByRole('button', { name: 'Simulate friends submitting locations' })).toBeEnabled({ timeout: 15_000 })
    await tools.getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('dialog', { name: 'Demo tools' })).toBeHidden()

    // Spots open at two starts and are worked out again as each start arrives, so wait for all three before reading them.
    await expect(page.getByRole('region', { name: 'Locations: 3 of 3' })).toBeVisible({ timeout: 15_000 })

    // A row of the list is a spot's card (the people lists are in each card's "More details" dialog, not inside the card).
    const rows = page.getByRole('list', { name: 'Meeting spots' }).locator(':scope > li[data-area]')
    await expect(rows).toHaveCount(3)

    const longest = []
    const names = []
    for (let i = 0; i < 3; i += 1) {
      const row = rows.nth(i)
      // "Fairest" is on the first spot only.
      if (i === 0) await expect(row.getByText('Fairest', { exact: true })).toBeVisible()
      else await expect(row.getByText('Fairest', { exact: true })).toHaveCount(0)
      // Each person's trip, in the spot's "More details" dialog: You, Darius and Nicole, with minutes (or "already there").
      await row.getByRole('button', { name: /^More details/ }).click()
      const dialog = page.getByRole('dialog')
      const trips = dialog.getByRole('list', { name: "Each person's trip" })
      for (const who of ['You', 'Darius', 'Nicole']) {
        await expect(trips.getByRole('listitem').filter({ hasText: who })).toContainText(/\d+ min|already there/)
      }
      const line = await dialog.getByText(/^Longest trip/).innerText()
      longest.push(Number(line.match(/Longest trip (?:about )?(\d+) min/)[1]))
      names.push(await dialog.getByRole('heading').innerText())
      await dialog.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(dialog).toBeHidden()
    }
    // Rank order: the longest trip never gets shorter going down the list.
    expect(longest, 'Longest trip of each spot, top to bottom').toEqual([...longest].sort((a, b) => a - b))

    // The footer button confirms the first spot, the fairest: the dialog's title is the spot's name.
    const firstName = names[0]
    await expect(page.getByRole('button', { name: `Confirm ${firstName}` })).toBeVisible()
  })
})
