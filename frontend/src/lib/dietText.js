// The words for dietary needs on the voting page, Roam and the cards (ticket #107). The group sees which needs the places fit,
// never whose they are and never how many people have them.
import { DIETARY_OPTIONS, cleanDietary } from './signupRules.js'

// A need's word as it reads inside a sentence. How to call: needWord('halal') -> 'halal'
const needWord = (need) => (DIETARY_OPTIONS.find((o) => o.value === need)?.label ?? need).toLowerCase()

// How to call: capitalised('halal and vegan') -> 'Halal and vegan'
const capitalised = (text) => text.charAt(0).toUpperCase() + text.slice(1)

// Needs joined as a person would say them, in the app's order.
// How to call: needsText(['vegetarian', 'halal']) -> 'halal and vegetarian'
export function needsText(needs) {
  const words = cleanDietary(needs).map(needWord)
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

// The one line under the food category. Empty when the group has no needs.
// How to call: fitLine(['halal', 'vegetarian']) -> 'Showing places that fit halal and vegetarian'
export function fitLine(needs) {
  const text = needsText(needs)
  return text ? `Showing places that fit ${text}` : ''
}

// What is said when fewer than 3 food places fit. How to call: fewLine(1) -> 'Only 1 place fits.'
export function fewLine(found) {
  if (found === 0) return 'No place nearby is confirmed to fit.'
  return `Only ${found} ${found === 1 ? 'place fits' : 'places fit'}.`
}

// The caveats a place carries, as tags beside "Near MRT", one per need (after a MUIS tag, when the place has one): a need we only guessed from a stall's name ("Halal
// likely") and a need we have no data on ("Halal not confirmed", with a warning icon). Halal is brown and vegetarian and
// vegan green (InfoTag tones `halal` and `veg`). Each tag's `title` is the whole sentence, "... check before you go". None
// for a place that fits for sure, and none for a drink, shop or activity place (the planner sends none for them).
// How to call: dietTags({ dietUnknown: ['halal'], verify: [] }) -> [{ key: 'unknown-halal', text: 'Halal not confirmed', tone: 'halal', icon: 'warning', title: 'Halal not confirmed, check before you go' }]
export function dietTags(option) {
  const tag = (need, kind) => {
    const text = `${capitalised(needWord(need))} ${kind === 'unknown' ? 'not confirmed' : 'likely'}`
    const tone = need === 'halal' ? 'halal' : 'veg'
    return { key: `${kind}-${need}`, text, tone, icon: kind === 'unknown' ? 'warning' : '', title: `${text}, check before you go` }
  }
  return [...certifiedTags(option?.venue), ...cleanDietary(option?.dietUnknown).map((n) => tag(n, 'unknown')), ...cleanDietary(option?.verify).map((n) => tag(n, 'likely'))]
}

// A centre with stalls certified halal by MUIS (a hand check, recorded on the place) says so first, whatever the group needs:
// it is a fact about the place. The title gives the count and the day it was checked.
// How to call: certifiedTags({ dataQuality: { halalSource: 'muis', muisStalls: 9, halalCheckedAt: '2026-10-18' } })
//   -> [{ key: 'muis-halal', text: 'MUIS halal stalls', tone: 'halal', icon: '', title: '9 stalls certified halal by MUIS, checked 18 Oct 2026' }]
export function certifiedTags(venue) {
  const q = venue?.dataQuality
  if (q?.halalSource !== 'muis' || !(q.muisStalls > 0)) return []
  const day = /^\d{4}-\d{2}-\d{2}$/.test(q.halalCheckedAt || '')
    ? new Date(`${q.halalCheckedAt}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : ''
  const count = `${q.muisStalls} ${q.muisStalls === 1 ? 'stall' : 'stalls'} certified halal by MUIS`
  return [{ key: 'muis-halal', text: 'MUIS halal stalls', tone: 'halal', icon: '', title: day ? `${count}, checked ${day}` : count }]
}

// Why a searched place cannot be added for a dietary need. How to call: unfitDietText('halal') -> 'Halal not confirmed'
export const unfitDietText = (need) => `${capitalised(needWord(need))} not confirmed`
