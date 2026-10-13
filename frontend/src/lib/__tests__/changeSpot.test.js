// Changing the meeting spot after it was confirmed (the data layer's changeMeetingSpot, and "Change spot" on the session
// page), and a meeting spot card that selects its spot wherever it is clicked. The planner is stubbed the way the new
// backend answers, as in meetingSpots.test.js: the app's spots are Bugis, Bishan and Orchard, fairest first.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { STORAGE_KEY, loadApi, stubPlanner } from './planFixture.js'
import { AREAS } from '../mock/places.js'
import { mountScreen, until } from './domless.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
// The map and its pins need a browser (Leaflet); the screen's own logic is what is under test.
vi.mock('@/components/map/PlannerMap.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/spots/SpotPins.vue', () => ({ default: { render: () => null } }))

vi.setConfig({ testTimeout: 20000 })

const WORST = { bugis: 25, bishan: 30, orchard: 31 }
const RANKED = ['bugis', 'bishan', 'orchard']
const area = (id) => AREAS.find((a) => a.id === id)
// When set, the planner fails, as when it cannot be reached.
let failing = false

// The planner as the new backend answers: the chosen area and its runners-up, then each included area. The first member
// travels the area's longest trip; everyone else five minutes less.
async function answer({ members, alternatives, include = [] }) {
  if (failing) throw new Error('Cannot reach the Jio planner right now. Check your connection and try again.')
  const price = (areaId, source) => {
    const travelByMember = Object.fromEntries(members.map((m, i) => [m.id, (WORST[areaId] ?? 35) - (i === 0 ? 0 : 5)]))
    const minutes = Object.values(travelByMember)
    return { area: area(areaId), worstMinutes: Math.max(...minutes), meanMinutes: minutes.reduce((a, b) => a + b, 0) / minutes.length, travelByMember, approximate: false, source }
  }
  const ranked = RANKED.slice(0, 1 + (alternatives || 0))
  const candidates = [...ranked.map((a) => price(a, 'ranked')), ...include.filter((a) => !ranked.includes(a)).map((a) => price(a, 'included'))]
  const [first] = candidates
  const base = { area: first.area, method: 'station', travelByMember: first.travelByMember, worstMinutes: first.worstMinutes, approximate: false }
  return alternatives === undefined && !include.length ? base : { ...base, candidates }
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
beforeEach(() => {
  failing = false
  stubPlanner(planner)
  planner.meetingArea.mockImplementation(answer)
})
afterEach(() => vi.unstubAllGlobals())

const PROFILE = { email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' }
const areaIds = (session) => session.spots.list.map((s) => s.areaId)
const hasAnyVote = (session) => Object.values(session.votes).some((byPerson) => Object.keys(byPerson).length > 0)

// A session with Ian (the host) and Jonathan, both with a start, that confirmed `spot` and is voting on places, with a
// vote from each of them. With `confirm`, the plan is confirmed too.
// How to call: const { api, id } = await settled({ spot: 'bishan', confirm: true })
async function settled({ spot = 'bugis', confirm = false } = {}) {
  const api = await loadApi()
  await api.signUp(PROFILE)
  const { id } = await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' })
  await api.inviteFriends(id, ['jonathan'])
  await api.startSession(id)
  await api.setLocation(id, 'ian', 'start', { areaId: 'tampines' })
  await api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
  await api.approveSpot(id, 'jonathan', 'bishan', true)
  await api.confirmSpot(id, spot)
  const { slots } = await api.getPlan(id)
  const eat = slots.find((s) => s.category === 'eat')
  for (const person of ['ian', 'jonathan']) await api.vote(id, eat.id, person, eat.options[0].id)
  if (confirm) await api.confirmPlan(id)
  return { api, id }
}

// The same stored sessions with another person as host, so the signed-in person is only a member.
async function hostedBy(api, other) {
  const state = JSON.parse(api.storage.store[STORAGE_KEY])
  for (const session of state.sessions) {
    session.hostId = other
    session.members = session.members.map((m) => ({ ...m, role: m.id === other ? 'host' : 'guest' }))
  }
  return loadApi({ data: { [STORAGE_KEY]: JSON.stringify(state) } })
}

describe('changing the meeting spot (data layer)', () => {
  it('takes a session that is voting back to choosing where to meet, with the spots worked out again', async () => {
    const { api, id } = await settled({ spot: 'orchard' })
    expect(hasAnyVote(await api.getSession(id))).toBe(true)
    await api.changeMeetingSpot(id)
    const session = await api.getSession(id)
    expect(session.status).toBe('locating')
    expect(areaIds(session)).toEqual(RANKED)
    // Everyone has a start, so the meeting area is worked out too, and nothing is pinned to Orchard any more.
    expect(session.meeting?.areaId).toBe('bugis')
    expect(['voted', 'chosen']).not.toContain(session.meeting.method)
    // Votes and places belonged to Orchard.
    expect(hasAnyVote(session)).toBe(false)
    expect(session.options).toEqual({})
    // Who said a spot works for them stays.
    expect(session.spots.approvals).toEqual({ jonathan: ['bishan'] })
  })

  it('clears a confirmed plan and its itinerary', async () => {
    const { api, id } = await settled({ confirm: true })
    expect(await api.getItinerary(id)).not.toBeNull()
    await api.changeMeetingSpot(id)
    expect((await api.getSession(id)).status).toBe('locating')
    expect(await api.getItinerary(id)).toBeNull()
  })

  it('carries on as the first time once another spot is confirmed, and can be changed again', async () => {
    const { api, id } = await settled({ spot: 'bugis', confirm: true })
    await api.changeMeetingSpot(id)
    await api.confirmSpot(id, 'bishan')
    let session = await api.getSession(id)
    expect(session.status).toBe('voting')
    expect(session.meeting.areaId).toBe('bishan')
    const { slots } = await api.getPlan(id)
    expect(slots.some((s) => s.options.length > 0)).toBe(true)
    await api.changeMeetingSpot(id)
    await api.confirmSpot(id, 'orchard')
    session = await api.getSession(id)
    expect(session).toMatchObject({ status: 'voting', meeting: { areaId: 'orchard' } })
  })

  it('works after a known place was set, listing the app’s spots again', async () => {
    const { api, id } = await settled()
    await api.changeMeetingSpot(id)
    await api.setKnownPlace(id, 'kovan')
    expect((await api.getSession(id)).meeting.areaId).toBe('kovan')
    await api.changeMeetingSpot(id)
    const session = await api.getSession(id)
    expect(session.status).toBe('locating')
    expect(areaIds(session)).toEqual(RANKED)
  })

  it('refuses anyone but the host, a spot not confirmed yet, and a session that has ended', async () => {
    const { api, id } = await settled()
    const member = await hostedBy(api, 'jonathan')
    await expect(member.changeMeetingSpot(id)).rejects.toThrow('Only the host can change the meeting spot.')
    await api.changeMeetingSpot(id)
    await expect(api.changeMeetingSpot(id)).rejects.toThrow('once one is confirmed')
    const done = await settled({ confirm: true })
    await done.api.endPlan(done.id)
    await expect(done.api.changeMeetingSpot(done.id)).rejects.toThrow('This session has ended.')
  })

  it('changes nothing when the planner cannot be reached', async () => {
    const { api, id } = await settled({ spot: 'orchard', confirm: true })
    const before = await api.getSession(id)
    failing = true
    await expect(api.changeMeetingSpot(id)).rejects.toThrow('Cannot reach the Jio planner')
    const after = await api.getSession(id)
    expect(after.status).toBe('confirmed')
    expect(after.meeting.areaId).toBe('orchard')
    expect(after.votes).toEqual(before.votes)
    expect(await api.getItinerary(id)).not.toBeNull()
    // And it works once the planner is back.
    failing = false
    await api.changeMeetingSpot(id)
    expect((await api.getSession(id)).status).toBe('locating')
  })

  it('is kept over a page reload', async () => {
    const { api, id } = await settled()
    await api.changeMeetingSpot(id)
    const again = await loadApi({ data: { [STORAGE_KEY]: api.storage.store[STORAGE_KEY] } })
    const session = await again.getSession(id)
    expect(session.status).toBe('locating')
    expect(areaIds(session)).toEqual(RANKED)
  })
})

// ── The screens ──

const SPOT = { areaId: 'bishan', area: { name: 'Bishan' }, by: 'app', here: false, worstMinutes: 30, meanMinutes: 28, times: { ian: 30, jonathan: 25 }, approximate: false, approvedBy: [], approvalCount: 0 }

describe('a meeting spot card', () => {
  // Draw one card, counting what it says.
  // How to call: const { view, said } = await card({ readonly: true })
  async function card(props = {}) {
    const said = { select: 0, approve: [] }
    const { default: SpotRow } = await import('@/components/spots/SpotRow.vue')
    const view = await mountScreen(SpotRow, { props: { spot: SPOT, number: 2, myId: 'ian', onSelect: () => (said.select += 1), onApprove: (on) => said.approve.push(on), ...props } })
    return { view, said }
  }

  it('selects its spot when clicked anywhere on it, not only on the name', async () => {
    const { view, said } = await card()
    await view.click('p.spot__line')
    expect(said.select).toBe(1)
    await view.click('li.spot')
    expect(said.select).toBe(2)
    await view.click('span.spot__min')
    expect(said.select).toBe(3)
    expect(view.errors).toEqual([])
  })

  it('selects once from the name, and not at all from Works for me', async () => {
    const { view, said } = await card()
    await view.click('button.spot__head')
    expect(said.select).toBe(1)
    await view.click(view.all('button').find((b) => b.attrs['aria-label'] === 'Works for me: Bishan'))
    expect(said.approve).toEqual([true])
    expect(said.select).toBe(1)
  })

  it('selects from anywhere on a card that has no controls (the group has moved on)', async () => {
    const { view, said } = await card({ readonly: true })
    await view.click('p.spot__line')
    expect(said.select).toBe(1)
  })
})

// What the session page reads from the browser: the history entry, the screen width, and animation frames for the
// "Finding the meeting point" bar (run on a timer here).
// How to call: browserBits()
function browserBits() {
  vi.stubGlobal('window', { history: { state: null, replaceState() {} }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(() => fn(Date.now()), 16))
  vi.stubGlobal('cancelAnimationFrame', (frame) => clearTimeout(frame))
}

// The session page for a settled session (see settled()), signed in as its local account.
// How to call: const { view, api, id, router } = await drawSettled({ confirm: true })
async function drawSettled(options) {
  const { api, id } = await settled(options)
  const { createPinia, setActivePinia } = await import('pinia')
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  await useAuthStore().init()
  const { routes } = await import('@/router/routes.js')
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: { render: () => null } })) })
  await router.push(`/sessions/${id}`)
  browserBits()
  const { default: GroupDetailView } = await import('@/views/GroupDetailView.vue')
  const view = await mountScreen(GroupDetailView, { plugins: [pinia, router], props: { id } })
  await until(() => view.has('#area-head'))
  return { view, api, id, router, pinia }
}

describe('Change spot on the session page', () => {
  const drawSession = (options) => drawSettled(options)

  it('lets the host go back to choosing where to meet, after saying what goes', async () => {
    const { view, api, id } = await drawSession({ spot: 'orchard' })
    expect(view.text('#area-head')).toBe('Orchard')
    await view.click('[data-testid="change-spot"]')
    await until(() => view.has('[role=dialog]'))
    expect(view.text('[role=dialog]')).toContain('Change the meeting spot from Orchard?')
    expect(view.text('[role=dialog]')).toContain('Votes for places are cleared')
    expect(view.text('[role=dialog]')).not.toContain('itinerary')
    await view.click('[data-testid="confirm-change-spot"]')
    await until(() => !view.has('#area-head') && view.text().includes('Bishan'))
    expect((await api.getSession(id)).status).toBe('locating')
    expect(view.errors.map(String)).toEqual([])
  })

  it('warns that a confirmed plan goes, and keeps the spot when the answer is Keep', async () => {
    const { view, api, id } = await drawSession({ spot: 'orchard', confirm: true })
    await view.click('[data-testid="change-spot"]')
    await until(() => view.has('[role=dialog]'))
    expect(view.text('[role=dialog]')).toContain('The confirmed plan and its itinerary are cleared')
    await view.click(view.all('button').find((b) => view.text(b) === 'Keep Orchard'))
    expect(view.has('[role=dialog]')).toBe(false)
    expect((await api.getSession(id)).status).toBe('confirmed')
  })

  it('shows why in the dialog when the planner cannot be reached, and keeps the spot', async () => {
    const { view, api, id } = await drawSession({ spot: 'orchard' })
    await view.click('[data-testid="change-spot"]')
    await until(() => view.has('[role=dialog]'))
    failing = true
    await view.click('[data-testid="confirm-change-spot"]')
    await until(() => view.has('[data-testid="change-spot-error"]'))
    expect(view.text('[data-testid="change-spot-error"]')).toContain('Cannot reach the Jio planner')
    expect((await api.getSession(id)).status).toBe('voting')
    expect(view.text('#area-head')).toBe('Orchard')
  })

  it('is not offered to someone who is not the host', async () => {
    const { api, id } = await settled({ spot: 'orchard' })
    const member = await hostedBy(api, 'jonathan')
    const { createPinia, setActivePinia } = await import('pinia')
    const pinia = createPinia()
    setActivePinia(pinia)
    const { useAuthStore } = await import('@/stores/auth.js')
    await useAuthStore().init()
    const { routes } = await import('@/router/routes.js')
    const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: { render: () => null } })) })
    await router.push(`/sessions/${id}`)
    browserBits()
    const { default: GroupDetailView } = await import('@/views/GroupDetailView.vue')
    const view = await mountScreen(GroupDetailView, { plugins: [pinia, router], props: { id } })
    await until(() => view.has('#area-head'))
    expect(view.has('[data-testid="change-spot"]')).toBe(false)
    expect(member).toBeTruthy()
  })
})

// Things that could go wrong that the tests above do not try.
describe('changing the meeting spot, under stress', () => {
  it('changes once when Change spot in the dialog is pressed twice at once, with no error', async () => {
    const { view, api, id, pinia } = await drawSettled({ spot: 'orchard' })
    const { useEventsStore } = await import('@/stores/events.js')
    const spy = vi.spyOn(useEventsStore(pinia), 'changeSpot')
    await view.click('[data-testid="change-spot"]')
    await until(() => view.has('[role=dialog]'))
    const button = view.one('[data-testid="confirm-change-spot"]')
    button.dispatch('click')
    button.dispatch('click')
    await until(() => !view.has('#area-head'))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(view.has('[data-testid="change-spot-error"]')).toBe(false)
    expect((await api.getSession(id)).status).toBe('locating')
  })

  it('does not let a ranking of places that was still running put old places back', async () => {
    const { api, id } = await settled({ spot: 'orchard' })
    // A ranking of places that answers late: started while voting, it lands after the change.
    // Every category is ranked, each in its own call: all of them wait until released.
    const held = []
    const answer = planner.rankSlot.getMockImplementation()
    planner.rankSlot.mockImplementation(async (args) => {
      await new Promise((resolve) => held.push(resolve))
      return answer(args)
    })
    const ranking = api.setRadius(id, 1500).catch(() => {})
    await until(() => held.length > 0)
    planner.rankSlot.mockImplementation(answer)
    const changing = api.changeMeetingSpot(id)
    // Let the late ranking answer while the change is under way, and after it.
    await new Promise((resolve) => setTimeout(resolve, 50))
    held.splice(0).forEach((resolve) => resolve())
    await changing
    await ranking
    held.splice(0).forEach((resolve) => resolve())
    await new Promise((resolve) => setTimeout(resolve, 50))
    const session = await api.getSession(id)
    expect(session.status).toBe('locating')
    expect(session.options).toEqual({})
    expect(hasAnyVote(session)).toBe(false)
  })

  it('lists the spots and waits for the meeting area when someone joined later without a start', async () => {
    const { api, id } = await settled({ spot: 'orchard' })
    await api.inviteFriends(id, ['faith'])
    await api.changeMeetingSpot(id)
    const session = await api.getSession(id)
    expect(session.status).toBe('locating')
    expect(areaIds(session)).toEqual(RANKED)
    // Faith has no start, so the meeting area waits for her, as it does the first time.
    expect(session.meeting).toBeNull()
    await api.setLocation(id, 'faith', 'start', { areaId: 'punggol' })
    // The meeting area is worked out once everyone has a start.
    for (let tries = 0; tries < 400 && !(await api.getSession(id)).meeting; tries++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await api.getSession(id)).meeting).toBeTruthy()
    await api.confirmSpot(id, 'bishan')
    expect((await api.getSession(id)).meeting.areaId).toBe('bishan')
  })

  it('takes away a waiting Re-plan question with the old spot', async () => {
    const { api, id } = await settled({ spot: 'orchard', confirm: true })
    const state = JSON.parse(api.storage.store[STORAGE_KEY])
    state.sessions[0].replan = { reason: 'Jonathan moved.', trigger: { kind: 'start', personName: 'Jonathan' } }
    const again = await loadApi({ data: { [STORAGE_KEY]: JSON.stringify(state) } })
    expect((await again.getSession(id)).replan).toBeTruthy()
    await again.changeMeetingSpot(id)
    expect((await again.getSession(id)).replan ?? null).toBeNull()
  })

  it('lets the members keep saying which spots work for them afterwards', async () => {
    const { api, id } = await settled({ spot: 'orchard' })
    await api.changeMeetingSpot(id)
    await api.approveSpot(id, 'ian', 'orchard', true)
    await api.suggestSpot(id, 'jonathan', 'kovan')
    const session = await api.getSession(id)
    expect(session.spots.approvals.ian).toEqual(['orchard'])
    expect(areaIds(session)).toContain('kovan')
  })
})
