// Builds backend/src/db/mock/area-times.json: real public transport minutes between every pair of the planner's meeting areas,
// taken from OneMap once. The planner uses it to rank the areas before it spends real routes on a few of them, and as a better
// estimate than straight-line distance when OneMap is off or over its budget.
//
// Run it by hand, with the OneMap account in backend/.env, and STOP THE RUNNING SERVER FIRST: the account allows 300 calls a
// minute for everyone, and a running server may use up to 240 of them (ONEMAP_CALLS_PER_MINUTE), so the two together can pass
// the limit. The script makes one call for each pair of areas (a trip and its way back take about the same
// time): 10,440 for 145 areas, 666 for the first 37. So it paces itself: at most `--per-minute` calls a minute (default 50, at most 120). When OneMap answers "too many
// requests" or fails it waits a minute and tries again; when it says that one trip has no route (400, 404 or 422) the pair is
// written under `_meta.missing` and not asked for again. It saves after every 20 trips and starts again where it stopped, so
// stopping it (Ctrl+C) loses nothing. If the areas changed since the saved file, the pairs of areas that are gone are dropped.
//
// How to call:
//   node --env-file=.env scripts/build-area-times.js
//   node --env-file=.env scripts/build-area-times.js --per-minute 40 --date 2026-10-27T12:30
//   node --env-file=.env scripts/build-area-times.js --limit 3 --out /tmp/try.json   (a trial of 3 trips)
//   node --env-file=.env scripts/build-area-times.js --help
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

// The day in Singapore of a moment, as 'YYYY-MM-DD'.
//
// How to call:
//   singaporeDay('2026-10-21T03:22:58.111Z') // '2026-10-21'
export const singaporeDay = (iso) => new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().slice(0, 10)

// Who made the times and when they were taken, written into the table: the access date goes wherever the data is shown or used
// (see "Saved OneMap data and its terms" in docs/external-apis.md). One day, or the first and the last when the build took several.
//
// How to call:
//   creditFor('2026-10-21T01:00:00.000Z', '2026-10-21T03:22:58.111Z') // '... accessed 2026-10-21. ...'
export function creditFor(startedAt, builtAt) {
  const first = singaporeDay(startedAt), last = singaporeDay(builtAt)
  const when = first === last ? `accessed ${first}` : `accessed ${first} to ${last}`
  return `Travel times from the OneMap routing service, Singapore Land Authority (https://www.onemap.gov.sg), ${when}. A derived summary in minutes, for non-commercial use; see backend/docs/external-apis.md.`
}

// What the command prints for --help.
export const HELP = `Builds src/db/mock/area-times.json: real public transport minutes between every pair of the meeting areas, from OneMap.

STOP THE RUNNING SERVER FIRST. The OneMap account allows 300 calls a minute for everyone, and the server may use up to 240 of them.

  node --env-file=.env scripts/build-area-times.js [--per-minute 50] [--date 2026-10-27T12:30] [--limit 3] [--out file.json]

  --per-minute  calls a minute, 1 to 120 (default 50)
  --date        the moment the times are for, Singapore time (default: the next Tuesday at 12:30)
  --limit       stop after this many trips (a trial)
  --out         write here instead of the saved table
  --help        this text

It saves as it goes and carries on where it stopped. Needs ONEMAP_EMAIL and ONEMAP_PASSWORD in backend/.env.`

// Whether OneMap said that this one trip cannot be routed (400, 404 or 422), as opposed to a failure that may pass (429, 5xx,
// no answer): the first is the pair's own answer, so it is written down and not retried.
//
// How to call:
//   isNoRoute(Object.assign(new Error('x'), { status: 404 })) // true
export const isNoRoute = (err) => [400, 404, 422].includes(err?.status)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Reads a saved table, or null. A table that is a list, or whose `_meta` or `minutes` is not an object, is not one.
function readTable(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
    return object(saved) && object(saved.minutes) ? saved : null
  } catch {
    return null
  }
}

// Writes the table whole, with its keys in sorted order so the same times always give the same file, to a temporary file first,
// so a stop in the middle never leaves a half-written file.
function writeTable(file, table) {
  const sorted = Object.fromEntries(Object.keys(table.minutes).sort().map((key) => [key, table.minutes[key]]))
  const out = { ...table, _meta: { ...table._meta, missing: [...table._meta.missing].sort() }, minutes: sorted }
  const temp = `${file}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(out, null, 1)}\n`)
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
  perMinute = DEFAULT_PER_MINUTE,
  limit = Infinity,
  log = console.log,
  wait = sleep,
  retries = 4,
  retryMs = 65_000,
  saveEvery = 20,
}) {
  const previous = readTable(file)
  const startedNow = new Date().toISOString()
  const table = previous && previous._meta?.dateTime === dateTime
    ? previous
    : { _meta: { source: 'OneMap routing, public transport', dateTime, startedAt: startedNow }, minutes: {} }
  // A saved file may lack parts of `_meta` (an older build, a hand edit): fill them in. Pairs of areas that are gone (the areas
  // changed since) are dropped, and the list of areas is the current one.
  const ids = new Set(areas.map((a) => a.id))
  const current = (key) => { const parts = key.split('|'); return parts.length === 2 && parts.every((id) => ids.has(id)) }
  table._meta = {
    source: 'OneMap routing, public transport',
    ...table._meta,
    areas: areas.map((a) => a.id),
    missing: (Array.isArray(table._meta?.missing) ? table._meta.missing : []).filter((key) => typeof key === 'string' && current(key)),
  }
  table._meta.startedAt ??= startedNow
  for (const key of Object.keys(table.minutes)) if (!current(key)) delete table.minutes[key]
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
        if (isNoRoute(err)) { // this trip's own answer: no route, not a failure to retry
          minutes = null
          break
        }
        if (attempt >= retries) throw new Error(`Giving up on ${key} after ${retries} retries: ${err.message}`)
        log(`  ${key}: ${err.status ? `HTTP ${err.status}` : err.message}; waiting ${Math.round(retryMs / 1000)} s (try ${attempt + 1} of ${retries})`)
        await wait(retryMs)
      }
    }
    if (Number.isFinite(minutes)) table.minutes[key] = Math.round(minutes * 10) / 10
    else if (!table._meta.missing.includes(key)) table._meta.missing.push(key) // OneMap found no public transport route between these two
    done += 1
    if (done % saveEvery === 0) {
      writeTable(file, table)
      log(`  ${done} of ${Math.min(todo.length, limit)} done`)
    }
    await wait(60_000 / perMinute)
  }
  table._meta.builtAt = new Date().toISOString()
  table._meta.credit = creditFor(table._meta.startedAt, table._meta.builtAt)
  table._meta.pairs = Object.keys(table.minutes).length
  writeTable(file, table)
  log(`Saved ${table._meta.pairs} times to ${file} (${table._meta.missing.length} pairs with no route).`)
  return table
}

// ---------------------------------------------------------------- the command
// How many calls a minute the script makes unless told otherwise: well under the 300 the shared account allows.
export const DEFAULT_PER_MINUTE = 50

// The most calls a minute the script may make, whatever it is asked: the OneMap account is shared by the whole team (300 a minute),
// and the server and other people's tests use it too.
export const MAX_PER_MINUTE = 120

// Reads the command's flags, or throws an Error that says which one is wrong.
//
// How to call:
//   readFlags(['--per-minute', '40', '--date', '2026-10-27T12:30']) // { perMinute: 40, dateTime: '2026-10-27T12:30', limit: Infinity, out: undefined }
export function readFlags(argv, now = new Date()) {
  const get = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
  const perMinute = get('per-minute') === undefined ? DEFAULT_PER_MINUTE : Number(get('per-minute'))
  if (!Number.isInteger(perMinute) || perMinute < 1 || perMinute > MAX_PER_MINUTE) throw new Error(`--per-minute must be a whole number from 1 to ${MAX_PER_MINUTE}.`)
  const dateTime = get('date') ?? nextTuesdayNoon(now)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dateTime) || Number.isNaN(Date.parse(`${dateTime}:00Z`))) throw new Error('--date must look like 2026-10-27T12:30 (Singapore time).')
  const limit = get('limit') === undefined ? Infinity : Number(get('limit'))
  if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) throw new Error('--limit must be a whole number of 1 or more.')
  return { perMinute, dateTime, limit, out: get('out') }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP)
    process.exit(0)
  }
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
  console.log('Make sure the Jio server is stopped: it shares the OneMap account (300 calls a minute) and may use up to 240 of them.')
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
