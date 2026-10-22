import fs from 'node:fs'
import { matchVenueToCdc, nameSimilarity } from '../planner/cdc-adapter.js'
import { haversineKm, walkMinutes } from '../planner/geo.js'
import { attachClosures, closureCoverage, closureStaleWarning } from '../planner/hawker-closures.js'
import { dedupeOneMapVenues, preparePool } from '../planner/onemap-adapter.js'
import { singaporeToday } from '../planner/scoring.js'

// Builds the one `data` object the planner engine reads, from the venue sources we have today:
//   mock-data.json       test/demo fixtures: fictional venues, profiles, weather cases, visit history
//   curated-venues.json  63 real places from the frontend team's list (built by scripts/build-venues.js)
//   onemap-places.json   483 places saved from OneMap's government lists (sport centres, attractions, museums, libraries,
//                        theatres, parks and hawker centres), plus NEA's hawker closure dates. Fewer reach the planner:
//                        loadPlanData sets aside the ones a group cannot go to and keeps one row of any place listed twice.
//                        (built by scripts/build-onemap-places.js; optional, skipped with a warning when the file is missing)
//   cdc-venues.json      1,422 CDC voucher food sites (built by scripts/build-cdc.js)
// plus areas.json, the named MRT stations and neighbourhoods used as meeting-area candidates.
//
// How to call:
//   const data = loadPlanData()
//   converge(input, data)
//
// When the database exists, replace the file reads with Supabase queries that return the same shape.

const MOCK_DIR = new URL('./mock/', import.meta.url)
const readJson = (name) => JSON.parse(fs.readFileSync(new URL(name, MOCK_DIR), 'utf8'))

let cached = null
let cachedFictional = false

// Hawker centres are listed twice: once by the frontend team ("Maxwell Food Centre") and once as a CDC
// site ("Food stalls at 1 Kadayanallur Street"). Keep the named curated venue and drop the CDC copy.
// Uses matchVenueToCdc: a hawker centre within 150 m of a large CDC site, or a matching stall name within 80 m.
// The frontend marks single stalls as kind 'hawker' too, so "is this a whole centre?" comes from the name.
// Every OneMap row of kind hawker IS a centre (NEA's list has nothing else), whatever its name: "Bedok North Street 1
// Blk 216" is a centre though it says neither "market" nor "food centre".
const CENTRE_NAME = /market|food cent(re|er)|hawker|makan place|food court|food republic|kopitiam|complex/i

// How well a diet need is known, best first. A OneMap centre knows none of them; the CDC site it replaces may know 'likely'.
const DIET_RANK = ['none', 'unknown', 'likely', 'options', 'full']
const betterDiet = (a, b) => (DIET_RANK.indexOf(b ?? 'unknown') > DIET_RANK.indexOf(a ?? 'unknown') ? b : a)

/**
 * What a centre (OneMap's or a curated one) keeps from the CDC site it replaces, so replacing loses nothing: the better diet level for each
 * need (halal "likely" from the stall names stays, or a halal group would lose the centre), the stalls (searching for a
 * stall by name still finds its centre) and the site's kind.
 *
 * How to call:
 *   const kept = carryOverFromCdcSite(oneMapCentre, cdcSite) // { diet, stalls, siteKind, dataQuality }
 */
export function carryOverFromCdcSite(venue, site) {
  const diet = { ...venue.diet }
  for (const need of ['halal', 'vegetarian', 'vegan']) diet[need] = betterDiet(venue.diet?.[need], site.diet?.[need])
  const known = ['halal', 'vegetarian', 'vegan'].some((need) => !['unknown', undefined].includes(diet[need]))
  return {
    diet,
    stalls: site.stalls ?? [],
    siteKind: site.siteKind,
    dataQuality: { ...venue.dataQuality, dietUnknown: !known, dietFromNames: known },
  }
}

/**
 * Joins hawker centres to their CDC sites. A centre replaces its site (the site is dropped); a stall keeps the centre's site.
 *
 * How to call:
 *   const { venues, droppedCdcIds } = mergeCuratedWithCdc(curatedVenues, cdcSites)
 */
export function mergeCuratedWithCdc(curated, cdc) {
  const dropped = new Set()
  const merged = curated.map((venue) => {
    if (venue.category !== 'eat') return venue
    const isCentre = CENTRE_NAME.test(venue.name) || (venue.source === 'onemap' && venue.kind === 'hawker')
    const match = matchVenueToCdc({ ...venue, type: isCentre ? 'hawker_centre' : undefined }, cdc)
    if (!match.cdcAccepted) return venue
    // Drop the CDC copy only when it is the same place: a whole centre, or a CDC entry that is one stall.
    // A stall inside a centre (Jian Bo Shui Kueh in Tiong Bahru Market) keeps the centre's CDC site.
    const site = cdc.find((s) => s.id === match.siteId)
    const replacesSite = isCentre || site.siteKind === 'food_stall'
    if (replacesSite) dropped.add(site.id)
    // Whatever replaces its site keeps what the site knew: a curated centre as much as a OneMap one (ticket #107).
    const carried = replacesSite ? carryOverFromCdcSite(venue, site) : {}
    return { ...venue, ...carried, cdcAccepted: true, cdc: { siteId: site.id, match: match.cdcAccepted, stallCount: site.cdc.stallCount } }
  })
  return { venues: merged, droppedCdcIds: [...dropped] }
}

// Mock and CDC venues do not say how far the MRT is, so the "last stop near an MRT" rule could only ever
// pick curated venues. Estimate it from the nearest station in areas.json, with the frontend's walking
// formula (5 km/h, streets 25% longer than a straight line). areas.json lists only 37 of Singapore's
// stations, so the estimate can only be LONGER than the real walk: it may wrongly exclude a venue, never
// wrongly include one. Labelled mrtWalkEstimated so the UI and the team can tell.
export function withEstimatedMrtWalk(venue, stations) {
  if (venue.mrtWalkMinutes != null) return venue
  let nearest = null
  for (const s of stations) if (!nearest || haversineKm(venue, s) < haversineKm(venue, nearest)) nearest = s
  return { ...venue, nearestMrt: venue.nearestMrt ?? nearest.name, mrtWalkMinutes: walkMinutes(venue, nearest), mrtWalkEstimated: true }
}

/**
 * The ways a place can be called: "Smith Street Blk 335 (Chinatown Complex Market)" is also "Chinatown Complex Market".
 *
 * How to call:
 *   namesOf({ name: 'Redhill Lane Blk 79 (Redhill Market)' }) // [whole, 'Redhill Lane Blk 79', 'Redhill Market']
 */
function namesOf(venue) {
  const names = new Set([venue.name, venue.officialName].filter(Boolean))
  for (const name of [...names]) {
    const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(name)
    if (m) { names.add(m[1]); names.add(m[2]) }
  }
  return [...names]
}

/**
 * A OneMap place that a hand-made list already has (the frontend's Tiong Bahru Market, the mock data's museum) is
 * left out, so a place is never suggested twice. Same place = within 300 m with a similar name, or the same kind of
 * place within 50 m. A name is compared in every way the place is written, so the name in a hawker centre's bracket
 * counts: curated "Chinatown Complex Food Centre" is OneMap's "Smith Street Blk 335 (Chinatown Complex Market)", 60 m
 * away, and curated "Kovan 209 Market and Food Centre" is "Hougang Street 21 Blk 209 (Kovan Hougang Market and Food
 * Centre)", 140 m away. Distance alone is not enough for two hawker centres: neighbouring blocks are different centres.
 * `sameKindMeters: 0` turns the same-kind rule off, so only a similar name within `meters` counts. The search for a
 * place by name uses that: a café someone typed the name of is not hidden by an unrelated saved café 44 m away.
 *
 * How to call:
 *   const fresh = dropKnownPlaces(oneMapVenues, [...mockVenues, ...curatedVenues])
 *   const fresh = dropKnownPlaces(searchedVenues, saved, { sameKindMeters: 0 }) // names only
 */
export function dropKnownPlaces(candidates, known, { meters = 300, minSimilarity = 0.5, sameKindMeters = 50 } = {}) {
  return candidates.filter((c) => !known.some((k) => {
    const m = haversineKm(c, k) * 1000
    const similar = namesOf(c).some((a) => namesOf(k).some((b) => nameSimilarity(a, b) >= minSimilarity))
    return (m <= meters && similar) || (sameKindMeters > 0 && m <= sameKindMeters && c.kind && c.kind === (k.kind ?? k.cuisine))
  }))
}

const readOptionalJson = (name) => (fs.existsSync(new URL(name, MOCK_DIR)) ? readJson(name) : null)

/**
 * The attribution the Singapore Open Data Licence asks for, to show wherever OneMap's or NEA's data is shown.
 *
 * How to call:
 *   dataAttribution('2026-10-09T15:06:48.452Z') // 'Contains information from OneMap themes (Singapore Land Authority) ...'
 */
export function dataAttribution(fetchedAt) {
  const accessed = typeof fetchedAt === 'string' ? fetchedAt.slice(0, 10) : 'unknown date'
  return 'Contains information from OneMap themes, Singapore Land Authority, and from "Dates of Hawker Centres Closure", National Environment Agency, '
    + `accessed ${accessed} from OneMap and data.gov.sg, made available under the terms of the Singapore Open Data Licence version 1.0 (https://data.gov.sg/open-data-licence).`
}

/**
 * The one object the planner reads. Cached after the first call; `fresh: true` reads the files again, and so does a
 * call that asks for the other pool (`includeFictional` differs from the cached one). `today` is the date
 * ("YYYY-MM-DD") the hawker closure dates are checked against at load, and defaults to today in Singapore. It is not
 * kept in the result: the engine works out the date anti-repeat needs on every request (see `context` in engine.js).
 *
 * `includeFictional` adds the mock file's invented venues and sample visit history. It defaults to
 * INCLUDE_FICTIONAL_VENUES=1 in the environment, which is the only switch for a running server. The backend's tests
 * turn it on in vitest.config.js, not through NODE_ENV, so no machine's NODE_ENV changes which places are served.
 *
 * How to call:
 *   const data = loadPlanData()
 *   const again = loadPlanData({ fresh: true, today: '2027-01-05' }) // logs the stale-closures warning
 *   const withMock = loadPlanData({ includeFictional: true })        // the 36 invented venues and the sample visits too
 */
export function loadPlanData({ fresh = false, today = singaporeToday(), includeFictional = process.env.INCLUDE_FICTIONAL_VENUES === '1' } = {}) {
  if (cached && !fresh && cachedFictional === includeFictional) return cached
  const mock = readJson('mock-data.json')
  const curated = readJson('curated-venues.json').venues
  const cdc = readJson('cdc-venues.json').venues
  const { areas } = readJson('areas.json')

  const onemapFile = readOptionalJson('onemap-places.json')
  if (!onemapFile) console.warn('venues: onemap-places.json is missing, so there are no OneMap places and no hawker closure dates. Build it with pnpm build:onemap-places (run in backend/).')
  // Fictional venues and visit history are for tests and demos only. A load needs an explicit opt-in
  // (INCLUDE_FICTIONAL_VENUES=1 or the option), so invented places can never leak into recommendations by default.
  const mockVenues = includeFictional ? mock.venues.map((v) => ({ ...v, source: v.source ?? 'mock' })) : []

  // The frontend's hawker centres replace their CDC copies, and so do OneMap's (which have photos and stall counts).
  const { venues: curatedMerged, droppedCdcIds } = mergeCuratedWithCdc(curated, cdc)

  // OneMap places: set aside the ones a group cannot go to, keep one row per place, drop the ones the hand-made lists have.
  // A group of rows for one place goes whole when the hand-made lists have any of them.
  const savedOnemap = onemapFile?.venues ?? []
  const { pool, excluded } = preparePool(savedOnemap)
  const knownList = [...mockVenues, ...curatedMerged]
  const stillNew = new Set(dropKnownPlaces(pool, knownList).map((v) => v.id))
  const { venues: unique, clusters } = dedupeOneMapVenues(pool)
  const knownGroups = new Set(clusters.filter((ids) => ids.some((id) => !stillNew.has(id))).map((ids) => ids[0]))
  const onemapNew = unique.filter((v) => stillNew.has(v.id) && !knownGroups.has(v.id))
  const { venues: onemapMerged, droppedCdcIds: droppedByOnemap } = mergeCuratedWithCdc(onemapNew, cdc)
  const dropped = new Set([...droppedCdcIds, ...droppedByOnemap])
  const mergedIntoOnemap = droppedByOnemap.filter((id) => !droppedCdcIds.includes(id))

  const closures = onemapFile?.hawkerClosures ?? []
  const withClosures = attachClosures(
    [...mockVenues, ...curatedMerged, ...onemapMerged, ...cdc.filter((v) => !dropped.has(v.id))],
    closures,
  )
  const venues = withClosures.map((v) => withEstimatedMrtWalk(v, areas))

  // The closure dates run out: say when, and say so in the log once, because after that every centre looks open on its cleaning days.
  const coverage = closureCoverage(closures)
  const staleWarning = onemapFile ? closureStaleWarning(coverage, today) : null
  if (staleWarning) console.warn(`venues: ${staleWarning}`)
  const closureRows = new Set(withClosures.map((v) => v.closuresFrom).filter(Boolean))

  cached = {
    venues,
    areas,
    occasionProfiles: mock.occasionProfiles,
    weatherCases: mock.weatherCases,
    // Sample visits are not real group feedback and must not affect any group's results.
    visitHistory: includeFictional ? mock.visitHistory : [],
    _meta: {
      // No `today` here on purpose: a date kept at load would stay at the server's start date after midnight.
      sources: {
        mock: mockVenues.length,
        curated: curated.length,
        onemap: onemapMerged.length,
        // Of the places saved from OneMap: set aside as not somewhere to go, one of several rows for a place, already in a hand-made list.
        onemapSaved: savedOnemap.length,
        onemapExcluded: excluded.length,
        onemapDuplicates: pool.length - unique.length,
        onemapSkippedAsKnown: unique.length - onemapNew.length,
        cdc: cdc.length - dropped.size,
        // CDC sites replaced by a curated centre, and by a OneMap centre (they used to be counted together).
        cdcMergedIntoCurated: droppedCdcIds.length,
        cdcMergedIntoOnemap: mergedIntoOnemap.length,
        hawkerClosures: closures.length,
      },
      onemapExcluded: excluded,
      // The dates hawker closures cover. After lastCleaning they say nothing, and every centre looks open.
      closures: {
        ...(coverage ?? { from: null, to: null, lastCleaning: null, rows: 0, periods: 0 }),
        rowsWithoutVenue: closures.filter((c) => !closureRows.has(c.name)).map((c) => c.name),
        stale: staleWarning !== null,
      },
      onemap: onemapFile ? { fetchedAt: onemapFile._meta?.fetchedAt ?? null, attribution: dataAttribution(onemapFile._meta?.fetchedAt) } : null,
    },
  }
  cachedFictional = includeFictional
  return cached
}
