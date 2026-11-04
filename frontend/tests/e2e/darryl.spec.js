// Owner: darryl. Feature: dietary needs (set on the profile, and carried into the places on Vote) and replacing a stop of a
// confirmed itinerary.
//
// Run only this file, from the repo root:
//   pnpm --filter jio-frontend exec playwright test tests/e2e/darryl.spec.js
//
// Both tests use the demo account's showcase (ten sessions, one in each state), which takes 20 seconds or so to build, so they
// have a longer timeout. The showcase's "Saturday movie and makan" is in voting and "Dessert run after the gym" is confirmed;
// Ian hosts both.
import { test, expect, signInDemo } from './fixtures.js'

// Open a meetup from Home: show the list (Home opens on the map alone), pick its row in "Your meetups", then use the "Open meetup"
// link of the panel that opens.
// How to call: await openMeetup(page, 'Saturday movie and makan')
async function openMeetup(page, title) {
  const list = page.getByTestId('home-list-toggle')
  if ((await list.getAttribute('aria-pressed')) !== 'true') await list.click()
  await page.getByRole('region', { name: 'Your meetups' }).getByRole('button', { name: new RegExp(`^${title}`) }).click()
  await page.getByRole('link', { name: `Open meetup ${title}` }).click()
}

// Minutes since midnight of a time such as "20:05".
// How to call: minutesOf('20:05') -> 1205
const minutesOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))

test.describe('Dietary needs and replacing a stop', () => {
  // What it proves: a dietary need set on the profile reaches the Vote page of an outing with no question asked: the need shows
  // as a selected chip for the group, and the places offered under Eat all fit it.
  // Starting state: the demo account with the showcase, no dietary need saved.
  // Steps: Profile, Edit profile, choose Halal, Save details; back to Home; open "Saturday movie and makan" (voting).
  // Checked at the end: no "Confirm dietary needs" dialog opened; the page's "Dietary needs" chips have Halal selected; the Eat
  // section says it shows places that fit halal; every Eat card carries "Halal likely" and none says "not confirmed", which the
  // app uses for a place it cannot vouch for.
  // Good to know: the showcase has other people in this outing with a need of their own (vegetarian), so the Eat line reads
  // "halal and vegetarian"; the test only requires halal to be in it.
  test('A halal need reaches Vote and only fitting places are offered', async ({ page }) => {
    test.setTimeout(120_000)
    await signInDemo(page, { showcase: true })

    // 1. Save the need on the profile.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Profile' }).click()
    await page.getByRole('link', { name: 'Edit profile' }).click()
    await page.getByRole('group', { name: 'Dietary needs' }).getByRole('button', { name: 'Halal' }).click()
    await page.getByRole('button', { name: 'Save details' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible()

    // 2. The outing in voting. No question opens first: the profile's need is already selected on the page.
    await page.getByRole('link', { name: 'Back', exact: true }).click()
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Home', exact: true }).click()
    await openMeetup(page, 'Saturday movie and makan')
    await expect(page.getByRole('region', { name: 'Eat', exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('dialog', { name: 'Confirm dietary needs' })).toHaveCount(0)

    // 3. Vote: the need is a chip, and Eat offers only places that fit it.
    await expect(page.getByRole('group', { name: 'Dietary needs' }).getByRole('button', { name: 'Halal' })).toHaveAttribute('aria-pressed', 'true')
    const eat = page.getByRole('region', { name: 'Eat', exact: true })
    await expect(eat.getByText(/Showing places that fit .*halal/)).toBeVisible()
    const cards = eat.getByRole('article')
    await expect(cards.first()).toBeVisible()
    const count = await cards.count()
    expect(count).toBeGreaterThan(0)
    for (let i = 0; i < count; i += 1) {
      await expect(cards.nth(i)).toContainText('Halal likely')
      await expect(cards.nth(i)).not.toContainText('not confirmed')
    }
  })

  // What it proves: the host can replace a stop of a confirmed itinerary with another place, and the times follow: the stop
  // keeps its start time and the next stop starts when the new stop ends plus the travel time to it.
  // Starting state: the demo account with the showcase. "Dessert run after the gym" is confirmed for Saturday 7 November with two
  // stops (an Eat stop at 19:00 for an hour, then an Activity); Ian is the host.
  // Steps: open it from Home; press "Edit itinerary"; "Replace stop" on the first stop; on the page of other places that fit,
  // press "Use ... instead" on the first one.
  // Checked at the end: back on the itinerary, the first stop has the new place's name (not the old one) and still starts at 19:00;
  // the second stop is unchanged, and starts at 19:00 plus the first stop's length plus the travel time now shown between them.
  // Good to know: which place is first in the list is the planner's choice, so the test reads the names from the page instead of
  // naming them. The travel time is whatever mode is selected (walk by default); the test reads that from the page too.
  test('The host replaces a confirmed stop and the times follow', async ({ page }) => {
    test.setTimeout(120_000)
    await signInDemo(page, { showcase: true })
    await openMeetup(page, 'Dessert run after the gym')
    await expect(page.getByRole('heading', { level: 1, name: 'Dessert run after the gym' })).toBeVisible()

    const stops = page.getByRole('list', { name: 'Stops' }).getByRole('article')
    await expect(stops).toHaveCount(2)
    const oldName = await stops.nth(0).getByRole('heading', { level: 3 }).innerText()
    const secondName = await stops.nth(1).getByRole('heading', { level: 3 }).innerText()
    // A stop's time line reads "19:00 · 1 h": its start, then how long it lasts.
    const firstStart = (await stops.nth(0).innerText()).match(/(\d\d:\d\d) · (\d+) h/)
    expect(firstStart, 'the first stop shows its start and length').not.toBeNull()
    expect(firstStart[1]).toBe('19:00')

    // 1. Edit, then Replace on the first stop. The page of other places opens for that one stop.
    await page.getByRole('button', { name: 'Edit itinerary' }).click()
    await page.getByRole('button', { name: `Replace stop: ${oldName}` }).click()
    await expect(page.getByRole('heading', { level: 2, name: oldName })).toBeVisible()
    await expect(page.getByText('Replacing', { exact: true })).toBeVisible()

    // 2. Pick the first other place. Its button says which place it is.
    const use = page.getByRole('button', { name: /^Use .* instead$/ }).first()
    const newName = (await use.getAttribute('aria-label')).replace(/^Use /, '').replace(/ instead$/, '')
    expect(newName).not.toBe(oldName)
    await use.click()

    // 3. Back on the itinerary: the stop changed, kept its start, and the next stop follows from the new travel time.
    await expect(page).toHaveURL(/\/sessions\/[^/]+\/itinerary$/)
    await expect(stops).toHaveCount(2)
    await expect(stops.nth(0).getByRole('heading', { level: 3 })).toHaveText(newName)
    await expect(stops.nth(0)).toContainText('19:00')
    await expect(page.getByRole('heading', { level: 3, name: oldName })).toHaveCount(0)
    await expect(stops.nth(1).getByRole('heading', { level: 3 })).toHaveText(secondName)

    const travel = page.getByRole('radiogroup', { name: `Travel from ${newName} to ${secondName}` })
    // The selected mode's words, such as "Walk about 5 min", are in the label around its radio.
    const mode = await travel.getByRole('radio', { checked: true }).evaluate((el) => el.closest('label').innerText)
    const minutes = Number(mode.match(/(\d+) min/)[1])
    const nextStart = (await stops.nth(1).innerText()).match(/(\d\d:\d\d) · /)[1]
    expect(minutesOf(nextStart)).toBe(minutesOf('19:00') + Number(firstStart[2]) * 60 + minutes)
  })
})
