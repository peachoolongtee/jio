// diversity.js: keeps a ranking from filling up with look-alikes (ticket #149).
//   - one place per building in a category's results: five stalls in one hotel food court are one outing, not five;
//   - Google as a top-up: at most 2 of the top 5 places in a category may be Google's, so places we already know
//     are not crowded out by whatever happens to be nearest.
// Both only reorder. Nothing is dropped: a place that loses its spot moves below the places that keep theirs.

export const MAX_GOOGLE_IN_TOP = 2;

const POSTCODE = /\b(\d{6})\b/;

// A unit number ("#01-40", "Unit 5", "B1-K3-29") is not part of the building.
const withoutUnit = text => text.replace(/#\s*[\w-]+/g, ' ').replace(/\b(unit|level|lvl)\s*[\w-]+/gi, ' ');

/**
 * Which building a venue is in, or null when we cannot tell (then it is its own building). A building is its postal
 * code; else its street number and street from the address, unit numbers ignored. Works on every source: the saved
 * places carry `postalCode`, Google's carry `address` ("9 Raffles Blvd, #01-40 Millenia Walk, Singapore 039596").
 *
 * How to call:
 *   buildingKey({ postalCode: '039596' })                           // 'p:039596'
 *   buildingKey({ address: '9 Raffles Blvd, #01-40 Millenia Walk, Singapore 039596' }) // 'p:039596'
 *   buildingKey({ address: '21 Canberra Link' })                    // 's:21 canberra link'
 *   buildingKey({ area: 'Tiong Bahru' })                            // null
 */
export function buildingKey(venue) {
  const postal = String(venue.postalCode ?? venue.postal ?? '').match(POSTCODE)?.[1] ?? String(venue.address ?? venue.area ?? '').match(/Singapore\s*(\d{6})\b/i)?.[1];
  if (postal) return `p:${postal}`;
  const first = withoutUnit(String(venue.address ?? '')).split(',')[0].toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /^\d+[a-z]?\s+[a-z]/.test(first) ? `s:${first}` : null;
}

/**
 * Puts at most one place per building (and category) first, in the order given; the others follow, also in order.
 * `rows` are best first and each has `.venue`.
 *
 * How to call:
 *   onePerBuilding(rows) // the same rows, a second stall at an address already shown moved below the rest
 */
export function onePerBuilding(rows) {
  const seen = new Set();
  const first = [], later = [];
  for (const r of rows) {
    const b = buildingKey(r.venue);
    const key = b === null ? null : `${r.venue.category}|${b}`;
    if (key !== null && seen.has(key)) later.push(r);
    else {
      if (key !== null) seen.add(key);
      first.push(r);
    }
  }
  return [...first, ...later];
}

/**
 * Keeps Google to `max` of the first `top` places in each category: a Google place beyond that moves below the rest. A
 * place we already know is never moved.
 *
 * How to call:
 *   capGoogle(rows, 5, 2) // rows best first; the 3rd Google place of a category that would be in its top 5 drops down
 */
export function capGoogle(rows, top = 5, max = MAX_GOOGLE_IN_TOP) {
  const placed = {}, google = {};
  const kept = [], moved = [];
  for (const r of rows) {
    const cat = r.venue.category;
    const isGoogle = r.venue.source === 'google';
    placed[cat] ??= 0;
    google[cat] ??= 0;
    if (isGoogle && placed[cat] < top && google[cat] >= max) {
      moved.push(r);
      continue;
    }
    placed[cat] += 1;
    if (isGoogle) google[cat] += 1;
    kept.push(r);
  }
  return [...kept, ...moved];
}

/** Both rules, in the order they apply: one place per building, then the Google cap. */
export const diversify = (rows, top = 5) => capGoogle(onePerBuilding(rows), top);
