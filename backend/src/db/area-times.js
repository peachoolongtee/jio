import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAreaTimes } from '../planner/area-times.js'

// Reads the saved table of real minutes between the meeting areas (scripts/build-area-times.js). Returns the table, or null when
// the file is missing, is not JSON or does not have the right shape: the planner then keeps the straight-line guess. Never throws.
//
// How to call:
//   const areaTimes = loadAreaTimes() // { _meta: { areas, dateTime, ... }, minutes: { 'bedok|bugis': 21.5, ... } } or null
export const AREA_TIMES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock/area-times.json')

export function loadAreaTimes(file = AREA_TIMES_FILE) {
  try {
    const table = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isAreaTimes(table) ? table : null
  } catch {
    return null
  }
}
