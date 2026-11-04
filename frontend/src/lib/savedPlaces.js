// The rules of a saved place: what is kept from a place in a post, and how a saved place finds the place Jio knows it as. Nothing here asks
// anything; lib/api.js keeps the rows.
//   A saved place: { id, name, nameEnglish, categories, tip, locationHint, googlePlaceId, postKey, postUrl }
// Google's terms allow keeping a place's id and nothing else of its data, so the name, the tip and the location hint are what the post said.
import { mapsUrl } from './postPlaces.js'

// The row to save for a place in a post's answer, in the category the person picked (the table keeps a list; a place is one kind).
// How to call: toSavedPlace({ name: 'Nylon', locationHint: 'Tanjong Pagar', toSave: { googlePlaceId: 'abc', tip: 'Good kopi' } }, ['eat'])
export function toSavedPlace(place, categories = []) {
  const kept = place?.toSave || {}
  return {
    name: kept.name || place?.name,
    nameEnglish: kept.nameEnglish || place?.nameEnglish || null,
    categories,
    tip: kept.tip || place?.tip || null,
    locationHint: place?.locationHint || null,
    googlePlaceId: kept.googlePlaceId || null,
    postKey: kept.postKey || null,
    postUrl: kept.postUrl || null,
  }
}

// What "Places from a post" was showing, kept while the person looks at another page, so coming back keeps the link, the places (a second
// read would cost another AI call) and what was picked. Only in this tab's memory, and only for the person who read it.
const postDraft = { owner: null, link: '', answer: null, picks: {} }
// How to call: keepPostDraft('7f3c', { link, answer, picks })
export function keepPostDraft(owner, draft) {
  Object.assign(postDraft, { owner }, draft)
}
// The draft kept for this person, or null. How to call: readPostDraft('7f3c') -> { link, answer, picks } | null
export function readPostDraft(owner) {
  return postDraft.owner === owner && (postDraft.link || postDraft.answer) ? { link: postDraft.link, answer: postDraft.answer, picks: postDraft.picks } : null
}
// How to call: forgetPostDraft()
export function forgetPostDraft() {
  Object.assign(postDraft, { owner: null, link: '', answer: null, picks: {} })
}

// What makes two saves the same place: its Google id, or its name when it has none, in any case.
// How to call: savedKey({ googlePlaceId: null, name: ' Goliath OUTDOOR ' }) -> 'name:goliath outdoor'
export function savedKey(place) {
  return place?.googlePlaceId ? `id:${place.googlePlaceId}` : `name:${String(place?.name || '').trim().toLowerCase()}`
}

// A name with its case, punctuation and spaces gone, so "Nylon Coffee" and "NYLON  coffee!" are the same.
const plain = (name) => String(name || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

// The place Jio knows a saved place as, among what a search of Jio's places found: the same name, and never a place from Google, which may
// not be shown beside the map. Null when Jio does not know it.
// How to call: knownVenue({ name: 'Nylon Coffee' }, [{ id: 'nylon', name: 'NYLON coffee' }]) -> { id: 'nylon', name: 'NYLON coffee' }
export function knownVenue(saved, found = []) {
  const names = [plain(saved?.name), plain(saved?.nameEnglish)].filter(Boolean)
  return found.find((r) => !String(r.id).startsWith('google_') && names.includes(plain(r.name))) || null
}

// Does a saved place match what was typed? By either name or where the post says it is.
// How to call: matchesQuery({ name: 'Nylon', locationHint: 'Tanjong Pagar' }, 'tanjong') -> true
export function matchesQuery(saved, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return true
  return [saved?.name, saved?.nameEnglish, saved?.locationHint].some((text) => String(text || '').toLowerCase().includes(q))
}

// A saved place's area for the line beside its category: where the post says it is, when that is an area such as "Katong". A street address
// or a long description is left off, because that line is only a quick label (Faith, 4 November 2026); the whole hint stays on the row.
// How to call: savedArea({ locationHint: 'Tanjong Pagar' }) -> 'Tanjong Pagar'; savedArea({ locationHint: '70 Telok Ayer St, #01-01' }) -> ''
export function savedArea(saved) {
  const hint = String(saved?.locationHint || '').trim()
  return hint.length <= 30 && !/[\d,#]/.test(hint) ? hint : ''
}

// Where the post says a saved place is, when that is more than an area: shown on the card as it is. It is the post's own words, so it may be
// kept, and showing it asks Google nothing (Faith, 4 November 2026).
// How to call: savedAddress({ locationHint: '70 Telok Ayer St, #01-01' }) -> '70 Telok Ayer St, #01-01'; savedAddress({ locationHint: 'Katong' }) -> ''
export function savedAddress(saved) {
  return savedArea(saved) ? '' : String(saved?.locationHint || '').trim()
}

// A saved place's link to Google Maps: by its id when it has one, else a search by name.
// How to call: savedMapsUrl({ name: 'Nylon', googlePlaceId: 'abc' }) -> 'https://www.google.com/maps/search/?api=1&...'
export function savedMapsUrl(saved) {
  const name = saved?.nameEnglish || saved?.name
  return mapsUrl(saved?.googlePlaceId ? { match: { placeId: saved.googlePlaceId, name } } : { name, locationHint: saved?.locationHint })
}

// ── A saved place in a vote ──
// Any saved place can be added to a vote, Jio knowing it or not (Faith, 4 November 2026). One Jio does not know goes in as a copy: its name,
// kind and address in the person's or the post's own words, and a point OneMap found from the address. Nothing of Google's is in it but the
// place id, which may be kept, so it may sit on the OneMap map. Its hours, price, rating and dietary levels are not known, so the planner
// never ranks it and the card claims none of them.
const SAVED_ID = 'saved_'

// Is this the id of a saved place's copy, not one of Jio's own places? How to call: isSavedVenueId('saved_7f3c') -> true
export const isSavedVenueId = (id) => String(id ?? '').startsWith(SAVED_ID)
// The id a saved place has in a vote. How to call: savedVenueId({ id: '7f3c' }) -> 'saved_7f3c'
export const savedVenueId = (saved) => `${SAVED_ID}${saved.id}`

const hasPoint = (row) => Number.isFinite(row?.lat) && Number.isFinite(row?.lng)

// Where a saved place is on the map, asked once, when it is added: the postal code in its address, then the street, then a place of its own name,
// all exact; then the area its address names, which is only rough. Null when nothing fits: the place has no pin. Asking OneMap never fails
// the add, and it never asks Google.
// `search` is plannerApi's searchAddresses (OneMap, [{ name, postal, lat, lng }]), `areas` the MRT areas ({ name, lat, lng }).
// How to call: await findSavedPin({ name: 'Amoy Hotel', locationHint: '76 Telok Ayer St, 048458' }, { search: searchAddresses, areas: AREAS }) -> { lat, lng, rough: false } | null
export async function findSavedPin(saved, { search, areas = [] }) {
  const hint = String(saved?.locationHint || '').trim()
  const ask = async (text) => {
    try {
      const rows = await search(text)
      return Array.isArray(rows) ? rows.filter(hasPoint) : []
    } catch {
      return []
    }
  }
  const pin = (row, rough) => ({ lat: row.lat, lng: row.lng, rough })
  const postal = /\b\d{6}\b/.exec(hint)?.[0]
  if (postal) {
    const found = (await ask(postal)).find((r) => String(r.postal) === postal)
    if (found) return pin(found, false)
  }
  // The street, without the unit or what follows it: "70 Telok Ayer St, #01-01" is "70 Telok Ayer St".
  const street = hint.split(',')[0].replace(/#\S+/g, '').trim()
  if (/\d/.test(street) && street !== postal) {
    const [found] = await ask(street)
    if (found) return pin(found, false)
  }
  const names = [plain(saved?.name), plain(saved?.nameEnglish)].filter(Boolean)
  for (const name of [saved?.nameEnglish, saved?.name].filter(Boolean)) {
    const found = (await ask(name)).find((r) => names.includes(plain(r.name)))
    if (found) return pin(found, false)
  }
  if (!savedArea(saved)) return null
  const area = areas.find((a) => hasPoint(a) && plain(a.name).includes(plain(hint)))
  if (area) return pin(area, true)
  const [found] = await ask(hint)
  return found ? pin(found, true) : null
}

// What is sent and kept for a saved place in a vote. The server keeps it with the option, so every member reads the same copy.
// How to call: savedCopy({ id: '7f3c', name: 'Nylon', categories: ['drink'], locationHint: 'Tanjong Pagar' }, { lat: 1.27, lng: 103.84, rough: true })
export function savedCopy(saved, pin) {
  return {
    id: saved.id,
    name: saved.nameEnglish || saved.name,
    category: saved.categories[0],
    address: String(saved.locationHint || '').trim() || null,
    lat: pin?.lat ?? null,
    lng: pin?.lng ?? null,
    rough: !!pin?.rough,
    googlePlaceId: saved.googlePlaceId || null,
  }
}

// A saved place's copy as the cards and the itinerary read a place. It claims nothing Jio does not know: no price, rating or hours, and each
// dietary need unconfirmed. Indoor, so no rain warning is made for it. One with no pin stands at the meeting area for the travel times,
// as a place that left the list does, and `noPin` keeps it off the map and off the distances.
// How to call: asSavedVenue({ id: 'saved_7f3c', name: 'Nylon', category: 'drink', address: 'Tanjong Pagar', lat: 1.27, lng: 103.84 })
export function asSavedVenue(copy) {
  return {
    ...copy,
    saved: true,
    // The line under a stop's name in the itinerary.
    area: copy.address || '',
    address: copy.address || '',
    price: null,
    rating: null,
    hours: [],
    serves: [],
    tags: [],
    indoor: true,
    diet: { halal: 'unknown', vegetarian: 'unknown', vegan: 'unknown' },
  }
}
