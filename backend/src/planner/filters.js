// filters.js: hard-constraint filtering shared by Converge and Roam.
// A venue is ALLOWED or REJECTED here. No scoring happens in this file.

/** "14:30" -> 870. "24:00" -> 1440, so midnight closing works. */
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Local clock minutes from "YYYY-MM-DDTHH:MM". Sliced, not parsed, so the machine time zone cannot shift it. */
function minutesOfDay(dateTime) {
  return toMinutes(dateTime.slice(11, 16));
}

/**
 * Open if the time falls in any range. Split hours (12:00-14:30 and 18:00-22:30) are normal.
 * A range whose close is not after its open (22:00-02:00) runs past midnight: open late at night
 * OR early in the morning. Without this, supper places were always treated as closed.
 */
function isOpenAt(venue, dateTime) {
  const t = minutesOfDay(dateTime);
  return venue.openingHours.some(([open, close]) => {
    const o = toMinutes(open), c = toMinutes(close);
    return c > o ? t >= o && t < c : t >= o || t < c;
  });
}

/** Which meal period is it? Used so we do not suggest a lunch-only place at 3pm. */
function mealPeriodAt(dateTime) {
  const t = minutesOfDay(dateTime);
  if (t >= toMinutes('04:00') && t < toMinutes('11:00')) return 'breakfast';
  if (t < toMinutes('14:30')) return t >= toMinutes('11:00') ? 'lunch' : 'supper';
  if (t < toMinutes('17:00')) return 'tea';
  if (t < toMinutes('21:30')) return 'dinner';
  return 'supper';
}

/**
 * Diet levels: 'full' | 'options' (verified) | 'likely' (inferred, e.g. from a stall name) | 'unknown' (no evidence) | 'none'.
 * Verified and 'likely' pass the hard filter ('likely' is flagged for the UI to verify). 'none' always fails.
 * 'unknown' fails by default (we will not claim halal without evidence) and passes only if unknownPolicy is 'lenient'.
 * Activities have diet = null and skip dietary filters.
 */
function meetsDiet(venue, need, unknownPolicy = 'strict') {
  if (venue.diet === null) return true;
  const level = venue.diet[need];
  if (['full', 'options', 'likely'].includes(level)) return true;
  return level === 'unknown' && unknownPolicy === 'lenient';
}

/** Which dietary needs are only 'likely' for this venue, so the UI can say "check the stall". */
function needsVerification(venue, members) {
  if (venue.diet === null) return [];
  const needs = [...new Set(members.flatMap(m => m.dietary ?? []))];
  return needs.filter(n => venue.diet[n] === 'likely');
}

// null = unknown. Strict (default): unknown fails a hard constraint. Lenient: unknown passes.
const SIMPLE_CONSTRAINTS = {
  step_free: (v, lenient) => (v.stepFree === null || v.stepFree === undefined ? lenient : v.stepFree === true),
  sockets: (v, lenient) => (v.sockets === null || v.sockets === undefined ? lenient : v.sockets === true),
  quiet: v => v.noise <= 2,
  indoor_only: v => v.setting === 'indoor',
};

/**
 * Every reason a venue fails (empty array = passes). We keep ALL reasons, not just the
 * first, so the UI can say what to relax.
 */
function rejectionReasons(venue, ctx) {
  const {
    members, groupConstraints = [], dateTime, categories = ['eat', 'drink'],
    excludeVenueIds = [], enforceMealPeriod = true, unknownPolicy = 'strict',
  } = ctx;
  const reasons = [];

  if (!categories.includes(venue.category)) reasons.push('category');
  if (excludeVenueIds.includes(venue.id)) reasons.push('excluded');

  const needs = [...new Set(members.flatMap(m => m.dietary ?? []))];
  for (const need of needs) if (!meetsDiet(venue, need, unknownPolicy)) reasons.push(`diet:${need}`);

  for (const c of groupConstraints) {
    if (c.startsWith('max_price_pp:')) {
      if (venue.avgPricePerPerson > Number(c.split(':')[1])) reasons.push('max_price');
    } else if (SIMPLE_CONSTRAINTS[c]) {
      if (!SIMPLE_CONSTRAINTS[c](venue, unknownPolicy === 'lenient')) reasons.push(c);
    } else {
      throw new Error(`filterByConstraints: unknown group constraint "${c}"`); // typos must not silently pass
    }
  }

  if (venue.maxGroupSize < members.length) reasons.push('capacity');
  if (!isOpenAt(venue, dateTime)) reasons.push('closed');
  if (enforceMealPeriod && venue.category === 'eat' && venue.mealPeriods.length > 0 &&
      !venue.mealPeriods.includes(mealPeriodAt(dateTime))) reasons.push('meal_period');

  return reasons;
}

/**
 * @param {object[]} venues
 * @param {{members:object[], groupConstraints?:string[], dateTime:string, categories?:string[],
 *          excludeVenueIds?:string[], enforceMealPeriod?:boolean, unknownPolicy?:'strict'|'lenient'}} ctx  members = ACTIVE members only
 * @returns {{passed:object[], rejected:{venue:object, reasons:string[]}[]}}
 */
function filterByConstraints(venues, ctx) {
  const passed = [], rejected = [];
  for (const venue of venues) {
    const reasons = rejectionReasons(venue, ctx);
    if (reasons.length === 0) passed.push(venue);
    else rejected.push({ venue, reasons });
  }
  return { passed, rejected };
}

/** Tally of rejection reasons, e.g. { 'diet:vegan': 23, max_price: 6 }. */
function countReasons(rejected) {
  const counts = {};
  for (const { reasons } of rejected) for (const r of reasons) counts[r] = (counts[r] || 0) + 1;
  return counts;
}

/**
 * "What should we relax?" For each group constraint and each dietary need, how many venues
 * would pass if we dropped just that one? Sorted best first. This is what the UI shows when
 * nothing passes, instead of a blank screen.
 */
function relaxationHints(venues, ctx) {
  const hints = [];
  for (const c of ctx.groupConstraints ?? []) {
    const next = { ...ctx, groupConstraints: ctx.groupConstraints.filter(x => x !== c) };
    hints.push({ drop: c, kind: 'constraint', passes: filterByConstraints(venues, next).passed.length });
  }
  const needs = [...new Set(ctx.members.flatMap(m => m.dietary ?? []))];
  for (const need of needs) {
    const members = ctx.members.map(m => ({ ...m, dietary: (m.dietary ?? []).filter(d => d !== need) }));
    hints.push({ drop: `diet:${need}`, kind: 'diet', passes: filterByConstraints(venues, { ...ctx, members }).passed.length });
  }
  return hints.sort((a, b) => b.passes - a.passes);
}

export {
  filterByConstraints, countReasons, relaxationHints, needsVerification, isOpenAt, mealPeriodAt, minutesOfDay, toMinutes,
};
