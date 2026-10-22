// "Any dietary needs?" (ticket #107): not a question in sign-up, but a popup asked once, right after the account is made
// (auth.signUp, components/event/DietaryFirstAsk.vue). The answer is saved on the profile; answered or skipped, it closes for
// good, and nothing else opens it.
import { afterAll, describe, expect, it, vi } from 'vitest'
import { loadApi } from './planFixture.js'
import { mountScreen } from './domless.js'

vi.setConfig({ testTimeout: 20000 })
afterAll(() => vi.unstubAllGlobals())

// A local account's sign-up draft, filled in, with the auth and events stores. How to call: const { auth } = await fresh()
async function fresh() {
  await loadApi()
  const { createPinia, setActivePinia } = await import('pinia')
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  const { useEventsStore } = await import('@/stores/events.js')
  const auth = useAuthStore()
  Object.assign(auth.draft, { email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' })
  return { auth, events: useEventsStore(), pinia }
}

describe('the dietary popup after sign-up', () => {
  it('opens once the account is made, saves the answer on the profile, and does not open again', async () => {
    const { auth, events } = await fresh()
    expect(auth.dietAsk).toBe(false)
    await auth.signUp()
    expect(auth.dietAsk).toBe(true)
    await auth.answerDietAsk(['halal'])
    expect(auth.dietAsk).toBe(false)
    expect(auth.user.dietary).toEqual(['halal'])
    await events.create({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' })
    expect(auth.dietAsk).toBe(false)
  })

  it('can be skipped, which leaves the profile with no needs', async () => {
    const { auth } = await fresh()
    await auth.signUp()
    await auth.answerDietAsk([])
    expect(auth.dietAsk).toBe(false)
    expect(auth.user.dietary).toEqual([])
  })

  it('is a popup with the three needs, saved with Save and skipped with "None, skip"', async () => {
    const { auth, pinia } = await fresh()
    const { default: DietaryFirstAsk } = await import('@/components/event/DietaryFirstAsk.vue')
    const view = await mountScreen(DietaryFirstAsk, { plugins: [pinia] })
    expect(view.has('[data-testid="diet-first-ask"]')).toBe(false)
    await auth.signUp()
    await view.tick()
    expect(view.text('h2')).toBe('Any dietary needs?')
    const chip = (name) => view.all('button').find((b) => b.attrs['aria-pressed'] !== undefined && view.text(b) === name)
    expect(['Halal', 'Vegetarian', 'Vegan'].every((name) => chip(name))).toBe(true)
    expect(view.text('[data-testid="diet-first-save"]')).toBe('None, skip')
    await view.click(chip('Vegetarian'))
    expect(view.text('[data-testid="diet-first-save"]')).toBe('Save')
    await view.click('[data-testid="diet-first-save"]')
    await vi.waitFor(() => expect(auth.dietAsk).toBe(false))
    await view.tick()
    expect(auth.user.dietary).toEqual(['vegetarian'])
    expect(view.has('[data-testid="diet-first-ask"]')).toBe(false)
  })
})
