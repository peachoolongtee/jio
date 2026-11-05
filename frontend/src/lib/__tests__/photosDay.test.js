// Photos open on the outing's day (UAT of 29 October 2026, item 6): from the Singapore day of the outing on, for every member, and not
// before. The Photos row on the itinerary, the Photos page and adding a photo (so a typed address gets no further) all follow it. The
// confirmed outing of the fixture is for 10 October. Local outings are drawn for real (domless.js) on the stand-in planner.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { STORAGE_KEY, confirmedSave, loadApi, stubPlanner } from './planFixture.js'
import { mountScreen, until } from './domless.js'
import { PHOTOS_BEFORE_DAY, photosOpen } from '../session.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), roamNearby: vi.fn(), forecast: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
vi.mock('@/components/map/PlannerMap.vue', () => ({ default: { render: () => null } }))
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 })

const at = (iso) => vi.setSystemTime(new Date(iso))
const mounted = []

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  at('2026-10-09T10:00:00+08:00')
  stubPlanner(planner)
  await confirmedSave()
})
beforeEach(() => stubPlanner(planner))
afterEach(() => {
  mounted.splice(0).forEach((view) => view.unmount())
  vi.unstubAllGlobals()
})
afterAll(() => vi.useRealTimers())

describe('photosOpen', () => {
  const outing = { date: '2026-10-10' }

  it('is closed the day before, open from the first minute of the day in Singapore, and open after', () => {
    expect(photosOpen(outing, new Date('2026-10-09T23:59:00+08:00'))).toBe(false)
    expect(photosOpen(outing, new Date('2026-10-10T00:00:00+08:00'))).toBe(true)
    expect(photosOpen(outing, new Date('2026-10-10T23:59:00+08:00'))).toBe(true)
    expect(photosOpen(outing, new Date('2026-10-14T12:00:00+08:00'))).toBe(true)
  })

  it('reads the day on Singapore’s clock, whatever the browser’s', () => {
    // 16:30 UTC on the 9th is half past midnight on the 10th in Singapore.
    expect(photosOpen(outing, new Date('2026-10-09T16:30:00Z'))).toBe(true)
    expect(photosOpen(outing, new Date('2026-10-09T15:30:00Z'))).toBe(false)
  })

  it('counts today as the day under the demo’s session-day switch, and is closed with no date', () => {
    expect(photosOpen({ date: '2026-12-25', isToday: true }, new Date('2026-10-09T10:00:00+08:00'))).toBe(true)
    expect(photosOpen({ date: '' }, new Date())).toBe(false)
    expect(photosOpen(null, new Date())).toBe(false)
  })
})

// The confirmed outing of the fixture, loaded with the clock at `iso`.
// How to call: const { api, id } = await outingAt('2026-10-10T09:00:00+08:00')
async function outingAt(iso) {
  const { text, id } = await confirmedSave()
  at(iso)
  const api = await loadApi({ data: { [STORAGE_KEY]: text } })
  return { api, id }
}

describe('adding a photo', () => {
  it('is refused before the day with a plain sentence, and nothing is saved', async () => {
    const { api, id } = await outingAt('2026-10-09T23:30:00+08:00')
    await expect(api.addPhoto(id, 'ian', 'data:early')).rejects.toThrow(PHOTOS_BEFORE_DAY)
    expect(PHOTOS_BEFORE_DAY).toBe('Photos open on the day of the outing.')
    expect(await api.getPhotos(id)).toEqual([])
  })

  it('works on the day, for the host and for a guest, and after it', async () => {
    const { api, id } = await outingAt('2026-10-10T00:05:00+08:00')
    await api.addPhoto(id, 'ian', 'data:host')
    await api.addPhoto(id, 'jonathan', 'data:guest')
    at('2026-10-12T09:00:00+08:00')
    await api.addPhoto(id, 'ian', 'data:later')
    expect((await api.getPhotos(id)).map((p) => p.src)).toEqual(['data:host', 'data:guest', 'data:later'])
  })

  it('opens at once under the demo’s session-day switch', async () => {
    const { api, id } = await outingAt('2026-10-08T10:00:00+08:00')
    await expect(api.addPhoto(id, 'ian', 'data:early')).rejects.toThrow(PHOTOS_BEFORE_DAY)
    await api.setConditions({ sessionDay: true })
    await api.addPhoto(id, 'ian', 'data:switched')
    expect((await api.getPhotos(id)).map((p) => p.src)).toEqual(['data:switched'])
  })
})

// The app's stores and router (stand-in screens) around a data layer, and a screen drawn on `path`.
// How to call: const view = await draw(api, '/sessions/s1/itinerary', 'EventView', { id: 's1' })
async function draw(api, path, name, props) {
  const { createPinia, setActivePinia } = await import('pinia')
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  await useAuthStore().init()
  const { routes } = await import('@/router/routes.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  vi.stubGlobal('window', { history: { state: null, replaceState() {} } })
  await router.push(path)
  const { default: screen } = await import(`@/views/${name}.vue`)
  const view = await mountScreen(screen, { plugins: [pinia, router], props })
  mounted.push(view)
  return view
}
const press = (view, label) => view.all('button').find((b) => view.text(b).includes(label))

describe('the Photos row on the itinerary', () => {
  it('is not there the day before', async () => {
    const { api, id } = await outingAt('2026-10-09T18:00:00+08:00')
    const view = await draw(api, `/sessions/${id}/itinerary`, 'EventView', { id })
    await until(() => view.has('[data-testid="change-plan"]'))
    expect(view.text()).not.toContain('Photos from the day')
  })

  // The row moved to the finish and review page, "How was it?" (Darius, 4 November 2026), so the itinerary has none on the day or
  // after it either. The Photos page itself still opens on the day (below).
  it.each([['on the day', '2026-10-10T08:00:00+08:00'], ['after it', '2026-10-13T08:00:00+08:00']])('is not there %s either: photos are added on "How was it?"', async (_name, iso) => {
    const { api, id } = await outingAt(iso)
    const view = await draw(api, `/sessions/${id}/itinerary`, 'EventView', { id })
    await until(() => view.has('[data-testid="change-plan"]'))
    expect(view.text()).not.toContain('Photos from the day')
  })
})

describe('the Photos page', () => {
  it('says photos open on the day before it, with the way back and no camera', async () => {
    const { api, id } = await outingAt('2026-10-09T18:00:00+08:00')
    const view = await draw(api, `/sessions/${id}/photos`, 'PhotosView', { id })
    await until(() => view.has('[data-testid="photos-before-day"]'))
    expect(view.text('[data-testid="photos-before-day"]')).toContain('Photos open on the day')
    expect(view.all('input').some((i) => i.attrs.type === 'file')).toBe(false)
    expect(press(view, 'Add photos')).toBeUndefined()
  })

  it('opens on the day, with the camera', async () => {
    const { api, id } = await outingAt('2026-10-10T08:00:00+08:00')
    const view = await draw(api, `/sessions/${id}/photos`, 'PhotosView', { id })
    await until(() => view.all('input').some((i) => i.attrs.type === 'file'))
    expect(view.has('[data-testid="photos-before-day"]')).toBe(false)
  })

  it('loads the pictures by itself when the page is left open past midnight and the day begins', async () => {
    // The shared clock (lib/useNow.js) ticks every 30 seconds; here it is a value the test moves.
    const { ref } = await import('vue')
    const clock = ref(new Date('2026-10-09T23:59:00+08:00'))
    vi.doMock('@/lib/useNow.js', () => ({ useNow: () => clock }))
    try {
      const { api, id } = await outingAt('2026-10-09T23:59:00+08:00')
      const view = await draw(api, `/sessions/${id}/photos`, 'PhotosView', { id })
      await until(() => view.has('[data-testid="photos-before-day"]'))
      const { useEventsStore } = await import('@/stores/events.js')
      const events = useEventsStore()
      expect(events.photos[id]).toBeUndefined()
      // The day opens: the page opens by itself and the pictures are asked for.
      at('2026-10-10T00:01:00+08:00')
      clock.value = new Date('2026-10-10T00:01:00+08:00')
      await until(() => view.all('input').some((i) => i.attrs.type === 'file'))
      await until(() => Array.isArray(events.photos[id]))
      expect(view.has('[data-testid="photos-before-day"]')).toBe(false)
    } finally {
      vi.doUnmock('@/lib/useNow.js')
      at('2026-10-09T10:00:00+08:00')
    }
  })
})
