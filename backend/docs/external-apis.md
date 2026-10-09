# External APIs

Every outside service Jio uses, whether it is built, and how to set it up. All calls go through the backend's HTTP helper (`backend/src/services/http.js`), so keys stay on the server and tests answer from fixtures instead of the network.

| API | Used for | Account or key | Status |
|---|---|---|---|
| **NEA weather** (data.gov.sg) | Live 2-hour forecast: rain warnings, indoor swaps, ranking outdoor places lower in rain | None | ✅ Built (Ian, `services/weather.js`) |
| **OneMap search** | Address, postal code and building search for start and end points | None | ✅ Built |
| **OneMap routing** | Real public transport times, instead of the estimate | Free OneMap account: `ONEMAP_EMAIL`, `ONEMAP_PASSWORD` | ✅ Built, **switched on once the account is in `backend/.env`** |
| **OneMap map tiles** | The map's background | None | ✅ Used by the frontend map |
| Google Places (New) | Photos, opening hours and ratings for venues | Google Maps key (Demo Key to try, a billed key with a quota cap for the final app) | ⬜ Next |
| TikTok oEmbed | "Save from a TikTok link": the caption, to find the place | None | ⬜ Next |
| Google Maps share links | "Save from a Maps link": the place name and point from the link | None (not an API) | ⬜ Next |
| NEA hawker centre closures (data.gov.sg dataset) | Don't suggest a hawker centre on its cleaning days | None | ⬜ Next |
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
- **Open point for the team:** the 2-hour forecast is applied to every request, including a slot tomorrow. A slot outside the forecast's 2 hours is scored with today's forecast. Worth deciding whether such slots should use no live weather, or a longer forecast (the 4-day outlook).

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

  A trip OneMap can't answer, and every trip of a candidate that was not routed, keeps the estimate and is marked `approximate`.
- **Fewer calls:**
  - Trips under 400 m are walked, with no call.
  - The way back reuses the way there.
  - Routes are cached 6 hours, by points rounded to about 110 m and the hour. A failed answer is never cached.
  - The meeting area tries 16 areas, not 37, and gives real routes to the best 5 of them by estimate.
- **Without an account:** routing stays off and travel is the estimate (`travel.source: 'estimate'`). The server prints this at startup.

### Keeping the shared account safe

The OneMap account is shared by the whole server and allows 300 calls a minute in total. Nothing a caller sends may be able to spend more than the account allows, so there are three layers.

1. **A cap on one request.** `MAX_ROUTED_TRIPS_PER_REQUEST = 60` (`services/travel-times.js`). Candidates are routed whole, in priority order, until the next one would pass the cap: a venue is either real for every member or an estimate for every member. Trips answered from the cache and trips under 400 m make no call and do not count. The venues in `currentOptionIds` count like any other venue. For `/api/meeting-area` the areas are first ordered by their estimated result and only the best 5 are routed; if even one area would pass the cap, nothing is routed and the answer is an estimate with `approximate: true`. One request also waits at most 8 seconds for OneMap in total (`ROUTING_DEADLINE_MS`); trips not answered by then keep the estimate.
2. **One budget for the process** (`services/budget.js`, owned by `services/onemap.js`). Routing, address search and login all draw from it:
   - at most 6 calls in flight at once, across all requests;
   - a token bucket of `ONEMAP_CALLS_PER_MINUTE` calls a minute (default 240, leaving headroom under 300). It starts full and refills evenly.
   - A routing trip that finds the bucket empty does not wait: it keeps the estimate at once and the result is `approximate`. An address search answers `503 search_unavailable` with `Retry-After`.
   - Stub mode runs the same code with a very large budget, so tests do not hit it.
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

## To set up (manual steps)

1. **OneMap account:** register at https://www.onemap.gov.sg/apidocs/register, then put the email and password in your own `backend/.env` as `ONEMAP_EMAIL` and `ONEMAP_PASSWORD`. On Render, set them under the service's Environment tab. **Never commit them or paste them in chat.** Set both or neither. Optionally set `ONEMAP_CALLS_PER_MINUTE` (default 240) to lower the server's share of the account's 300 calls a minute.
2. **Nothing for NEA.** To use the demo panel's rain switch on your own machine, set `ALLOW_SIMULATED_WEATHER=1` in `backend/.env`.
3. **Google Places, when we get there:** a [Maps Demo Key](https://mapsplatform.google.com/maps-demo-key/) is enough to try it, with no card. For the final app, a billed key with a daily quota cap (Google Cloud → APIs & Services → Quotas) and a budget alert, so grading can't run up a bill. It will go in `backend/.env` as `GOOGLE_MAPS_API_KEY`.

## For the frontend

- **Weather:** nothing to do. The frontend already sends `weatherCase` only when the demo rain switch is on.
- **Show where the numbers came from:**
  - `weather.source === 'live'`: e.g. "Forecast until 9.30 pm" from `weather.validUntil`.
  - `travel.source === 'estimate'` or a result's `approximate: true`: say "about".
- **Start and end points can come from `GET /api/places/search?q=`** instead of the mock address list. Code for `searchPlaces` is in [changes-and-frontend-guide.md, Part D](changes-and-frontend-guide.md#part-d-live-weather-travel-times-and-address-search-9-oct).

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
