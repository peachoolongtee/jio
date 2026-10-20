# Planner API

How the frontend asks the backend where to meet and which venues to suggest. The routes live in `backend/src/routes/plan.js`, the input checks in `backend/src/routes/plan-schemas.js`.

Base URL: `VITE_API_BASE_URL` (locally `http://localhost:3000`). Every request and response is JSON. All four endpoints are `POST`.

| Endpoint | Use it for |
|---|---|
| `POST /api/meeting-area` | Once per session, after everyone has set a start point: where the group meets. |
| `POST /api/converge` | Once per itinerary slot: rank venues for the group around the meeting point. |
| `POST /api/roam` | "What next?": rank venues near one person's current point. |
| `POST /api/search` | Find a place by name to add as an option, and say whether it fits the slot. |
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
- `dietary` accepts `halal`, `vegetarian` and `vegan`, in any letter case.
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
  "approximate": false,
  "diagnostics": { "routingCalls": 74, "activeMembers": ["ian", "faith"] }
}
```

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
- **`diagnostics`** gains `extraRoutingCalls` (only when candidates are asked for): the trips the engine asked about for areas outside the chosen area's ranking, that is included areas the station rule did not try, or, for another method, the areas tried for runners-up. `routingCalls` is unchanged.
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
| `unknownPolicy` | no | `strict` (default): a venue with no data on a diet need, step-free access or sockets is left out. `lenient`: it is kept, and `dietUnknown` says what we don't know. |
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
  ],
  "diagnostics": { "passedFilters": 1446, "radiusUsed": 500 }
}
```

`breakdown` and `venue` are shortened here; the real response has every factor and every venue field.

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

Places that fit come first, then by walking time. `distanceKm` is rounded here. `unfit` says why a place can't be added. It uses the same words as `diagnostics.rejectedCounts`:

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

`approximate: true` on a result (or on the meeting area) means at least one of its trips used the estimate, whether it `failed` or was `estimated`. A result that is not approximate has real times for every trip. `diagnostics.routingCalls` is the engine's own count of the trips it asked about; `travel` is what was really fetched.

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
- With routing on, the meeting area tries the 16 areas nearest the fairest point, unless `maxCandidates` is sent. 16 never missed the best area in 2,000 random groups. `/api/meeting-area` also accepts `dateTime`, for when the group sets off; without it, the server uses the time now.

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

## DELETE /api/sessions/:id/members/:userId

Leave a shared session, or (as the host) remove a guest. Not a planner route: it needs a login (`Authorization: Bearer <token>`, see `GET /api/me`) and Supabase to be set up; without them the route does not exist and answers 404. A browser cannot delete a member row itself (the database gives a signed-in user no delete on `session_members`), so the server does it with its own key after checking the caller as the user.

`:userId` is `me` (the caller leaves) or a person's id (the host removes them). `:id` is the session's id. No body.

| Answer | When |
|---|---|
| 200 `{ "planVersion": 3, "left": true }` | The caller left. |
| 200 `{ "planVersion": 3, "removed": true }` | The host removed a guest. |
| 400 `invalid_input` | `:id` or `:userId` is not a uuid (or `me`). |
| 401 `unauthenticated`, 503 `auth_unavailable` | The login check, as for every route that needs one. |
| 403 `host_cannot_leave` | The host asked to leave, or someone asked to remove the host. They cancel the session instead. |
| 403 `host_only` | A guest asked to remove someone else. |
| 404 `session_not_found` | No such session, or the caller is not in it (the same answer, so a stranger learns nothing). |
| 404 `member_not_found` | The person is not in the session (or went a moment ago). |
| 409 `session_closed` | The session is completed or cancelled. |
| 409 `session_started` | The session is no longer inviting. For now only a session that is still inviting can be left or taken out of: the database lets a host start one directly, and a person who left it would leave their votes and spot approvals counted. Stage 3 takes those with the member and lifts this. |
| 429 `rate_limited` | More than `SESSION_RATE_LIMIT_PER_MINUTE` (30) a minute from one person. |

The member's exact place goes with their row (a foreign key). The server then raises `sessions.plan_version` by one, which every remaining member hears as an update of the session row (Realtime), so their screens follow. The version is written only if it is still what the server read (`update ... where plan_version = <read>`), up to four tries, so another write that raised it meanwhile is never moved backwards. This is best effort: if it cannot be raised the answer is still 200, `planVersion` is the last version seen, and the others find out on their next read. Ids are compared without regard to the case of their letters.

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
| `cuisineLikes`, `cuisineDislikes` | 20 each per member |
| any id, name or label | 80 characters |
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
