# External APIs

Every outside service Jio uses, whether it is built, and how to set it up. All calls go through the backend's HTTP helper (`backend/src/services/http.js`), so keys stay on the server and tests answer from fixtures instead of the network.

| API | Used for | Account or key | Status |
|---|---|---|---|
| **NEA weather** (data.gov.sg) | Live 2-hour forecast: rain warnings, indoor swaps, ranking outdoor places lower in rain | None (optional `DATAGOV_API_KEY` only raises the rate limit) | ✅ Built |
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

- **Call:** `GET https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast`. Source: [data.gov.sg Weather Forecast collection](https://data.gov.sg/collections/1456/view).
- **Code:** `backend/src/services/weather.js`. Cached 5 minutes. NEA updates it every 30 minutes.
- **Get → merge → massage → show:**
  - **get** the forecast for 47 areas
  - **merge** each venue with its nearest area
  - **massage** the forecast word into a rain risk (0 to 1), which feeds the weather score, rain warnings and the indoor swap
  - **show** `weather` in every Converge and Roam answer
- **Only for the next 2 hours.** A slot outside the forecast's period gets `weather.source: 'none'`, never tonight's forecast for tomorrow. A 4-day outlook is a possible next step for sessions planned ahead.
- **If NEA is down:** the planner plans without live weather and says so (`reason: 'forecast_unavailable'`). The request does not fail.

### OneMap search

- **Call:** `GET https://www.onemap.gov.sg/api/common/elastic/search?searchVal=…&returnGeom=Y&getAddrDetails=Y&pageNum=1`. Docs: [OneMap API](https://www.onemap.gov.sg/apidocs/).
- **Code:** `backend/src/services/onemap.js` → `GET /api/places/search?q=…`. Cached a day.
- **No account needed** (checked live on 9 Oct 2026: "Bishan MRT" and "520201" both answer).

### OneMap routing

- **Calls:**
  - `POST /api/auth/post/getToken` with the account. The token lasts 3 days; the server gets a new one an hour before it runs out.
  - `GET /api/public/routingsvc/route?start=…&end=…&routeType=pt&date=MM-DD-YYYY&time=HH:00:00&mode=TRANSIT&maxWalkDistance=1000&numItineraries=1`
- **Code:**
  - `backend/src/services/onemap.js`: the token, routes and the cache.
  - `backend/src/services/travel-times.js`: feeds the routes to the engine.
- **How the synchronous engine gets async routes:**
  1. A dry run records every trip the engine needs.
  2. Those are fetched, 6 at a time.
  3. The real run reads them.

  A trip OneMap can't answer falls back to the estimate and is marked `approximate`.
- **Fewer calls:**
  - Trips under 400 m are walked, with no call.
  - The way back reuses the way there.
  - Routes are cached 6 hours, by points rounded to about 110 m and the hour.
  - The meeting area tries 16 areas, not 37.
- **Without an account:** routing stays off and travel is the estimate (`travel.source: 'estimate'`). The server prints this at startup.

## To set up (manual steps)

1. **OneMap account:** register at https://www.onemap.gov.sg/apidocs/register, then put the email and password in your own `backend/.env` as `ONEMAP_EMAIL` and `ONEMAP_PASSWORD`. On Render, set them under the service's Environment tab. **Never commit them or paste them in chat.**
2. **Nothing for NEA.**
3. **Google Places, when we get there:** a [Maps Demo Key](https://mapsplatform.google.com/maps-demo-key/) is enough to try it, with no card. For the final app, a billed key with a daily quota cap (Google Cloud → APIs & Services → Quotas) and a budget alert, so grading can't run up a bill. It will go in `backend/.env` as `GOOGLE_MAPS_API_KEY`.

## For the frontend

- **Leave `weatherCase` out** of `/api/converge` and `/api/roam` unless the demo "rain" switch is on. Sending `'clear'` pins the weather to the demo's dry case, so the live forecast is never used. (`frontend/src/lib/plannerApi.js` currently always sends it.)
- **Show where the numbers came from:**
  - `weather.source === 'nea'`: e.g. "Forecast 7.30 pm to 9.30 pm" from `weather.validText`.
  - `travel.source === 'estimate'` or a result's `approximate: true`: say "about".
- **Start and end points can come from `GET /api/places/search?q=`** instead of the mock address list.

## Testing

- `pnpm test` never touches the network. Stub mode answers NEA and OneMap from `backend/tests/fixtures/`.
- In stub mode, the scenarios behave like this:
  - `rain`: thundery showers everywhere
  - `routing-fail`: every route fails
  - `dry`: fair weather everywhere, with routes generated from distance
- Tests: `backend/tests/live-data.test.js` (the services) and `backend/tests/plan-routes.test.js` (the routes, including the forecast period, NEA down, and address search).
- Checked live on 9 Oct 2026, with the real APIs and no account:
  - **NEA:** 47 areas, "7.30 pm to 9.30 pm". A slot at 20:00 used the live forecast; a slot the next day correctly got `outside_forecast_period`.
  - **OneMap search** answered "520201" with 201 Tampines Street 21.
