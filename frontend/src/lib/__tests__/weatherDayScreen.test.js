// The itinerary's weather, drawn with the tiny stand-in for the page (miniDom.js), a real events store, and the data layer's
// calls stood in for: the marks from a stored plan and from an old save, the check on the day (when it asks, when it does not,
// what it keeps when it fails), and the rain banners (who sees what, the host's swap and keep, and that nothing swaps unasked).
// Time is fake, so 30 minutes pass in an instant.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { fakeStorage } from './planFixture.js'
import { mount } from './miniDom.js'

vi.mock('../plannerApi.js', () => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), roamNearby: vi.fn() }))
vi.mock('../api.js', async (original) => ({
  ...(await original()),
  getSession: vi.fn(),
  getItinerary: vi.fn(),
  getConditions: vi.fn(),
  checkStopWeather: vi.fn(),
  findRainSwap: vi.fn(),
  swapOption: vi.fn(),
  dismissRainWarning: vi.fn(),
}))
vi.mock('vue-router', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useRoute: () => ({ params: {}, query: {} }),
    RouterLink: defineComponent({ props: ['to'], setup: (p, { slots }) => () => h('a', { href: String(p.to) }, slots.default?.()) }),
  }
})
// The parts of the itinerary that need a real browser, or that this test is not about, stand in as plain markup.
const stand = vi.hoisted(() => (tag) => async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ inheritAttrs: false, setup: (_p, { slots }) => () => h(tag, slots.default?.()) }) }
})
vi.mock('../../components/event/SessionHeader.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ props: ['session', 'title'], setup: (p) => () => h('h1', p.title || p.session.title) }) }
})
vi.mock('../../components/event/SessionNotices.vue', stand('div'))
vi.mock('../../components/event/ProposedStops.vue', stand('div'))
vi.mock('../../components/event/TravelConnector.vue', stand('div'))
// The map records the rain it is given, so a test can read what the screen asked it to draw.
const mapSeen = vi.hoisted(() => ({ rain: [], rainLabel: '' }))
vi.mock('../../components/map/PlannerMap.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      inheritAttrs: false,
      props: ['rain', 'rainLabel'],
      setup: (p) => () => {
        mapSeen.rain = p.rain
        mapSeen.rainLabel = p.rainLabel
        return h('div')
      },
    }),
  }
})
vi.mock('../../components/map/CategoryKey.vue', stand('div'))
vi.mock('../../components/ui/ModalDialog.vue', stand('div'))
vi.mock('../../components/ui/ToastMessage.vue', stand('div'))
vi.mock('../../components/ui/SplitView.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ setup: (_p, { slots }) => () => h('div', [slots.list?.(), slots.map?.()]) }) }
})
vi.mock('../../components/ui/SortableList.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      props: ['items'],
      setup: (p, { slots }) => () => h('div', p.items.map((item, index) => slots.item({ item, index, dragging: false, lifted: false, handle: {} }))),
    }),
  }
})

vi.stubGlobal('localStorage', fakeStorage())
vi.stubGlobal('window', { history: { state: null, replaceState() {} } })
const api = await import('../api.js')
const { default: EventView } = await import('../../views/EventView.vue')
const { default: SessionMapView } = await import('../../views/SessionMapView.vue')
const { useEventsStore } = await import('../../stores/events.js')
const { usePlannerStore } = await import('../../stores/planner.js')
const { useAuthStore } = await import('../../stores/auth.js')
const { CHECK_EVERY_MS } = await import('../weatherCheck.js')

const MIN = 60 * 1000
const venue = (id, name, extra = {}) => ({ id, name, category: 'activity', area: 'Marine Parade', price: 0, lat: 1.3, lng: 103.9, hours: [], ...extra })
const HAWKER = venue('hawker', 'Lau Pa Sat', { category: 'eat', area: 'Raffles Place', price: 8, setting: 'indoor', exposure: 1 })
const PARK = venue('park', 'East Coast Park', { setting: 'outdoor', exposure: 5, kind: 'park' })
const LIBRARY = venue('toa-payoh-library', 'Toa Payoh Public Library', { setting: 'indoor', exposure: 0 })
const BLOCK = { source: 'live', basis: 'area', issuedAt: '2026-10-10T09:30:00+08:00', validUntil: '2026-10-10T11:30:00+08:00' }
const wx = (state, over = {}) => ({ state, rainLikely: state === 'showers' || state === 'thundery', ...BLOCK, ...over })
const SIM = { source: 'simulated', basis: 'simulated' }

const stops = (weathers = [wx('cloudy'), wx('showers', { phrase: 'Light Showers' })], venues = [HAWKER, PARK]) => [
  { index: 0, slotId: 'eat', category: 'eat', venue: venues[0], start: 12 * 60, end: 13 * 60, duration: 60, open: true, weather: weathers[0] },
  { index: 1, slotId: 'activity', category: 'activity', venue: venues[1], start: 15 * 60, end: 16 * 60 + 30, duration: 90, open: true, weather: weathers[1] },
]
const itinerary = (over = {}) => ({
  stops: stops(), weather: BLOCK, legs: [{ index: 0, options: { walk: 10 }, mode: 'walk', minutes: 10 }], end: null, trips: [], aiNote: null, area: null, starts: [], ...over,
})
const session = (over = {}) => ({
  id: 's1', title: 'Saturday', status: 'confirmed', hostId: 'ian', hostName: 'Ian', isToday: false, date: '2026-10-10', activeIds: ['ian', 'faith'],
  plan: { stops: [{ slotId: 'eat' }, { slotId: 'activity' }] }, proposals: [], photoCount: 0, weatherDismissed: {}, ...over,
})

let pinia
let events
let conditions
let state
const pages = []
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(new Date('2026-10-10T10:00:00+08:00'))
  pinia = createPinia()
  setActivePinia(pinia)
  events = useEventsStore()
  useAuthStore().user = { id: 'ian', name: 'Ian', username: 'ian', local: true }
  conditions = { rain: false, routing: true, sessionDay: false }
  state = { session: session(), itinerary: itinerary() }
  api.getSession.mockReset().mockImplementation(async () => state.session)
  api.getItinerary.mockReset().mockImplementation(async () => state.itinerary)
  api.getConditions.mockReset().mockImplementation(async () => ({ ...conditions }))
  api.checkStopWeather.mockReset().mockImplementation(async () => ({ checkedAt: Date.now(), stops: { eat: wx('dry', { rainLikely: false }), activity: wx('showers') }, weather: BLOCK }))
  api.findRainSwap.mockReset().mockResolvedValue({ id: LIBRARY.id, name: LIBRARY.name })
  api.swapOption.mockReset().mockImplementation(async () => state.session)
  api.dismissRainWarning.mockReset().mockImplementation(async () => state.session)
})
afterEach(() => {
  // A page left mounted would go on reacting to the shared clock in the next test.
  for (const page of pages.splice(0)) page.app.unmount()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.stubGlobal('localStorage', fakeStorage())
  vi.stubGlobal('window', { history: { state: null, replaceState() {} } })
})

const settle = () => vi.advanceTimersByTimeAsync(0)
const open = async (over = {}) => {
  Object.assign(state, over)
  const page = mount(EventView, { id: 's1' }, [pinia])
  pages.push(page)
  await vi.advanceTimersByTimeAsync(50)
  return page
}
// Press a button by its label (or its accessible name) without waiting on a real timer.
async function press(page, label) {
  const el = page.all('button').find((b) => page.textOf(b).includes(label) || (b.props['aria-label'] || '').includes(label))
  if (!el) throw new Error(`no button "${label}" on the page`)
  await el.listeners.click({ pointerType: 'mouse', detail: 1, target: el })
  await vi.advanceTimersByTimeAsync(50)
}
const marks = (page) => page.all().filter((el) => el.props['data-testid'] === 'weather-mark').map((el) => page.textOf(el))
const lines = (page) => page.all().filter((el) => el.props['data-testid'] === 'weather-source')
// The buttons inside the rain banners, by their names (the page has other buttons: Edit, the dialogs' own).
const banners = (page) => page.all().filter((el) => el.props['data-testid'] === 'rain-banner')
const under = (el) => [el, ...el.children.flatMap(under)]
const bannerButtons = (page) => banners(page).flatMap(under).filter((n) => n.tag === 'button').map((b) => b.props['aria-label'] || page.textOf(b))

describe('the itinerary before its day', () => {
  it('shows each stop\'s mark from the plan, and one muted line for the source and time, with no request', async () => {
    const page = await open()
    expect(marks(page)).toEqual(['Cloudy', 'Outdoor, showers . Rain is likely at this open-air stop. NEA says Light Showers'])
    expect(lines(page)).toHaveLength(1)
    expect(page.textOf(lines(page)[0])).toContain('NEA forecast, 09:30')
    await vi.advanceTimersByTimeAsync(3 * 60 * MIN)
    expect(api.checkStopWeather).not.toHaveBeenCalled()
  })

  it('puts the line under the stops, once, and no second rain label on a stop', async () => {
    const page = await open()
    const text = page.text()
    expect(text.indexOf('East Coast Park')).toBeLessThan(text.indexOf('NEA forecast'))
    expect(text.split('NEA forecast, 09:30').length - 1).toBe(1)
    expect(page.all('', 'rain expected')).toHaveLength(0)
  })

  it('shows an old save, whose stops have no weather, as checked from the day before, with the line for a stop outside the window, and no error', async () => {
    const page = await open({ itinerary: itinerary({ stops: stops([null, null]), weather: null }) })
    expect(marks(page)).toEqual(['Weather is checked from the day before', 'Weather is checked from the day before'])
    expect(page.textOf(lines(page)[0])).toContain('Weather is checked from the day before')
    expect(page.all('', 'undefined')).toHaveLength(0)
    expect(page.all('p').filter((p) => p.props.role === 'alert')).toHaveLength(0)
  })

  it('reads a stop outside the forecast window as checked from the day before too', async () => {
    const outside = { state: 'unknown', rainLikely: false, source: 'none', basis: 'none', reason: 'outside_window' }
    const page = await open({ itinerary: itinerary({ stops: stops([outside, outside]), weather: { source: 'none', basis: 'none', reason: 'outside_window' } }) })
    expect(marks(page)).toEqual(['Weather is checked from the day before', 'Weather is checked from the day before'])
    expect(page.textOf(lines(page)[0])).toContain('Weather is checked from the day before')
  })

  it('says "Indoor" for an indoor stop when rain is likely there, and not in the warning tone', async () => {
    const page = await open({ itinerary: itinerary({ stops: stops([wx('showers'), wx('showers')], [HAWKER, LIBRARY]) }) })
    expect(marks(page).map((m) => m.split(' . ')[0])).toEqual(['Indoor', 'Indoor'])
    const tags = page.all('span').filter((el) => el.props['data-testid'] === 'weather-mark')
    for (const tag of tags) expect(tag.props.class).not.toContain('tag--warning')
  })

  it('uses the warning tone only for the exposed stop with rain likely', async () => {
    const page = await open()
    const tags = page.all('span').filter((el) => el.props['data-testid'] === 'weather-mark')
    expect(tags.map((t) => t.props.class.includes('tag--warning'))).toEqual([false, true])
  })

  it('shows no weather for a plan that is not confirmed', async () => {
    const page = await open({ session: session({ status: 'completed' }) })
    expect(marks(page)).toEqual([])
    expect(lines(page)).toHaveLength(0)
  })
})

describe('the check on the day', () => {
  beforeEach(() => {
    state.session = session({ isToday: true })
  })

  it('asks once when the itinerary opens, and shows what it found over the plan\'s own marks', async () => {
    const page = await open()
    expect(api.checkStopWeather).toHaveBeenCalledTimes(1)
    expect(api.checkStopWeather).toHaveBeenCalledWith('s1')
    expect(marks(page).map((m) => m.split(' . ')[0])).toEqual(['Dry', 'Outdoor, showers'])
  })

  it('asks again after 30 minutes, not before, and keeps asking every 30 minutes while it stays open', async () => {
    await open()
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS - MIN)
    expect(api.checkStopWeather).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(api.checkStopWeather).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS)
    expect(api.checkStopWeather).toHaveBeenCalledTimes(3)
  })

  it('asks nothing more on a change of focus or of window, or when the same itinerary is loaded again', async () => {
    await open()
    for (let i = 0; i < 20; i++) await events.loadItinerary('s1')
    await settle()
    expect(api.checkStopWeather).toHaveBeenCalledTimes(1)
  })

  it('does not ask for a plan that is not under way: not confirmed, or not its day', async () => {
    await open({ session: session({ isToday: false }) })
    await open({ session: session({ isToday: true, status: 'voting' }) })
    await vi.advanceTimersByTimeAsync(2 * CHECK_EVERY_MS)
    expect(api.checkStopWeather).not.toHaveBeenCalled()
  })

  it('asks again at once when the stops change (a swap, a move, a delete)', async () => {
    await open()
    state.itinerary = itinerary({ stops: stops([wx('dry', { rainLikely: false }), wx('showers')], [HAWKER, LIBRARY]) })
    await events.loadItinerary('s1')
    await settle()
    expect(api.checkStopWeather).toHaveBeenCalledTimes(2)
  })

  it('has one check at a time: a change while one is running waits for it, and runs once after', async () => {
    let running = 0
    let most = 0
    api.checkStopWeather.mockImplementation(async () => {
      running += 1
      most = Math.max(most, running)
      await new Promise((resolve) => setTimeout(resolve, 5000))
      running -= 1
      return { checkedAt: Date.now(), stops: { activity: wx('showers') }, weather: BLOCK }
    })
    await open()
    const planner = usePlannerStore()
    for (let i = 0; i < 4; i++) {
      conditions.rain = !conditions.rain
      await planner.loadConditions()
      await vi.advanceTimersByTimeAsync(100)
    }
    await vi.advanceTimersByTimeAsync(20000)
    expect(most).toBe(1)
    expect(api.checkStopWeather.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('stops when the page is left: no check afterwards', async () => {
    const page = await open()
    expect(api.checkStopWeather).toHaveBeenCalledTimes(1)
    page.app.unmount()
    await vi.advanceTimersByTimeAsync(3 * CHECK_EVERY_MS)
    expect(api.checkStopWeather).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits while the page is hidden, and asks once when it is shown', async () => {
    const listeners = new Set()
    const doc = { visibilityState: 'visible', addEventListener: (_n, fn) => listeners.add(fn), removeEventListener: (_n, fn) => listeners.delete(fn) }
    vi.stubGlobal('document', doc)
    await open()
    expect(api.checkStopWeather).toHaveBeenCalledTimes(1)
    doc.visibilityState = 'hidden'
    listeners.forEach((fn) => fn())
    await vi.advanceTimersByTimeAsync(4 * CHECK_EVERY_MS)
    expect(api.checkStopWeather).toHaveBeenCalledTimes(1)
    doc.visibilityState = 'visible'
    listeners.forEach((fn) => fn())
    await settle()
    expect(api.checkStopWeather).toHaveBeenCalledTimes(2)
  })

  it('keeps the last answer and its time when a check fails, and says it could not check again', async () => {
    const page = await open()
    expect(page.textOf(lines(page)[0])).toContain('NEA forecast, 09:30')
    api.checkStopWeather.mockRejectedValue(new Error('Cannot reach the Jio planner right now.'))
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS + 100)
    expect(api.checkStopWeather).toHaveBeenCalledTimes(2)
    expect(marks(page).map((m) => m.split(' . ')[0])).toEqual(['Dry', 'Outdoor, showers'])
    expect(page.textOf(lines(page)[0])).toContain('NEA forecast, 09:30 · could not check again')
    // And the next check, on schedule, works again.
    api.checkStopWeather.mockResolvedValue({ checkedAt: Date.now(), stops: { eat: wx('cloudy', { rainLikely: false }), activity: wx('cloudy', { rainLikely: false }) }, weather: { ...BLOCK, issuedAt: '2026-10-10T10:30:00+08:00' } })
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS)
    expect(marks(page).map((m) => m.split(' . ')[0])).toEqual(['Cloudy', 'Cloudy'])
    expect(page.textOf(lines(page)[0])).toContain('NEA forecast, 10:30')
    expect(page.textOf(lines(page)[0])).not.toContain('could not')
  })

  it('keeps showing what the plan kept when the first check fails, and says it could not check', async () => {
    api.checkStopWeather.mockRejectedValue(new Error('down'))
    const page = await open()
    expect(marks(page).map((m) => m.split(' . ')[0])).toEqual(['Cloudy', 'Outdoor, showers'])
    expect(page.textOf(lines(page)[0])).toContain('NEA forecast, 09:30 · could not check again')
  })

  it('says the weather is not available when the first check fails and the plan kept nothing', async () => {
    api.checkStopWeather.mockRejectedValue(new Error('down'))
    const page = await open({ itinerary: itinerary({ stops: stops([null, null]), weather: null }) })
    expect(marks(page)).toEqual(['Weather is not available right now', 'Weather is not available right now'])
    expect(page.textOf(lines(page)[0])).toContain('Weather is not available right now')
  })

  it('says so when the planner could not fetch the forecast', async () => {
    const down = { state: 'unknown', rainLikely: false, source: 'unavailable', basis: 'none', reason: 'unavailable' }
    api.checkStopWeather.mockResolvedValue({ checkedAt: Date.now(), stops: { eat: down, activity: down }, weather: { source: 'unavailable', basis: 'none', reason: 'unavailable' } })
    const page = await open()
    expect(marks(page)).toEqual(['Weather is not available right now', 'Weather is not available right now'])
    expect(page.textOf(lines(page)[0])).toContain('Weather is not available right now')
  })

  it('shows "Simulated forecast" as a banner at the top and in the line, and every mark is the simulated one', async () => {
    api.checkStopWeather.mockResolvedValue({
      checkedAt: Date.now(),
      stops: { eat: { state: 'showers', rainLikely: true, ...SIM }, activity: { state: 'showers', rainLikely: true, ...SIM } },
      weather: SIM,
    })
    const page = await open()
    const text = page.text()
    expect(text.split('Simulated forecast').length - 1).toBe(2)
    expect(text.indexOf('Simulated forecast')).toBeLessThan(text.indexOf('Lau Pa Sat'))
    expect(page.all().some((el) => el.props['data-testid'] === 'weather-simulated-banner')).toBe(true)
    expect(text).not.toContain('NEA forecast')
    expect(marks(page).map((m) => m.split(' . ')[0])).toEqual(['Indoor', 'Outdoor, showers'])
  })
})

describe('the rain banners', () => {
  beforeEach(() => {
    state.session = session({ isToday: true })
    state.itinerary = itinerary({ stops: stops([wx('dry', { rainLikely: false }), wx('dry', { rainLikely: false })]) })
    // The park, at 15:00, has rain likely; it is 10:00.
    api.checkStopWeather.mockImplementation(async () => ({ checkedAt: Date.now(), stops: { eat: wx('dry', { rainLikely: false }), activity: wx('showers') }, weather: BLOCK }))
  })

  it('is one banner, for the exposed stop still to come, with where and when', async () => {
    const page = await open()
    expect(banners(page)).toHaveLength(1)
    expect(page.textOf(banners(page)[0])).toContain('Rain is likely at East Coast Park around 15:00.')
  })

  it('is not shown when rain is not likely', async () => {
    api.checkStopWeather.mockImplementation(async () => ({ checkedAt: Date.now(), stops: { eat: wx('dry', { rainLikely: false }), activity: wx('cloudy', { rainLikely: false }) }, weather: BLOCK }))
    expect(banners(await open())).toHaveLength(0)
  })

  it('is not shown for an indoor stop with rain over it', async () => {
    state.itinerary = itinerary({ stops: stops([wx('dry'), wx('dry')], [HAWKER, LIBRARY]) })
    api.checkStopWeather.mockImplementation(async () => ({ checkedAt: Date.now(), stops: { eat: wx('showers'), activity: wx('showers') }, weather: BLOCK }))
    expect(banners(await open())).toHaveLength(0)
  })

  it('is not shown for a stop that has begun', async () => {
    vi.setSystemTime(new Date('2026-10-10T15:30:00+08:00'))
    expect(banners(await open())).toHaveLength(0)
  })

  it('asks the host "Swap to <indoor place>?" with Swap and Keep, each named for the stop', async () => {
    const page = await open()
    expect(page.textOf(banners(page)[0])).toContain('Swap to Toa Payoh Public Library?')
    expect(bannerButtons(page)).toEqual(['Swap East Coast Park for Toa Payoh Public Library', 'Keep East Coast Park'])
    expect(api.findRainSwap).toHaveBeenCalledTimes(1)
    expect(api.findRainSwap).toHaveBeenCalledWith('s1', 'activity')
  })

  it('shows a member the banner with no buttons, and asks the planner for no swap', async () => {
    const page = await open({ session: session({ isToday: true, hostId: 'faith' }) })
    expect(banners(page)).toHaveLength(1)
    expect(page.textOf(banners(page)[0])).toContain('Rain is likely at East Coast Park around 15:00.')
    expect(page.textOf(banners(page)[0])).toContain('The host can swap it')
    expect(bannerButtons(page)).toEqual([])
    expect(api.findRainSwap).not.toHaveBeenCalled()
  })

  it('swaps nothing until the host presses Swap', async () => {
    await open()
    await vi.advanceTimersByTimeAsync(2 * CHECK_EVERY_MS)
    expect(api.swapOption).not.toHaveBeenCalled()
    expect(api.dismissRainWarning).not.toHaveBeenCalled()
  })

  it('swaps through the data layer, once, however many times Swap is pressed', async () => {
    let finish
    api.swapOption.mockImplementation(() => new Promise((resolve) => (finish = () => resolve(state.session))))
    const page = await open()
    const swap = page.all('button').find((b) => (b.props['aria-label'] || '').startsWith('Swap '))
    // Three presses in a row; none is waited for, as the swap is still being made.
    swap.listeners.click({ pointerType: 'mouse', detail: 1 })
    swap.listeners.click({ pointerType: 'mouse', detail: 1 })
    swap.listeners.click({ pointerType: 'mouse', detail: 1 })
    await vi.advanceTimersByTimeAsync(10)
    expect(api.swapOption).toHaveBeenCalledTimes(1)
    expect(api.swapOption).toHaveBeenCalledWith('s1', 'activity', 'park', 'toa-payoh-library')
    // The buttons are off while it is made.
    const mine = banners(page).flatMap(under).filter((n) => n.tag === 'button')
    expect(mine).toHaveLength(2)
    expect(mine.every((b) => b.props.disabled)).toBe(true)
    // It lands: the plan has the indoor place, and the warning is gone.
    state.itinerary = itinerary({ stops: stops([wx('dry', { rainLikely: false }), wx('showers')], [HAWKER, LIBRARY]) })
    finish()
    await vi.advanceTimersByTimeAsync(100)
    expect(api.swapOption).toHaveBeenCalledTimes(1)
    expect(banners(page)).toHaveLength(0)
    expect(marks(page).map((m) => m.split(' . ')[0])).toEqual(['Dry', 'Indoor'])
  })

  it('says why when the swap could not be made, and leaves the warning', async () => {
    api.swapOption.mockRejectedValue(new Error('Toa Payoh Public Library does not fit this stop.'))
    const page = await open()
    await press(page, 'Swap East Coast Park')
    expect(page.text()).toContain('does not fit this stop')
    expect(banners(page)).toHaveLength(1)
    // And it can be tried again, since nothing is stuck.
    expect(banners(page).flatMap(under).filter((n) => n.tag === 'button').every((b) => !b.props.disabled)).toBe(true)
  })

  it('lets the host keep the stop: dismissed with the forecast\'s state, through the data layer', async () => {
    const page = await open()
    await press(page, 'Keep East Coast Park')
    expect(api.dismissRainWarning).toHaveBeenCalledTimes(1)
    expect(api.dismissRainWarning).toHaveBeenCalledWith('s1', 'activity', 'showers')
    expect(api.swapOption).not.toHaveBeenCalled()
  })

  it('stays dismissed for the stop until the forecast changes state, for everyone', async () => {
    state.session = session({ isToday: true, weatherDismissed: { activity: 'showers' } })
    const host = await open()
    expect(banners(host)).toHaveLength(0)
    const member = await open({ session: session({ isToday: true, hostId: 'faith', weatherDismissed: { activity: 'showers' } }) })
    expect(banners(member)).toHaveLength(0)
    // The forecast gets worse: it is a new warning.
    api.checkStopWeather.mockImplementation(async () => ({ checkedAt: Date.now(), stops: { eat: wx('dry', { rainLikely: false }), activity: wx('thundery') }, weather: BLOCK }))
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS + 100)
    expect(banners(host)).toHaveLength(1)
    expect(banners(member)).toHaveLength(1)
    // The same state again after it cleared in between is still the kept one.
    expect(api.swapOption).not.toHaveBeenCalled()
  })

  it('asks the planner for the indoor place again only when the stop or the state changes', async () => {
    await open()
    await vi.advanceTimersByTimeAsync(3 * CHECK_EVERY_MS)
    expect(api.findRainSwap).toHaveBeenCalledTimes(1)
    api.checkStopWeather.mockImplementation(async () => ({ checkedAt: Date.now(), stops: { eat: wx('dry', { rainLikely: false }), activity: wx('thundery') }, weather: BLOCK }))
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS)
    expect(api.findRainSwap).toHaveBeenCalledTimes(2)
  })

  it('says when the planner has no indoor place to offer, and still lets the host keep the stop', async () => {
    api.findRainSwap.mockResolvedValue(null)
    const page = await open()
    expect(page.textOf(banners(page)[0])).toContain('Jio found no indoor place to swap in.')
    expect(bannerButtons(page)).toEqual(['Keep East Coast Park'])
  })

  it('says when it could not look for an indoor place, and offers to try again', async () => {
    api.findRainSwap.mockRejectedValueOnce(new Error('down'))
    const page = await open()
    expect(page.textOf(banners(page)[0])).toContain('Could not look for an indoor place.')
    api.findRainSwap.mockResolvedValue({ id: LIBRARY.id, name: LIBRARY.name })
    await press(page, 'Try again')
    expect(page.textOf(banners(page)[0])).toContain('Swap to Toa Payoh Public Library?')
  })

  it('is announced by the banner itself, which is a status region', async () => {
    const page = await open()
    expect(page.attr(page.all('div').find((d) => d.props['data-testid'] === 'rain-banner'), 'role')).toBe('status')
  })
})

describe('"Simulate rain"', () => {
  it('turns the check, the marks, the banner and the label on, with no real rain', async () => {
    state.session = session({ isToday: true })
    state.itinerary = itinerary({ stops: stops([wx('dry', { rainLikely: false }), wx('dry', { rainLikely: false })]) })
    api.checkStopWeather.mockImplementation(async () =>
      conditions.rain
        ? { checkedAt: Date.now(), stops: { eat: { state: 'showers', rainLikely: true, ...SIM }, activity: { state: 'showers', rainLikely: true, ...SIM } }, weather: SIM }
        : { checkedAt: Date.now(), stops: { eat: wx('dry', { rainLikely: false }), activity: wx('dry', { rainLikely: false }) }, weather: BLOCK },
    )
    const page = await open()
    const planner = usePlannerStore()
    expect(banners(page)).toHaveLength(0)
    expect(page.text()).not.toContain('Simulated forecast')
    expect(api.checkStopWeather).toHaveBeenCalledTimes(1)
    // The demo panel's switch.
    conditions.rain = true
    await planner.loadConditions()
    await vi.advanceTimersByTimeAsync(100)
    expect(api.checkStopWeather).toHaveBeenCalledTimes(2)
    expect(banners(page)).toHaveLength(1)
    expect(page.text()).toContain('Simulated forecast')
    expect(marks(page).map((m) => m.split(' . ')[0])).toEqual(['Indoor', 'Outdoor, showers'])
    // And off again.
    conditions.rain = false
    await planner.loadConditions()
    await vi.advanceTimersByTimeAsync(100)
    expect(banners(page)).toHaveLength(0)
    expect(page.text()).not.toContain('Simulated forecast')
  })
})

describe('the rain on the itinerary\'s map', () => {
  // The plan's activity stop is outdoor with showers; the forecast is current from 09:30 to 11:30 and it is 10:00.
  it('draws a patch where rain is likely, with the chip for the live two-hour forecast', async () => {
    await open()
    expect(mapSeen.rain).toEqual([{ lat: PARK.lat, lng: PARK.lng }])
    expect(mapSeen.rainLabel).toBe('Rain likely · next 2 h')
  })

  it('draws none for a plan that is not confirmed, or for dry weather', async () => {
    await open({ session: session({ status: 'inviting' }) })
    expect(mapSeen.rain).toEqual([])
    await open({ itinerary: itinerary({ stops: stops([wx('dry', { rainLikely: false }), wx('cloudy')]) }) })
    expect(mapSeen.rain).toEqual([])
  })

  it('stops drawing the rain when the forecast it came from has run out, and not before', async () => {
    api.checkStopWeather.mockImplementation(async () => ({ checkedAt: Date.now(), stops: { eat: wx('dry', { rainLikely: false }), activity: wx('showers') }, weather: BLOCK }))
    await open({ session: session({ isToday: true }) })
    expect(mapSeen.rain).toHaveLength(1)
    // The forecast ends at 11:30; the clock moves on, but a check each half hour returns the same old answer.
    await vi.advanceTimersByTimeAsync(89 * MIN)
    expect(mapSeen.rain).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(mapSeen.rain).toEqual([])
    expect(mapSeen.rainLabel).toBe('')
  })

  it('says "Simulated rain" for the demo\'s forecast, which does not run out', async () => {
    conditions.rain = true
    api.checkStopWeather.mockImplementation(async () => ({ checkedAt: Date.now(), stops: { eat: wx('showers', SIM), activity: wx('showers', SIM) }, weather: SIM }))
    await open({ session: session({ isToday: true }), itinerary: itinerary({ weather: SIM, stops: stops([wx('showers', SIM), wx('showers', SIM)]) }) })
    expect(mapSeen.rainLabel).toBe('Simulated rain')
    await vi.advanceTimersByTimeAsync(5 * 60 * MIN)
    expect(mapSeen.rain.length).toBeGreaterThan(0)
  })

  it('draws nothing from a plan\'s kept forecast that was stored hours ago', async () => {
    vi.setSystemTime(new Date('2026-10-10T14:00:00+08:00'))
    await open()
    expect(mapSeen.rain).toEqual([])
    expect(mapSeen.rainLabel).toBe('')
  })
})

describe('the rain on the full-screen map', () => {
  const openMap = async (over = {}) => {
    Object.assign(state, over)
    const page = mount(SessionMapView, { id: 's1' }, [pinia])
    pages.push(page)
    await vi.advanceTimersByTimeAsync(50)
    return page
  }
  const source = (page) => page.all().filter((el) => el.props['data-testid'] === 'weather-source')

  it('draws the rain with the chip, and the source line with its licence notice, as the itinerary does', async () => {
    const page = await openMap()
    expect(mapSeen.rain).toEqual([{ lat: PARK.lat, lng: PARK.lng }])
    expect(mapSeen.rainLabel).toBe('Rain likely · next 2 h')
    expect(source(page)).toHaveLength(1)
    expect(page.text()).toContain('NEA forecast, 09:30')
    expect(page.text()).toContain('About this forecast')
  })

  it('says it is simulated in the source line when the rain is the demo\'s', async () => {
    const page = await openMap({ itinerary: itinerary({ weather: SIM, stops: stops([wx('showers', SIM), wx('showers', SIM)]) }) })
    expect(mapSeen.rainLabel).toBe('Simulated rain')
    expect(page.text()).toContain('Simulated forecast')
  })

  it('shows neither rain nor the source line once the plan\'s kept forecast has run out', async () => {
    vi.setSystemTime(new Date('2026-10-10T14:00:00+08:00'))
    const page = await openMap()
    expect(mapSeen.rain).toEqual([])
    expect(source(page)).toHaveLength(0)
  })

  it('asks for the check on the day once when it opens alone on the day of a confirmed plan, and not otherwise', async () => {
    await openMap({ session: session({ isToday: true }) })
    expect(api.checkStopWeather).toHaveBeenCalledTimes(1)
    api.checkStopWeather.mockClear()
    await openMap()
    expect(api.checkStopWeather).not.toHaveBeenCalled()
  })
})
