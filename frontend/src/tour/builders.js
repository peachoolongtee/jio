// The pieces the development showcase (components/dev/showcase.js) and the demo tour (tour/load.js) both build sessions
// with. Nothing here writes the stored data itself: every session is made through the public functions of lib/api.js, in
// the order a real group would (create, invite, start, share locations, settle the spot, vote, confirm, end, add photos),
// so the data is always valid for the code as it is now and the screens cannot tell it from the real thing.
//
// A "spec" describes one session: { key, title, day (days from now), start, end, window (true: the times of a session that is
// on today), hostId, build }. build() does what a group does after the session is made; `at('voting')` names the step it is on,
// for the message if it stops there.
//   const { made, failed } = await buildSessions(SPECS, { now, makePhotos, onProgress })
import { addDays, format } from 'date-fns'
import * as api from '@/lib/api.js'

export const DAY = 24 * 60 * 60 * 1000
// How long an invite a spec leaves pending stays pending. A read after this accepts it, as in the demo.
export const PENDING_FOR = 7 * DAY
// Photos in a finished session's album (a session holds up to api.PHOTOS_MAX).
export const ALBUM = 8
// A title can be at most 60 characters in the app (the create form and updateSession), so 60 is the longest a person can reach.
export const LONGEST_TITLE = 'Long overdue catch-up lunch, then kopi after the Sunday hike'

const pad = (n) => String(n).padStart(2, '0')
const clock = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`

// The times of a session that is on today: it started half an hour ago (to the quarter hour) and runs six hours, so "Live
// now" shows between 07:30 and 17:30, and "Starts in" or "Ended" outside that. Never past 23:45, never before 07:00.
// How to call: todayWindow(new Date('2026-10-10T14:20:00')) -> { start: '13:45', end: '19:45' }
export function todayWindow(now) {
  const minutes = now.getHours() * 60 + now.getMinutes()
  const start = Math.min(Math.max(Math.floor((minutes - 30) / 15) * 15, 7 * 60), 17 * 60)
  return { start: clock(start), end: clock(Math.min(start + 6 * 60, 23 * 60 + 45)) }
}

// What went wrong part way: the message says what was loaded and what was not, and the lists are there for code.
// How to call: throw new ShowcaseError('Loaded 7 of 10 sessions...', { loaded: [...], failed: [...] })
export class ShowcaseError extends Error {
  constructor(message, { loaded = [], failed = [] } = {}) {
    super(message)
    this.name = 'ShowcaseError'
    this.loaded = loaded
    this.failed = failed
  }
}

// Does a session summary hold any vote for a place? How to call: hasVotes(summary) -> true
export const hasVotes = (session) => Object.values(session.votes || {}).some((byPerson) => Object.keys(byPerson).length > 0)

// The helpers a session's build() gets, bound to the session being made.
// How to call: toolsFor((step) => (current = step), makePhotos)
export function toolsFor(at, makePhotos) {
  // Everyone's start area, in turn. The meeting area appears when the last one arrives.
  // How to call: await share('s3', { ian: 'bishan', darius: 'bugis' })
  const share = async (id, starts) => {
    for (const [who, areaId] of Object.entries(starts)) await api.setLocation(id, who, 'start', { areaId })
  }
  const session = (id) => api.getSession(id)
  // One person's votes, as how far down each category's options they pick (0 is the first). A category with no options is skipped.
  // How to call: await voteFor('s4', 'darius', { eat: 0, activity: 1 })
  const voteFor = async (id, who, picks) => {
    const { options } = await api.getSession(id)
    for (const [slotId, index] of Object.entries(picks)) {
      const list = options[slotId] || []
      if (list.length) await api.vote(id, slotId, who, list[Math.min(index, list.length - 1)])
    }
  }
  // The spots listed for the session, in the order the app shows them (the app's three, then members' suggestions).
  // How to call: const [first, second] = await spots('s9')
  const spots = async (id) => (await api.getSession(id)).spots.list
  // A friend suggests a spot: the first area of `prefer` that is not listed yet (an area that is listed is the app's own, or
  // someone else's, and cannot be shown as the friend's). `here` marks "we are here already".
  // How to call: await suggest('s9', 'nicole', ['serangoon', 'kovan'], { here: true })
  const suggest = async (id, who, prefer, { here = false } = {}) => {
    const listed = new Set((await spots(id)).map((spot) => spot.areaId))
    const areaId = prefer.find((candidate) => !listed.has(candidate))
    if (!areaId) throw new Error('every area a friend could suggest is already listed')
    await api.suggestSpot(id, who, areaId, { here })
  }
  // Who says which spots work for them: the spots are entries of the list from spots().
  // How to call: await approve('s9', { darius: [list[1], list[0]], faith: [list[1]] })
  const approve = async (id, byPerson) => {
    for (const [who, chosen] of Object.entries(byPerson)) for (const spot of chosen) await api.approveSpot(id, who, spot.areaId, true)
  }
  return { at, share, session, voteFor, makePhotos, spots, suggest, approve }
}

// Two sessions the showcase and the tour both show: the spot vote with the user as host (and the longest title the app
// allows), and the spot vote with a friend as host.
export const LONG_SPEC = {
  key: 'long',
  title: LONGEST_TITLE,
  day: 6,
  start: '12:00',
  end: '17:00',
  // The spot vote, with the user as host: four starts, so the app lists three spots; Nicole suggests the area she is in
  // ("we are here already"); Darius, Faith and Nicole say which work for them, and the app's second spot leads. The host
  // has not confirmed (Home: "Confirm the spot").
  build: async ({ id, at, share, spots, suggest, approve }) => {
    at('invites')
    await api.inviteFriends(id, ['darius', 'faith', 'nicole'])
    at('start')
    await api.startSession(id)
    at('locations')
    await share(id, { ian: 'toa-payoh', darius: 'bishan', faith: 'novena', nicole: 'serangoon' })
    at('suggestion')
    await suggest(id, 'nicole', ['serangoon', 'kovan', 'tampines', 'paya-lebar'], { here: true })
    at('approvals')
    const list = await spots(id)
    await approve(id, { darius: [list[1], list[0]], faith: [list[1]], nicole: [list[1], list.at(-1)] })
  },
}

export const GUEST_SPEC = {
  key: 'guest',
  title: "Darius's board game night",
  day: 8,
  start: '19:00',
  end: '23:00',
  hostId: 'darius',
  // The spot vote, with a friend as host: Ian has shared where he starts and has marked nothing (Home: "Pick your spots").
  // Nicole suggests a spot, and the others say which work for them, so the first spot leads.
  build: async ({ id, at, share, spots, suggest, approve }) => {
    at('invites')
    await api.inviteFriends(id, ['faith', 'nicole'])
    at('start')
    await api.startSession(id)
    at('locations')
    await share(id, { darius: 'serangoon', faith: 'kovan', nicole: 'paya-lebar', ian: 'bishan' })
    at('suggestion')
    await suggest(id, 'nicole', ['tampines', 'bedok', 'pasir-ris'])
    at('approvals')
    const list = await spots(id)
    await approve(id, { darius: [list[0]], faith: [list[0]], nicole: [list[0], list[2]] })
  },
}

// Make every spec's session, then build them all. They are created one after another, so the ids (s1, s2...) always
// follow the order of `specs`, then built side by side, as they do not depend on each other. A session that fails stops
// where it was; the others carry on.
//   now          the moment dates are counted from (a Date)
//   makePhotos   (kinds, count, seed) -> data URLs
//   onProgress   ({ done, total }) after each session is finished
// Answers { made: [{ spec, id, step, error }], failed: [{ title, id, step, message }] }.
// How to call: const { made, failed } = await buildSessions(SPECS, { now: new Date(), makePhotos, onProgress })
export async function buildSessions(specs, { now, makePhotos, onProgress = () => {} }) {
  const total = specs.length
  const made = []
  for (const spec of specs) {
    const entry = { spec, id: '', step: 'create', error: null }
    made.push(entry)
    try {
      const day = format(addDays(now, spec.day), 'yyyy-MM-dd')
      const { start = '12:00', end = '20:00' } = spec.window ? todayWindow(now) : spec
      entry.id = (await api.createSession({ title: spec.title, date: day, start, end, hostId: spec.hostId })).id
    } catch (error) {
      entry.error = error
    }
  }
  let done = made.filter((e) => e.error).length
  await Promise.all(
    made
      .filter((e) => e.id)
      .map(async (entry) => {
        try {
          await entry.spec.build({ id: entry.id, ...toolsFor((step) => (entry.step = step), makePhotos) })
          entry.step = 'done'
        } catch (error) {
          entry.error = error
        }
        onProgress({ done: ++done, total })
      }),
  )
  const failed = made.filter((e) => e.error).map((e) => ({ title: e.spec.title, id: e.id, step: e.step, message: e.error.message }))
  return { made, failed }
}

// Throw a ShowcaseError for sessions that did not finish, or return nothing when all did.
// How to call: assertAllBuilt({ made, failed }, 'sessions')
export function assertAllBuilt({ made, failed }, noun = 'sessions') {
  if (!failed.length) return
  const loaded = made.filter((e) => !e.error).map((e) => e.spec.title)
  const stopped = failed.map((f) => `"${f.title}" ${f.id ? `stopped at ${f.step}` : 'was not created'} (${f.message})`).join('; ')
  throw new ShowcaseError(`Loaded ${loaded.length} of ${made.length} ${noun}. Not finished: ${stopped}. The rest were left as they were.`, { loaded, failed })
}
