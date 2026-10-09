// Takes a snapshot of OneMap's place lists and NEA's hawker closure dates for the planner.
// Usage (from backend/): pnpm build:onemap-places
// Needs ONEMAP_EMAIL and ONEMAP_PASSWORD in backend/.env (themes need a OneMap account). The closure dates need no key.
// Writes src/db/mock/onemap-places.json. Re-run when OneMap's lists or NEA's closure dates change (closures are
// published per year), then commit the file.
//
// Why a snapshot and not a call per request: these lists change a few times a year, and the course tests each
// feature several times a day, so calling OneMap for them on every request would only spend its rate limit.
//
// Data: OneMap themes (Singapore Land Authority) and "Dates of Hawker Centres Closure" (National Environment Agency,
// via data.gov.sg), both under the Singapore Open Data Licence.
import 'dotenv/config'
import fs from 'node:fs'
import { createHttp } from '../src/services/http.js'
import { createOneMap } from '../src/services/onemap.js'
import { fromOneMapTheme, THEME_NAMES } from '../src/planner/onemap-adapter.js'
import { parseClosureRows } from '../src/planner/hawker-closures.js'

const CLOSURES_URL = 'https://data.gov.sg/api/action/datastore_search?resource_id=d_bda4baa634dd1cc7a6c7cad5f19e2d68&limit=1000'
const OUT = 'src/db/mock/onemap-places.json'

const email = process.env.ONEMAP_EMAIL === 'you@example.com' ? null : process.env.ONEMAP_EMAIL
if (!email || !process.env.ONEMAP_PASSWORD) {
  console.error('Set ONEMAP_EMAIL and ONEMAP_PASSWORD in backend/.env first: OneMap themes need an account.')
  process.exit(1)
}

const http = createHttp()
const onemap = createOneMap({ http, email, password: process.env.ONEMAP_PASSWORD })

const venues = []
const counts = {}
for (const theme of THEME_NAMES) {
  const rows = await onemap.theme(theme)
  const converted = fromOneMapTheme(theme, rows)
  counts[theme] = { rows: rows.length, kept: converted.length }
  venues.push(...converted)
}

const closuresBody = await http.getJson(CLOSURES_URL)
const hawkerClosures = parseClosureRows(closuresBody?.result?.records ?? [])

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
fs.writeFileSync(OUT, JSON.stringify({ _meta: meta, venues, hawkerClosures }, null, 1) + '\n')

console.log(`wrote ${venues.length} places and ${hawkerClosures.length} hawker centres' closure dates to ${OUT}`)
for (const [theme, c] of Object.entries(counts)) console.log(`  ${theme}: ${c.kept} kept of ${c.rows}`)
