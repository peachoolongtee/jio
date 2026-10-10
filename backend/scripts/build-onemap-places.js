// Takes a snapshot of OneMap's place lists and NEA's hawker closure dates for the planner.
//
// Usage (from backend/):
//   pnpm build:onemap-places      takes a new snapshot (needs a network and the OneMap account)
//   pnpm repair:onemap-places     repairs the saved file in place, with no network and no account
//
// Taking a snapshot needs ONEMAP_EMAIL and ONEMAP_PASSWORD in backend/.env (themes need a OneMap account). The closure
// dates need no key. It writes src/db/mock/onemap-places.json. Re-run when OneMap's lists change, and every year when
// NEA publishes the next year's closure dates (the planner logs a warning when the saved dates are about to run out),
// then commit the file. It refuses to overwrite the saved file when a theme or the closure dates come back empty, and
// writes the places in a fixed order (theme, then id), so a new snapshot diffs cleanly against the old one.
//
// Repairing applies the adapter's current text, link and address fixes to the saved places and changes nothing else
// (not fetchedAt, not the order, not the closure dates). It is safe to run twice: the second run changes nothing.
// Options: --file <path> works on another copy of the file (the tests do).
//
// Why a snapshot and not a call per request: these lists change a few times a year, and the course tests each
// feature several times a day, so calling OneMap for them on every request would only spend its rate limit.
//
// Data: OneMap themes (Singapore Land Authority) and "Dates of Hawker Centres Closure" (National Environment Agency,
// via data.gov.sg), both under the Singapore Open Data Licence.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { THEME_NAMES, fromOneMapTheme, repairSavedVenue } from '../src/planner/onemap-adapter.js'
import { parseClosureReport } from '../src/planner/hawker-closures.js'

const CLOSURES_URL = 'https://data.gov.sg/api/action/datastore_search?resource_id=d_bda4baa634dd1cc7a6c7cad5f19e2d68&limit=1000'
export const DEFAULT_FILE = fileURLToPath(new URL('../src/db/mock/onemap-places.json', import.meta.url))

/**
 * The file's text for an object: one place per block, one space of indent, a final newline. The same form the build has
 * always written, so a repair that changes nothing changes no byte.
 *
 * How to call:
 *   fs.writeFileSync(file, serialise({ _meta, venues, hawkerClosures }))
 */
export const serialise = (data) => JSON.stringify(data, null, 1) + '\n'

/**
 * Writes a file through a temporary neighbour and a rename, so a crash never leaves half a snapshot.
 *
 * How to call:
 *   writeAtomically('src/db/mock/onemap-places.json', serialise(data))
 */
function writeAtomically(file, text) {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, text)
  fs.renameSync(temporary, file)
}

/**
 * Repairs the saved file in place: every place goes through repairSavedVenue; the metadata, the closure dates and the
 * order stay as they were. Writes nothing when nothing changes.
 *
 * How to call:
 *   const { venues, changed } = repairFile('src/db/mock/onemap-places.json')
 */
export function repairFile(file = DEFAULT_FILE) {
  const before = fs.readFileSync(file, 'utf8')
  const saved = JSON.parse(before)
  if (!Array.isArray(saved.venues)) throw new Error(`${file} has no list of venues`)
  const repaired = { ...saved, venues: saved.venues.map(repairSavedVenue) }
  const after = serialise(repaired)
  const changed = saved.venues.filter((v, i) => JSON.stringify(v) !== JSON.stringify(repaired.venues[i])).length
  if (after !== before) writeAtomically(file, after)
  return { venues: saved.venues.length, changed }
}

/**
 * Places in a fixed order: the themes as listed in THEME_NAMES, then by id, so two snapshots of the same data are
 * the same file whatever order OneMap answered in.
 *
 * How to call:
 *   const ordered = inStableOrder(venues)
 */
export function inStableOrder(venues) {
  const rank = (v) => THEME_NAMES.indexOf(v.oneMapTheme)
  return [...venues].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Reasons not to overwrite the saved file: a theme that came back empty (nothing downloaded, or nothing kept), or no
 * closure dates. An empty list means the snapshot is fit to write.
 *
 * How to call:
 *   const problems = snapshotProblems(counts, hawkerClosures) // ['theme "museum" came back with no rows', ...]
 */
export function snapshotProblems(counts, hawkerClosures) {
  const problems = []
  for (const theme of THEME_NAMES) {
    const c = counts[theme]
    if (!c || c.rows === 0) problems.push(`theme "${theme}" came back with no rows`)
    else if (c.kept === 0) problems.push(`theme "${theme}" had ${c.rows} rows and none was kept`)
  }
  if (hawkerClosures.length === 0) problems.push('the hawker closure dates came back empty')
  return problems
}

/**
 * The real clients for a snapshot, or null (with a message) when the account is not set. Only a snapshot reads
 * backend/.env; a repair never touches it.
 *
 * How to call:
 *   const clients = await realClients() // { http, onemap, OneMapUnavailableError } | null
 */
async function realClients() {
  await import('dotenv/config')
  const email = process.env.ONEMAP_EMAIL === 'you@example.com' ? null : process.env.ONEMAP_EMAIL
  if (!email || !process.env.ONEMAP_PASSWORD) {
    console.error('Set ONEMAP_EMAIL and ONEMAP_PASSWORD in backend/.env first: OneMap themes need an account.')
    return null
  }
  const { createHttp } = await import('../src/services/http.js')
  const { createOneMap, OneMapUnavailableError } = await import('../src/services/onemap.js')
  const http = createHttp()
  return { http, onemap: createOneMap({ http, email, password: process.env.ONEMAP_PASSWORD }), OneMapUnavailableError }
}

/**
 * Downloads every theme and the closure dates and writes the file, or writes nothing and says why in one line.
 * Returns the exit code. `clients` is { http, onemap, OneMapUnavailableError }; the tests pass fakes.
 *
 * How to call:
 *   const code = await takeSnapshot('src/db/mock/onemap-places.json', await realClients())
 */
export async function takeSnapshot(file, { http, onemap, OneMapUnavailableError }) {
  const venues = []
  const counts = {}
  try {
    for (const theme of THEME_NAMES) {
      const rows = await onemap.theme(theme)
      const converted = fromOneMapTheme(theme, rows)
      counts[theme] = { rows: rows.length, kept: converted.length }
      venues.push(...converted)
    }
  } catch (err) {
    if (err instanceof OneMapUnavailableError && err.reason === 'login_failed') {
      console.error('OneMap login failed: check ONEMAP_EMAIL and ONEMAP_PASSWORD in backend/.env. Nothing was written.')
    } else {
      console.error(`Could not download the OneMap themes: ${err.message}. Nothing was written.`)
    }
    return 1
  }

  let closuresBody
  try {
    closuresBody = await http.getJson(CLOSURES_URL)
  } catch (err) {
    console.error(`Could not download the hawker closure dates: ${err.message}. Nothing was written.`)
    return 1
  }
  const { closures: hawkerClosures, dropped } = parseClosureReport(closuresBody?.result?.records ?? [])

  const problems = snapshotProblems(counts, hawkerClosures)
  if (problems.length > 0) {
    console.error(`Not writing ${file}, which stays as it was: ${problems.join('; ')}.`)
    return 1
  }

  const meta = {
    sources: [
      'OneMap themes, Singapore Land Authority (https://www.onemap.gov.sg/apidocs/)',
      'Dates of Hawker Centres Closure, National Environment Agency (https://data.gov.sg/datasets/d_bda4baa634dd1cc7a6c7cad5f19e2d68/view)',
    ],
    licence: 'Singapore Open Data Licence (https://data.gov.sg/open-data-licence)',
    fetchedAt: new Date().toISOString(),
    counts,
    builtBy: 'backend/scripts/build-onemap-places.js',
    note: 'Do not edit by hand: re-run pnpm build:onemap-places.',
  }
  const ordered = inStableOrder(venues)
  const orderedClosures = [...hawkerClosures].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  writeAtomically(file, serialise({ _meta: meta, venues: ordered, hawkerClosures: orderedClosures }))

  console.log(`wrote ${ordered.length} places and ${orderedClosures.length} hawker centres' closure dates to ${file}`)
  for (const [theme, c] of Object.entries(counts)) console.log(`  ${theme}: ${c.kept} kept of ${c.rows}`)
  console.log(`  closure rows dropped: ${dropped.length}${dropped.length ? ` (${dropped.map((d) => `${d.name || '(no name)'}: ${d.reason}`).join('; ')})` : ''}`)
  return 0
}

/**
 * Runs the script. Returns the exit code: 0 on success, 1 when nothing could be written, 2 for a bad command line.
 *
 * How to call:
 *   process.exitCode = await main(['--repair', '--file', '/tmp/copy.json'])
 */
export async function main(argv) {
  let repair = false
  let file = DEFAULT_FILE
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repair') repair = true
    else if (argv[i] === '--file' && argv[i + 1]) file = argv[++i]
    else { console.error(`Unknown option "${argv[i]}". Use --repair, and --file <path> to work on another copy.`); return 2 }
  }
  if (repair) {
    try {
      const { venues, changed } = repairFile(file)
      console.log(`repaired ${changed} of ${venues} places in ${file}`)
      return 0
    } catch (err) {
      console.error(`Could not repair ${file}: ${err.message}`)
      return 1
    }
  }
  const clients = await realClients()
  return clients ? takeSnapshot(file, clients) : 1
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
