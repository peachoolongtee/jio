// Measures what the balanced rule changes (planner/balance.js), on random groups, with the engine's own estimates. Makes no network
// call and no OneMap call: every trip is the straight-line estimate (or the area table's guess with --table), so the numbers show the
// rule's shape and are not what real OneMap times would give. The figures in docs/planner-api.md ("What it changes, measured") come from
// this script; run it again when the rule's settings change, and update the document with what it prints.
//
// How to call:
//   node scripts/measure-balanced-rule.js
//   node scripts/measure-balanced-rule.js --groups 400 --seed 7 --table
import { fileURLToPath } from 'node:url'
import { loadAreaTimes } from '../src/db/area-times.js'
import { loadPlanData } from '../src/db/venues.js'
import { createAreaEstimator } from '../src/planner/area-times.js'
import { BALANCE } from '../src/planner/balance.js'
import { meetingArea } from '../src/planner/engine.js'

// A small seeded random generator, so the same groups come out every run.
//
// How to call:
//   const rand = rng(7); rand() // 0.6270
export function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Random groups of 2 to 5 people with homes anywhere on the island.
//
// How to call:
//   const groups = randomGroups(400, 7) // [[{ id: 'm0', home: { lat, lng } }, ...], ...]
export function randomGroups(count, seed) {
  const rand = rng(seed)
  return Array.from({ length: count }, () =>
    Array.from({ length: 2 + Math.floor(rand() * 4) }, (_, i) => ({ id: `m${i}`, name: `M${i}`, home: { lat: 1.28 + rand() * 0.16, lng: 103.7 + rand() * 0.26 } })))
}

// The rule's settings to compare. The first is the default rule; the others are the balanced rule at its setting and two looser ones.
export const SETTINGS = [
  { name: 'default (longest)', rule: 'longest' },
  { name: 'balanced (longest within 5%, average within 10%)', rule: 'balanced' },
  { name: 'balanced, longest within 10%, average within 10%', rule: 'balanced', slack: 0.10, slackMinutes: 2, avgSlack: 0.10, avgSlackMinutes: 3 },
  { name: 'balanced, longest within 10%/4 min, average within 20%/5 min', rule: 'balanced', slack: 0.10, slackMinutes: 4, avgSlack: 0.20, avgSlackMinutes: 5 },
]

// Runs every setting over the groups and returns, for each, the averages of the longest trip, the gap between people and the trip.
//
// How to call:
//   const rows = measure(groups, data, estimateMinutes) // [{ name, longest, gap, average }]
export function measure(groups, data, travelMinutes) {
  const original = { ...BALANCE }
  try {
    return SETTINGS.map(({ name, rule, ...overrides }) => {
      Object.assign(BALANCE, original, overrides)
      let longest = 0, gap = 0, average = 0
      for (const members of groups) {
        const out = meetingArea({ members, rule }, data, { travelMinutes })
        const trips = Object.values(out.travelByMember)
        longest += Math.max(...trips)
        gap += Math.max(...trips) - Math.min(...trips)
        average += trips.reduce((a, b) => a + b, 0) / trips.length
      }
      return { name, longest: longest / groups.length, gap: gap / groups.length, average: average / groups.length }
    })
  } finally {
    Object.assign(BALANCE, original)
  }
}

// Of the groups, how many get another area when one person is given a past-travel balance, under each rule.
//
// How to call:
//   const moved = pickChanges(groups, data, travelMinutes, 240) // { longest: 0, balanced: 31 }
export function pickChanges(groups, data, travelMinutes, debtMinutes) {
  const counts = { longest: 0, balanced: 0 }
  for (const rule of Object.keys(counts)) {
    for (const members of groups) {
      const before = meetingArea({ members, rule }, data, { travelMinutes }).area.id
      const owed = members.map((m, i) => (i === 0 ? { ...m, travelDebtMinutes: debtMinutes } : m))
      if (meetingArea({ members: owed, rule }, data, { travelMinutes }).area.id !== before) counts[rule] += 1
    }
  }
  return counts
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const get = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
  const count = Number(get('groups') ?? 400), seed = Number(get('seed') ?? 7)
  const data = loadPlanData()
  const table = process.argv.includes('--table') ? loadAreaTimes() : null
  const estimate = table ? createAreaEstimator({ areas: data.areas, table }) : undefined
  const groups = randomGroups(count, seed)
  console.log(`${count} random groups of 2 to 5 people, seed ${seed}, ${table ? "the area table's guess" : 'the straight-line estimate'}, no past travel.`)
  for (const row of measure(groups, data, estimate)) console.log(`${row.name}: longest ${row.longest.toFixed(1)}, gap ${row.gap.toFixed(1)}, average trip ${row.average.toFixed(1)} minutes`)
  const moved = pickChanges(groups.slice(0, 100), data, estimate, 240)
  console.log(`With one person owed 240 minutes, the area changed in ${moved.longest} of 100 groups under the default rule and ${moved.balanced} under the balanced rule.`)
}
