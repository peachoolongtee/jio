// Sample reviews for the place detail view, written by people on Jio after their meetups: some by Ian's friends,
// some by people he does not know yet (who he can add as friends from their review).
// Mock data, generated the same way every time for a place (seeded by its id). The texts are about the
// kind of place, not claims about the real venue. Replace with real reviews when the backend has them.
//
// A review: { id, personId, name, rating (out of 10, like venue ratings), text, date (yyyy-MM-dd) }.
import { format, subDays } from 'date-fns'
import { seeded } from './history.js'
import { PEOPLE, isCommunity } from './people.js'

const TEXTS = {
  hawker: [
    'Went with the group after a long walk. Plenty of stalls, so everyone found something they liked.',
    'Cheap and filling. Get there before the lunch crowd or tables are hard to find.',
    'Good spot for a big group: split up, order from different stalls, meet back at one table.',
    'Queues at the popular stalls, but they move fast. Bring tissue packets to chope a seat.',
    'Ate here before the MRT home. Quick, warm and easy on the wallet.',
  ],
  restaurant: [
    'Booked for six and they set us up at a long table. Food came out quickly.',
    'Generous portions, so we shared a few dishes. Service was friendly even when it got busy.',
    'Nice place to sit and talk for a while. A bit loud at dinner time.',
    'Worth it for a birthday dinner. Split the bill easily at the counter.',
    'Solid choice when the group cannot agree on what to eat. Something for everyone.',
  ],
  cafe: [
    'Cosy, with good coffee. We stayed for almost two hours and nobody rushed us.',
    'Pastries sold out by the afternoon, so come early if you want them.',
    'Quiet on a weekday morning, packed on Saturday. Great for catching up.',
    'Lovely light inside and comfortable seats. A little pricey, but we would come back.',
    'Good place to start the day before heading somewhere else nearby.',
  ],
  dessert: [
    'Perfect stop after dinner. We shared three things and finished all of them.',
    'Small shop, so it fills up fast, but takeaway works if there are no seats.',
    'Sweet but not too sweet. The group could not stop talking about it.',
    'A treat after a hot afternoon walk. Worth the short queue.',
  ],
  bar: [
    'Great drinks and a relaxed crowd. Best after 8 pm when it gets lively.',
    'We got a corner table for the group. Music was loud enough to feel fun, not too loud to talk.',
    'Pricey, but good for a celebration. Staff helped us choose.',
    'Happy hour made it easy on the wallet. A good place to end the night.',
  ],
  mall: [
    'Easy meeting point right by the MRT, with plenty of food options inside.',
    'Air-con, toilets and lots of shops. Good backup plan when it rains.',
    'Crowded on weekends, but we found everything we needed in one place.',
    'We split up to shop, then met at the food court. Worked well for the group.',
  ],
  market: [
    'Fun to wander around together. Lots of small shops and snacks along the way.',
    'Great for photos. Gets hot in the afternoon, so bring water.',
    'Busy and colourful. Bargained a little and got a good deal.',
    'Nice to walk through after lunch. Plenty to look at even if you do not buy anything.',
  ],
  park: [
    'Lovely walk with the group. Shady paths and a few good spots to sit.',
    'Went in the late afternoon when it was cooler. Beautiful at sunset.',
    'Free and relaxing. A nice break between food stops.',
    'Wear comfortable shoes. Some slopes, but worth it for the views.',
  ],
  museum: [
    'Spent a good two hours here. Interesting exhibits and a cool escape from the heat.',
    'Quiet and calm. Good for a slower afternoon with friends.',
    'Some exhibits were free, which was a nice surprise. Check what is on before going.',
    'Great for a rainy day. We ended at the café inside.',
  ],
  cinema: [
    'Comfortable seats and good sound. Book online so the group can sit together.',
    'Easy to grab food nearby before the show. Popcorn combo was decent.',
    'Weekday matinee was cheaper and nearly empty. Recommended.',
  ],
  library: [
    'Calm place to hang out for a bit. Air-conditioned, clean and free.',
    'Nice reading corners. We came to study, then went for food nearby.',
    'Good spot to wait for friends who are running late.',
  ],
  sports: [
    'Booked two courts for the group. Equipment rental was easy.',
    'Great way to work up an appetite before dinner. Book ahead on weekends.',
    'Clean and well kept. Changing rooms were busy but fine.',
  ],
  attraction: [
    'Touristy, but fun with friends. Go early to avoid the crowds.',
    'Took lots of photos. Allow more time than you think.',
    'Worth visiting at least once. The evening is especially nice.',
    'Busy on weekends. Weekday visits are much calmer.',
  ],
  // The sets below are for places the planner can return that the sets above do not fit: a theatre, a place to play
  // (karaoke, an arcade, an escape room, board games), a bowling alley, and any other activity. None of them talk about food.
  theatre: [
    'Booked ahead so the group could sit together. Good seats and the show started on time.',
    'A relaxed evening out, and easy to get to by MRT. Check what is on before you go.',
    'Seated and quiet during the show, so save the chatting for before and after.',
    'Picked a show everyone would enjoy. A good plan for a rainy evening.',
  ],
  games: [
    'Great for a group: we split into teams and the time went by fast.',
    'Booked a slot ahead, which was easy to do. Best with four to six people.',
    'Loud and silly in the best way. Everyone joined in, even the shy ones.',
    'Costs more per person than a walk, but worth it for a birthday or a celebration.',
  ],
  bowling: [
    'Lanes were free on a weekday evening. Shoe rental was quick.',
    'Easy for mixed skill levels. We laughed more than we scored.',
    'Book a lane ahead on weekends so the whole group can play together.',
  ],
  activity: [
    'Easy to find and easy to get to. A good plan for a group that wants to do something together.',
    'Booked ahead for the group and it was quick to sort out.',
    'We spent a couple of hours here without noticing. Check opening hours first.',
    'Better with friends than on your own. Allow more time than you think.',
  ],
}

// The sets written about food and drink. A place that is not food never gets one of these.
export const FOOD_KINDS = ['hawker', 'restaurant', 'cafe', 'dessert', 'bar']
// The kinds of review text there are.
export const REVIEW_KINDS = Object.keys(TEXTS)

// What a place with no kind of its own is, by its category. Eating and drinking places are food, the others are not.
const FROM_CATEGORY = { eat: 'restaurant', drink: 'cafe', shop: 'mall', activity: 'activity' }
// What the planner's own list calls a place that has a cuisine and no kind (backend/src/db/mock/mock-data.json), and
// what Google calls the places that are played at.
const FROM_CUISINE = { hawker: 'hawker', cafe: 'cafe', bar: 'bar', park: 'park', museum: 'museum', bowling: 'bowling', board_games: 'games', escape_room: 'games' }
const GAMES = new Set(['karaoke', 'video_arcade', 'amusement_center', 'escape_room', 'board_games'])
const BOWLING = new Set(['bowling', 'bowling_alley'])

// Which set of review texts fits a place. Food places get food texts and no other place does: the category settles it
// when the kind and the category disagree. A place with no kind is told apart by its cuisine, a CDC site is a hawker
// centre's stalls, and anything else falls to its category (a place with none is "activity", which has no food in it).
// How to call: reviewKind({ kind: 'sports', cuisine: 'bowling_alley', category: 'activity' }) -> 'bowling'
export function reviewKind(venue) {
  const { kind, cuisine, category, source } = venue || {}
  let key
  if (kind === 'attraction' && GAMES.has(cuisine)) key = 'games'
  else if (kind === 'sports' && BOWLING.has(cuisine)) key = 'bowling'
  else if (kind && TEXTS[kind]) key = kind
  else if (source === 'cdc') key = 'hawker'
  else key = FROM_CUISINE[cuisine] || FROM_CATEGORY[category] || 'activity'
  const food = category === 'eat' || category === 'drink'
  const place = category === 'shop' || category === 'activity'
  if ((food && !FOOD_KINDS.includes(key)) || (place && FOOD_KINDS.includes(key))) return FROM_CATEGORY[category]
  return key
}

const CIRCLE = PEOPLE.filter((p) => p.id !== 'ian' && !isCommunity(p.id))
const OTHERS = PEOPLE.filter((p) => isCommunity(p.id))

// 3 to 5 reviews for a venue, newest first: one or two from Ian's circle, the rest from other people on Jio.
// Ratings sit around the venue's own rating. The texts fit the kind of place (see reviewKind).
// How to call: reviewsFor({ id: 'maxwell', kind: 'hawker', category: 'eat', rating: 8.4 })
export function reviewsFor(venue, today = new Date()) {
  const random = seeded(`reviews:${venue.id}`)
  const texts = [...TEXTS[reviewKind(venue)]]
  const count = Math.min(texts.length, 3 + Math.floor(random() * 3))
  const pick = (list, n) => {
    const pool = [...list]
    return Array.from({ length: n }, () => pool.splice(Math.floor(random() * pool.length), 1)[0])
  }
  const friends = 1 + Math.floor(random() * 2)
  const people = [...pick(CIRCLE, friends), ...pick(OTHERS, count - friends)]
  const base = venue.rating ?? 8
  const reviews = []
  for (let i = 0; i < count; i++) {
    const person = people[i]
    const text = texts.splice(Math.floor(random() * texts.length), 1)[0]
    // Within a point of the venue's rating, in halves, between 5 and 10.
    const rating = Math.min(10, Math.max(5, Math.round((base + (random() * 2 - 1)) * 2) / 2))
    const date = format(subDays(today, 3 + Math.floor(random() * 170)), 'yyyy-MM-dd')
    reviews.push({ id: `${venue.id}-r${i}`, personId: person.id, name: person.name, rating, text, date })
  }
  return reviews.sort((a, b) => b.date.localeCompare(a.date))
}
