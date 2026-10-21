# Backend engine: every change, and what the frontend needs to change

One file for the team: everything that changed on `feature/backend-engines`, and a step-by-step guide for switching the frontend from its in-browser planner to the backend API.

- Request and response details: [planner-api.md](planner-api.md)
- Why each engine and data decision was made: [engine-integration.md](engine-integration.md)

**Status (9 Oct 2026):** the frontend now calls the planner API (Jonathan, 8 Oct). The backend now uses **live NEA weather** (Ian) and **real OneMap travel times**, and has **OneMap address search** (branch `feature/external-apis`). One optional frontend change uses the address search: see [Part D](#part-d-live-weather-travel-times-and-address-search-9-oct).

---

# Part A: every change on `feature/backend-engines`

Six commits after `7fc0a66 changed the cdc-venues.json`. Only `backend/` and one paragraph of `README.md` changed. **No frontend file was changed.**

## 1. `61e65fb` Move the planner to `import`/`export` and run the engine tests in Vitest

**Problem:** `backend/package.json` says `"type": "module"`, but the planner files used `require`, and the engine tests used `node:test`. On this branch, 7 of 8 test files failed before a single test ran.

**Change:**
- The planner files (`src/planner/*.js`) switched from `require`/`module.exports` to `import`/`export`. Only how files load each other changed, not what the code does.
- The engine tests run in Vitest (same `assert` checks) and load data from `src/db/mock/`.
- `build-cdc.js` moved from `tests/` to `scripts/`, because it is a build script, not a test, and could not run from `tests/`. Run it with `pnpm --filter jio-backend build:cdc`.
- The raw 11.5 MB `CDC.json` belongs in `backend/data/`, which is gitignored. The one test that reads it skips itself when the file is absent.

## 2. `3944775` Fix 5 engine bugs found by a stress test, and add the stress test

**Stress test** (`tests/stress.test.js`): about 1,500 random but seeded groups, venues, times and constraints. Instead of one expected answer, it checks rules that must hold for every input:
- results sorted by score
- hard filters respected
- inside 3 km
- return-trip limits respected
- scores between 0 and 100, and no NaN
- same input gives the same output
- member order doesn't change the ranking
- fairness pulls the centre toward the person owed
- minimax never loses to the centroid
- ledger changes sum to zero
- strict results are a subset of lenient results
- Borda points are conserved

**Bugs it found, now fixed.** Each has its own test in `tests/edge-cases.test.js`, and each test fails on the old code:

| Bug | Fix |
|---|---|
| Routing returning `null` or `NaN` (OneMap down) **crashed** the engine | Falls back to the estimate. The result is marked `approximate: true`. |
| A member with no budget made **every score NaN**, so the ranking was garbage | Members with no budget are left out of the price average. |
| An unknown occasion or weather case crashed with an unclear `TypeError` | Clear error naming the valid values. |
| Opening hours past midnight (`22:00-02:00`) counted as **always closed** | Now open late at night and early morning. |
| A venue with no precomputed occasion fit was treated as **fit 0** and cut from the shortlist | Its fit is calculated, the same way the final score does it. |

**Also found:** in strict mode, 13 of 57 groups of the mock members got no results for a 7pm dinner. That's a data issue (unknown diet data), not a bug. It's listed under "To decide" below.

## 3. `2eb72d0` Join the mock, frontend and CDC venues into one list

`src/db/venues.js` → `loadPlanData()` served **1,513 venues** at this commit (it serves 1,782 by default now, with the OneMap places and without the invented ones: see [engine-integration.md](engine-integration.md)):
- 36 mock venues (since left out of the default pool; they are served only with `INCLUDE_FICTIONAL_VENUES=1`, which the tests set)
- 63 frontend places, converted by `src/planner/venue-adapter.js`
- 1,414 CDC food sites

It also serves 37 meeting areas (`areas.json`, copied from the frontend's `AREAS`).

- **Frontend places keep their ids** (`maxwell-food-centre`). Unknown details (diet, step-free) stay **unknown**. Details the list doesn't give (how quiet or romantic, group size) are **defaults per kind of place**, labelled in `dataQuality`.
- **Hawker centres listed twice** (frontend and CDC) are merged into the named venue. 8 CDC copies were dropped.
- **MRT walk** is estimated for mock and CDC venues from the nearest station (`mrtWalkEstimated: true`). The estimate can only be too long, never too short.
- `geo.js` gained `walkMinutes()`, the frontend's walking formula.
- Regenerate after the frontend list changes: `pnpm --filter jio-backend build:venues`.

## 4. `cfd294d` Slot features, option details and search in the engine

**For the slot flow:**
- **Open for the whole slot:** `durationMinutes`.
- **`shop` category.**
- **Last stop:** near an MRT, and the trip home counts.
- **Given centre:** meet once, then rank every slot around that point.
- **Crowd**, ported from the frontend's `crowd.js`.
- **Meeting area:**
  - `station` (the frontend's rule)
  - `weighted_centroid`, `centroid`, `minimax` (the engine's)

**What each option shows (same as the frontend's `scoreVenue`):**
- `walkMinutes`
- `reasons`, up to 2 tags
- `crowd`
- `warnings` (`['rain']`)
- `swap`: an indoor alternative, never already shown or already an option
- `dietUnknown`: diet needs we have no data on (lenient mode)

**Search by name** (`searchVenues`). It matches the name, the area or a CDC stall name, and says why a place doesn't fit.

**Bugs found while building, fixed:**
- **"Best MRT station" could miss the fairest station.** A shortcut that tried only the 8 nearest picked a worse station for 3.4% of random groups. It now tries all of them.
- **The indoor swap came back empty** when the 3 nearest places were outdoors. It now falls back to the nearest indoor place within 3 km.
- **Regret line could say "would add 0 minutes".** It now rounds first.
- **Lenient mode passed venues with no halal data silently.** Now flagged in `dietUnknown`.

## 5. `cfa00f3` The planner API

`POST /api/meeting-area`, `/api/converge`, `/api/roam` and `/api/search` (`src/routes/plan.js`).
- Every request is checked with zod (`src/routes/plan-schemas.js`). Bad input gets a 400 naming each wrong field.
- "Halal" with any capitalisation works. Negative weights and typo constraints are rejected.
- Errors are always JSON.
- Stub mode: the `x-jio-scenario` header (`rain`, `routing-fail`) drives the planner for Playwright.

## 6. `a2d7f05` Docs

`backend/docs/planner-api.md`, `backend/docs/engine-integration.md` and a README paragraph. This file was added after those commits.

## Outside the repo

`Jio_Engine_Algorithms_updated.xlsx` (in the WAD2 project folder):
- statuses updated to match the code
- missing filters and algorithms added
- a Next Steps sheet

## Tests

`pnpm test`: 14 files, **183 passing**, 1 skipped (needs `backend/data/CDC.json`). It was 19 passing before this branch (the rest couldn't run).

---

# Part B: what the frontend needs to change

Everything is in **`frontend/src/lib/api.js`**, plus one display fix in `SuggestionCard.vue` and deleting old planner code. Slots, voting, options, the itinerary and the UI stay as they are.

## Step 0: run both

```bash
cp backend/.env.example backend/.env
pnpm dev:backend
pnpm dev:frontend
```

- `frontend/.env` already has `VITE_API_BASE_URL=http://localhost:3000`.
- The backend allows `http://localhost:5173` by default (`FRONTEND_ORIGIN`).
- `api.js` already exports an axios client called `api` pointing there.

## Step 1: build the request from a session

The backend needs coordinates, a date-time and an occasion. The session has area ids, minutes and a date, so add two helpers next to `origins()` and `homes()`:

```js
// Members as the backend expects them: start and end as { lat, lng } from the area ids.
function membersFor(session) {
  return activeIds(session)
    .filter((id) => session.locations[id]?.start)
    .map((id) => {
      const start = areaById(session.locations[id].start.areaId)
      const end = endPlaceOf(session, id)
      return { id, name: nameOf(id), start: { lat: start.lat, lng: start.lng }, end: { lat: end.lat, lng: end.lng } }
    })
}

// "2026-10-10T15:00" from the session date and a slot's start (minutes after midnight).
const dateTimeFor = (session, minutes) => `${session.date}T${P.fromMinutes(minutes)}`
```

**Occasion:** sessions don't have one, but the backend requires it (`date`, `birthday`, `coffee_chat`, `study`, `catch_up`, `casual_meal`). Until the create-session screen asks for it, send `'catch_up'`.

**Diet:** the frontend's people have no `dietary` field, so nobody gets diet filtering yet. When profiles get a diet field, add `dietary: ['halal']` to each member.

## Step 2: meeting area → `POST /api/meeting-area`

Replace the body of `computeMeeting(session)`:

```js
async function computeMeeting(session) {
  const members = membersFor(session)
  if (members.length < P.MIN_LOCATIONS) return null
  const { data } = await api.post('/api/meeting-area', {
    members,
    // The demo's "routing off" switch: the geographic centre, named after the nearest area.
    method: db.conditions.routing ? 'station' : 'centroid',
  })
  const minutes = Object.values(data.travelByMember)
  // The same fields chooseMeetingArea returned, so the rest of api.js keeps working.
  return {
    areaId: data.area.id,
    method: data.method === 'station' ? 'fairest' : 'centre', // the values meetingResultLine() expects
    times: data.travelByMember,
    maxMinutes: Math.round(data.worstMinutes),
    totalMinutes: Math.round(minutes.reduce((sum, m) => sum + m, 0)),
    count: members.length,
    approximate: data.approximate,
  }
}
```

- `data.area.id` is the same id as in the frontend's `AREAS`, so `areaById(session.meeting.areaId)` keeps working.
- `meetingResultLine()` expects the `method` values `'same'`, `'centre'` and `'fairest'`, so the code above maps `station` → `'fairest'` and `centroid` → `'centre'`. The backend has no separate "everyone starts from the same place" case; it just picks that area, so the line says "nobody travels more than N minutes".

## Step 3: ranking a slot → `POST /api/converge`

Replace `rankSlot(session, slot, slots)`:

```js
async function rankSlot(session, slot, slots) {
  const area = areaById(session.meeting.areaId)
  const { data } = await api.post('/api/converge', {
    members: membersFor(session),
    occasion: session.occasion || 'catch_up',
    dateTime: dateTimeFor(session, slot.start),
    durationMinutes: slot.duration,
    categories: [slot.category],
    centre: { lat: area.lat, lng: area.lng },
    lastStop: slots[slots.length - 1]?.id === slot.id,
    currentOptionIds: session.options[slot.id] || [],
    ...(db.conditions.rain ? { weatherCase: 'rain' } : {}), // only for the demo rain switch: see Part D
    unknownPolicy: 'lenient', // see "To decide" below
    topN: P.OPTIONS_MAX,
  })
  rememberVenues(data.results) // step 5
  return { options: data.status === 'ok' ? data.results.map(toOption) : [], widened: !!data.notice, empty: data.status === 'empty' ? data : null }
}

// One backend result -> the option shape SuggestionCard reads.
function toOption(r) {
  return {
    venue: toCardVenue(r.venue), // step 4
    walk: r.walkMinutes,
    crowd: r.crowd,
    reasons: r.reasons,
    warnings: r.warnings,
    swap: r.swap ? { id: r.swap.venueId, name: r.swap.name } : null,
    rank: r.rank,
    score: r.score, // a penalty: lower is better
    explanation: r.explanation,
    verify: r.verify,
    dietUnknown: r.dietUnknown,
    approximate: r.approximate,
  }
}
```

**⚠️ Score direction is opposite.** The backend's `score` is a penalty: **lower is better**. `getPlan` currently sorts with `.sort((a, b) => b.score - a.score)`, which would put the worst option first. Sort by `rank` (1 is best), or by `a.score - b.score`.

**⚠️ It becomes async.** `rankSlot` and `computeMeeting` are now network calls. Every function that calls them, directly or through `syncOptions`, needs `await`. The internal helpers must become `async`; the exported ones already are:

| Calls | Functions in `api.js` |
|---|---|
| `rankSlot` | `syncOptions`, `addMoreOptions`, `getPlan`, `confirmPlan` |
| `computeMeeting` | `applyTrigger`, `reopenVoting`, `setConditions` (its loop over sessions) |
| `syncOptions` | `applyTrigger`, `useMeetingArea`, `optOut`, `setPreferences`, `deleteSlot`, `restoreSlots`, `reopenVoting` |

`syncOptions` loops over every slot. Use `Promise.all` so the slots load in parallel.

**Empty slot:** `data.status === 'empty'` means nothing fits. `data.reason` says why, and `data.hints` says what to relax ([planner-api.md](planner-api.md#post-apiconverge)). That replaces "the slot has nothing nearby".

**Rain swap:** `swap` was computed by `P.indoorSwap` in `getPlan`. It now comes on each result, so delete that line.

## Step 4: venue fields have different names

The backend sends venues in the engine's format. Convert them where the cards expect the frontend's names:

| Card reads (frontend) | Backend sends | Note |
|---|---|---|
| `venue.price` | `venue.avgPricePerPerson` | |
| `venue.indoor` | `venue.setting === 'indoor'` | Also `'outdoor'` or `'mixed'`. |
| `venue.mrt`, `venue.mrtWalk` | `venue.nearestMrt`, `venue.mrtWalkMinutes` | Estimated for mock and CDC venues (`mrtWalkEstimated: true`). |
| `venue.rating` (0–10) | `venue.rating` (**0–5**, or **`null`** for CDC sites) | Multiply by 2. Show "No rating" for `null`. |
| `venue.hours` (`["07:30-20:00"]`) | `venue.openingHours` (`[["07:30","20:00"]]`) | |
| `venue.serves` | `venue.mealPeriods` | |
| `venue.tags` (`cdc`, `hidden`, `touristy`) | `venue.tags` (frontend places only), `venue.cdcAccepted` | Add `'cdc'` when `cdcAccepted`. |
| `venue.kind`, `venue.popularity` | the same, **frontend places only** | Missing on mock and CDC venues. |
| `venue.name`, `area`, `category`, `lat`, `lng`, `id` | the same | |
| `option.walk` | `result.walkMinutes` | |
| `option.swap.id` | `result.swap.venueId` | |

```js
function toCardVenue(v) {
  return {
    ...v,
    price: v.avgPricePerPerson,
    indoor: v.setting === 'indoor',
    mrt: v.nearestMrt,
    mrtWalk: v.mrtWalkMinutes,
    rating: v.rating == null ? null : v.rating * 2,
    hours: v.openingHours.map(([open, close]) => `${open}-${close}`),
    serves: v.mealPeriods,
    tags: [...new Set([...(v.tags || []), ...(v.cdcAccepted ? ['cdc'] : [])])],
  }
}
```

## Step 5: venues are no longer only the frontend's 63

Results can include mock venues (`v25`) and CDC sites (`cdc_570511`). These aren't in `VENUES`, so `venueById(id)` returns `undefined` for them. That breaks `addOption`, `swapOption` and `getItinerary` (`session.plan.stops`).

Keep every venue the API returns:

```js
// Every venue the backend has sent, by id, so options and the itinerary can show it later.
function rememberVenues(results) {
  db.venues = db.venues || {}
  for (const r of results) db.venues[r.venue.id] = toCardVenue(r.venue)
}
const venueById = (id) => db.venues?.[id] || VENUES.find((v) => v.id === id)
```

`db` is saved to localStorage, so remembered venues survive a reload. Bump `VERSION` so old saved data resets cleanly.

## Step 6: search → `POST /api/search`

Replace the body of `searchVenuesForSlot`:

```js
const { data } = await api.post('/api/search', {
  query: q,
  centre: { lat: area.lat, lng: area.lng },
  dateTime: dateTimeFor(session, slot.start),
  durationMinutes: slot.duration,
  categories: [slot.category],
  lastStop: isLast,
  members: membersFor(session),
})
return data.results.map((r) => ({
  id: r.venueId, name: r.name, area: r.area, category: r.category, walk: r.walkMinutes,
  unfit: r.unfit[0] || '', // first reason; see the table in planner-api.md
  added: (session.options[slotId] || []).includes(r.venueId),
}))
```

- Search results don't include the full venue. Before adding one, call `/api/converge` for that slot, or show the search fields only.
- **`addOption`** checks with `P.unfitReason` and `P.WIDE_RADIUS_KM`. Use the search result's `fits` instead: only offer "Add" when `fits` is true.
- The `unfit` words differ:

  | Frontend | Backend |
  |---|---|
  | `meal` | `meal_period` |
  | `mrt` | `near_mrt` |

  `category`, `closed` and `far` are the same. The backend adds `diet:halal`, `capacity`, and others.

## Step 7: the demo switches (`db.conditions`)

| Switch | Send |
|---|---|
| Rain | `weatherCase: 'rain'`. When the switch is off, **leave `weatherCase` out** so the live NEA forecast is used (Part D). |
| Routing off | `method: 'centroid'` on `/api/meeting-area` (step 2). For Playwright, the backend's stub `routing-fail` scenario is more realistic: results come back `approximate: true`. |
| Simulate crowd | No exact equivalent. The backend has no "+0.4 boost". Closest: send `weights: { worst: 25, mean: 5, occasion: 25, preference: 10, weather: 12, price: 8, cdc: 3, antiRepeat: 2, crowd: 20 }` so crowd counts in the ranking. |

## Step 8: crowd can be `unknown`

`SuggestionCard.vue` has `CROWD_TONE = { quiet, moderate, busy }`, and `crowdText()` reads `CROWD_LABELS`. Mock and CDC venues come back with `crowd: 'unknown'`, which would show "undefined · est.":

- Add `unknown: 'neutral'` to `CROWD_TONE`.
- Add `unknown: 'Crowd unknown'` to `CROWD_LABELS` in `crowd.js`. Or hide the tag when crowd is unknown.

## Step 9: show the new information (optional, recommended)

| Field | Show it as |
|---|---|
| `explanation` | One line under the card: why it ranked here. |
| `verify` | "Check the stall": the diet was only guessed from a stall name. |
| `dietUnknown` | "Halal status not known". |
| `approximate` | "About 25 min": travel time is an estimate. |
| `regret` (top level of the converge response) | "Picking X instead would add 9 minutes to Faith's journey". |

## Step 10: delete the old ranking, keep the rest

Once steps 2–8 work, delete the frontend's ranking so there's only one algorithm:

| File | Delete (now in the backend) | Keep (frontend logic) |
|---|---|---|
| `planner/suggestions.js` | `scoreVenue`, `rankForSlot`, `unfitReason`, `indoorSwap`, `SEARCH_RADIUS_KM`, `WIDE_RADIUS_KM`, `LAST_STOP_MRT_WALK` | `reconcileOptions`, `moreOptions`, `OPTIONS_START`, `OPTIONS_MAX` (voting and options) |
| `planner/meetingArea.js` | `chooseMeetingArea` | `meetingResultLine`, `MIN_LOCATIONS` (display) |
| `planner/crowd.js` | `crowdScore`, `crowdLevel`, `CROWD_PENALTY` | `crowdText`, `CROWD_LABELS` (display, used by `SuggestionCard`) |
| `planner/timeOfDay.js` | `isOpenDuring`, `fitsMealWindow` (if nothing else uses them) | `mealWindow`, `MEAL_WINDOWS` if a screen shows them |
| `planner/travel.js` | nothing | all of it: the itinerary uses `legOptions`, `transitMinutes`, `defaultMode` for walk, MRT and Grab legs |
| `planner/slots.js`, `confirm.js`, `recalc.js`, `itinerary.js`, `format.js`, `geo.js` | nothing | all |
| `planner/__tests__/suggestions.test.js`, `meetingArea.test.js` | the tests for deleted functions | the rest. The backend tests cover the deleted rules (`backend/tests/options.test.js`, `slots.test.js`). |
| `lib/mock/venues.js` | after step 5 works and `nearbyPlaces` (Home) uses `/api/roam` | until then |

`nearbyPlaces(areaId)` (Home screen) also reads `VENUES`. Switch it to `POST /api/roam` with `current` set to the home area's coordinates and `categories: ['eat', 'drink', 'shop', 'activity']`. Or keep it on the local list for now, knowing it shows only the 63 places.

## Step 11: check it

- `pnpm build` passes.
- Create a session, set locations, and the meeting area appears.
- Slots show options in rank order (best first).
- Rain switch: outdoor options get a warning and a swap.
- Search "chicken rice" finds hawker centres.
- Add, swap and vote work with a CDC venue (`cdc_…` id), not just the 63.
- Reload the page: options and the itinerary still show their venues.

---

# Part D: live weather, travel times and address search (9 Oct)

The backend now uses real data (`backend/docs/external-apis.md` has every detail):

| What | Source | What the frontend has to do |
|---|---|---|
| Weather | Live NEA 2-hour forecast (Ian) | Nothing: already done, see Change 1 |
| Travel times | Real OneMap public transport routes | Nothing: same fields as before, just real numbers. `approximate: true` still means "estimate". |
| Start and end points | OneMap address search | **Change 2** below (optional, but the mock list has only a few addresses) |

## Change 1: weather (already done)

Ian changed `frontend/src/lib/plannerApi.js` to send `weatherCase` only when the demo rain switch is on, so the live NEA forecast is used. Nothing more to do. On your own machine, set `ALLOW_SIMULATED_WEATHER=1` in `backend/.env` if you use the rain switch.

Every answer says which weather and travel times it used. Show them so nobody is misled:

| Field | Show |
|---|---|
| `weather.source === 'live'` | e.g. "Forecast until 9.30 pm" (`weather.validUntil`) |
| `weather.source === 'simulated'` | "Demo weather" |
| `weather.source === 'unavailable'` | Nothing about weather: the forecast couldn't be fetched |
| `travel.source === 'estimate'`, or a result's `approximate: true` | "about 25 min" |

## Change 2 (optional): address search with OneMap

`searchPlaces(query)` in `frontend/src/lib/api.js` searches a short mock list (`ADDRESSES`). The backend's `GET /api/places/search?q=` searches all of Singapore through OneMap:

```js
// GET /api/places/search?q=520201
// -> { results: [{ name, address, postal, lat, lng }] }   at most 10. 503 when OneMap can't be reached.
```

The app shows other people only someone's **area**, never their exact place, so match each result to its nearest area. Keep the area matches, and fall back to the mock list if the backend doesn't answer:

```js
export async function searchPlaces(query) {
  const q = query.trim()
  if (!q) return []
  const areas = AREAS.filter((a) => a.name.toLowerCase().includes(q.toLowerCase()))
    .map((a) => ({ id: a.id, label: a.name, sub: 'MRT station and area', areaId: a.id }))
  try {
    const { data } = await planner.api.get('/api/places/search', { params: { q } })
    const places = data.results.map((p, i) => {
      const area = P.nearest(p, AREAS)
      // lat and lng are the exact place: only the person themselves and the server should keep them.
      return { id: `onemap-${p.postal ?? i}`, label: p.name, sub: `${p.address} · ${area.name}`, areaId: area.id, lat: p.lat, lng: p.lng }
    })
    return [...areas, ...places].slice(0, 8)
  } catch {
    // Backend or OneMap down: the old mock search, so the screen still works.
    const addresses = ADDRESSES.filter((a) => a.label.toLowerCase().includes(q.toLowerCase()) || a.postal.startsWith(q))
      .map((a) => ({ id: a.id, label: a.label, sub: `Singapore ${a.postal} · ${areaById(a.areaId).name}`, areaId: a.areaId }))
    return [...areas, ...addresses].slice(0, 8)
  }
}
```

`planner.api` is the axios client `api.js` already imports from `plannerApi.js`, and `P.nearest` and `AREAS` are already imported there. Remove the `await wait(DELAY.read)` fake delay, since this is a real call now.

## Nothing to set up on the frontend

No keys go in the frontend. OneMap's login lives only in `backend/.env` (and in Render's settings for the live server).

# Part C: to decide as a team

1. **Meeting point rule:** `station` (frontend's, default) or `weighted_centroid` (engine's, uses the fairness ledger more strongly). In `station`, travel debt only breaks ties.
2. **Strict or lenient:** the frontend's places have no diet data, so strict mode hides all of them from anyone with a diet need. The guide sends `lenient` and shows `dietUnknown`. Decide before diet fields exist.
3. **Meal windows:**
   - frontend: breakfast 07:00–10:30, tea until 17:30, also applied to drinks
   - engine: breakfast 04:00–11:00, tea until 17:00, food only

   Pick one.
4. **Search radius:**
   - frontend: 1.2 km, widened to 2.4 km
   - engine: 0.5, 1, 2, then 3 km
5. **Occasion:** add it to session creation, or keep a default.
6. **Not built yet** (backend): OneMap routing, NEA weather, the database, venue opening hours from a real source (TIH or Google Places), hints when group size or opening hours rule everything out, `decideVote` with no options.
