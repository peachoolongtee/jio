// Each person's colour: the same on their map pin and their avatar, so you can tell who is who at a glance.
// The demo friends take the colours in order; anyone else gets one from their id.
import { PEOPLE } from './mock/people.js'

export const PERSON_COLOURS = 8

// 1 to PERSON_COLOURS: which --person-N colour someone has.
export function personIndex(id) {
  let n = PEOPLE.findIndex((p) => p.id === id)
  if (n < 0) {
    n = 0
    for (const c of String(id)) n = (n * 31 + c.charCodeAt(0)) % PERSON_COLOURS
  }
  return (n % PERSON_COLOURS) + 1
}

export function personColour(id) {
  return id ? `var(--person-${personIndex(id)})` : ''
}
