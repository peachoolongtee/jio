// The profile's Sessions list narrowed by a search box and by a day picked on the meetup graph (walkthrough, 30 October 2026).
// The rules are pure functions in lib/profileSessions.js; the screen is drawn on the in-memory page (domless.js) with a stand-in
// graph whose one button picks a day, as a click on the real canvas does.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { boot } from './authFixture.js'
import { mountScreen, until } from './domless.js'
import { narrowSessions, narrowedEmptyText } from '../profileSessions.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
vi.mock('@/components/ui/GridPulse.vue', () => ({ default: { render: () => null } }))
// The graph picks 12 October, or lets it go when that day is picked again, as the canvas does. A second button picks the first day
// that has only a sample meetup (no session).
vi.mock('@/components/ui/MeetupGraph.vue', () => ({
  default: {
    props: ['history', 'planned', 'selected'],
    emits: ['select'],
    setup(props, { emit }) {
      const sampleDay = () => (props.history || []).map((d) => d.date).sort().find((d) => d < '2026-10-01')
      return () => h('div', [
        h('button', { type: 'button', 'data-testid': 'graph-day', onClick: () => emit('select', props.selected === '2026-10-12' ? null : '2026-10-12') }, 'Mon 12 Oct'),
        h('button', { type: 'button', 'data-testid': 'graph-sample-day', onClick: () => emit('select', sampleDay()) }, 'A sample day'),
      ])
    },
  },
}))

vi.setConfig({ testTimeout: 20000 })
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00+08:00'))
})
afterEach(() => vi.unstubAllGlobals())

const NOW = new Date('2026-10-09T10:00:00+08:00')
const make = (id, over = {}) => ({ id, title: id, status: 'locating', date: '2026-10-12', start: '19:00', areaName: '', ...over })
const ids = (list) => list.map((s) => s.id)

describe('narrowing the profile list', () => {
  const list = [
    make('Dinner catch-up', { areaName: 'Bugis' }),
    make('Saturday hangout', { date: '2026-10-17', areaName: 'Tampines' }),
    make('Beach day', { date: '2026-10-12', areaName: 'East Coast' }),
  ]

  it('keeps everything with no search and no day', () => {
    expect(ids(narrowSessions(list, {}, NOW))).toEqual(ids(list))
  })

  it('matches the title or the meeting area, in any case, and keeps the order it was given', () => {
    expect(ids(narrowSessions(list, { query: '  DINNER ' }, NOW))).toEqual(['Dinner catch-up'])
    expect(ids(narrowSessions(list, { query: 'tampines' }, NOW))).toEqual(['Saturday hangout'])
    expect(ids(narrowSessions(list, { query: 'zoo' }, NOW))).toEqual([])
  })

  it('keeps only the day picked, and both together', () => {
    expect(ids(narrowSessions(list, { day: '2026-10-12' }, NOW))).toEqual(['Dinner catch-up', 'Beach day'])
    expect(ids(narrowSessions(list, { day: '2026-10-12', query: 'beach' }, NOW))).toEqual(['Beach day'])
  })

  it('narrows someone else\'s activity by day too', () => {
    const activity = [{ date: '2026-10-12', text: 'Successful meetup at Bugis' }, { date: '2026-09-01', text: 'Redeemed a voucher' }]
    expect(narrowSessions(activity, { day: '2026-09-01' }, NOW)).toEqual([activity[1]])
  })

  it('says why the list is empty', () => {
    const day = (d) => `day ${d}`
    expect(narrowedEmptyText({ query: 'zoo' }, day)).toBe('Nothing matches “zoo”')
    expect(narrowedEmptyText({ day: '2026-10-12' }, day)).toBe('No sessions on day 2026-10-12')
    expect(narrowedEmptyText({ query: 'zoo', day: '2026-10-12' }, day)).toBe('Nothing matches “zoo” on day 2026-10-12')
  })
})

describe('the Sessions list on your own profile', () => {
  // The profile of the local demo account, holding two sessions on different days.
  async function drawProfile() {
    const booted = await boot(null)
    const { createPinia, setActivePinia } = await import('pinia')
    const pinia = createPinia()
    setActivePinia(pinia)
    const { useAuthStore } = await import('@/stores/auth.js')
    const { DEMO_ACCOUNT } = await import('../../components/dev/demoAccount.js')
    await useAuthStore().signUpAs(DEMO_ACCOUNT)
    await booted.api.createSession({ title: 'Dinner catch-up', date: '2026-10-12', start: '19:00', end: '22:00' })
    await booted.api.createSession({ title: 'Saturday hangout', date: '2026-10-17', start: '12:00', end: '18:00' })
    const stub = { render: () => null }
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: stub }] })
    await router.push('/profile')
    const { default: ProfileView } = await import('@/views/ProfileView.vue')
    const view = await mountScreen(ProfileView, { plugins: [pinia, router] })
    await until(() => view.text().includes('Dinner catch-up') && view.text().includes('Saturday hangout'))
    return view
  }

  it('narrows by what is typed in the search box, and says when nothing matches', async () => {
    const view = await drawProfile()
    view.type('[data-testid=session-search]', 'saturday')
    await until(() => !view.text().includes('Dinner catch-up'))
    expect(view.text()).toContain('Saturday hangout')
    view.type('[data-testid=session-search]', 'zoo')
    await until(() => view.has('[data-testid=sessions-empty]'))
    expect(view.text('[data-testid=sessions-empty]')).toBe('Nothing matches “zoo”')
    expect(view.errors).toEqual([])
  })

  it('lists a day with only sample meetups as past meetups, not as an empty day', async () => {
    const view = await drawProfile()
    await view.click('[data-testid=graph-sample-day]')
    await until(() => view.has('[data-testid=past-meetups]'))
    expect(view.text('[data-testid=past-meetups]')).toMatch(/Meetups? with friends/)
    expect(view.text('[data-testid=past-meetups]')).toContain('Past meetup')
    expect(view.has('[data-testid=sessions-empty]')).toBe(false)
    expect(view.text()).not.toContain('Dinner catch-up')
    expect(view.errors).toEqual([])
  })

  it('shows only the day picked on the graph, with a chip whose × brings everything back', async () => {
    const view = await drawProfile()
    expect(view.has('[data-testid=day-filter]')).toBe(false)
    await view.click('[data-testid=graph-day]')
    await until(() => view.has('[data-testid=day-filter]'))
    expect(view.text('[data-testid=day-filter]')).toContain('Mon 12 Oct 2026')
    expect(view.one('[data-testid=day-filter]').attrs['aria-label']).toBe('Show every day, not only Mon 12 Oct 2026')
    expect(view.text()).toContain('Dinner catch-up')
    expect(view.text()).not.toContain('Saturday hangout')
    expect(view.all('[role=status]').some((n) => view.text(n) === 'Showing Mon 12 Oct 2026 only')).toBe(true)
    await view.click('[data-testid=day-filter]')
    await until(() => view.text().includes('Saturday hangout'))
    expect(view.has('[data-testid=day-filter]')).toBe(false)
    expect(view.errors).toEqual([])
  })

  it('lets the day go when the same day is picked again on the graph, and picks All so the day is never hidden', async () => {
    const view = await drawProfile()
    await view.click(view.all('button').find((b) => view.text(b) === 'Completed'))
    await view.click('[data-testid=graph-day]')
    await until(() => view.text().includes('Dinner catch-up'))
    const all = view.all('[role=radio]').find((b) => view.text(b) === 'All')
    expect(all.attrs['aria-checked']).toBe('true')
    await view.click('[data-testid=graph-day]')
    await until(() => !view.has('[data-testid=day-filter]'))
    expect(view.text()).toContain('Saturday hangout')
  })
})
