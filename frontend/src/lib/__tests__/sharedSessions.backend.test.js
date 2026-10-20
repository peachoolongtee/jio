// Leaving and removing, and the meeting spots (stage 3), the frontend and the backend together: api.js (real, with the real planner
// client) calls the real Express routes under /api/sessions/:id, started in this process. The login check is the stand-in's (it knows whose token
// each stand-in client issued) and the database is the stand-in (components/dev/fakeDatabase.js) that both sides use. If the
// request or the answer drifts apart, this fails.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../../../backend/src/app.js'
import { createHttp } from '../../../../backend/src/services/http.js'
import { OTHER, PROFILE, SESSION, boot, fakeSupabase } from './authFixture.js'
import { SERVICE, createDataClient, createDatabase } from '../../components/dev/fakeDatabase.js'

const THIRD = { email: 'lee@example.com', password: 'Th1rd-secret!', name: 'Lee', username: 'lee_third', dob: '1998-01-02', homeAreaId: 'bishan', friends: [] }

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

const servers = []
afterAll(() => servers.forEach((s) => s.close()))

// The database, the real backend on it, and a way to open the app as someone with its planner client pointed at that backend.
// How to call: const w = await world({ max: 3 }); const sam = await w.open(PROFILE)
async function world({ max } = {}) {
  const database = createDatabase({ profiles: {} })
  const facade = {
    service: createDataClient({ database, as: () => SERVICE }),
    forUser: (token) => createDataClient({ database, as: () => database.userForToken(token) }),
    verifyToken: async (token) => {
      const id = database.userForToken(token)
      return id ? { id, email: null } : null
    },
  }
  const server = createApp({ frontendOrigin: 'http://localhost:5173', http: createHttp({ stub: true }), supabase: facade, sessionRateLimit: max ? { windowMs: 60_000, max } : null }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  servers.push(server)
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    database,
    async open(profile) {
      const fake = fakeSupabase({ database, memoryOnly: true })
      const app = await boot(fake, {}, { shared: true })
      app.api.api.defaults.baseURL = base
      const user = await app.api.signUp({ ...profile })
      return { ...app, fake, user }
    },
  }
}

// Two or three people in one session.
// How to call: const t = await session(w, [OTHER, THIRD]) -> { sam, guests: [kim, lee], id }
async function session(w, guests) {
  const sam = await w.open(PROFILE)
  const { id } = await sam.api.createSession({ ...SESSION })
  const { token } = await sam.api.makeInviteLink(id)
  const joined = []
  for (const profile of guests) {
    const guest = await w.open(profile)
    await guest.api.joinWithLink(token)
    joined.push(guest)
  }
  return { sam, guests: joined, id }
}

const memberIds = (w) => w.database.tables.session_members.map((m) => m.user_id)

describe('leaving a session', () => {
  it('lets a guest leave, and the host\'s next read no longer has them', async () => {
    const w = await world()
    const { sam, guests: [kim], id } = await session(w, [OTHER])
    await kim.api.leaveSession(id)
    expect(memberIds(w)).toEqual([sam.user.id])
    expect((await sam.api.getSession(id)).members.map((m) => m.id)).toEqual([sam.user.id])
    await expect(kim.api.getSession(id)).rejects.toMatchObject({ code: 'not_found' })
    // The session row's version went up, which is what the others hear.
    expect(w.database.tables.sessions[0].plan_version).toBe(1)
  })

  it('tells the host to cancel instead of leaving', async () => {
    const w = await world()
    const { sam, id } = await session(w, [OTHER])
    await expect(sam.api.leaveSession(id)).rejects.toMatchObject({ message: 'The host cannot leave. Cancel the session instead.', code: 'host_cannot_leave' })
    expect(memberIds(w)).toHaveLength(2)
  })

  it('says so when the session has ended', async () => {
    const w = await world()
    const { sam, guests: [kim], id } = await session(w, [OTHER])
    await sam.api.cancelSession(id)
    await expect(kim.api.leaveSession(id)).rejects.toMatchObject({ message: 'This session has ended.' })
    expect(memberIds(w)).toHaveLength(2)
  })

  it('says so when the person is not in the session', async () => {
    const w = await world()
    const { id } = await session(w, [])
    const lee = await w.open(THIRD)
    await expect(lee.api.leaveSession(id)).rejects.toMatchObject({ message: 'This session does not exist, or you are not in it.' })
  })
})

describe('removing a guest', () => {
  it('lets the host remove a guest and answers with the session as it is then', async () => {
    const w = await world()
    const { sam, guests: [kim, lee], id } = await session(w, [OTHER, THIRD])
    const after = await sam.api.removeFromSession(id, kim.user.id)
    expect(after.members.map((m) => m.id)).toEqual([sam.user.id, lee.user.id])
    await expect(kim.api.getSession(id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('does not let a guest remove anyone, or the host be removed', async () => {
    const w = await world()
    const { sam, guests: [kim, lee], id } = await session(w, [OTHER, THIRD])
    await expect(kim.api.removeFromSession(id, lee.user.id)).rejects.toMatchObject({ message: 'Only the host can remove someone.' })
    await expect(kim.api.removeFromSession(id, sam.user.id)).rejects.toMatchObject({ message: 'Only the host can remove someone.' })
    expect(memberIds(w)).toHaveLength(3)
  })

  it('says so when the person is already gone', async () => {
    const w = await world()
    const { sam, guests: [kim], id } = await session(w, [OTHER])
    await kim.api.leaveSession(id)
    await expect(sam.api.removeFromSession(id, kim.user.id)).rejects.toMatchObject({ message: 'That person is not in this session any more.' })
  })
})

describe('the limit', () => {
  it('holds one person to a few tries a minute, in words', async () => {
    const w = await world({ max: 2 })
    const { guests: [kim], id } = await session(w, [OTHER])
    // Two refusals use the allowance; the third is turned away before the server looks at it.
    for (let i = 0; i < 2; i += 1) await expect(kim.api.removeFromSession(id, '99999999-9999-4999-8999-999999999999')).rejects.toMatchObject({ code: 'host_only' })
    await expect(kim.api.leaveSession(id)).rejects.toThrow('Too many requests. Wait a few seconds and try again.')
    expect(memberIds(w)).toHaveLength(2)
  })
})

// Two people, started (locating), with the spots worked out by the real server.
// How to call: const t = await locatingPair(w); await t.sam.api.getSession(t.id)
async function locatingPair(w, { starts = true } = {}) {
  const { sam, guests: [kim], id } = await session(w, [OTHER])
  await sam.api.startSession(id)
  if (starts) {
    await sam.api.setLocation(id, sam.user.id, 'start', { areaId: 'tampines', label: 'Tampines Mall' })
    await kim.api.setLocation(id, kim.user.id, 'start', { areaId: 'bishan', label: 'Bishan Junction 8' })
  }
  return { sam, kim, id }
}

// Counts the calls an app makes to POST /api/sessions/:id/meeting-area (E1), and lets a test run something just before each.
// How to call: const asked = watchRepairs(kim); ...; expect(asked.count).toBe(1)
function watchRepairs(app, before = null) {
  const asked = { count: 0 }
  app.api.api.interceptors.request.use(async (config) => {
    if (config.method === 'post' && String(config.url).endsWith('/meeting-area')) {
      asked.count += 1
      await before?.(asked.count)
    }
    return config
  })
  return asked
}

describe('a start saved while the host confirms', () => {
  // The host confirms between the guest's direct write and the guest's call to the server. The server answers 409 not_yet while the
  // group is voting, and 409 wrong_status once the session is further on; the guest's start stays, and nothing is thrown.
  it.each([
    ['not_yet', 'voting', async () => {}],
    ['wrong_status', 'confirmed', async (w, id) => { w.database.tables.sessions.find((s) => s.id === id).status = 'confirmed' }],
  ])('keeps the start and throws nothing when the server says %s', async (code, status, extra) => {
    const w = await world()
    const { sam, kim, id } = await locatingPair(w)
    const answers = []
    kim.api.api.interceptors.response.use(undefined, (err) => (answers.push(err?.code), Promise.reject(err)))
    const asked = watchRepairs(kim, async () => {
      // Kim's new start is in the database already; now the host confirms (the spots are priced for both), then the call arrives.
      await sam.api.confirmSpot(id)
      await extra(w, id)
    })
    const seen = await kim.api.setLocation(id, kim.user.id, 'start', { areaId: 'jurong-east', label: 'Jurong East Mall' })
    expect(asked.count).toBe(1)
    expect(answers).toEqual([code])
    expect(w.database.tables.sessions.find((s) => s.id === id).status).toBe(status === 'voting' ? 'voting' : 'confirmed')
    expect(w.database.tables.session_members.find((m) => m.user_id === kim.user.id).start_area_id).toBe('jurong-east')
    expect(seen.locations[kim.user.id].start).toMatchObject({ areaId: 'jurong-east' })
  })

  it('still takes the start back when the server fails for another reason', async () => {
    const w = await world()
    const { kim, id } = await locatingPair(w)
    watchRepairs(kim, async () => { w.database.tables.session_members = w.database.tables.session_members.filter((m) => m.user_id !== kim.user.id) })
    await expect(kim.api.setLocation(id, kim.user.id, 'start', { areaId: 'bishan', label: 'Bishan Junction 8' })).rejects.toBeInstanceOf(Error)
  })
})

describe('the banner the server writes', () => {
  // apply_session_plan writes { text, at, approvalsRemoved: true } (in milliseconds) when approvals went with a spot that left the
  // list, and the app shows it as it is: the shape is the server's, nothing is added to it in the browser.
  it('is { text, at, approvalsRemoved: true } in the database and on the screens, and a newer one shows again after a dismissal', async () => {
    const w = await world()
    const { sam, kim, id } = await locatingPair(w)
    const row = () => w.database.tables.sessions.find((s) => s.id === id)
    expect(row().banner).toBeNull()
    await kim.api.suggestSpot(id, kim.user.id, 'orchard')
    await sam.api.approveSpot(id, sam.user.id, 'orchard', true)
    await kim.api.withdrawSpot(id, kim.user.id)
    const firstAt = row().banner.at
    expect(row().banner).toEqual({ text: expect.stringContaining('no longer on the list'), at: expect.any(Number), approvalsRemoved: true })
    expect(Object.keys(row().banner).sort()).toEqual(['approvalsRemoved', 'at', 'text'])
    const seen = await sam.api.getSession(id)
    expect(seen.banner).toEqual({ text: row().banner.text, at: row().banner.at, approvalsRemoved: true })
    // Dismissing is Sam's alone; Kim still sees it.
    expect((await sam.api.dismissBanner(id)).banner).toBeNull()
    expect((await sam.api.getSession(id)).banner).toBeNull()
    expect((await kim.api.getSession(id)).banner).toMatchObject({ approvalsRemoved: true })
    // A later banner has a later `at`, so it shows again.
    vi.setSystemTime(new Date('2026-10-09T10:00:05'))
    await kim.api.suggestSpot(id, kim.user.id, 'punggol')
    await sam.api.approveSpot(id, sam.user.id, 'punggol', true)
    await kim.api.withdrawSpot(id, kim.user.id)
    const later = (await sam.api.getSession(id)).banner
    expect(later).toMatchObject({ approvalsRemoved: true })
    expect(later.at).toBeGreaterThan(firstAt)
    // The browser adds nothing to what the server wrote: a banner that does not say approvals were removed does not become one.
    row().banner = { text: 'Something else changed.', at: later.at + 1 }
    expect((await sam.api.getSession(id)).banner).toEqual({ text: 'Something else changed.', at: later.at + 1 })
    vi.setSystemTime(new Date('2026-10-09T10:00:00'))
  })
})

// The same person's app loaded again, as a page reload does: a fresh copy of the modules, signed in to the same account.
// How to call: const page = await openAgain(sam, PROFILE)
async function openAgain(app, profile) {
  const page = await boot(app.fake, {}, { shared: true })
  page.api.api.defaults.baseURL = app.api.api.defaults.baseURL
  await page.api.signIn({ email: profile.email, password: profile.password })
  return page
}

describe('the repair of a start that was never priced', () => {
  // A member's row is newer than every spot when a start was saved and the server never heard, or when something else on the row
  // changed (their categories, how long they stay). The first time a page opens the session it asks the server once. The server
  // brings the spots' time of working out forward even if nothing moved, so the next page does not ask again.
  it('asks once, and a second page load of the same session asks nothing', async () => {
    const w = await world()
    const { sam, kim, id } = await locatingPair(w)
    // Kim changes something that does not change a spot, straight in the database, a minute later.
    vi.setSystemTime(new Date('2026-10-09T10:01:00'))
    await w.database.run({ as: kim.user.id, kind: 'update', table: 'session_members', values: { categories: ['eat'] }, filters: [{ col: 'session_id', op: 'eq', value: id }, { col: 'user_id', op: 'eq', value: kim.user.id }] })
    const spotsBefore = JSON.stringify(w.database.tables.session_spots.map(({ computed_at: _at, ...rest }) => rest))
    const versionBefore = w.database.tables.sessions.find((s) => s.id === id).plan_version

    // The first page: Sam opens the session (a page of his own, loaded now), which finds the gap and asks once.
    vi.setSystemTime(new Date('2026-10-09T10:02:00'))
    const page1 = await openAgain(sam, PROFILE)
    const first = watchRepairs(page1)
    await page1.api.getSession(id)
    await vi.waitFor(() => expect(first.count).toBe(1))
    // The spots are now newer than Kim's last change (10:01), which is what the page compares.
    await vi.waitFor(() => expect(Math.min(...w.database.tables.session_spots.map((x) => Date.parse(x.computed_at)))).toBeGreaterThan(Date.parse('2026-10-09T10:01:00')))
    // Nothing moved: same spots, same version, only the time of working out is later.
    expect(JSON.stringify(w.database.tables.session_spots.map(({ computed_at: _at, ...rest }) => rest))).toBe(spotsBefore)
    expect(w.database.tables.sessions.find((s) => s.id === id).plan_version).toBe(versionBefore)

    // A second page of the same person (the app loaded again, a minute later) reads the session and asks nothing.
    vi.setSystemTime(new Date('2026-10-09T10:03:00'))
    const page2 = await openAgain(sam, PROFILE)
    const second = watchRepairs(page2)
    const read = await page2.api.getSession(id)
    expect(read.spots.list).toHaveLength(3)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(second.count).toBe(0)
    vi.setSystemTime(new Date('2026-10-09T10:00:00'))
  })
})
