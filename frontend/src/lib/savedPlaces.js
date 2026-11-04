// The rules of a saved place: what is kept from a place in a post, and how a saved place finds the place Jio knows it as. Nothing here asks
// anything; lib/api.js keeps the rows.
//   A saved place: { id, name, nameEnglish, categories, tip, locationHint, googlePlaceId, postKey, postUrl }
// Google's terms allow keeping a place's id and nothing else of its data, so the name, the tip and the location hint are what the post said.
import { mapsUrl } from './postPlaces.js'

// The row to save for a place in a post's answer, in the categories the person picked.
// How to call: toSavedPlace({ name: 'Nylon', locationHint: 'Tanjong Pagar', toSave: { googlePlaceId: 'abc', tip: 'Good kopi' } }, ['eat', 'drink'])
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
