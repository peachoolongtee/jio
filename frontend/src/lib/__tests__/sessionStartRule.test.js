// A session cannot start in the past in Singapore, and every way into the data layer says so: the create form's checks
// (checkSessionFields) now guard `createSession` and `updateSession` alike, on a demo account's local data. The days and times are
// Singapore's whatever the time zone of the machine the tests run on, so the clocks here are explicit instants, chosen so that
// the date in Singapore and the date in UTC differ. A change of the title alone is always allowed. The path of a real account is
// in sessionStartRule.server.test.js.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadApi, stubPlanner } from './planFixture.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

const at = (iso) => vi.setSystemTime(new Date(iso))
const PAST_START = 'That start time has already passed today.'

let api
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  at('2026-10-09T10:00:00+08:00')
  stubPlanner(planner)
  api = await loadApi()
  await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2004-03-18', homeAreaId: 'bishan' })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('creating a session on a local account', () => {
  it('refuses a start earlier today in Singapore, and takes one later today', async () => {
    at('2026-10-10T05:00:00Z') // 13:00 in Singapore
    await expect(api.createSession({ title: 'Lunch', date: '2026-10-10', start: '12:00', end: '15:00' })).rejects.toThrow(PAST_START)
    await expect(api.createSession({ title: 'Lunch', date: '2026-10-10', start: '13:00', end: '15:00' })).rejects.toThrow(PAST_START)
    await expect(api.createSession({ title: 'Tea', date: '2026-10-10', start: '13:01', end: '15:00' })).resolves.toMatchObject({ date: '2026-10-10', start: '13:01' })
  })

  it('counts the day in Singapore: at 00:30 on the 11th there, the 10th has passed even though it is still the 10th in UTC', async () => {
    at('2026-10-10T16:30:00Z')
    await expect(api.createSession({ title: 'Supper', date: '2026-10-10', start: '23:00', end: '23:59' })).rejects.toThrow('That day has passed.')
    await expect(api.createSession({ title: 'Supper', date: '2026-10-11', start: '00:15', end: '03:00' })).rejects.toThrow(PAST_START)
    await expect(api.createSession({ title: 'Supper', date: '2026-10-11', start: '00:45', end: '03:00' })).resolves.toMatchObject({ date: '2026-10-11' })
  })

  it('is as strict as the server path about the other fields, and adds nothing when it refuses', async () => {
    const before = (await api.listSessions()).length
    await expect(api.createSession({ title: '  ', date: '2026-10-10', start: '12:00', end: '15:00' })).rejects.toThrow(/title/i)
    await expect(api.createSession({ title: 'Lunch', date: '2026-10-10', start: '15:00', end: '12:00' })).rejects.toThrow(/after the start/i)
    await expect(api.createSession({ title: 'Lunch', date: '2027-02-01', start: '12:00', end: '15:00' })).rejects.toThrow(/3 months/i)
    expect((await api.listSessions()).length).toBe(before)
  })

  it('keeps the title trimmed', async () => {
    expect(await api.createSession({ title: '  Lunch  ', date: '2026-10-10', start: '12:00', end: '15:00' })).toMatchObject({ title: 'Lunch' })
  })

  it('leaves the demo\'s own sessions alone: keepOpen ones are built at fixed times, some already under way', async () => {
    at('2026-10-10T05:00:00Z')
    await expect(api.createSession({ title: 'Live now', date: '2026-10-10', start: '12:00', end: '18:00', keepOpen: true })).resolves.toMatchObject({ start: '12:00' })
  })
})

describe('editing a session on a local account', () => {
  let id
  beforeEach(async () => {
    ;({ id } = await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' }))
    at('2026-10-10T05:00:00+00:00') // 13:00 on the day in Singapore: the start has passed
  })

  it('refuses to move the start to a time that has passed, and leaves the session as it was', async () => {
    await expect(api.updateSession(id, { title: 'Saturday', date: '2026-10-10', start: '12:30', end: '20:00' })).rejects.toThrow(PAST_START)
    expect(await api.getSession(id)).toMatchObject({ date: '2026-10-10', start: '12:00', end: '20:00' })
  })

  it('refuses to move the session to a day that has passed', async () => {
    await expect(api.updateSession(id, { title: 'Saturday', date: '2026-10-09', start: '18:00', end: '20:00' })).rejects.toThrow('That day has passed.')
  })

  it('takes a later start', async () => {
    await expect(api.updateSession(id, { title: 'Saturday', date: '2026-10-10', start: '13:30', end: '20:00' })).resolves.toMatchObject({ start: '13:30' })
  })

  it('allows a change of the title alone, though the start has passed since', async () => {
    const saved = await api.updateSession(id, { title: 'Saturday lunch', date: '2026-10-10', start: '12:00', end: '20:00' })
    expect(saved).toMatchObject({ title: 'Saturday lunch', date: '2026-10-10', start: '12:00', end: '20:00' })
  })

  it('still checks the title and the shape of the times when only the title changes', async () => {
    await expect(api.updateSession(id, { title: '', date: '2026-10-10', start: '12:00', end: '20:00' })).rejects.toThrow(/title/i)
  })

  it('allows the title alone after the day has passed too', async () => {
    at('2026-10-12T05:00:00Z')
    await expect(api.updateSession(id, { title: 'Renamed', date: '2026-10-10', start: '12:00', end: '20:00' })).resolves.toMatchObject({ title: 'Renamed' })
  })
})
