// Example test, to copy: the demo account starts a new meetup on Home, fills in the title, the day and the times, presses Next,
// and lands on the Invite screen, which shows the session it just made.
//
// Copy this file, rename it for your feature (my-feature.spec.js), and change the steps. Find things the way a person does, by
// role and name (getByRole, getByLabel, getByText), never by CSS class or position.
import { test, expect, signInDemo, setTime, dayName, daysAhead } from './fixtures.js'

test.describe('Create a session', () => {
  test('the demo account creates a session and lands on the Invite screen', async ({ page }) => {
    const title = 'Saturday makan trip'
    // The fixed clock makes today Wednesday 4 November 2026, so this is Saturday 7 November.
    const day = daysAhead(3)

    // 1. Sign in as the demo account. It ends on Home, with no meetups yet.
    await signInDemo(page)
    await expect(page.getByRole('heading', { level: 1, name: /Hi,\s*Ian/ })).toBeVisible()

    // 2. Start a new meetup. With no meetups, the map's pin is the way in.
    await page.getByRole('link', { name: 'Jio your friends' }).click()
    await expect(page).toHaveURL(/\/sessions\/new$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Create session' })).toBeVisible()

    // 3. Fill in the title, pick the day, set the times. Next stays disabled until the form is ready.
    await page.getByLabel('Title', { exact: true }).fill(title)
    await page.getByRole('button', { name: dayName(day) }).click()
    await expect(page.getByRole('button', { name: dayName(day) })).toHaveAttribute('aria-pressed', 'true')
    await setTime(page, 'Start time', '14:00')
    await setTime(page, 'End time', '18:30')

    // 4. Press Next.
    const next = page.getByRole('button', { name: 'Next', exact: true })
    await expect(next).toBeEnabled()
    await next.click()

    // 5. The Invite screen opens at the new session's address, and shows the session's title.
    await expect(page).toHaveURL(/\/sessions\/[^/]+\/invite$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Invite friends' })).toBeVisible()
    await expect(page.getByText(title, { exact: true })).toBeVisible()
  })
})
