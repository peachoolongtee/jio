# Engine integration: joined venue data, itinerary slots and the planner API

Changes made on 6 Oct 2026 on `feature/backend-engines`, so the frontend can use the backend engine instead of its in-browser planner. This explains what changed and why, so whoever is asked about it can explain it. The request and response formats are in [planner-api.md](planner-api.md).

## The decision this implements

The frontend (`dev` branch) had its own planner in `frontend/src/lib/planner/`, with different rules from the backend engine. We agreed to split the work:

- **The frontend keeps the slot logic** (`slots.js`): turning everyone's category picks into a timed itinerary for the day.
- **The backend engine ranks venues for each slot**, because it has what the frontend planner lacks: diet filters, the fairness ledger, unknown-data handling, explanations, regret line, anti-repeat and the CDC layer.
- **The meeting point supports both rules**, because the team has not chosen yet:
  - the frontend's "best real MRT station" (the default, since a named station is easier to show)
  - the engine's fairness-weighted centre

  It is one parameter (`method`) on `/api/meeting-area`.

## 1. One venue list from three sources

`backend/src/db/venues.js` → `loadPlanData()` builds the `data` object the engine reads:

| Source | File | Venues | Built by |
|---|---|---|---|
| Fictional mock venues | `src/db/mock/mock-data.json` | 36 | by hand |
| The frontend team's real places | `src/db/mock/curated-venues.json` | 63 | `pnpm build:venues` |
| CDC voucher food sites | `src/db/mock/cdc-venues.json` | 1,414 of 1,422 | `pnpm build:cdc` |
| **Total** | | **1,513** | |

It also loads `src/db/mock/areas.json`: the 37 MRT stations and neighbourhoods the frontend uses as meeting-area candidates.

### Converting the frontend's places (`src/planner/venue-adapter.js`)

The frontend list is lighter than the engine format. `fromFrontendVenue()` keeps the frontend's `id`, so the UI can match results to its own list. It fills in the rest like this:

| Engine field | Comes from | Note |
|---|---|---|
| `rating` | frontend `rating / 2` | Their scale is 0–10, ours 0–5. |
| `openingHours`, `mealPeriods` | `hours`, `serves` | `"17:00-02:00"` runs past midnight. |
| `mrtWalkMinutes`, `nearestMrt` | `mrtWalk`, `mrt` | |
| `cdcAccepted` | `tags` includes `cdc` | |
| `diet` | **unknown** for food and drink, `null` for shop and activity | The list has no diet data. "Unknown" is not "none": strict mode leaves these out for anyone with a diet need. |
| `stepFree`, `sockets` | **unknown** (`null`) | |
| `attributes` (quiet, romantic, cozy…) | **defaults per kind**, nudged by tags | `KIND_DEFAULTS` in the adapter. These drive occasion fit, so they matter. They are guesses, not measurements. |
| `noise`, `maxGroupSize`, `longStayOk` | defaults per kind | Also guesses. |
| `exposure` (rain) | indoor + MRT walk, or 4–5 if outdoor | |
| `forecastArea` | rough region from coordinates | Same as the CDC sites. |
| `cuisine` | `kind` (hawker, cafe, bar…) | No real cuisine, so cuisine likes only match the kind. |

Every converted venue has `dataQuality` saying which fields are defaults or unknown.

### Hawker centres listed twice

Maxwell Food Centre is in the frontend list *and* is a CDC site. `mergeCuratedWithCdc()` keeps the named curated venue and drops the CDC copy (8 dropped). The rules, reusing `matchVenueToCdc()` from the CDC adapter:

- **Is it a whole centre?** Decided from the name ("market", "food centre", "makan place"…), because the frontend uses `kind: 'hawker'` for single stalls too.
- **A whole centre** within 150 m of a CDC site, or with a matching stall name within 80 m, replaces that site.
- **A single stall** inside a centre (Jian Bo Shui Kueh in Tiong Bahru Market) does **not** remove the centre's CDC site. The centre's other stalls are still a valid venue.
- **Never by distance alone:** a café next to a hawker centre is not merged.

### Estimated MRT walk

The last-stop rule needs "minutes to the MRT". Only the curated venues have it. `withEstimatedMrtWalk()` fills it in for the mock and CDC venues: distance to the nearest station in `areas.json`, at the frontend's walking speed (5 km/h, streets 25% longer than a straight line).

`areas.json` has only 37 of Singapore's stations, so the estimate can only be **longer** than the real walk. It may wrongly exclude a venue, but never wrongly include one. These venues are marked `mrtWalkEstimated: true`.

Without this, last-stop food slots in strict mode came back empty 25 times out of 30 (pairs of our mock members at 12:00 and 18:30). With it, 4 out of 30.

### Regenerating the data

- After the frontend team edits their venues or areas: `pnpm --filter jio-backend build:venues` (reads `frontend/src/lib/mock/venues.js` and `places.js`; needs those files, which are on `dev`). Commit both JSON files it writes.
- After a new CDC snapshot: put it at `backend/data/CDC.json` and run `pnpm --filter jio-backend build:cdc`.

## 2. Engine changes for the slot flow

All in `backend/src/planner/`. Defaults are unchanged, so every earlier test still passes.

| Change | Where | Why |
|---|---|---|
| **Open for the whole slot** | `filters.js` `isOpenFor()`, used when `durationMinutes` is given | A slot is "eat 12:00 to 13:30", so a place closing at 13:00 must not be suggested. Same rule as the frontend's `isOpenDuring`, including past-midnight hours. |
| **`shop` category** | no code change needed | Shops have `diet: null`, so dietary filters skip them, like activities. |
| **`near_mrt:N` constraint** | `filters.js` `rejectionReasons()` | Within N minutes' walk of an MRT. An unknown walk time follows strict/lenient, like `step_free`. |
| **Last stop** | `engine.js` `lastStopRules()`, `input.lastStop` | The frontend's rule: the last stop must be near an MRT (`near_mrt:10`), and the trip home counts. Adds the `returnWorst` factor (longest trip home) with weight 15. |
| **Given centre** | `engine.js` `converge()`, `input.centre` | The meeting area is chosen once, then every slot is ranked around that same point instead of recomputing it. |
| **Crowd** | `scoring.js` `crowdEstimate`, `crowdPenalty`, `crowdLevel` | Ported from the frontend's `crowd.js` (same hourly profiles and thresholds, credited in the code). Every result gets a `crowd` label. It **only affects the ranking when a `crowd` weight is sent**; the defaults are unchanged. Only curated venues have the `kind` and `popularity` it needs; others are `unknown` (neutral 50). |
| **Meeting area** | `engine.js` `meetingArea()` | `station`: the frontend's rule (shortest longest-journey, ties by fairness-weighted average). `weighted_centroid` / `centroid` / `minimax`: the engine's points, named after the nearest area. |
| **`dietUnknown` on results** | `filters.js` `unknownDietNeeds()` | In lenient mode, a venue with no halal data passed with no warning, and almost every curated venue is like that. The UI can now say "halal status not known". |

### Meeting area: why it tries every area by default

A shortcut that only tried the 8 areas nearest the "fairest by distance" point missed the best area for **67 of 2,000 random groups (3.4%)**, adding up to 7.5 minutes to the longest trip. Jurong East + Woodlands got Ang Mo Kio (51.9 min) instead of Bishan (49.4 min).

Trying 16 areas never missed in those 2,000 groups. With fake travel times every check is free, so the default tries all 37. Once OneMap is in, pass `maxCandidates: 16` to save routing calls: 16 instead of 37 calls per person.

## 3. What each option shows, and search

Added so the frontend loses nothing when it switches to the API. Each Converge and Roam result now has the same option details the frontend's `scoreVenue` produced.

| Field | Where | Rule |
|---|---|---|
| `walkMinutes` | `geo.js` `walkMinutes()` | The frontend's formula: 5 km/h, streets 25% longer than a straight line, under 50 m is 0. Measured from the meeting point (Converge) or the current point (Roam). The estimated MRT walk uses the same function. |
| `reasons` | `scoring.js` `reasonTags()` | The frontend's tags, in the same order, at most two: "Indoor" (in rain), "Easy trip home" (last stop, longest trip home 35 min or less), "Near MRT" (5 min or less), "Quiet at HH:MM", "Short walk" (5 min or less), "Hidden gem", "Budget friendly" (under $10). |
| `warnings` | `scoring.js` `rainWarning()` | `['rain']` when rain is likely (0.6 or more) at a venue that is not indoor and has exposure 2 or more. Same thresholds as `rainCheck()`. |
| `swap` | `engine.js` `indoorSwap()` | For a rain warning, an indoor alternative not already shown and not in `currentOptionIds`. First the best-ranked indoor venue on the shortlist. If there is none, the nearest indoor venue that passed the filters, within 3 km. |

**Why the swap needed a fallback.** The radius search stops as soon as it has 3 venues. If the 3 nearest places are all parks, the indoor places just further out are never scored, so a swap taken only from the shortlist came back empty. The test that caught it has three parks and two indoor places, the second about 670 m away. On real data in rain, 120 of 170 warned results got a swap; the rest had no indoor place within 3 km that passed the filters.

**Search by name** (`engine.js` `searchVenues()`, `POST /api/search`) replaces the frontend's `searchVenuesForSlot`.
- It matches the venue name, its area, or a CDC stall name. "Chicken rice" finds the hawker centres with a chicken rice stall, not only venues with it in their name.
- Each match runs through the same filters as the slot (duration, category, diet, last stop), plus `far` past 3 km, and says why it doesn't fit.
- Fitting places come first, then by walking time, at most 12.

## 4. Bug fixed along the way

- **Regret line said "would add 0 minutes"** (`scoring.js` `regretCounterfactual`). The gap was checked before rounding, so 0.3 minutes passed and then printed as 0. It now rounds first and hides gaps under one minute.

## 5. The API

`backend/src/routes/plan.js`, mounted in `src/app.js`:

- `POST /api/meeting-area`
- `POST /api/converge`
- `POST /api/roam`
- `POST /api/search`

Every request is checked by zod (`src/routes/plan-schemas.js`) before the engine runs:

- Occasions and weather cases must exist.
- Constraints must be known words (a typo like `step-free` is a 400, not a silent pass).
- Weights must be 0 or more, and only for factors that engine has.
- Points must be in Singapore.
- Diet words are lowercased.
- Member ids must be unique.
- At least one member must not have opted out.

Bad input gets a 400 naming every bad field. A body that isn't JSON gets a 400. A bug gets a 500, in JSON, never an HTML page.

In stub mode, the existing `x-jio-scenario` header also drives the planner: `rain` switches the weather case, and `routing-fail` makes every trip an estimate (results come back `approximate: true`).

## 6. Tests

`pnpm test`: 14 files, **183 passing** (was 132), 1 skipped (needs the raw `CDC.json`).

| File | What it checks |
|---|---|
| `tests/venues.test.js` (new, 12) | Converting frontend places, merging hawker centres with CDC, estimated MRT walk, and the combined data (no duplicate ids, every venue has what the engine reads). |
| `tests/slots.test.js` (new, 14) | Open for the whole slot, `near_mrt`, last stop, `shop`, given centre, crowd, `dietUnknown`, every meeting-area method, and the full flow: meet once, then rank three slots. |
| `tests/options.test.js` (new, 9) | Walk minutes, every reason tag, rain warning, indoor swap (including `currentOptionIds` and the fallback beyond the shortlist), and search (name, area, stall, why it doesn't fit, sort order). |
| `tests/plan-routes.test.js` (new, 14) | The four endpoints over real HTTP: good requests, every kind of 400, and the stub `rain` and `routing-fail` scenarios. |
| `tests/stress.test.js` (extended) | Now runs on the joined data, plus 100 random itinerary slots (random meeting method, duration, category, last stop, crowd weight, weather). Every result is checked against every rule, including: a swap only with a rain warning, never already shown, always indoor. |
| `tests/edge-cases.test.js` (one added) | The regret rounding bug. |

Two tests were checked by breaking the code on purpose, to make sure they can fail:

- The rain-scenario test fails if the scenario is not wired up.
- The meeting-area test fails with the 8-candidate shortcut.

## 7. Still to agree or do

**For the team:**

- **Meeting point:** `station` (frontend rule, default) or `weighted_centroid` (engine rule, uses the fairness ledger more strongly)? In `station`, travel debt only breaks ties.
- **Strict or lenient by default?** Curated venues have no diet data, so strict mode hides all of them from anyone halal, vegetarian or vegan. Strict drink slots for those members are often empty: only 5 of 30 pair/time combinations returned venues, because the only drink venues with known diet data are the mock ones.
- **Meal windows differ slightly:**
  - frontend: breakfast 07:00–10:30, tea until 17:30
  - engine: breakfast 04:00–11:00, tea until 17:00

  The frontend also applies meal windows to drinks; the engine only to food. Pick one.
- **Search radius differs:**
  - frontend: 1.2 km, widened once to 2.4 km
  - engine: 0.5, 1, 2, then 3 km

  The API uses the engine's. The engine already accepts a `radius` option, but the API does not expose it yet.
- **Defaults are guesses:** curated venue attributes and group sizes (`KIND_DEFAULTS`) are defaults. Better data (user tags, reviews) would make occasion fit meaningful.

**For the frontend (`frontend/src/lib/api.js`):**

- Replace the in-browser ranking with calls to these endpoints:
  - `chooseMeetingArea` becomes `/api/meeting-area`
  - `rankForSlot` becomes `/api/converge` with `centre`, `durationMinutes`, `categories`, `lastStop` and `currentOptionIds`
  - `searchVenuesForSlot` becomes `/api/search`
- **Then delete the frontend's own ranking** (`scoreVenue`, `rankForSlot`, `indoorSwap`, `chooseMeetingArea`, `crowd.js`), so there is only one.
- Votes, options and slots stay where they are.
- Show `walkMinutes`, `reasons`, `crowd`, `warnings`, `swap`, `verify`, `dietUnknown` and `approximate` as described in [planner-api.md](planner-api.md).

**Backend, later:**

- Real travel times from OneMap (`services/onemap.js`).
- Live weather from NEA.
- The database instead of JSON files (`loadPlanData` is the one place to change).
- The mock `today` date (`2026-10-04`) is used for anti-repeat until real visit history exists.

## Files

**New:**
- `backend/src/planner/venue-adapter.js`
- `backend/src/db/venues.js`
- `backend/src/routes/plan-schemas.js`
- `backend/scripts/build-venues.js`
- `backend/src/db/mock/curated-venues.json` (generated)
- `backend/src/db/mock/areas.json` (generated)
- `backend/docs/planner-api.md`
- `backend/docs/engine-integration.md`
- `backend/tests/venues.test.js`
- `backend/tests/slots.test.js`
- `backend/tests/plan-routes.test.js`
- `backend/tests/options.test.js`

**Changed:**
- `backend/src/planner/engine.js`
- `backend/src/planner/filters.js`
- `backend/src/planner/scoring.js`
- `backend/src/planner/geo.js` (`walkMinutes`)
- `backend/src/routes/plan.js` (was empty)
- `backend/src/app.js`
- `backend/package.json` (`build:venues` script)
- `backend/tests/stress.test.js`
- `backend/tests/edge-cases.test.js`
- `README.md` (API and docs links)
