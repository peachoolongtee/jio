// Sample reviews for the place detail view, written by Jio's demo friends after their meetups.
// Mock data, generated the same way every time for a place (seeded by its id). The texts are about the
// kind of place, not claims about the real venue. Replace with real reviews when the backend has them.
//
// A review: { id, personId, name, rating (out of 10, like venue ratings), text, date (yyyy-MM-dd) }.
import { format, subDays } from 'date-fns'
import { seeded } from './history.js'
import { PEOPLE } from './people.js'

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
}

const REVIEWERS = PEOPLE.filter((p) => p.id !== 'ian')

// 3 to 5 reviews for a venue, newest first. Ratings sit around the venue's own rating.
export function reviewsFor(venue, today = new Date()) {
  const random = seeded(`reviews:${venue.id}`)
  const texts = [...(TEXTS[venue.kind] || TEXTS.restaurant)]
  const people = [...REVIEWERS]
  const count = Math.min(texts.length, people.length, 3 + Math.floor(random() * 3))
  const base = venue.rating ?? 8
  const reviews = []
  for (let i = 0; i < count; i++) {
    const person = people.splice(Math.floor(random() * people.length), 1)[0]
    const text = texts.splice(Math.floor(random() * texts.length), 1)[0]
    // Within a point of the venue's rating, in halves, between 5 and 10.
    const rating = Math.min(10, Math.max(5, Math.round((base + (random() * 2 - 1)) * 2) / 2))
    const date = format(subDays(today, 3 + Math.floor(random() * 170)), 'yyyy-MM-dd')
    reviews.push({ id: `${venue.id}-r${i}`, personId: person.id, name: person.name, rating, text, date })
  }
  return reviews.sort((a, b) => b.date.localeCompare(a.date))
}
