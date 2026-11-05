// The pure parts of searching for a place: how a name is shown, when two names are the same place, how a list of
// places becomes a list of areas for "Suggest a spot", what the search sheet says while it works, and the guard that
// keeps an older search from overwriting a newer one. No network and no component here, so each is tested alone.
// api.js (searchPlaces) and components/group/LocationSheet.vue use them.

// Fewest characters worth asking the address search about, and the most the backend accepts.
export const SEARCH_MIN_CHARS = 2
export const SEARCH_MAX_CHARS = 80

// Words OneMap writes in capitals that stay in capitals when a name is shown.
const KEEP_UPPER = new Set(['MRT', 'LRT', 'HDB', 'NUS', 'NTU', 'SMU', 'SIM', 'ION', 'NEX', 'CBD', 'BTO', 'NIL', 'SG', 'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX', 'XI', 'XII', 'AMK', 'KK', 'TTSH', 'SGH', 'NUH', 'CHIJMES'])

// A name as OneMap writes it ("TAMPINES MALL") in the case a person reads. A name that already has lower case letters is
// left as it is. Station, school and mall acronyms keep their capitals.
// How to call: displayName('TAMPINES MALL') -> 'Tampines Mall'
export function displayName(name) {
  const text = String(name ?? '').trim().replace(/\s+/g, ' ')
  if (!text || /\p{Ll}/u.test(text)) return text
  return text.replace(/\p{L}[\p{L}']*/gu, (word) => (KEEP_UPPER.has(word) ? word : word[0] + word.slice(1).toLowerCase()))
}

// A name boiled down so two spellings of one place compare equal: lower case, no punctuation, no "MRT station".
// How to call: sameKey('TAMPINES MRT STATION') -> 'tampines'
export function sameKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/\b(mrt|lrt)\b/g, ' ')
    .replace(/\bstation\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

// "Suggest a spot" picks an area, not a place. Each row becomes the area it falls in, with the place searched as its
// second line, and an area is listed once (its first row wins, so a built-in area row stays ahead of an address in it).
// Rows are { id, label, sub, areaId, areaName, near }. `near` is the place searched, or null for an area itself.
// How to call: toSpotRows([{ id: 'x', label: 'Tampines Mall', sub: '...', areaId: 'tampines', areaName: 'Tampines', near: 'Tampines Mall' }])
//   -> [{ id: 'spot-tampines', label: 'Tampines', sub: 'Near Tampines Mall', areaId: 'tampines' }]
export function toSpotRows(rows) {
  const seen = new Set()
  const out = []
  for (const row of rows) {
    if (seen.has(row.areaId)) continue
    seen.add(row.areaId)
    out.push({ id: `spot-${row.areaId}`, label: row.areaName || row.label, sub: row.near ? `Near ${row.near}` : row.sub, areaId: row.areaId })
  }
  return out
}

// What the line under the results says, or '' when it has nothing to say.
//   query:       the trimmed text that was searched
//   pending:     a search for it is still running
//   unavailable: the wider (address) search could not be used
//   count:       how many rows are shown
// How to call: searchStatus({ query: 'xyz', pending: false, unavailable: false, count: 0 })
//   -> 'No places match "xyz". Try a postal code or a nearby MRT station.'
export function searchStatus({ query, pending, unavailable, count }) {
  if (!query) return ''
  if (pending) return 'Searching…'
  if (unavailable) {
    const lead = count ? '' : `No places match "${query}". `
    return `${lead}Address search is not available right now, so only areas Jio already knows are listed.`
  }
  if (!count) {
    return query.length < SEARCH_MIN_CHARS
      ? `No places match "${query}". Type two or more characters to search addresses.`
      : `No places match "${query}". Try a postal code or a nearby MRT station.`
  }
  return ''
}

// A guard for a search that can be replaced while it runs. start() cancels the one before and returns the new one's
// signal and a `current()` that says whether it is still the latest. Whoever awaits an answer checks `current()` before
// showing it, so a slower earlier answer is dropped. cancel() ends the latest one too, for a closed sheet or a cleared field.
// How to call:
//   const latest = createLatest()
//   const job = latest.start()
//   const answer = await search(q, { signal: job.signal })
//   if (job.current()) show(answer)
export function createLatest() {
  let count = 0
  let controller = null
  return {
    start() {
      controller?.abort()
      controller = new AbortController()
      const mine = ++count
      return { signal: controller.signal, current: () => mine === count }
    },
    cancel() {
      controller?.abort()
      controller = null
      count += 1
    },
  }
}

// Did this error come from a cancelled search?
// How to call: isCancelled(err) -> true for the AbortError the search throws
export function isCancelled(err) {
  return err?.name === 'AbortError' || err?.code === 'ERR_CANCELED'
}
