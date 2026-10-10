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
import { nameSimilarity, withinSingapore } from './cdc-adapter.js';

/**
 * "30/3/2026" -> "2026-03-30". "NA", "TBC" or anything else that is not a date -> null.
 *
 * How to call:
 *   isoDate('30/3/2026') // '2026-03-30'
 *   isoDate('NA')        // null
 */
function isoDate(text) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(text ?? '').trim());
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

/** A coordinate cell as a number, or null when it is blank, not a number or not given ("" would be 0 with Number()). */
const coordinate = cell => (cell === null || cell === undefined || String(cell).trim() === '' ? null : Number.isFinite(Number(cell)) ? Number(cell) : null);

/**
 * The dataset's rows -> the centres with dated closures, plus the rows that were left out and why.
 * A row is left out when its location is blank, not a number or not in Singapore ('no_location'), or when it has no
 * dated period ('no_dates').
 *
 * How to call:
 *   const { closures, dropped } = parseClosureReport(records)   // dropped: [{ name, reason }]
 */
function parseClosureReport(records) {
  const closures = [], dropped = [];
  for (const r of records) {
    const name = String(r.name ?? '').trim();
    const lat = coordinate(r.latitude_hc), lng = coordinate(r.longitude_hc);
    if (lat === null || lng === null || !withinSingapore({ lat, lng })) { dropped.push({ name, reason: 'no_location' }); continue; }
    const periods = [];
    for (const q of ['q1', 'q2', 'q3', 'q4']) {
      const from = isoDate(r[`${q}_cleaningstartdate`]), to = isoDate(r[`${q}_cleaningenddate`]);
      if (from && to) periods.push({ from, to, reason: 'cleaning' });
    }
    const from = isoDate(r.other_works_startdate), to = isoDate(r.other_works_enddate);
    if (from && to) periods.push({ from, to, reason: 'repairs' });
    if (periods.length) closures.push({ name, lat, lng, periods });
    else dropped.push({ name, reason: 'no_dates' });
  }
  return { closures, dropped };
}

/**
 * The dataset's rows -> [{ name, lat, lng, periods: [{ from, to, reason }] }]. Dates are "YYYY-MM-DD", both ends
 * included. A row with no usable location (blank, not a number, outside Singapore) or no dated period is dropped.
 *
 * How to call:
 *   const closures = parseClosureRows(records)   // records from data.gov.sg's datastore_search
 *   closures[0].periods[0]                       // { from: '2026-03-30', to: '2026-03-31', reason: 'cleaning' }
 */
function parseClosureRows(records) {
  return parseClosureReport(records).closures;
}

/**
 * Is the venue shut for cleaning or repairs on this day ("YYYY-MM-DD")?
 *
 * How to call:
 *   isClosedOn(venue, '2026-10-12') // true when one of venue.closures covers that day
 */
function isClosedOn(venue, date) {
  return (venue.closures ?? []).some(c => date >= c.from && date <= c.to);
}

// ---------------------------------------------------------------- which centre is which row
// A name written five ways: "Redhill Lane Blk 79 (Redhill Market)", "Redhill Lane Blk 79", "Redhill Market".
const plain = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
/**
 * The ways one name can be written: the whole, the part before a closing bracket, and the part inside it.
 *
 * How to call:
 *   nameVariants('Redhill Lane Blk 79 (Redhill Market)') // [whole, 'Redhill Lane Blk 79', 'Redhill Market']
 */
function nameVariants(...names) {
  const out = new Set();
  for (const name of names) {
    if (!name) continue;
    out.add(String(name));
    const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(String(name));
    if (m) { out.add(m[1]); out.add(m[2]); }
  }
  return [...out];
}
const nameKeys = (...names) => new Set(nameVariants(...names).map(plain).filter(Boolean));
/** The best word overlap between any way of writing the venue's name and any way of writing the row's. */
const likeness = (v, c) => Math.max(0, ...nameVariants(v.name, v.officialName).flatMap(a => nameVariants(c.name).map(b => nameSimilarity(a, b))));

/** Is the venue a hawker place that NEA's list could have a row for? A CDC site counts only when it is a large site. */
// A small CDC cluster 80 m away is often a coffee shop across the road, which stays open when the centre shuts.
const atHawker = v => v.category === 'eat' && (v.source === 'cdc' ? v.siteKind === 'large_site' : v.kind === 'hawker' || v.cuisine === 'hawker');
// A OneMap hawker venue comes from the same NEA list as the closure rows, so it has a row of its own, not a neighbour's.
const fromNeaList = v => v.source === 'onemap' && v.kind === 'hawker';

/**
 * Which closure row belongs to which venue: at most one row per venue, the best match.
 *   1. the same name (whole, without the bracket, or the bracket alone), or coordinates within `sameSpotMeters`;
 *   2. a OneMap hawker venue whose name is only worded differently ("The Hawker Centre @ Our Tampines Hub"): the nearest
 *      row within `meters` that no other OneMap hawker venue has taken and whose name is at least `minSimilarity` alike;
 *   3. any other hawker venue (a curated centre, a large CDC site): the nearest row within `meters`, or within `namedMeters`
 *      when its name is at least `minSimilarity` alike (curated "Kovan 209 Market" is 143 m from NEA's "Hougang Street 21
 *      Blk 209 (Kovan Hougang Market and Food Centre)").
 * Neighbouring blocks (Redhill Blk 79 and 85, 60 m apart) therefore never share a row.
 *
 * How to call:
 *   const { rows, unmatched } = matchClosureRows(venues, closures)  // rows: Map(venue -> closure row)
 */
function matchClosureRows(venues, closures, { meters = 100, sameSpotMeters = 10, minSimilarity = 0.5, namedMeters = 150 } = {}) {
  const rows = new Map();
  const claimed = new Set();
  const hawkers = venues.filter(atHawker);
  const rowKeys = new Map(closures.map(c => [c, nameKeys(c.name)]));
  const meetsName = (v, c) => { const mine = nameKeys(v.name, v.officialName); for (const k of rowKeys.get(c)) if (mine.has(k)) return true; return false; };
  const metersTo = (v, c) => haversineKm(v, c) * 1000;

  // Pass 1: exact matches (a name, or the same spot). A name may match a row in another part of the island (two
  // "Market Street" centres), so the name counts only within 1 km.
  for (const v of hawkers) {
    let best = null;
    for (const c of closures) {
      const d = metersTo(v, c);
      const exact = (d <= 1000 && meetsName(v, c)) || d <= sameSpotMeters;
      if (exact && (!best || d < best.d)) best = { c, d };
    }
    if (best) { rows.set(v, best.c); if (fromNeaList(v)) claimed.add(best.c); }
  }
  // Pass 2: the rest.
  for (const v of hawkers) {
    if (rows.has(v)) continue;
    let best = null;
    for (const c of closures) {
      const d = metersTo(v, c);
      const alike = d <= namedMeters && likeness(v, c) >= minSimilarity;
      if (fromNeaList(v)) {
        if (claimed.has(c) || !alike || d > meters) continue;
      } else if (d > meters && !alike) continue; // other lists place a centre up to 150 m off, and say so in its name
      if (!best || d < best.d) best = { c, d };
    }
    if (best) { rows.set(v, best.c); if (fromNeaList(v)) claimed.add(best.c); }
  }
  const used = new Set(rows.values());
  return { rows, unmatched: closures.filter(c => !used.has(c)) };
}

/**
 * Gives every hawker venue the closures of its centre, as venue.closures (and the row's name as venue.closuresFrom).
 * See matchClosureRows for which row is whose. A large CDC site at the centre counts too: the whole centre shuts, so
 * its stalls do.
 *
 * How to call:
 *   const withClosures = attachClosures(venues, closures)
 */
function attachClosures(venues, closures, options) {
  const { rows } = matchClosureRows(venues, closures, options);
  return venues.map(v => (rows.has(v) ? { ...v, closures: rows.get(v).periods, closuresFrom: rows.get(v).name } : v));
}

// ---------------------------------------------------------------- how far the dates reach
/**
 * The first and last day any saved period covers, and the last cleaning day (the date the data goes stale on).
 * null when there are no periods.
 *
 * How to call:
 *   closureCoverage(closures) // { from: '2026-01-05', to: '2026-12-31', lastCleaning: '2026-12-31', rows: 123, periods: 480 }
 */
function closureCoverage(closures) {
  const periods = closures.flatMap(c => c.periods);
  if (periods.length === 0) return null;
  const max = xs => xs.reduce((a, b) => (a > b ? a : b));
  const cleaning = periods.filter(p => p.reason === 'cleaning');
  return {
    from: periods.map(p => p.from).reduce((a, b) => (a < b ? a : b)),
    to: max(periods.map(p => p.to)),
    lastCleaning: max((cleaning.length ? cleaning : periods).map(p => p.to)),
    rows: closures.length, periods: periods.length,
  };
}

const REBUILD_COMMAND = 'pnpm build:onemap-places (run in backend/)';
const STALE_WITHIN_DAYS = 30;

/**
 * A sentence for the log when the closure dates are used up or nearly so, else null. `today` is "YYYY-MM-DD".
 * After the last cleaning date every centre looks open on its cleaning days, silently, so this says so.
 *
 * How to call:
 *   closureStaleWarning(closureCoverage(closures), '2027-01-05') // 'Hawker closure dates end 2026-12-31 ...'
 *   closureStaleWarning(closureCoverage(closures), '2026-10-11') // null
 */
function closureStaleWarning(coverage, today) {
  if (!coverage) return `No hawker closure dates are loaded, so every centre looks open on its cleaning days. Rebuild with ${REBUILD_COMMAND}.`;
  const day = d => Date.parse(`${d}T00:00:00Z`) / 86400000;
  const left = day(coverage.lastCleaning) - day(today);
  if (left >= 0 && left > STALE_WITHIN_DAYS) return null;
  const when = left < 0 ? `ended ${coverage.lastCleaning}, ${-left} day${-left === 1 ? '' : 's'} ago` : `end ${coverage.lastCleaning}, in ${left} day${left === 1 ? '' : 's'}`;
  return `Hawker closure dates ${when}: after that every centre looks open on its cleaning days. Rebuild with ${REBUILD_COMMAND}.`;
}

export { parseClosureRows, parseClosureReport, attachClosures, matchClosureRows, isClosedOn, isoDate, closureCoverage, closureStaleWarning, REBUILD_COMMAND };
