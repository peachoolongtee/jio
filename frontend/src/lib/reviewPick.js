// Which sample review a place shows on its card, and in what order the detail lists them. The most useful review when a
// group is choosing is one from someone they know, so people in this outing come first, then friends, then everyone else.
// Pure functions of the reviews and of who is who; no screen is involved.
//   const ctx = { outing: ['faith', 'darius'], friends: ['faith', 'nicole'], self: 'ian' }
//   cardLine(venue, ctx)  ->  { count: 4, review: { name: 'Faith', text: '...', ... } }
import { HOST_ID } from './mock/people.js'
import { reviewsFor } from './mock/reviews.js'

// How far to the front a review sits: 0 for someone in this outing, 1 for a friend, 2 for anyone else.
// `outing` and `friends` are lists of person ids.
// How to call: reviewRank({ personId: 'faith' }, { outing: ['faith'], friends: [] }) -> 0
export function reviewRank(review, { outing = [], friends = [] } = {}) {
  if (outing.includes(review.personId)) return 0
  return friends.includes(review.personId) ? 1 : 2
}

// The reviews in the order the detail lists them: people in this outing, then friends, then others. The order inside each
// group is the order given (newest first), and the list passed in is not changed.
// How to call: orderReviews(reviews, { outing: ['faith'], friends: ['nicole'] })
export function orderReviews(reviews, ctx = {}) {
  return reviews
    .map((review, index) => ({ review, index, rank: reviewRank(review, ctx) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.review)
}

// The one review a card shows: the first by someone in this outing, else the first by a friend, else none. Your own review
// is never chosen, and a stranger's never is (the card says how many there are instead).
// How to call: pickReview(reviews, { outing: ['faith'], friends: ['nicole'], self: 'ian' })
export function pickReview(reviews, ctx = {}) {
  const self = ctx.self ?? HOST_ID
  const first = orderReviews(reviews.filter((r) => r.personId !== self), ctx)[0]
  return first && reviewRank(first, ctx) < 2 ? first : null
}

// What a card's review line says for a place: how many sample reviews it has and the one to quote, if any.
// How to call: cardLine(option.venue, { outing: ['faith'], friends: ['nicole'] }) -> { count: 4, review: null }
export function cardLine(venue, ctx = {}) {
  const reviews = reviewsFor(venue)
  return { count: reviews.length, review: pickReview(reviews, ctx) }
}

// The start of a text for a screen reader: up to `max` characters, cut at a word, with an ellipsis when something was cut.
// How to call: snippet('Cheap and filling. Get there before the lunch crowd.', 24) -> 'Cheap and filling…'
export function snippet(text, max = 60) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max + 1)
  const at = cut.lastIndexOf(' ')
  const words = (at > 0 ? cut.slice(0, at) : clean.slice(0, max)).replace(/[\s.,;:!?-]+$/, '')
  return `${words}…`
}

// The words a card's review line is named by for a screen reader.
// How to call: reviewLabel('Maxwell Food Centre', { count: 4, review: null }) -> 'Reviews of Maxwell Food Centre. 4 sample reviews'
export function reviewLabel(placeName, { count, review }) {
  if (!review) return `Reviews of ${placeName}. ${count} sample ${count === 1 ? 'review' : 'reviews'}`
  return `Reviews of ${placeName}. ${review.name}, sample review: ${snippet(review.text)}`
}

// The place the detail opens for a suggestion: what the option already carries, with its distance from the meeting area
// in km (left out when unknown). Nothing is asked of the planner.
// How to call: placeFromOption(option) -> { ...option.venue, distanceKm: 0.4 }
export function placeFromOption(option) {
  const place = { ...option.venue }
  if (option.distanceM != null) place.distanceKm = Math.max(0.1, Math.round(option.distanceM / 100) / 10)
  return place
}
