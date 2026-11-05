// balance.js: the "balanced" way to choose where a group meets, and the labelled choices a group can pick from.
//
// Today's rule (`rule: 'longest'`, the default) picks the place where the LONGEST trip is shortest, and looks at the gap between
// people, or at anyone's past travel, only when two places tie to the exact minute. That ignores the gap almost always, and it
// makes a person's past travel count for nothing. The balanced rule fixes both:
//   1. A person's trip counts as much as their past travel says: weight = 1 + debt / scale, at most 3 (so someone who travelled
//      a lot last time counts up to three times as much, and the point moves toward them). With no debt every weight is 1.
//   2. Start from today's pick (the shortest longest trip) and consider only places inside the hard cap (the longest real trip
//      within 35% or 10 minutes of the best) that are about as good as it on BOTH the longest weighted trip (within 5%, at
//      least 2 minutes) and the weighted average trip (within 10%, at least 3 minutes), so evening things out never costs the
//      group.
//   3. Of those, take the one with the smallest gap between the longest and shortest weighted trip; then the lower weighted
//      average; then the lower longest trip; then the order tried. Today's pick is always among them.
// So the rule changes today's pick only for a place that is about as good for the longest trip AND the average, and more even.
// (A first version let the gap decide among places up to 10% worse on the longest trip, and picked a place that cost three
// people 7 minutes each to save one person 4: see the docs.)
// Nothing here calls a service: it works on trip times that have already been measured (real or estimated).

export const BALANCE = {
  maxWeight: 3, // The most a person's past travel can multiply their trip.
  slack: 0.05, // How much longer than today's pick the longest weighted trip may be...
  slackMinutes: 2, // ...or this many minutes, whichever allows more.
  avgSlack: 0.10, // How much higher than today's pick the weighted AVERAGE trip may be (so evening out never costs the group)...
  avgSlackMinutes: 3, // ...or this many minutes, whichever allows more.
  capFactor: 1.35, // How much longer than the best the longest real trip may be...
  capMinutes: 10, // ...or this many minutes more, whichever allows more.
  gapWeight: 8, // Converge: the weight of the gap between people in a venue's score (beside `worst` at 25).
};

// Two minutes this close count as equal (floating point leaves dust in sums of weighted trips), so a tie falls through to the next key.
const TIE = 1e-9;

/**
 * A comparator that looks at each key in turn and moves to the next only when the two are equal within TIE. A negative result
 * means `x` comes first.
 *
 * How to call:
 *   [...places].sort(byKeys(s => s.m.gap, s => s.m.mean))
 */
const byKeys = (...keys) => (x, y) => {
  for (const key of keys) {
    const d = key(x) - key(y);
    if (Math.abs(d) > TIE) return d;
  }
  return 0;
};

/**
 * The longest real trip a place may have and still be considered: within BALANCE.capFactor or BALANCE.capMinutes of the best
 * longest real trip anywhere, whichever allows more.
 *
 * How to call:
 *   capFor(40) // 54 (40 x 1.35; 40 + 10 = 50 is less)
 */
const capFor = bestRealLongest => Math.max(bestRealLongest * BALANCE.capFactor, bestRealLongest + BALANCE.capMinutes);

/**
 * Each person's weight: 1 + past travel / scale, at most BALANCE.maxWeight. Someone who travelled MORE than their share weighs
 * more, so places nearer them win this time. No past travel (or a negative one) is 1.
 *
 * How to call:
 *   balanceWeights([{ travelDebtMinutes: 0 }, { travelDebtMinutes: 60 }, { travelDebtMinutes: 600 }]) // [1, 2, 3]
 */
export function balanceWeights(members, scaleMinutes = 60) {
  // A scale that is not a positive number would make the weights meaningless (negative, or NaN that poisons every comparison).
  const scale = Number.isFinite(scaleMinutes) && scaleMinutes > 0 ? scaleMinutes : 60;
  return members.map(m => {
    const debt = typeof m.travelDebtMinutes === 'number' && Number.isFinite(m.travelDebtMinutes) ? m.travelDebtMinutes : 0;
    return Math.min(BALANCE.maxWeight, 1 + Math.max(0, debt) / scale);
  });
}

/**
 * The numbers the rule compares for one set of trips (minutes, one per person) and the people's weights.
 *   burdens  each trip times its person's weight
 *   longest  the longest weighted trip     gap  the longest minus the shortest weighted trip
 *   mean     the weighted average of the real trips     realLongest  the longest real trip
 *
 * How to call:
 *   measure([18, 41, 41], [1, 1, 1]) // { burdens: [18, 41, 41], longest: 41, gap: 23, mean: 33.33, realLongest: 41 }
 */
export function measure(travel, weights) {
  const w = travel.map((_, i) => weights[i] ?? 1); // a person with no weight counts once
  const burdens = travel.map((t, i) => t * w[i]);
  const wSum = w.reduce((a, b) => a + b, 0);
  return {
    burdens,
    longest: Math.max(...burdens),
    gap: Math.max(...burdens) - Math.min(...burdens),
    mean: travel.reduce((s, t, i) => s + w[i] * t, 0) / wSum,
    realLongest: Math.max(...travel),
  };
}

// The measured places, each with its numbers, in three groups:
//   allowed   inside the cap, and no worse than the BASELINE on the longest trip or on the average (within a little)
//   capped    inside the cap but worse than the baseline on one of them
//   beyond    outside the cap: never chosen while any place is inside it
// The baseline is today's pick: the place inside the cap with the shortest longest (weighted) trip, then the lower average. It
// is always allowed, so the rule can only keep it or swap it for a place that is about as good for the longest trip AND for the
// average. The cap is on the longest REAL trip, against the best real longest trip anywhere: a hard limit, so past travel and
// the gap can move the choice only among places that keep everyone's trip reasonable.
function classify(entries, weights) {
  // A place with a trip that is not a number cannot be compared: it is left out (never chosen, listed last).
  const usable = entries.filter(e => e.j.travel.every(t => Number.isFinite(t)));
  const scored = usable.map(e => ({ e, m: measure(e.j.travel, weights) }));
  if (scored.length === 0) return { allowed: [], capped: [], beyond: [], unusable: entries };
  const bestReal = Math.min(...scored.map(s => s.m.realLongest));
  const inCap = scored.filter(s => s.m.realLongest <= capFor(bestReal) + 1e-9); // never empty: the best real longest trip qualifies
  const baseline = inCap.reduce((b, s) => byBaseline(s, b) < 0 ? s : b);
  const longestOk = baseline.m.longest + Math.max(baseline.m.longest * BALANCE.slack, BALANCE.slackMinutes);
  const meanOk = baseline.m.mean + Math.max(baseline.m.mean * BALANCE.avgSlack, BALANCE.avgSlackMinutes);
  const allowed = inCap.filter(s => s === baseline || (s.m.longest <= longestOk + 1e-9 && s.m.mean <= meanOk + 1e-9));
  return { allowed, capped: inCap.filter(s => !allowed.includes(s)), beyond: scored.filter(s => !inCap.includes(s)), unusable: entries.filter(e => !usable.includes(e)) };
}

// Ties are decided within TIE, and a tie on every key keeps the order tried (the sorts are stable).
const byGap = byKeys(x => x.m.gap, x => x.m.mean, x => x.m.longest);
const byLongest = byKeys(x => x.m.longest, x => x.m.gap, x => x.m.mean);
const byBaseline = byKeys(x => x.m.longest, x => x.m.mean); // today's pick: the shortest longest trip, then the lower average

/**
 * The measured places in the order the balanced rule prefers them: the ones inside the cap and near the best first, smallest gap
 * first (then the lower weighted average, then the lower longest trip); then the rest of those inside the cap, and last those
 * outside it, each by their longest trip. `entries` are
 * { j: { travel: [minutes per person] } } in the order they were tried. The first is what pickBalanced picks.
 *
 * How to call:
 *   rankBalanced(evaluated, balanceWeights(members)).slice(0, 3) // the chosen place and two runners-up
 */
export function rankBalanced(entries, weights) {
  if (entries.length === 0) return [];
  const { allowed, capped, beyond, unusable } = classify(entries, weights);
  return [...[...allowed].sort(byGap), ...[...capped].sort(byLongest), ...[...beyond].sort(byLongest)].map(s => s.e).concat(unusable);
}

/**
 * Which of the measured places the balanced rule picks, or null for no places: today's pick, or a more even place that is
 * about as good for the longest trip and the average.
 *
 * How to call:
 *   pickBalanced(evaluated, balanceWeights(members)) // the { a, j } of the chosen area
 */
export function pickBalanced(entries, weights) {
  const first = rankBalanced(entries, weights)[0] ?? null;
  return first && first.j.travel.every(t => Number.isFinite(t)) ? first : null; // null: nothing could be compared
}

/**
 * The labelled choices a group can pick between, from the places that were measured:
 *   shortest_longest_trip  today's rule: the place where the longest trip is shortest (then the lower average)
 *   most_balanced          the balanced rule above
 *   lowest_average         the lowest average of everyone's real trips (the figure the answer shows as `meanMinutes`, past travel
 *                          does not enter), among the places inside the same cap as the balanced pick: a place that is cheap
 *                          on average because one person travels far is not offered
 * A place that wins more than one label comes once, with every label. Each choice says every person's trip, the longest, the
 * average and the gap between the longest and the shortest (real minutes).
 *
 * How to call:
 *   choicesOf(evaluated, members, balanceWeights(members), (a, j) => ({ area: {...}, approximate: j.approximate }))
 */
export function choicesOf(allEntries, members, weights, describe) {
  const entries = allEntries.filter(e => e.j.travel.every(t => Number.isFinite(t))); // a place with no usable trip cannot be offered
  if (entries.length === 0) return [];
  const real = e => measure(e.j.travel, e.j.travel.map(() => 1));
  const pick = (cmp, from = entries) => from.reduce((b, e) => (cmp(e, b) < 0 ? e : b));
  const shortest = pick(byKeys(e => e.j.worst, e => e.j.fairMean));
  const balanced = pickBalanced(entries, weights);
  const cap = capFor(Math.min(...entries.map(e => real(e).realLongest)));
  const lowest = pick(byKeys(e => real(e).mean, e => e.j.worst), entries.filter(e => real(e).realLongest <= cap + 1e-9)); // never empty: the best real longest trip qualifies
  const labelled = [['shortest_longest_trip', shortest], ['most_balanced', balanced], ['lowest_average', lowest]];
  const out = [];
  for (const [label, entry] of labelled) {
    if (!entry) continue;
    const have = out.find(c => c.entry === entry);
    if (have) { have.labels.push(label); continue; }
    out.push({ entry, labels: [label] });
  }
  return out.map(({ entry, labels }) => {
    const m = real(entry);
    return {
      labels,
      ...describe(entry.a, entry.j),
      worstMinutes: m.realLongest,
      meanMinutes: entry.j.travel.reduce((a, b) => a + b, 0) / entry.j.travel.length,
      gapMinutes: Math.max(...entry.j.travel) - Math.min(...entry.j.travel),
      travelByMember: Object.fromEntries(members.map((mm, i) => [mm.id, entry.j.travel[i]])),
    };
  });
}
