// The Roam page ("What next?") and the proposed stops under the itinerary, rendered with a tiny stand-in for the page
// (miniDom.js), a real events store whose actions are watched, and the data layer's planner calls stood in for. They check
// what a person sees and what each press asks for: the centre line, the cards, the states, "Use my location" in each of
// its outcomes, and that the position goes to the planner and nowhere else.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { fakeStorage } from './planFixture.js'
import { mount } from './miniDom.js'

vi.mock('../plannerApi.js', () => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), roamNearby: vi.fn() }))
vi.mock('../api.js', async (original) => ({ ...(await original()), roamNearby: vi.fn(), placeFromCoords: vi.fn(), listAreas: vi.fn() }))
vi.mock('../../components/group/LocationSheet.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      props: ['open', 'which', 'title'],
      emits: ['select', 'update:open'],
      setup: (p, { emit }) => () => (p.open ? h('button', { onClick: () => emit('select', { areaId: 'kovan', label: 'Somewhere exact' }) }, `Picker: ${p.title}`) : null),
    }),
  }
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
const { default: ProposedStops } = await import('../../components/event/ProposedStops.vue')
const { useEventsStore } = await import('../../stores/events.js')
const { useAuthStore } = await import('../../stores/auth.js')

const venue = (id, name, extra = {}) => ({ id, name, category: 'eat', area: 'Bishan', price: 12, lat: 1.35, lng: 103.85, ...extra })
const place = (id, name, extra = {}) => ({
  id, venue: venue(id, name), rank: 1, score: 5, walk: 2, reasons: ['Near MRT', 'Short walk'], warnings: [], swap: null, travelMinutes: 4.4, distanceKm: 0.3, distanceM: 300,
  approximate: false, state: 'free', proposal: null, ...extra,
})
const session = (over = {}) => ({
  id: 's1', title: 'Saturday', status: 'confirmed', hostId: 'ian', hostName: 'Ian', isToday: true, areaName: 'Bishan', activeIds: ['ian', 'faith', 'jonathan'],
  plan: { stops: [{ slotId: 'eat', venueId: 'v9' }] }, proposals: [], ...over,
})
const answer = (...places) => ({ centre: { areaId: 'bishan', areaName: 'Bishan' }, places, empty: null, widened: false, blocked: '' })

let pinia
let events
beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  events = useEventsStore()
  // The signed-in person is the sample person Ian, as for the demo account.
  useAuthStore().user = { id: 'ian', name: 'Ian', username: 'ian', local: true }
  events.byId = { s1: session() }
  vi.spyOn(events, 'loadSession').mockResolvedValue(session())
  for (const name of ['proposeMyStop', 'resolveProposal']) vi.spyOn(events, name).mockResolvedValue({})
  api.roamNearby.mockReset().mockResolvedValue(answer(place('v1', 'Green Kitchen'), place('v2', 'Corner Bowling', { venue: venue('v2', 'Corner Bowling', { category: 'activity' }) })))
  api.placeFromCoords.mockReset().mockResolvedValue({ id: 'here-toa-payoh', label: 'Current location', sub: 'Toa Payoh', areaId: 'toa-payoh' })
  api.listAreas.mockReset().mockResolvedValue([{ id: 'kovan', name: 'Kovan', lat: 1.3602, lng: 103.8851 }])
})
afterEach(() => vi.unstubAllGlobals())

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
const open = async (over = {}) => {
  if (over.session) events.byId = { s1: over.session }
  const page = mount(RoamView, { id: 's1' }, [pinia])
  await flush()
  return page
}
const byTestId = (page, id) => page.all().filter((el) => el.props['data-testid'] === id)
const geolocation = (impl) => vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: vi.fn(impl) } })

describe('the Roam page', () => {
  it('has the heading, says where it is centred, and lists the places with distance, reasons and a Propose button', async () => {
    const page = await open()
    expect(page.text()).toContain('What next?')
    expect(page.textOf(byTestId(page, 'roam-centre')[0])).toBe('Near Bishan')
    const cards = page.all('article')
    expect(cards).toHaveLength(2)
    expect(page.textOf(cards[0])).toContain('Green Kitchen')
    expect(page.textOf(cards[0])).toContain('about 4 min away · 300 m')
    expect(page.textOf(cards[0])).toContain('Near MRT')
    // The card no longer repeats the line above it: "Short walk" went from the place card on 11 October 2026.
    expect(page.textOf(cards[0])).not.toContain('Short walk')
    expect(page.all('button', 'Propose')).toHaveLength(2)
    // The request was for the meeting area: no point.
    expect(api.roamNearby).toHaveBeenCalledWith('s1', { point: undefined, categories: ['eat', 'drink', 'shop', 'activity'] })
  })

  it('does not ask the browser where the person is until the button is pressed', async () => {
    const getCurrentPosition = vi.fn()
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } })
    await open()
    expect(getCurrentPosition).not.toHaveBeenCalled()
  })

  it('marks a place where rain is expected', async () => {
    api.roamNearby.mockResolvedValue(answer(place('v1', 'Green Kitchen', { warnings: ['rain'] })))
    const page = await open()
    expect(page.text()).toContain('Outdoor, rain expected')
  })

  it('shows a skeleton while the list loads, and says so to a screen reader', async () => {
    api.roamNearby.mockReturnValue(new Promise(() => {}))
    const page = await open()
    expect(byTestId(page, 'roam-loading')).toHaveLength(1)
    expect(page.all('article')).toHaveLength(0)
    expect(page.text()).toContain('Finding places near Bishan')
  })

  it('says nothing nearby fits, and how to go on', async () => {
    api.roamNearby.mockResolvedValue(answer())
    const page = await open()
    expect(page.text()).toContain('Nothing nearby fits')
    expect(page.text()).toContain('Try another kind of place.')
  })

  it('says the planner could not be reached, and tries again on Retry', async () => {
    api.roamNearby.mockRejectedValueOnce(new Error('Cannot reach the Jio planner right now. Check your connection and try again.'))
    const page = await open()
    expect(page.text()).toContain('Could not load places')
    expect(page.text()).toContain('Cannot reach the Jio planner right now.')
    expect(page.all('article')).toHaveLength(0)
    await page.button('Retry').click()
    await flush()
    expect(page.all('article')).toHaveLength(2)
    expect(page.text()).not.toContain('Could not load places')
  })

  it('asks for one kind of place when a chip is pressed, and for all of them on All', async () => {
    const page = await open()
    await page.button('Eat').click()
    await flush()
    expect(api.roamNearby).toHaveBeenLastCalledWith('s1', { point: undefined, categories: ['eat'] })
    expect(page.attr(page.button('Eat'), 'aria-checked')).toBe('true')
    await page.button('All').click()
    await flush()
    expect(api.roamNearby).toHaveBeenLastCalledWith('s1', { point: undefined, categories: ['eat', 'drink', 'shop', 'activity'] })
  })
})

describe('proposing from the page', () => {
  it('proposes the place when Propose is pressed, as the signed-in person', async () => {
    const page = await open()
    await page.button('Propose').click()
    expect(events.proposeMyStop).toHaveBeenCalledWith('s1', 'v1')
  })

  it('shows "Proposed by you" with Take back for your own proposal, and takes it back', async () => {
    events.byId = { s1: session({ proposals: [{ id: 'pp1', venueId: 'v1', by: 'ian', byName: 'Ian', venue: venue('v1', 'Green Kitchen') }] }) }
    const page = await open({ session: events.byId.s1 })
    const first = page.all('article')[0]
    expect(page.textOf(first)).toContain('Proposed by you')
    await page.button('Take back').click()
    expect(events.resolveProposal).toHaveBeenCalledWith('s1', 'pp1', false)
  })

  it('shows who proposed a place for someone else\'s, with nothing to press, and says a place in the plan is in it', async () => {
    events.byId = { s1: session({ proposals: [{ id: 'pp1', venueId: 'v1', by: 'faith', byName: 'Faith', venue: venue('v1', 'Green Kitchen') }], plan: { stops: [{ venueId: 'v2' }] } }) }
    const page = await open({ session: events.byId.s1 })
    const [first, second] = page.all('article')
    expect(page.textOf(first)).toContain('Proposed by Faith')
    expect(page.all('button', 'Take back')).toHaveLength(0)
    expect(page.textOf(second)).toContain('In the plan')
    expect(page.all('button', 'Propose')).toHaveLength(0)
  })

  it('turns Propose off and says why when the person has 3 waiting', async () => {
    const mine = ['v7', 'v8', 'v9'].map((v, i) => ({ id: `pp${i}`, venueId: v, by: 'ian', byName: 'Ian', venue: venue(v, v) }))
    const page = await open({ session: session({ proposals: mine }) })
    expect(page.textOf(byTestId(page, 'roam-blocked')[0])).toBe('You have 3 places waiting. Take one back to propose another.')
    for (const button of page.all('button', 'Propose')) expect(button.props.disabled).toBe(true)
  })

  it('shows what went wrong in an alert and leaves the card as it was', async () => {
    events.proposeMyStop.mockRejectedValue(new Error('The plan has 8 stops, the most it can hold.'))
    const page = await open()
    await page.button('Propose').click()
    expect(page.textOf(byTestId(page, 'roam-error')[0])).toBe('The plan has 8 stops, the most it can hold.')
    expect(page.all('button', 'Propose')).toHaveLength(2)
  })
})

describe('"Use my location"', () => {
  it('centres the list on the person, names only the area, and sends the position to the planner for that request', async () => {
    geolocation((ok) => ok({ coords: { latitude: 1.33217, longitude: 103.84779 } }))
    const page = await open()
    await page.button('Use my location').click()
    await flush()
    expect(api.placeFromCoords).toHaveBeenCalledWith(1.33217, 103.84779)
    expect(api.roamNearby).toHaveBeenLastCalledWith('s1', { point: { lat: 1.33217, lng: 103.84779 }, categories: ['eat', 'drink', 'shop', 'activity'] })
    expect(page.textOf(byTestId(page, 'roam-centre')[0])).toBe('Near you, in Toa Payoh')
    expect(page.text()).not.toContain('1.33217')
    expect(page.text()).not.toContain('103.84779')
    expect(page.text()).toContain('never where you are')
    // A way back to the meeting area, which asks for it again with no point.
    await page.button('Back to Bishan').click()
    await flush()
    expect(api.roamNearby).toHaveBeenLastCalledWith('s1', { point: undefined, categories: ['eat', 'drink', 'shop', 'activity'] })
    expect(page.textOf(byTestId(page, 'roam-centre')[0])).toBe('Near Bishan')
  })

  it('offers the areas when the browser refuses, and centres on the area that is picked', async () => {
    geolocation((ok, refuse) => refuse({ code: 1 }))
    const page = await open()
    const asked = api.roamNearby.mock.calls.length
    await page.button('Use my location').click()
    expect(page.textOf(byTestId(page, 'roam-note')[0])).toBe('Location access is off. Pick an area instead.')
    expect(api.roamNearby).toHaveBeenCalledTimes(asked)
    await page.button('Picker: Pick an area').click()
    await flush()
    expect(api.roamNearby).toHaveBeenLastCalledWith('s1', { point: { lat: 1.3602, lng: 103.8851 }, categories: ['eat', 'drink', 'shop', 'activity'] })
    expect(page.textOf(byTestId(page, 'roam-centre')[0])).toBe('Near Kovan')
    expect(page.text()).not.toContain('never where you are')
  })

  it('offers the areas when no position is available', async () => {
    geolocation((ok, refuse) => refuse({ code: 2 }))
    const page = await open()
    await page.button('Use my location').click()
    expect(page.textOf(byTestId(page, 'roam-note')[0])).toBe('Your location is not available right now. Pick an area instead.')
    expect(page.button('Picker: Pick an area')).not.toBeNull()
  })

  it('offers the areas when the browser cannot share a position at all', async () => {
    vi.stubGlobal('navigator', {})
    const page = await open()
    await page.button('Use my location').click()
    expect(page.textOf(byTestId(page, 'roam-note')[0])).toBe('This browser cannot share your location. Pick an area instead.')
    expect(page.button('Picker: Pick an area')).not.toBeNull()
  })

  it('offers the areas when the person is outside Singapore, and keeps the list on the meeting area', async () => {
    geolocation((ok) => ok({ coords: { latitude: 51.5, longitude: -0.12 } }))
    api.placeFromCoords.mockResolvedValue(null)
    const page = await open()
    const asked = api.roamNearby.mock.calls.length
    await page.button('Use my location').click()
    await flush()
    expect(page.textOf(byTestId(page, 'roam-note')[0])).toBe('Your location is outside Singapore. Pick an area instead.')
    expect(page.button('Picker: Pick an area')).not.toBeNull()
    expect(api.roamNearby).toHaveBeenCalledTimes(asked)
    expect(page.textOf(byTestId(page, 'roam-centre')[0])).toBe('Near Bishan')
  })
})

describe('the proposed stops on the itinerary', () => {
  const proposals = [
    { id: 'pp1', venueId: 'v1', by: 'faith', byName: 'Faith', venue: venue('v1', 'Green Kitchen') },
    { id: 'pp2', venueId: 'v2', by: 'ian', byName: 'Ian', venue: venue('v2', 'Corner Bowling', { category: 'activity' }) },
  ]
  const rows = (s, myId) => mount(ProposedStops, { session: session({ proposals, ...s }), myId }, [pinia])

  it('shows the host each proposal with who proposed it, "Add to plan" and "Not now"', () => {
    const page = rows({}, 'ian')
    expect(page.text()).toContain('Proposed stops')
    expect(page.text()).toContain('Proposed by Faith')
    expect(page.text()).toContain('Proposed by you')
    expect(page.all('button', 'Add to plan')).toHaveLength(2)
    expect(page.all('button', 'Not now')).toHaveLength(2)
    expect(page.attr(page.all('button', 'Add to plan')[0], 'aria-label')).toBe('Add Green Kitchen to the plan')
  })

  it('adds the place to the plan, or leaves it out, through the store', async () => {
    const page = rows({}, 'ian')
    await page.button('Add to plan').click()
    expect(events.resolveProposal).toHaveBeenCalledWith('s1', 'pp1', true)
    await page.button('Not now').click()
    expect(events.resolveProposal).toHaveBeenLastCalledWith('s1', 'pp1', false)
  })

  it('shows a guest who proposed it and that the host decides, with no way to add', () => {
    const page = rows({ hostId: 'faith', hostName: 'Faith' }, 'jonathan')
    expect(page.text()).toContain('Proposed by Faith')
    expect(page.text()).toContain('Faith decides what goes into the plan.')
    expect(page.text()).toContain('Waiting for Faith to decide')
    expect(page.all('button')).toHaveLength(0)
  })

  it('lets a guest take back their own, and only theirs', async () => {
    const page = rows({ hostId: 'faith', hostName: 'Faith' }, 'ian')
    expect(page.all('button', 'Take back')).toHaveLength(1)
    await page.button('Take back').click()
    expect(events.resolveProposal).toHaveBeenCalledWith('s1', 'pp2', false)
  })

  it('shows nothing when there are no proposals, and the error when a change is refused', async () => {
    expect(rows({ proposals: [] }, 'ian').text()).not.toContain('Proposed stops')
    events.resolveProposal.mockRejectedValue(new Error('The plan has 8 stops, the most it can hold.'))
    const page = rows({}, 'ian')
    await page.button('Add to plan').click()
    expect(page.text()).toContain('The plan has 8 stops, the most it can hold.')
  })
})
