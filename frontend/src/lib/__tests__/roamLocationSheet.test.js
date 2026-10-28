// The Roam page with the location sheet's own "Use current location" (components/group/LocationSheet.vue), the second way of
// asking for a position on that page next to its "Use my location" button. roamScreen.test.js stands the sheet in; here the
// real sheet is drawn (only the popover around it and its text field are plain boxes, since the real ones are placed and focused in a browser).
// The sheet asks the browser for the position, turns it into an area, and hands the page that area (id, label, sub, areaId) and
// no coordinates, so the list is centred on the area's own point and the exact position goes nowhere.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { fakeStorage } from './planFixture.js'
import { mount } from './miniDom.js'

vi.mock('../plannerApi.js', () => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), roamNearby: vi.fn() }))
vi.mock('../api.js', async (original) => ({ ...(await original()), roamNearby: vi.fn(), placeFromCoords: vi.fn(), listAreas: vi.fn(), getPlace: vi.fn() }))
// The map is Leaflet, which needs a browser: the list is what these tests read.
vi.mock('../../components/map/PlannerMap.vue', () => ({ default: { render: () => null } }))
vi.mock('../../components/ui/PopoverPanel.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      props: ['open', 'title', 'width'],
      emits: ['update:open'],
      setup: (p, { slots }) => () => (p.open ? h('section', { role: 'dialog' }, [h('h2', p.title), slots.default?.()]) : null),
    }),
  }
})
vi.mock('../../components/ui/TextField.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ props: ['modelValue', 'label'], setup: () => () => h('input') }) }
})
vi.mock('../../components/event/SessionHeader.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ props: ['session', 'title'], setup: (p) => () => h('h1', p.title || p.session.title) }) }
})
vi.mock('../../components/event/SessionNotices.vue', async () => {
  const { defineComponent } = await import('vue')
  return { default: defineComponent({ props: ['session'], setup: () => () => null }) }
})

vi.stubGlobal('localStorage', fakeStorage())
const api = await import('../api.js')
const { default: RoamView } = await import('../../views/RoamView.vue')
const { useEventsStore } = await import('../../stores/events.js')
const { useAuthStore } = await import('../../stores/auth.js')

const venue = { id: 'v1', name: 'Green Kitchen', category: 'eat', area: 'Bishan', price: 12, lat: 1.35, lng: 103.85 }
const place = { id: 'v1', venue, rank: 1, score: 5, walk: 2, reasons: [], warnings: [], swap: null, travelMinutes: 4.4, distanceKm: 0.3, distanceM: 300, approximate: false, state: 'free', proposal: null }
const session = {
  id: 's1', title: 'Saturday', status: 'confirmed', hostId: 'ian', hostName: 'Ian', isToday: true, areaName: 'Bishan', area: { id: 'bishan', name: 'Bishan' },
  activeIds: ['ian', 'faith'], plan: { stops: [{ slotId: 'eat', venueId: 'v9' }] }, proposals: [],
}
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
const REQUEST = (point) => ['s1', { point, categories: ['eat', 'drink', 'shop', 'activity'], unconfirmed: false }]

let pinia
beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  const events = useEventsStore()
  useAuthStore().user = { id: 'ian', name: 'Ian', username: 'ian', local: true }
  events.byId = { s1: session }
  vi.spyOn(events, 'loadSession').mockResolvedValue(session)
  api.roamNearby.mockReset().mockResolvedValue({ centre: { areaId: 'bishan', areaName: 'Bishan' }, places: [place], empty: null, widened: false, blocked: '' })
  api.placeFromCoords.mockReset()
  api.listAreas.mockReset().mockResolvedValue([{ id: 'toa-payoh', name: 'Toa Payoh', lat: 1.3343, lng: 103.8563 }])
})
afterEach(() => vi.unstubAllGlobals())

// Open the page, refuse "Use my location" so the sheet opens, and give the browser a position for the sheet's own button.
async function openSheet(position) {
  // The page's way on ("Itinerary") is a link, so it needs a router.
  const { createRouter, createMemoryHistory } = await import('vue-router')
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:rest(.*)*', component: { render: () => null } }] })
  const page = mount(RoamView, { id: 's1' }, [pinia, router])
  await flush()
  vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: vi.fn((ok, refuse) => (refuse ? refuse({ code: 1 }) : null)) } })
  await page.button('Use my location').click()
  expect(page.button('Use current location')).not.toBeNull()
  vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: vi.fn(position) } })
  return page
}

describe('the sheet\'s "Use current location" on the Roam page', () => {
  it('centres the list on the area of the position, at the area\'s own point, and never sends the position', async () => {
    api.placeFromCoords.mockResolvedValue({ id: 'here-toa-payoh', label: 'Current location', sub: 'Toa Payoh', areaId: 'toa-payoh' })
    const page = await openSheet((ok) => ok({ coords: { latitude: 1.33217, longitude: 103.84779 } }))
    await page.button('Use current location').click()
    await flush()
    expect(api.placeFromCoords).toHaveBeenCalledWith(1.33217, 103.84779)
    expect(api.roamNearby).toHaveBeenLastCalledWith(...REQUEST({ lat: 1.3343, lng: 103.8563 }))
    expect(page.all().find((el) => el.props['data-testid'] === 'roam-centre') && page.textOf(page.all().find((el) => el.props['data-testid'] === 'roam-centre'))).toBe('Near Toa Payoh')
    expect(JSON.stringify(api.roamNearby.mock.calls)).not.toContain('1.33217')
    expect(page.text()).not.toContain('1.33217')
    // The sheet has closed.
    expect(page.button('Use current location')).toBeNull()
  })

  it('says so in the sheet, and leaves the list where it was, when the position is outside Singapore', async () => {
    api.placeFromCoords.mockResolvedValue(null)
    const page = await openSheet((ok) => ok({ coords: { latitude: 51.5, longitude: -0.12 } }))
    const asked = api.roamNearby.mock.calls.length
    await page.button('Use current location').click()
    await flush()
    expect(page.text()).toContain('Your current location is outside Singapore. Search for a place instead.')
    expect(api.roamNearby).toHaveBeenCalledTimes(asked)
  })

  it('says so in the sheet, and leaves the list where it was, when the browser refuses the sheet\'s own request', async () => {
    const page = await openSheet((ok, refuse) => refuse({ code: 1 }))
    const asked = api.roamNearby.mock.calls.length
    await page.button('Use current location').click()
    await flush()
    expect(page.text()).toContain('Location access is off. Search for a place instead.')
    expect(api.roamNearby).toHaveBeenCalledTimes(asked)
  })
})
