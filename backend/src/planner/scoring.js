// scoring.js: turning a venue into numbers. Every factor is a PENALTY from 0 (best) to 100 (worst),
// so the LOWEST weighted score ranks first.
//
// Design choice: every factor uses an ABSOLUTE scale, never min-max stretched across the candidates.
// Min-max made a 12 vs 15 minute difference look like 0 vs 100 and drowned out everything else
// (a date-night ranking was led by a dim sum hall). Travel is measured against a ceiling instead:
// 0 minutes = 0, the ceiling (default 60) = 100.

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

// Defaults are starting points. Expose them as sliders and tune against your mock data.
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
  add('price', f.price === 0, 'within budget');
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
  const extra = popular.travelByMember[worstId] - rec.travelByMember[worstId];
  if (extra <= 0) return null;
  const name = memberNames[worstId] ?? worstId;
  return {
    popularChoiceId: popular.venue.id, memberId: worstId, extraMinutes: Math.round(extra),
    text: `Picking ${popular.venue.name} instead would add ${Math.round(extra)} minutes to ${name}'s journey.`,
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
  regretCounterfactual, paretoFront,
};
