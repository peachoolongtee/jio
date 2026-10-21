// Builds backend/src/db/mock/area-times.json: real public transport minutes between every pair of the planner's meeting areas,
// taken from OneMap once. The planner uses it to rank the areas before it spends real routes on a few of them, and as a better
// estimate than straight-line distance when OneMap is off or over its budget.
//
// Run it by hand, with the OneMap account in backend/.env. It makes about 666 calls for 37 areas (one for each pair: a trip
// and its way back take about the same time), so it paces itself: at most `--per-minute` calls a minute (default 60), well
// under the 300 a minute the whole team shares. When OneMap answers "too many requests" it waits a minute and tries again.
// It saves after every 20 trips and starts again where it stopped, so stopping it (Ctrl+C) loses nothing.
//
// How to call:
//   node --env-file=.env scripts/build-area-times.js
//   node --env-file=.env scripts/build-area-times.js --per-minute 40 --date 2026-10-27T12:30
//   node --env-file=.env scripts/build-area-times.js --limit 3 --out /tmp/try.json   (a trial of 3 trips)
//
// The times are for ONE moment (default: the next Tuesday at 12:30, off-peak), so they do not show the evening rush. They rank
// areas; the real route for a request still uses the request's own time.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPlanData } from '../src/db/venues.js'
import { pairKey } from '../src/planner/area-times.js'
import { createHttp } from '../src/services/http.js'
import { createOneMap } from '../src/services/onemap.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_OUT = path.join(HERE, '../src/db/mock/area-times.json')

// The next Tuesday at 12:30 after `from`, as a local Singapore date-time "YYYY-MM-DDTHH:MM".
//
// How to call:
//   nextTuesdayNoon(new Date('2026-10-21T00:00:00Z')) // '2026-10-27T12:30'
export function nextTuesdayNoon(from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()))
  do d.setUTCDate(d.getUTCDate() + 1)
  while (d.getUTCDay() !== 2)
  return `${d.toISOString().slice(0, 10)}T12:30`
}

// Who made the times, written into the table.
export const CREDIT = "Travel times from the OneMap routing service, Singapore Land Authority (https://www.onemap.gov.sg). Check OneMap's terms before reusing them."

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Reads a saved table, or an empty one.
function readTable(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    return saved && typeof saved.minutes === 'object' ? saved : null
  } catch {
    return null
  }
}

// Writes the table whole, to a temporary file first, so a stop in the middle never leaves a half-written file.
function writeTable(file, table) {
  const temp = `${file}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(table, null, 1)}\n`)
  fs.renameSync(temp, file)
}

// Builds or continues the table. `route(from, to, dateTime)` gives minutes, or null for "no route", or throws.
//
// How to call:
//   const table = await buildAreaTimes({ areas, route: onemap.routeMinutes, dateTime: '2026-10-27T12:30', file: DEFAULT_OUT })
export async function buildAreaTimes({
  areas,
  route,
  dateTime,
  file,
  perMinute = 60,
  limit = Infinity,
  log = console.log,
  wait = sleep,
  retries = 4,
  retryMs = 65_000,
  saveEvery = 20,
}) {
  const previous = readTable(file)
  const table = previous && previous._meta?.dateTime === dateTime
    ? previous
    : { _meta: { source: 'OneMap routing, public transport', dateTime, areas: areas.map((a) => a.id), builtAt: null, credit: CREDIT, missing: [] }, minutes: {} }
  const pairs = []
  for (let i = 0; i < areas.length; i++) for (let j = i + 1; j < areas.length; j++) pairs.push([areas[i], areas[j]])
  const todo = pairs.filter(([a, b]) => !(pairKey(a.id, b.id) in table.minutes) && !table._meta.missing.includes(pairKey(a.id, b.id)))
  log(`${pairs.length} pairs, ${pairs.length - todo.length} already done, ${Math.min(todo.length, limit)} to do at ${perMinute} a minute.`)
  let done = 0
  for (const [a, b] of todo) {
    if (done >= limit) break
    const key = pairKey(a.id, b.id)
    let minutes
    for (let attempt = 0; ; attempt++) {
      try {
        minutes = await route(a, b, dateTime)
        break
      } catch (err) {
        if (attempt >= retries) throw new Error(`Giving up on ${key} after ${retries} retries: ${err.message}`)
        log(`  ${key}: ${err.status ? `HTTP ${err.status}` : err.message}; waiting ${Math.round(retryMs / 1000)} s (try ${attempt + 1} of ${retries})`)
        await wait(retryMs)
      }
    }
    if (Number.isFinite(minutes)) table.minutes[key] = Math.round(minutes * 10) / 10
    else table._meta.missing.push(key) // OneMap found no public transport route between these two
    done += 1
    if (done % saveEvery === 0) {
      writeTable(file, table)
      log(`  ${done} of ${Math.min(todo.length, limit)} done`)
    }
    await wait(60_000 / perMinute)
  }
  table._meta.builtAt = new Date().toISOString()
  table._meta.pairs = Object.keys(table.minutes).length
  writeTable(file, table)
  log(`Saved ${table._meta.pairs} times to ${file} (${table._meta.missing.length} pairs with no route).`)
  return table
}

// ---------------------------------------------------------------- the command
// The most calls a minute the script may make, whatever it is asked: the OneMap account is shared by the whole team (300 a minute),
// and the server and other people's tests use it too.
export const MAX_PER_MINUTE = 120

// Reads the command's flags, or throws an Error that says which one is wrong.
//
// How to call:
//   readFlags(['--per-minute', '40', '--date', '2026-10-27T12:30']) // { perMinute: 40, dateTime: '2026-10-27T12:30', limit: Infinity, out: undefined }
export function readFlags(argv, now = new Date()) {
  const get = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
  const perMinute = get('per-minute') === undefined ? 60 : Number(get('per-minute'))
  if (!Number.isInteger(perMinute) || perMinute < 1 || perMinute > MAX_PER_MINUTE) throw new Error(`--per-minute must be a whole number from 1 to ${MAX_PER_MINUTE}.`)
  const dateTime = get('date') ?? nextTuesdayNoon(now)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dateTime) || Number.isNaN(Date.parse(`${dateTime}:00Z`))) throw new Error('--date must look like 2026-10-27T12:30 (Singapore time).')
  const limit = get('limit') === undefined ? Infinity : Number(get('limit'))
  if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) throw new Error('--limit must be a whole number of 1 or more.')
  return { perMinute, dateTime, limit, out: get('out') }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const email = process.env.ONEMAP_EMAIL
  const password = process.env.ONEMAP_PASSWORD
  if (!email || !password) {
    console.error('Set ONEMAP_EMAIL and ONEMAP_PASSWORD (node --env-file=.env scripts/build-area-times.js).')
    process.exit(1)
  }
  let flags
  try {
    flags = readFlags(process.argv.slice(2))
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
  const { perMinute, dateTime, limit, out } = flags
  const onemap = createOneMap({ http: createHttp(), email, password, callsPerMinute: Math.max(perMinute * 2, 30) })
  const areas = loadPlanData().areas
  await buildAreaTimes({
    areas,
    route: (a, b, when) => onemap.routeMinutes(a, b, when),
    dateTime,
    file: out ?? DEFAULT_OUT,
    perMinute,
    limit,
  })
}
