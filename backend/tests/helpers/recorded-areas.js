import { loadPlanData } from '../../src/db/venues.js'

// The plan data with only the 37 areas the planner had when the frozen answers in tests/fixtures were recorded. The list grew to every open
// MRT station on 30 October 2026, which changes which area wins for many groups; those fixtures pin the engine's behaviour, not the list, so
// their tests replay on the areas they were recorded on. The 37 are the first 37 of areas.json, kept in their order and unchanged.
//
// How to call:
//   const planData = recordedPlanData() // { ...loadPlanData(), areas: the first 37 }
export const RECORDED_AREA_COUNT = 37

export function recordedPlanData(data = loadPlanData()) {
  return { ...data, areas: data.areas.slice(0, RECORDED_AREA_COUNT) }
}
