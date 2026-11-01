// Home's week chips (walkthrough, 30 October 2026): This week, Next week, After next week and All choose which meetups "Your meetups" lists, and the
// map pins only those, so each pin has its row. Drawn for real (domless.js) on the stand-in planner, for a local account; the pins need a
// browser and are stood in for by an element that says how many it was given and for which areas, and the dotted map by one that says how
// many routes it draws and where they end. Also: the routes, always six, converge on the selected pin.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { loadApi, stubPlanner } from './planFixture.js'
import { mountScreen, until } from './domless.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), roamNearby: vi.fn(), forecast: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
vi.mock('../../components/home/MeetupPins.vue', () => ({
  default: { props: ['pins'], setup: (props) => () => h('div', { 'data-testid': 'pins', 'data-areas': props.pins.map((p) => p.areaName).join(',') }, String(props.pins.length)) },
}))
vi.mock('../../components/ui/SingaporeMap.vue', () => ({
  default: { props: ['routes'], setup: (props) => () => h('div', { 'data-testid': 'routes', 'data-ends': [...new Set(props.routes.map((r) => `${r.to.lat},${r.to.lng}`))].join('|') }, String(props.routes.length)) },
}))
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 })

beforeAll(() => vi.useFakeTimers({ toFake: ['Date'] }))
beforeEach(() => {
  stubPlanner(planner)
  // Friday 30 October 2026 in Singapore: this week ends on Sunday 1 November.
  vi.setSystemTime(new Date('2026-10-30T10:00:00+08:00'))
})
afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// A meetup with Darius on `date`, its place already named, so it has a pin.
// How to call: await meetupAt(api, '2026-11-03', 'bishan')
async function meetupAt(api, date, areaId) {
  const { id } = await api.createSession({ title: `Out ${date}`, date, start: '12:00', end: '15:00' })
  await api.inviteFriends(id, ['darius'])
  await api.startSession(id, { meetBy: 'known' })
  await api.setKnownPlace(id, areaId)
}

// Home for Ian with one meetup this week (Saturday, Bugis) and two next week (Bishan, Orchard).
async function drawHome() {
  const api = await loadApi()
  await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' })
  await meetupAt(api, '2026-10-31', 'bugis')
  await meetupAt(api, '2026-11-03', 'bishan')
  await meetupAt(api, '2026-11-04', 'orchard')
  const { createPinia, setActivePinia } = await import('pinia')
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  await useAuthStore().init()
  const { routes } = await import('@/router/routes.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  await router.push('/')
  const { default: LandingView } = await import('@/views/LandingView.vue')
  const view = await mountScreen(LandingView, { plugins: [pinia, router] })
  await until(() => view.has('[data-testid=meetup-ranges]'))
  return view
}
const chip = (view, label) => view.all('[role=radio]').find((c) => view.text(c).startsWith(label))

describe('the week chips on Home', () => {
  it('start on This week, with counts, and pin only what is listed', async () => {
    const view = await drawHome()
    expect(chip(view, 'This week').attrs['aria-checked']).toBe('true')
    expect(chip(view, 'This week').attrs['aria-label']).toBe('This week, 1 meetup')
    expect(chip(view, 'Next week').attrs['aria-label']).toBe('Next week, 2 meetups')
    expect(chip(view, 'After next week').attrs['aria-disabled']).toBe('true')
    expect(view.text('[data-testid=pins]')).toBe('1')
    expect(view.one('[data-testid=pins]').attrs['data-areas']).toBe('Bugis')
    // Each row says its stage and whose turn it is; Ian has not voted, so it is his.
    expect(view.text('[data-testid=meetup-status]')).toContain('Voting')
    expect(view.text('[data-testid=your-turn]')).toBe('Your turn · Vote')
    // "Your turn" counts every meetup waiting on Ian, whatever its week: all three wait for his vote.
    expect(view.one('[data-testid=your-turn-filter]').attrs['aria-label']).toBe('Your turn, 3 meetups')
    expect(view.errors).toEqual([])
  })

  it('"Your turn" moves the chips to All with only the meetups waiting on you; off, All lists everything; a week turns it off', async () => {
    const view = await drawHome()
    const mine = () => view.one('[data-testid=your-turn-filter]')
    await view.click(mine())
    expect(mine().attrs['aria-pressed']).toBe('true')
    expect(chip(view, 'All').attrs['aria-checked']).toBe('true')
    await until(() => view.text('[data-testid=pins]') === '3')
    await view.click(mine())
    expect(mine().attrs['aria-pressed']).toBe('false')
    expect(chip(view, 'All').attrs['aria-checked']).toBe('true')
    await view.click(mine())
    await view.click(chip(view, 'Next week'))
    expect(mine().attrs['aria-pressed']).toBe('false')
    await until(() => view.text('[data-testid=pins]') === '2')
  })

  it('show next week\'s meetups and pins when Next week is chosen, and all of them for All', async () => {
    const view = await drawHome()
    await view.click(chip(view, 'Next week'))
    await until(() => view.text('[data-testid=pins]') === '2')
    expect(view.one('[data-testid=pins]').attrs['data-areas'].split(',').sort()).toEqual(['Bishan', 'Orchard'])
    await view.click(chip(view, 'All'))
    await until(() => view.text('[data-testid=pins]') === '3')
  })

  it('ignore a chip with nothing in it', async () => {
    const view = await drawHome()
    await view.click(chip(view, 'After next week'))
    expect(chip(view, 'This week').attrs['aria-checked']).toBe('true')
    expect(view.text('[data-testid=pins]')).toBe('1')
  })
})

describe('the routes on the map', () => {
  const BISHAN = '1.35092,103.84822'
  const ORCHARD = '1.30406,103.83186'

  it('are always six, from the same starts, converging on the selected meetup\'s pin, and move when another is picked', async () => {
    const view = await drawHome()
    const { AREAS } = await import('../mock/places.js')
    const at = (id) => AREAS.find((a) => a.id === id)
    const bugis = `${at('bugis').lat},${at('bugis').lng}`
    expect(view.text('[data-testid=routes]')).toBe('6')
    expect(view.one('[data-testid=routes]').attrs['data-ends']).toBe(bugis)
    await view.click(chip(view, 'Next week'))
    await until(() => view.one('[data-testid=routes]').attrs['data-ends'] === BISHAN)
    expect(view.text('[data-testid=routes]')).toBe('6')
    // Picking the Orchard meetup's row moves them there, still six.
    const row = view.all('button').find((b) => view.text(b).includes('Out 2026-11-04'))
    await view.click(row)
    await until(() => view.one('[data-testid=routes]').attrs['data-ends'] === ORCHARD)
    expect(view.text('[data-testid=routes]')).toBe('6')
  })
})
