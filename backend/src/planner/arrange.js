import { mockTravelMinutes, walkMinutes } from './geo.js';

/**
 * Rearranging a confirmed itinerary. Food stops keep their place in the order and their time, so the group still eats
 * at a normal meal time; the other stops (drink, shop, activity) swap places among the remaining positions. This file
 * lists every order that works and scores it. It never calls an AI: services/itinerary-ai.js picks one of these
 * orders, so the AI can only choose an order that keeps every place open and every meal on time.
 *
 * Timing: the plan starts at `startAt` and each stop starts when the one before it ends plus the trip between them
 * (walk when it is 15 minutes or less, public transport otherwise). Two things can make a stop start later, leaving
 * free time before it: a meal never starts before its current time, and a stop whose place is not open yet waits for
 * it to open (at most MAX_WAIT_MINUTES, or MAX_FIRST_WAIT_MINUTES for the first stop).
 */

// A meal may start this many minutes after its current time (when an earlier stop runs long), and no more. It never
// starts earlier.
export const MEAL_SHIFT_MINUTES = 60;

// The longest a stop may wait for its place to open. Longer than this, the order does not work. The first stop may
// wait less, because the group has just met and would be standing around.
export const MAX_WAIT_MINUTES = 60;
export const MAX_FIRST_WAIT_MINUTES = 30;

// The most stops that may move. 6 stops make 720 orders, which is still instant.
export const MAX_MOVABLE_STOPS = 6;

// The last stop should be this close to an MRT station (minutes on foot), as on the itinerary screen.
const LAST_STOP_MRT_WALK = 10;

const WALK_LIMIT_MINUTES = 15;

/**
 * Minutes from one stop to the next, and how: walk when it is short, public transport otherwise.
 *
 * How to call:
 *   legBetween({ lat: 1.30, lng: 103.85 }, { lat: 1.31, lng: 103.86 }) // { minutes: 18, mode: 'mrt' }
 */
export function legBetween(a, b) {
  const walk = walkMinutes(a, b);
  if (walk <= WALK_LIMIT_MINUTES) return { minutes: walk, mode: 'walk' };
  return { minutes: Math.round(mockTravelMinutes(a, b)), mode: 'mrt' };
}

/**
 * Is the stop open for the whole of [start, end) (minutes after midnight)? Hours are strings such as "07:30-20:00";
 * a closing time before the opening time runs past midnight. A stop with no hours listed counts as open, as on the
 * itinerary screen.
 *
 * How to call:
 *   isOpenDuring(['10:00-22:00'], 13 * 60, 15 * 60) // true
 */
export function isOpenDuring(hours, start, end) {
  if (!hours?.length) return true;
  const toMinutes = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  return hours.some((text) => {
    const [open, rawClose] = text.split('-').map(toMinutes);
    const close = rawClose <= open ? rawClose + 1440 : rawClose;
    return [0, 1440].some((shift) => start + shift >= open && end + shift <= close);
  });
}

// The earliest start at or after `at` when a place with these hours is open for `duration` minutes, or null.
function nextOpening(hours, at, duration) {
  if (!hours?.length) return at;
  const toMinutes = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  const starts = hours.flatMap((text) => {
    const [open, rawClose] = text.split('-').map(toMinutes);
    const close = rawClose <= open ? rawClose + 1440 : rawClose;
    return [0, 1440, -1440].map((shift) => {
      const start = Math.max(at, open + shift);
      return start + duration <= close + shift ? start : null;
    });
  });
  const fits = starts.filter((t) => t !== null);
  return fits.length ? Math.min(...fits) : null;
}

/**
 * Times a list of stops from `startAt`: each one after the one before it plus the trip, later when it is a meal (never
 * before its time in `mealTimes`) or when its place is not open yet (it waits, at most MAX_WAIT_MINUTES, or
 * MAX_FIRST_WAIT_MINUTES for the first stop).
 *
 * How to call:
 *   timeStops(stops, 10 * 60, { mealTimes: new Map([['eat-1', 12 * 60]]) })
 *   // { stops: [{ ...stop, start, end, open }], travelMinutes: 24, waitMinutes: 15 }
 */
export function timeStops(stops, startAt, { mealTimes = new Map() } = {}) {
  const timed = [];
  let travelMinutes = 0;
  let waitMinutes = 0;
  stops.forEach((stop, i) => {
    let ready = startAt;
    if (i > 0) {
      const leg = legBetween(timed[i - 1], stop);
      travelMinutes += leg.minutes;
      ready = timed[i - 1].end + leg.minutes;
    }
    let start = mealTimes.has(stop.id) ? Math.max(ready, mealTimes.get(stop.id)) : ready;
    if (!isOpenDuring(stop.hours, start, start + stop.duration)) {
      const opens = nextOpening(stop.hours, start, stop.duration);
      if (opens !== null && opens - start <= (i === 0 ? MAX_FIRST_WAIT_MINUTES : MAX_WAIT_MINUTES)) start = opens;
    }
    waitMinutes += start - ready;
    const end = start + stop.duration;
    timed.push({ ...stop, start, end, open: isOpenDuring(stop.hours, start, end) });
  });
  return { stops: timed, travelMinutes, waitMinutes };
}

// Every order of `items`. Only called with MAX_MOVABLE_STOPS items or fewer.
function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

const orderKey = (ids) => ids.join('|');

const clock = (minutes) => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

// Why an order does not work, in words for the group: a closed stop, a meal that would start too late, or a plan that
// would run past the end of the session.
function problemOf(timed, mealTimes, endAt) {
  const closed = timed.find((s) => !s.open);
  if (closed) return `${closed.name} is not open at ${clock(closed.start)}-${clock(closed.end)}`;
  const meal = timed.find((s) => mealTimes.has(s.id) && s.start - mealTimes.get(s.id) > MEAL_SHIFT_MINUTES);
  if (meal) return `${meal.name} would start more than an hour after ${clock(mealTimes.get(meal.id))}`;
  const last = timed[timed.length - 1];
  if (endAt != null && last.end > endAt) return `the plan would end after ${clock(endAt)}`;
  return null;
}

/**
 * Every order of the itinerary that keeps food stops in place, keeps every place open, starts each meal at its time
 * (or at most MEAL_SHIFT_MINUTES later) and ends by `endAt`. Best first, by a simple score: minutes travelling, plus
 * half the minutes spent waiting, plus 15 when the last stop is far from an MRT station. The current order is included
 * when it works, and marked, so the caller can leave it out.
 *
 * How to call:
 *   const { candidates, movable, blockers } = arrangeCandidates({ stops, startAt: 10 * 60, endAt: 17 * 60 })
 *   candidates[0] // { ids: ['s1', 's3', 's2'], stops: [...timed], travelMinutes: 22, waitMinutes: 10, lastFarFromMrt: false, score: 27, isCurrent: false }
 *   blockers       // ['Shaw Theatres is not open at 10:00-12:00', ...]: why the other orders do not work, most common first
 *
 * stops:   [{ id, name, category, lat, lng, duration, start?, hours?, indoor?, mrtWalk? }] in the current order. `start`
 *          is the time the itinerary shows now; a meal keeps it. Without it, the meal keeps its time in this file's
 *          own timing of the current order.
 * startAt: when the plan starts, in minutes after midnight
 * endAt:   when the session ends, or leave it out for no limit
 */
export function arrangeCandidates({ stops, startAt, endAt = null }) {
  const fixed = stops.map((s) => s.category === 'eat');
  const movable = stops.filter((_, i) => !fixed[i]);
  if (movable.length > MAX_MOVABLE_STOPS) throw new Error(`At most ${MAX_MOVABLE_STOPS} stops can be rearranged.`);

  const current = timeStops(stops, startAt);
  const mealTimes = new Map(current.stops.filter((s) => s.category === 'eat').map((s) => [s.id, s.start]));
  for (const s of stops) if (s.category === 'eat' && Number.isInteger(s.start)) mealTimes.set(s.id, s.start);
  const currentKey = orderKey(stops.map((s) => s.id));

  const candidates = permutations(movable).map((order) => {
    let next = 0;
    const ordered = stops.map((s, i) => (fixed[i] ? s : order[next++]));
    const timed = timeStops(ordered, startAt, { mealTimes });
    const last = timed.stops[timed.stops.length - 1];
    const lastFarFromMrt = (last.mrtWalk ?? 0) > LAST_STOP_MRT_WALK;
    return {
      ids: ordered.map((s) => s.id),
      stops: timed.stops,
      travelMinutes: timed.travelMinutes,
      waitMinutes: timed.waitMinutes,
      lastFarFromMrt,
      score: timed.travelMinutes + timed.waitMinutes / 2 + (lastFarFromMrt ? 15 : 0),
      isCurrent: orderKey(ordered.map((s) => s.id)) === currentKey,
      problem: problemOf(timed.stops, mealTimes, endAt),
    };
  });

  // The reasons the other orders do not work, most common first, for a "no other order" answer.
  const counts = new Map();
  for (const c of candidates) if (!c.isCurrent && c.problem) counts.set(c.problem, (counts.get(c.problem) ?? 0) + 1);
  const blockers = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([text]) => text);

  const valid = candidates
    .filter((c) => !c.problem)
    .sort((a, b) => a.score - b.score)
    .map(({ problem, ...c }) => c);
  return { candidates: valid, movable: movable.length, blockers };
}

/**
 * The orders a new "Rearrange" may offer: valid, not the current order, and not one already shown. When every
 * valid order has been shown, it starts again (only the current order is left out) and says so with `restarted`.
 * With `includeCurrent` (the first suggestion, when the plan is confirmed) the current order may be chosen too, so a
 * voted order that is already the best stays as it is.
 *
 * How to call:
 *   const { options, restarted } = freshCandidates(candidates, [['s1', 's2', 's3']])
 *   const { options } = freshCandidates(candidates, [], { includeCurrent: true })
 */
export function freshCandidates(candidates, shown = [], { includeCurrent = false } = {}) {
  if (includeCurrent) return { options: candidates, restarted: false };
  const seen = new Set(shown.map(orderKey));
  const others = candidates.filter((c) => !c.isCurrent);
  const fresh = others.filter((c) => !seen.has(orderKey(c.ids)));
  if (fresh.length > 0) return { options: fresh, restarted: false };
  return { options: others, restarted: others.length > 0 };
}
