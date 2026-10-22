// The same rule for a real account, whose sessions are on the server (lib/api.js `onServer`): a start that has passed in Singapore is
// refused when a session is made or when its day and times change, and a change of the title alone is always allowed. The browser
// refuses before anything is sent (the database's own rule on dates is a schema change and not part of this). The real data
// layer, on the stand-in Jio server and database (sessionsWorld.js); the clocks are explicit instants.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROFILE } from './authFixture.js'
import { world } from './sessionsWorld.js'

const at = (iso) => vi.setSystemTime(new Date(iso))
const PAST_START = 'That start time has already passed today.'

let w
let sam
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  at('2026-10-09T10:00:00+08:00')
  w = world()
  sam = await w.open(PROFILE)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const rows = () => w.database.tables.sessions

describe('creating a session for a real account', () => {
  it('refuses a start that has passed in Singapore, and writes nothing', async () => {
    at('2026-10-10T05:00:00Z') // 13:00 on the 10th in Singapore
    const before = w.ops.length
    await expect(sam.api.createSession({ title: 'Lunch', date: '2026-10-10', start: '12:00', end: '15:00' })).rejects.toThrow(PAST_START)
    expect(rows()).toHaveLength(0)
    expect(w.ops.length).toBe(before)
    await expect(sam.api.createSession({ title: 'Tea', date: '2026-10-10', start: '13:30', end: '15:00' })).resolves.toMatchObject({ start: '13:30' })
    expect(rows()).toHaveLength(1)
  })

  it('counts the day in Singapore, not in UTC', async () => {
    at('2026-10-10T16:30:00Z') // 00:30 on the 11th in Singapore, still the 10th in UTC
    await expect(sam.api.createSession({ title: 'Supper', date: '2026-10-10', start: '23:00', end: '23:59' })).rejects.toThrow('That day has passed.')
    await expect(sam.api.createSession({ title: 'Supper', date: '2026-10-11', start: '00:15', end: '03:00' })).rejects.toThrow(PAST_START)
    expect(rows()).toHaveLength(0)
  })
})

describe('editing a session for a real account', () => {
  let id
  beforeEach(async () => {
    ;({ id } = await sam.api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' }))
    // The page has read the session; then the day comes, and the start has passed.
    await sam.api.getSession(id)
    at('2026-10-10T05:00:00Z')
  })

  it('refuses to move the start to a time that has passed, and leaves the row as it was', async () => {
    await expect(sam.api.updateSession(id, { title: 'Saturday', date: '2026-10-10', start: '12:30', end: '20:00' })).rejects.toThrow(PAST_START)
    expect(rows()[0]).toMatchObject({ title: 'Saturday', start_time: expect.stringMatching(/^12:00/) })
  })

  it('takes a later start', async () => {
    await expect(sam.api.updateSession(id, { title: 'Saturday', date: '2026-10-10', start: '13:30', end: '20:00' })).resolves.toMatchObject({ start: '13:30' })
  })

  it('allows a change of the title alone, though the start has passed since', async () => {
    await expect(sam.api.updateSession(id, { title: 'Saturday lunch', date: '2026-10-10', start: '12:00', end: '20:00' })).resolves.toMatchObject({ title: 'Saturday lunch', start: '12:00' })
    expect(rows()[0].title).toBe('Saturday lunch')
  })
})
