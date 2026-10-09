// hawker-closures.js: NEA's cleaning and repair closures for hawker centres.
//
// Every hawker centre shuts for a day or more each quarter for cleaning, and some shut for weeks for repairs.
// NEA publishes the dates (data.gov.sg dataset "Dates of Hawker Centres Closure"). Without them, Jio would send a
// group to a centre that is shut that day. This file reads the dataset and attaches the closures to venues;
// filters.js then leaves a venue out on its closed days (reason 'closed_for_cleaning').
//
// Data: National Environment Agency, via data.gov.sg, used under the Singapore Open Data Licence.
// Fetched by backend/scripts/build-onemap-places.js.

import { haversineKm } from './geo.js';
import { nameSimilarity } from './cdc-adapter.js';

/** "30/3/2026" -> "2026-03-30". "NA", "TBC" or anything else that is not a date -> null. */
function isoDate(text) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(text ?? '').trim());
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

/**
 * The dataset's rows -> [{ name, lat, lng, periods: [{ from, to, reason }] }]. Dates are "YYYY-MM-DD", both ends
 * included. A row with no location or no dated period is dropped.
 *
 * How to call:
 *   const closures = parseClosureRows(records)   // records from data.gov.sg's datastore_search
 *   closures[0].periods[0]                       // { from: '2026-03-30', to: '2026-03-31', reason: 'cleaning' }
 */
function parseClosureRows(records) {
  const out = [];
  for (const r of records) {
    const lat = Number(r.latitude_hc), lng = Number(r.longitude_hc);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const periods = [];
    for (const q of ['q1', 'q2', 'q3', 'q4']) {
      const from = isoDate(r[`${q}_cleaningstartdate`]), to = isoDate(r[`${q}_cleaningenddate`]);
      if (from && to) periods.push({ from, to, reason: 'cleaning' });
    }
    const from = isoDate(r.other_works_startdate), to = isoDate(r.other_works_enddate);
    if (from && to) periods.push({ from, to, reason: 'repairs' });
    if (periods.length) out.push({ name: String(r.name ?? '').trim(), lat, lng, periods });
  }
  return out;
}

/** Is the venue shut for cleaning or repairs on this day ("YYYY-MM-DD")? */
function isClosedOn(venue, date) {
  return (venue.closures ?? []).some(c => date >= c.from && date <= c.to);
}

/**
 * Gives every venue at a hawker centre that centre's closures, as venue.closures. A venue is "at" the centre when it
 * is a hawker place and either shares the centre's name or is within 100 m of it. A large CDC site at the centre
 * counts too: the whole centre shuts, so its stalls do.
 *
 * How to call:
 *   const withClosures = attachClosures(venues, closures)
 */
function attachClosures(venues, closures, { meters = 100, minSimilarity = 0.6 } = {}) {
  // A CDC site counts only when it is a large site (the centre itself): a small CDC cluster 80 m away is often a
  // coffee shop across the road, which stays open when the centre shuts.
  const atHawker = v => v.category === 'eat' && (v.source === 'cdc' ? v.siteKind === 'large_site' : v.kind === 'hawker' || v.cuisine === 'hawker');
  return venues.map(v => {
    if (!atHawker(v)) return v;
    const mine = closures.filter(c => haversineKm(v, c) * 1000 <= meters || nameSimilarity(v.name, c.name) >= minSimilarity && haversineKm(v, c) < 1);
    if (mine.length === 0) return v;
    return { ...v, closures: mine.flatMap(c => c.periods) };
  });
}

export { parseClosureRows, attachClosures, isClosedOn, isoDate };
