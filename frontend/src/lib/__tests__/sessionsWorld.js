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
export async function locating({ places = false, third = false, hostLast = false } = {}) {
  const w = world()
  // The app opened last is the one the stores and screens of a test belong to: Kim's by default, or Sam's (the host's) with `hostLast`.
  let sam
  let kim
  if (hostLast) {
    kim = await w.open(OTHER)
    sam = await w.open(PROFILE)
  } else {
    sam = await w.open(PROFILE)
    kim = await w.open(OTHER)
  }
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


// Sam hosts a session with Kim in it, both with a start, and the host has confirmed the first spot: the group is voting, and the server
// has made the slots and their places. `plan` is the first slot (the first category of the plan) as Sam reads it.
// How to call: const { w, sam, kim, id, slot } = await voting()
export async function voting({ third = false, hostLast = false } = {}) {
  const world = await locating({ places: true, third, hostLast })
  await world.sam.api.useMeetingArea(world.id)
  const plan = await world.sam.api.getPlan(world.id)
  world.w.server.calls.length = 0
  return { ...world, plan, slot: plan.slots[0] }
}

// Stage 5. Sam hosts, Kim has joined, and both have voted in every category: Sam for each category's first place, Kim for the first of the
// first two categories and the second place of the rest, so the winners (a tie goes to the better stored score) are the first places.
// The host has not confirmed. `plan` is the Vote page's plan as Sam reads it.
// How to call: const { w, sam, kim, id, plan } = await voted()
export async function voted({ third = false, hostLast = false } = {}) {
  const world = await voting({ third, hostLast })
  const { sam, kim, id, plan } = world
  for (const [index, slot] of plan.slots.entries()) {
    await sam.api.vote(id, slot.id, sam.id, slot.options[0].id)
    await kim.api.vote(id, slot.id, kim.id, slot.options[index < 2 ? 0 : 1].id)
  }
  world.w.server.calls.length = 0
  return world
}

// The same, and the host has confirmed the plan in the voted order: the group has an itinerary. `itinerary` is Sam's read of it.
// How to call: const { w, sam, kim, id, itinerary } = await confirmed()
export async function confirmed({ third = false, hostLast = false } = {}) {
  const world = await voted({ third, hostLast })
  await world.sam.api.confirmPlan(world.id)
  world.w.server.calls.length = 0
  return { ...world, itinerary: await world.sam.api.getItinerary(world.id) }
}
