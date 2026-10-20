// A world for the tests of stage 3 (where people start and the meeting spots): one stand-in database, the Jio server on it
// (./fakeSessionsServer.js), and copies of the app that sign up on it. Not a test file itself (the name does not end in .test.js).
import { OTHER, PROFILE, SESSION, boot, fakeSupabase } from './authFixture.js'
import { createDatabase } from '../../components/dev/fakeDatabase.js'
import { fakeSessionsServer } from './fakeSessionsServer.js'

export const THIRD = { email: 'lee@example.com', password: 'Th1rd-secret!', name: 'Lee', username: 'lee_third', dob: '1998-01-02', homeAreaId: 'bishan', friends: [] }
export const SAM_PLACE = { areaId: 'tampines', label: 'Tampines Mall, level 2' }
export const KIM_PLACE = { areaId: 'bishan', label: 'Blk 123 Bishan St 12, #05-67' }
export const BASE = 'http://jio.test'

// One database, the Jio server on it, and a way to open the app as someone. `ops` is every request that reached the database from
// a browser; `subscriptions` every live subscription asked for; `gate.hold(op)` may return a promise that delays an answer.
// How to call: const w = world(); const sam = await w.open(PROFILE)
export function world() {
  const database = createDatabase({ profiles: {} })
  const server = fakeSessionsServer(database)
  const ops = []
  const subscriptions = []
  const gate = { hold: null }
  const watched = {
    ...database,
    run: async (op) => {
      ops.push(op)
      const answer = database.run(op)
      const hold = gate.hold?.(op)
      if (hold) await hold
      return answer
    },
    subscribe: (spec, cb) => (subscriptions.push(spec), database.subscribe(spec, cb)),
  }
  return {
    database,
    server,
    ops,
    subscriptions,
    gate,
    async open(profile) {
      const fake = fakeSupabase({ database: watched, memoryOnly: true })
      const app = await boot(fake, {}, { shared: true })
      app.api.api.defaults.baseURL = BASE
      app.api.api.defaults.adapter = server.adapter
      const user = await app.api.signUp({ ...profile })
      return { ...app, fake, user, id: user.id }
    },
  }
}

// Sam hosts a session with Kim in it, started (locating). With `places`, each has shared where they start.
// How to call: const { w, sam, kim, id } = await locating({ places: true })
export async function locating({ places = false, third = false } = {}) {
  const w = world()
  const sam = await w.open(PROFILE)
  const kim = await w.open(OTHER)
  const lee = third ? await w.open(THIRD) : null
  const { id } = await sam.api.createSession({ ...SESSION })
  const { token } = await sam.api.makeInviteLink(id)
  await kim.api.joinWithLink(token)
  if (lee) await lee.api.joinWithLink(token)
  await sam.api.startSession(id)
  if (places) {
    await sam.api.setLocation(id, sam.id, 'start', SAM_PLACE)
    await kim.api.setLocation(id, kim.id, 'start', KIM_PLACE)
  }
  return { w, sam, kim, lee, id }
}

