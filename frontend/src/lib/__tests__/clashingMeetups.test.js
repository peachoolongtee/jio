// Making or changing a meetup that overlaps another one the person is in is refused with a ClashError (lib/api.js assertFree).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadApi } from './planFixture.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

let api
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00+08:00'))
  api = await loadApi()
  await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2004-03-18', homeAreaId: 'bishan' })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const make = (over = {}) => api.createSession({ title: 'Dinner', date: '2026-10-10', start: '19:00', end: '21:00', ...over })

describe('a second meetup at the same time', () => {
  it('is refused, naming the first', async () => {
    const first = await make()
    const err = await make({ title: 'Drinks', start: '20:00', end: '22:00' }).catch((e) => e)
    expect(err.code).toBe('schedule_clash')
    expect(err.clash).toMatchObject({ id: first.id, title: 'Dinner', start: '19:00', end: '21:00' })
    expect((await api.listSessions()).length).toBe(1)
  })

  it('is allowed back to back or on another day', async () => {
    await make()
    await expect(make({ title: 'Late', start: '21:00', end: '23:00' })).resolves.toBeTruthy()
    await expect(make({ title: 'Next day', date: '2026-10-11' })).resolves.toBeTruthy()
  })

  it('is refused when an edit moves a meetup onto another', async () => {
    await make()
    const other = await make({ title: 'Brunch', start: '10:00', end: '12:00' })
    const err = await api.updateSession(other.id, { title: 'Brunch', date: '2026-10-10', start: '20:00', end: '22:00' }).catch((e) => e)
    expect(err.code).toBe('schedule_clash')
  })

  it('does not clash with itself when only its title changes', async () => {
    const first = await make()
    await expect(api.updateSession(first.id, { title: 'Dinner out', date: '2026-10-10', start: '19:00', end: '21:00' })).resolves.toBeTruthy()
  })
})
