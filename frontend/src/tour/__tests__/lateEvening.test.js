// The demo tour loaded late in the evening, and in the morning: its "today" outings have a window fixed at load time (todayWindow:
// at most six hours, ending no later than 23:00), and the tour and the showcase must stay as designed whatever the hour. No
// session built by them is finished or closed by its end time (keepOpen), so "On the day" is still a plan under way, nobody is
// paid for it, and the finished save was paid once, by hand. Built through the public functions of lib/api.js, with the planner
// backend not there (a closed port), as in story.test.js.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadApi } from '../../lib/__tests__/planFixture.js'
import { DEMO_ACCOUNT } from '../../components/dev/demoAccount.js'
import { itineraryAction } from '../../lib/session.js'

vi.setConfig({ testTimeout: 90000, hookTimeout: 90000 })

const DEAD_BACKEND = 'http://127.0.0.1:1'
const stubPhotos = async (kinds, count) => Array.from({ length: count }, (_, i) => `data:image/jpeg;base64,AAAA${i}`)

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
})
afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// The tour loaded at `iso`, the demo account signed in, nothing else.
// How to call: const { api, tour } = await loadAt('2026-10-10T23:30:00')
async function loadAt(iso) {
  const now = new Date(iso)
  vi.setSystemTime(now)
  const api = await loadApi()
  await api.signUp(DEMO_ACCOUNT)
  api.api.defaults.baseURL = DEAD_BACKEND
  const { createPinia, setActivePinia } = await import('pinia')
  setActivePinia(createPinia())
  const { useTourStore } = await import('../store.js')
  const tour = useTourStore()
  await tour.attach()
  await tour.settled()
  await tour.start({ now, makePhotos: stubPhotos })
  return { api, tour, now }
}

const story = (list, tour) => tour.manifest.story.map((id) => list.find((s) => s.id === id))

describe('the tour loaded late in the evening', () => {
  let loaded
  beforeAll(async () => {
    loaded = await loadAt('2026-10-10T23:30:00')
  })

  it('has a "today" window that is already over when it is loaded', async () => {
    const list = await loaded.api.listSessions()
    const today = story(list, loaded.tour)[6]
    expect(today.end < '23:30').toBe(true)
    expect(today.date).toBe('2026-10-10')
  })

  it('keeps "On the day" a plan under way, with "Finish outing" offered, not finished at once', async () => {
    const list = await loaded.api.listSessions()
    const [, , , , , , today, finished] = story(list, loaded.tour)
    expect(today).toMatchObject({ status: 'confirmed', isToday: true, end: '23:00' })
    expect(itineraryAction(today)).toBe('finish')
    expect(today.endedBy).toBeUndefined()
    expect(finished).toMatchObject({ status: 'completed', endedBy: 'hand', paid: true })
  })

  it('still leaves it so on the next morning and days later, and pays nothing more', async () => {
    const before = JSON.parse(loaded.api.storage.store['jio-demo-v1']).stats.ian.points
    for (const iso of ['2026-10-11T00:30:00', '2026-10-11T09:00:00', '2026-10-15T09:00:00']) {
      vi.setSystemTime(new Date(iso))
      const list = await loaded.api.listSessions()
      const [, , , , , confirmed, today] = story(list, loaded.tour)
      expect(today.status, iso).toBe('confirmed')
      expect(confirmed.status, iso).toBe('confirmed')
      // The side cases and earlier saves, none of them closed two days past their end with no plan.
      expect(list.filter((s) => s.status === 'completed').map((s) => s.id)).toEqual([loaded.tour.manifest.story[7]])
    }
    expect(JSON.parse(loaded.api.storage.store['jio-demo-v1']).stats.ian.points).toBe(before)
  })
})

describe('the tour loaded in the morning', () => {
  it('keeps "On the day" for the whole day, past the six hours of its window', async () => {
    const { api, tour } = await loadAt('2026-10-10T08:00:00')
    for (const iso of ['2026-10-10T08:05:00', '2026-10-10T13:31:00', '2026-10-10T22:00:00']) {
      vi.setSystemTime(new Date(iso))
      const list = await api.listSessions()
      const today = story(list, tour)[6]
      expect(today.status, iso).toBe('confirmed')
      expect(itineraryAction(today), iso).toBe('finish')
    }
  })
})
