// "Any dietary needs?" (ticket #107): not in sign-up, but asked once, and skippable, the first time a person creates or joins
// an outing (auth.askDietOnce, components/event/DietaryFirstAsk.vue). The answer is saved on the profile; answered or skipped,
// it is not asked again, and a person who already set needs on their profile is never asked.
import { afterAll, describe, expect, it, vi } from 'vitest'
import { loadApi } from './planFixture.js'
import { mountScreen } from './domless.js'

vi.setConfig({ testTimeout: 20000 })
afterAll(() => vi.unstubAllGlobals())

// A local account signed in as Ian, with `dietary` on the profile, and the auth and events stores over it.
// How to call: const { auth, events, pinia } = await signedIn([])
async function signedIn(dietary = []) {
  const api = await loadApi()
  await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines', dietary })
  const { createPinia, setActivePinia } = await import('pinia')
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  const { useEventsStore } = await import('@/stores/events.js')
  const auth = useAuthStore()
  auth.user = await api.getUser()
  return { api, auth, events: useEventsStore(), pinia }
}
const OUTING = { title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' }

describe('the first outing asks for dietary needs once', () => {
  it('asks when the first outing is created, saves the answer on the profile, and does not ask again', async () => {
    const { auth, events } = await signedIn()
    expect(auth.dietAsk).toBe(false)
    await events.create(OUTING)
    expect(auth.dietAsk).toBe(true)
    await auth.answerDietAsk(['halal'])
    expect(auth.dietAsk).toBe(false)
    expect(auth.user.dietary).toEqual(['halal'])
    expect(auth.user.dietAsked).toBe(true)
    await events.create(OUTING)
    expect(auth.dietAsk).toBe(false)
  })

  it('can be skipped, and is not asked again after a skip either', async () => {
    const { auth, events } = await signedIn()
    await events.startRoam({ areaId: 'bugis' })
    expect(auth.dietAsk).toBe(true)
    await auth.answerDietAsk([])
    expect(auth.user.dietary).toEqual([])
    expect(auth.user.dietAsked).toBe(true)
    await events.create(OUTING)
    expect(auth.dietAsk).toBe(false)
  })

  it('is not asked of someone who already set needs on their profile', async () => {
    const { auth, events } = await signedIn(['vegan'])
    await events.create(OUTING)
    expect(auth.dietAsk).toBe(false)
  })

  it('is a dialog with the three needs, saved with Save and skipped with "None, skip"', async () => {
    const { auth, events, pinia } = await signedIn()
    const { default: DietaryFirstAsk } = await import('@/components/event/DietaryFirstAsk.vue')
    const view = await mountScreen(DietaryFirstAsk, { plugins: [pinia] })
    expect(view.has('[data-testid="diet-first-ask"]')).toBe(false)
    await events.create(OUTING)
    await view.tick()
    expect(view.text('h2')).toBe('Any dietary needs?')
    const chip = (name) => view.all('button').find((b) => b.attrs['aria-pressed'] !== undefined && view.text(b) === name)
    expect(['Halal', 'Vegetarian', 'Vegan'].every((name) => chip(name))).toBe(true)
    expect(view.text('[data-testid="diet-first-save"]')).toBe('None, skip')
    await view.click(chip('Vegetarian'))
    expect(view.text('[data-testid="diet-first-save"]')).toBe('Save')
    await view.click('[data-testid="diet-first-save"]')
    await vi.waitFor(() => expect(auth.user.dietAsked).toBe(true))
    await view.tick()
    expect(auth.user.dietary).toEqual(['vegetarian'])
    expect(view.has('[data-testid="diet-first-ask"]')).toBe(false)
  })
})
