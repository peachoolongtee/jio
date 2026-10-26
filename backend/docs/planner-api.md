# Planner API

How the frontend asks the backend where to meet and which venues to suggest. The routes live in `backend/src/routes/plan.js`, the input checks in `backend/src/routes/plan-schemas.js`.

Base URL: `VITE_API_BASE_URL` (locally `http://localhost:3000`). Planner requests and responses are JSON. Ranking and slot search use `POST`; address search and the build-spec venue-search alias use `GET`.

Coordinates are checked against the URA Master Plan planning-area land polygons plus a bounded central planning envelope, so outlying Johor and Batam points are rejected while central coastal points remain usable. `dateTime` must be a real `YYYY-MM-DDTHH:MM` calendar date in Singapore local time; weekday-specific Google opening hours and explicit closed-weekday data use its date.

## What the public answer leaves out

Two things are separate:

- **Minutes are rounded to one decimal place, always.** Every `...Minutes` field (`worstMinutes`, `meanMinutes`, `travelMinutes`, `walkMinutes`) and every value in `travelByMember`, `returnByMember` and `times` is rounded: `45.468` is sent as `45.5`. Rounding does not depend on any setting.
- **`diagnostics` is shown only with `PLANNER_DIAGNOSTICS=1`** in the server's environment (blank by default, see `backend/.env.example`). It holds the engine's own counters (`routingCalls`, `passedFilters`, `radiusUsed`, `rejectedCounts`, `extraRoutingCalls`) and is for debugging; a client must not read it. The backend's tests turn it on in `vitest.config.js`. `NODE_ENV` changes neither.

In code, `createApp({ includePlannerDiagnostics, roundPlannerMinutes })` sets the two; a test that needs the engine's raw minutes passes `roundPlannerMinutes: false`. The sample answers below show the public shape, so they have no `diagnostics`.

| Endpoint | Use it for |
|---|---|
| `POST /api/meeting-area` | Once per session, after everyone has set a start point: where the group meets. |
| `POST /api/converge` | Once per itinerary slot: rank venues for the group around the meeting point. |
| `POST /api/roam` | "What next?": rank venues near one person's current point. |
| `POST /api/search` | Find a place by name to add as an option, and say whether it fits the slot. |
| `POST /api/plan/converge`, `POST /api/plan/roam` | Build-spec aliases for the two ranking endpoints above. |
| `GET /api/venues/search?q=...` | Build-spec search alias. Optional `lat`, `lng`, `dateTime`, `category`, `durationMinutes` and `limit`; defaults to central Singapore and the current Singapore date/time. |
| `GET /api/places/search?q=` | Find an address, postal code or building with OneMap, for start and end points. |

Travel times are real OneMap public transport times once the server has a OneMap account (`ONEMAP_EMAIL`, `ONEMAP_PASSWORD`), and the engine's estimate until then. Every answer says which it used: see [Travel times](#travel-times). Weather: see [Weather](#weather).

## How it fits the frontend's slot flow

1. Everyone sets a start point. Call `/api/meeting-area` with the members. Show `area.name` on the map and `worstMinutes` in the result line.
2. The frontend still builds the slots (`buildSlots` in `frontend/src/lib/planner/slots.js`).
3. For each slot, call `/api/converge` with:
   - `centre`: the meeting area's `centre`
   - `dateTime`: the slot's date and start, as `"YYYY-MM-DDTHH:MM"`
   - `durationMinutes`: the slot's duration
   - `categories`: `[slot.category]`
   - `lastStop: true` for the last slot
4. Show `results` as the options to vote on. The frontend keeps the votes; the backend only ranks. Send the ids already being voted on as `currentOptionIds`: they are always scored and come back in `current` while they still fit, and a rain swap never suggests one of them.
5. "Add a place": call `/api/search` with the same slot fields plus `query`.

Each result already carries what the option cards show: `walkMinutes`, `reasons`, `crowd`, `warnings` and `swap`. The frontend no longer needs its own `scoreVenue`, `rankForSlot`, `indoorSwap` or `chooseMeetingArea`, and should delete them once it calls the API, so there is only one ranking.

## Switching the frontend over

Step-by-step guide with code for `frontend/src/lib/api.js`: [changes-and-frontend-guide.md, part B](changes-and-frontend-guide.md#part-b-what-the-frontend-needs-to-change). The things that would break if missed:

| Watch out for | Why | Do this |
|---|---|---|
| **Score direction** | `score` is a penalty: **lower is better**. `getPlan` sorts `b.score - a.score`. | Sort by `rank` (1 is best). |
| **Venues outside the frontend's list** | Results include mock (`v25`) and CDC (`cdc_570511`) venues, which `venueById` can't find in `VENUES`. | Keep every `result.venue` the API sends (a cache by id) and look there first. |
| **Async** | `rankSlot` and `computeMeeting` become network calls. | `await` them, and make `syncOptions` and its callers async. |
| **`crowd: 'unknown'`** | Mock and CDC venues have no crowd profile. `SuggestionCard`'s `CROWD_TONE` and `crowdText` only know `quiet`, `moderate` and `busy`. | Add `unknown`, or hide the tag. |
| **No occasion** | Sessions don't have one; the backend requires it. | Send `'catch_up'` until session creation asks. |
| **Coordinates, not area ids** | Members are sent with `start` and `end` as `{ lat, lng }`. | Look up `areaById(session.locations[id].start.areaId)`. The meeting area's `area.id` matches the frontend's `AREAS` ids. |
| **Date-time** | One string per slot. | `` `${session.date}T${P.fromMinutes(slot.start)}` `` plus `durationMinutes: slot.duration`. |

Venue and option fields have different names from the frontend's:

| Card reads | Backend sends |
|---|---|
| `option.walk` | `result.walkMinutes` |
| `option.swap.id` | `result.swap.venueId` |
| `venue.price` | `venue.avgPricePerPerson` |
| `venue.indoor` | `venue.setting === 'indoor'` |
| `venue.mrt`, `venue.mrtWalk` | `venue.nearestMrt`, `venue.mrtWalkMinutes` |
| `venue.rating` (0–10) | `venue.rating` (0–5, `null` for CDC sites): double it |
| `venue.hours` (`"07:30-20:00"`) | `venue.openingHours` (`["07:30", "20:00"]`) |
| `venue.serves` | `venue.mealPeriods` |
| `venue.tags` includes `cdc` | `venue.cdcAccepted` |
| `venue.kind`, `venue.popularity` | the same, but only on the frontend's 63 places |

The demo switches map to request fields:
- rain → `weatherCase: 'rain'`. This only works when the server allows the simulated forecast; see [Weather](#weather).
- routing off → `method: 'centroid'` on `/api/meeting-area`
- simulate crowd → a `crowd` weight

**After switching, delete the frontend's ranking** so there is only one: `scoreVenue`, `rankForSlot`, `unfitReason`, `indoorSwap`, `chooseMeetingArea`, `crowdScore`, `crowdLevel`. **Keep** slots, voting (`reconcileOptions`, `moreOptions`), `travel.js` (used by the itinerary) and the display helpers (`crowdText`, `meetingResultLine`).

## Members

Each member is an object. Only `id` is required, plus a location (`home` or `start`) for `/meeting-area` and `/converge`.

```json
{
  "id": "faith",
  "name": "Faith",
  "home": { "lat": 1.315, "lng": 103.765 },
  "start": { "lat": 1.3, "lng": 103.85 },
  "end": { "lat": 1.315, "lng": 103.765 },
  "dietary": ["halal"],
  "prefersHealthy": false,
  "cuisineLikes": ["japanese"],
  "cuisineDislikes": [],
  "budgetMaxPerPerson": 20,
  "maxReturnMinutes": 60,
  "travelDebtMinutes": 0
}
```

- `start` and `end` default to `home`.
- `dietary` accepts `halal`, `vegetarian` and `vegan`, in any letter case. It filters food places only. A drink stop is not a meal: a halal need keeps bars out of it (kind `bar`, or a halal level of `none`), cafés stay, and no other need changes it. Drink places carry no `verify` or `dietUnknown`.
- `travelDebtMinutes` comes from the fairness ledger. Positive means the person travelled more than their share last time.
- Points must be inside Singapore (lat 1.1 to 1.5, lng 103.5 to 104.1). This catches swapped lat and lng.

## POST /api/meeting-area

Request:

```json
{
  "members": [ { "id": "ian", "home": { "lat": 1.3541, "lng": 103.9446 } },
               { "id": "faith", "home": { "lat": 1.315, "lng": 103.765 }, "dietary": ["halal"] } ],
  "optedOut": [],
  "overrides": { "faith": { "start": { "lat": 1.3, "lng": 103.85 } } },
  "method": "station"
}
```

`method`:

| Value | What it does |
|---|---|
| `station` (default) | The frontend team's rule. Tries every named area in `areas.json` and picks the one where the longest journey is shortest. A tie goes to the lower fairness-weighted average. |
| `weighted_centroid` | The engine's fairness rule: travel debt pulls the point toward whoever travelled more. The point is exact; `area` is the nearest named place. |
| `centroid`, `minimax` | The plain middle, or the centre of the smallest circle around everyone (up to 12 people). |

`maxCandidates` (optional) tries only the N areas nearest the fairest point, to save routing calls. Don't go below 16: 8 missed the best area for 3.4% of random groups.

`alternatives` and `include` (both optional) ask for runners-up and for named areas. See [Runners-up and named areas](#runners-up-and-named-areas) below. A request that sends neither gets exactly the answer described here, and no `candidates`.

Response (real output for the request above):

```json
{
  "method": "station",
  "area": { "id": "bishan", "name": "Bishan", "lat": 1.35092, "lng": 103.84822 },
  "centre": { "lat": 1.35092, "lng": 103.84822 },
  "distanceFromAreaKm": 0,
  "worstMinutes": 45.5,
  "worstMember": "Ian",
  "meanMinutes": 44.3,
  "travelByMember": { "ian": 45.5, "faith": 43.1 },
  "approximate": false
}
```

With `PLANNER_DIAGNOSTICS=1` the answer also carries `"diagnostics": { "routingCalls": 74, "activeMembers": ["ian", "faith"] }` (see [What the public answer leaves out](#what-the-public-answer-leaves-out)).

Pass `centre` to `/api/converge`. `approximate: true` means some trips used the estimate, because OneMap could not answer them or because they were left out of the per-request cap or the shortlist. Say "about" in the UI. The answer also carries `travel` (see [Travel times](#travel-times)).

### Runners-up and named areas

Two optional request fields add a `candidates` list to the answer: the chosen area, some runners-up, and any areas you name.

| Field | Meaning |
|---|---|
| `alternatives` | A whole number from 0 to 3 (default 0): how many runners-up to return after the chosen area. `alternatives: 2` gives the chosen area and up to two more, three areas in all. |
| `include` | Up to 8 area ids (the `id` of an area, such as `"bishan"`) to evaluate whatever their rank. Each must be an area the planner knows, and each can be listed once. |

`candidates` is in the answer when either field is sent, and only then. `alternatives: 0` or `include: []` on their own give a list of just the chosen area. Example (`"alternatives": 1, "include": ["tampines"]`, routing off, shortened):

```json
"candidates": [
  { "area": { "id": "ang-mo-kio", "name": "Ang Mo Kio", "lat": 1.36993, "lng": 103.84958 },
    "worstMinutes": 47.3, "meanMinutes": 45.5,
    "travelByMember": { "ian": 45.4, "faith": 47.3, "jonathan": 43.7 }, "approximate": false, "source": "ranked" },
  { "area": { "id": "bishan", "name": "Bishan", "lat": 1.35092, "lng": 103.84822 }, "worstMinutes": 49.4, "…": "…", "source": "ranked" },
  { "area": { "id": "tampines", "name": "Tampines", "lat": 1.35408, "lng": 103.94535 }, "worstMinutes": 81.5, "…": "…", "source": "included" }
]
```

- **Order.** The chosen area first, then the runners-up best first, then the included areas in the order you sent them.
- **`source`.** `ranked` for the chosen area and the runners-up, `included` for an area you named that is neither. An included area that is also the chosen area or a returned runner-up appears once, with `ranked`, in its ranked place. So work out which spots a member suggested from your own data, not from `source`.
- **Runners-up** are ranked by the station rule: the shortest longest trip first, then the lower fairness-weighted mean, from the areas the station rule tries (every area, or the 16 nearest the fairest point when routing is on or `maxCandidates` is sent). There can be fewer than you asked for, when fewer areas are tried.
- **Other methods.** With `centroid`, `weighted_centroid` or `minimax`, `candidates[0]` is the area named after the centre, with the travel times measured to the centre, exactly as the top level is. The runners-up are the station rule's best areas after leaving out that area. They can be better than `candidates[0]`: the centre is not chosen by the station rule. Asking for `alternatives` with one of these methods makes the planner also try the areas for the ranking (16 with routing on). `include` alone does not.
- **`candidates[0]` is the top-level answer.** Its `area`, `worstMinutes`, `meanMinutes` and `travelByMember` equal the top-level fields, from the same run. Its `approximate` does not have to equal the top-level one (see below).
- **`include` never changes the planner's own answer.** With or without `include`, the top-level answer (`area`, `centre`, `worstMinutes`, `worstMember`, `meanMinutes`, `travelByMember`, `approximate`, `distanceFromAreaKm`) and the ranked candidates (which areas, their order and every figure) are identical; `include` only adds entries with `source: 'included'`. This holds with routing on too: an included area's real OneMap times are used for its own entry and never when choosing the area or ordering the runners-up, so a member's suggestion cannot flip the planner's pick. (`alternatives` does not change the top-level answer either.)
- **An included area's times are real when the cap has room and estimated otherwise.** With routing on, an included area is routed for every member when the 60-trip cap has room for it whole, after the chosen area and the runners-up; otherwise every member's time is the estimate. Its `approximate` says which: `false` for real times, `true` for estimates. With routing off, its times are estimates and its `approximate` is `false` (see the next point).
- **`approximate` on a candidate is about that area alone**: true when at least one of its own trips used the estimate, because OneMap could not answer, or because the area did not fit the per-request cap. This is narrower than the top-level `approximate`, which is true when any area the ranking compared used an estimate. So `candidates[0].approximate` can be `false` while the top-level `approximate` is `true`, when the chosen area was routed for every member and a lower-ranked area was not. Say "about" for a candidate only when its own flag is true.
- **`approximate` is false when routing is off, although every time is then an estimate.** The flag means "a trip fell back to the estimate", and with no OneMap service nothing falls back: the estimate is all there is. So do not read `approximate: false` as "real times". Read `travel.source`: `'estimate'` means every time in the answer, candidates included, is the engine's estimate, and `'onemap'` means at least one trip got a real time, with `approximate` then telling which areas fell back.
- **`diagnostics`** (shown only with `PLANNER_DIAGNOSTICS=1`) gains `extraRoutingCalls` (only when candidates are asked for): the trips the engine asked about for areas outside the chosen area's ranking, that is included areas the station rule did not try, or, for another method, the areas tried for runners-up. `routingCalls` is unchanged.
- **`travel`** counts the extra areas' trips as well (`asked`, `routed`, `estimated`), so it can differ from the same request without the new fields.

Errors are the route's usual `400 invalid_input`. An unknown or repeated area id names the entry in `issues`:

```json
{
  "error": "invalid_input",
  "message": "Some fields in the request are missing or not valid. See issues.",
  "issues": [ { "path": "include.1", "message": "not an area id the planner knows" } ]
}
```

A repeat says `each area can be included once` at the path of the later entry. `alternatives` that is negative, above 3 or not a whole number is an issue on `alternatives`; more than 8 ids is an issue on `include`. An id must match exactly, in lower case, as in `areas.json`.

### A fairer choice: `rule: "balanced"` and `choices`

Added 19 October 2026. Both are optional. A request without them is answered exactly as before: the default rule is unchanged, and no `rule` or `choices` appears in the answer.

**Why.** The default rule picks the area where the *longest* trip is shortest. It looks at the gap between people, or at anyone's past travel, only when two areas have exactly the same longest trip, which with real minutes almost never happens. So a group where one person travels 41 minutes and another 18 gets no help from the gap, and a person's past travel changes nothing. `pnpm measure:balanced-rule` measures it: with one person of each group owed 240 minutes, the default rule's area changed in 0 of 100 random groups (see "What it changes, measured", below).

| Field | Meaning |
|---|---|
| `rule` | `longest` (default, today's rule) or `balanced`. Only with `method: "station"` (the default method): any other method with `balanced` answers 400 at `rule`. |
| `choices` | `true` adds `choices`: the places a group can pick between, each labelled (below). Works with either rule, but only with `method: "station"`: with any other method `choices: true` answers 400 at `choices` (`choices: false` is always accepted). |

**The balanced rule** starts from today's pick and moves away from it only when that costs the group nothing. Over the same areas the station rule compares (the same real routes, and no more calls):

1. **Past travel counts.** Each member's trip is multiplied by `1 + travelDebtMinutes / 60`, at most 3. Someone who travelled more than their share last time counts more, so the point moves toward them. With no balance every weight is 1. (The 60 is fixed for the API: the engine's `fairnessScaleMinutes` is not a request field.)
2. **A hard cap.** Only areas whose longest real trip is within 35% (or 10 minutes) of the best longest trip anywhere are considered. Past travel and the gap can never make someone travel far just to even things out.
3. **Only a swap that costs nothing.** Today's pick (the shortest longest weighted trip) is the baseline. Another area is considered only if its longest weighted trip is within 5% (at least 2 minutes) of the baseline's **and** its weighted average trip is within 10% (at least 3 minutes) of the baseline's.
4. **Smallest gap.** Of those, take the one with the smallest gap between the longest and shortest weighted trip; then the lower weighted average; then the lower longest trip. The baseline is always among them, so the rule never picks an area whose longest weighted trip is more than 5% (at least 2 minutes) over the baseline's, nor whose weighted average is more than 10% (at least 3 minutes) over it. Two numbers closer than a billionth of a minute count as equal, and the tie goes to the next key.

The answer has `rule: "balanced"`, and `candidates` (when asked for) list the chosen area first, then the other allowed areas, then the rest. Each trip is still in real minutes.

**`choices`.** Each choice has `labels`, the `area`, `worstMinutes`, `meanMinutes`, `gapMinutes` and `travelByMember`, all in real minutes (past travel does not enter any figure shown). A place that wins several labels comes once.

| Label | The place |
|---|---|
| `shortest_longest_trip` | where the longest trip is shortest (then the lower fairness-weighted average): today's rule |
| `most_balanced` | the balanced rule's pick |
| `lowest_average` | with the lowest average of everyone's real trips (`meanMinutes`), among the places inside the same cap as the balanced rule (longest real trip within 35% or 10 minutes of the best). A place that is cheap on average only because one person travels far is not offered |

**On `/api/converge`.** `rule: "balanced"` is accepted there too, and the answer says `rule: "balanced"`. It changes how venues are scored, not which venues are asked about. `worst` and `gap` are scored on real minutes, as in the default rule, and each result has `gapMinutes` (the longest real trip less the shortest). The weights from past travel are a term of their own, `debt`, in the `breakdown`: the longest weighted trip less the longest real trip, against a ceiling of 60 x 2 minutes, so a heavy weight cannot push every venue to the same penalty. `debt` weighs twice what `worst` does, and is left out when nobody is owed anything. `gap` weighs 8 beside `worst` at 25. `mean` is the weighted average trip, with the same capped weights as the meeting area (at most 3). Unlike the meeting area there is no hard cap on the longest trip: venues are ranked by their score, and the travel ceiling (`travelCeilingMinutes`, 60) and the other factors decide.

**A worked example, with OneMap times** (Aiyu and Ben in Tanah Merah, Chen in Lakeside, Dina in Simei; Saturday 24 October 2026, 12:30; minutes for each person in that order). The figures were copied by hand from the author's runs against OneMap, which cannot be repeated offline and are not recorded anywhere else in the repository; the tests use them as fixed numbers.

| Area | Trips | Longest | Gap | Average |
|---|---|---|---|---|
| Paya Lebar (the map's midpoint) | 11 / 18 / 42 / 16 | 42 | 31 | 22 |
| Bugis | 22 / 28 / 36 / 27 | **36** | 14 | 28 |
| Dhoby Ghaut | 28 / 34 / 38 / 32 | 38 | 10 | 33 |
| Somerset (the station rule's pick) | 29 / 35 / 39 / 34 | 39 | 10 | 34 |
| Caldecott | 36 / 42 / 35 / 40 | 42 | 7 | 38 |

A first version of this rule picked Caldecott: its gap is smaller (7 against 10) but three people lose about 7 minutes each to save one person 4, and the average rises by 4. The rule above refuses that swap (the longest trip is over 39 + 2, and the average is over 34 + 3.4), keeps Somerset among these, picks Dhoby Ghaut when it is on the list, and Bugis when that is. `tests/balanced-meeting-area.test.js` has these numbers.

**What it changes, measured.** `pnpm measure:balanced-rule` (`scripts/measure-balanced-rule.js`) makes no network call. It runs 400 random groups of 2 to 5 people (seed 7, homes anywhere on the island, no past travel) through the meeting area with the engine's own straight-line estimate. Real OneMap times differ. Its output, 21 October 2026:

| Rule | Longest trip | Average gap between people | Average trip |
|---|---|---|---|
| default (`longest`) | 43.0 min | 17.0 min | 35.4 min |
| `balanced` (the setting: longest within 5%, average within 10%) | 43.2 | 15.9 | 35.9 |
| `balanced`, longest within 10%, average within 10% | 43.6 | 15.5 | 36.1 |
| `balanced`, longest within 10%/4 min, average within 20%/5 min | 44.0 | 14.8 | 36.8 |

With `--table` the same groups use the area table's guess (34.5 / 15.4 / 27.9 for the default, 34.8 / 14.7 / 28.2 for the setting). The figures this document gave before (35.3 to 35.5 minutes, gap 14.5 to 13.7) came from a one-off measurement whose generator was not kept; they were replaced with these, which anyone can reproduce. The setting shrinks the gap by about 1.1 minutes on average (0.7 with the table) and adds 0.2 to 0.3 minutes to the longest trip. It matters most when several areas are close on the longest trip and the average, and when someone is owed travel: with one person in each of 100 groups owed 240 minutes, the default rule changed its area in 0 groups and the balanced rule in 87 (86 with the table). A loose version shrinks the gap more but starts trading the group's time for evenness, which is the Caldecott problem above. **The larger limit is the list of areas that get real routes, not this rule:** in the example Bugis (longest 36) was never routed, because the straight-line estimate that shortlists areas ranked it 18th of 37. See the shortlist, below.

**The shortlist.** With OneMap routing on and no area table, a request narrows to the 16 areas nearest the fairest point and gives real routes to the 5 whose straight-line estimate is best. With the table, the 16 are the ones with the shortest guessed longest trip. In the example, that shortlist never reached Bugis (longest 36). A better first estimate is what would reach it: see [The table of real times between areas](#the-table-of-real-times-between-areas).

## POST /api/converge

Request (one slot; the response below is real output for these two members with `"unknownPolicy": "lenient"` and `"topN": 2`):

```json
{
  "members": [ "…as above…" ],
  "occasion": "casual_meal",
  "dateTime": "2026-10-10T12:30",
  "durationMinutes": 90,
  "categories": ["eat"],
  "centre": { "lat": 1.35092, "lng": 103.84822 },
  "lastStop": false,
  "unknownPolicy": "strict",
  "groupConstraints": [],
  "excludeVenueIds": [],
  "topN": 5
}
```

| Field | Required | Notes |
|---|---|---|
| `members` | yes | At least one who has not opted out. |
| `occasion` | yes | `date`, `birthday`, `coffee_chat`, `study`, `catch_up`, `casual_meal`. |
| `dateTime` | yes | Local time `YYYY-MM-DDTHH:MM`, no time zone. |
| `durationMinutes` | no | The venue must stay open for the whole slot. Without it, only the start time is checked. |
| `categories` | no | Any of `eat`, `drink`, `shop`, `activity`. Default `["eat", "drink"]`. |
| `centre` | no | Rank around this point. Without it, the engine uses the fairness-weighted centre of everyone's start (`seed` picks another method). |
| `lastStop` | no | The frontend's last-stop rule: only venues within `lastStopMrtWalkMinutes` (default 10) of an MRT, and the longest trip home counts toward the score. |
| `unknownPolicy` | no | `strict` (default): a venue with no data on a diet need, step-free access or sockets is left out. `lenient`: it is kept, and `dietUnknown` says what we don't know. In lenient mode the results are tiered by how many of the group's diet needs a place is not known to meet: places that meet every need (for sure or likely) first, then those missing one, and so on, each tier in score order. The shortlist that is routed is cut the same way, so a place that likely meets more needs is never dropped for one that meets fewer. `/api/roam` does the same. |
| `dietPolicy` | no | `strict` or `lenient`, for dietary needs alone. Left out, dietary needs follow `unknownPolicy`. The frontend sends `strict` for the food slots of a group with needs and leaves `unknownPolicy` as it was, so a dietary need does not make `near_mrt`, `step_free` and `sockets` strict as well. Accepted by `/api/converge`, `/api/roam` and `/api/search`. |
| `groupConstraints` | no | `step_free`, `sockets`, `quiet`, `indoor_only`, `max_price_pp:N`, `near_mrt:N`. |
| `weights` | no | Override scoring weights, all 0 or more. Keys: `worst`, `mean`, `returnWorst`, `occasion`, `preference`, `weather`, `price`, `cdc`, `antiRepeat`, `crowd`. `crowd` has no weight by default, so it doesn't change the ranking unless you send one. **There is no `rating` weight a caller can send**: the rating always counts (as far as its reviews, see "Things to know" below) with a weight the server sets and scales to the weights in use, so a request that sends `weights.rating` is refused with the usual 400 (`invalid_input`, path `weights.rating`). Venues carry `rating` and `ratingCount` for display. (Roam takes the same keys except `worst`, `mean` and `returnWorst`, plus `distance`.) |
| `weatherCase` | no | `clear`, `rain`, `rain_east`: a simulated forecast. Used only when the server allows it; otherwise ignored. See [Weather](#weather). |
| `currentOptionIds` | no | The options the group is already voting on. Each one that passes the hard filters and is within 3 km is always scored, even past the shortlist (a place added by search, or swapped in for rain), and comes back in `current`. A rain swap never suggests one of these. |
| `radiusMeters` | no | The search radius the group chose, 100 to 3000. Only places inside it are suggested or kept in `current`. Without it, the search widens on its own (500 m, 1, 2, then 3 km). Search takes the same limit as `maxKm`. |
| `groupId` | no | Names the group whose visit history anti-repeat looks at. Without it anti-repeat is 0 for every venue. See [Known limits](#known-limits). |
| `optedOut`, `overrides`, `excludeVenueIds`, `topN`, `seed`, `travelCeilingMinutes` | no | As in the engine (`backend/src/planner/engine.js`). |
| `minOptions` | no | Keep widening the search (500 m, 1 km, 2 km, 3 km) until at least this many places fit. Default **3**, max 30. Ignored when `radiusMeters` is sent. |
| `shortlistSize` | no | How many places are fully scored, with travel times. Default **10**, max 30. The answer has at most this many `results` (and at most `topN`). Each one costs a OneMap route per member and trip. |

Response:

```json
{
  "status": "ok",
  "centre": { "lat": 1.35092, "lng": 103.84822 },
  "notice": null,
  "regret": null,
  "current": [],
  "results": [
    {
      "rank": 1,
      "venueId": "v25",
      "name": "Bishan Green Halal Kitchen",
      "score": 42.7,
      "worstMinutes": 45.1,
      "worstMember": "Ian",
      "meanMinutes": 44.3,
      "travelByMember": { "ian": 45.1, "faith": 43.4 },
      "returnByMember": { "ian": 45.1, "faith": 43.4 },
      "distanceFromCentreKm": 0.1,
      "explanation": "A good fit for a casual meal and 45 min for whoever travels furthest.",
      "verify": [],
      "dietUnknown": [],
      "crowd": "unknown",
      "walkMinutes": 1,
      "reasons": ["Near MRT", "Short walk"],
      "warnings": [],
      "swap": null,
      "approximate": false,
      "breakdown": { "worst": { "value": 75.2, "weight": 25, "contribution": 18.5 } },
      "venue": { "id": "v25", "name": "…", "category": "eat", "source": "mock" }
    }
  ]
}
```

`breakdown` and `venue` are shortened here; the real response has every factor and every venue field. With `PLANNER_DIAGNOSTICS=1` the answer also has `"diagnostics": { "passedFilters": 1446, "radiusUsed": 500 }`.

What to show for each result:

| Field | UI meaning |
|---|---|
| `explanation` | One sentence on why it ranked here. It says "within budget" only for a venue whose price is known (not `dataQuality.priceAssumed`). |
| `verify` | Diet needs we only *guessed* from a stall name. Say "check the stall". |
| `dietUnknown` | Diet needs we have *no* data on (lenient mode only). Say "halal status not known". |
| `crowd` | `quiet`, `moderate`, `busy` or `unknown`. Always label it as an estimate ("Busy · est."). |
| `walkMinutes` | Walk from the meeting point (Converge) or the current point (Roam). Same formula as the frontend's `walkMinutes`. |
| `reasons` | Up to two tags, same ones and same order as the frontend: "Indoor" (when it rains), "Easy trip home" (last stop, everyone home within 35 min), "Near MRT", "Quiet at 12:30", "Rated 4.6 from 512 reviews" (only with at least 50 reviews and a weighted rating of 4.2 or more; a low rating is never a reason), "Short walk", "Hidden gem", "Budget friendly" (under $10, and only when the price is known: a venue with `dataQuality.priceAssumed` never gets it, whatever its source. That is every OneMap and CDC place, and a Google place with no price level). |
| `warnings` | `["rain"]` when rain is likely (risk 0.6 or more) at an open-air or exposed venue. |
| `swap` | With a rain warning: `{ "venueId", "name" }` of an indoor alternative that is not already shown or in `currentOptionIds`, or `null` if none is within 3 km. |
| `approximate` | At least one travel time is an estimate: routing failed for it, or its venue did not fit the per-request cap on OneMap calls. |
| `regret` (top level) | "Picking X instead would add N minutes to Y's journey". `null` when there is nothing to say. |
| `current` (top level) | The `currentOptionIds` that still fit, as results (same fields), ranked among every scored venue. An id missing here no longer fits the slot. `[]` when none were sent. |
| `notice` (top level) | `{ "type": "few_options", "found": 1, "widenToKm": 4 }` when fewer than 3 venues are within 3 km. |

When nothing fits, `status` is `"empty"` and `reason` says why:

| `reason` | Extra fields |
|---|---|
| `no_venue_passes_constraints` | `hints`: what to drop, e.g. `[{ "drop": "diet:vegan", "passes": 12 }]`. |
| `outside_max_radius` | `hints.nearestKm` and `hints.widenToKm`. |
| `return_trip_too_long` | none |

## POST /api/roam

Same as `/api/converge`, with these differences:

- `current: { lat, lng }` is required. There is no `centre` or `seed`.
- `members` only need an `id`; the engine uses them for diets, budget, tastes and group size.
- `categories` default to `["eat", "drink", "activity"]`.
- Each result has `travelMinutes` and `distanceKm` instead of the per-member fields.
- Weight keys use `distance` instead of `worst`, `mean` and `returnWorst`.

## POST /api/search

Find a place to add as an option (the frontend's `searchVenuesForSlot`), by name, address or postal code. It looks in three places:

- **Our saved places:** the venue name, its area, its address (only for words of 3 or more characters), or the name of a stall at a CDC site ("Ming Kee Chicken Rice" finds the hawker centre it is in).
- **A postal code (6 digits):** OneMap finds the building, and our saved places within 150 m of it match.
- **Google** (with `GOOGLE_MAPS_API_KEY`): a text search for the words near `centre` ("Teo Heng", "Havefun Karaoke", or "Singapore 238843" for a postal code). Places of every kind are kept (one of another kind than the slot comes back with `unfit: ["category"]`, so the screen says "Eat, not Activity"), places we already have are skipped (compared by name only: a saved place of the same kind close by does not hide it), words shorter than 3 characters are not sent to Google (`google.source` is `not_needed`), and Google's review minimum is not applied: the group asked for that place by name. These results have ids starting `google_` and `source: "google"`. The answer says where Google stood in `google: { source, added }`, as `/converge` does.

A Google place added as an option is not saved anywhere but its id. Every ranking that has it in `currentOptionIds` looks it up again by id (Place Details; see "Venues from Google" for the limits), so it is scored like any other option. OneMap or Google being down never fails the search: it answers with what it has. In the answer, matches that hold the words in their name come before those matched by area, address or Google, among places that fit equally.

**A searched Google place that is not an outing.** A place found by name that Google does not type as food, drink, a shop or an outing (a bank, a clinic, a school, an ATM, a petrol station, a temple that is not also a tourist attraction, a place with no types) comes back with `fits: false` and `unfit: ["not_an_outing", ...]`, the reason first, so the screen can say "not somewhere to go" instead of showing nothing. A tuition centre, a school or an advert for a name is marked the same way. It cannot be taken as an option: a ranking that gets its id in `currentOptionIds` leaves it out and lists it in `google.missing`. The list of types that count as outings (`OUTING_TYPES`) is in `planner/google-adapter.js`.

Request: the slot's fields, so the answer says whether the place fits.

```json
{
  "query": "chicken rice",
  "centre": { "lat": 1.35092, "lng": 103.84822 },
  "dateTime": "2026-10-10T12:30",
  "durationMinutes": 60,
  "categories": ["eat"],
  "lastStop": false,
  "members": [ { "id": "faith", "dietary": ["halal"] } ]
}
```

`query`, `centre` and `dateTime` are required. `members` is optional: send it to get diet and group-size reasons. Also accepted: `groupConstraints`, `unknownPolicy`, `maxKm` (default 3) and `limit` (default 12, max 50).

Response (real output, without `members`):

```json
{
  "results": [
    { "venueId": "cdc_570511", "name": "Food stalls at 511 Bishan Street 13", "area": "511 Bishan Street 13", "category": "eat",
      "source": "cdc", "matchedStall": "Ming Kee Chicken Rice", "walkMinutes": 4, "distanceKm": 0.26, "fits": true, "unfit": [] },
    { "venueId": "ming-kee-chicken-rice", "name": "Ming Kee Chicken Rice", "area": "Bishan", "category": "eat",
      "source": "curated", "matchedStall": null, "walkMinutes": 5, "distanceKm": 0.31, "fits": true, "unfit": [] }
  ]
}
```

Each result also carries `verify` and `dietUnknown`, as a ranked result does (both empty without `members`). Places that fit come first, then by walking time. `distanceKm` is rounded here. `unfit` says why a place can't be added. It uses the same words as `diagnostics.rejectedCounts` (a counter shown only with `PLANNER_DIAGNOSTICS=1`):

| `unfit` value | Meaning |
|---|---|
| `category` | Not the slot's category. |
| `closed` | Not open for the whole slot, or the place is shut that weekday (its hours text says "Closed on Monday"; the weekday is the calendar date of `dateTime`). |
| `meal_period` | Doesn't serve that meal. |
| `near_mrt` | Last stop, but too far from an MRT. |
| `diet:halal` etc. | Doesn't meet someone's diet (or no data, in strict mode). |
| `capacity` | Too small for the group. |
| `far` | More than `maxKm` from the meeting point. |
| `closed_for_cleaning` | A hawker centre's NEA cleaning or repair day. |
| `not_an_outing` | A Google place found by name that is not something to do (a bank, a clinic, a school). Always first in the list. |

## Errors

| Status | Body | When |
|---|---|---|
| 400 | `{ "error": "invalid_input", "message": "…", "issues": [ { "path": "occasion", "message": "…" } ] }` | A field is missing or wrong. Every bad field is listed. |
| 400 | `{ "error": "invalid_json" }` | The body is not JSON. |
| 404 | `{ "error": "not_found" }` | No route at that address, or the wrong method. |
| 413 | `{ "error": "too_large" }` | The body is over 100 kB. |
| 4xx | `{ "error": "bad_request" }` | Another mistake in how the request was sent, for example 415 for a body encoding the server cannot read. |
| 401 | `{ "error": "unauthenticated" }` | On routes that need a login: no `Authorization: Bearer <token>` header, or the token is malformed, expired, forged or not a person's. Sign in again. |
| 429 | `{ "error": "rate_limited" }` | Too many planner requests from one caller in a minute. The answer carries `Retry-After` in whole seconds; wait that long. Refused requests are not counted. |
| 503 | `{ "error": "auth_unavailable" }` | The server could not reach Supabase to check the token. The token may be fine. The answer carries `Retry-After: 5`; retry the same request and do not sign the user out. |
| 500 | `{ "error": "server_error" }` | A bug on our side. The server log has the details. |

Every error has the same flat body: `{ "error": "<code>", "message": "<text>" }`. `invalid_input` adds `issues`.

**Rate limit.** Each caller may make 300 planner requests a minute (`PLANNER_RATE_LIMIT_PER_MINUTE` changes it). A caller is an address today, and a signed-in user once the planner routes check logins. Stub mode has no limit. The limit is loose because one round of voting sends about 130 requests; it should come down once the frontend sends fewer.

## Weather

`POST /api/converge` and `POST /api/roam` score each venue against the weather. Their answers carry a top-level field:

```json
"weather": { "source": "live", "validUntil": "2026-10-09T21:30:00+08:00" }
```

| `source` | Meaning |
|---|---|
| `live` | The two-hour forecast from data.gov.sg, cached on the server for five minutes. Each venue is scored from the nearest of the 47 forecast areas, and `venue.forecastArea` holds that area's name, for example `"Bukit Merah"`. `validUntil` is when the forecast period ends. |
| `simulated` | The request sent `weatherCase` and the server allows it. No `validUntil`. `venue.forecastArea` keeps the old region label. |
| `unavailable` | data.gov.sg could not be reached or sent an unusable answer. The planner scores as if the weather were clear and still answers 200. No `validUntil`. |

**The simulated forecast is off unless the server allows it.** With `ALLOW_SIMULATED_WEATHER=1`, or in stub mode, `weatherCase` is used and `source` is `simulated`. Otherwise `weatherCase` is ignored, the live forecast is used, and the answer adds `"simulationIgnored": true` to `weather`. The request is never refused, because the frontend sends `weatherCase` on every ranking.

**On your own machine,** set `ALLOW_SIMULATED_WEATHER=1` in `backend/.env` if you use the demo panel's rain switch. Without it the switch does nothing.

**Rain risk.** Each forecast sentence maps to a risk from 0 to 1, multiplied by how exposed the venue is. At 0.6 or more the planner adds the rain warning and suggests an indoor swap. A sentence the server does not recognise scores 0.5 and is logged once.

`/api/meeting-area` and `/api/search` do not use weather and have no `weather` field.

### Which forecast, by how far away the stop is

Added 11 Oct 2026 (ticket #108). Before this, every ranking used the two-hour forecast as of now, whatever the date of the outing. Now the stop's `dateTime` (Singapore local time) decides. "Now" comes from the server clock, compared as Singapore local time; the server's own time zone plays no part.

| The stop starts | `weather.basis` | What scores the venues |
|---|---|---|
| within 2 hours of now, or already in the past, or no `dateTime` | `area` | The area forecast (two-hour), as before. Each venue takes the forecast of its nearest two-hour area. |
| later than that, when a period of the regional forecast covers the start | `regional` | The regional forecast (24-hour). Each venue takes the forecast of the region its two-hour area falls in (a fixed table in `backend/src/services/weather-regions.js`). |
| later than that, and no period covers it (or it is more than 25 hours away) | `none` | **Weather has no effect**: no weather penalty beyond the `clear` case, no rain warning, no indoor swap, no "Indoor" reason tag. |
| any date, when the request sends `weatherCase` and the server allows it | `simulated` | The simulated case, as before. The forecast window does not apply, so "Simulate rain" shows the new marks for an outing next week. |

The regional forecast reaches 18 to 24 hours (and up to 25 minutes) ahead, depending on when NEA last issued it: a stop up to 18 hours away is always covered, one 18 to 24 hours away only part of the time. The number of periods (three or four) is not assumed. The server checks that the forecast's last period has not ended; an answer that has run out of periods covers nothing and counts as unavailable.

**The `weather` block of a ranking.** Every field the answer had keeps its meaning. New fields are additive:

| Field | Meaning |
|---|---|
| `source` | `live` (area or regional forecast used), `simulated`, `unavailable` (the forecast could not be fetched or used), or **`none`** (new: the stop is outside the forecast window, so no weather applies; nothing is wrong). A client that only knows `live`, `simulated` and `unavailable` treats `none` as "no weather information". |
| `basis` | `area`, `regional`, `simulated` or `none`. |
| `issuedAt` | When NEA issued the forecast used. Not for `simulated` or `none`. |
| `validUntil` | When the forecast used ends: the area forecast's end, or the end of the regional period that covers the stop. |
| `phrase` | NEA's own phrase, only when the whole forecast used has just one (for example every area says "Fair (Day)"). Left out otherwise: each result carries its own. |
| `reason` | Only with `basis: 'none'`: `outside_window` (a screen can say "Weather is checked from the day before") or `unavailable` (the forecast failed; `source` is `unavailable` too). |
| `simulationIgnored` | As before. |

Real examples. A stop this evening, scored from the regional forecast; a stop next week; a simulated one; and one whose forecast failed:

```json
{ "source": "live", "basis": "regional", "issuedAt": "2026-10-11T14:42:00+08:00", "validUntil": "2026-10-11T18:00:00+08:00" }
{ "source": "none", "basis": "none", "reason": "outside_window" }
{ "source": "simulated", "basis": "simulated" }
{ "source": "unavailable", "basis": "none", "reason": "unavailable" }
```

**Each result carries `weather`,** and so does the `swap` venue:

```json
"weather": { "state": "thundery", "phrase": "Thundery Showers", "rainLikely": true }
```

| Field | Meaning |
|---|---|
| `state` | One of `dry`, `cloudy`, `showers`, `thundery`, and `unknown` ("Not known"). Every sentence in `RAIN_RISK` has a state in the table beside it (`FORECAST_STATE` in `services/weather.js`); a sentence not in the table is `unknown` and logged once. A simulated case has no sentence: `showers` when rain is likely, `dry` otherwise. With `basis: 'none'` it is `unknown`. |
| `phrase` | NEA's own phrase for the venue's area or region, or `null` (simulated, or none). |
| `rainLikely` | The planner's threshold (risk 0.6 or more). It is true over an indoor venue too: only an exposed one earns the rain warning (`warnings: ["rain"]`, with a `swap`). |

A real exposed result and its swap, from a simulated rain for a stop next week:

```json
{
  "name": "Food stalls at 40 Beo Crescent Dbs Havelock Road",
  "warnings": ["rain"],
  "weather": { "state": "showers", "phrase": null, "rainLikely": true },
  "swap": {
    "venueId": "loos-curry-rice",
    "name": "Loo's Hainanese Curry Rice",
    "weather": { "state": "showers", "phrase": null, "rainLikely": true }
  }
}
```

Weather does not change which meeting spots `/api/meeting-area` suggests. Roam's list does use it.

**A forecast that cannot be used never fails a request.** If the regional forecast fails, times out, is malformed, has no period, or has only periods that have ended, the answer is 200 with `basis: 'none'` and `reason: 'unavailable'`. It never falls back to the area forecast for a stop the regional one should cover. The failure is logged once a minute at most, for each forecast.

**Bounds on the weather service.** data.gov.sg allows 6 calls per 10 seconds without a key, possibly shared between the two forecasts.

| Forecast | Cached | Failure remembered | Timeout | Shared in-flight |
|---|---|---|---|---|
| Area (two-hour) | 5 minutes | 30 seconds | the HTTP helper's 10 seconds | yes |
| Regional (24-hour) | 10 minutes (NEA issues it four times a day) | 30 seconds | the same | yes |

A request makes at most one call per forecast kind, through the cache. A stop more than 25 hours away fetches nothing.

## POST /api/weather/stops

The weather at the stops of a plan. The itinerary asks when it opens and every 30 minutes on the day. It does not rank anything and suggests no swap. It sits under the same rate limit as the planner routes (the same counter), and `weatherCase` follows the same rule as there.

Request:

```json
{
  "stops": [
    { "id": "park", "point": { "lat": 1.3333, "lng": 103.7424 }, "start": "2026-10-11T15:30", "setting": "outdoor", "exposure": 5 },
    { "id": "cafe", "point": { "lat": 1.3333, "lng": 103.7424 }, "start": "2026-10-11T15:30", "setting": "indoor", "exposure": 0 },
    { "id": "late", "point": { "lat": 1.3333, "lng": 103.7424 }, "start": "2026-10-12T22:00" }
  ]
}
```

| Field | Rule |
|---|---|
| `stops` | 1 to 8, with different `id`s. |
| `id` | 1 to 80 characters. |
| `point` | `lat` 1.1 to 1.5 and `lng` 103.5 to 104.1 (as everywhere in the planner). |
| `start` | `"YYYY-MM-DDTHH:MM"`, Singapore local time, like `dateTime`. |
| `exposure` | Optional, 0 to 5. Missing counts as 0, so a stop that does not say how exposed it is earns no warning. |
| `setting` | Optional: `indoor`, `outdoor` or `mixed`. |
| `weatherCase` | Optional, as in `/converge`: used when the server allows it, otherwise ignored and flagged. |

Response (real output, with the clock at 12:30 on 11 Oct 2026 and the recorded regional forecast, where the west and centre were thundery in the afternoon and the east and south were not; a fourth stop in the east, which was dry, is left out here):

```json
{
  "stops": [
    { "id": "park", "basis": "regional", "issuedAt": "2026-10-11T14:42:00+08:00", "validUntil": "2026-10-11T18:00:00+08:00",
      "state": "thundery", "phrase": "Thundery Showers", "rainLikely": true, "rainWarning": true },
    { "id": "cafe", "basis": "regional", "issuedAt": "2026-10-11T14:42:00+08:00", "validUntil": "2026-10-11T18:00:00+08:00",
      "state": "thundery", "phrase": "Thundery Showers", "rainLikely": true, "rainWarning": false },
    { "id": "late", "basis": "none", "reason": "outside_window",
      "state": "unknown", "phrase": null, "rainLikely": false, "rainWarning": false }
  ],
  "weather": { "source": "live", "basis": "mixed", "issuedAt": "2026-10-11T14:42:00+08:00", "validUntil": "2026-10-11T18:00:00+08:00" }
}
```

Per stop: `basis`, `state`, `phrase`, `rainLikely`, and `rainWarning` (the planner's rule: rain likely, not `indoor`, exposure 2 or more). With a forecast it also has `issuedAt` and `validUntil`; with `basis: 'none'` it has `reason`.

The top-level `weather` block has the same fields as a ranking's, summarising the stops: `basis` is the stops' shared basis, or **`mixed`** when they differ (this route only); `issuedAt` and `validUntil` are the earliest among the forecasts used; `phrase` is there only when every stop with a forecast has the same one; `source` is `simulated`, else `live` if any stop has a forecast, else `unavailable` if any failed, else `none`; `reason` appears when no stop has a forecast.

Errors are the flat shape: 400 `invalid_input` with `issues` (for example `stops.0.point.lat`, `stops.0.start`, `stops.0.exposure`, or `stops` for 9 stops), 429 `rate_limited`.

What the screen half still needs: the on-the-day check (call this route when the itinerary opens and every 30 minutes, show a banner when `rainWarning` turns true for a stop still to come, and ask the host to accept or dismiss the swap with `POST /api/converge` or `/roam` for the indoor alternative); and the data.gov.sg attribution, see [external-apis.md](external-apis.md#nea-24-hour-regional-forecast).


## Getting more options per slot

By default a slot gets few options, because of two limits:
- The search **stops at the first circle with 3 places** (500 m, then 1 km, 2 km, 3 km).
- Only **10 places are scored**.

To get more, send `minOptions` and `shortlistSize` with `topN`. Measured live at Newton, Sat 2pm, with Google and OneMap on:

| Slot | Default | `minOptions: 10, shortlistSize: 20, topN: 20` | OneMap routes |
|---|---|---|---|
| Activity | 5 options | 20 options | 8 → 28 |
| Drink | 5 options | 12 options | 10 → 20 |

More options means more OneMap calls per slot. They're cached for 6 hours, so repeats are free.

The **screen's** limit is separate, and it's the frontend's: `OPTIONS_START` (3) and `OPTIONS_MAX` (6) in `frontend/src/lib/planner/suggestions.js`, and `RANKED_MAX` (10) in `frontend/src/lib/api.js`.

## Venues from OneMap

417 places come from OneMap's government lists (483 are saved; 30 that a group cannot go to, 16 duplicates and 20 already in a hand-made list are not offered): sport centres, tourist attractions, museums, libraries, theatres, parks and hawker centres (see [external-apis.md](external-apis.md)). They have `source: 'onemap'` and a few extra fields the cards can use:

| Field | What |
|---|---|
| `photoUrl`, `photoCredit` | A real photo (attractions, libraries, hawker centres). Show the credit under it. |
| `address`, `postalCode` | The street address. |
| `description`, `website` | Attractions' text and official links. |
| `openingHoursText` | OneMap's own hours text, e.g. "Daily from 7am – 12pm, and 6pm – 9pm". `openingHours` is the version the planner reads. |
| `kind` | `sports`, `attraction`, `museum`, `library`, `theatre`, `park` or `hawker`. `theatre` is new to the frontend's photo list. |
| `closures`, `closuresFrom` | Hawker centres: NEA cleaning and repair days, `[{ from, to, reason }]`, as `YYYY-MM-DD`, from one NEA row (`closuresFrom` is its name). The planner leaves the centre out on those days. The dates end 2026-12-30: see [external-apis.md](external-apis.md#onemap-themes-and-hawker-closures-a-snapshot-not-a-call-per-request). |
| `closedWeekdays` | Weekdays the hours text says the place is closed on (0 = Sunday ... 6 = Saturday), e.g. `[1]` for "Closed on Monday". The planner leaves the place out on those days (reason `closed`). Public holidays are not known. |
| `officialName` | Hawker centres only, when `name` is the name in the bracket: NEA's full name ("Redhill Lane Blk 79 (Redhill Market)"). |
| `stalls`, `siteKind`, `cdc` | Hawker centres: the stalls and kind of the CDC site the centre replaced, so a stall's name finds the centre. |
| `dataQuality` | Which fields are typical values (`hoursAssumed`, `priceAssumed`) rather than real ones. |

## Venues from Google

With `GOOGLE_MAPS_API_KEY` set, `/api/converge` and `/api/roam` add up to 20 of the nearest places from Google Places: restaurants, cafés, bars and dessert shops for food and drink slots, shopping malls for shop slots, and bowling, cinemas, karaoke, arcades, amusement centres, galleries, the zoo and aquarium for activity slots (OneMap already supplies parks, sport centres, museums, libraries and theatres). Only places of the slot's category are added. A mall needs at least 50 Google reviews and an activity 30; an activity whose name is an advert or a school is left out; and a place whose name says it has closed is left out. They're added for that request only, never saved, because Google's terms don't allow it. Every answer says:

```json
"google": { "source": "google", "added": 16, "missing": ["google_ChIJabc"] }
```

| `source` | Meaning |
|---|---|
| `google` | `added` places came from Google (places the venue list already had were skipped) |
| `off` | The server has no Google key |
| `not_needed` | Google was not asked. `reason: 'enough_own_places'` when we already know at least 6 open places of every category asked, near the meeting point; with no `reason`, the request asked for no category Google is used for |
| `unavailable` | Google couldn't be used: it failed or timed out, the server's Google call budget for the minute is used up, or Google is paused after repeated failures. The answer uses the other venues |

`skipped` is there when Google was asked about some categories and not others: the categories we know at least 6 open places of near the meeting point (`["eat"]`). Google tops up, it does not flood: it is asked only about the categories where we know fewer than 6, and at most 2 of the first 5 places of a category are Google's, whatever `topN` is (Google's other places come below ours until position 6; nothing is dropped). "Known" means the places the planner itself would keep for this request: our saved and curated places inside the search circle that pass the same hard filters the ranking uses (dietary needs, `groupConstraints`, a `lastStop`'s near-MRT rule, closed weekdays and cleaning closures, `durationMinutes`, group size, `excludeVenueIds`, and being open at the time asked).

`missing` is there only when the server has a Google key and it is not empty. It lists the option ids `google_...` in `currentOptionIds` that could not be looked up this time, so the screen can show those options as "can't be checked right now" instead of dropping them without a word. A place is missing when Google answered 404 for it (remembered for 5 minutes), the look-up failed, was too slow, or was over this request's limit, the id is not a Google place id, or the place is not an outing (`not_an_outing`). It is "this time" only: the same id may be found by the next request.

**How many Google calls this makes.** A ranking makes at most one nearby search, and looks up at most 3 of the Google places in `currentOptionIds` (at most 2 at a time; only the first 6 Google ids are read). A place looked up in the last 10 minutes, or answered 404 for in the last 5, costs no call. The nearby search and the look-ups run together, and everything Google adds waits at most 3.25 seconds (one call timeout of 3 s plus 250 ms); past that the ranking goes on without it. Every Google call, searches, look-ups and photos together, is counted against one budget for the whole server: `GOOGLE_CALLS_PER_MINUTE` (default 60), with at most 4 calls running at once. A call over the budget is not made, and the answer says `unavailable`. A search is cached for 10 minutes, and its radius is rounded up to 500, 1000, 2000 or 3000 m before it is asked or cached (so `radiusMeters: 1001` and `2000` share one search; the circle always covers what was asked). A Google call waits at most 3 seconds. After 3 failures in a row (a timeout, a network error, a 4xx or 5xx, or an answer that cannot be read) Google is skipped for 60 seconds, and one success closes the pause again. A failure is logged at most once a minute per reason. An answer where `places` is not a list is a failure and is never cached; a single unreadable place in a list is skipped.

A Google venue has `source: 'google'`, `googlePlaceId`, a real `rating` and `ratingCount` (a food or drink place found by the nearby search needs at least 20 reviews to be added, a shop 50, an activity 30; a place someone searched for by name is exempt), `address`, and that **day of the week's** `openingHours`. It may also have `photo: { name, credit, credits }`:

- Show the photo with `GET /api/places/photo?name=<photo.name>&maxWidth=400`. It redirects to the image, and the key never reaches the browser.
  - `maxWidth` is rounded to a whole number and up to 200, 400, 800 or 1600 (400 when left out), so there are four sizes of each photo.
  - Each id in `name` is 1 to 300 characters: a longer or malformed name is 400 `invalid_input`.
  - 302 carries `Cache-Control: public, max-age=1800`. It only redirects to an `https` address on `googleusercontent.com`, `ggpht.com` or a subdomain of either.
  - 404 `not_found`: Google has no such photo (Google answered 404 or 400). Remembered for 5 minutes, and does not count toward the pause.
  - 502 `photos_unavailable`: Google sent a link that is not one of its image addresses. Not cached.
  - 503 `photos_unavailable`: the server has no Google key, Google failed, the call budget is used up, or Google is paused.
- **Attribution.** Google requires attribution for everything it supplies, not only photos: show that places, ratings and hours come from Google wherever you show them. A photo needs **every** author named for it: `photo.credits` is the full list (`displayName`, linked to `uri`), and `photo.credit` is only the first, kept for older code.

The Demo Key returns no photos. A billed key does.

### Decisions for the lead (open, not settled)

- **Billing tier.** The nearby search's field mask asks for rating, review count, opening hours and price level. Google is likely to bill those at a dearer tier than basic fields. This has not been confirmed: check Google's pricing page for Places API (New) Nearby Search, and keep the daily quota on the key either way.
- **Terms and the map.** Google's terms restrict showing Places content alongside a non-Google map, and Jio's map is OneMap. Whether this use is allowed has not been checked against the current terms.

## Travel times

`POST /api/meeting-area`, `POST /api/converge` and `POST /api/roam` answer with a top-level field:

```json
"travel": { "source": "onemap", "asked": 20, "routed": 12, "cached": 4, "walked": 2, "failed": 0, "estimated": 2 }
```

| `source` | Meaning |
|---|---|
| `onemap` | At least one trip got a real public transport time from OneMap (`routed` or `cached`). |
| `estimate` | The engine's own estimate: the server has no OneMap account yet, or no trip got a OneMap time. Say "about" in the UI. |

The counts always add up: `asked = routed + cached + walked + failed + estimated`. A trip and its reverse count once.

| Field | Meaning |
|---|---|
| `asked` | Distinct trips the planner wanted a time for. |
| `routed` | Real OneMap answers fetched for this request. Cached and walked trips are not counted here. |
| `cached` | Answered from the server's route cache (6 hours). No call. |
| `walked` | Under 400 m, so walked. No call. |
| `failed` | OneMap was asked and gave no time (an error, or no route), or the cache remembers "no route". The engine used its estimate. |
| `estimated` | Never asked, so the engine used its estimate. Its venue or area did not fit the per-request cap (or the meeting-area shortlist), or OneMap was not available (the shared call budget was used up, routing was paused after repeated failures, the login failed), or this request waited its 8 seconds. |

`approximate: true` on a result (or on the meeting area) means at least one of its trips used the estimate, whether it `failed` or was `estimated`. A result that is not approximate has real times for every trip. `diagnostics.routingCalls` (with `PLANNER_DIAGNOSTICS=1`) is the engine's own count of the trips it asked about; `travel` is what was really fetched, and is always shown.

How the OneMap times work (`backend/src/services/onemap.js`, `travel-times.js`):
- The engine runs once to find the trips it needs. Those are fetched from OneMap, 6 at a time, and the engine runs again with the real times.
- **One request makes at most 60 OneMap route calls.** Whole venues (or whole candidate areas) are routed, in the engine's own priority order, until the next one would pass 60; the rest keep the estimate and are `approximate`. A venue is real for every member or an estimate for every member, never half and half. Cached and walked trips are free. `currentOptionIds` venues count like any other. With 30 members one venue (up to 60 trips) uses the whole cap.
- **The meeting area routes only the best 5 areas** by estimated result, within the same cap. With 30 members that is 2 areas. The answer is then `approximate: true`, and the area it names may be one that only has an estimate, so say "about". If a single area would pass the cap, nothing is routed.
- **Runners-up and named areas (`alternatives`, `include`) use the same cap**, so a request routes at most 60 trips however many areas it names. The order areas get real routes in is:
  1. For a method other than station, the meeting point itself (it is the answer).
  2. The shortlist of the 5 best areas by estimate, exactly as for a request that sends neither field. The chosen area and the runners-up come from the areas the ranking compares, and these five are the ones routed first. An included area outside the areas the station rule tries never takes a place in this shortlist.
  3. The included areas that are not already routed, in the order sent, each as long as the cap has room for it whole.

  So the chosen area and its times are the same with or without the new fields. A named area's real times belong to its own entry only: the ranking is never shown them, even for an included area the ranking also compares (one of the 16 nearest tried), because a real time can come out below the estimate and would let a named area beat the planner's own pick. A named area is routed only with room to spare: with 10 members (6 areas fit) the first included area is routed and the second is not; with 12 members or more, no included area is. An area that did not fit keeps the estimate for every member and its candidate is `approximate: true`. The room is counted after free trips: a trip already in the route cache or short enough to walk costs nothing, so a repeat request routes more of the areas the first one had to estimate. With 30 members, `alternatives: 3` and 8 included areas, the stub test makes 60 route calls (`tests/meeting-area-candidates.test.js`); `tests/meeting-area-include-isolation.test.js` checks that `include` changes nothing but its own entries.
- **The whole server shares a OneMap budget**: at most 6 calls in flight, and `ONEMAP_CALLS_PER_MINUTE` a minute (default 240) for routing, address search and login together. A routing trip that finds it used up keeps the estimate at once. See [external-apis.md](external-apis.md#keeping-the-shared-account-safe).
- **One request waits at most 8 seconds** for OneMap routes in total. Trips not answered by then keep the estimate, and the request is still answered.
- After 5 failed route calls in a row, routing is paused for 30 seconds and every trip keeps the estimate. A rejected login token is replaced once and the call retried; a failed login is not retried for 60 seconds.
- A trip under 400 m is walked; no route is asked for.
- The way back is taken to be as long as the way there, so one route serves both. Most members end where they started, so this halves the calls.
- Times are for the start of the slot's hour. Routes are cached for 6 hours, by points rounded to about 110 m.
- The OneMap login token lasts 3 days. The server gets a new one an hour before it runs out.
- With routing on, the meeting area tries 16 areas, unless `maxCandidates` is sent. Without the area table (below) they are the 16 nearest the fairest point on the map, and 16 never missed the best area in 2,000 random groups. That measurement was made without the table. With the table they are the 16 whose guessed longest trip (from the table, plus a short hop at each end) is shortest, which has not been measured the same way. `/api/meeting-area` also accepts `dateTime`, for when the group sets off; without it, the server uses the time now.

### The table of real times between areas

Added 21 October 2026. With OneMap routing on, a meeting-area request first guesses every area's trips, narrows to 16 areas and gives real routes to the 5 best guesses. The guess used to be the straight line between two points, which ignores the MRT: for a real group (two people in Tanah Merah, one in Lakeside, one in Simei) Bugis had the best real longest trip (36 minutes) and the best average (28), but the straight line ranked it 18th of 37, so it was never routed, and the answer was Somerset (39 and 34).

`src/db/mock/area-times.json` holds **real public transport minutes between every pair of the 37 areas**, taken from OneMap once with `pnpm build:area-times` (about 666 calls, paced at 50 a minute; stop the running server first: the account allows 300 a minute for everyone and the server may use 240; it saves as it goes and carries on where it stopped). With it, the guess for any two points is the shortest, over the three areas nearest each end, of the real time between those areas plus a short hop at each end (`planner/area-times.js`). A member of a session starts on an area's centre, so for a session it is exactly the table's time. A trip inside one area is the least of the straight line, the two hops and the area's shortest trip to a neighbour, so it is never longer than leaving the area. A point has no distance limit (the hop just grows), so there is no jump where "near an area" ends. And:

- the 16 candidate areas are the 16 with the shortest guessed longest trip (then the lower mean), not the 16 nearest the fairest point on the map. The "never missed the best area in 2,000 random groups" figure belongs to the old way and was measured without the table;
- the 5 that get real routes are the best by that guess;
- trips that get no real route (and every trip, when OneMap is off or over its budget) use the same guess instead of the straight line.

`MEETING_FINALISTS` (1 to 12, default 5) raises the number of areas that get real routes: more use more of the OneMap budget the whole team shares (a request still routes at most 60 trips, whole areas only). **The trade-off:** with 6 members, 12 finalists would take 72 trips, so the 60 are used up by ten finalists and the areas a request names in `include` (or that members suggest in a session) would get only estimates. So the first 5 finalists are routed first, then the named areas, then the other finalists with what is left. With the default 5 nothing changes, and naming areas never changes the chosen area. With more than 5, a request that names areas can route fewer of the extra finalists than one that does not, so when the 60 trips run out the chosen area can differ between the two; that is the price of the named areas getting real times.

Nothing changes without the file: `index.js` loads it when it exists (and not in stub mode), and says "Area travel times are ON" at start-up. A request is answered the same way, with the same fields; only which areas get real routes, and the estimate behind unrouted ones, differ. `/api/converge` and `/api/roam` keep the straight-line estimate for venues.

The table carries a credit to OneMap (`_meta.credit`): check OneMap's terms before reusing the times elsewhere. A value that cannot be a time (negative, over 6 hours, not a number) is not used and the straight line answers for that pair; at start-up the server says how many of the areas' pairs the table covers, and warns when it covers fewer (the areas changed since it was built: rebuild). `tests/area-times.test.js` fails when the saved table does not cover every pair of the current areas.

The times are for one moment (a Tuesday at 12:30, in `_meta.dateTime`): they rank areas, they do not show the evening rush, and a request's real routes still use its own time. Rebuild when the lines or the areas change (a new MRT line opens, an area is added), with `pnpm build:area-times -- --date <a date-time>`; the script starts a fresh table when the moment changes. It refuses a pace above 120 calls a minute and a date that is not `YYYY-MM-DDTHH:MM`. A trip OneMap says it cannot route (400, 404 or 422) is listed under `_meta.missing` and not asked for again; any other failure waits a minute and tries again. When the areas change, a rebuild drops the pairs of areas that are gone and keeps the rest. `--help` says all of this. Where the data came from and the conditions it is kept under are in [external-apis.md](external-apis.md#saved-onemap-data-and-its-terms).

## GET /api/places/search

`GET /api/places/search?q=520201` → `{ "results": [{ "name", "address", "postal", "lat", "lng", "source" }] }`, at most 10. `source` is `"onemap"` or `"google"`. `postal` is a string, or `null` when the place has none, whichever the source.

For start and end points, and meeting spots: an address, postal code or building name, searched with OneMap. It needs no OneMap account. Results are cached for a day. The rate limit applies, and so does the server's shared OneMap call budget (the same one routing draws from).

When OneMap finds nothing, and the words have a letter in them and are at least 4 characters, Google's text search adds places by name (a karaoke, a shop, a landmark OneMap does not list), in the same shape; `postal` is read from Google's address when it has one. A postal code, and the first letters of a word still being typed, are not sent to Google. Only a name, an address and a point are asked for, with a bias that covers the island. A Google place with no name, a name of only digits, or a point outside Singapore is left out. The answer is 503 only when neither OneMap nor Google could answer (or OneMap failed and Google had nothing to show).

| Status | When |
|---|---|
| 200 | Results, possibly empty. |
| 400 `invalid_input` | `q` is missing, blank, given more than once (an array), or over 80 characters. The issue is on `q`. |
| 503 `search_unavailable` | OneMap could not be reached, or this server has no address search. Show "search is not available, try again soon". When the server's shared OneMap call budget for the minute is used up, the answer also carries `Retry-After` in whole seconds: wait that long before searching again. |

## POST /api/itinerary/arrange

The AI order for an itinerary. The frontend asks once, when the group opens **Confirm plan**: the dialog shows the suggested order and its reason, and confirming saves it. After that the group can still move stops by hand in the itinerary's edit mode. (`shown` and `restarted` let a caller ask for a different order each time; the app does not use them today.) Food stops keep their place, so meals stay at meal times; the drink, shop and activity stops are put in a new order.

How it decides:

1. `planner/arrange.js` tries every order of the stops that can move (at most 6, so at most 720 orders). Stops are timed from `startAt`, each after the one before it plus the trip (walking when a leg is 15 minutes or less, public transport otherwise). Two things can make a stop start later, leaving free time before it:
   - a meal never starts before its time (the stop's `start`, its slot's time from voting), and at most 60 minutes after it;
   - a stop whose place is not open yet waits for it: at most 30 minutes for the first stop (the group has just met), 60 for any other.
   An order works when every place is open for the whole stop, every meal is on time, and the plan ends by `endAt`.
2. It leaves out the current order and every order in `shown` (except with `includeCurrent`, used on confirm, where the voted order may be the best). When all have been shown, it starts again and says `restarted: true`.
3. The AI (`services/itinerary-ai.js`: Gemini with `GEMINI_API_KEY`, else Claude with `ANTHROPIC_API_KEY`) is shown the best 6 of those (the lowest score: travel, plus half the waiting, plus 15 when the last stop is far from an MRT station) and picks the one that makes the nicest day, with one sentence saying why. Its answer is checked: a choice that is not a whole number on the list is never used, and the sentence is used only when it is plain text (no `<` or `>`, no control or bidirectional-control character, no link or anything shaped like a domain name; at most 200 characters). A valid choice with a sentence that fails the check keeps the AI's order and gets a fixed sentence instead; `source` stays `ai`. The AI can only choose an order the rules allow; it never invents one.
4. Without a key, in stub mode, or when the AI cannot answer (it fails, is slow, refuses, answers something unreadable, is out of free quota, is over budget or is paused), the order the rules score best is used instead, at once, and `source` is `rules`. The request never fails and never waits for the AI more than 8 seconds. The sentence then is "Every place is open and every meal is on time in this order." The best score is not always the order with the least travel: waiting and the MRT penalty count too.

**Travel and hours.** Travel between stops is the engine's own estimate (walking when a leg is 15 minutes or less, otherwise a public transport estimate from the distance). This route never calls OneMap, so the times can differ from the itinerary screen's. The route takes that day's `hours` from the caller and knows nothing of a venue's closed weekdays or closure dates: a stop that is closed on that weekday must be sent with `hours` that say so (or the caller must not offer it).

**What limits the AI.** The AI is paid for (Gemini beyond its free tier, Claude always), so its use is bounded, the way Google Places is:

- One budget for every AI call this server makes: `ITINERARY_AI_CALLS_PER_MINUTE` a minute (20 by default; an invalid value means 20) and at most 2 calls at once. A request that finds the budget used up, or both slots taken, is answered by the rules at once. It does not wait.
- Three failures in a row (an error, a timeout, or an answer that cannot be used) pause the AI for 60 seconds. After that one call is tried; a success closes the circuit.
- An answer is kept for 10 minutes, for at most 500 plans, under a key made from the provider, the model, the system prompt and the prompt. The same plan asked again within 10 minutes makes no call and gets the same answer. A failure is never kept.
- One choice takes at most 8 seconds, whichever AI is asked. Gemini's timeout is that, and Claude's call is aborted at that time and never retried (the SDK would otherwise honour a `retry-after` header of any length).
- A failure is logged at most once a minute per reason, with a fixed sentence and a status or an error name. The log never holds an error message, a response or a key.

**What is sent to the AI.** Venue names and kinds (text from the request, with line breaks and control characters removed), indoor or outdoor, the times, the minutes of travel, whether the last stop is far from an MRT station, and whether rain is expected. Nothing about the people in the group. The model names (`claude-haiku-5-5` by default for Claude, `gemini-3.8-flash` for Gemini; `ANTHROPIC_MODEL` and `GEMINI_MODEL` change them) were not checked against the live APIs: a name the service rejects means a rules answer and one log line.

Request:

```json
{
  "stops": [
    { "id": "s5-eat", "name": "WeWa", "category": "eat", "lat": 1.3204, "lng": 103.8438, "duration": 90, "hours": ["11:00-22:00"], "indoor": true },
    { "id": "s5-activity", "name": "Shaw Theatres", "category": "activity", "lat": 1.3222, "lng": 103.8445, "duration": 120, "hours": ["10:00-23:59"], "indoor": true },
    { "id": "s5-shop", "name": "Velocity", "category": "shop", "lat": 1.3201, "lng": 103.8436, "duration": 90, "hours": ["10:00-22:00"], "indoor": true, "mrtWalk": 2 },
    { "id": "s5-drink", "name": "Atlas", "category": "drink", "lat": 1.3195, "lng": 103.8441, "duration": 60, "hours": ["12:00-18:00"], "indoor": true }
  ],
  "startAt": 720,
  "endAt": 1200,
  "rain": false,
  "includeCurrent": false
}
```

`stops` are in the current order. `id` is the frontend's slot id. `start` (optional) is the stop's time; a food stop keeps it as its meal time. `hours` are that day's opening hours; a stop with none counts as open. `startAt` and `endAt` are minutes after midnight (`endAt` over 1440 for past midnight, optional). `rain` tells the AI to prefer the outdoor stop while it is dry. `includeCurrent` lets the current order be chosen.

Answer (from a run on a server with no AI key, so `source` is `rules`; with a key it is `ai` and `reason` is the AI's own sentence):

```json
{
  "status": "ok",
  "order": ["s5-eat", "s5-shop", "s5-drink", "s5-activity"],
  "stops": [
    { "id": "s5-eat", "start": 720, "end": 810 },
    { "id": "s5-shop", "start": 810, "end": 900 },
    { "id": "s5-drink", "start": 901, "end": 961 },
    { "id": "s5-activity", "start": 966, "end": 1086 }
  ],
  "reason": "Every place is open and every meal is on time in this order.",
  "source": "rules",
  "restarted": false,
  "others": 3
}
```

or `{ "status": "no_other_order", "message", "blockers" }` when no other order fits. `message` says why, for example "No other order works. Only one stop can move: food stays at meal times." (with `blockers: []`), or, for the same plan with only 3 stops and `endAt: 840`, "No other order works. The plan would end after 14:00." (with `blockers: ["the plan would end after 14:00"]`). `stops` carries each stop's time; the frontend keeps it as the stop's earliest start (`notBefore`), so the free time and the meal times stay as planned.

| Field | Limit |
|---|---|
| `stops` | 2 to 8, with at most 6 that are not food, ids all different |
| a stop's `id`, `name`, `kind` | 1 to 80 characters |
| a stop's `lat`, `lng` | 1.1 to 1.5 and 103.5 to 104.1 (Singapore, with a little margin) |
| `shown` | 50 orders, each of at most 8 ids |
| `duration` | 15 to 720 minutes |
| `hours` | 4 ranges, each `HH:MM-HH:MM` |
| `mrtWalk` | 0 to 120 minutes |
| `startAt`, `endAt`, a stop's `start` | `startAt` 0 to 1439; `endAt` and `start` 0 to 2880 (minutes after midnight, over 1440 for past midnight) |

## Session endpoints: where a group meets and what it votes on (`/api/sessions/:id/...`)

Not planner routes. They work on a shared session in Supabase, so they need a login (`Authorization: Bearer <token>`, see `GET /api/me`) and Supabase to be set up; without them none of these routes exists and each answers 404. Every one runs the login check, then a limit of `SESSION_RATE_LIMIT_PER_MINUTE` (60) a minute per signed-in person (429 `rate_limited` with `Retry-After`; the search of a slot's places and `GET /api/venues` have limits of their own, below), then checks the caller as the user: a session the caller is not in answers 404 `session_not_found`, the same as one that does not exist. `:id` is the session's id; ids are compared without regard to the case of their letters.

What the server does, and what the browser does:

- **The browser writes directly**, under the database's rules (`db/policies.sql`): a member's own start and end area, what they picked and how long they stay (`session_members.start_area_id`, `end_area_id`, `categories`, `stay_until`), their own **vote** (`votes`: insert, change or delete one's own row, for a place that is an option of a slot, while the session is `voting`, the slot is not removed and the member has joined), their exact place (`session_member_places`, which only they and the server can read), and "Works for me" (`spot_approvals`: insert or delete one's own row, for a spot that is listed, while the session is `locating` and the member has joined). The server only reads these. After a start or end changes, the browser calls `POST .../meeting-area`; after picks or the time someone can stay changes, `POST .../plan/sync`.
- **The server writes everything else**, with the service key, through one database function, `apply_session_plan` (`db/migrations/20261020000000_jio_apply_session_plan.sql`). It locks the session row and writes nothing unless the session's `plan_version` and `status` are still what the server loaded, so an answer worked out while the group was locating is never put over a session the host has since confirmed, and a confirmed meeting area is never moved by a recompute. It raises `plan_version` by one when it writes anything (so the other devices, which watch the session row, refetch), and not when the write would change nothing, so repeating a request leaves the database as it was.
  What the function enforces itself, so that no mistake in the server's code can break it (each refusal is an error `P0001` with a hint, which the server turns into a 409):
  1. **Status.** A status moves only from `inviting` or `locating` to `voting`, in the same patch that gives a meeting area (`status_transition`). Starting, cancelling and the later stages' moves are not made here.
  2. **Two people.** Leaving `inviting` needs two joined members counted *after* the patch's member operations, so a patch that opts someone out or removes them and starts the session in one call is refused when fewer than two remain (`needs_two_people`).
  3. **Changed means changed.** In the `session` section a value counts as a change only where it differs from the stored row: the status, each `meeting` column as it would be written after rounding, the area, the method and the banner. The same pinned meeting or the same banner again answers the stored `plan_version` and writes nothing, not even `meeting_computed_at`. A write of the spots, members or suggestions that changes nothing is no change either.
  4. **A pin stays.** While `meeting_method` is `voted` or `chosen`, a patch cannot change the area or the method (`area_pinned`). The one exception is the host's change of the meeting place (rule 10 below), which is the only way a pin is ever let go.
  5. **A pin only with a confirm.** A patch whose `meeting.method` is `voted` or `chosen` is accepted only when the same patch moves the status from `inviting` or `locating` to `voting`, or when that method and area are already stored (`pin_without_confirm`). The planner's own methods (`same`, `fairest`, `centre`) need no confirm.
  6. **The host stays.** `remove_member` and `opt_out` naming the session's host are refused (`host_member`).
  7. **Slots only while voting.** Slots, options and the two operations on them (`clear_votes`, `swap_option`) are written only when the session is `voting` after the patch (`slots_status`); a swap that names a slot the session does not have is `slot_missing`. They are written as a difference, so an option the patch keeps keeps its votes, and one it leaves out takes them. The votes of anyone who is not a joined member go with the next write of the slots. A change of who travels how long counts as a change even when the longest trip, the total and the count are the same. `session.radius_meters` is written here too, and a `session.banner` without `at` is stamped with the database's clock. A `swap_option` whose `from` and `to` are the same place changes nothing (it does not delete the option and its votes). A member's minutes are written only where they differ from the stored ones, so a patch that repeats them does not touch the member's row.
  7a. **Nothing is dropped without a word.** A patch part the function does not know (anything but `ops`, `spots`, `slots`, `session`, `loaded_at`, `recomputed`, `banner_text`), a `session` that is not an object, or a part of the session it does not know (anything but `status`, `meeting`, `banner`, `radius_meters`) is refused with error `22023` (a typo, or a server newer than the function, is told at once). The banner is a change only where it differs from the stored one apart from its time: the same words sent again keep their old time and are not shown again to a member who dismissed them, while a different notice, or `null`, is a change.
  8. **When a spot was worked out.** A patch may carry `loaded_at`, an ISO time: when the server read the members, taken before the planner ran. A written spot gets that as its `computed_at` (without it, the time of the write), and `"recomputed": true` brings the spots that are older to it. A member row saved while the planner ran therefore stays newer than the spots, and the repair check below still asks for a run.
  9. **The plan (stage 5, `db/migrations/20261023000000_jio_apply_session_plan_stops.sql`).** The status also moves `voting` to `confirmed` (the patch must carry stops, and at least two joined people must have voted: `stops_missing`, `not_enough_votes`; every stop must be an option of its slot: `stop_not_option`), `confirmed` to `voting` (the plan is opened again: the stops, the order note, the suggested order and the plan's start are cleared, and the pending proposals are dismissed) and `confirmed` to `completed` (the ledger is written with it; its deltas must sum to zero: `ledger_sum`). Stops, the details of a place put in a stop, the order note and the plan's start are written only while the session is `confirmed` after the patch (`stops_status`), the suggested order only while it is `voting` (`order_status`), the ledger only with the move to `completed` (`ledger_status`). Stops are written as a difference and must be numbered 0, 1, 2 ... with no gap, no repeat and no place twice (`stop_order`, `stop_duplicate`), at most 8 (`too_many_stops`), at least 1 (`last_stop`). Proposals (`propose`, `resolve_proposal`) are written only while the plan is confirmed, with their limits checked under the lock (`plan_full`, `too_many_proposals`, `already_a_stop`). A part of the plan the function does not know now also excludes `stops`, `stop_options`, `ledger`, and of the session `replan`, `plan_start_minute`, `order_note`, `order_suggestion`.
  10. **Changing the meeting place (`db/migrations/20261027000000_jio_change_meeting_place.sql`).** The op `{ "op": "release_meeting", "meet_by": "fairest" | "known" }` is the only way a `voting` or `confirmed` session goes back to `locating`, and that move is valid only with it. On any other move the op is refused (`release_status`: from `locating`, `inviting`, `completed` or `cancelled`, or in a patch that stays in `voting` or goes to `confirmed`, `voting` or `completed`); without it the move is `status_transition`. `meet_by` is anything but `fairest` or `known`: `22023`. The patch cannot bring a meeting of its own (`release_meeting`). In the one write the function deletes every vote, slot (their options go by foreign key), stop, spot, approval and suggestion, sets every `meeting_*` column to null (the members' own `travel_minutes` are left alone: nothing reads them while locating, the next confirm rewrites them, and writing them would make every page think the spots are stale), clears `order_reason`, `order_source`, `order_suggestion`, `plan_start_minute`, `replan` and `weather_kept`, dismisses the proposals still waiting, writes `sessions.meet_by`, and clears the banner unless the patch brings one (which is always written afresh). Starts, ends, exact places, picks, the radius and who is in the session stay. The patch may bring `spots` (worked out again from the kept starts) and `session.banner` in the same call. **Lock order:** a release first locks the session's votes and then its options, in a fixed order, and only then the session row, because a guest's vote locks its row and its option before its trigger waits for the session (a release that took the session first would deadlock with it, 40P01). `applyPlan` (`backend/src/db/sessions.js`) also tries any write once more after 40P01 or 40001 (nothing was written), and answers an error only if the second try fails. Rule 4 (`area_pinned`) and rule 5 (`pin_without_confirm`) are unchanged on every other path. `db/tests/apply_session_plan.sql` steps 301 to 343 test it.
- **Travel times come from the centres of areas**, never from an exact place: a member's start is the centre of their start area. A spot's minutes therefore say nothing about where in the area anyone is, and the server never reads `session_member_places`. No answer carries a label or a coordinate.
- **Only saved places and areas.** Nothing here asks Google. Every area id is checked against the planner's list before anything is planned (422 `unknown_area`).
- **OneMap is the shared budget.** The routes use the same engine runs as the planner routes (`services/planner-runs.js`): at most 60 route calls for one request, whole areas only, the rest estimated and flagged `approximate`, and the server-wide budget of `ONEMAP_CALLS_PER_MINUTE`.
- **A line per session.** A session's writes run one at a time, and at most one run waits. A request that arrives while one runs is served by the next run, which loads the session afresh; a run that only recomputed and finds another waiting does not write, and its callers are answered by the waiting run. A run that finds the session moved on loads again and does its work again, up to three times, then answers 409 `plan_busy` with `Retry-After: 1`. The session id is lower-cased once, so a session has one line however its id is written. A run that would only recompute and finds a run already waiting hands its jobs over before it asks the planner, so it spends no OneMap calls; one that finds a run waiting only after the planner has finished does not write. Every call a run makes to the database has a deadline of 8 seconds: past it the run fails with 503 `unavailable` and `Retry-After: 2`, and the next run in the line goes on. A 503 does not say whether the write happened (the call may still finish), so a caller that wants to know reads the session again.

The spots are the areas a group chooses between while `locating`: up to three from the app (`rank` 1 to 3, the fairest first) and the ones members suggest (`rank` null), in `session_spots`, each with the longest trip, the mean and every located member's minutes (unrounded; the screens round them), `approximate` when a time is an estimate. `sessions.meeting_*` stay empty while locating; the host's confirm fills them.

**The banner (`sessions.banner`).** One notice for the whole group, `null` or an object the server writes and the browser shows as it is, adding nothing to it:

```json
{ "text": "Faith's start location changed. Orchard is no longer on the list, so approvals for it were removed.", "at": 1792051200000, "approvalsRemoved": true }
```

`text` is the sentence; `at` is when it was written, in milliseconds since 1970 (the database's `now()`), so a newer banner always has a newer `at`; `approvalsRemoved` is `true`: this stage writes only this kind of banner, when a spot left the list and took approvals with it (from a start or end change, a suggestion or a withdrawal, opting out, leaving or being removed). When several requests share one run, the sentence before the lost spots names the request that took the spot away (the withdrawal, the replaced suggestion, the person who left or opted out); with none to blame it says only "The list of spots changed.", never one person's start change for something else's doing. A host's confirm or known place sets it back to `null`, and a write that removes no approval leaves the earlier banner as it was. Later stages add their own flags on the same object (the browser already reads `votesCleared` from it in voting). The host's change of the meeting place writes `{ text, at, released: true }` (and `votesCleared: true` too when it goes straight on to voting at a named area), which Locate and Vote show and which names the host and nobody else. Dismissing is each person's own and is kept in their browser, stamped with `at` (the session's `planVersion` is the stamp only for a banner without an `at`); it never changes the row. `apply_session_plan` writes the shape (`db/tests/apply_session_plan.sql` step 10 checks it), and `frontend/src/lib/__tests__/sharedSessions.backend.test.js` checks that the browser shows what the server wrote.

**The repair check.** A start can be saved in the database and the call to `POST .../meeting-area` never come (the page closed between the two). The browser sees the gap when a member row's `updated_at` is later than every spot's `computed_at`, and asks once, the first time a page reads the session. Any other change to a member row (their categories, how long they stay) looks the same, and a run for it changes no number. So a run that worked the spots out with the planner always brings every spot's `computed_at` forward, without raising `plan_version`: the server says so to `apply_session_plan` with `"recomputed": true` in the patch, and the gap is closed for every device. The time written is the one the server read the members at (`loaded_at`, before the planner ran), not the time the planner finished, so a start saved while the planner worked still looks unpriced and is priced by the next run. A run that only keeps the stored spots (a suggestion on a spot already listed) does not, because it has not priced anything.

Errors common to all of them, all `{ "error": "<code>", "message": "..." }`: 400 `invalid_input` (a path id that is not a uuid, or a body with a missing, wrong or extra field; `issues` lists the fields), 401 `unauthenticated`, 503 `auth_unavailable`, 503 `unavailable` (the database did not answer in 8 seconds; `Retry-After: 2`), 429 `rate_limited`, 404 `session_not_found`, 409 `plan_busy`, 500 `server_error` (a database that fails; the database's words are never sent). A status that does not fit is 409 `wrong_status`, or 409 `not_yet` for work the plan stage (stage 5) will do (a confirmed session).

### POST /api/sessions/:id/meeting-area

Work the spots out again: after a start, an end or a late start was written, or when someone joined. Body `{ "trigger": "start" | "end" | "added" }` (optional; it only words the notice). Joined members only; status `inviting`, `locating` or `voting`.

200 `{ "planVersion": 5, "meetingAreaId": null, "moved": false, "votesCleared": false, "skipped": ["<user id>"], "spots": 3, "approvalsRemoved": ["orchard"] }`. `meetingAreaId` is null while locating; `moved` and `votesCleared` are for voting (below). `skipped` lists the joined members with no start the planner knows. With fewer than two members that have a start there are no spots (`spots: 0`). One engine run asks for the chosen area and two runners-up and for every suggested area (`include`, oldest first). The spots are written as a difference: listed areas are inserted or updated, unlisted ones deleted, and an approval goes with its spot. When a deleted spot took approvals with it, `sessions.banner` is set to `{ text, at, approvalsRemoved: true }` ("Faith's start location changed. Orchard is no longer on the list, so approvals for it were removed."); otherwise the banner is left alone.

**While voting** the spots are left as the record and the meeting area and the slots are worked out again (one allowance of 60 OneMap trips for all of it). A chosen area (`voted` or `chosen`) stays where it is and only its travel times move (zero when nobody has shared a start). The planner's own pick (`same` or `fairest`) may move: then every vote is deleted, every slot's places are chosen again from nothing, and the answer says `moved: true` and `votesCleared: true` (when there were votes). With fewer than two starts the planner's pick is cleared (`meetingAreaId: null`, voting is paused: the options are cleared too, and places cannot be added: 409 `no_meeting_area`); it comes back with the second start. Then the slots are ranked again and the places people vote for stay while they still fit. The answer in voting is `{ planVersion, meetingAreaId, moved, votesCleared, skipped, spots: <stored spots>, approvalsRemoved: [] }`. The notice (`sessions.banner`) is written only when the area moved or its travel times changed: "Meeting area moved from Bugis to Orchard because Ian's start location changed. Votes for places were cleared." (`votesCleared: true`) or "Meeting area stays at Bugis. Ian's start location changed."; a repeat that changes nothing writes nothing.

Errors: 403 `not_joined` (the caller opted out), 409 `not_yet` (confirmed), 409 `wrong_status` (completed, cancelled). A browser that has just saved a start treats `not_yet` and `wrong_status` alike: the host has already moved on, the start stays saved (it only adds a travel time to the confirmed spot) and the person is not shown an error.

### PUT /api/sessions/:id/spots/mine

The caller suggests a spot, replacing their earlier suggestion. Body `{ "areaId": "bugis", "here": true }` (`areaId` 1 to 60 characters; `here`, optional, labels it "we are here already"). Joined members only; status `locating`.

200 `{ "planVersion": 6, "spots": 4, "approvalsRemoved": [] }`. The planner is asked only when the area is not already listed; an area the app already lists just gets the suggestion, which keeps it listed if the app's three change. The old suggestion's spot leaves the list unless it is the app's or another member's, with its approvals (and the banner above).

Errors: 403 `not_joined`, 409 `wrong_status` (not locating), 409 `no_spots` (a new area needs two starts), 409 `too_many_spots` (a ninth different area; the same area as another member's does not count), 422 `unknown_area`, 422 `area_not_priced` (the planner could not work out times to it; nothing is saved).

### DELETE /api/sessions/:id/spots/mine

The caller takes their suggestion back. No body, no planner run. 200 `{ "planVersion": 7 }`; with no suggestion to take back it does nothing and writes nothing. Errors: 403 `not_joined`, 409 `wrong_status`.

### POST /api/sessions/:id/voting

The host confirms a spot. Body `{ "areaId": "bugis" }`, or none for the preselected spot: the one with the most "Works for me" among joined members, a tie going to the shorter longest trip (compared before rounding), then to the list's order (the app's by rank, then the members' by who suggested first). No planner run: the meeting area is written from the spot's stored figures (`meeting_max_minutes` and `meeting_total_minutes` from the rounded minutes, `meeting_count`, `meeting_approximate`, and each joined member's `session_members.travel_minutes`), `sessions.banner` is cleared and the status becomes `voting`. The spots stay as the record. `meeting_method` is `voted` when anyone approved the spot, `same` or `fairest` when nobody did and it is the app's first spot (`same` when every located member starts in one place), and `chosen` otherwise.

200 `{ "planVersion": 8, "status": "voting", "meetingAreaId": "bugis", "method": "voted", "slotCount": 4 }`. **The same write makes the slots and their places**: a slot for each of eat, drink, shop and activity (a kind the day is too short for is left out), laid out from what the members picked and how long they stay, and each slot's best places ranked around the meeting area (see "The slot plan" below). `slotCount` is the number of slots made. Confirming the same spot again answers the same 200 and writes nothing.

Errors: 403 `host_only`, 403 `not_joined`, 404 `spot_not_found` (not on the list), 409 `no_spots` (nothing listed), 409 `wrong_status` (not locating, and not already confirmed for that spot), 422 `unknown_area`.

### PUT /api/sessions/:id/known-place

The host sets the meeting area straight away because the group has already decided. Body `{ "areaId": "bugis" }`. Status `inviting` or `locating`, with at least two joined members. The list becomes that one area (`rank` null), suggestions and approvals are cleared, the meeting area is written with method `chosen` (pinned: a later change of start moves the times, never the area), and the status becomes `voting`. One planner run prices the area for the members who have shared a start (at most one route call per member); with none, the times are zero. The slots and their places are made in the same write, as above (with nobody located, everyone is planned for as starting at the place).

After the write has gone through, the server records the host's Start choice: `sessions.meet_by = 'known'` (service key, only when it is not 'known' already). It is a second statement after `apply_session_plan`, which is not changed for it, so the browser writes nothing for the choice on this path and a failed place leaves it as it was. If that statement fails (for instance the migration `20261026000000_jio_session_meet_by.sql` is not applied), the place stands, the answer is still 200, and a warning naming the migration is logged at most once a minute.

200 `{ "planVersion": 9, "status": "voting" }`. Setting the same place again answers the same 200 and writes nothing. Errors: 403 `host_only`, 403 `not_joined`, 409 `needs_two_people`, 409 `wrong_status`, 422 `unknown_area`.

### POST /api/sessions/:id/opt-out and POST /api/sessions/:id/rejoin

A guest steps out, and comes back. No body. Opting out keeps the member's row, deletes their approvals, suggestion and votes, and works the spots (or, while voting, the meeting area and the slots, as for `meeting-area`) out without them. Rejoining works them out with the member again (a member who is already in still gets the spots worked out, in case an earlier call was lost). Status `inviting`, `locating` or `voting`.

200 `{ "planVersion": 10, "state": "opted_out" }` and `{ "planVersion": 11, "state": "joined" }`. Opting out when already out does nothing. Rejoining is allowed while voting (the person comes back without their votes, which opting out took) and is refused once the plan is confirmed (409 `not_yet`). **Opting out of a confirmed plan** is allowed and changes the plan silently in nothing: the person goes out (their votes with them), the places they had put forward as the next stop are dismissed (by them), the stops stay, and the one thing written to the session is the question "Re-plan?" in `sessions.replan`, `{ "reason": "Faith opted out. The meeting area would stay at Bugis.", "trigger": { "kind": "optout" }, "at": 1760000000000 }`, in the same `apply_session_plan` write. The sentence says whether the planner's own pick of meeting area would move without them ("The fairest meeting area is now X."; a chosen area never does); that is priced for the sentence only (OneMap through the shared allowance) and nothing about the area is stored. A later opt-out replaces the question; the host answers it with `POST .../replan` (`accept: true` opens the plan for voting again, `accept: false` clears it), which also clears it. The other cases in which the browser's own version asks "Re-plan?" (a start, an end or a late start changing) cannot happen on the server: a member's own start and end are writable only while the session is inviting, locating or voting (`my_open_session_ids()`), and the meeting-area route refuses a confirmed session (409 `not_yet`). Leaving and being removed stay refused once the plan is confirmed (409 `session_started`). Errors: 403 `host_cannot_opt_out`, 409 `wrong_status` (completed, cancelled). (Opting out can pause a voting session, when it leaves fewer than two starts, and rejoining resumes it: see `meeting-area` above.)

### The slot plan (voting)

A voting session has one `slots` row for each of `eat`, `drink`, `shop` and `activity` (unique per session), made by the host's confirm or known place and kept by every voting write. A slot is laid out as if it were the only stop of the day (a port of the browser's rules, `src/planner/slot-plan.js`, with a test that holds the two together): Eat near lunch (12:00) or dinner (18:30), the others in the middle of the time half the group can stay. `start_minute`, `duration_minutes`, `picks` (how many joined members picked the kind), `is_last` (the last of the day's slots; every ranking is a browse, so none is ranked as the last stop) and `details` are stored; a slot the host removed has `deleted: true` and no options. `slots.details` is one shape, written by the server from the engine's own answer for the slot (`readRanking` and `slotDetails` in `src/services/session-slots.js`) and read by the Vote page as it is (`planView` in `frontend/src/lib/api.js`); nothing is translated between them:

| Field | Meaning | Where the engine says it |
|---|---|---|
| `widened` | `true` when the planner had to widen the search past the radius to find places (the notice the page shows). | `notice` present |
| `few` | `{ found, widenToKm }` when fewer than 3 places fit inside the radius: how many were found and how far to widen to find more (the page's "Widen to ..."). Otherwise `null`. | `notice` of type `few_options` (`found`, `widenToKm`) |
| `empty` | `{ reason, nearestKm, widenToKm }` when the slot has no places: why (`reason`, the engine's own word, such as `outside_max_radius`), how far the nearest fitting place is, and how far to widen. The two distances may be `null`. Otherwise `null`. | `status` other than `ok`, `reason`, `hints.nearestKm`, `hints.widenToKm` |
| `moreAvailable` | `true` when the ranking had more places than the slot holds, so "More suggestions" will add some. | places ranked beyond the slot's options |
| `weather` | The forecast the ranking was scored on, `{ source, basis, issuedAt?, validUntil?, phrase?, reason? }`, or `null`. | the answer's `weather` block |

The first version of the browser assumed `{ notice, empty: { reason, hints }, moreAvailable, weather }`; it now reads this one.

Each slot's places are `slot_options` rows (3 at first, up to 6): `venue_id`, `rank`, `score` (a penalty, lower is better), `source` (`planner`, or `member` for one a person added or swapped in), `added_by`, and `details` = `{ walkMinutes, crowd, reasons, warnings, swap: { venueId, name, weather } | null, explanation, checkNeeds?, approximate, weather? }`. The cards read them directly (`walkMinutes`, `reasons`, `warnings`, `swap.venueId` and `swap.name`, `explanation`, `checkNeeds`, `approximate`, `weather`), with a place's name, position and the rest from `GET /api/venues?ids=` (below). `crowd` and `swap.weather` are stored because the engine says them, but no screen shows them (crowd estimates were cut). Only saved places are ranked: no Google place (the lead's decision of 16 October). A place's id may be up to 160 characters, in the requests, the `slot_options.venue_id` check, `stops` and `stop_proposals`: the 32 hawker centres saved from OneMap have ids of 86 and are the places a halal group is offered, so they are options like any other.

**No need is named in a row or an answer every member reads.** Every member reads `slot_options.details`, so in a group of two a named need ("halal") would be the other person's. The planner's `verify` and `dietUnknown` (which name the needs a place only likely meets or has no data on) are therefore **not stored**: `details.checkNeeds` is `true`, and only then present, when any of them was non-empty for the place, and it names nothing. The browser names the needs it may itself, from each venue's own diet levels (`diet`, from `GET /api/venues`): its own person's needs always, and the others' only when `GET /api/sessions/:id/dietary` gives them (three have joined). Otherwise a card says only "Check it fits everyone's needs". The same holds for the search below (`group_needs`), and for the live frames and the rows in the database: none holds a need's name.

The ranking uses the same engine as `POST /api/converge` with the meeting area as centre, the radius the host chose, the weather at the slot's time (the live forecast, as the planner routes use it), `unknownPolicy: lenient` for everything but the diet, `dietPolicy: strict` for dietary needs (a place that is not known to suit every member's need is left out, though a halal hawker centre with certified stalls is "likely" and says to check them; `lenient` would keep and flag it), and the members' needs read with the service key after the caller has been admitted (`session_member_needs()`, which answers joined members only): everyone's diets count (a member with no start yet adds no trip, but what they cannot eat is still left out), a budget counts for the member who set it, and one member's need for step-free access holds for the whole slot. Each located member is planned from the centre of their start area. Places people already vote for are always scored and stay while they still fit.

### POST /api/sessions/:id/plan/sync

Work the slots and their places out again, after someone changed what they picked or how long they stay (a direct write). Joined members only. No body. 200 `{ "planVersion": 12, "changed": true }`; `changed` is false when nothing was different, and nothing is written. While `inviting` or `locating` there are no slots and the answer is `changed: false`. A voting session that has no slots (confirmed before this stage) gets them. Errors: 403 `not_joined`, 409 `wrong_status` (confirmed, completed, cancelled).

### PUT /api/sessions/:id/radius

The host sets how far from the meeting area places are offered. Body `{ "radiusMeters": 1000 }`: a whole number from 100 to 3000, or `null` to let the planner widen on its own. Statuses `inviting`, `locating`, `voting`. While voting every slot is ranked again: places outside the ring drop out with their votes and each slot tops up to three. When votes went, `sessions.banner` becomes `{ text: "Votes for places outside the new ring were cleared.", at, votesCleared: true, byRadius: true }` (or "Votes for places that no longer fit were cleared." for `null`); a radius change that drops no vote takes back its own earlier notice and leaves any other. The same radius again does nothing. 200 `{ "planVersion": 13, "radiusMeters": 1000 }`. Errors: 400 `invalid_input`, 403 `host_only`, 409 `not_yet` (confirmed). (The browser's own version let any member change it; the design makes it the host's.)

### DELETE /api/sessions/:id/slots/:slotId and POST /api/sessions/:id/slots/restore

The host removes a slot (its places and their votes go; the other slots do not move), and brings back one removed slot (`{ "slotId": "<uuid>" }`) or every removed slot (no `slotId`). Restored slots are ranked afresh. `:slotId` is the slot's row id. Status `voting`. 200 `{ "planVersion": 14 }` and `{ "planVersion": 15, "restored": ["<slot id>"] }` (empty when none was removed); removing a removed slot does nothing. Errors: 403 `host_only`, 404 `slot_not_found`, 409 `wrong_status`, 409 `no_meeting_area` (restoring while voting is paused).

### POST /api/sessions/:id/slots/:slotId/options

A joined member adds a place to a slot. Body `{ "venueId": "ya-kun-kaya-toast" }`. The place must be a saved one and fit the slot (the planner is asked with it among the options, and it must come back as one that still fits). It is kept as `source: member`, `added_by` the caller. 201 `{ "planVersion": 16, "added": true }`; already an option: 200 `{ "planVersion": 16, "added": false }` and nothing is written. Errors: 403 `not_joined`, 404 `slot_not_found` (also a removed slot), 404 `venue_not_found`, 409 `slot_full` (6 places), 409 `no_meeting_area`, 422 `venue_does_not_fit`.

### POST /api/sessions/:id/slots/:slotId/options/more

"More suggestions". Body `{ "have": 3 }`, the number of places the caller sees (0 to 6). The slot gets the next best places so that it holds `min(6, have + 3)`; if it already holds that many nothing is added, so a retry never adds again. 200 `{ "planVersion": 17, "added": ["venue-id"] }`. Errors as for adding.

### POST /api/sessions/:id/slots/:slotId/options/:venueId/swap

A joined member swaps one place of a slot for another. Body `{ "toVenueId": "toa-payoh-library" }`. The place changes **in place, so the votes for it follow it** (the design's choice; the browser's own version deleted them). When the other place is already an option the votes move to it and this one goes. Any joined member may swap, so a swap moves other people's votes along with the place; that is the design's choice (a place that changes, say for rain, takes its supporters with it) and is kept open to every member on purpose. The new place must be saved and fit. 200 `{ "planVersion": 18, "swapped": true }`; swapping again, when the place it leaves is gone and the other is there, is 200 `swapped: false`. Errors: 404 `option_not_found` (the place was never an option, or the session is paused and has cleared its places), 404 `venue_not_found`, 409 `no_meeting_area` (only when the place is still an option, so not in a paused session), 422 `venue_does_not_fit`, and those above.

### GET /api/sessions/:id/slots/:slotId/venue-search?q=

A joined member searches the saved places by name, area or address for a slot (1 to 60 characters). 200 `{ "results": [ { "venueId", "name", "area", "category", "source", "matchedStall", "walkMinutes", "distanceKm", "fits", "unfit": ["closed"], "added" } ] }`, at most 12, fitting places first. It changes nothing. Dietary needs and a need for step-free access are applied (`dietPolicy: strict`), but no result names a need: every reason that does (`diet:halal` and so on, `step_free`) is `group_needs`, once, among the other reasons (`closed`, `far`, `category`, ...), and a result carries no `verify` or `dietUnknown` (they would name the needs of the other members; a stateless `POST /api/search` still sends them). Its own limit is `VENUE_RATE_LIMIT_PER_MINUTE` (120) a minute per person, counted apart from the writes. Unlike `POST /api/search` it asks neither Google nor OneMap: there is no postal-code lookup, so a postal code finds a place only by its address text. Errors: 400 `invalid_input`, 403 `not_joined`, 404 `slot_not_found`, 409 `wrong_status`, 409 `no_meeting_area`.

### GET /api/venues?ids=

The saved places behind the cards of a voting session. Any signed-in person. `ids` is up to 50 ids separated by commas, each up to 160 characters. 200 `{ "venues": [ { "id", "name", "lat", "lng", "category", ... } ] }`: the planner's own venues (as `POST /api/converge` sends them), in the order asked, each once; an id the planner does not know is left out. 400 `invalid_input` for none, more than 50, or an id over 160 characters. Its own limit: `VENUE_RATE_LIMIT_PER_MINUTE` (120) a minute per person, counted apart from the search above and from the writes, so showing cards never uses up the allowance of the writes (429 `rate_limited`).

## The plan: the suggested order, confirming, the stops and finishing (`/api/sessions/:id/...`)

Stage 5 of the sessions work. Every route needs a login, then the same per-person limit as the other session routes, and answers errors in the flat `{ error, message }` shape (400 `invalid_input` with `issues`, 401, 403 `host_only` / `not_joined`, 404 `session_not_found` for a stranger as for a missing session, 409 `wrong_status`, 409 `plan_busy` with `Retry-After`, 500). **Apply `db/migrations/20261023000000_jio_apply_session_plan_stops.sql` before the stage 5 backend runs anywhere** (the server checks at start-up that the columns and tables are there and stops with a message naming the migration if they are not: `checkPlanSchema` in `src/db/sessions.js`): it reads `sessions.order_suggestion`, `plan_start_minute` and the other plan columns, `stops.not_before_minute` and `stop_proposals`, and calls `session_travel_debt()` and the new parts of `apply_session_plan`, none of which exist until it (or `20261011000300`) is applied.

**What the browser sends, and what it never does.** The browser never sends a stop, a time, a sentence or anyone's minutes. The stops of a confirm come from the stored winners of each slot (most votes of joined members, a tie to the lower planner score, then the better rank), laid back to back inside the session's window as the browser's `planSlotsOf` does; a suggested order, its sentence and who chose it come from `sessions.order_suggestion`; the ledger comes from stored rows. Every host-only route checks `host_id` on the row the caller's own client read, and the service key is not used before that check passes.

**Where a stop's minutes come from.** `stops.travel_minutes` is the leg into that stop, worked out by the server with the browser's own formulas for walking, the MRT and a car (`src/planner/itinerary.js`, held to `frontend/src/lib/planner/` by `backend/tests/itinerary-port.test.js`). `stops.travel_mode` is the host's choice for that leg, `null` for the default. `stops.not_before_minute` is the earliest the stop may start: the suggested order's start for each stop, or the moment a replaced or proposed stop was checked for. `sessions.plan_start_minute` is when the plan starts, which reordering keeps. A stop with no `slot_id` was added from a Roam proposal.

### POST /api/sessions/:id/order/suggest
The host, in a `voting` session, once two joined people have voted. No body. The server takes the stops the votes make now, hashes them with the session's date and times (`basis`), and returns the stored suggestion when its `basis` is the same (no AI call, no write). Otherwise it lists every order that keeps each place open and each meal on time (`planner/arrange.js`), has the itinerary AI choose among them inside its own budget (`ITINERARY_AI_CALLS_PER_MINUTE`, two at once, a 10-minute cache, a pause after three failures, an 8-second deadline; the rules choose when it cannot answer), and stores `{ basis, order, starts, reason, source, at }` in `sessions.order_suggestion`. Only the places' names, kinds, opening hours and settings, the stops' lengths and times, and whether it rains go to the provider; never a person, an area or an id. `rain` is true only in stub mode with the rain scenario. 200 `{ "status": "ok", "basis": "<64 hex>", "order": ["<slotId>", ...], "stops": [{ "slotId", "venueId", "start" }], "reason": "...", "source": "ai" | "rules" }`, or `{ "status": "none", "why": "no_stops" | "one_movable" | "no_order_fits" | "unknown_place", "basis": "<64 hex>" }` (nothing is stored; `basis` is there except for `no_stops`, so a confirm of the voted order can say which votes the host looked at). Errors: 403 `host_only`, 409 `not_enough_votes`, `wrong_status`. If the votes move while the order is worked out, it works out again (up to three times), then 409 `plan_busy`.

### POST /api/sessions/:id/confirm
The host. Body `{ "order": "voted" | "suggested", "basis": "<64 hex>" }`, all optional; `order: "suggested"` needs `basis`. `voted` (or no body) writes the stops in the voted order with no earliest start. A `basis` may go with the voted order too (the one `order/suggest` gave, even when it answered `none`): one that is not the votes' own now is **409 `order_stale`** and nothing is written, so what the host saw is what is saved. **The tally is read again under the session's lock** (`apply_session_plan`): every stop must still be a leader of its slot (a tie is a leader; only joined people's votes count) and every slot somebody voted in must have its stop, else the same **409 `order_stale`** (hint `stale_tally`). A browser's vote is refused with hint `votes_status` once the session is no longer voting (the trigger `votes_guard_status` takes a shared lock on the session, which the function's exclusive lock waits for), so a vote either lands before the confirm and is counted, or is turned away. `suggested` takes the stored suggestion (its order, its start as each stop's `not_before_minute`, and its sentence and source as `sessions.order_reason` / `order_source`) **only if** the body's `basis` equals the stored suggestion's **and** the stops the votes make now still hash to it: otherwise **409 `order_stale`** and nothing is written (the host asks for a suggestion again and is shown the new order). At least two joined people must have voted (409 `not_enough_votes`); a day too short to lay any stop out is 409 `nothing_to_confirm`. The status becomes `confirmed`, `banner` and `replan` are cleared, `plan_start_minute` is the first voted stop's planned start. 200 `{ "planVersion", "status": "confirmed", "stops": 3 }`. Confirming a confirmed session answers the same without writing.

### POST /api/sessions/:id/change-meeting-place
The host changes the meeting place after it was set. Body `{ "meetBy": "fairest" }` or `{ "meetBy": "known", "areaId": "bugis" }`, each with an optional `"planVersion": 12`, the version the caller saw (strict: `known` needs `areaId`, `fairest` must not have one; anything else is 400 `invalid_input`; an area the planner does not know is 422 `unknown_area`). Statuses: `voting` or `confirmed` only (409 `wrong_status` otherwise, so `inviting`, `locating`, `completed` and `cancelled` never change here). The host only (403 `host_only`); a person who is not in the session gets 404 `session_not_found` before the service key is used.

It is **one write** through the session's line: the op `release_meeting` (above) takes the session back to `locating`, and the notice is written in it: `{ "text": "Ian changed the meeting place, so the votes and the plan were cleared.", "at", "released": true }` (the wording follows what went: "the votes were cleared" in voting, "the votes and the plan were cleared" in a confirmed plan, and when nobody had voted "the places to vote on were cleared", or "chosen again" when the host named the area). With `fairest` the spots are worked out again in that same write, from the starts people already shared (one engine run, the shared OneMap allowance), so a guest never sees an empty list between the two; `meet_by` becomes `fairest`. With `known` the release writes no spots and `meet_by` becomes `known`; the server then runs the known place (`PUT .../known-place`, a second write) with the notice brought along, which now names the area ("Ian changed the meeting place to Orchard, so the votes were cleared.", `released` and `votesCleared`). If that second write fails the session stays on Locate with the host's choice recorded and the first notice, the answer is the failure's (500 or 409), and the host names the area from Locate ("We already have a place"); the server keeps nothing in memory between the two.

200 `{ "planVersion", "status": "locating", "meetBy": "fairest" }`, or `{ "planVersion", "status": "voting", "meetBy": "known" }`. **A retry never wipes what happened since:** a `planVersion` that is not the session's now is 409 `stale_plan` and nothing is written (the browser sends the version it read). Without one, a repeat of `known` naming the area the session is already voting at (chosen by the host's own `known`) with no vote cast yet is a no-op that answers 200 and writes nothing. Repeating `fairest` once the session is locating is 409 `wrong_status` and writes nothing.

**The gap in `known`.** It is two writes, so between them the session is `locating` for a moment, with no spot list (the `fairest` release has none missing: its spots are in the release's own write). A guest's page waits briefly and looks again before it leaves Vote or Itinerary, and goes back to Vote when the session is voting at the new area, where the notice is shown. If the second write fails the host is shown the error on Locate. **The migration must be applied first** (see the file's header): without it the route answers 500, nothing else is affected.

### POST /api/sessions/:id/replan
The host. Body `{ "accept": true }` (default). Opens a confirmed plan for voting again: the stops, the order note, the suggested order, `plan_start_minute` and the prompt are cleared, the pending proposals are dismissed, the meeting area is worked out again (a chosen area stays; the planner's own pick may move, and then the votes go and the banner says so) and the slots are ranked again. 200 `{ "planVersion", "status": "voting" }`; already voting is a no-op. `accept: false` only clears `sessions.replan` (200 `status: "confirmed"`).

### PUT /api/sessions/:id/stops/order, DELETE and PATCH /api/sessions/:id/stops/:stopId, PUT /api/sessions/:id/stops/:stopId/place
All the host's, all only while the plan is `confirmed`, all answer 200 `{ "planVersion" }` (with the fields below) and 404 `stop_not_found` for a stop that is not in the plan.
- **Order.** `PUT .../stops/order` body `{ "stopIds": ["<id>", ...] }`: every stop once, in the new order, else 409 `stops_changed` (not 404 `stop_not_found`: the list is the caller's view of the plan and the plan has moved; the browser words it "The plan changed. Look at it again."). `stop_not_found` is for the routes that name one stop. The plan keeps its start; the modes go back to their defaults; the order note and every non-Roam stop's earliest start go. The same order again changes nothing.
- **Delete.** `DELETE .../stops/:stopId`: the stops after it move up, the legs either side merge into one with its default mode, the note and the earliest starts from the order go, and deleting the first stop makes the plan start when the next one does (its own earliest start if it came from a proposal). The last stop is 409 `last_stop`.
- **Travel mode.** `PATCH .../stops/:stopId` body `{ "travelMode": "walk" | "mrt" | "car" | null }`: how the group gets to this stop from the one before, and the stop's `travel_minutes` with it. The first stop has no leg: 409 `no_leg`. 200 `{ planVersion, travelMode }`.
- **Another place, the one way** (the browser's `changeStopPlace`, behind both the rain swap and Replace). `PUT .../stops/:stopId/place` body `{ "venueId", "seenVenueId", "category"? }`. Refused: 404 `venue_not_found`; 409 `stop_changed` when the stop no longer holds `seenVenueId` (the place the caller saw); 409 `already_a_stop`; 422 `venue_does_not_fit` when the planner, asked for the place at the time the stop starts in the itinerary now (as the plan's last stop if it is), does not keep it. The stop keeps its length and start, its `not_before_minute` becomes at least that time (never earlier than checked), the legs either side go back to their defaults, the note goes, and the new place is kept as an option of the stop's slot with what the planner said about it (the old place leaves the options with its votes). `category` makes it another kind of stop. 200 `{ planVersion, changed }` (`changed: false` when the stop already holds the place).

### GET /api/sessions/:id/stops/:stopId/swap, GET /api/sessions/:id/stops/:stopId/choices and POST /api/sessions/:id/roam
Three reads for a confirmed plan. They rank places from the planner's own pool of saved places with the same engine and services as a voting slot, and **write nothing and keep nothing**: no row is written and no cache holds an answer. The point sent to Roam is not stored, not logged and not answered, and its routes **skip the route cache** (`cache: false` through `runWithTravel`): the origin reaches OneMap, rounded to about 110 m as OneMap's request is, to get each trip's time, and no copy of it stays in this process (the cache would have kept it for 6 hours). The stateless `POST /api/roam` is unchanged and does cache. A choice a person acts on goes through a write route that puts it in the database: `PUT .../stops/:stopId/place` (the stop's place, in `stops`), `POST .../proposals` (`stop_proposals`). All three need a login, then the planner routes' per-person limit (`PLANNER_RATE_LIMIT_PER_MINUTE`, counted together with the stateless planner routes), spend the request's own allowance of 60 OneMap trips (whole places only, the estimate where it cannot route), and never ask Google. The group's needs (dietary needs, step-free access) decide which places are left, but **no answer names a need**: a place that is only likely to meet one carries the flag `checkNeeds: true`, a result has no `verify` or `dietUnknown`, and an empty answer carries no hint saying what to relax. A stranger, and anyone not in the session, gets 404 `session_not_found` before the service key is used. Errors common to the three: 400 `invalid_input`, 401, 403 `not_joined` (the caller opted out), 404 `session_not_found`, 409 `wrong_status` (not confirmed), 409 `no_meeting_area`, 429 `rate_limited`.

- **Swap.** `GET .../stops/:stopId/swap`. Any joined member. The indoor place the planner would put in the stop in the rain: it ranks the stop's own place for the stop's own length at the time the itinerary starts it now (as the plan's last stop if it is), with the plan's other stops left out, and the `swap` it gives for a place with a rain warning is the answer. 200 `{ "swap": { "venueId", "name" } }` or `{ "swap": null }` (a dry day, a sheltered place, no indoor place near). 404 `stop_not_found`. Putting the place in is the host's `PUT .../place`.
- **Replace's list.** `GET .../stops/:stopId/choices?category=eat|drink|shop|activity`. Only the host (403 `host_only`). The places that could take the stop's place, of `category` (the stop's own when left out), ranked for the stop's own time as above; the places the group voted for in that kind are always among them while they fit, and a place any stop already has is never offered. 200 `{ "category": "drink", "options": [ { "venueId", "rank", "score", "votes", "details" } ] }`: `votes` is how many joined members voted for the place in that kind (a number, never who), `details` is what a voting option keeps (`walkMinutes`, `crowd`, `reasons`, `warnings`, `swap`, `explanation`, `checkNeeds`, `approximate`, `weather`). The query takes `category` and nothing else (a time is the server's: 400 for any other key). 404 `stop_not_found`.
- **Roam.** `POST .../roam`, **only on the day of the outing** (409 `wrong_day` on any other day, Singapore's date), body `{ "current": { "lat", "lng" }, "categories": ["eat", ...] }`, both optional (`current` inside Singapore, up to 4 kinds; any other field is 400). Any joined member. The places near `current` (used for this request only), or near the meeting area's centre; ranked for the time the next stop would start, today in Singapore (when the last stop ends, or now if that has passed) and an hour long, with the group's needs and the weather. 200 `{ "status": "ok", "results": [ { "rank", "venueId", "name", "venue", "score", "travelMinutes", "distanceKm", "walkMinutes", "crowd", "reasons", "warnings", "swap", "weather", "explanation", "approximate", "checkNeeds"?, "isStop", "proposedBy" } ], "notice", "weather" }`, at most 10, best first. `isStop` says the place is already in the plan; `proposedBy` is the id of the member who put it forward as the next stop, or `null`. The answer has no `centre` (the point), no `breakdown` and no `diagnostics`. When nothing fits: `{ "status": "empty", "reason", "hints": { "nearestKm"?, "widenToKm"? }, "results": [], "weather" }`.

### PUT /api/sessions/:id/stops/:stopId/kept-rain
The host keeps a stop as it is in the rain (the "Keep" button on a rain warning). Body `{ "state": "showers" }`: the forecast's state when it was pressed (a lower-case word of at most 24 letters; any other field is 400). Only while the plan is confirmed (409 `wrong_status`), host only (403 `host_only`), a stop of the plan (404 `stop_not_found`). It is **stored on the session** in `sessions.weather_kept`, `{ "<stop id>": "<state>" }` (jsonb, server only: a browser has no update on the column; a check keeps it an object of at most 1,000 bytes), written through `apply_session_plan` (`session.weather_kept`, only while the session is confirmed after the patch), so every member and every device of the host sees the warning put away, after a reload or a server restart. The warning comes back when the forecast changes state (the screen compares the state kept with the state now). The stop's place changing (`PUT .../place`), the stop being deleted, the plan being opened again, finished or confirmed afresh clears the stop's entry (or all of them). The same state again changes nothing. 200 `{ "planVersion", "kept": true }`.

### POST /api/sessions/:id/complete
The host finishes the outing, `confirmed` to `completed`, **from the outing's day on** (409 `before_the_day` before it; Singapore's date). Nothing finishes a shared outing by itself yet: a sweep that closes outings whose day has passed is a follow-up, so until then the host does it (the browser offers "Finish outing" on and after the day, and Home reminds the group that the outing stays open until its host finishes it). No body (a body is 400: nobody sends anyone's minutes). The server computes the ledger from stored rows for every joined member who has minutes in (`session_members.travel_minutes`, stored when the meeting spot was confirmed): `minutes_in` is that, `minutes_between` is the sum of the stops' stored `travel_minutes`, `minutes_home` is routed, leaving when the last stop ends on the outing's day, from the last stop to the centre of the area the person ends the day in (their end area, else their start area), by OneMap through the shared runs inside the request's allowance of 60 trips (the estimate where it cannot route), and `delta_from_mean` is the person's total minus the group's mean, rounded to hundredths with the rounding left over given to the person with the most minutes, so the deltas sum to exactly zero (the database checks it). The ledger rows and the status are written together; `completed_at` is stamped; the pending proposals are dismissed. A retry after success answers the same 200 `{ "planVersion", "status": "completed" }` and writes nothing. Refused unless confirmed (409 `wrong_status`), and for a guest (403 `host_only`).
Who reads a ledger row: `commute_ledger_select` lets every member of the session read every row of that session (a person's own row, or any row of a session they are in). A row holds only minutes and a delta, no place, label or coordinate; the minutes in are already readable by the group on `session_members.travel_minutes` and `session_spots.travel_minutes`, and the minutes home come from the centres of areas the group already sees. Nobody can write a ledger row from a browser.

### POST /api/sessions/:id/proposals and POST /api/sessions/:id/proposals/:proposalId/resolve (Roam)
- **Propose.** A joined member, while the plan is confirmed. Body `{ "venueId" }` (a saved place). 201 `{ planVersion, id, applied: true }`; a place already waiting stays its first proposer's: 200 `{ planVersion, id, applied: false }`. 404 `venue_not_found`, 409 `already_a_stop`, `plan_full` (8 stops), `too_many_proposals` (3 waiting for a member, 10 for the session).
- **Answer.** `resolve` body `{ "accept": true | false }`. Accepting is the host's: the place is appended as the last stop (no slot, its own category, 60 minutes, not before the last stop ends, or now if that is later and the outing is today in Singapore; on any other day the clock says nothing about the plan) and the note goes. Dismissing is the host's or the proposer's own. 200 `{ planVersion, applied }`; a proposal that is not waiting any more (answered, or cleared by a re-plan, a finished outing) is `applied: false` and writes nothing. 409 `plan_full` on accepting into a full plan.

### The group's past in the rankings
A ranking of a session's slots and its meeting area use two extras, both softly: each joined member's **travel debt** (`session_travel_debt()`, the sum of their ledger deltas in other sessions in the last 90 days, clamped, read with the service key) as `travelDebtMinutes`, and **the places the group has been to lately** (the stops of the finished outings of the last 60 days, the newest 30, in which at least two of this session's joined members were, read with the service key for **every** joined member, so the ranking that is stored does not depend on who asked; only the places and days of those outings are used, never who was there) as the planner's visit history for this session. Any failure or slowness (a function not on the project, a timeout) means the planner answers without them, and logs one line a minute without the database's message. The sample visits in the planner's data are never used for a session.

## DELETE /api/sessions/:id/members/:userId

Leave a shared session, or (as the host) remove a guest. `:userId` is `me` (the caller leaves) or a person's id (the host removes them). No body. A browser cannot delete a member row itself (the database gives a signed-in user no delete on `session_members`), so the server does it.

| Answer | When |
|---|---|
| 200 `{ "planVersion": 3, "left": true }` | The caller left. |
| 200 `{ "planVersion": 3, "removed": true }` | The host removed a guest. |
| 400 `invalid_input` | `:id` or `:userId` is not a uuid (or `me`). |
| 401 `unauthenticated`, 503 `auth_unavailable` | The login check, as for every route that needs one. |
| 403 `host_cannot_leave` | The host asked to leave, or someone asked to remove the host. They cancel the session instead. |
| 403 `host_only` | A guest asked to remove someone else. |
| 404 `session_not_found` | No such session, or the caller is not a joined member of it (an opted-out member too; the same answer, so a stranger learns nothing). |
| 404 `member_not_found` | The person is not in the session (or went a moment ago). |
| 409 `session_closed` | The session is completed or cancelled. |
| 409 `session_started` | The session is `confirmed`. Leaving and removing a guest stay refused once the plan is confirmed, by decision: a guest who does not want to go opts out instead (`POST .../opt-out`, which asks the host "Re-plan?"), and the host cancels or re-plans. `inviting`, `locating` and `voting` are allowed. |
| 409 `plan_busy` | The session changed again three times while this was worked out. |
| 429 `rate_limited` | More than `SESSION_RATE_LIMIT_PER_MINUTE` (60) a minute from one person. |

The member's row goes, and with it their exact place, approvals and suggestion (foreign keys) and, deleted by the same write, their votes; then the spots (or, while voting, the meeting area and the slots) are worked out without them, in the same transaction, and `sessions.plan_version` goes up (which every remaining member hears as an update of the session row). If approvals went with a spot that dropped off the list, the banner says so ("Jonathan left. Orchard is no longer on the list, so approvals for it were removed.").

## GET /api/people/search?q=

Find a person to invite by the start of their username. It feeds the invite field, which asks after a short pause as the person types. Not a planner route: it needs a login (`Authorization: Bearer <token>`, see `GET /api/me`) and Supabase to be set up; without them the route does not exist and answers 404.

The server reads `profiles` with its own key and selects only the public columns (`id, username, display_name, avatar_url`), so the profiles rule can later be narrowed to the person and the people they share a session with (ticket #125) without this screen changing. Who the caller has "met" is read through the caller's own client, so the database's access rules decide it. It is asked after the matches are known and only about them (the first 50 matches by username), so the API's row cap on a read never cuts it. If that read fails the search still answers, in username order with `metBefore` false, and the failure is logged.

`q` is the start of a username: trimmed, lower-cased, 3 to 20 characters from `a-z`, `0-9` and `_` (the same alphabet as `username_format` in `db/schema.sql`). It matches the start of a username only, never a display name and never the middle. `%`, `_` and `\` are escaped before the pattern is made (a plain `LIKE`, since usernames are lower case in the database and `q` is lower-cased), so `sam_` matches `sam_tan` and not `samuel`.

```
GET /api/people/search?q=sam_
200 { "people": [ { "id": "7f3c...", "name": "Sam Tan", "username": "sam_tan", "avatarUrl": "", "metBefore": true } ] }
```

At most 5 people, in this order: the exact match, then people who share (or shared) a session with the caller, then the others; inside each group by username. The caller never appears. `name` is the display name, or the username when there is none. `avatarUrl` is the address the person set, or `""`: the frontend shows it only when this project's own storage serves it. Every answer, including a 400, 401 or 429, is `Cache-Control: no-store`.

| Answer | When |
|---|---|
| 200 `{ "people": [...] }` | Always for a valid `q`; the list is empty when nobody matches. |
| 400 `invalid_input` | `q` is missing, repeated, shorter than 3 or longer than 20 characters, or has a character outside `a-z`, `0-9`, `_`. |
| 401 `unauthenticated`, 503 `auth_unavailable` | The login check, as for every route that needs one. |
| 429 `rate_limited` | More than `PEOPLE_SEARCH_RATE_LIMIT_PER_MINUTE` (120) a minute from one person. |

## GET /api/sessions/:id/dietary

An outing's dietary needs, together and without names (ticket #107), so "Confirm dietary needs" can open with them selected for a real friend's need too. Not a planner route: it needs a login and Supabase, as `DELETE /api/sessions/:id/members/:userId` does; without Supabase it does not exist and answers 404. A need is private (`profile_private`, read only by its owner and the server), so the server reads every joined member's through `session_member_needs()` with its own key, after checking as the caller that they are in the session, and answers only the needs.

| Answer | When |
|---|---|
| 200 `{ "dietary": ["halal", "vegan"], "others": ["halal"] }` | `dietary` is every joined member's needs together; `others` is everyone's but the caller's (the ones the caller cannot take off), and `[]` until at least three members have joined. Each list is in the app's order (halal, vegetarian, vegan), each need once; anything else in a row is left out. Never an id, a count or another private field (home area, budget, step-free). `Cache-Control: no-store`. |
| 400 `invalid_input` | `:id` is not a uuid. |
| 401 `unauthenticated`, 503 `auth_unavailable` | The login check. |
| 404 `session_not_found` | No such session, or the caller is not a joined member of it (an opted-out member too; the same answer, so a stranger learns nothing, and no private row is read). |
| 429 `rate_limited` | More than `SESSION_RATE_LIMIT_PER_MINUTE` (30) a minute from one person, counted apart from leaving. |

With fewer than three joined members `others` is `[]`: in a group of two it would be the other person's own list, and it is never offered for the "Unselect" warning. (`dietary` is still everyone's together, because the places are filtered for it; the line "Showing places that fit halal" says as much.) Members who opted out count for nothing here: they add no need and are not part of the three.

## Limits

Every list and number has an upper limit, so one request cannot keep the server busy. Going over any of them is a 400 naming the field.

| Field | Limit |
|---|---|
| `members`, `optedOut`, `overrides` | 30 |
| `groupConstraints` | 10 |
| `currentOptionIds` | 30 (the app shows at most 6 options per slot) |
| `excludeVenueIds` | 200 |
| `categories` | 4 (repeats are removed) |
| `alternatives` (meeting area) | 3 |
| `include` (meeting area) | 8 area ids, each a known area, none repeated |
| `areaId` (session endpoints) | 60 characters, a known area |
| different areas members may suggest in one session | 8 |
| `cuisineLikes`, `cuisineDislikes` | 20 each per member |
| a place's id in `currentOptionIds` or `excludeVenueIds`, in a session route's path or body, and in `GET /api/venues?ids=` | 160 characters (`MAX.venueId`; a saved OneMap place's id carries its address, the longest are 86; the database's own limit is the same) |
| any other id, name or label | 80 characters |
| `stops` of `/api/itinerary/arrange` | 8, of which at most 6 are not food (see that route's table) |
| `stops` of `/api/weather/stops` | 8, with different ids; `exposure` 0 to 5 |
| any weight | 1000 |
| `budgetMaxPerPerson` | 10000 |
| `max_price_pp:N` | 5 digits |
| `near_mrt:N` | 3 digits |

## Known limits

Things that are true today and that the team should know. None of them is fixed here.

- **`groupId` comes from the caller.** Anti-repeat uses the visit history of the group the request names, and `groupId` is a free-text field the caller supplies. That is harmless while there is no real visit history (a default server holds none: the sample visits are served only with `INCLUDE_FICTIONAL_VENUES=1`). Once real history exists, the group must come from the signed-in session on the server, not from the request, or anyone could read which places another group visited by guessing its id (the ranking and its "somewhere new for the group" and "the group went here recently" lines would show it).
- **Saved sessions that hold invented venues.** The 36 fictional venues are no longer in the planner's pool. A session saved in a browser before this change can still hold their ids, and the screens keep showing them. But a voting session drops such an option, and the votes on it, on its next re-rank; no rain swap is offered for such a stop; and replacing a stop with one is refused.
- **A rating counts as far as its reviews** (ticket #149, agreed with the lead on 16 October 2026). A venue is scored on `(20 × 4.0 + reviews × stars) ÷ (20 + reviews)`: one review at 5.0 becomes 4.05, 500 at 4.6 stays 4.58. A place with no rating, or a rating with no review count, counts as 4.0, the average. That is the curated, OneMap and CDC places (none has a review count). The invented places of `mock-data.json` (served only with `INCLUDE_FICTIONAL_VENUES=1`) do have a count, so they are scored on their ratings; Google's places always do. It is a `rating` factor in `breakdown`, and it is used in the engine's first cut of candidates too. Its weight is 8 under the default weights and scales with the weights in use (8 ÷ the total of the engine's default weights × the total of the weights sent), so it has the same share of the score (about 8%) whatever a request sends, and `weights` cannot switch it off. It is not a weight a caller can send (the API still answers 400 for `rating`). `reasons` may carry `Rated 4.6 from 512 reviews` for a place with at least 50 reviews and a weighted rating of 4.2 or more; a lower rating is never shown as a reason. It comes ahead of "Short walk" and "Hidden gem". Showing the review count on a card beside the score is planned, not built: nothing in the frontend reads `ratingCount` yet.
- **One place per building, per category.** Of the places at one address (a postal code, else a street number and street; unit numbers are ignored; every source) only the best-scored is placed in order; the others move below the places at other buildings, and are still listed after them. A place whose building cannot be told counts as its own building.

## Testing from Playwright (stub mode)

Start the backend with `STUB_EXTERNALS=1 pnpm dev:backend`. Then send the `x-jio-scenario` header on `/api/**` requests:

- `rain`: the forecast fixture says heavy thundery showers everywhere, unless the body sends `weatherCase`.
- `routing-fail`: every OneMap route fails, so travel falls back to the estimate (`travel.source: 'estimate'`) and results come back with `approximate: true`.
- No header (`dry`): routes are generated from distance in OneMap's format, so `travel.source` is `onemap`.
- The regional forecast is stubbed too (`rain`: heavy thundery showers everywhere; otherwise partly cloudy), moved in time on each call so it always covers the next 18 to 24 hours. A stop within 2 hours uses the area fixture, a stop up to 25 hours away the regional one, anything later has no weather.
