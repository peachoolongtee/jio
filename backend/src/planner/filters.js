// filters.js: hard-constraint filtering shared by Converge and Roam.
// A venue is ALLOWED or REJECTED here. No scoring happens in this file.

import { isClosedOn } from './hawker-closures.js';

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
 * Day of the week (0 = Sunday ... 6 = Saturday) of a local date, "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM". The date part is read as
 * a calendar date: no time zone is applied, because the string is already Singapore local time, so the answer cannot
 * change with the machine's time zone.
 *
 * How to call:
 *   weekdayOf('2026-10-12T10:00') // 1 (a Monday)
 */
function weekdayOf(dateTime) {
  const [y, m, d] = dateTime.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Does the venue say it is shut on this weekday (venue.closedWeekdays, from "Closed on Monday" in its hours text)? */
const isClosedWeekday = (venue, dateTime) => (venue.closedWeekdays ?? []).includes(weekdayOf(dateTime));

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

/**
 * Open for the WHOLE visit, from dateTime for `minutes`? Used for itinerary slots ("eat 12:00 to 13:30"):
 * a place that closes at 13:00 must not be suggested even though it is open at 12:00.
 * Ranges past midnight (18:00-03:00) work, and so does an early-morning visit inside last night's
 * late opening (01:00 to 02:00 at an 18:00-03:00 place). Same rule as isOpenDuring in the frontend planner.
 */
function isOpenFor(venue, dateTime, minutes) {
  const start = minutesOfDay(dateTime), end = start + minutes;
  return venue.openingHours.some(([open, close]) => {
    const o = toMinutes(open), c = toMinutes(close) > o ? toMinutes(close) : toMinutes(close) + 1440;
    return [0, 1440].some(shift => start + shift >= o && end + shift <= c);
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
 * A drink stop is not a meal (ticket #107): only halal changes it, and only by keeping bars out (a place whose kind is
 * 'bar', or whose halal level is 'none'). Cafés stay, with no caveat.
 * How to call: meetsDiet(venue, 'halal', 'strict') -> true
 */
function meetsDiet(venue, need, unknownPolicy = 'strict') {
  if (venue.diet === null) return true;
  if (venue.category === 'drink') return !(need === 'halal' && isBar(venue));
  const level = venue.diet[need];
  if (['full', 'options', 'likely'].includes(level)) return true;
  return level === 'unknown' && unknownPolicy === 'lenient';
}

/**
 * Is this drink place a bar, which a halal group leaves out? Its kind says so, or its halal level is 'none'.
 * How to call: isBar({ kind: 'bar' }) -> true
 */
function isBar(venue) {
  return venue.kind === 'bar' || venue.diet?.halal === 'none';
}

// Food places are the only ones whose dietary status is checked and shown (drink stops skip it, see meetsDiet).
// How to call: dietChecked(venue) -> true
const dietChecked = (venue) => venue.diet !== null && venue.diet !== undefined && venue.category !== 'drink';

/** Which dietary needs are only 'likely' for this venue, so the UI can say "check the stall". */
function needsVerification(venue, members) {
  if (!dietChecked(venue)) return [];
  const needs = [...new Set(members.flatMap(m => m.dietary ?? []))];
  return needs.filter(n => venue.diet[n] === 'likely');
}

/**
 * Which dietary needs we have NO data on for this venue. Only lenient mode lets these through, and then
 * the UI must say so ("halal status not known"), otherwise lenient silently looks like a yes.
 */
function unknownDietNeeds(venue, members) {
  if (!dietChecked(venue)) return [];
  const needs = [...new Set(members.flatMap(m => m.dietary ?? []))];
  return needs.filter(n => venue.diet[n] === 'unknown');
}

/**
 * How many of the group's dietary needs this place is NOT known to meet: 0 for a place that meets all of them (for sure or
 * likely), and for every drink, shop or activity place. Only lenient mode keeps places above 0. The engine ranks by it first
 * (ticket #107): places that likely meet more of the group's needs come before those that meet fewer, then by score.
 * How to call: dietMisses(venue, [{ id: 'a', dietary: ['halal', 'vegan'] }]) -> 1
 */
function dietMisses(venue, members) {
  return unknownDietNeeds(venue, members).length;
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
    excludeVenueIds = [], enforceMealPeriod = true, unknownPolicy = 'strict', durationMinutes = 0,
  } = ctx;
  const reasons = [];

  if (!categories.includes(venue.category)) reasons.push('category');
  if (excludeVenueIds.includes(venue.id)) reasons.push('excluded');

  const needs = [...new Set(members.flatMap(m => m.dietary ?? []))];
  for (const need of needs) if (!meetsDiet(venue, need, unknownPolicy)) reasons.push(`diet:${need}`);

  for (const c of groupConstraints) {
    if (c.startsWith('max_price_pp:')) {
      if (venue.avgPricePerPerson > Number(c.split(':')[1])) reasons.push('max_price');
    } else if (c.startsWith('near_mrt:')) {
      // within N minutes' walk of an MRT station (the frontend's rule for the last stop of the day).
      // Unknown walk time follows the unknown-data policy, like step_free.
      const walk = venue.mrtWalkMinutes;
      const ok = walk === null || walk === undefined ? unknownPolicy === 'lenient' : walk <= Number(c.split(':')[1]);
      if (!ok) reasons.push('near_mrt');
    } else if (SIMPLE_CONSTRAINTS[c]) {
      if (!SIMPLE_CONSTRAINTS[c](venue, unknownPolicy === 'lenient')) reasons.push(c);
    } else {
      throw new Error(`filterByConstraints: unknown group constraint "${c}"`); // typos must not silently pass
    }
  }

  if (venue.maxGroupSize < members.length) reasons.push('capacity');
  // A hawker centre's cleaning or repair days (NEA), attached by hawker-closures.js. Dates are "YYYY-MM-DD".
  if (isClosedOn(venue, dateTime.slice(0, 10))) reasons.push('closed_for_cleaning');
  // With a duration (an itinerary slot), the venue must stay open for all of it, not just at the start.
  // A place whose hours text says "Closed on Monday" is closed all that day, whatever its opening hours on other days.
  if (isClosedWeekday(venue, dateTime) || !(durationMinutes > 0 ? isOpenFor(venue, dateTime, durationMinutes) : isOpenAt(venue, dateTime))) reasons.push('closed');
  if (enforceMealPeriod && venue.category === 'eat' && venue.mealPeriods.length > 0 &&
      !venue.mealPeriods.includes(mealPeriodAt(dateTime))) reasons.push('meal_period');

  return reasons;
}

/**
 * @param {object[]} venues
 * @param {{members:object[], groupConstraints?:string[], dateTime:string, categories?:string[],
 *          excludeVenueIds?:string[], enforceMealPeriod?:boolean, unknownPolicy?:'strict'|'lenient',
 *          durationMinutes?:number}} ctx  members = ACTIVE members only
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
  filterByConstraints, countReasons, relaxationHints, needsVerification, unknownDietNeeds, dietMisses, isOpenAt, isOpenFor, mealPeriodAt, minutesOfDay, toMinutes,
  weekdayOf, isClosedWeekday,
};
