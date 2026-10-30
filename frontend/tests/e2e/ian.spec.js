//Planning an outing end to end tests

import { test, expect, signInDemo, createSession, inviteAndStart, openDemoTools } from './fixtures.js'


//Reusable function to reach the voting page
async function reachVote(page) {

  await signInDemo(page)
  await createSession(page, { title: 'Plan an outing' })
  await inviteAndStart(page, ['Darius', 'Nicole'])
  await page.getByRole('button', { name: 'Starting from Add where you are starting' }).click()
  await page.getByRole('textbox', { name: 'Place or postal code' }).fill('Bishan')
  await page.getByRole('button', { name: 'Bishan MRT station and area' }).click()
  await expect(page.getByRole('button', { name: 'Starting from Bishan' })).toBeVisible();


  const tools = await openDemoTools(page)
  await tools.getByRole('button', { name: 'Simulate friends submitting locations'}).click()
  await expect(tools.getByRole('button', { name: 'Simulate friends submitting locations'})).toBeEnabled({ timeout: 15000 })
  await tools.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('dialog', { name: 'Demo tools' })).toBeHidden()

  await expect(page.getByRole('region', { name: 'Locations: 3 of 3' })).toBeVisible({ timeout: 15000 })

  await page.getByRole('button', { name: /^Confirm / }).click();
  await expect(page.getByRole('status').filter({ hasText: 'is confirmed' })).toBeVisible()
  await page.getByRole('link', { name: 'Choose places'}).click()

  await expect(page).toHaveURL(/\/sessions\/[^/]+\/plan$/)

  const diet = page.getByRole('dialog', { name: 'Confirm dietary needs' })
  await expect(diet).toBeVisible()
  await diet.getByRole('button', {name: 'Confirm', exact: true}).click()
  await expect(diet).toBeHidden()
}

test.describe('Planning an outing', () => {
  test('Planning an outing end to end', async ({ page }) => {
    await reachVote(page)

    const slots = page.getByRole('region').filter({ has: page.getByRole('button', { name: /^Vote for / }) })
    await expect(slots.first()).toBeVisible()
    const count = await slots.count()
    for (let i=0;i<count;i++) {
      await slots.nth(i).getByRole('button', { name: /^Vote for / }).first().click()
    }

    const tools = await openDemoTools(page)
    await tools.getByRole('button', { name: 'Simulate friends voting'}).click()
    await expect(tools.getByRole('button', { name: 'Simulate friends voting'})).toBeEnabled({ timeout: 15000 })
    await tools.getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('dialog', { name: 'Demo tools' })).toBeHidden()


    await page.getByRole('button', { name: 'Confirm plan' }).click();
    const plan = page.getByRole('dialog', { name: 'Confirm plan?' })
    await expect(plan).toBeVisible()
    await plan.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(plan).toBeHidden()
    await expect(page.getByRole('region', { name: 'Plan confirmed' })).toBeVisible()
    await page.getByRole('link', { name: 'Save plan' }).click();

    await expect(page).toHaveURL(/\/sessions\/[^/]+\/itinerary$/)
    await expect(page.getByRole('list', { name: 'Stops' }).getByRole('article')).toHaveCount(count)
  })

  test('Change the meeting place after voting', async ({ page }) => {
    await reachVote(page)
    const slots = page.getByRole('region').filter({ has: page.getByRole('button', { name: /^Vote for / }) })
    await expect(slots.first()).toBeVisible()
    const count = await slots.count()
    for (let i=0;i<count;i++) {
      await slots.nth(i).getByRole('button', { name: /^Vote for / }).first().click()
    }
    // One vote is pressed in each category, so the check at the end has votes to see cleared
    await expect(page.getByRole('button', { name: /^Vote for /, pressed: true })).toHaveCount(count)

    await page.getByRole('button', { name: 'Change plan'}).click()
    const change = page.getByRole('dialog', { name: 'Change plan' })
    await expect(change).toBeVisible()
    await change.getByRole('button', { name: /^Change meeting place/ }).click()

    // The same box asks again, under a new title, and names what is lost
    const lose = page.getByRole('dialog', { name: 'Change the meeting place?' })
    await expect(lose).toBeVisible()
    await expect(lose).toContainText("everyone's votes")
    await lose.getByRole('button', { name: 'Choose a new meeting place' }).click()
    await expect(lose).toBeHidden()

    // The host names the new area: Bugis, which the planner did not pick
    await expect(page).toHaveURL(/\/sessions\/[^/]+\/change-place$/)
    await page.getByRole('radio', { name: /^We already know where/ }).click()
    await page.getByRole('button', { name: 'Choose the area' }).click()
    await expect(page.getByRole('heading', { name: 'Where is the place?' })).toBeVisible()
    await page.getByRole('textbox', { name: 'Search for an area' }).fill('Bugis')
    await page.getByRole('radio', { name: 'Bugis', exact: true }).click()
    await page.getByRole('button', { name: 'Meet at Bugis' }).click()

    // Back on Vote at Bugis: the notice says why, and none of the old votes is left
    await expect(page).toHaveURL(/\/sessions\/[^/]+\/plan$/)
    await expect(page.getByText('Ian changed the meeting place to Bugis, so the votes were cleared.')).toBeVisible()
    await expect(slots.first()).toBeVisible()
    await expect(page.getByRole('button', { name: /^Vote for /, pressed: true })).toHaveCount(0)
  })
})
