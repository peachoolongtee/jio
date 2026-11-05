// Owner: Nichole. Feature: session rules, mainly the rule that a session cannot be planned in the past, and the rule that its date
// and times lock once it starts.
//
// Run only this file, from the repo root:
//   pnpm --filter jio-frontend exec playwright test tests/e2e/nichole.spec.js
import { test, expect, signInDemo, createSession, inviteAndStart, setTime, dayName, daysAhead } from './fixtures.js'

// What it proves: the Create form will not make a session for a day that has gone, or for a start time that has already passed
// today, and a day in the future goes through.
// Starting state: the demo account on Home with no meetups. The browser's clock is Wed 4 Nov 2026, 10:00 in Singapore, so
// "yesterday" is Tue 3 Nov and "a start that has passed today" is anything up to 10:00 on Wed 4 Nov.
// Steps: open Create and type a title; yesterday is a disabled day, so Next stays blocked; pick today and set a start of 09:00,
// which shows its message; pick a day ahead, which clears it, and Next goes on to the Start choice.
// Checked at the end: the Start choice is open for the new session.
// Good to know: the app refuses a past DAY by greying the day out, not by a message, so that is what the test checks. The message
// "That start time has already passed today." is for a start time earlier today.
test.describe('Session rules', () => {
  test('Create refuses the past: a past day and a start that has already passed', async ({ page }) => {
    await signInDemo(page)
    await page.getByRole('link', { name: 'Jio your friends' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Create session' })).toBeVisible()
    await page.getByLabel('Title', { exact: true }).fill('Past date check')
    const next = page.getByRole('button', { name: 'Next', exact: true })

    // 1. Yesterday cannot be picked, and with no day Next is blocked.
    const yesterday = page.getByRole('button', { name: dayName(daysAhead(-1)) })
    await expect(yesterday).toBeDisabled()
    await expect(next).toBeDisabled()

    // 2. Today is allowed, but only with a start that is still ahead. 09:00 is before the fixed 10:00.
    await page.getByRole('button', { name: dayName(daysAhead(0)) }).click()
    await setTime(page, 'Start time', '09:00')
    await expect(page.getByText('That start time has already passed today.')).toBeVisible()
    await expect(page.getByLabel('Start time', { exact: true })).toHaveAttribute('aria-invalid', 'true')
    await expect(next).toBeDisabled()

    // 3. A day ahead has no such limit: the message goes and Next opens.
    await page.getByRole('button', { name: dayName(daysAhead(3)) }).click()
    await expect(page.getByText('That start time has already passed today.')).toBeHidden()
    await expect(next).toBeEnabled()
    await next.click()
    await expect(page).toHaveURL(/\/sessions\/[^/]+\/start$/)
    await expect(page.getByRole('heading', { level: 2, name: 'How do you want to pick the meeting point?' })).toBeVisible()
  })

  // What it proves: the host can rename a session and move its date while it is inviting, and once Start session has been
  // pressed the date and times can no longer be changed.
  // Starting state: the demo account on Home with no meetups; a session made through the form for Sat 7 Nov.
  // Steps: on the Start choice, go back to the form, rename the session and move it to Sun 8 Nov, Next; see the new title and date on the
  // session page; keep the fairest spot, invite Darius, press Start session; then open the Create step from the steps bar.
  // Checked at the end: the form is replaced by "The date and times are locked once a session has started." and has no title field,
  // calendar or time fields.
  // Good to know: the brief expected the title to stay editable after the start. In this build it does not: the whole edit form,
  // title included, is replaced by the lock message (CreateEventView.vue, and updateSession in lib/api.js refuses any change
  // after the start). So the test checks what is true: renaming works before the start, nothing can be changed after it.
  test('Dates lock once a session starts', async ({ page }) => {
    await signInDemo(page)
    await createSession(page, { title: 'Before the rename', day: daysAhead(3) })

    // 1. While inviting: back to the form, change the title and the day.
    await page.getByRole('link', { name: 'Back', exact: true }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Edit session' })).toBeVisible()
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Before the rename')
    await page.getByLabel('Title', { exact: true }).fill('After the rename')
    await page.getByRole('button', { name: dayName(daysAhead(4)) }).click()
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'How do you want to pick the meeting point?' })).toBeVisible()
    await expect(page.getByText('After the rename', { exact: true })).toBeVisible()

    // 2. Invite one friend and start. The session page shows the new title and Sunday 8 Nov.
    await inviteAndStart(page, ['Darius'])
    await expect(page.getByRole('heading', { level: 1, name: 'After the rename' })).toBeVisible()
    await expect(page.getByText(/Sun 8 Nov/)).toBeVisible()

    // 3. The Create step is still a link, but it says it is locked, and the form is gone.
    await page.getByRole('link', { name: 'Step 1 of 5: Create, locked once the session starts' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Edit session' })).toBeVisible()
    await expect(page.getByText('The date and times are locked once a session has started.')).toBeVisible()
    await expect(page.getByLabel('Title', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('group', { name: 'Date' })).toHaveCount(0)
    await expect(page.getByLabel('Start time', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Back to session' })).toBeVisible()
  })
})
