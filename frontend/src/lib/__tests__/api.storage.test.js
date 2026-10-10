// The data layer and local storage: a full storage fails loudly and leaves nothing half-saved, a damaged save is
// replaced, a confirmed plan is not re-ranked, and the sign-up and itinerary rules. The planner is stubbed.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY, confirmedSave, loadApi, loadConfirmed, stubPlanner } from './planFixture.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
  stubPlanner(planner)
  await confirmedSave()
})
beforeEach(() => stubPlanner(planner))
afterEach(() => vi.unstubAllGlobals())

const FULL = /storage is full/

describe('when storage is full', () => {
  it('rejects the write, keeps the old state, and works again once there is room', async () => {
    const { api, id } = await loadConfirmed()
    const before = api.storage.store[STORAGE_KEY]
    // Room for what is stored and a little more, but not for a big photo.
    api.storage.limit = before.length + 200
    await expect(api.addPhoto(id, 'ian', 'x'.repeat(5000))).rejects.toThrow(FULL)
    expect((await api.getSession(id)).photoCount).toBe(0)
    expect(api.storage.store[STORAGE_KEY]).toBe(before)
    await api.addPhoto(id, 'ian', 'tiny')
    expect((await api.getSession(id)).photoCount).toBe(1)
  })

  it('rejects any other write too, not only photos, and undoes it', async () => {
    const { api } = await loadConfirmed()
    api.storage.limit = api.storage.store[STORAGE_KEY].length
    const count = (await api.listSessions()).length
    await expect(api.createSession({ title: 'One more session with a long enough title', date: '2026-11-01', start: '10:00', end: '18:00' })).rejects.toThrow(FULL)
    expect(await api.listSessions()).toHaveLength(count)
    await expect(api.setFriend('darius', true)).rejects.toThrow(FULL)
    expect((await api.listPeople()).find((p) => p.id === 'darius').isFriend).toBe(false)
  })

  it('keeps working on the same session object after a rollback', async () => {
    const { api, id } = await loadConfirmed()
    api.storage.limit = api.storage.store[STORAGE_KEY].length
    await expect(api.addPhoto(id, 'ian', 'x'.repeat(5000))).rejects.toThrow(FULL)
    api.storage.limit = Infinity
    const photo = await api.addPhoto(id, 'ian', 'ok')
    expect(photo.photoCount).toBe(1)
    expect(JSON.parse(api.storage.store[STORAGE_KEY]).sessions.find((s) => s.id === id).photos).toHaveLength(1)
  })

  it('still works in memory when storage is missing altogether', async () => {
    vi.resetModules()
    vi.stubGlobal('localStorage', undefined)
    const api = await import('../api.js')
    await api.signUp({ email: 'a@b.sg', name: 'Ian', username: 'ian', dob: '2000-01-01', homeAreaId: 'tampines' })
    expect((await api.getUser()).name).toBe('Ian')
  })
})

describe('photos', () => {
  it('saves once per photo', async () => {
    const { api, id } = await loadConfirmed()
    const writes = api.storage.writes
    await api.addPhoto(id, 'ian', 'one')
    expect(api.storage.writes - writes).toBe(1)
  })

  it('holds at most 12 per session, with a clear message', async () => {
    const { api, id } = await loadConfirmed()
    for (let i = 0; i < api.PHOTOS_MAX; i++) await api.addPhoto(id, 'ian', `p${i}`)
    expect(api.PHOTOS_MAX).toBe(12)
    await expect(api.addPhoto(id, 'ian', 'one too many')).rejects.toThrow(/up to 12 photos/)
    expect((await api.getSession(id)).photoCount).toBe(12)
    await api.deletePhoto(id, (await api.getPhotos(id))[0].id)
    await api.addPhoto(id, 'ian', 'room again')
  })

  it('leaves the pictures out of a session summary and returns them from getPhotos', async () => {
    const { api, id } = await loadConfirmed()
    await api.addPhoto(id, 'ian', 'data:one')
    await api.addPhoto(id, 'jonathan', 'data:two')
    const session = await api.getSession(id)
    expect(session.photoCount).toBe(2)
    expect(session).not.toHaveProperty('photos')
    expect((await api.listSessions())[0]).not.toHaveProperty('photos')
    const photos = await api.getPhotos(id)
    expect(photos.map((p) => [p.src, p.name])).toEqual([['data:one', 'Ian'], ['data:two', 'Jonathan']])
    expect((await api.getPhotos(id, { latest: 1 })).map((p) => p.src)).toEqual(['data:two'])
  })
})

describe('a saved state that is not in the right shape', () => {
  const saved = async () => JSON.parse((await confirmedSave()).text)
  const open = async (state) => loadApi({ data: { [STORAGE_KEY]: JSON.stringify(state) } })

  it('is used when it is whole', async () => {
    const api = await open(await saved())
    expect(await api.listSessions()).toHaveLength(1)
  })

  it.each([
    ['stats gone', (s) => delete s.stats],
    ['sessions not a list', (s) => (s.sessions = 'oops')],
    ['a session without members', (s) => delete s.sessions[0].members],
    ['season without dates', (s) => (s.season = { number: 1 })],
    ['seq not a number', (s) => (s.seq = 'x')],
    ['a person missing from the stats', (s) => delete s.stats.faith],
    ['conditions missing', (s) => delete s.conditions],
  ])('is replaced by a fresh one when %s, keeping the account and friends', async (_name, damage) => {
    const state = await saved()
    state.friends = ['darius']
    damage(state)
    const api = await open(state)
    expect(await api.listSessions()).toEqual([])
    expect((await api.getUser()).name).toBe('Ian')
    // The people and the leaderboard read the stats, so they would crash on a damaged save.
    expect((await api.listPeople()).find((p) => p.id === 'darius').isFriend).toBe(true)
    expect(await api.getLeaderboard()).toHaveLength(6)
  })

  it('drops the account too when that is damaged', async () => {
    const state = await saved()
    state.user = { name: 5 }
    state.friends = 'darius'
    delete state.stats
    const api = await open(state)
    expect(await api.getUser()).toBeNull()
    expect((await api.listPeople()).every((p) => !p.isFriend)).toBe(true)
  })

  it('treats an older version as before', async () => {
    const state = await saved()
    state.version = 4
    const api = await open(state)
    expect(await api.listSessions()).toEqual([])
    expect((await api.getUser()).name).toBe('Ian')
  })

  it('reads text that is not a save at all as no save', async () => {
    const api = await loadApi({ data: { [STORAGE_KEY]: '{not json' } })
    expect(await api.getUser()).toBeNull()
  })
})

describe('a confirmed plan', () => {
  it('is shown from what was stored, without asking the planner', async () => {
    const { api, id } = await loadConfirmed()
    planner.rankSlot.mockClear()
    const plan = await api.getPlan(id)
    expect(planner.rankSlot).not.toHaveBeenCalled()
    // Every category is still shown; the two that were voted on are the plan's stops.
    expect(plan.slots).toHaveLength(4)
    const voted = plan.slots.filter((s) => ['eat', 'activity'].includes(s.category))
    expect(voted).toHaveLength(2)
    for (const slot of voted) {
      expect(slot.options).toHaveLength(3)
      const [option] = slot.options
      expect(option.votes).toBe(2)
      expect(option.reasons).toEqual(['Close to everyone'])
      expect(option.walk).toBeGreaterThan(0)
      expect(slot.canAddMore).toBe(false)
    }
  })

  it('is shown from storage when the plan is completed too', async () => {
    const { api, id } = await loadConfirmed()
    await api.endPlan(id)
    planner.rankSlot.mockClear()
    expect((await api.getPlan(id)).slots).toHaveLength(4)
    expect(planner.rankSlot).not.toHaveBeenCalled()
  })

  it('shows a plan confirmed before the details were kept, with a walk estimate and no reasons', async () => {
    const state = JSON.parse((await confirmedSave()).text)
    delete state.sessions[0].confirmedRanking
    const api = await loadApi({ data: { [STORAGE_KEY]: JSON.stringify(state) } })
    const plan = await api.getPlan(state.sessions[0].id)
    expect(plan.slots[0].options[0].reasons).toEqual([])
    expect(plan.slots[0].options[0].walk).toBeGreaterThanOrEqual(0)
    expect(planner.rankSlot).not.toHaveBeenCalled()
  })

  it('is ranked again once it goes back to voting, and options have no crowd', async () => {
    const { api, id } = await loadConfirmed()
    await api.replan(id)
    planner.rankSlot.mockClear()
    const plan = await api.getPlan(id)
    expect(planner.rankSlot).toHaveBeenCalledTimes(plan.slots.length)
    const option = plan.slots[0].options[0]
    expect(option).not.toHaveProperty('crowd')
    expect(Object.keys(option)).not.toContain('crowd')
  })

  it('has options without a crowd field', async () => {
    const { api, id } = await loadConfirmed()
    for (const slot of (await api.getPlan(id)).slots) for (const option of slot.options) expect(option).not.toHaveProperty('crowd')
  })

  it('does not keep a stored ranking in the session summary', async () => {
    const { api, id } = await loadConfirmed()
    expect(await api.getSession(id)).not.toHaveProperty('confirmedRanking')
  })
})

describe('deleting stops', () => {
  it('starts the plan at the new first stop when the first one goes', async () => {
    const { api, id } = await loadConfirmed()
    const before = await api.getItinerary(id)
    expect(before.stops).toHaveLength(2)
    // The second stop's own planned time, from the stored plan.
    const secondPlanned = (await api.getSession(id)).plan.stops[1].plannedStart
    expect(secondPlanned).toBeGreaterThan(before.stops[0].start)
    await api.deleteStop(id, 0)
    const after = await api.getItinerary(id)
    expect(after.stops).toHaveLength(1)
    // Starts at the remaining stop's own time, not pulled forward to the old start.
    expect(after.stops[0].start).toBe(secondPlanned)
  })

  it('keeps the start when a later stop goes', async () => {
    const { api, id } = await loadConfirmed()
    const before = await api.getItinerary(id)
    await api.deleteStop(id, 1)
    expect((await api.getItinerary(id)).stops[0].start).toBe(before.stops[0].start)
  })

  it('rejects, with a clear message, when the session has no plan', async () => {
    const api = await loadApi()
    await api.signUp({ email: 'a@b.sg', name: 'Ian', username: 'ian', dob: '2000-01-01', homeAreaId: 'tampines' })
    const { id } = await api.createSession({ title: 'No plan yet', date: '2026-10-10', start: '12:00', end: '20:00' })
    await expect(api.deleteStop(id, 0)).rejects.toThrow(/no plan/)
    await expect(api.setTravelMode(id, 0, 'walk')).rejects.toThrow(/no plan/)
  })

  it('rejects a stop that does not exist', async () => {
    const { api, id } = await loadConfirmed()
    await expect(api.deleteStop(id, 5)).rejects.toThrow(/does not exist/)
  })
})

describe('sign-up rules', () => {
  const good = { email: 'a@b.sg', name: 'Ian', username: 'ian_99', dob: '2004-03-18', homeAreaId: 'tampines' }
  const signUp = async (patch) => (await loadApi()).signUp({ ...good, ...patch })

  it('stores the date of birth and no permissions', async () => {
    const api = await loadApi()
    const user = await api.signUp({ ...good, name: '  Ian Pong  ' })
    expect(user.dob).toBe('2004-03-18')
    expect(user.name).toBe('Ian Pong')
    expect(user).not.toHaveProperty('permissions')
  })

  it.each([['ab'], ['a'.repeat(21)], ['ian.pong'], ['Ian'], ['with space'], ['']])('rejects the username %j', async (username) => {
    await expect(signUp({ username })).rejects.toThrow(/Username must be 3 to 20/)
  })

  it('accepts the shortest and longest usernames', async () => {
    await signUp({ username: 'abc' })
    await signUp({ username: 'a'.repeat(20) })
  })

  it('needs a name of 1 to 50 characters after trimming', async () => {
    await expect(signUp({ name: '   ' })).rejects.toThrow(/Enter your name/)
    await expect(signUp({ name: 'x'.repeat(51) })).rejects.toThrow(/name can be up to 50/)
    await signUp({ name: 'x'.repeat(50) })
    await signUp({ name: `  ${'x'.repeat(50)}  ` })
  })

  it.each([
    [undefined, /date of birth as YYYY-MM-DD/],
    ['18/03/2004', /date of birth as YYYY-MM-DD/],
    ['2001-02-30', /does not exist/],
    ['2026-10-10', /in the future/],
    ['2099-01-01', /in the future/],
    ['1899-12-31', /before 1900/],
  ])('rejects the date of birth %s', async (dob, message) => {
    await expect(signUp({ dob })).rejects.toThrow(message)
  })

  it('accepts today and the first day of 1900', async () => {
    await signUp({ dob: '2026-10-09' })
    await signUp({ dob: '1900-01-01' })
  })

  it('no longer reads the permissions', async () => {
    await expect(signUp({ locationAllowed: undefined, contactsAllowed: undefined })).resolves.toBeTruthy()
  })

  it('applies the username rules when checking a username, and finds taken ones', async () => {
    const api = await loadApi()
    await expect(api.checkUsername('a.b')).rejects.toThrow(/Username must be/)
    await expect(api.checkUsername('Darius')).rejects.toThrow(/Username must be/)
    expect(await api.checkUsername('darius')).toEqual({ available: false })
    expect(await api.checkUsername('nobody_here')).toEqual({ available: true })
  })
})

describe('demo conditions', () => {
  it('have no crowd switch', async () => {
    const api = await loadApi()
    expect(Object.keys(await api.getConditions()).sort()).toEqual(['rain', 'routing', 'sessionDay'])
    expect(Object.keys(await api.setConditions({ crowd: true, rain: true })).sort()).toEqual(['rain', 'routing', 'sessionDay'])
  })

  it('drop a crowd switch left in an older save', async () => {
    const state = JSON.parse((await confirmedSave()).text)
    state.conditions.crowd = true
    state.conditions.rain = true
    const api = await loadApi({ data: { [STORAGE_KEY]: JSON.stringify(state) } })
    expect(await api.getConditions()).toEqual({ rain: true, routing: true, sessionDay: false })
  })

  it('send no crowd to the planner', async () => {
    const { api, id } = await loadConfirmed()
    await api.replan(id)
    await api.getPlan(id)
    for (const [call] of planner.rankSlot.mock.calls) expect(call.conditions).not.toHaveProperty('crowd')
  })
})
