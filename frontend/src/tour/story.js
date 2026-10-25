// The demo tour's data: one outing, told in eight checkpoints, and a few side cases outside the story.
//
// The story is one outing with the same title and the same four people (Ian hosts, with Darius, Nicole and Faith), saved
// ten times as a real group would have it at that moment (the two Start choice checkpoints are the two ways the same outing could go). Each save is its own session in the data layer, built through its
// public functions (tour/builders.js), so every one is a state a real group could reach and the screens treat it like any
// other session.
//
// Dates. The first eight checkpoints are some days before the outing, and the last two are the day itself, so "On the day" is
// today and shows a live plan. All ten use the times of a session that is on today (todayWindow), so the time line reads
// the same at every checkpoint.
//
// The side cases are sessions that are not part of the story: one a friend hosts, one where a friend opted out, and one with
// the longest title the app allows. A redeemed reward (a Rewards history entry) is made by tour/load.js.
//   CHECKPOINTS[3].spec   the session spec for "Choosing the spot"
//   pathFor(CHECKPOINTS[3], 's4') -> '/sessions/s4'
import * as api from '@/lib/api.js'
import { placeKind } from '@/lib/placeImages.js'
import { HOST_ID } from '@/lib/mock/people.js'
import { ALBUM, GUEST_SPEC, LONG_SPEC, PENDING_FOR } from './builders.js'

export const STORY_TITLE = 'Catch-up makan with the gang'
// Days before the outing for the first eight checkpoints. The last two are on the day (0).
const BEFORE = 3
// Where each person starts from, spread across the island so the fair spot is somewhere in the middle.
const STARTS = { ian: 'toa-payoh', darius: 'tampines', nicole: 'jurong-east', faith: 'bugis' }
// What each person votes for: how far down each category's list they pick (0 is the first).
const VOTES = {
  darius: { eat: 0, drink: 0, activity: 0 },
  nicole: { eat: 0, drink: 1, activity: 0 },
  faith: { eat: 1, drink: 0, activity: 0 },
  ian: { eat: 0, drink: 0, activity: 0 },
}

// The things a group does, in the order they do them. Each takes what a spec's build() gets.
const steps = {
  // Darius and Nicole said yes; Faith has not answered yet.
  invitesOut: async ({ id, at }) => {
    at('invites')
    await api.inviteFriends(id, ['darius', 'nicole'])
    await api.inviteFriends(id, ['faith'], { pending: true, acceptAfter: PENDING_FOR })
  },
  // Everyone said yes and the host started the session, choosing to find the fairest spot (the default of the Start choice).
  start: async ({ id, at }) => {
    at('invites')
    await api.inviteFriends(id, ['darius', 'nicole', 'faith'])
    at('start')
    await api.startSession(id, { meetBy: 'fairest' })
  },
  // Everyone said yes. The host has not pressed Start session yet: the next page is the Start choice.
  allIn: async ({ id, at }) => {
    at('invites')
    await api.inviteFriends(id, ['darius', 'nicole', 'faith'])
  },
  // Everyone said yes, and the host started the session with "We already know where" and named Bishan: the group goes straight
  // to choosing places, with no location step.
  knownPlace: async ({ id, at }) => {
    at('invites')
    await api.inviteFriends(id, ['darius', 'nicole', 'faith'])
    at('start')
    await api.startSession(id, { meetBy: 'known' })
    at('known place')
    await api.setKnownPlace(id, 'bishan')
  },
  // Ian has shared where he starts. The other three have not.
  hostShares: async ({ id, at, share }) => {
    at('locations')
    await share(id, { ian: STARTS.ian })
  },
  // The other three share, so the app lists spots; Nicole suggests one; Darius, Faith and Nicole say which work, and the app's
  // second spot leads. The host has not confirmed.
  chooseSpot: async ({ id, at, share, spots, suggest, approve }) => {
    at('locations')
    await share(id, { darius: STARTS.darius, nicole: STARTS.nicole, faith: STARTS.faith })
    at('suggestion')
    await suggest(id, 'nicole', ['paya-lebar', 'dhoby-ghaut', 'city-hall', 'novena'])
    at('approvals')
    const list = await spots(id)
    await approve(id, { darius: [list[1]], faith: [list[1], list[0]], nicole: [list[1], list.at(-1)] })
  },
  // The host takes the spot that leads. The session moves to voting.
  confirmSpot: async ({ id, at, session }) => {
    at('meeting area')
    const { spots } = await session(id)
    await api.confirmSpot(id, spots.preselectedAreaId || spots.list[0].areaId)
  },
  // Three of the four have voted. Ian has not.
  friendsVote: async ({ id, at, voteFor }) => {
    at('votes')
    for (const who of ['darius', 'nicole', 'faith']) await voteFor(id, who, VOTES[who])
  },
  // Ian votes and confirms the plan.
  confirmPlan: async ({ id, at, voteFor }) => {
    at('votes')
    await voteFor(id, 'ian', VOTES.ian)
    at('confirm')
    await api.confirmPlan(id)
  },
  // The plan is over, and everyone adds photos.
  finish: async ({ id, at, makePhotos }) => {
    at('ending')
    await api.endPlan(id)
    at('photos')
    const stops = (await api.getItinerary(id))?.stops || []
    const pictures = await makePhotos(stops.map((stop) => placeKind(stop.venue)), ALBUM, `${id}-0`)
    const people = [HOST_ID, 'darius', 'nicole', 'faith']
    for (const [i, src] of pictures.entries()) await api.addPhoto(id, people[i % people.length], src)
  },
}

// Run some steps one after another.
// How to call: sequence(steps.start, steps.hostShares)
const sequence = (...list) => async (ctx) => {
  for (const step of list) await step(ctx)
}

// The page each checkpoint opens: the one that shows that state best.
const page = {
  lobby: (id) => `/sessions/${id}`,
  start: (id) => `/sessions/${id}/start`,
  invite: (id) => `/sessions/${id}/invite`,
  vote: (id) => `/sessions/${id}/plan`,
  itinerary: (id) => `/sessions/${id}/itinerary`,
  photos: (id) => `/sessions/${id}/photos`,
}

// The ten checkpoints, in order. name: what the strip calls it. look: one line for the strip about what to look at. path:
// the page it opens for the session with this id.
export const CHECKPOINTS = [
  {
    key: 'created',
    name: 'Just created',
    look: 'Ian has made the session and no one is in it yet. Look for Invite friends.',
    path: page.lobby,
    spec: { day: BEFORE, build: async () => {} },
  },
  {
    key: 'invites',
    name: 'Invites out',
    look: 'Darius and Nicole said yes. Faith has not answered yet.',
    path: page.invite,
    spec: { day: BEFORE, build: steps.invitesOut },
  },
  {
    key: 'how',
    name: 'Choosing how to meet',
    look: 'Everyone said yes. Ian picks how the group chooses the meeting point: the fairest spot, or a place they know.',
    path: page.start,
    spec: { day: BEFORE, build: steps.allIn },
  },
  {
    key: 'known',
    name: 'A place already known',
    look: 'The other choice: Ian said "We already know where" and named Bishan. The group goes straight to choosing places.',
    path: page.vote,
    spec: { day: BEFORE, build: steps.knownPlace },
  },
  {
    key: 'locations',
    name: 'Sharing locations',
    look: 'Ian has shared where he starts. Darius, Nicole and Faith have not yet.',
    path: page.lobby,
    spec: { day: BEFORE, build: sequence(steps.start, steps.hostShares) },
  },
  {
    key: 'spot',
    name: 'Choosing the spot',
    look: 'Everyone has shared. Nicole added a spot, and friends say which spots work.',
    path: page.lobby,
    spec: { day: BEFORE, build: sequence(steps.start, steps.hostShares, steps.chooseSpot) },
  },
  {
    key: 'voting',
    name: 'Voting on places',
    look: 'The spot is set. Darius, Nicole and Faith have voted. Ian has not.',
    path: page.vote,
    spec: { day: BEFORE, build: sequence(steps.start, steps.hostShares, steps.chooseSpot, steps.confirmSpot, steps.friendsVote) },
  },
  {
    key: 'confirmed',
    name: 'Plan confirmed',
    look: 'Everyone voted and Ian confirmed. See the stops and the travel between them.',
    path: page.itinerary,
    spec: { day: BEFORE, build: sequence(steps.start, steps.hostShares, steps.chooseSpot, steps.confirmSpot, steps.friendsVote, steps.confirmPlan) },
  },
  {
    key: 'today',
    name: 'On the day',
    look: 'The outing is today. The itinerary shows what is on now and what is next.',
    path: page.itinerary,
    spec: { day: 0, build: sequence(steps.start, steps.hostShares, steps.chooseSpot, steps.confirmSpot, steps.friendsVote, steps.confirmPlan) },
  },
  {
    key: 'finished',
    name: 'Finished with photos',
    look: 'The outing is over and the group added photos. Ian earned JioCoins for it.',
    path: page.photos,
    spec: { day: 0, build: sequence(steps.start, steps.hostShares, steps.chooseSpot, steps.confirmSpot, steps.friendsVote, steps.confirmPlan, steps.finish) },
  },
]

// The session specs of the story, in checkpoint order: one title, one set of people, the same times.
export const STORY_SPECS = CHECKPOINTS.map(({ key, spec }) => ({ key, title: STORY_TITLE, window: true, ...spec }))

// A friend opted out: the host carried on without Jonathan, who had not shared where he starts. The spots are listed for the
// three left.
const OPTED_OUT_SPEC = {
  key: 'opted-out',
  title: 'Kopi catch-up with the office gang',
  day: 5,
  start: '10:00',
  end: '13:00',
  build: async ({ id, at, share, spots, suggest, approve }) => {
    at('invites')
    await api.inviteFriends(id, ['darius', 'nicole', 'jonathan'])
    at('start')
    await api.startSession(id, { meetBy: 'fairest' })
    at('locations')
    await share(id, { ian: 'toa-payoh', darius: 'bishan' })
    at('opt-out')
    await api.optOut(id, 'jonathan')
    await share(id, { nicole: 'novena' })
    at('approvals')
    const list = await spots(id)
    await approve(id, { darius: [list[0]], nicole: [list[0], list[1]] })
  },
}

// What sits outside the story. A reference to a spec in builders.js is the same session the development showcase makes.
export const SIDE_SPECS = [GUEST_SPEC, OPTED_OUT_SPEC, LONG_SPEC]

// The explanations the strip and the tests use for the side cases.
export const SIDE_CASES = [
  { key: 'guest', note: 'A friend hosts' },
  { key: 'opted-out', note: 'A friend opted out' },
  { key: 'long', note: 'The longest title' },
]
