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

Pass `centre` to `/api/converge`. `approximate: true` means OneMap could not answer some trips and estimates were used. Say "about" in the UI. The answer also carries `travel` (see [Travel times](#travel-times)).

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
| `weights` | no | Override scoring weights, all 0 or more. Keys: `worst`, `mean`, `returnWorst`, `occasion`, `preference`, `rating`, `weather`, `price`, `cdc`, `antiRepeat`, `crowd`. `crowd` has no weight by default, so it doesn't change the ranking unless you send one. |
| `weatherCase` | no | `clear`, `rain`, `rain_east`: a simulated forecast. Used only when the server allows it; otherwise ignored. See [Weather](#weather). |
| `currentOptionIds` | no | The options the group is already voting on. Each one that passes the hard filters and is within 3 km is always scored, even past the shortlist (a place added by search, or swapped in for rain), and comes back in `current`. A rain swap never suggests one of these. |
| `radiusMeters` | no | The search radius the group chose, 100 to 3000. Only places inside it are suggested or kept in `current`. Without it, the search widens on its own (500 m, 1, 2, then 3 km). Search takes the same limit as `maxKm`. |
| `optedOut`, `overrides`, `excludeVenueIds`, `groupId`, `topN`, `seed`, `travelCeilingMinutes` | no | As in the engine (`backend/src/planner/engine.js`). |

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
| `explanation` | One sentence on why it ranked here. |
| `verify` | Diet needs we only *guessed* from a stall name. Say "check the stall". |
| `dietUnknown` | Diet needs we have *no* data on (lenient mode only). Say "halal status not known". |
| `crowd` | `quiet`, `moderate`, `busy` or `unknown`. Always label it as an estimate ("Busy · est."). |
| `walkMinutes` | Walk from the meeting point (Converge) or the current point (Roam). Same formula as the frontend's `walkMinutes`. |
| `reasons` | Up to two tags, same ones and same order as the frontend: "Indoor" (when it rains), "Easy trip home" (last stop, everyone home within 35 min), "Near MRT", "Quiet at 12:30", "Short walk", "Hidden gem", "Budget friendly". |
| `warnings` | `["rain"]` when rain is likely (risk 0.6 or more) at an open-air or exposed venue. |
| `swap` | With a rain warning: `{ "venueId", "name" }` of an indoor alternative that is not already shown or in `currentOptionIds`, or `null` if none is within 3 km. |
| `approximate` | Travel times are estimates because routing failed. |
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

Find a place by name to add as an option (the frontend's `searchVenuesForSlot`). It matches the venue name, its area, or the name of a stall at a CDC site ("Ming Kee Chicken Rice" finds the hawker centre it is in).

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
| `closed` | Not open for the whole slot. |
| `meal_period` | Doesn't serve that meal. |
| `near_mrt` | Last stop, but too far from an MRT. |
| `diet:halal` etc. | Doesn't meet someone's diet (or no data, in strict mode). |
| `capacity` | Too small for the group. |
| `far` | More than `maxKm` from the meeting point. |
| `closed_for_cleaning` | A hawker centre's NEA cleaning or repair day. |

## Errors

| Status | Body | When |
|---|---|---|
| 400 | `{ "error": "invalid_input", "issues": [ { "path": "occasion", "message": "…" } ] }` | A field is missing or wrong. Every bad field is listed. |
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

## Venues from OneMap

About 460 places come from OneMap's government lists: sport centres, tourist attractions, museums, libraries, theatres, parks and hawker centres (see [external-apis.md](external-apis.md)). They have `source: 'onemap'` and a few extra fields the cards can use:

| Field | What |
|---|---|
| `photoUrl`, `photoCredit` | A real photo (attractions, libraries, hawker centres). Show the credit under it. |
| `address`, `postalCode` | The street address. |
| `description`, `website` | Attractions' text and official links. |
| `openingHoursText` | OneMap's own hours text, e.g. "Daily from 7am – 12pm, and 6pm – 9pm". `openingHours` is the version the planner reads. |
| `kind` | `sports`, `attraction`, `museum`, `library`, `theatre`, `park` or `hawker`. `theatre` is new to the frontend's photo list. |
| `closures` | Hawker centres: NEA cleaning and repair days, `[{ from, to, reason }]`, as `YYYY-MM-DD`. The planner leaves the centre out on those days. |
| `dataQuality` | Which fields are typical values (`hoursAssumed`, `priceAssumed`) rather than real ones. |

## Venues from Google

With `GOOGLE_MAPS_API_KEY` set, `/api/converge` and `/api/roam` add up to 20 of the nearest restaurants, cafés, bars and dessert shops from Google Places, for food and drink slots. They're added for that request only, never saved, because Google's terms don't allow it. Every answer says:

```json
"google": { "source": "google", "added": 16 }
```

| `source` | Meaning |
|---|---|
| `google` | `added` places came from Google (places the venue list already had were skipped) |
| `off` | The server has no Google key |
| `not_needed` | A shop or activity slot: Google isn't used for those |
| `unavailable` | Google couldn't be reached; the answer uses the other venues |

A Google venue has `source: 'google'`, `googlePlaceId`, a real `rating` and `ratingCount`, `address`, and that **day of the week's** `openingHours`. It may also have `photo: { name, credit }`:

- Show the photo with `GET /api/places/photo?name=<photo.name>&maxWidth=400`. It redirects to the image, and the key never reaches the browser. 400 for a bad name; 503 when the server has no Google key or Google is down.
- Show `photo.credit.displayName`, linked to `photo.credit.uri`, with the photo. Google requires it.

The Demo Key returns no photos. A billed key does.

## Travel times

`POST /api/meeting-area`, `POST /api/converge` and `POST /api/roam` answer with a top-level field:

```json
"travel": { "source": "onemap", "routed": 9, "failed": 0 }
```

| `source` | Meaning |
|---|---|
| `onemap` | Real public transport times from OneMap. `routed` trips were answered; `failed` trips fell back to the engine's estimate, and those results are `approximate: true`. |
| `estimate` | The engine's own estimate: the server has no OneMap account yet, or every OneMap call failed. Say "about" in the UI. |

How the OneMap times work (`backend/src/services/onemap.js`, `travel-times.js`):
- The engine runs once to find the trips it needs. Those are fetched from OneMap, 6 at a time, and the engine runs again with the real times.
- A trip under 400 m is walked; no route is asked for.
- The way back is taken to be as long as the way there, so one route serves both. Most members end where they started, so this halves the calls.
- Times are for the start of the slot's hour. Routes are cached for 6 hours, by points rounded to about 110 m.
- The OneMap login token lasts 3 days. The server gets a new one an hour before it runs out.
- With routing on, the meeting area tries the 16 areas nearest the fairest point, unless `maxCandidates` is sent. 16 never missed the best area in 2,000 random groups. `/api/meeting-area` also accepts `dateTime`, for when the group sets off; without it, the server uses the time now.

## GET /api/places/search

`GET /api/places/search?q=520201` → `{ "results": [{ "name", "address", "postal", "lat", "lng" }] }`, at most 10.

For start and end points: an address, postal code or building name, searched with OneMap. It needs no OneMap account. Results are cached for a day. The rate limit applies.

| Status | When |
|---|---|
| 200 | Results, possibly empty. |
| 400 `invalid_input` | `q` is missing, blank, or over 80 characters. |
| 503 `search_unavailable` | OneMap could not be reached, or this server has no address search. Show "search is not available, try again soon". |

## Limits

Every list and number has an upper limit, so one request cannot keep the server busy. Going over any of them is a 400 naming the field.

| Field | Limit |
|---|---|
| `members`, `optedOut`, `overrides` | 30 |
| `groupConstraints` | 10 |
| `currentOptionIds` | 30 (the app shows at most 6 options per slot) |
| `excludeVenueIds` | 200 |
| `categories` | 4 (repeats are removed) |
| `cuisineLikes`, `cuisineDislikes` | 20 each per member |
| any id, name or label | 80 characters |
| any weight | 1000 |
| `budgetMaxPerPerson` | 10000 |
| `max_price_pp:N` | 5 digits |
| `near_mrt:N` | 3 digits |

## Testing from Playwright (stub mode)

Start the backend with `STUB_EXTERNALS=1 pnpm dev:backend`. Then send the `x-jio-scenario` header on `/api/**` requests:

- `rain`: the forecast fixture says heavy thundery showers everywhere, unless the body sends `weatherCase`.
- `routing-fail`: every OneMap route fails, so travel falls back to the estimate (`travel.source: 'estimate'`) and results come back with `approximate: true`.
- No header (`dry`): routes are generated from distance in OneMap's format, so `travel.source` is `onemap`.
