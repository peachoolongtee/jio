// The words of the sample reviews fit the place: every kind and category the planner can return gets texts of its own
// kind, and a place that is not food never gets a food text. The order of the detail and the choice of the card's
// review line are checked here too.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FOOD_KINDS, REVIEW_KINDS, reviewKind, reviewsFor } from '../mock/reviews.js'
import { cardLine, orderReviews, pickReview, placeFromOption, reviewLabel, reviewRank, snippet } from '../reviewPick.js'
import { VENUES } from '../mock/venues.js'
import { bindCurrentUser } from '../currentUser.js'

// The sets, read back out of the module the only way it is public: by asking for the reviews of a place of each kind.
// A venue id is tried until every text of the set has been seen.
function textsOf(venue) {
  const seen = new Set()
  for (let i = 0; i < 400; i++) for (const r of reviewsFor({ ...venue, id: `probe-${i}` })) seen.add(r.text)
  return [...seen]
}
const SAMPLE = { food: { category: 'eat' }, place: { category: 'activity' } }

// Words that review something eaten or drunk. No set for a place that is not food may use them. (A mall or a cinema may
// say that food is nearby; that is a fact about where it is.)
const FOOD_REVIEW_WORDS = /\b(dish|dishes|portions?|pastr(?:y|ies)|coffee|menu|stalls?|noodles?|rice|tastes?|tasted|delicious|flavou?rs?|cocktails?|drinks?|brunch|desserts?|sweet|filling|hungry)\b/i
// The sets written for this change say nothing at all about food.
const ANY_FOOD_WORD = /\b(food|eat|ate|eating|snacks?|dinner|lunch|breakfast|appetite|popcorn|caf[eé]s?|meals?|bill|hawker)\b/i
const NEW_SETS = ['theatre', 'games', 'bowling', 'activity']

const mock = (name) => JSON.parse(readFileSync(new URL(`../../../../backend/src/db/mock/${name}.json`, import.meta.url), 'utf8'))

describe('the text sets', () => {
  const sets = Object.fromEntries(REVIEW_KINDS.map((k) => [k, textsOf({ kind: k, category: FOOD_KINDS.includes(k) ? 'eat' : 'activity', cuisine: k })]))

  it('has a set for every kind of place the planner can return', () => {
    for (const kind of ['hawker', 'restaurant', 'cafe', 'dessert', 'bar', 'mall', 'market', 'park', 'museum', 'cinema', 'library', 'sports', 'attraction', 'theatre']) {
      expect(REVIEW_KINDS, kind).toContain(kind)
    }
  })

  it('shares no text between a food set and any other set', () => {
    const food = new Set(FOOD_KINDS.flatMap((k) => sets[k]))
    expect(food.size).toBeGreaterThan(10)
    for (const kind of REVIEW_KINDS.filter((k) => !FOOD_KINDS.includes(k))) {
      expect(sets[kind].length, kind).toBeGreaterThan(0)
      for (const text of sets[kind]) expect(food.has(text), `${kind}: ${text}`).toBe(false)
    }
  })

  it('has no review of food or drink in a set for a place that is not food', () => {
    for (const kind of REVIEW_KINDS.filter((k) => !FOOD_KINDS.includes(k))) {
      for (const text of sets[kind]) expect(text, `${kind}: ${text}`).not.toMatch(FOOD_REVIEW_WORDS)
    }
  })

  it('has no food word at all in the sets for theatres, games, bowling and other activities', () => {
    for (const kind of NEW_SETS) {
      expect(sets[kind].length, kind).toBeGreaterThanOrEqual(3)
      for (const text of sets[kind]) expect(text, `${kind}: ${text}`).not.toMatch(ANY_FOOD_WORD)
    }
  })

  it('writes in plain sentences: a capital, a full stop, and no markup', () => {
    for (const [kind, texts] of Object.entries(sets)) for (const text of texts) expect(text, kind).toMatch(/^[A-Z].*[.]$/)
  })
})

describe('reviewKind', () => {
  it('gives each kind its own set, and a food set only to food', () => {
    const cases = [
      [{ kind: 'hawker', category: 'eat' }, 'hawker'], [{ kind: 'restaurant', category: 'eat' }, 'restaurant'],
      [{ kind: 'cafe', category: 'drink' }, 'cafe'], [{ kind: 'dessert', category: 'eat' }, 'dessert'], [{ kind: 'bar', category: 'drink' }, 'bar'],
      [{ kind: 'mall', category: 'shop' }, 'mall'], [{ kind: 'market', category: 'shop' }, 'market'],
      [{ kind: 'park', category: 'activity' }, 'park'], [{ kind: 'museum', category: 'activity' }, 'museum'], [{ kind: 'cinema', category: 'activity' }, 'cinema'],
      [{ kind: 'library', category: 'activity' }, 'library'], [{ kind: 'sports', category: 'activity' }, 'sports'], [{ kind: 'attraction', category: 'activity' }, 'attraction'],
      [{ kind: 'theatre', category: 'activity' }, 'theatre'],
      [{ kind: 'sports', category: 'activity', cuisine: 'bowling_alley' }, 'bowling'], [{ kind: 'attraction', category: 'activity', cuisine: 'karaoke' }, 'games'],
      [{ kind: 'attraction', category: 'activity', cuisine: 'zoo' }, 'attraction'], [{ kind: 'museum', category: 'activity', cuisine: 'art_gallery' }, 'museum'],
    ]
    for (const [venue, expected] of cases) expect(reviewKind(venue), JSON.stringify(venue)).toBe(expected)
  })

  it('tells places with no kind apart by cuisine, source and category', () => {
    expect(reviewKind({ category: 'activity', cuisine: 'bowling' })).toBe('bowling')
    expect(reviewKind({ category: 'activity', cuisine: 'escape_room' })).toBe('games')
    expect(reviewKind({ category: 'activity', cuisine: 'board_games' })).toBe('games')
    expect(reviewKind({ category: 'activity', cuisine: 'park' })).toBe('park')
    expect(reviewKind({ category: 'activity', cuisine: 'museum' })).toBe('museum')
    expect(reviewKind({ category: 'eat', cuisine: 'western' })).toBe('restaurant')
    expect(reviewKind({ category: 'eat', cuisine: 'hawker' })).toBe('hawker')
    expect(reviewKind({ category: 'drink', cuisine: 'healthy' })).toBe('cafe')
    expect(reviewKind({ category: 'eat', source: 'cdc', cuisine: 'chinese' })).toBe('hawker')
    expect(reviewKind({ category: 'shop' })).toBe('mall')
    expect(reviewKind({ category: 'activity' })).toBe('activity')
    expect(reviewKind({})).toBe('activity')
    expect(reviewKind(undefined)).toBe('activity')
  })

  it('lets the category settle it when the kind says food and the category does not, and the other way round', () => {
    expect(reviewKind({ kind: 'restaurant', category: 'activity' })).toBe('activity')
    expect(reviewKind({ kind: 'bar', category: 'shop' })).toBe('mall')
    expect(reviewKind({ kind: 'park', category: 'eat' })).toBe('restaurant')
    expect(reviewKind({ kind: 'museum', category: 'drink' })).toBe('cafe')
  })

  it('never gives a food set to a place that is not food, over every place the planner has', () => {
    const lists = [VENUES, mock('curated-venues').venues, mock('mock-data').venues, mock('onemap-places').venues, mock('cdc-venues').venues]
    let checked = 0
    for (const list of lists) {
      for (const venue of list) {
        const key = reviewKind(venue)
        expect(REVIEW_KINDS, venue.id).toContain(key)
        const food = venue.category === 'eat' || venue.category === 'drink'
        expect(FOOD_KINDS.includes(key), `${venue.id} (${venue.kind}/${venue.cuisine}/${venue.category}) -> ${key}`).toBe(food)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(1900)
  })

  it('covers the places Google can return, by the kinds the backend gives them', () => {
    const google = [
      ['restaurant', 'eat', 'italian'], ['hawker', 'eat', 'hawker'], ['bar', 'drink', 'bar'], ['dessert', 'eat', 'dessert'], ['cafe', 'drink', 'cafe'],
      ['mall', 'shop', 'mall'], ['market', 'shop', 'market'], ['cinema', 'activity', 'movie_theater'], ['sports', 'activity', 'bowling_alley'],
      ['museum', 'activity', 'art_gallery'], ['attraction', 'activity', 'karaoke'], ['attraction', 'activity', 'video_arcade'],
      ['attraction', 'activity', 'amusement_center'], ['attraction', 'activity', 'amusement_park'], ['attraction', 'activity', 'aquarium'], ['attraction', 'activity', 'zoo'],
    ]
    for (const [kind, category, cuisine] of google) {
      const key = reviewKind({ kind, category, cuisine })
      expect(FOOD_KINDS.includes(key), `${kind}/${cuisine}`).toBe(category === 'eat' || category === 'drink')
    }
  })
})

describe('reviewsFor', () => {
  it('gives the same reviews for the same place every time', () => {
    const today = new Date('2026-10-11T12:00:00')
    for (const venue of [{ id: 'a1', kind: 'hawker', category: 'eat', rating: 8 }, { id: 'b2', category: 'activity', cuisine: 'bowling' }, { id: 'c3', kind: 'theatre', category: 'activity' }]) {
      expect(reviewsFor(venue, today)).toEqual(reviewsFor({ ...venue }, today))
    }
  })

  it('keeps the reviews every place on Home has today (a kind that already had texts is unchanged)', () => {
    const today = new Date('2026-10-11T12:00:00')
    for (const venue of VENUES) {
      const reviews = reviewsFor(venue, today)
      expect(reviews.length).toBeGreaterThanOrEqual(3)
      expect(reviewKind(venue), venue.id).toBe(venue.kind)
    }
  })

  it('writes a place of each kind a review from its own set', () => {
    const today = new Date('2026-10-11T12:00:00')
    const bowling = reviewsFor({ id: 'x', category: 'activity', cuisine: 'bowling' }, today)
    expect(bowling.every((r) => /lane|shoe|bowl|laughed|group play/i.test(r.text))).toBe(true)
    const theatre = reviewsFor({ id: 'y', kind: 'theatre', category: 'activity' }, today)
    expect(theatre.some((r) => /show|seats|tickets|evening/i.test(r.text))).toBe(true)
  })
})

const review = (id, personId, name = personId) => ({ id, personId, name, text: `Review ${id}`, rating: 8, date: '2026-09-01' })
const REVIEWS = [review('r1', 'meiling', 'Mei Ling'), review('r2', 'nicole', 'Nicole'), review('r3', 'faith', 'Faith'), review('r4', 'siti', 'Siti'), review('r5', 'darius', 'Darius')]

describe('the order of the detail', () => {
  it('lists people in this outing, then friends, then others, and keeps the given order inside each group', () => {
    const ctx = { outing: ['faith', 'darius'], friends: ['nicole', 'faith', 'darius'] }
    expect(orderReviews(REVIEWS, ctx).map((r) => r.id)).toEqual(['r3', 'r5', 'r2', 'r1', 'r4'])
  })

  it('is Home\'s order (friends first) when nobody is in an outing, and does not change the list it is given', () => {
    const before = REVIEWS.map((r) => r.id)
    expect(orderReviews(REVIEWS, { friends: ['siti', 'darius'] }).map((r) => r.id)).toEqual(['r4', 'r5', 'r1', 'r2', 'r3'])
    expect(REVIEWS.map((r) => r.id)).toEqual(before)
    expect(orderReviews(REVIEWS).map((r) => r.id)).toEqual(before)
  })

  it('ranks a person in the outing above a friend above anyone else', () => {
    const ctx = { outing: ['faith'], friends: ['faith', 'nicole'] }
    expect(reviewRank({ personId: 'faith' }, ctx)).toBe(0)
    expect(reviewRank({ personId: 'nicole' }, ctx)).toBe(1)
    expect(reviewRank({ personId: 'meiling' }, ctx)).toBe(2)
  })
})

describe('the review a card shows', () => {
  it('chooses someone in the outing over a friend', () => {
    expect(pickReview(REVIEWS, { outing: ['faith'], friends: ['nicole', 'faith'] }).personId).toBe('faith')
  })
  it('chooses a friend over a stranger', () => {
    expect(pickReview(REVIEWS, { outing: [], friends: ['nicole'] }).personId).toBe('nicole')
    expect(pickReview(REVIEWS, { outing: ['siti'], friends: [] }).personId).toBe('siti')
  })
  it('never chooses the signed-in person\'s own review', () => {
    // The signed-in person is the sample person Ian here, as for the demo account.
    const before = bindCurrentUser(() => 'ian')
    try {
      const own = [review('own', 'ian', 'Ian'), review('r2', 'nicole', 'Nicole')]
      expect(pickReview(own, { outing: ['ian'], friends: ['ian', 'nicole'] }).personId).toBe('nicole')
      expect(pickReview(own, { outing: ['ian'], friends: ['ian'] })).toBeNull()
      expect(pickReview([review('mine', 'faith')], { outing: ['faith'], self: 'faith' })).toBeNull()
    } finally {
      bindCurrentUser(before)
    }
  })
  it('chooses nobody when no reviewer is in the outing or a friend', () => {
    expect(pickReview(REVIEWS, { outing: [], friends: [] })).toBeNull()
    expect(pickReview(REVIEWS, { outing: ['kai'], friends: ['kai'] })).toBeNull()
    expect(pickReview([], {})).toBeNull()
  })
  it('counts the reviews either way, and chooses the same review each time for the same place', () => {
    const venue = { id: 'maxwell', kind: 'hawker', category: 'eat', rating: 8.4 }
    const everyone = ['darius', 'jonathan', 'nicole', 'faith', 'darryl']
    const a = cardLine(venue, { friends: everyone })
    expect(a.count).toBe(reviewsFor(venue).length)
    expect(a.review).not.toBeNull()
    expect(cardLine(venue, { friends: everyone })).toEqual(a)
    expect(cardLine(venue, {})).toEqual({ count: a.count, review: null })
  })
})

describe('words for the card', () => {
  it('names the line for a screen reader, with the place, who wrote it and the start of the review', () => {
    const label = reviewLabel('Maxwell Food Centre', { count: 4, review: { name: 'Faith', text: 'Cheap and filling. Get there before the lunch crowd or tables are hard to find.' } })
    expect(label).toBe('Reviews of Maxwell Food Centre. Faith, sample review: Cheap and filling. Get there before the lunch crowd or…')
    expect(reviewLabel('Bishan Park', { count: 4, review: null })).toBe('Reviews of Bishan Park. 4 sample reviews')
    expect(reviewLabel('Bishan Park', { count: 1, review: null })).toBe('Reviews of Bishan Park. 1 sample review')
  })
  it('cuts a text at a word and says so', () => {
    expect(snippet('Short.', 60)).toBe('Short.')
    expect(snippet('Cheap and filling. Get there early', 20)).toBe('Cheap and filling…')
    expect(snippet('Unbrokenwordthatgoeson', 8)).toBe('Unbroken…')
    expect(snippet(undefined)).toBe('')
  })
  it('builds the place from the option with its distance in km, and leaves the distance out when unknown', () => {
    const venue = { id: 'v', name: 'V', category: 'eat' }
    expect(placeFromOption({ venue, distanceM: 420 })).toEqual({ ...venue, distanceKm: 0.4 })
    expect(placeFromOption({ venue, distanceM: 10 }).distanceKm).toBe(0.1)
    expect(placeFromOption({ venue, distanceM: null })).toEqual(venue)
    expect(placeFromOption({ venue }).distanceKm).toBeUndefined()
  })
})
