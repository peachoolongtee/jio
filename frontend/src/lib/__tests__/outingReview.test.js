// Fixes to outings that finish by themselves, found in the review of pull request #152 (tickets #120, #122, #98): a one-person outing
// earns no coins; a read never saves an old state over another tab's newer save; opening a finished outing by its address
// shows it finished; demo sessions are never finished by the clock; a radius change that drops votes says so; the create form's
// day and times late at night; a closed outing takes no photos. The planner is stood in for, as in outingLifecycle.test.js.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY, confirmedSave, fakeStorage, loadApi, loadConfirmed, stubPlanner } from './planFixture.js'
import { VENUES } from '../mock/venues.js'
import { POINTS_PER_MEETUP } from '../mock/people.js'
import { NO_COINS, defaultDate, defaultSessionEnd, defaultTimes, dueEnding, earnsCoins, endHasPassed, singaporeDate, startHasPassed, overdueOuting } from '../session.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), roamNearby: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

const at = (iso) => vi.setSystemTime(new Date(iso))
const stored = (storage) => JSON.parse(storage.store[STORAGE_KEY])
const pointsOf = (storage, id) => stored(storage).stats[id]?.points ?? 0

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  at('2026-10-09T10:00:00')
  stubPlanner(planner)
  // The confirmed save is Saturday 10 October 2026, 12:00 to 20:00, for Ian and Jonathan.
  await confirmedSave()
})
beforeEach(() => {
  stubPlanner(planner)
  at('2026-10-09T10:00:00')
})
afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function signedIn() {
  const api = await loadApi()
  await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' })
  return api
}

describe('an outing of one person earns no coins', () => {
  it('counts two people as the least that earn', () => {
    expect(earnsCoins(0)).toBe(false)
    expect(earnsCoins(1)).toBe(false)
    expect(earnsCoins(2)).toBe(true)
  })

  it('pays nothing for "Finish outing" on "Already out?", however often it is repeated, and says why', async () => {
    at('2026-10-17T14:20:00')
    const api = await signedIn()
    const before = { ...stored(api.storage).stats.ian }
    for (let i = 0; i < 3; i++) {
      const { id } = await api.startRoam({ areaId: 'bugis' })
      const done = await api.endPlan(id)
      expect(done).toMatchObject({ status: 'completed', endedBy: 'hand', paid: false })
    }
    expect(stored(api.storage).stats.ian).toEqual(before)
  })

  it('pays nothing when it finishes by itself once its window ends', async () => {
    at('2026-10-17T14:20:00')
    const api = await signedIn()
    const { id } = await api.startRoam({ areaId: 'bugis' })
    const before = { ...stored(api.storage).stats.ian }
    at('2026-10-17T17:21:00')
    const [s] = await api.listSessions()
    expect(s).toMatchObject({ id, status: 'completed', endedBy: 'auto', paid: false })
    expect(stored(api.storage).stats.ian).toEqual(before)
  })

  it('still pays everyone when two people are in it, light or not', async () => {
    at('2026-10-17T14:20:00')
    const api = await signedIn()
    const { id } = await api.startRoam({ areaId: 'bugis' })
    await api.inviteFriends(id, ['faith'])
    // The friend accepts a moment after being asked, as in the demo: a read after that moment (settleInvites) counts her in.
    at('2026-10-17T15:00:00')
    const before = pointsOf(api.storage, 'ian')
    const done = await api.endPlan(id)
    expect(done).toMatchObject({ status: 'completed', paid: true })
    expect(pointsOf(api.storage, 'ian')).toBe(before + POINTS_PER_MEETUP)
    expect(pointsOf(api.storage, 'faith')).toBeGreaterThanOrEqual(POINTS_PER_MEETUP)
  })

  it('has words for the dialog, the toast and the notice', () => {
    expect(NO_COINS.before).toBe('Outings with friends earn JioCoins. This one is just you, so it earns none.')
    expect(NO_COINS.toast).toBe('No JioCoins for an outing of one. Outings with friends earn them.')
    expect(NO_COINS.done).toBe('This outing was just you, so it earned no JioCoins. Outings with friends earn them.')
  })
})

describe('a read never saves an old state over another tab\'s newer save', () => {
  // Two copies of the data layer on one storage, as two tabs of one browser are.
  async function twoTabs(change = () => {}) {
    const { text } = await confirmedSave()
    const save = JSON.parse(text)
    change(save)
    const storage = fakeStorage({ data: { [STORAGE_KEY]: JSON.stringify(save) } })
    vi.stubGlobal('localStorage', storage)
    vi.resetModules()
    const a = await import('../api.js')
    vi.resetModules()
    const b = await import('../api.js')
    return { a, b, storage }
  }
  const richIan = (save) => {
    save.stats.ian.points = 500
  }

  it('keeps a voucher redeemed in tab A when tab B, opened before it, reads after the end time', async () => {
    const { a, b, storage } = await twoTabs(richIan)
    at('2026-10-10T19:00:00')
    await a.redeemReward('r-nylon')
    expect(stored(storage).redemptions).toHaveLength(1)
    expect(pointsOf(storage, 'ian')).toBe(440)
    at('2026-10-10T20:30:00')
    // Tab B still holds ian at 500 points, no voucher, a confirmed outing past its end.
    const [s] = await b.listSessions()
    expect(s).toMatchObject({ status: 'completed', endedBy: 'auto' })
    const after = stored(storage)
    expect(after.redemptions).toHaveLength(1)
    // 500 less the voucher, plus the outing: settled on top of A's save, not over it.
    expect(after.stats.ian.points).toBe(440 + POINTS_PER_MEETUP)
  })

  it('does not pay twice when tab A already finished the outing and redeemed after it', async () => {
    const { a, b, storage } = await twoTabs(richIan)
    at('2026-10-10T20:30:00')
    await a.listSessions()
    await a.redeemReward('r-nylon')
    const afterA = stored(storage)
    expect(afterA.stats.ian.points).toBe(500 + POINTS_PER_MEETUP - 60)
    const [s] = await b.listSessions()
    expect(s.status).toBe('completed')
    expect(stored(storage)).toEqual(afterA)
  })

  it('writes nothing when the stored save cannot be read, and the read still answers', async () => {
    const { b, storage } = await twoTabs()
    storage.store[STORAGE_KEY] = '{not a save'
    at('2026-10-10T20:30:00')
    const writes = storage.writes
    const list = await b.listSessions()
    expect(list).toHaveLength(1)
    expect(storage.store[STORAGE_KEY]).toBe('{not a save')
    expect(storage.writes).toBe(writes)
  })
})

describe('an outing opened by its address after its end time is finished', () => {
  it('shows it completed, paid once, and refuses a second "Finish outing" in plain words', async () => {
    const { api, id } = await loadConfirmed()
    const before = pointsOf(api.storage, 'ian')
    at('2026-10-10T20:05:00')
    const session = await api.getSession(id)
    expect(session).toMatchObject({ status: 'completed', endedBy: 'auto', paid: true })
    expect(pointsOf(api.storage, 'ian')).toBe(before + POINTS_PER_MEETUP)
    await expect(api.endPlan(id)).rejects.toThrow('This outing has already finished.')
    expect(pointsOf(api.storage, 'ian')).toBe(before + POINTS_PER_MEETUP)
  })

  it('keeps the old words for a plan that was never confirmed', async () => {
    const api = await signedIn()
    const { id } = await api.createSession({ title: 'Later', date: '2026-10-12', start: '12:00', end: '20:00' })
    await expect(api.endPlan(id)).rejects.toThrow('Only a confirmed plan can be ended.')
  })
})

describe('a closed outing takes no photos', () => {
  it('refuses a photo for an outing that closed with no plan, and still takes one for a finished plan', async () => {
    const api = await signedIn()
    const { id } = await api.createSession({ title: 'Never planned', date: '2026-10-10', start: '12:00', end: '20:00' })
    await api.inviteFriends(id, ['jonathan'])
    await api.startSession(id)
    at('2026-10-12T20:01:00')
    const [closed] = await api.listSessions()
    expect(closed).toMatchObject({ status: 'completed', endedBy: 'closed' })
    await expect(api.addPhoto(id, 'ian', 'data:image/jpeg;base64,AAAA')).rejects.toThrow('This outing closed without a plan, so it has no photos.')

    at('2026-10-09T10:00:00')
    const done = await loadConfirmed()
    at('2026-10-10T21:00:00')
    await done.api.listSessions()
    await expect(done.api.addPhoto(done.id, 'ian', 'data:image/jpeg;base64,AAAA')).resolves.toBeTruthy()
  })
})

describe('demo sessions are never finished by the clock', () => {
  const keepOpenSession = { status: 'confirmed', date: '2026-10-10', end: '20:00', keepOpen: true }

  it('leaves a keepOpen session alone for the rules, and out of the overdue reminder', () => {
    const late = new Date('2026-12-31T23:00:00')
    expect(dueEnding(keepOpenSession, late)).toBeNull()
    expect(dueEnding({ ...keepOpenSession, status: 'voting' }, late)).toBeNull()
    expect(overdueOuting({ ...keepOpenSession, status: 'voting' }, late)).toBeNull()
    expect(dueEnding({ ...keepOpenSession, keepOpen: false }, late)).toBe('finish')
  })

  it('keeps a session made with keepOpen as it is, days past its end', async () => {
    const api = await signedIn()
    const { id } = await api.createSession({ title: 'Demo', date: '2026-10-10', start: '12:00', end: '20:00', keepOpen: true })
    await api.inviteFriends(id, ['jonathan'])
    await api.startSession(id)
    at('2026-10-20T10:00:00')
    const [s] = await api.listSessions()
    expect(s).toMatchObject({ id, status: 'locating', keepOpen: true })
  })
})

describe('a radius change that drops votes says so', () => {
  // A planner that honours the radius: with one set, only the first place of a category fits.
  function radiusPlanner() {
    planner.rankSlot.mockReset().mockImplementation(async ({ slot, currentOptionIds = [], radiusMeters }) => {
      const option = (venue, i) => ({ venue, rank: i + 1, score: i, walk: 5, crowd: 'quiet', reasons: [], warnings: [], swap: null, explanation: '', dietUnknown: [], verify: [], approximate: false })
      const fits = VENUES.filter((v) => v.category === slot.category).slice(0, radiusMeters ? 1 : 3)
      return { options: fits.map(option), current: fits.filter((v) => currentOptionIds.includes(v.id)).map(option), widened: false, few: null, empty: null }
    })
  }
  async function votingWithVotes() {
    radiusPlanner()
    const api = await signedIn()
    const { id } = await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' })
    await api.inviteFriends(id, ['jonathan'])
    await api.startSession(id)
    await api.setLocation(id, 'ian', 'start', { areaId: 'tampines' })
    await api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
    await api.useMeetingArea(id)
    const { slots } = await api.getPlan(id)
    const eat = slots.find((s) => s.category === 'eat')
    await api.vote(id, eat.id, 'ian', eat.options[0].id)
    await api.vote(id, eat.id, 'jonathan', eat.options[1].id)
    return { api, id, eat }
  }

  it('puts a banner on the session, in the words, and takes the votes for places outside the ring', async () => {
    const { api, id, eat } = await votingWithVotes()
    const s = await api.setRadius(id, 250)
    expect(s.banner).toMatchObject({ text: 'Votes for places outside the new ring were cleared.', votesCleared: true })
    expect(Object.keys((await api.getSession(id)).votes[eat.id])).toEqual(['ian'])
  })

  it('says nothing when no vote was dropped, and takes the banner back on the next change', async () => {
    const { api, id } = await votingWithVotes()
    expect((await api.setRadius(id, 250)).banner?.votesCleared).toBe(true)
    // Widening again drops no vote: the old notice goes.
    expect((await api.setRadius(id, null)).banner).toBeNull()
    // Nobody voted for what stays inside: no banner either.
    const first = await votingWithVotes()
    await first.api.vote(first.id, first.eat.id, 'jonathan', first.eat.options[0].id)
    expect((await first.api.setRadius(first.id, 250)).banner).toBeNull()
  })
})

describe('the create form late at night', () => {
  const clock = (iso) => new Date(iso)

  it('presets tomorrow when the default start is after midnight, and nothing otherwise', () => {
    expect(defaultTimes(clock('2026-10-17T23:30:00'))).toEqual({ start: '00:00', end: '03:00' })
    expect(defaultDate(clock('2026-10-17T23:30:00'))).toBe('2026-10-18')
    expect(defaultDate(clock('2026-10-17T23:00:00'))).toBe('2026-10-18')
    expect(defaultDate(clock('2026-10-31T23:59:00'))).toBe('2026-11-01')
    expect(defaultDate(clock('2026-10-17T22:59:00'))).toBe('')
    expect(defaultDate(clock('2026-10-17T14:20:00'))).toBe('')
    expect(defaultDate(clock('2026-10-17T00:10:00'))).toBe('')
  })

  it('refuses an end that has already passed today, never one on a later day', () => {
    const now = clock('2026-10-17T23:30:00')
    expect(endHasPassed('2026-10-17', '03:00', now)).toBe(true)
    expect(endHasPassed('2026-10-17', '23:30', now)).toBe(true)
    expect(endHasPassed('2026-10-17', '23:31', now)).toBe(false)
    expect(endHasPassed('2026-10-18', '03:00', now)).toBe(false)
    expect(endHasPassed('', '03:00', now)).toBe(false)
    expect(endHasPassed('2026-10-17', '', now)).toBe(false)
  })

  it('refuses a start that has passed in Singapore time', () => {
    const now = clock('2026-10-17T08:30:00Z') // 16:30 in Singapore
    expect(startHasPassed('2026-10-17', '16:00', now)).toBe(true)
    expect(startHasPassed('2026-10-17', '17:00', now)).toBe(false)
    expect(startHasPassed('2026-10-18', '09:00', now)).toBe(false)
  })

  it('uses Singapore’s calendar date across the UTC day boundary', () => {
    expect(singaporeDate(new Date('2026-10-17T16:30:00Z'))).toBe('2026-10-18')
    expect(singaporeDate(new Date('2026-10-17T15:59:00Z'))).toBe('2026-10-17')
  })

  it('does not give a 23:59 start a zero-length default session', () => {
    expect(defaultSessionEnd('23:59')).toBe('23:59')
    expect(defaultSessionEnd('23:30')).toBe('23:59')
    expect(defaultSessionEnd('15:00')).toBe('21:00')
  })
})
