import fs from 'node:fs'
import { matchVenueToCdc, nameSimilarity } from '../planner/cdc-adapter.js'
import { haversineKm, walkMinutes } from '../planner/geo.js'
import { attachClosures } from '../planner/hawker-closures.js'

// Builds the one `data` object the planner engine reads, from the venue sources we have today:
//   mock-data.json       36 fictional venues + members, occasion profiles, weather cases, visit history
//   curated-venues.json  63 real places from the frontend team's list (built by scripts/build-venues.js)
//   onemap-places.json   ~480 places from OneMap's government lists: sport centres, attractions, museums, libraries,
//                        theatres, parks and hawker centres, plus NEA's hawker closure dates
//                        (built by scripts/build-onemap-places.js; optional, skipped when the file is missing)
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

// Hawker centres are listed twice: once by the frontend team ("Maxwell Food Centre") and once as a CDC
// site ("Food stalls at 1 Kadayanallur Street"). Keep the named curated venue and drop the CDC copy.
// Uses matchVenueToCdc: a hawker centre within 150 m of a large CDC site, or a matching stall name within 80 m.
// The frontend marks single stalls as kind 'hawker' too, so "is this a whole centre?" comes from the name.
const CENTRE_NAME = /market|food cent(re|er)|hawker|makan place|food court|food republic|kopitiam|complex/i

export function mergeCuratedWithCdc(curated, cdc) {
  const dropped = new Set()
  const merged = curated.map((venue) => {
    if (venue.category !== 'eat') return venue
    const isCentre = CENTRE_NAME.test(venue.name)
    const match = matchVenueToCdc({ ...venue, type: isCentre ? 'hawker_centre' : undefined }, cdc)
    if (!match.cdcAccepted) return venue
    // Drop the CDC copy only when it is the same place: a whole centre, or a CDC entry that is one stall.
    // A stall inside a centre (Jian Bo Shui Kueh in Tiong Bahru Market) keeps the centre's CDC site.
    const site = cdc.find((s) => s.id === match.siteId)
    if (isCentre || site.siteKind === 'food_stall') dropped.add(site.id)
    return { ...venue, cdcAccepted: true, cdc: { siteId: site.id, match: match.cdcAccepted, stallCount: site.cdc.stallCount } }
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

// A OneMap place that a hand-made list already has (the frontend's Tiong Bahru Market, the mock data's museum) is
// left out, so a place is never suggested twice. Same place = within 300 m with a similar name, or the same
// kind of place within 50 m.
export function dropKnownPlaces(candidates, known, { meters = 300, minSimilarity = 0.5, sameKindMeters = 50 } = {}) {
  return candidates.filter((c) => !known.some((k) => {
    const m = haversineKm(c, k) * 1000
    return (m <= meters && nameSimilarity(c.name, k.name) >= minSimilarity) || (m <= sameKindMeters && c.kind && c.kind === (k.kind ?? k.cuisine))
  }))
}

const readOptionalJson = (name) => (fs.existsSync(new URL(name, MOCK_DIR)) ? readJson(name) : null)

export function loadPlanData({ fresh = false } = {}) {
  if (cached && !fresh) return cached
  const mock = readJson('mock-data.json')
  const curated = readJson('curated-venues.json').venues
  const cdc = readJson('cdc-venues.json').venues
  const { areas } = readJson('areas.json')

  const onemapFile = readOptionalJson('onemap-places.json')
  const mockVenues = mock.venues.map((v) => ({ ...v, source: v.source ?? 'mock' }))

  // The frontend's hawker centres replace their CDC copies, and so do OneMap's (which have photos and stall counts).
  const { venues: curatedMerged, droppedCdcIds } = mergeCuratedWithCdc(curated, cdc)
  const onemapNew = dropKnownPlaces(onemapFile?.venues ?? [], [...mockVenues, ...curatedMerged])
  const { venues: onemapMerged, droppedCdcIds: droppedByOnemap } = mergeCuratedWithCdc(onemapNew, cdc)
  const dropped = new Set([...droppedCdcIds, ...droppedByOnemap])

  const venues = attachClosures(
    [...mockVenues, ...curatedMerged, ...onemapMerged, ...cdc.filter((v) => !dropped.has(v.id))],
    onemapFile?.hawkerClosures ?? [],
  ).map((v) => withEstimatedMrtWalk(v, areas))

  cached = {
    venues,
    areas,
    occasionProfiles: mock.occasionProfiles,
    weatherCases: mock.weatherCases,
    visitHistory: mock.visitHistory,
    _meta: {
      // The mock visit history is dated relative to this day, so anti-repeat stays meaningful in the demo.
      today: mock._meta.today,
      sources: {
        mock: mock.venues.length,
        curated: curated.length,
        onemap: onemapMerged.length,
        onemapSkippedAsKnown: (onemapFile?.venues.length ?? 0) - onemapNew.length,
        cdc: cdc.length - dropped.size,
        cdcMergedIntoCurated: dropped.size,
        hawkerClosures: onemapFile?.hawkerClosures.length ?? 0,
      },
    },
  }
  return cached
}
