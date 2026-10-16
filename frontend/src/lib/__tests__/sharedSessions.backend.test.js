// Leaving and removing, the frontend and the backend together: api.js (real, with the real planner client) calls the real Express
// route DELETE /api/sessions/:id/members/:userId, started in this process. The login check is the stand-in's (it knows whose token
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
  const server = createApp({ frontendOrigin: 'http://localhost:5173', http: createHttp({ stub: true }), supabase: facade, sessionRateLimit: max ? { windowMs: 60_000, max } : null }).listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  servers.push(server)
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    database,
    async open(profile) {
      const app = await boot(fakeSupabase({ database, memoryOnly: true }), {}, { shared: true })
      app.api.api.defaults.baseURL = base
      const user = await app.api.signUp({ ...profile })
      return { ...app, user }
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
