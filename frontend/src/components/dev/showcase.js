// Showcase data for the demo tools (development builds only): replaces the account's sessions with ten, one for each state
// a screen can show, so every feature can be looked at in one sitting instead of being made by hand.
//   const result = await loadShowcase()                                  // dates counted from this moment
//   const result = await loadShowcase({ now: new Date('2026-10-10T14:20:00'), makePhotos: stubPhotos })   // in a test
// It never writes the stored data itself. Every session is built through the public functions of lib/api.js, in the
// order a real group would (create, invite, start, share locations, use the meeting area, vote, confirm, end, add
// photos), so the data is always valid for the code as it is now, and the screens cannot tell it from the real thing.
//
// Starts with resetDemo, so running it twice gives the same ten sessions (s1 to s10), not twenty. That also puts the
// leaderboard, JioCoins, rewards and demo switches back as a new account has them; the account and friends stay.
//
// The planner: the meeting area and every ranking come from the backend. With it off, offlinePlanner.js answers in its
// place (and says so in `result.planner`), and with it on the real answers are used. Voting and plan screens ask the
// backend again when they open, so they need it running; Home, Sessions, a session's page and a confirmed itinerary do not.
//
// `now` decides the dates only. The data layer's own idea of "today" is the real clock, so a test that passes a fixed `now`
// also sets the system time (vi.setSystemTime) to the same moment.
import { addDays, format } from 'date-fns'
import * as api from '@/lib/api.js'
import { HOST_ID } from '@/lib/mock/people.js'
import { placeKind } from '@/lib/placeImages.js'
import { makeDemoPhotos } from './demoPhotos.js'
import { useOfflinePlanner } from './offlinePlanner.js'

const DAY = 24 * 60 * 60 * 1000
// How long an invite the showcase leaves pending stays pending. A read after this accepts it, as in the demo.
const PENDING_FOR = 7 * DAY
// Photos in the completed session's album (a session holds up to api.PHOTOS_MAX).
const ALBUM = 8
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

// The ten sessions, in the order they are made (so s1 to s10). `day` is days from now; build() does what a group does
// after the session is made. `at('voting')` names the step it is on, for the message if it stops there.
const SPECS = [
  {
    key: 'fresh',
    title: 'Weekend brunch',
    day: 14,
    build: async () => {},
  },
  {
    key: 'invited',
    title: 'Birthday dinner for Nicole',
    day: 10,
    start: '18:30',
    end: '22:00',
    build: async ({ id, at }) => {
      at('invites')
      await api.inviteFriends(id, ['darius', 'nicole'])
      await api.inviteFriends(id, ['faith', 'darryl'], { pending: true, acceptAfter: PENDING_FOR })
    },
  },
  {
    key: 'waiting',
    title: 'Hawker lunch near the office',
    day: 5,
    start: '11:30',
    end: '15:00',
    build: async ({ id, at, share }) => {
      at('invites')
      await api.inviteFriends(id, ['darius', 'nicole', 'faith'])
      at('start')
      await api.startSession(id)
      at('locations')
      await share(id, { ian: 'bishan', darius: 'bugis' })
    },
  },
  {
    key: 'voting',
    title: 'Saturday movie and makan',
    day: 2,
    start: '14:00',
    end: '21:00',
    build: async ({ id, at, share, voteFor }) => {
      at('invites')
      await api.inviteFriends(id, ['darius', 'nicole'])
      at('start')
      await api.startSession(id)
      at('locations')
      await share(id, { ian: 'bishan', darius: 'bugis', nicole: 'tampines' })
      at('meeting area')
      await api.useMeetingArea(id)
      at('preferences')
      await api.setPreferences(id, 'ian', { categories: ['eat', 'activity'], until: null })
      await api.setPreferences(id, 'darius', { categories: ['eat', 'activity', 'drink'], until: null })
      await api.setPreferences(id, 'nicole', { categories: ['eat', 'shop'], until: null })
      at('votes')
      await voteFor(id, 'darius', { eat: 0, activity: 1 })
      await voteFor(id, 'nicole', { eat: 1, shop: 0 })
    },
  },
  {
    key: 'revoted',
    title: 'Sunday kopi and a long walk',
    day: 4,
    start: '10:00',
    end: '17:00',
    build: async ({ id, at, share, voteFor, session }) => {
      at('invites')
      await api.inviteFriends(id, ['darius', 'nicole', 'faith', 'jonathan'])
      at('start')
      await api.startSession(id)
      at('locations')
      await share(id, { ian: 'toa-payoh', darius: 'bugis', nicole: 'tampines', faith: 'punggol', jonathan: 'jurong-east' })
      at('meeting area')
      await api.useMeetingArea(id)
      at('votes')
      await voteFor(id, 'darius', { eat: 0, activity: 0 })
      await voteFor(id, 'nicole', { eat: 1 })
      await voteFor(id, 'faith', { activity: 1 })
      at('opt-out')
      await api.optOut(id, 'jonathan')
      // The opt-out may have moved the area and cleared the votes. Votes have to be there for the next move to clear them.
      if (!hasVotes(await session(id))) {
        at('votes')
        await voteFor(id, 'darius', { eat: 0 })
        await voteFor(id, 'nicole', { activity: 0 })
      }
      // Faith's start moves to the far west, which moves the meeting area and clears the votes for places, and the banner says so.
      // The first place that moves it is used, as the planner decides what moves.
      at('location change')
      for (const areaId of ['boon-lay', 'jurong-east', 'tuas-link', 'woodlands', 'harbourfront']) {
        await api.setLocation(id, 'faith', 'start', { areaId })
        if ((await session(id)).banner?.votesCleared) break
        if (!hasVotes(await session(id))) await voteFor(id, 'darius', { eat: 0 })
      }
      if (!(await session(id)).banner?.votesCleared) throw new Error('moving a start did not move the meeting area')
      at('votes')
      await voteFor(id, 'ian', { eat: 0, activity: 1 })
    },
  },
  {
    key: 'today',
    title: 'Chinatown makan crawl',
    day: 0,
    window: true,
    build: async ({ id, at, share, voteFor }) => {
      at('invites')
      await api.inviteFriends(id, ['darius', 'faith'])
      at('start')
      await api.startSession(id)
      at('locations')
      await share(id, { ian: 'bugis', darius: 'city-hall', faith: 'dhoby-ghaut' })
      at('meeting area')
      await api.useMeetingArea(id)
      at('votes')
      for (const who of ['ian', 'darius', 'faith']) await voteFor(id, who, { eat: 0, drink: 0, activity: 0 })
      at('confirm')
      await api.confirmPlan(id)
    },
  },
  {
    key: 'ahead',
    title: 'Dessert run after the gym',
    day: 3,
    start: '19:00',
    end: '22:00',
    build: async ({ id, at, share, voteFor }) => {
      at('invites')
      await api.inviteFriends(id, ['nicole'])
      at('start')
      await api.startSession(id)
      at('locations')
      await share(id, { ian: 'dhoby-ghaut', nicole: 'little-india' })
      at('meeting area')
      await api.useMeetingArea(id)
      at('votes')
      for (const who of ['ian', 'nicole']) await voteFor(id, who, { eat: 0, activity: 1 })
      at('confirm')
      await api.confirmPlan(id)
    },
  },
  {
    key: 'completed',
    title: 'Orchard Road wander and dinner',
    day: -7,
    start: '15:00',
    end: '21:30',
    build: async ({ id, at, share, voteFor, makePhotos }) => {
      at('invites')
      await api.inviteFriends(id, ['darius', 'nicole', 'faith'])
      at('start')
      await api.startSession(id)
      at('locations')
      await share(id, { ian: 'orchard', darius: 'tiong-bahru', nicole: 'novena', faith: 'buona-vista' })
      at('meeting area')
      await api.useMeetingArea(id)
      at('votes')
      for (const who of ['ian', 'darius', 'nicole', 'faith']) await voteFor(id, who, { eat: 0, shop: 0, drink: 1 })
      at('confirm')
      await api.confirmPlan(id)
      at('ending')
      await api.endPlan(id)
      at('photos')
      const stops = (await api.getItinerary(id))?.stops || []
      const pictures = await makePhotos(stops.map((stop) => placeKind(stop.venue)), ALBUM, `${id}-0`)
      const people = [HOST_ID, 'darius', 'nicole', 'faith']
      for (const [i, src] of pictures.entries()) await api.addPhoto(id, people[i % people.length], src)
    },
  },
  {
    key: 'long',
    title: LONGEST_TITLE,
    day: 6,
    start: '12:00',
    end: '17:00',
    // Everyone has shared where they start, so it has a meeting point and a pin, and waits for the host to confirm it.
    build: async ({ id, at, share }) => {
      at('invites')
      await api.inviteFriends(id, ['darius', 'faith'])
      at('start')
      await api.startSession(id)
      at('locations')
      await share(id, { ian: 'toa-payoh', darius: 'bishan', faith: 'novena' })
    },
  },
  {
    key: 'guest',
    title: "Darius's board game night",
    day: 8,
    start: '19:00',
    end: '23:00',
    hostId: 'darius',
    // Darius hosts and Ian is a guest who has not yet said where he starts.
    build: async ({ id, at, share }) => {
      at('invites')
      await api.inviteFriends(id, ['faith', 'nicole'])
      at('start')
      await api.startSession(id)
      at('locations')
      await share(id, { darius: 'serangoon', faith: 'kovan' })
    },
  },
]

// Does a session summary hold any vote for a place? How to call: hasVotes(summary) -> true
const hasVotes = (session) => Object.values(session.votes || {}).some((byPerson) => Object.keys(byPerson).length > 0)

// The helpers a session's build() gets, bound to the session being made.
// How to call: toolsFor((step) => (current = step), makePhotos)
function toolsFor(at, makePhotos) {
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
  return { at, share, session, voteFor, makePhotos }
}

// Fill the account with the showcase, and answer what was made.
//   now          the moment dates are counted from (a Date); the default is now
//   makePhotos   (kinds, count, seed) -> data URLs; a test passes a stub because there is no canvas outside a browser
//   onProgress   ({ done, total }) after each session is finished, for a busy message
// Answers { sessions: [{ id, title, status }], planner: 'backend' | 'stand-in' | 'both' (the backend went away part way), photos, redeemed }.
// Throws a ShowcaseError, after doing what it can, when a session could not be finished; the message says which.
// How to call: const { sessions } = await loadShowcase({ onProgress: ({ done, total }) => (note.value = `${done} of ${total}`) })
export async function loadShowcase({ now = new Date(), makePhotos = makeDemoPhotos, onProgress = () => {} } = {}) {
  if (!(await api.getUser())) throw new Error('Sign in first: the showcase fills the signed-in account.')
  const offline = useOfflinePlanner(api.api)
  try {
    // From here the account's sessions, points and switches are replaced.
    await api.resetDemo()
    const total = SPECS.length
    const made = []
    // Made one after another, so s1 to s10 are always the same sessions; then built side by side, as they do not depend on each other.
    for (const spec of SPECS) {
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

    // One voucher redeemed, if the account has the JioCoins for it, so Rewards has a history.
    const redeemed = await api.redeemReward('r-nylon').then(() => true, () => false)

    const failed = made.filter((e) => e.error).map((e) => ({ title: e.spec.title, id: e.id, step: e.step, message: e.error.message }))
    const sessions = (await api.listSessions()).filter((s) => made.some((e) => e.id === s.id)).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    const result = {
      sessions: sessions.map((s) => ({ id: s.id, title: s.title, status: s.status })),
      planner: offline.source || 'none',
      photos: sessions.reduce((sum, s) => sum + s.photoCount, 0),
      redeemed,
    }
    if (failed.length) {
      const loaded = made.filter((e) => !e.error).map((e) => e.spec.title)
      const stopped = failed.map((f) => `"${f.title}" ${f.id ? `stopped at ${f.step}` : 'was not created'} (${f.message})`).join('; ')
      throw new ShowcaseError(`Loaded ${loaded.length} of ${total} sessions. Not finished: ${stopped}. The rest were left as they were.`, { loaded, failed })
    }
    return result
  } finally {
    offline.restore()
  }
}
