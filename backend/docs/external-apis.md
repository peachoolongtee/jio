# External APIs

Every outside service Jio uses, whether it is built, and how to set it up. All calls go through the backend's HTTP helper (`backend/src/services/http.js`), so keys stay on the server and tests answer from fixtures instead of the network.

| API | Used for | Account or key | Status |
|---|---|---|---|
| **NEA weather** (data.gov.sg) | Live 2-hour forecast: rain warnings, indoor swaps, ranking outdoor places lower in rain | None | ✅ Built (Ian, `services/weather.js`) |
| **OneMap search** | Address, postal code and building search for start and end points | None | ✅ Built |
| **OneMap routing** | Real public transport times, instead of the estimate | Free OneMap account: `ONEMAP_EMAIL`, `ONEMAP_PASSWORD` | ✅ Built, **switched on once the account is in `backend/.env`** |
| **OneMap map tiles** | The map's background | None | ✅ Used by the frontend map |
| **OneMap themes** | 483 more places saved (417 reach the planner): SportSG sport centres, tourist attractions, museums, libraries, theatres, parks, hawker centres | OneMap account (only to take the snapshot) | ✅ Built (`feature/onemap-places`) |
| **Google Places (New)** | Restaurants, cafés, bars, dessert shops, shopping malls and private activities (bowling, cinemas, karaoke, arcades, galleries, zoo, aquarium) near the meeting point, with ratings, price level, opening hours per day, and photos | `GOOGLE_MAPS_API_KEY` (Demo Key to try; a billed key with a quota cap for the final app) | ✅ Built (`feature/google-places`) |
| TikTok oEmbed | "Save from a TikTok link": the caption, to find the place | None | ⬜ Next |
| Google Maps share links | "Save from a Maps link": the place name and point from the link | None (not an API) | ⬜ Next |
| **NEA hawker centre closures** (data.gov.sg dataset) | Don't suggest a hawker centre on its cleaning or repair days | None | ✅ Built (`feature/onemap-places`) |
| LTA DataMall | MRT station crowd levels | Free key, by request | ⏸ On hold (team decision) |
| Instagram oEmbed | — | — | ❌ Dropped: only posts whose owners allow it can be read |

## Built

### NEA 2-hour forecast

Built by Ian in `backend/src/services/weather.js` and `backend/src/planner/live-weather.js`. The full behaviour is in [planner-api.md, Weather](planner-api.md#weather). In short:

- **Call:** `GET https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast`. Cached 5 minutes; NEA issues one every 30 minutes.
- **Get → merge → massage → show:**
  - **get** the forecast for 47 areas
  - **merge** each venue with its nearest area
  - **massage** the forecast sentence into a rain risk from 0 to 1, which feeds the weather score, rain warnings and the indoor swap
  - **show** `weather: { source, validUntil }` in every Converge and Roam answer
- **`source`:**
  - `live`: the forecast was used
  - `simulated`: the demo rain switch, only when `ALLOW_SIMULATED_WEATHER=1` or in stub mode
  - `unavailable`: NEA could not be reached; the planner plans as if clear and still answers
- **Settled 11 Oct 2026 (ticket #108):** the 2-hour forecast is used only for a stop starting within 2 hours of now. Later stops use the regional forecast below, or no weather. See [planner-api.md, Weather](planner-api.md#which-forecast-by-how-far-away-the-stop-is).

### NEA 24-hour (regional) forecast

Added 11 Oct 2026 (ticket #108; research in ticket #115). Code: `parseTwentyFourHourForecast` and `createWeather().regionalForecast()` in `backend/src/services/weather.js`, the region table in `backend/src/services/weather-regions.js`, and the choice of forecast in `backend/src/planner/weather-window.js`.

- **Call:** `GET https://api-open.data.gov.sg/v2/real-time/api/twenty-four-hr-forecast`. No key. Without a key data.gov.sg allows 6 calls per 10 seconds (12 with a development key, 30 with a production key), possibly shared with the two-hour call; over it, 429. Optional query `date` is not used.
- **Shape (read by key; key order differs between calls):** `{ code, data: { records: [{ date, timestamp, updatedTimestamp, general, periods }] }, errorMsg }`. A period has `timePeriod { start, end, text }` and `regions`: `west`, `east`, `central`, `south`, `north`, each `{ code, text }`. Times carry `+08:00`. The specification's examples show `Z` and an `area_metadata` the live answer does not have.
- **Periods and reach:** three or four periods (6 am to noon, noon to 6 pm, 6 pm to 6 am, split at midnight when the window starts there). Issued about 05:30, 11:30, 17:30 and 23:30, with reissues in between that keep the same window. The last period ends 18 hours 20 minutes ahead (just before an issue) to 24 hours 25 minutes ahead (just after). A stop up to 18 hours away is always covered. The server checks each period's end: an answer whose last period has ended covers nothing and counts as unavailable.
- **Regions:** NEA publishes no mapping from the 47 two-hour areas to the five regions. The table in `weather-regions.js` is the researched one: 31 areas from NEA's regions for air quality reporting, 14 by nearest region label point, 2 by neighbouring towns (Novena is the weakest call). An area missing from the table takes the nearest region by label point and is logged once.
- **Limits and cache:** cached 10 minutes, one shared in-flight request, a failure remembered 30 seconds, the HTTP helper's 10-second timeout. A failure is logged at most once a minute. A stop more than 25 hours away fetches nothing.
- **Stub mode:** `fixtures/datagov/twenty-four-hr-forecast.dry.json` and `.rain.json`, moved in time on each call to cover the next 18 to 24 hours (`shiftTwentyFourHourForecast` in `stubs.js`).
- **Licence and attribution (Singapore Open Data Licence, version 1.0).** The licence requires a conspicuous notice naming the source and linking to the licence. Its example wording is: "Contains information from {name of dataset} accessed on {date of access of dataset} from {source of data} which is made available under the terms of the Singapore Open Data Licence version 1.0 {URL link to licence}". For the weather this reads: "Contains information from 24-hour Weather Forecast and 2-hour Weather Forecast accessed on {date} from data.gov.sg which is made available under the terms of the Singapore Open Data Licence version 1.0 https://data.gov.sg/open-data-licence". **The screens must show it wherever a forecast is shown** (the muted source line under the itinerary's stops and under the Vote list): a short form in the line itself ("NEA forecast, 2:10 pm") with the full notice one tap away, or on the page that carries the line, with the date of access taken from `weather.issuedAt`. The API sends no notice itself. This applies to the two-hour forecast too, which has had no notice on any screen so far.

### OneMap search

- **Call:** `GET https://www.onemap.gov.sg/api/common/elastic/search?searchVal=…&returnGeom=Y&getAddrDetails=Y&pageNum=1`. Docs: [OneMap API](https://www.onemap.gov.sg/apidocs/).
- **Code:** `backend/src/services/onemap.js` → `GET /api/places/search?q=…`. Cached a day.
- **No account needed** (checked live on 9 Oct 2026: "Bishan MRT" and "520201" both answer).
- **It draws from the same call budget as routing** (see [Keeping the shared account safe](#keeping-the-shared-account-safe)). When the budget for the minute is used up, the route answers `503 search_unavailable` with a `Retry-After` header in whole seconds.
- **`q` is checked first:** missing, empty, an array (`?q=a&q=b`) or over 80 characters is `400 invalid_input` with an issue on `q`, and costs no OneMap call.

### OneMap routing

- **Calls:**
  - `POST /api/auth/post/getToken` with the account. The token lasts 3 days; the server gets a new one an hour before it runs out.
  - `GET /api/public/routingsvc/route?start=…&end=…&routeType=pt&date=MM-DD-YYYY&time=HH:00:00&mode=TRANSIT&maxWalkDistance=1000&numItineraries=1`
- **Code:**
  - `backend/src/services/onemap.js`: the token, routes and the cache.
  - `backend/src/services/travel-times.js`: feeds the routes to the engine.
- **How the synchronous engine gets async routes:**
  1. A dry run records every trip the engine needs, grouped by candidate (one venue, or one candidate meeting area, with every member's trips to it).
  2. Whole candidates are chosen, in the engine's own priority order, until the next one would pass the cap (below). Their trips are fetched, 6 at a time.
  3. The real run reads them.

  A trip OneMap can't answer, and every trip of a candidate that was not routed, keeps the estimate and is marked `approximate`. With the table of real times between the areas (see below) the fallback is the table's time, labelled `travelSource: 'table'` and not `approximate`; only a trip the table has no pair for is the straight line.
- **Fewer calls:**
  - Trips under 400 m are walked, with no call.
  - The way back reuses the way there.
  - Routes are cached 6 hours, by points rounded to about 110 m and the hour. A failed answer is never cached.
  - The meeting area tries 16 areas, not 37, and gives real routes to the best 5 of them by estimate. **With the table (the normal case) it ranks all 16 on table times with no call and routes only the best 2, plus up to two more rounds for any area a live time lifts into them (named areas last); places rank on the table too and only the best 3 are routed** (planner-api.md, "Table mode").
- **Without an account:** routing stays off and travel is the estimate (`travel.source: 'estimate'`). The server prints this at startup.

### Keeping the shared account safe

The OneMap account is shared by the whole server and allows 300 calls a minute in total. Nothing a caller sends may be able to spend more than the account allows, so there are three layers.

1. **A cap on one request.** In table mode (the planner has `area-times.json`) a request routes only what it shows first, typically 6 to 10 trips, and the cap below still holds for it. `MAX_ROUTED_TRIPS_PER_REQUEST = 60` (`services/travel-times.js`). Candidates are routed whole, in priority order, until the next one would pass the cap: a venue is either real for every member or an estimate for every member. Trips answered from the cache and trips under 400 m make no call and do not count. The venues in `currentOptionIds` count like any other venue. For `/api/meeting-area` the areas are first ordered by their estimated result and only the best 5 are routed; if even one area would pass the cap, nothing is routed and the answer is an estimate with `approximate: true`. One request also waits at most 3 seconds for OneMap in total (`ROUTING_DEADLINE_MS`, an environment setting: whole milliseconds from 1000 to 15000, blank means 3000, anything else stops the server starting); trips not answered by then keep the estimate and are `approximate`, and an answer that arrives later changes nothing. A request that sends `travel: 'estimate'` (sample data) makes no OneMap call at all.
2. **One budget for the process** (`services/budget.js`, owned by `services/onemap.js`). Routing, address search and login all draw from it:
   - at most 6 calls in flight at once, across all requests;
   - a token bucket of `ONEMAP_CALLS_PER_MINUTE` calls a minute (default 240, leaving headroom under 300). It starts full and refills evenly.
   - A routing trip that finds the bucket empty does not wait: it keeps the estimate at once and the result is `approximate`. An address search answers `503 search_unavailable` with `Retry-After`.
   - Stub mode runs the same code with a very large budget, so tests do not hit it.
   - Searching one different postal code after another spends one call each (`POST /api/search` looks the building up to find saved places near it, and `GET /api/places/search` asks for the address). 240 different postal codes in one minute use up the budget; routing then falls back to the estimate and address search answers 503 with `Retry-After`. The planner rate limit (per caller) is the only brake on that; no extra limiter was added for it.
3. **A failing OneMap is left alone.**
   - **Rejected token (401):** the token is dropped, the server logs in once (requests that arrive meanwhile share that login), and the call is retried once. If the new token is rejected too, no login is tried for 60 seconds.
   - **Failed login:** not tried again for 60 seconds. Meanwhile routing keeps the estimate and no login is attempted. If a renewal fails while the old token has not expired, the old token is kept.
   - **No usable `expiry_timestamp`** in the login answer: the token is trusted for one hour and the server logs a warning once, rather than logging in for every trip.
   - **Circuit breaker:** after 5 failed route calls in a row, no route call is made for 30 seconds. An answer about one trip (HTTP 400, 404 or 422) does not count. The breaker is kept per stub scenario, so a `routing-fail` test cannot pause the next `dry` one; outside stub mode there is one.

**What the log says.** When routing falls back for a reason other than "no account", the server prints one `console.warn` line naming the reason (`budget_empty`, `login_failed`, `circuit_open`, `deadline` or `upstream_error`), at most once a minute per reason. Neither the email, the password nor a token is ever logged, put in an error message or sent in a response.

**At start-up** (`index.js`):
- The example values from `.env.example` count as not set, so a fresh copy of that file starts with routing off.
- With only one of `ONEMAP_EMAIL` and `ONEMAP_PASSWORD` holding a real value, or with `ONEMAP_CALLS_PER_MINUTE` not a whole number above 0, the server prints which variables are wrong and exits with code 1. It never prints their values.
- With neither account variable set, routing is off and the server says so.
- With both set, the server tries one login in the background and prints one line saying whether routing is on. It does not wait for it, and it keeps running if OneMap is down.

### OneMap themes and hawker closures (a snapshot, not a call per request)

- **What:** OneMap's government place lists, converted into venues by `backend/src/planner/onemap-adapter.js`:

  | Theme | Becomes | Saved | In the planner's pool |
  |---|---|---|---|
  | SportSG sport facilities | activity, `sports` | 45 | 44 |
  | Tourist attractions | activity, `attraction` (with **real opening hours** for 61, and photos) | 107 | 97 |
  | Museums | activity, `museum` | 11 | 4 |
  | Libraries | activity, `library` (with photos) | 28 | 25 |
  | Theatres | activity, `theatre` | 36 | 18 |
  | Parks | activity, `park`: real parks, gardens and nature areas only (playgrounds, fitness corners, open spaces, car parks left out) | 134 of 462 | 118 |
  | Hawker centres | food, `hawker` (photos, number of stalls): open ones only | 122 of 129 | 111 |
  | **Total** | | **483** | **417** |

  The pool is smaller than the file for three reasons, all done when the planner loads the file (`loadPlanData`), so the saved file keeps every place: **30 set aside** because a group cannot go there (18 theatre rooms, 10 interim parks, the islets Pulau Sekudu and Pulau Unum, and the 2 places that take visits by appointment only), **16 duplicates** (the same place listed under two themes, one row kept), and **20 already in a hand-made list** (e.g. Tiong Bahru Market, and now Chinatown Complex and Kovan 209). 30 + 16 + 20 + 417 = 483. `_meta.sources` has each count and `_meta.onemapExcluded` lists the 30 with the reason.

  Monuments and community clubs are left out on purpose: they're buildings to look at, or classes, rather than outings. Each is one line in `THEMES` if the team wants them.
- **Closures:** NEA's "Dates of Hawker Centres Closure" (data.gov.sg, no key) lists each centre's quarterly cleaning days and longer repairs. `backend/src/planner/hawker-closures.js` attaches them to the centre and its large CDC site, and the filters leave the centre out on those days (reason `closed_for_cleaning`). **A venue takes the dates of one row, never a union of its neighbours':** a OneMap hawker centre takes the row with its own name (whole, without the bracket, or the bracket alone) or the same spot (within 10 m); one that NEA words differently ("The Hawker Centre @ Our Tampines Hub") takes the nearest unclaimed row within 100 m with a similar name; any other hawker venue (curated, a large CDC site) takes the nearest row within 100 m, or within 150 m when the names are alike. The venue says which row in `closuresFrom`. One row of the 123 matches no venue: **Bukit Timah Market**. Its coordinates (1.3396, 103.7758) are 2.9 km from the nearest hawker centre OneMap lists, and OneMap's hawker theme has no centre by that name (the saved file does not keep the 7 rows the build left out, so we cannot tell whether OneMap lists it as not yet open or not at all). The planner reports it in `_meta.closures.rowsWithoutVenue`. Rows with a blank, non-numeric or out-of-Singapore location are dropped by the build, which prints how many.
- **The dates run out.** Every cleaning date in the snapshot of 9 October 2026 ends by 30 December 2026. After that every centre looks open on its cleaning days, with nothing in an answer to say so. `loadPlanData` works out the range (`_meta.closures`: `from`, `to`, `lastCleaning`, `rows`, `periods`, `stale`) and logs one warning when today (Singapore) is past `lastCleaning` or within 30 days of it, naming the rebuild command. Rebuild when NEA publishes the next year's dates.
- **Snapshot:** `pnpm --filter jio-backend build:onemap-places` (needs the OneMap account) writes `backend/src/db/mock/onemap-places.json`. These lists change a few times a year, so calling OneMap per request would only spend its rate limit. Re-run it when the lists or the next year's closure dates change, and commit the file. It writes the places in a fixed order (theme, then id), prints how many closure rows it dropped, **refuses to overwrite the file** when a theme or the closure dates come back empty, and when the OneMap login fails prints one line and exits 1. `loadPlanData` logs a warning when the file is missing.
- **Repair, with no network:** `pnpm --filter jio-backend repair:onemap-places` (`node scripts/build-onemap-places.js --repair`) reads the saved file, applies the adapter's current text, link and address fixes to the saved places, and writes it back, changing nothing else (not `fetchedAt`, not the order, not the closure dates). Running it twice changes nothing the second time. It never reads `.env`. It was run once on the 9 October snapshot: 251 of 483 places changed: 91 photo links given their `https://` and 1 root-relative link dropped (with its credit), 14 addresses and 15 postal codes fixed, 150 descriptions that were programme or branch codes dropped (122 hawker, 28 library), 7 descriptions de-garbled (3 lost apostrophes restored), 4 names, 1 credit and 2 hours texts de-garbled or cleaned. **What cannot be repaired from the saved value:** a theatre address that is only a house number ("1, Singapore 038981": the theatre theme gives a house number and, for 10 of its 36 rows, the street in the description field, which the saved file keeps as `description`), and any character OneMap lost entirely other than an apostrophe.
- **Text copied from OneMap is cleaned** (`fixText`, `freeText`, `https`, `addressOf` in the adapter). Garbled characters ("Â®", "â„¢", "â€“") are fixed by **a real re-decode** (the characters are turned back into the bytes they were and decoded as UTF-8) rather than by a list of patterns: a list covers only the symbols somebody has already met, the re-decode covers every accent and symbol, and it fails safe, because a run that is not valid UTF-8 is left exactly as it was. HTML tags are removed, `https://` is added to a link that starts with a host name, a root-relative or otherwise unusable link becomes `null` (and its photo credit with it), a postal code of `0` is dropped and a five-digit one gets its leading zero, email addresses and phone numbers are removed with the sentence that offers them, and a description that is only a programme or branch code ("HUP Rebuilding", "NAS") is dropped.
- **Merging** (`backend/src/db/venues.js`):
  - A place the hand-made lists already have (e.g. Tiong Bahru Market) is skipped: 20 skipped. A hawker centre is compared by the name in its bracket too, so curated "Chinatown Complex Food Centre" is OneMap's "Smith Street Blk 335 (Chinatown Complex Market)".
  - **The same place listed twice by OneMap** (`dedupeOneMapVenues`): same category, and either different themes within 100 m with half their words alike, or within 250 m with three quarters alike; chained, so "Esplanade Theatre" (two themes) and "Esplanade Theatres on the Bay" are one group. The kept row has real opening hours, else a photo, and keeps its own id. Hawker centres are never merged with each other (neighbouring blocks are separate centres), and neither are two rows of one theme unless nearly identical ("Central Library" and "Central Arts Library" stay separate listings). 16 rows were dropped this way.
  - OneMap's hawker centres replace their CDC copies, the same way the frontend's do. **Every OneMap row of kind hawker is a centre,** whatever its name ("Bedok North Street 1 Blk 216" has neither "market" nor "food centre"). The CDC site it replaces is the one with its postal code, else a large site, else the nearest (it used to be the first one in the file within 150 m, which was the neighbouring block's site for 25 of the 122 centres). The centre keeps what the site knew: the better diet level for each need (halal and vegetarian "likely" from stall names, so a strict halal group still sees it), the stalls (so searching a stall's name finds the centre), and `siteKind`. 111 CDC sites were replaced by OneMap centres, and 8 by the frontend's.
  - A hawker centre named by street and block shows the name in its bracket ("Redhill Market"); the NEA name is kept as `officialName`. "Maxwell Food Centre (Kim Hua Market)" and "Amoy Street Food Centre (Telok Ayer Food Centre)" keep their names: there the bracket is only an alias.
- **Left out of the pool:** theatres that are community club or centre halls, mini theatre rooms, school, college or polytechnic halls (`illuminITE`, `ITE`, `UCC`, `ACSB`, polytechnics), auditoriums, amphitheatres or studio rooms; parks named "Interim Park"; the islets Pulau Sekudu and Pulau Unum; and places whose hours text says visits are **by appointment only** (Maghain Aboth Synagogue, NUS Baba House). The public theatres stay.
- **Weekday opening hours:** Google Places supplies hours per weekday, and the adapter chooses the requested date's weekday. For OneMap and CDC data, the source usually supplies one general opening range rather than a weekly schedule; the builder also recognizes explicit weekday closures such as "Closed on Monday". Public holidays and weekly hour-by-hour schedules for those local datasets are not available. All weekday decisions use the calendar date in `dateTime` without applying a time zone.
- **What's a guess:** OneMap gives no price, rating or diet, and most themes give no hours. Those are typical values for the kind of place, labelled in `dataQuality` (`hoursAssumed`, `priceAssumed`…). Tourist attractions with hours in OneMap use those, and keep the original text in `openingHoursText`. **A guessed price is not shown as a fact:** any venue with `priceAssumed` (OneMap, Google and CDC alike, by the lead's decision of 11 October 2026) gets no "Budget friendly" tag and no "within budget" sentence. The `max_price_pp` filter and the price part of the score still use the typical price, as before.
- **Credit (required wherever this data is shown):** the Singapore Open Data Licence asks for an attribution. Use this wording, with the access date from `_meta.onemap.fetchedAt` (it is in `data._meta.onemap.attribution` ready to show): *"Contains information from OneMap themes, Singapore Land Authority, and from "Dates of Hawker Centres Closure", National Environment Agency, accessed 2026-10-09 from OneMap and data.gov.sg, made available under the terms of the Singapore Open Data Licence version 1.0 (https://data.gov.sg/open-data-licence)."* Tourist attraction photos carry their own `photoCredit`, which is shown under the photo.

### Saved OneMap data and its terms

Two files in the repository hold data taken from OneMap and saved: `backend/src/db/mock/area-times.json` (public transport minutes between the 37 meeting areas, from OneMap's routing service, accessed 21 October 2026, `pnpm build:area-times`) and `backend/src/db/mock/onemap-places.json` (the government place lists from OneMap's themes, accessed 9 October 2026, `pnpm build:onemap-places`). **This records what the terms say and what the project does. It does not decide whether saving the data is allowed; that is open and is the lead's.**

**What the terms say.** Read on 21 October 2026 by the lead's agent, at https://www.onemap.gov.sg/legal/termsofuse.html:

- Clause 3(a) licenses SLA Data (the Singapore Land Authority's data) "for any usage", and the licence can be revoked.
- Clause 3(b)(i) prohibits storing, downloading, archiving or combining SLA Data "except as expressly permitted in Clause 3(a)". "SLA Data" includes data compilations, so a saved table of times or a saved list of places may count. Whether 3(a)'s "any usage" expressly permits saving is the open question.
- Clause 6(c) requires destroying all copies of the data when the licence ends.
- Clause 3(b)(ii) forbids removing SLA's notices or logos.
- The Singapore Open Data Licence (the one the weather and hawker closure data are under) does not clearly cover OneMap's data. The credit for the saved places names it; that wording is right for NEA's closure dates, and is not a statement that OneMap's data is under that licence.
- The OneMap Developer Agreement, which governs the account and its API, was **not read**.

**The conditions the project keeps, until the question is settled:**

1. **Non-commercial.** Jio is a graded student project. If it were ever to earn money or be offered to the public, this has to be looked at again first.
2. **The repository stays private.** The files are not published. (CLAUDE.md already asks for this for another reason, an old database password in the history.)
3. **A credit with the access date wherever the data is shown or used.** `area-times.json` carries it in `_meta.credit` (names OneMap and the Singapore Land Authority, links https://www.onemap.gov.sg, says "accessed 2026-10-21"). `onemap-places.json` carries its access date in `_meta.fetchedAt`, and `data._meta.onemap.attribution` has the wording to show (see "OneMap themes and hawker closures"). Do not strip either.
4. **A derived summary, not raw responses.** `area-times.json` holds minutes for each pair of areas, not OneMap's routes, steps, geometry or any response body. `onemap-places.json` holds the fields the planner uses from each place, converted by the adapter. Nothing else from OneMap is written to a file; tests use invented fixtures.
5. **Deletion if OneMap asks or the licence ends.** Both files are deleted, and the code falls back: without `area-times.json` the planner uses the straight-line estimate (the start-up line says "Area travel times are OFF"); without `onemap-places.json` it uses the hand-made, CDC and Google venues (`loadPlanData` logs a warning). The tests that expect the saved files (for example, that `area-times.json` covers every pair of areas) would need changing with them. Clause 6(c) means every copy, including old commits on any machine that has cloned the repository.

A change to any of these (a public repository, a deployed demo that serves the data, a commercial use) should go to the lead before it happens.

### Google Places (New)

- **Calls:**
  - `POST https://places.googleapis.com/v1/places:searchNearby`: one per Converge or Roam request, at most.
  - `GET https://places.googleapis.com/v1/places/{id}`: Place Details, for a Google place the group already has as an option and the ranking does not have. At most 3 per Converge or Roam request, 2 at a time (see "Google search by name, and looking a place up by id").
  - `POST https://places.googleapis.com/v1/places:searchText`: one per search by name.
  - `GET https://places.googleapis.com/v1/{photo name}/media`: one per photo shown.

  Docs: [Nearby Search (New)](https://developers.google.com/maps/documentation/places/web-service/nearby-search).
- **Code:**
  - `backend/src/services/google-places.js`: the calls, the field list, the cache, the call budget and the circuit.
  - `backend/src/planner/google-adapter.js`: turns a Google place into a venue.
  - `backend/src/routes/plan.js`: adds the places to a request, and serves the photo route.
- **Get → merge → massage → show:**
  - **get** up to 20 of the **nearest** restaurants, cafés, bars and dessert shops (food and drink slots) shopping malls (shop slots), or bowling, cinemas, karaoke, arcades, amusement centres, galleries, the zoo and aquarium (activity slots) within 1 km of the point the request ranks around
  - **merge** them with the venue list, skipping places it already has
  - **massage**: place each in its NEA forecast area, read that **day of the week's** opening hours (a place shut on Mondays is left out on a Monday), turn the price level into a typical price
  - **show** them ranked with everything else
- **Why per request, not a snapshot:** Google's terms allow storing a place's id, not its details. So these are never saved to a file, only cached in memory for 10 minutes.
- **Shops:** shop slots ask for `shopping_mall` only. `department_store` and `market` brought back single jewellery shops and grocers. A mall needs 50+ reviews, and names like "(No longer in operation)" are dropped. Checked live near Newton: Scotts Square, Far East Plaza, Pacific Plaza and COMO Orchard, and at 08:44 the malls that open at 8am (before, the 15 hand-listed malls were all still closed).
- **Activities:** activity slots ask for `bowling_alley`, `movie_theater`, `karaoke`, `video_arcade`, `amusement_center`, `amusement_park`, `art_gallery`, `aquarium` and `zoo`: the private places OneMap's government lists don't have. Filters:
  - at least 30 reviews
  - no advert-style names (over 60 characters, or two or more slashes)
  - no lessons (academy, school, tuition, coaching, enrichment, classes)

  Checked live: near Bishan, Golden Village Bishan; near Newton, The FRIENDS™ Experience and Fever Exhibition Hall. The filters removed a watch-film shop listed as an "art gallery" and a sports academy.
- **Why "nearest first":** the planner looks within 500 m first and only widens when it has fewer than 3 options. Google's default ("most popular") returned places 300–800 m away, which the planner never reached. Checked live near Bishan: with "nearest", Din Tai Fung, Pepper Grill, Stuff'd and Shake Shack at Junction 8 made the top 6.
- **Cost control:**
  - One nearby search per slot at most, cached by points about 110 m apart. Look-ups by id and searches by name have their own limits below.
  - **One budget for every Google call**, searches, look-ups and photos together: `GOOGLE_CALLS_PER_MINUTE` (default 60; invalid or blank means 60), at most 4 in flight (same mechanism as OneMap's, `services/budget.js`). A call over the budget makes no request: the planner answers with `google.source: 'unavailable'` and the photo route answers 503.
  - The search radius is rounded up to the planner's steps (500, 1000, 2000, 3000 m) before it is sent and cached, so changing `radiusMeters` by a metre does not make a new billed search. A photo's width is rounded up to 200, 400, 800 or 1600.
  - Only the fields Jio uses (`NEARBY_FIELDS`): each extra field can move the request to a dearer tier. The current list includes rating, review count, opening hours and price level, which is likely the dearer tier (see "Decisions for the lead" below).
  - A daily quota on the key is the real safety net.
- **Failure handling:**
  - A Google call times out after **3 seconds** (the HTTP helper takes a `timeoutMs` per call; the default for the other services stays 10 s).
  - **Circuit:** 3 failures in a row (timeout, network error, 4xx, 5xx, or an answer that cannot be read) pause Google for 60 seconds: no request is made and the answer is `unavailable` at once. After that one call is tried; one success closes the circuit. A photo Google says does not exist (404 or 400) is not a failure, and nor is a place look-up that answers 404. A look-up that answers 400 is a failure (a 400 can mean a bad key or field mask). A call that queued for a slot for a second or more is not started when the last completed call failed: it is refused with the reason `waited_too_long` (logged with its own text), so a hung Google does not give every queued call a timeout of its own, and a link-reader lane gets its charge back for it.
  - **What Google can add to one ranking waits at most one call timeout plus 250 ms (3.25 seconds)**: the nearby search and the look-ups run together under one deadline. Past it, the ranking goes on without them: `google.source` is `unavailable` if the nearby search was not back, and the look-ups not back are listed in `google.missing`. The calls themselves end at their own 3 s timeout.
  - A failure is logged at most once a minute per reason, never with the key.
  - An answer whose `places` is not a list is a failure and is not cached. A place that is not an object, has no string id or no numeric location, or cannot be converted is skipped.
- **What's a guess:**
  - Diet and access are unknown.
  - The "quiet / romantic / lively" attributes are defaults for the kind of place.
  - The price is a typical amount for Google's level ($10 inexpensive, $25 moderate, $50 expensive, $90 very expensive).

  `dataQuality` labels each.
- **Photos:** a Google venue has `photo: { name, credit, credits }`. The browser loads `GET /api/places/photo?name=<photo.name>&maxWidth=400`, which redirects to Google's image link. The key stays on the server.
  - `maxWidth` becomes 200, 400, 800 or 1600. Each id in the name is 1 to 300 characters (else 400).
  - The redirect (302, `Cache-Control: public, max-age=1800`) goes only to an `https` address on `googleusercontent.com`, `ggpht.com` or a subdomain; any other link from Google is a 502 `photos_unavailable` and is not cached.
  - Google 404 or 400 for a photo: 404 `not_found`, remembered for 5 minutes. Any other failure: 503 `photos_unavailable`.
  - **Attribution:** Google requires attribution for all Google content shown to a user, not only photos: say that places, ratings and hours come from Google. A photo needs every author in `photo.credits` (`displayName`, linked to `uri`). `photo.credit` is only the first author, kept for older code.
- **Every answer says** `google: { source, added, missing? }`:
  - `google`: places were added
  - `off`: no key
  - `not_needed`: the request asked for no category Google is used for (on `POST /api/search`: the words are shorter than 3 characters)
  - `unavailable`: Google failed, its call budget is used up, or it is paused; the planner answers with its other venues
  - `missing` (Converge and Roam, only when Google is on and only when not empty): the option ids `google_...` in `currentOptionIds` that could not be looked up this time. The place may be gone from Google (404), the look-up may have failed, been over the request's limit of 3, or been too slow; the id may not be a Google place id; or the place is not an outing (a bank). The screen can word each option as "can't be checked right now".

- **Test data:** `backend/tests/fixtures/google/places-nearby.json` is **invented** (ids like `stub_place_01`, made-up names, addresses, ratings and hours), not a recording. Google's terms allow storing only a place id, so no real place's details are kept in the repo.

#### Decisions for the lead (open, not settled)

- **Billing tier.** The nearby search's field mask asks for rating, review count, opening hours and price level. That is likely the dearer billing tier, but it is not confirmed: check Google's pricing page for Places API (New) Nearby Search. Dropping those fields would make the call cheaper and lose the ratings and hours the planner scores on.
- **Terms and the map.** Google's terms restrict showing Places content alongside a non-Google map, and Jio's map is OneMap. Whether the current use is allowed has not been checked against the current terms.

What the browser keeps. When a Google place is added as an option, the frontend keeps the whole venue object the backend sent, not only its id: `frontend/src/lib/api.js` stores every venue of a ranking in `db.venues`, and the demo's save in the browser's local storage holds it. So that place's name, address, photo name and photo credit stay in the browser after the page closes. Google's terms allow keeping a place id, not its details. The backend never writes them to a file, but the frontend does. Keeping only `googlePlaceId` and asking again when a screen needs the place would match what the terms allow. This was not changed because it is in `frontend/`.

Where Google content could show beside the OneMap map. No screen shows Google's photo, rating or credit yet, but a Google place already reaches several screens once a key is set, next to the OneMap map: the Vote page's option cards, its search rows and its map pins; the itinerary's stops and their pins; and the location sheet's rows (`GET /api/places/search`). Google's terms restrict showing Places content beside a map that is not Google's, so whether the app shows Google places at all is the lead's decision and is still open. There is no switch for only the search routes: with `GOOGLE_MAPS_API_KEY` unset every answer is as it was before Google.

### Google search by name, and looking a place up by id

- **Text Search (New)** (`places:searchText`) finds places by name, address or postal code. At most 10 places, cached 10 minutes. Two routes use it, with different field masks (the mask is part of the cache key):
  - the Vote page's "Search" (`POST /api/search`), for words of 3 or more characters, near the meeting point. It asks for the full field list (`NEARBY_FIELDS`), because the places are scored and checked against opening hours;
  - the location search for start and end points and meeting spots (`GET /api/places/search`), only when OneMap found nothing, the words have a letter in them and are at least 4 characters after trimming (a pasted postal code, and each prefix of what a person is typing, are OneMap's). It asks for a name, an address and a point only (`PLACE_SEARCH_FIELDS`: `places.id`, `places.displayName`, `places.location`, `places.formattedAddress`), with a bias circle of 25 km around the middle of the island. A place Google sends with no name, a name of only digits, or a point outside the URA no-sea Singapore planning-area polygons is dropped.
- **Place Details (New)** (`places/{id}`) looks up one Google place the group added from a search, so the planner can rank it: it is not among the 20 nearest. It uses the full field list. Only the place id is ever kept, which Google's terms allow. Per ranking:
  - a place looked up in the last 10 minutes costs nothing; a place Google answered 404 for in the last 5 minutes costs nothing (so an invented id is paid for once);
  - of the others, at most 3 are looked up, at most 2 at a time; the rest are `google.missing` this time. Only the first 6 Google ids of `currentOptionIds` are read (`MAX.googleOptions`);
  - an id that is not a Google place id (letters, digits, `_` and `-`, 1 to 300 characters) is never sent.
- Searches and look-ups use the same per-minute budget (`GOOGLE_CALLS_PER_MINUTE`), the same 3 s timeout and the same pause after repeated failures. Stub mode answers from `tests/fixtures/google/places-text-search.json` (invented places) and the nearby fixture.
- **A searched place that is not an outing.** A place found by name that has no food, drink or shop type is offered as an activity only when Google types it as an outing (`OUTING_TYPES` in `planner/google-adapter.js`: attractions and culture, parks and nature, sports and recreation, entertainment). Otherwise it comes back in `POST /api/search` with `fits: false` and `unfit[0] = 'not_an_outing'` (a bank, a clinic, a school, a petrol station), and a ranking will not take it as an option. A tuition centre or an advert for a name, which the nearby search leaves out, is marked the same way when searched.
- **Limits worth knowing.** A different invented id costs one paid look-up until it is remembered, so a caller sending fresh invented ids can still spend the budget at 3 look-ups a request; the planner rate limit is what bounds that. Different postal-code searches each spend a OneMap call (the postal match in `POST /api/search`): 240 different ones in a minute use up the shared OneMap budget, and the location search and routing then answer from the estimate or with 503 until it refills. No new limiter was added.

### Google reviews (not built: feasibility, checked 10 Oct 2026)

- **Demo Key:** Place Details returns the rating and review count, but **no review texts** (0 returned), the same as photos. It does return `googleMapsLinks.reviewsUri`, a link to the place's reviews on Google Maps, which works now.
- **Normal key:** Place Details (New) with the `reviews` field gives up to **5** reviews per place: Google's "most relevant", not chosen or sorted by us. Each has a rating, text, author (`authorAttribution`) and age ("2 weeks ago").
- **How it would work:** fetched only when someone opens a place's details (one Place Details request per opened place, cached briefly), never for every option on a list.
- **Cost:** `reviews` is in Google's premium (Atmosphere) tier, so check the free amount on Google's pricing page and keep the daily quota on the key.
- **Terms:** don't save reviews; show each review's author and that it comes from Google.
- **Frontend:** the place detail screen already shows mock reviews (`frontend/src/lib/mock/reviews.js`), so real ones would replace those.

### Gemini or Claude, for the AI itinerary order

- **What:** when the group confirms a plan, the AI picks the nicest order of the drink, shop and activity stops; food stays at meal times. See `POST /api/itinerary/arrange` in `planner-api.md`.
- **Safe by design:** the backend lists only the orders that keep every place open and every meal on time, and the AI chooses one of those. It cannot invent an order or a place. Its answer is checked before it is used.
- **Which AI:** Gemini when `GEMINI_API_KEY` is set (Google AI Studio, free tier), else Claude when `ANTHROPIC_API_KEY` is set. One short request each time the Confirm dialog opens with a plan not asked in the last 10 minutes (about 6 orders of 4 stops in, one sentence out).
- **Cost and time are bounded** (`services/itinerary-ai.js`, the same way as Google Places): one budget of `ITINERARY_AI_CALLS_PER_MINUTE` calls a minute (default 20; an invalid value means 20 and a warning at start-up) and at most 2 at once; three failures in a row pause the AI for 60 seconds, then one call is tried and a success closes it; an answer is kept for 10 minutes (at most 500, by a hash of the provider, model, system prompt and prompt); one choice takes at most 8 seconds for either provider. Over budget, paused, slow or failed: the rules answer at once and the request never fails. A failure is logged at most once a minute per reason, with a fixed sentence and a status or error name, never an error message (undici puts a bad header value into its message). Still set a spend limit in the Anthropic console, and a quota on the Gemini key.
- **Keys:** trimmed; blank is not set; a value with a space, a control character or a character outside printable ASCII is not set either, and the server warns at start-up naming the variable and never printing the value.
- **What is sent:** venue names and kinds, indoor or outdoor, times, minutes of travel, and the weather. Nothing about the people.
- **Gemini:** `generateContent` on `generativelanguage.googleapis.com`, model `gemini-3.8-flash` unless `GEMINI_MODEL` says otherwise, through `services/http.js` (8 s timeout, the whole choice's deadline; `maxOutputTokens` 512, as thinking tokens count against it). The key is sent in the `x-goog-api-key` header, never in the address. On the free tier Google may use the prompts to improve its products; ours hold only place names, kinds and times.
- **Claude:** `claude-haiku-5-5` unless `ANTHROPIC_MODEL` says otherwise, at low effort with `max_tokens` 400, through Anthropic's own SDK (`@anthropic-ai/sdk`) with `maxRetries: 0` (no retry: the SDK honours a `retry-after` header of any length when it retries) and each call given an `AbortSignal` that fires at the 8 s deadline. Server-side fallbacks are still on.
- **Not verified:** the model names (`claude-haiku-5-5`, `gemini-3.8-flash`) and whether Haiku accepts `output_config.effort` and `fallbacks` were not checked against the live APIs (the installed SDK's types list `claude-haiku-5-5` as a model but do not say which options each model takes). If a name or an option is rejected, the answer is the rules order and one log line a minute, so the feature stays safe but the AI never answers: check the server log after setting a key.
- **Without a key**, out of free quota, over budget, paused, too slow, or when the AI fails: confirming still works. The plan gets the order the rules score best (travel, plus half the waiting, plus a penalty for a last stop far from an MRT station), and the itinerary says the AI is off. Stub mode and the tests never call an AI.

### YouTube Data API and Gemini video (link reader)

- **What:** reading the places in a pasted post link. Gemini watches a public YouTube video (`file_data`); the YouTube Data API supplies its description, publish date and top comments; Google Places matches each place. Full behaviour: [link-reader-api.md](link-reader-api.md).
- **Where:** `backend/src/services/link-reader.js`. Every call goes through `services/http.js` (stubbed in stub mode), the YouTube key travels in a header, and calls are budgeted, cached and circuit-broken like the others.
- **Off by default:** the three routes exist only with `LINK_READER=1`; without it they answer 404 and nothing runs at start-up. It also needs `GEMINI_API_KEY`, **the same key as the itinerary AI** (one provider quota, two separate budgets in the server).
- **Budgets:** `LINK_READER_CALLS_PER_MINUTE` (default 6) counts model calls, one token each; the YouTube Data API has its own count (twice that); the Google matches go through a lane of at most a third of `GOOGLE_CALLS_PER_MINUTE` inside the shared Google budget; one caller gets 3 reads and 3 refreshes a minute (`LINK_READER_PER_CALLER_PER_MINUTE`). Details and the worst case: [link-reader-api.md](link-reader-api.md).
- **Not allowed to rely on:** downloading TikTok or Instagram videos (their terms forbid it), so that path is off unless `LINK_READER_YTDLP=1` **and `NODE_ENV=development`**, and never in production or stub mode.

## To set up (manual steps)

1. **OneMap account:** register at https://www.onemap.gov.sg/apidocs/register, then put the email and password in your own `backend/.env` as `ONEMAP_EMAIL` and `ONEMAP_PASSWORD`. On Render, set them under the service's Environment tab. **Never commit them or paste them in chat.** Set both or neither. Optionally set `ONEMAP_CALLS_PER_MINUTE` (default 240) to lower the server's share of the account's 300 calls a minute.
2. **Nothing for NEA.** To use the demo panel's rain switch on your own machine, set `ALLOW_SIMULATED_WEATHER=1` in `backend/.env`.
3. **Google Places:** put the key in `backend/.env` as `GOOGLE_MAPS_API_KEY`.
   - A [Maps Demo Key](https://mapsplatform.google.com/maps-demo-key/) works for building and testing, with no card. Checked 9 Oct 2026: ratings, prices and hours come back, **photos don't**.
   - For the final app: a key from a Google Cloud project with billing (the Free Trial is fine; don't upgrade it). Restrict it to Places API (New), set a **daily quota cap** (APIs & Services → Places API (New) → Quotas), and a **budget alert**. Then grading can't run up a bill.
   - On Render, set it in the Environment tab too.
   - Optional: `GOOGLE_CALLS_PER_MINUTE` (default 60) caps the calls this server makes to Google, searches and photos together. A key with a space or a control character inside it is treated as not set, and the server says so at start-up (without printing it).
4. **Itinerary AI:** put a free key from https://aistudio.google.com in `backend/.env` as `GEMINI_API_KEY` (and on Render's Environment tab). Or, for Claude, a key from https://console.anthropic.com as `ANTHROPIC_API_KEY`, with a monthly spend limit set in the console. Gemini is used when both are set. Optional: `ITINERARY_AI_CALLS_PER_MINUTE` (default 20), `GEMINI_MODEL`, `ANTHROPIC_MODEL`. **Never commit a key or paste it in chat.**

## For the frontend

- **Weather:** nothing to do. The frontend already sends `weatherCase` only when the demo rain switch is on.
- **Show where the numbers came from:**
  - `weather.source === 'live'`: e.g. "Forecast until 9.30 pm" from `weather.validUntil`.
  - `travel.source === 'estimate'` or a result's `approximate: true`: say "about".
- **Start and end points can come from `GET /api/places/search?q=`** instead of the mock address list.
- **Google places** have `source: 'google'`, a real `rating` and `ratingCount`, and `photo: { name, credit }`. Show the photo with `<img src="${VITE_API_BASE_URL}/api/places/photo?name=${encodeURIComponent(photo.name)}">` and the credit under it. Code for `searchPlaces` is in [changes-and-frontend-guide.md, Part D](changes-and-frontend-guide.md#part-d-live-weather-travel-times-and-address-search-9-oct).

## Testing

- `pnpm test` never touches the network. Stub mode answers NEA and OneMap from `backend/tests/fixtures/`.
- In stub mode, the scenarios behave like this:
  - `rain`: thundery showers everywhere
  - `routing-fail`: every OneMap route fails (after 5 in a row the circuit opens, and later trips keep the estimate without a call)
  - `dry`: fair weather everywhere, with routes generated from distance
- Tests:
  - `backend/tests/live-data.test.js`: the cache, OneMap search and routing, the token refresh, and the engine with real travel times
  - `backend/tests/onemap-limits.test.js`: the per-request cap, the shared budget, the token and login rules, the circuit, the deadline, the `q` checks and the start-up settings. Fake HTTP objects and a clock the test moves; no network.
  - `backend/tests/plan-routes.test.js`: the `travel` field and address search over HTTP
  - Ian's weather tests cover NEA
- Checked live on 9 Oct 2026:
  - **OneMap search** (no account) answered "520201" with 201 Tampines Street 21.
  - **OneMap routing**, with a real account, routed 9 of 9 trips for a Roam request (`travel.source: 'onemap'`).
