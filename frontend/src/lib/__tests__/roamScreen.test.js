// The Roam page ("What next?") and the proposed stops under the itinerary, rendered with a tiny stand-in for the page
// (miniDom.js), a real events store whose actions are watched, and the data layer's planner calls stood in for. They check
// what a person sees and what each press asks for: the centre line, the cards, the states, "Use my location" in each of
// its outcomes, and that the position goes to the planner and nowhere else.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { fakeStorage } from './planFixture.js'
import { mount } from './miniDom.js'

vi.mock('../plannerApi.js', () => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), roamNearby: vi.fn() }))
vi.mock('../api.js', async (original) => ({ ...(await original()), roamNearby: vi.fn(), placeFromCoords: vi.fn(), listAreas: vi.fn(), getPlace: vi.fn() }))
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
// The place detail is stood in for: it shows what it was given, and Close sends `close` as the real one does. Its own behaviour is
// tested with the component; here only what Roam gives it and does when it closes.
vi.mock('../../components/event/PlaceDetail.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      props: ['place', 'reviews', 'from', 'outing', 'error'],
      emits: ['close'],
      setup: (p, { emit }) => () =>
        h('div', { 'data-testid': 'place-detail', 'data-from': p.from, 'data-outing': (p.outing || []).join(','), 'data-address': p.place.address || '' }, [
          h('h2', p.place.name),
          h('button', { onClick: () => emit('close') }, 'Close'),
        ]),
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
  id: 's1', title: 'Saturday', status: 'confirmed', start: '12:00', end: '21:30', hostId: 'ian', hostName: 'Ian', isToday: true, areaName: 'Bishan', area: { id: 'bishan', name: 'Bishan' }, activeIds: ['ian', 'faith', 'jonathan'],
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
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00+08:00'))
  events.byId = { s1: session() }
  vi.spyOn(events, 'loadSession').mockResolvedValue(session())
  for (const name of ['proposeMyStop', 'resolveProposal']) vi.spyOn(events, name).mockResolvedValue({})
  api.roamNearby.mockReset().mockResolvedValue(answer(place('v1', 'Green Kitchen'), place('v2', 'Corner Bowling', { venue: venue('v2', 'Corner Bowling', { category: 'activity' }) })))
  api.placeFromCoords.mockReset().mockResolvedValue({ id: 'here-toa-payoh', label: 'Current location', sub: 'Toa Payoh', areaId: 'toa-payoh' })
  api.getPlace.mockReset().mockResolvedValue({ address: '1 Bishan Street' })
  api.listAreas.mockReset().mockResolvedValue([{ id: 'kovan', name: 'Kovan', lat: 1.3602, lng: 103.8851 }])
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

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
    expect(api.roamNearby).toHaveBeenCalledWith('s1', { point: undefined, categories: ['eat', 'drink', 'shop', 'activity'], unconfirmed: false })
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
    expect(api.roamNearby).toHaveBeenLastCalledWith('s1', { point: undefined, categories: ['eat'], unconfirmed: false })
    expect(page.attr(page.button('Eat'), 'aria-checked')).toBe('true')
    await page.button('All').click()
    await flush()
    expect(api.roamNearby).toHaveBeenLastCalledWith('s1', { point: undefined, categories: ['eat', 'drink', 'shop', 'activity'], unconfirmed: false })
  })
})

// The control a card gives focus back to: found by the attribute the card puts on it, through the page's `document`.
describe('opening a place from a card', () => {
  let focused
  beforeEach(() => {
    focused = []
    vi.stubGlobal('CSS', { escape: (text) => String(text) })
    vi.stubGlobal('document', {
      querySelector: (selector) => ({ focus: (options) => focused.push({ selector, options }) }),
    })
  })
  const nameButton = (page, id) => page.all('button').find((b) => b.props['data-open-for'] === id)
  const reviewButton = (page, id) => page.all('button').find((b) => b.props['data-review-for'] === id)
  const detailOf = (page) => byTestId(page, 'place-detail')[0]

  it('opens the place from the name and photo button, and from the review line, with no planner request', async () => {
    const plannerApi = await import('../plannerApi.js')
    const page = await open()
    const before = api.roamNearby.mock.calls.length
    expect(detailOf(page)).toBeUndefined()
    await nameButton(page, 'v1').listeners.click({ pointerType: 'mouse', detail: 1 })
    await flush()
    expect(page.textOf(detailOf(page))).toContain('Green Kitchen')
    await page.button('Close').click()
    await reviewButton(page, 'v2').listeners.click({ pointerType: 'mouse', detail: 1 })
    await flush()
    expect(page.textOf(detailOf(page))).toContain('Corner Bowling')
    // Nothing was asked of the planner: not another list, not a ranking, not a search.
    expect(api.roamNearby).toHaveBeenCalledTimes(before)
    expect(plannerApi.meetingArea).not.toHaveBeenCalled()
    expect(plannerApi.rankSlot).not.toHaveBeenCalled()
    expect(plannerApi.searchSlot).not.toHaveBeenCalled()
    expect(plannerApi.roamNearby).not.toHaveBeenCalled()
  })

  it('gives the detail the other people in the meetup, for its "In this outing" order, and the area its distance is from', async () => {
    const page = await open()
    await nameButton(page, 'v1').listeners.click({ pointerType: 'mouse', detail: 1 })
    await flush()
    expect(detailOf(page).props['data-outing']).toBe('faith,jonathan')
    expect(detailOf(page).props['data-from']).toBe('Bishan')
    // The address comes from the place list, for the same place, after it has opened.
    expect(api.getPlace).toHaveBeenCalledWith('v1', 'bishan')
    expect(detailOf(page).props['data-address']).toBe('1 Bishan Street')
  })

  it('measures from "you" when the list is centred on the person, never from where they are', async () => {
    geolocation((ok) => ok({ coords: { latitude: 1.33217, longitude: 103.84779 } }))
    const page = await open()
    await page.button('Use my location').click()
    await flush()
    await nameButton(page, 'v1').listeners.click({ pointerType: 'mouse', detail: 1 })
    await flush()
    expect(detailOf(page).props['data-from']).toBe('you')
    expect(page.text()).not.toContain('1.33217')
  })

  it('opens without the address when the place list does not know the place', async () => {
    api.getPlace.mockRejectedValue(new Error('This place does not exist.'))
    const page = await open()
    await nameButton(page, 'v1').listeners.click({ pointerType: 'mouse', detail: 1 })
    await flush()
    expect(page.textOf(detailOf(page))).toContain('Green Kitchen')
    expect(detailOf(page).props['data-address']).toBe('')
  })

  it('puts focus back on the name when it opened from the name, and on the review line when it opened from there', async () => {
    const page = await open()
    await nameButton(page, 'v1').listeners.click({ pointerType: 'mouse', detail: 1 })
    await flush()
    await page.button('Close').click()
    await flush()
    expect(detailOf(page)).toBeUndefined()
    expect(focused).toEqual([{ selector: '[data-open-for="v1"]', options: { preventScroll: true } }])
    await reviewButton(page, 'v2').listeners.click({ pointerType: 'mouse', detail: 1 })
    await flush()
    await page.button('Close').click()
    await flush()
    expect(focused.at(-1)).toEqual({ selector: '[data-review-for="v2"]', options: { preventScroll: true } })
  })

  it('does not change what Propose does', async () => {
    const page = await open()
    await nameButton(page, 'v1').listeners.click({ pointerType: 'mouse', detail: 1 })
    await flush()
    await page.button('Close').click()
    await page.button('Propose').click()
    expect(events.proposeMyStop).toHaveBeenCalledWith('s1', 'v1')
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
    expect(api.roamNearby).toHaveBeenLastCalledWith('s1', { point: { lat: 1.33217, lng: 103.84779 }, categories: ['eat', 'drink', 'shop', 'activity'], unconfirmed: false })
    expect(page.textOf(byTestId(page, 'roam-centre')[0])).toBe('Near you, in Toa Payoh')
    expect(page.text()).not.toContain('1.33217')
    expect(page.text()).not.toContain('103.84779')
    expect(page.text()).toContain('never where you are')
    // A way back to the meeting area, which asks for it again with no point.
    await page.button('Back to Bishan').click()
    await flush()
    expect(api.roamNearby).toHaveBeenLastCalledWith('s1', { point: undefined, categories: ['eat', 'drink', 'shop', 'activity'], unconfirmed: false })
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
    expect(api.roamNearby).toHaveBeenLastCalledWith('s1', { point: { lat: 1.3602, lng: 103.8851 }, categories: ['eat', 'drink', 'shop', 'activity'], unconfirmed: false })
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
    // The visible words are the start of the accessible name, so speech control can say what it sees.
    expect(page.attr(page.all('button', 'Add to plan')[0], 'aria-label')).toBe('Add to plan: Green Kitchen')
    expect(page.attr(page.all('button', 'Not now')[0], 'aria-label')).toBe('Not now: Green Kitchen')
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


// A promise the test settles by hand.
const later = () => {
  let resolve
  let reject
  const promise = new Promise((ok, no) => { resolve = ok; reject = no })
  return { promise, resolve, reject }
}
const statusOf = (page) => page.all('p').filter((p) => p.props.role === 'status').map((p) => page.textOf(p)).join('|')

describe('the Roam page says what a press did', () => {
  it('says "<place> proposed. <host> decides." after Propose, and "You took back <place>." after Take back', async () => {
    const page = await open()
    await page.button('Propose').click()
    expect(page.textOf(byTestId(page, 'roam-said')[0])).toBe('Green Kitchen proposed. Ian decides.')
    events.byId = { s1: session({ proposals: [{ id: 'pp1', venueId: 'v1', by: 'ian', byName: 'Ian', venue: venue('v1', 'Green Kitchen') }] }) }
    await flush()
    await page.button('Take back').click()
    expect(page.textOf(byTestId(page, 'roam-said')[0])).toBe('You took back Green Kitchen.')
  })

  it('says what really happened when nothing changed: the place was proposed already, or the proposal is gone', async () => {
    const page = await open()
    events.proposeMyStop.mockResolvedValue(false)
    await page.button('Propose').click()
    expect(page.textOf(byTestId(page, 'roam-said')[0])).toBe('Green Kitchen is already proposed.')
    events.byId = { s1: session({ proposals: [{ id: 'pp1', venueId: 'v1', by: 'ian', byName: 'Ian', venue: venue('v1', 'Green Kitchen') }] }) }
    await flush()
    events.resolveProposal.mockResolvedValue(false)
    await page.button('Take back').click()
    expect(page.textOf(byTestId(page, 'roam-said')[0])).toBe('That proposal is no longer there.')
  })

  it('says nothing was proposed when the change is refused', async () => {
    events.proposeMyStop.mockRejectedValue(new Error('The plan has 8 stops, the most it can hold.'))
    const page = await open()
    await page.button('Propose').click()
    expect(page.textOf(byTestId(page, 'roam-said')[0])).toBe('')
  })

  it('ignores a second press while the first is saving', async () => {
    const saving = later()
    events.proposeMyStop.mockReturnValue(saving.promise)
    const page = await open()
    const first = page.button('Propose').click()
    await flush()
    await page.button('Propose').click()
    await page.button('Propose').click()
    expect(events.proposeMyStop).toHaveBeenCalledTimes(1)
    saving.resolve(true)
    await first
    await flush()
    await page.button('Propose').click()
    expect(events.proposeMyStop).toHaveBeenCalledTimes(2)
  })
})

describe('who can press Propose', () => {
  it('turns it off, with the reason in words on the page, for someone who opted out of the meetup', async () => {
    const left = session({ activeIds: ['faith', 'jonathan'], members: [{ id: 'ian', state: 'opted_out' }, { id: 'faith', state: 'joined' }] })
    const page = await open({ session: left })
    expect(page.textOf(byTestId(page, 'roam-blocked')[0])).toBe('You opted out of this meetup, so you cannot propose places.')
    for (const button of page.all('button', 'Propose')) {
      expect(button.props.disabled).toBe(true)
      expect(page.attr(button, 'aria-describedby')).toBe('roam-blocked')
    }
    await page.button('Propose').click()
    expect(events.proposeMyStop).not.toHaveBeenCalled()
  })

  it('turns it off, with the reason, for someone who was never in the meetup', async () => {
    const page = await open({ session: session({ activeIds: ['faith', 'jonathan'], members: [{ id: 'faith', state: 'joined' }] }) })
    expect(page.textOf(byTestId(page, 'roam-blocked')[0])).toBe('Only people in this meetup can propose places.')
    expect(page.all('button', 'Propose').every((b) => b.props.disabled)).toBe(true)
  })

  it('leaves it on for a member', async () => {
    const page = await open()
    expect(byTestId(page, 'roam-blocked')).toHaveLength(0)
    expect(page.all('button', 'Propose').every((b) => !b.props.disabled)).toBe(true)
  })

  it('says the plan is full when it holds eight stops', async () => {
    const stops = Array.from({ length: 8 }, (_, i) => ({ slotId: `s${i}`, venueId: `x${i}` }))
    const page = await open({ session: session({ plan: { stops } }) })
    expect(page.textOf(byTestId(page, 'roam-blocked')[0])).toBe('The plan has 8 stops, the most it can hold.')
    expect(page.all('button', 'Propose').every((b) => b.props.disabled)).toBe(true)
  })
})

describe('the newest list wins', () => {
  it('ignores a slow earlier answer that arrives after a newer one', async () => {
    const slow = later()
    api.roamNearby.mockReset()
    api.roamNearby.mockReturnValueOnce(slow.promise)
    api.roamNearby.mockResolvedValue(answer(place('v2', 'Corner Bowling', { venue: venue('v2', 'Corner Bowling', { category: 'activity' }) })))
    const page = await open()
    // The first list (all kinds) is still coming; a chip asks for another, which answers at once.
    await page.button('Eat').click()
    await flush()
    expect(page.textOf(page.all('article')[0])).toContain('Corner Bowling')
    // The older answer arrives late and is dropped.
    slow.resolve(answer(place('v1', 'Green Kitchen')))
    await flush()
    expect(page.all('article')).toHaveLength(1)
    expect(page.textOf(page.all('article')[0])).toContain('Corner Bowling')
    expect(byTestId(page, 'roam-loading')).toHaveLength(0)
  })

  it('ignores a slow earlier failure that arrives after a newer answer', async () => {
    const slow = later()
    api.roamNearby.mockReset()
    api.roamNearby.mockReturnValueOnce(slow.promise)
    api.roamNearby.mockResolvedValue(answer(place('v2', 'Corner Bowling')))
    const page = await open()
    await page.button('Drink').click()
    await flush()
    slow.reject(new Error('Cannot reach the Jio planner right now.'))
    await flush()
    expect(page.text()).not.toContain('Could not load places')
    expect(page.all('article')).toHaveLength(1)
  })

  it('drops an answer that arrives after the plan was finished, and stops loading', async () => {
    const slow = later()
    api.roamNearby.mockReset()
    api.roamNearby.mockReturnValue(slow.promise)
    // The closed page links back to the session, so it needs a router.
    const { createRouter, createMemoryHistory } = await import('vue-router')
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:rest(.*)*', component: { render: () => null } }] })
    const page = mount(RoamView, { id: 's1' }, [pinia, router])
    await flush()
    expect(byTestId(page, 'roam-loading')).toHaveLength(1)
    // The outing is finished while the list is still coming.
    events.byId = { s1: session({ status: 'completed' }) }
    await flush()
    expect(page.text()).toContain('This outing is over.')
    slow.resolve(answer(place('v1', 'Green Kitchen')))
    await flush()
    expect(page.all('article')).toHaveLength(0)
    expect(byTestId(page, 'roam-loading')).toHaveLength(0)
    expect(byTestId(page, 'roam-closed')).toHaveLength(1)
  })
})

describe('the proposed stops say only what happened', () => {
  const proposals = [
    { id: 'pp1', venueId: 'v1', by: 'faith', byName: 'Faith', venue: venue('v1', 'Green Kitchen') },
    { id: 'pp2', venueId: 'v2', by: 'ian', byName: 'Ian', venue: venue('v2', 'Corner Bowling', { category: 'activity' }) },
  ]
  const rows = (s = {}, props = {}) => mount(ProposedStops, { session: session({ proposals, ...s }), myId: 'ian', ...props }, [pinia])
  const goneNote = (page) => page.all('p').filter((p) => p.props['data-testid'] === 'proposed-gone')

  it('does not say "added" when the proposal was gone: it says so, in the status and in words on the page', async () => {
    events.resolveProposal.mockResolvedValue(false)
    const page = rows()
    await page.button('Add to plan').click()
    expect(statusOf(page)).toBe('That proposal is no longer there.')
    expect(page.textOf(goneNote(page)[0])).toBe('That proposal is no longer there.')
    expect(page.text()).not.toContain('was added to the plan')
    await page.button('Not now').click()
    expect(statusOf(page)).toBe('That proposal is no longer there.')
    expect(page.text()).not.toContain('was left out')
  })

  it('says "added" after a change that was made', async () => {
    const page = rows()
    await page.button('Add to plan').click()
    expect(statusOf(page)).toBe('Green Kitchen was added to the plan.')
    expect(goneNote(page)).toHaveLength(0)
  })

  it('says it was left out, or taken back, after those changes', async () => {
    const page = rows()
    await page.button('Not now').click()
    expect(statusOf(page)).toBe('Green Kitchen was left out.')
    const guest = rows({ hostId: 'faith', hostName: 'Faith' })
    await guest.button('Take back').click()
    expect(statusOf(guest)).toBe('You took back Corner Bowling.')
  })

  it('waits for the itinerary to load again before it announces an added stop or moves focus', async () => {
    const reload = later()
    vi.spyOn(events, 'loadItinerary').mockReturnValue(reload.promise)
    const emptied = vi.fn()
    const page = rows({ proposals: [proposals[0]] }, { onEmptied: emptied })
    const pressed = page.button('Add to plan').click()
    await flush()
    expect(events.resolveProposal).toHaveBeenCalled()
    expect(events.loadItinerary).toHaveBeenCalledWith('s1')
    expect(statusOf(page)).toBe('')
    expect(emptied).not.toHaveBeenCalled()
    reload.resolve({})
    await pressed
    await flush()
    expect(statusOf(page)).toBe('Green Kitchen was added to the plan.')
    expect(emptied).toHaveBeenCalledTimes(1)
  })

  it('still announces the change when the itinerary cannot be loaded again', async () => {
    vi.spyOn(events, 'loadItinerary').mockRejectedValue(new Error('offline'))
    const page = rows()
    await page.button('Add to plan').click()
    await flush()
    expect(statusOf(page)).toBe('Green Kitchen was added to the plan.')
    expect(page.all('p').some((p) => p.props.role === 'alert')).toBe(false)
  })

  it('does not reload the itinerary for a proposal that was left out', async () => {
    const load = vi.spyOn(events, 'loadItinerary').mockResolvedValue({})
    const page = rows()
    await page.button('Not now').click()
    expect(load).not.toHaveBeenCalled()
  })

  it('ignores a second press while a change is saving', async () => {
    const saving = later()
    events.resolveProposal.mockReturnValue(saving.promise)
    vi.spyOn(events, 'loadItinerary').mockResolvedValue({})
    const page = rows()
    const first = page.button('Add to plan').click()
    await flush()
    await page.button('Add to plan').click()
    await page.button('Not now').click()
    expect(events.resolveProposal).toHaveBeenCalledTimes(1)
    saving.resolve(true)
    await first
    await flush()
    await page.button('Not now').click()
    expect(events.resolveProposal).toHaveBeenCalledTimes(2)
  })

  it('puts the visible words of each button at the start of its accessible name', () => {
    const page = rows()
    const guest = rows({ hostId: 'faith', hostName: 'Faith' })
    for (const button of [...page.all('button'), ...guest.all('button')]) {
      const visible = (page.textOf(button) || guest.textOf(button)).trim()
      expect(page.attr(button, 'aria-label')).toMatch(new RegExp(`^${visible}`))
    }
    expect(page.all('button').map((b) => page.attr(b, 'aria-label'))).toEqual([
      'Add to plan: Green Kitchen', 'Not now: Green Kitchen', 'Add to plan: Corner Bowling', 'Not now: Corner Bowling',
    ])
  })
})

describe('the host is told before adding a stop that would end after the session\'s end', () => {
  const proposals = [{ id: 'pp1', venueId: 'v1', by: 'faith', byName: 'Faith', venue: venue('v1', 'Green Kitchen') }]
  const itinerary = (end) => ({ stops: [{ venue: venue('v9', 'Last Stop'), start: end - 60, end, duration: 60 }] })
  const late = (page) => page.all('p').filter((p) => p.props['data-testid'] === 'proposed-late')

  it('says when it would end and when the session ends, before "Add to plan" is pressed', () => {
    const page = mount(ProposedStops, { session: session({ proposals, end: '21:30' }), myId: 'ian', itinerary: itinerary(1300) }, [pinia])
    expect(late(page)).toHaveLength(1)
    expect(page.textOf(late(page)[0])).toMatch(/^Would end at \d\d:\d\d, after the session's end, 21:30$/)
    expect(page.all('button', 'Add to plan')).toHaveLength(1)
  })

  it('says nothing when it would end in time, or without an itinerary, and nothing to a guest', () => {
    expect(late(mount(ProposedStops, { session: session({ proposals, end: '21:30' }), myId: 'ian', itinerary: itinerary(600) }, [pinia]))).toHaveLength(0)
    expect(late(mount(ProposedStops, { session: session({ proposals, end: '21:30' }), myId: 'ian' }, [pinia]))).toHaveLength(0)
    expect(late(mount(ProposedStops, { session: session({ proposals, end: '21:30', hostId: 'faith', hostName: 'Faith' }), myId: 'ian', itinerary: itinerary(1300) }, [pinia]))).toHaveLength(0)
  })

  it('reads a time past midnight as the next day', () => {
    const page = mount(ProposedStops, { session: session({ proposals, end: '21:30' }), myId: 'ian', itinerary: itinerary(1430) }, [pinia])
    expect(page.textOf(late(page)[0])).toMatch(/^Would end at \d\d:\d\d tomorrow, after the session's end, 21:30$/)
  })

  it('counts from now when the plan ended hours ago', async () => {
    vi.setSystemTime(new Date('2026-10-09T21:00:00+08:00'))
    const page = mount(ProposedStops, { session: session({ proposals, end: '21:30' }), myId: 'ian', itinerary: itinerary(600) }, [pinia])
    await flush()
    // Added at 21:00 it would end at 22:00 at the soonest.
    expect(page.textOf(late(page)[0])).toBe('Would end at 22:00, after the session\'s end, 21:30')
  })
})
