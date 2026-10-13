// scoring.js: turning a venue into numbers. Every factor is a PENALTY from 0 (best) to 100 (worst),
// so the LOWEST weighted score ranks first.
//
// Design choice: every factor uses an ABSOLUTE scale, never min-max stretched across the candidates.
// Min-max made a 12 vs 15 minute difference look like 0 vs 100 and drowned out everything else
// (a date-night ranking was led by a dim sum hall). Travel is measured against a ceiling instead:
// 0 minutes = 0, the ceiling (default 60) = 100.

import { forecastStateOf } from '../services/weather.js';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

// Defaults are starting points. Expose them as sliders and tune against your mock data.
// Two more factors exist but have NO default weight, so they only count when a caller asks for them:
//   crowd       (both engines) estimated crowd at the visit time, from the frontend's profiles
//   returnWorst (Converge)     the longest trip home from the venue; lastStop: true turns it on
// Occasion fit is one of the heaviest factors on purpose: "what suits a date / birthday / study session" is
// the product. With occasion at only 10, a venue that matched the group's cuisine beat one that fit the mood.
const DEFAULT_WEIGHTS = {
  converge: { worst: 25, mean: 5, occasion: 25, preference: 10, rating: 10, weather: 12, price: 8, cdc: 3, antiRepeat: 2 },
  roam:     { distance: 20, occasion: 25, preference: 10, rating: 12, weather: 18, price: 10, cdc: 3, antiRepeat: 2 },
};

/** Travel minutes as a penalty: 0 min = 0, ceilingMinutes or more = 100. Absolute, so tiny gaps stay tiny. */
const travelPenalty = (minutes, ceilingMinutes = 60) => clamp((100 * minutes) / ceilingMinutes, 0, 100);

/** Rescale to 0-100 across the set. All equal -> all 0. Only used for cheap pruning, not for final scores. */
function normalizeMinMax(values) {
  const lo = Math.min(...values), hi = Math.max(...values);
  return values.map(v => (hi === lo ? 0 : (100 * (v - lo)) / (hi - lo)));
}

/** Occasion fit 0-100 = sum of (profile weight x venue attribute). Higher is better. */
function computeOccasionFit(venue, profile) {
  return Math.round(Object.entries(profile.weights).reduce((s, [k, w]) => s + w * venue.attributes[k], 0));
}

/** Share of members who like this cuisine, minus those who dislike it. 0..1 */
function cuisineMatch(venue, members) {
  const likes = members.filter(m => (m.cuisineLikes ?? []).includes(venue.cuisine)).length;
  const dislikes = members.filter(m => (m.cuisineDislikes ?? []).includes(venue.cuisine)).length;
  return clamp((likes - dislikes) / members.length, 0, 1);
}

/** Members who want healthy food care about venue.diet.healthy (0-5); everyone else is neutral. 0..1 */
function healthMatch(venue, members) {
  if (venue.diet === null) return 1;
  return mean(members.map(m => (m.prefersHealthy ? venue.diet.healthy / 5 : 1)));
}

/** Soft taste preference: 70% cuisine, 30% healthiness. */
function preferencePenalty(venue, members) {
  return 100 * (1 - (0.7 * cuisineMatch(venue, members) + 0.3 * healthMatch(venue, members)));
}

/**
 * 0 if the price is within the group's average budget, rising as it goes over.
 * Members with no budget set (missing or 0) are left out of the average; if nobody set one,
 * price is not a concern (0). Without this, one missing budget made every score NaN.
 */
function pricePenalty(venue, members) {
  const budgets = members.map(m => m.budgetMaxPerPerson).filter(b => Number.isFinite(b) && b > 0);
  if (budgets.length === 0) return 0;
  const budget = mean(budgets);
  return clamp(((venue.avgPricePerPerson - budget) / budget) * 100, 0, 100);
}

/** rainRisk x (exposure / 5). A mall linked to the MRT (exposure 0) barely cares about rain. */
function weatherPenalty(venue, weatherByArea) {
  const w = weatherByArea[venue.forecastArea];
  return clamp(w.rainRisk * (venue.exposure / 5) * 100, 0, 100);
}

// ---------------------------------------------------------------- crowd (estimate)
// How busy each kind of place is through the day, 0 to 1, by hour.
// Ported from the frontend team's planner (frontend/src/lib/planner/crowd.js) so both sides agree.
const CROWD_PROFILES = {
  hawker: { 7: 0.5, 8: 0.6, 11: 0.8, 12: 1, 13: 0.9, 14: 0.5, 15: 0.3, 16: 0.3, 17: 0.5, 18: 0.9, 19: 1, 20: 0.7, 21: 0.4 },
  restaurant: { 11: 0.5, 12: 0.9, 13: 0.8, 14: 0.4, 15: 0.2, 16: 0.2, 17: 0.4, 18: 0.8, 19: 1, 20: 0.8, 21: 0.5 },
  cafe: { 8: 0.5, 9: 0.6, 10: 0.7, 11: 0.8, 12: 0.8, 13: 0.9, 14: 1, 15: 1, 16: 0.9, 17: 0.6, 18: 0.4, 19: 0.3 },
  dessert: { 13: 0.5, 14: 0.7, 15: 0.9, 16: 0.9, 17: 0.6, 18: 0.5, 19: 0.7, 20: 0.9, 21: 1, 22: 0.8 },
  bar: { 17: 0.3, 18: 0.5, 19: 0.6, 20: 0.8, 21: 1, 22: 1, 23: 0.8 },
  mall: { 10: 0.3, 11: 0.4, 12: 0.6, 13: 0.7, 14: 0.8, 15: 0.9, 16: 0.9, 17: 0.9, 18: 1, 19: 1, 20: 0.8, 21: 0.5 },
  market: { 11: 0.4, 12: 0.6, 13: 0.7, 14: 0.8, 15: 0.9, 16: 0.9, 17: 0.9, 18: 1, 19: 1, 20: 0.8, 21: 0.6 },
  park: { 7: 0.6, 8: 0.5, 9: 0.4, 10: 0.3, 15: 0.3, 16: 0.5, 17: 0.8, 18: 1, 19: 0.8, 20: 0.4 },
  museum: { 10: 0.4, 11: 0.6, 12: 0.7, 13: 0.8, 14: 1, 15: 1, 16: 0.9, 17: 0.6, 18: 0.4 },
  cinema: { 11: 0.2, 13: 0.4, 15: 0.5, 17: 0.6, 19: 0.9, 20: 1, 21: 1, 22: 0.7 },
  library: { 10: 0.4, 11: 0.5, 14: 0.8, 15: 0.9, 16: 0.9, 17: 0.7, 19: 0.5, 20: 0.3 },
  sports: { 7: 0.7, 8: 0.6, 9: 0.5, 15: 0.5, 16: 0.7, 17: 0.9, 18: 1, 19: 0.9, 20: 0.6 },
  attraction: { 9: 0.4, 10: 0.6, 11: 0.8, 12: 0.8, 13: 0.9, 14: 1, 15: 1, 16: 0.9, 17: 0.7, 18: 0.5 },
};

/**
 * Estimated crowd 0 (empty) to 1 (packed) at an hour, or null when we cannot tell.
 * Needs the venue's kind and popularity (only the curated venues have both). Between listed hours it uses
 * the nearest earlier hour x 0.8; before the first listed hour it assumes quiet (0.2), like the frontend.
 */
function crowdEstimate(venue, hour) {
  const profile = CROWD_PROFILES[venue.kind];
  if (!profile || typeof venue.popularity !== 'number') return null;
  const earlier = Object.keys(profile).map(Number).filter(h => h < hour);
  const level = hour in profile ? profile[hour] : earlier.length ? profile[Math.max(...earlier)] * 0.8 : 0.2;
  return venue.popularity * level;
}

/** Crowd as a penalty 0-100. Unknown is neutral (50), like an unknown rating. */
function crowdPenalty(venue, hour) {
  const c = crowdEstimate(venue, hour);
  return c === null ? 50 : clamp(c * 100, 0, 100);
}

/** The label the UI shows, always as an estimate: same thresholds as the frontend. */
function crowdLevel(venue, hour) {
  const c = crowdEstimate(venue, hour);
  if (c === null) return 'unknown';
  return c < 0.4 ? 'quiet' : c < 0.7 ? 'moderate' : 'busy';
}

// ---------------------------------------------------------------- option labels for the UI
// Rain is "likely" from 0.6, and a venue is exposed from exposure 2: the same thresholds as rainCheck().
const RAIN_LIKELY = 0.6, RAIN_EXPOSED = 2;

/** Rain is likely where this venue is. */
const rainLikelyAt = (venue, weatherByArea) => weatherByArea[venue.forecastArea].rainRisk >= RAIN_LIKELY;

/**
 * What the weather is where this venue is, for a screen: { state, phrase, rainLikely }.
 *   state       'dry' | 'cloudy' | 'showers' | 'thundery' | 'unknown'. From the forecast sentence when the entry has
 *               one; for a simulated case (no sentence) 'showers' when rain is likely and 'dry' otherwise; 'unknown'
 *               when the entry says so (weather has no effect on this ranking).
 *   phrase      the weather service's own sentence, or null when there is none (simulated, or no forecast)
 *   rainLikely  the same test as rainWarning's first half
 *
 * How to call:
 *   weatherOf(venue, data.weatherCases.live) // { state: 'thundery', phrase: 'Thundery Showers', rainLikely: true }
 */
const weatherOf = (venue, weatherByArea) => {
  const w = weatherByArea[venue.forecastArea];
  if (!w) return { state: 'unknown', phrase: null, rainLikely: false };
  const phrase = typeof w.forecast === 'string' ? w.forecast : null;
  const state = w.state ?? (phrase ? forecastStateOf(phrase).state : w.rainRisk >= RAIN_LIKELY ? 'showers' : 'dry');
  return { state, phrase, rainLikely: w.rainRisk >= RAIN_LIKELY };
};

/** Rain is likely AND the venue is open-air or a long walk from shelter: show a rain warning and an indoor swap. */
const rainWarning = (venue, weatherByArea) =>
  rainLikelyAt(venue, weatherByArea) && venue.setting !== 'indoor' && venue.exposure >= RAIN_EXPOSED;

// Can this venue's price back a claim such as "Budget friendly" or "within budget"? A typical price for a kind of
// place (dataQuality.priceAssumed) is a guess: every OneMap attraction is given the same figure, ticketed or free, and
// every CDC food site is given $5 or $6 whatever its stalls charge. A guessed price makes no claim for any place,
// whatever its source (the lead's decision of 11 October 2026). The price still counts in the score and in the
// max_price_pp filter; only the words that call a place cheap or within budget need a price that is known.
//
// How to call:
//   priceIsKnown({ avgPricePerPerson: 15, source: 'onemap', dataQuality: { priceAssumed: true } })   // false
//   priceIsKnown({ avgPricePerPerson: 6, source: 'cdc', dataQuality: { priceAssumed: true } })       // false
//   priceIsKnown({ avgPricePerPerson: 6 })                                                             // true
export function priceIsKnown(venue) {
  return !venue.dataQuality?.priceAssumed;
}

/**
 * Short reason tags under each option, the same ones and in the same order as the frontend planner
 * (scoreVenue in frontend/src/lib/planner/suggestions.js), at most two.
 * o: { venue, walkMinutes, crowd, rainy, homeMaxMinutes (last stop only, else null), time "HH:MM" }
 */
function reasonTags({ venue, walkMinutes, crowd, rainy, homeMaxMinutes = null, time }) {
  const tags = [];
  if (rainy && venue.setting === 'indoor') tags.push('Indoor');
  if (homeMaxMinutes !== null && homeMaxMinutes <= 35) tags.push('Easy trip home');
  if (venue.mrtWalkMinutes != null && venue.mrtWalkMinutes <= 5) tags.push('Near MRT');
  if (crowd === 'quiet') tags.push(`Quiet at ${time}`);
  if (walkMinutes <= 5) tags.push('Short walk');
  if ((venue.tags ?? []).includes('hidden')) tags.push('Hidden gem');
  if (venue.avgPricePerPerson < 10 && priceIsKnown(venue)) tags.push('Budget friendly');
  return tags.slice(0, 2);
}

/** Unknown rating (e.g. CDC stalls) is neutral (50): not a reward, not a punishment. */
const ratingPenalty = venue => (venue.rating === null || venue.rating === undefined ? 50 : clamp(100 - venue.rating * 20, 0, 100));
const cdcPenalty = venue => (venue.cdcAccepted ? 0 : 100);

/** 100 if visited within 14 days, falling linearly to 0 at 60 days. Dates are "YYYY-MM-DD". */
function antiRepeatPenalty(venueId, history, { today, groupId = null }) {
  const day = d => Date.parse(`${d}T00:00:00Z`) / 86400000;
  const gaps = history
    .filter(h => h.venueId === venueId && (groupId === null || h.groupId === groupId))
    .map(h => day(today) - day(h.date))
    .filter(g => g >= 0);
  if (gaps.length === 0) return 0;
  const gap = Math.min(...gaps);
  if (gap <= 14) return 100;
  if (gap >= 60) return 0;
  return (100 * (60 - gap)) / 46;
}

/**
 * Weighted average of penalties. Weights do not need to sum to 100: they are divided by their total,
 * so a slider can move freely. Returns the score AND a breakdown (used by the explanation).
 */
function combine(factors, weights) {
  let num = 0, den = 0;
  for (const [k, w] of Object.entries(weights)) {
    if (!w) continue;
    if (factors[k] === undefined) throw new Error(`combine: missing factor "${k}"`);
    num += w * factors[k];
    den += w;
  }
  const breakdown = {};
  for (const [k, w] of Object.entries(weights)) {
    if (w) breakdown[k] = { value: factors[k], weight: w, contribution: (w * factors[k]) / den };
  }
  return { score: den === 0 ? 0 : num / den, breakdown };
}

/**
 * One human sentence. Picks up to two strengths (in order of how much we weight them),
 * and adds a caution if something is genuinely wrong.
 * row: { venue, factors, weights, worstMinutes?, travelMinutes?, hasHistory }
 */
function explain(row, occasionLabel = 'meetup') {
  const { venue: v, factors: f, weights: w } = row;
  const strengths = [];
  // Priority order, not weight order: lead with WHY it suits the occasion, then travel.
  const add = (key, ok, text) => { if (ok && w[key]) strengths.push(text); };
  add('occasion', f.occasion <= 40, `a good fit for a ${occasionLabel.toLowerCase()}`);
  if (row.worstMinutes !== undefined) add('worst', true, `${Math.round(row.worstMinutes)} min for whoever travels furthest`);
  if (row.travelMinutes !== undefined) add('distance', true, `${Math.round(row.travelMinutes)} min away`);
  add('rating', f.rating <= 20 && v.rating != null, `rated ${v.rating}`);
  add('preference', f.preference <= 50, "suits the group's tastes");
  add('cdc', v.cdcAccepted, 'accepts CDC vouchers');
  add('price', f.price === 0 && priceIsKnown(v), 'within budget');
  add('weather', f.weather <= 15 && v.exposure === 0, 'sheltered from rain');
  add('antiRepeat', f.antiRepeat === 0 && row.hasHistory, 'somewhere new for the group');

  const top = strengths.slice(0, 2);
  const cautions = [];
  if (f.weather >= 40) cautions.push('rain risk is high for an open-air venue');
  if (f.antiRepeat >= 50) cautions.push('the group went here recently');
  let text = top.length ? top.join(' and ') : 'best overall balance';
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return cautions.length ? `${text}. Caution: ${cautions.join(', ')}.` : `${text}.`;
}

/**
 * "Picking X instead would add N minutes to Y's journey."
 * popular = the venue with the lowest MEAN travel time (what a plain "closest to everyone" app picks).
 * We compare the same person's travel to the popular pick vs our recommendation, so the sentence is exact.
 * rows must be sorted best-first and carry travelByMember and meanRaw. Returns null when there is no regret.
 */
function regretCounterfactual(rows, memberNames = {}) {
  if (rows.length < 2) return null;
  const rec = rows[0];
  const popular = [...rows].sort((a, b) => a.meanRaw - b.meanRaw)[0];
  if (popular.venue.id === rec.venue.id) return null;
  const worstId = Object.entries(popular.travelByMember).sort((a, b) => b[1] - a[1])[0][0];
  // Rounded BEFORE the check, so a 0.3 minute gap is not shown as "would add 0 minutes".
  const extra = Math.round(popular.travelByMember[worstId] - rec.travelByMember[worstId]);
  if (extra < 1) return null;
  const name = memberNames[worstId] ?? worstId;
  return {
    popularChoiceId: popular.venue.id, memberId: worstId, extraMinutes: extra,
    text: `Picking ${popular.venue.name} instead would add ${extra} ${extra === 1 ? 'minute' : 'minutes'} to ${name}'s journey.`,
  };
}

/**
 * Pareto front (minimise every key): venues that no other venue beats on ALL keys at once.
 * An alternative to one weighted sum: it shows the real trade-offs without choosing weights.
 */
function paretoFront(items, keys) {
  const dominates = (a, b) => keys.every(k => a[k] <= b[k]) && keys.some(k => a[k] < b[k]);
  return items.filter(x => !items.some(y => y !== x && dominates(y, x)));
}

export {
  DEFAULT_WEIGHTS, travelPenalty, normalizeMinMax, computeOccasionFit, cuisineMatch, healthMatch, preferencePenalty,
  pricePenalty, weatherPenalty, ratingPenalty, cdcPenalty, antiRepeatPenalty, combine, explain,
  regretCounterfactual, paretoFront, crowdEstimate, crowdPenalty, crowdLevel, rainLikelyAt, rainWarning, reasonTags, weatherOf, RAIN_LIKELY, RAIN_EXPOSED,
};
