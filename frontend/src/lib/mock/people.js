// The people in the demo. Ian is the host and signs up in the app; his five friends already have the app, and so do
// a few other people he does not know yet (COMMUNITY). No other names appear anywhere in the app.

export const HOST_ID = 'ian'

// Ian's circle: the people the demo is about. They start as his friends.
const CIRCLE = [
  { id: 'ian', name: 'Ian', username: 'ian', homeAreaId: 'tiong-bahru' },
  { id: 'darius', name: 'Darius', username: 'darius', homeAreaId: 'bugis' },
  { id: 'jonathan', name: 'Jonathan', username: 'jonathan', homeAreaId: 'jurong-east' },
  { id: 'nicole', name: 'Nicole', username: 'nicole', homeAreaId: 'tampines' },
  { id: 'faith', name: 'Faith', username: 'faith', homeAreaId: 'punggol' },
  { id: 'darryl', name: 'Darryl', username: 'darryl', homeAreaId: 'bishan' },
]

// Other people on Jio, not Ian's friends to begin with. They write reviews of places, and Ian can add them as
// friends (from a review, their profile, or sign-up's suggestions). Once added they show on his leaderboard too.
export const COMMUNITY = [
  { id: 'meiling', name: 'Mei Ling', username: 'meiling', homeAreaId: 'toa-payoh' },
  { id: 'arjun', name: 'Arjun', username: 'arjun.k', homeAreaId: 'clementi' },
  { id: 'siti', name: 'Siti', username: 'siti.r', homeAreaId: 'bedok' },
  { id: 'weijie', name: 'Wei Jie', username: 'weijie', homeAreaId: 'ang-mo-kio' },
  { id: 'priya', name: 'Priya', username: 'priya', homeAreaId: 'little-india' },
  { id: 'kai', name: 'Kai', username: 'kai.tan', homeAreaId: 'serangoon' },
]
const COMMUNITY_IDS = new Set(COMMUNITY.map((p) => p.id))
export const isCommunity = (id) => COMMUNITY_IDS.has(id)

export const PEOPLE = [...CIRCLE, ...COMMUNITY]

// Successful meetups before the demo starts (the last six months). Each one earned POINTS_PER_MEETUP points.
// Ian's numbers are the demo account's only (`demo: true` on signUp); a person who signs up through the form starts at 0.
// Their dates come from lib/mock/history.js, so the profile graph matches these counts.
// The sample friends' dietary needs (ticket #107): Faith is halal and Nicole is vegetarian. They are private, as a real
// person's are: the planner filters by them, and no screen says whose they are. Everyone else has none.
export const SAMPLE_DIETARY = { faith: ['halal'], nicole: ['vegetarian'] }

export const STARTING_MEETUPS ={ ian: 10, darius: 24, nicole: 19, darryl: 12, faith: 8, jonathan: 5, meiling: 30, arjun: 16, siti: 22, weijie: 27, priya: 14, kai: 18 }
// How many of those fall in the current leaderboard season, and how many in the season before it. Everyone has
// some in both, so nobody opens the demo unranked. All different within a season, so the demo leaderboard has no
// ties (whoever Ian adds), and for the friends in the same order as the totals above, so the most active lead.
export const SEASON_MEETUPS = { ian: 4, darius: 6, nicole: 5, darryl: 3, faith: 2, jonathan: 1, meiling: 8, arjun: 7, siti: 9, weijie: 10, priya: 11, kai: 12 }
export const LAST_SEASON_MEETUPS = { ian: 4, darius: 9, nicole: 7, darryl: 5, faith: 3, jonathan: 1, meiling: 12, arjun: 8, siti: 10, weijie: 11, priya: 2, kai: 6 }
export const POINTS_PER_MEETUP = 100

// What each friend picks when the demo simulates them choosing categories and how long they can stay.
// `until` is minutes after midnight; null means the whole session.
export const FRIEND_PICKS = {
  darius: { categories: ['activity', 'eat', 'drink'], until: null },
  jonathan: { categories: ['shop', 'eat'], until: 20 * 60 },
  nicole: { categories: ['activity', 'shop', 'eat'], until: null },
  faith: { categories: ['activity', 'drink'], until: 19 * 60 },
  darryl: { categories: ['activity', 'shop', 'eat'], until: null },
}

// Past meetups that show under "Recent activity" on a friend's profile. Places only, no other people.
export const PAST_ACTIVITY = {
  darius: [
    { date: '2026-09-26', text: 'Successful meetup at Bugis' },
    { date: '2026-09-12', text: 'Successful meetup at City Hall' },
    { date: '2026-08-30', text: 'Redeemed a sample voucher' },
  ],
  jonathan: [{ date: '2026-09-19', text: 'Successful meetup at Jurong East' }],
  nicole: [
    { date: '2026-09-27', text: 'Successful meetup at Tampines' },
    { date: '2026-09-06', text: 'Successful meetup at Paya Lebar' },
  ],
  faith: [{ date: '2026-09-20', text: 'Successful meetup at Punggol' }],
  darryl: [
    { date: '2026-09-28', text: 'Successful meetup at Bishan' },
    { date: '2026-09-13', text: 'Successful meetup at Novena' },
  ],
}
