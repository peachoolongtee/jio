// Showcase data for the demo tools (development builds only): replaces the account's sessions with ten, one for each state
// a screen can show, so every feature can be looked at in one sitting instead of being made by hand.
//   const result = await loadShowcase()                                  // dates counted from this moment
//   const result = await loadShowcase({ now: new Date('2026-10-10T14:20:00+08:00'), makePhotos: stubPhotos })   // in a test
// It never writes the stored data itself. Every session is built through the public functions of lib/api.js, in the
// order a real group would (create, invite, start, share locations, use the meeting area, vote, confirm, end, add
// photos), so the data is always valid for the code as it is now, and the screens cannot tell it from the real thing.
//
// Starts with resetDemo, so running it twice gives the same ten sessions (s1 to s10), not twenty. That also puts the
// leaderboard, JioCoins, rewards and demo switches back as a new account has them; the account and friends stay.
//
// Where to meet is settled in the way a real group settles it (the meeting spots: members share starts, the app lists
// up to three areas, friends suggest their own and say which work for them, and the host confirms one or names a place):
// useMeetingArea (the host takes the spot the app lists first, nobody having voted), confirmSpot (the host takes a spot the
// group approved) and setKnownPlace ("We already have a place"). Two sessions are left in the vote itself.
//
// The planner: the meeting area, the spots and every ranking come from the backend. With it off, offlinePlanner.js answers
// in its place (and says so in `result.planner`), and with it on the real answers are used. Voting and plan screens ask the
// backend again when they open, and so do suggestions for a spot, so they need it running; Home, Sessions, a session's page
// and a confirmed itinerary do not. Marking "Works for me" needs no planner.
//
// `now` decides the dates only. The data layer's own idea of "today" is the real clock, so a test that passes a fixed `now`
// also sets the system time (vi.setSystemTime) to the same moment.
import * as api from '@/lib/api.js'
import { HOST_ID } from '@/lib/mock/people.js'
import { placeKind } from '@/lib/placeImages.js'
import { ALBUM, GUEST_SPEC, LONGEST_TITLE, LONG_SPEC, PENDING_FOR, ShowcaseError, assertAllBuilt, buildSessions, todayWindow } from '@/tour/builders.js'
import { makeDemoPhotos } from './demoPhotos.js'
import { useOfflinePlanner } from './offlinePlanner.js'

// These moved to tour/builders.js, where the demo tour uses them too. They are still exported from here.
export { LONGEST_TITLE, ShowcaseError, todayWindow }

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
    // Only the host has shared where they start. From two starts on, the spots open (see the last two sessions).
    build: async ({ id, at, share }) => {
      at('invites')
      await api.inviteFriends(id, ['darius', 'nicole', 'faith'])
      at('start')
      await api.startSession(id)
      at('locations')
      await share(id, { ian: 'bishan' })
    },
  },
  {
    key: 'voting',
    title: 'Saturday movie and makan',
    day: 2,
    start: '14:00',
    end: '21:00',
    // "We already have a place": the film is at Bugis, so the host names it before anyone has shared a start. The meeting
    // area is then chosen (method 'chosen'), not found, and the session goes straight to choosing what to do.
    build: async ({ id, at, voteFor }) => {
      at('invites')
      await api.inviteFriends(id, ['darius', 'nicole'])
      at('start')
      await api.startSession(id)
      at('known place')
      await api.setKnownPlace(id, 'bugis')
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
    // The group votes on places, then Faith's start moves to the far west. A confirmed meeting area never moves by itself (Faith's
    // walkthrough, 30 October 2026), so the host chooses it again: the spots are worked out again from everyone's starts, the votes for
    // places are cleared, and the host confirms the new fairest spot. The group is voting again, on new places.
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
      at('location change')
      await api.setLocation(id, 'faith', 'start', { areaId: 'boon-lay' })
      at('meeting area again')
      await api.changeMeetingPlace(id, { meetBy: 'fairest' })
      await api.useMeetingArea(id)
      if ((await session(id)).status !== 'voting') throw new Error('choosing the meeting area again did not go back to voting')
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
    // Both say the app's first spot works for them and the host confirms it (confirmSpot, method 'voted'). It is the same area
    // useMeetingArea would take, so it stays next to the one the session on today meets in.
    build: async ({ id, at, share, voteFor, spots, approve }) => {
      at('invites')
      await api.inviteFriends(id, ['nicole'])
      at('start')
      await api.startSession(id)
      at('locations')
      await share(id, { ian: 'dhoby-ghaut', nicole: 'little-india' })
      at('spots')
      const [first] = await spots(id)
      await approve(id, { ian: [first], nicole: [first] })
      at('meeting area')
      await api.confirmSpot(id, first.areaId)
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
      // Ian starts far east, so he travelled more than his share: the Locate steps of the two spot votes below count it for him, and the first spot says "This spot is closer to you." to him where it is closer to him than the group's
      // average (the long session's, not the guest's). His debt from this outing is over the 5 minutes the line needs (lib/travelLean.js).
      await share(id, { ian: 'tampines', darius: 'tiong-bahru', nicole: 'novena', faith: 'buona-vista' })
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
  LONG_SPEC,
  GUEST_SPEC,
]

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
    const built = await buildSessions(SPECS, { now, makePhotos, onProgress })
    const { made } = built

    // One voucher redeemed, if the account has the JioCoins for it, so Rewards has a history.
    const redeemed = await api.redeemReward('r-nylon').then(() => true, () => false)

    const sessions = (await api.listSessions()).filter((s) => made.some((e) => e.id === s.id)).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    const result = {
      sessions: sessions.map((s) => ({ id: s.id, title: s.title, status: s.status })),
      planner: offline.source || 'none',
      photos: sessions.reduce((sum, s) => sum + s.photoCount, 0),
      redeemed,
    }
    assertAllBuilt(built, 'sessions')
    return result
  } finally {
    offline.restore()
  }
}
