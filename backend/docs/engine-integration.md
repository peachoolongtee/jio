# Engine integration: joined venue data, itinerary slots and the planner API

Changes made on 5–6 Oct 2026 on `feature/backend-engines`, so the frontend can use the backend engine instead of its in-browser planner. This explains what changed and why, so whoever is asked about it can explain it.

- Request and response formats: [planner-api.md](planner-api.md)
- Every change in one list, plus the step-by-step frontend switch-over: [changes-and-frontend-guide.md](changes-and-frontend-guide.md)

## Before this: test setup and five engine bugs

Two earlier commits on this branch.

**`61e65fb` Planner on `import`/`export`, tests in Vitest.**
- `backend/package.json` is `"type": "module"`, but the planner used `require` and the engine tests used `node:test`, so 7 of 8 test files couldn't run.
- The planner now uses `import`/`export`. Only how files load each other changed.
- The engine tests run in Vitest and read data from `src/db/mock/`.
- `build-cdc.js` moved from `tests/` to `scripts/` (`pnpm --filter jio-backend build:cdc`). It's a build script, and it couldn't run from `tests/`.
- The raw `CDC.json` goes in `backend/data/` (gitignored).

**`3944775` A stress test, and the five bugs it found.**

`tests/stress.test.js` runs about 1,500 seeded random groups, venues, times and constraints. It checks rules that must hold for every input:
- sorted results, hard filters respected, inside 3 km, return-trip limits
- scores 0–100 and no NaN
- the same input gives the same output, and member order doesn't matter
- fairness pulls toward the person owed; minimax beats the centroid on the worst trip
- the ledger sums to zero; strict results are a subset of lenient; Borda conserves points

Each fix has a test in `tests/edge-cases.test.js` that fails on the old code:

| Bug | Fix | Where |
|---|---|---|
| Routing returning `null` or `NaN` crashed the engine | Falls back to the estimate and marks the result `approximate` | `engine.js` `routedMinutes()` |
| A member with no budget made every score NaN | Members with no budget are left out of the price average | `scoring.js` `pricePenalty()` |
| Unknown occasion or weather case gave an unclear `TypeError` | A clear error listing the valid values | `engine.js` `validateInput()` |
| Hours past midnight (`22:00-02:00`) counted as always closed | Open late at night and early morning | `filters.js` `isOpenAt()` |
| A venue with no precomputed occasion fit was cut from the shortlist as "fit 0" | Its fit is calculated, as in the final score | `engine.js` `prune()` |

The stress test also showed that in strict mode, 13 of 57 groups of our mock members got no results for a 7pm dinner, mostly because of unknown diet data. That's a decision for the team (section 7), not a bug.

## The decision this implements

The frontend (`dev` branch) had its own planner in `frontend/src/lib/planner/`, with different rules from the backend engine. We agreed to split the work:

- **The frontend keeps the slot logic** (`slots.js`): turning everyone's category picks into a timed itinerary for the day.
- **The backend engine ranks venues for each slot**, because it has what the frontend planner lacks: diet filters, the fairness ledger, unknown-data handling, explanations, regret line, anti-repeat and the CDC layer.
- **The meeting point supports both rules**, because the team has not chosen yet:
  - the frontend's "best real MRT station" (the default, since a named station is easier to show)
  - the engine's fairness-weighted centre

  It is one parameter (`method`) on `/api/meeting-area`.

## 1. One venue list from four sources

`backend/src/db/venues.js` → `loadPlanData()` builds the `data` object the engine reads:

| Source | File | Venues | Built by |
|---|---|---|---|
| Fictional mock venues | `src/db/mock/mock-data.json` | 36 | by hand |
| The frontend team's real places | `src/db/mock/curated-venues.json` | 63 | `pnpm build:venues` |
| OneMap's government lists (sport centres, attractions, museums, libraries, theatres, parks, hawker centres), added 9 Oct | `src/db/mock/onemap-places.json` | 463 (20 already known were skipped) | `pnpm build:onemap-places` |
| CDC voucher food sites | `src/db/mock/cdc-venues.json` | 1,332 of 1,422 (90 replaced by named hawker centres) | `pnpm build:cdc` |
| **Total** | | **1,894** | |

Activities went from 20 to about 370 (sports from 2 to 46). See [external-apis.md](external-apis.md#onemap-themes-and-hawker-closures-a-snapshot-not-a-call-per-request).

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

`pnpm test`: 14 files, **183 passing**, 1 skipped (needs the raw `CDC.json`). Before this branch, 19 passed and the other test files couldn't run; after the first two commits, 132 passed.

| File | What it checks |
|---|---|
| `tests/venues.test.js` (new, 12) | Converting frontend places, merging hawker centres with CDC, estimated MRT walk, and the combined data (no duplicate ids, every venue has what the engine reads). |
| `tests/slots.test.js` (new, 14) | Open for the whole slot, `near_mrt`, last stop, `shop`, given centre, crowd, `dietUnknown`, every meeting-area method, and the full flow: meet once, then rank three slots. |
| `tests/options.test.js` (new, 9) | Walk minutes, every reason tag, rain warning, indoor swap (including `currentOptionIds` and the fallback beyond the shortlist), and search (name, area, stall, why it doesn't fit, sort order). |
| `tests/plan-routes.test.js` (new, 14) | The four endpoints over real HTTP: good requests, every kind of 400, and the stub `rain` and `routing-fail` scenarios. |
| `tests/stress.test.js` (new in `3944775`, extended since) | About 1,500 seeded random runs checked against rules that must always hold. Now also runs on the joined data, plus 100 random itinerary slots (random meeting method, duration, category, last stop, crowd weight, weather). Every result is checked against every rule, including: a swap only with a rain warning, never already shown, always indoor. |
| `tests/edge-cases.test.js` (new, 10) | One test per bug: the five from the stress test, and the regret rounding bug. Each fails on the old code. |

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

**For the frontend.** Not done yet; the app still uses its own ranking. The step-by-step guide with code is in [changes-and-frontend-guide.md](changes-and-frontend-guide.md#part-b-what-the-frontend-needs-to-change). In short, in `frontend/src/lib/api.js`:

1. **Build requests from a session:** members' `start` and `end` as coordinates (from their area ids), `dateTime` from `session.date` plus the slot start, and an `occasion` (sessions don't have one yet, so default `'catch_up'`).
2. **Meeting area:** `computeMeeting` calls `/api/meeting-area` instead of `chooseMeetingArea`.
3. **Ranking:** `rankSlot` calls `/api/converge` with `centre`, `durationMinutes`, `categories`, `lastStop`, `currentOptionIds` and `weatherCase`.
4. **Sort by `rank`, not by `score` descending:** the backend's score is lower-is-better. `getPlan` currently sorts highest first, which would show the worst option first.
5. **Async:** `rankSlot` and `computeMeeting` become network calls, so `syncOptions` and every function that calls them need `await`.
6. **Rename venue fields** for the cards: `price` ← `avgPricePerPerson`, `indoor` ← `setting === 'indoor'`, `walk` ← `walkMinutes`, and `rating` is 0–5 (or `null` for CDC), so double it.
7. **Keep the venues the API returns:** results include mock and CDC venues that aren't in the frontend's 63, so `venueById` must look in a cache of API venues too (for add, swap and the itinerary).
8. **Search:** `searchVenuesForSlot` calls `/api/search`, and "Add" uses its `fits`.
9. **Unknown crowd:** handle `crowd: 'unknown'` in `SuggestionCard` (`CROWD_TONE`, `CROWD_LABELS`), or it shows "undefined · est.".
10. **Demo switches:** rain → `weatherCase: 'rain'` (leave `weatherCase` out when the switch is off, so the live NEA forecast is used; see [external-apis.md](external-apis.md)); routing off → `method: 'centroid'`; simulate crowd → a `crowd` weight.
11. **Then delete the frontend's ranking:** `scoreVenue`, `rankForSlot`, `unfitReason`, `indoorSwap`, `chooseMeetingArea`, `crowdScore`, `crowdLevel`. **Keep** slots, voting (`reconcileOptions`, `moreOptions`), `travel.js` (the itinerary uses it) and the display helpers (`crowdText`, `meetingResultLine`).

**Backend, later:**

- Real travel times from OneMap (`services/onemap.js`).
- Live weather from NEA.
- The database instead of JSON files (`loadPlanData` is the one place to change).
- The mock `today` date (`2026-10-04`) is used for anti-repeat until real visit history exists.

## Files

Across all six commits on this branch.

**New:**
- `backend/tests/stress.test.js`
- `backend/tests/edge-cases.test.js`
- `backend/scripts/build-cdc.js` (moved from `tests/`)
- `backend/src/planner/venue-adapter.js`
- `backend/src/db/venues.js`
- `backend/src/routes/plan-schemas.js`
- `backend/scripts/build-venues.js`
- `backend/src/db/mock/curated-venues.json` (generated)
- `backend/src/db/mock/areas.json` (generated)
- `backend/docs/planner-api.md`
- `backend/docs/engine-integration.md`
- `backend/docs/changes-and-frontend-guide.md`
- `backend/tests/venues.test.js`
- `backend/tests/slots.test.js`
- `backend/tests/plan-routes.test.js`
- `backend/tests/options.test.js`

**Changed:**
- every file in `backend/src/planner/` (`import`/`export`)
- the engine tests (`cdc`, `geo-filters`, `graph`, `pipeline`, `postranking`), now in Vitest
- `.gitignore` (`backend/data/CDC.json`)
- `backend/src/planner/engine.js`
- `backend/src/planner/filters.js`
- `backend/src/planner/scoring.js`
- `backend/src/planner/geo.js` (`walkMinutes`)
- `backend/src/routes/plan.js` (was empty)
- `backend/src/app.js`
- `backend/package.json` (`build:cdc` and `build:venues` scripts)
- `backend/tests/stress.test.js`
- `backend/tests/edge-cases.test.js`
- `README.md` (API and docs links)
