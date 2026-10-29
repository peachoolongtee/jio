//Planning an outing end to end tests

import { test, expect, signInDemo, createSession, inviteAndStart, openDemoTools } from './fixtures.js'

test.describe('Planning an outing', () => {
  test('Planning an outing end to end', async ({ page }) => {
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

    const slots = page.getByRole('region').filter({ has: page.getByRole('button', { name: /^Vote for / }) })
    await expect(slots.first()).toBeVisible()
    const count = await slots.count()
    for (let i=0;i<count;i++) {
      await slots.nth(i).getByRole('button', { name: /^Vote for / }).first().click()
    }

    await openDemoTools(page)
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
})
