// A photo for any place: one per kind of place, not a photo of the venue itself.
// Credits and sources: src/assets/places/CREDITS.md.
//   <img :src="placeImage(venue)" alt="" />
import attraction from '@/assets/places/attraction.jpg'
import bar from '@/assets/places/bar.jpg'
import cafe from '@/assets/places/cafe.jpg'
import cinema from '@/assets/places/cinema.jpg'
import dessert from '@/assets/places/dessert.jpg'
import hawker from '@/assets/places/hawker.jpg'
import library from '@/assets/places/library.jpg'
import mall from '@/assets/places/mall.jpg'
import market from '@/assets/places/market.jpg'
import museum from '@/assets/places/museum.jpg'
import park from '@/assets/places/park.jpg'
import restaurant from '@/assets/places/restaurant.jpg'
import sports from '@/assets/places/sports.jpg'

const PHOTOS = { attraction, bar, cafe, cinema, dessert, hawker, library, mall, market, museum, park, restaurant, sports }

// Places from the backend's mock list have a cuisine instead of a kind.
const FROM_CUISINE = { hawker: 'hawker', cafe: 'cafe', bar: 'bar', park: 'park', museum: 'museum', bowling: 'sports', board_games: 'attraction', escape_room: 'attraction' }
const FROM_CATEGORY = { eat: 'restaurant', drink: 'cafe', shop: 'mall', activity: 'attraction' }

// The kind of place a venue is, for its photo.
export function placeKind(venue) {
  if (venue.kind && PHOTOS[venue.kind]) return venue.kind
  // Every CDC site is a coffee shop or hawker centre's food stalls.
  if (venue.source === 'cdc') return 'hawker'
  return FROM_CUISINE[venue.cuisine] || FROM_CATEGORY[venue.category] || 'restaurant'
}

export function placeImage(venue) {
  return PHOTOS[placeKind(venue)]
}

// The photo for a kind of place ('park', 'hawker', ...), or the restaurant one for a kind it does not know.
// How to call: photoOfKind('park')
export function photoOfKind(kind) {
  return PHOTOS[kind] || PHOTOS.restaurant
}
