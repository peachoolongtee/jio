// The six people in the demo. No other names appear anywhere in the app.
// Ian is the host and signs up in the app; the five friends already have the app.

export const HOST_ID = 'ian'

export const PEOPLE = [
  { id: 'ian', name: 'Ian', username: 'ian', homeAreaId: 'tiong-bahru' },
  { id: 'darius', name: 'Darius', username: 'darius', homeAreaId: 'bugis' },
  { id: 'jonathan', name: 'Jonathan', username: 'jonathan', homeAreaId: 'jurong-east' },
  { id: 'nicole', name: 'Nicole', username: 'nicole', homeAreaId: 'tampines' },
  { id: 'faith', name: 'Faith', username: 'faith', homeAreaId: 'punggol' },
  { id: 'darryl', name: 'Darryl', username: 'darryl', homeAreaId: 'bishan' },
]

// Successful meetups before the demo starts. Each one earned POINTS_PER_MEETUP points.
export const STARTING_MEETUPS = { ian: 0, darius: 6, nicole: 5, darryl: 3, faith: 2, jonathan: 1 }
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
    { date: '2026-08-30', text: 'Redeemed a voucher at Tiong Bahru Bakery' },
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
