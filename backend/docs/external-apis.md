# External APIs

Every outside service Jio uses, whether it is built, and how to set it up. All calls go through the backend's HTTP helper (`backend/src/services/http.js`), so keys stay on the server and tests answer from fixtures instead of the network.

| API | Used for | Account or key | Status |
|---|---|---|---|
| **NEA weather** (data.gov.sg) | Live 2-hour forecast: rain warnings, indoor swaps, ranking outdoor places lower in rain | None | ✅ Built (Ian, `services/weather.js`) |
| **OneMap search** | Address, postal code and building search for start and end points | None | ✅ Built |
| **OneMap routing** | Real public transport times, instead of the estimate | Free OneMap account: `ONEMAP_EMAIL`, `ONEMAP_PASSWORD` | ✅ Built, **switched on once the account is in `backend/.env`** |
| **OneMap map tiles** | The map's background | None | ✅ Used by the frontend map |
| **OneMap themes** | ~460 more places: SportSG sport centres, tourist attractions, museums, libraries, theatres, parks, hawker centres | OneMap account (only to take the snapshot) | ✅ Built (`feature/onemap-places`) |
| **Google Places (New)** | Restaurants, cafés, bars, dessert shops and shopping malls near the meeting point, with ratings, price level, opening hours per day, and photos | `GOOGLE_MAPS_API_KEY` (Demo Key to try; a billed key with a quota cap for the final app) | ✅ Built (`feature/google-places`) |
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
- **Open point for the team:** the 2-hour forecast is applied to every request, including a slot tomorrow. A slot outside the forecast's 2 hours is scored with today's forecast. Worth deciding whether such slots should use no live weather, or a longer forecast (the 4-day outlook).

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

### OneMap themes and hawker closures (a snapshot, not a call per request)

- **What:** OneMap's government place lists, converted into venues by `backend/src/planner/onemap-adapter.js`:

  | Theme | Becomes | Kept |
  |---|---|---|
  | SportSG sport facilities | activity, `sports` | 45 |
  | Tourist attractions | activity, `attraction` (with **real opening hours** for 61, and photos) | 107 |
  | Museums | activity, `museum` | 11 |
  | Libraries | activity, `library` (with photos) | 28 |
  | Theatres | activity, `theatre` | 36 |
  | Parks | activity, `park`: real parks, gardens and nature areas only (playgrounds, fitness corners, open spaces, car parks left out) | 134 of 462 |
  | Hawker centres | food, `hawker` (photos, number of stalls): open ones only | 122 of 129 |

  Monuments and community clubs are left out on purpose: they're buildings to look at, or classes, rather than outings. Each is one line in `THEMES` if the team wants them.
- **Closures:** NEA's "Dates of Hawker Centres Closure" (data.gov.sg, no key) lists each centre's quarterly cleaning days and longer repairs. `backend/src/planner/hawker-closures.js` attaches them to the centre and its large CDC site, and the filters leave the centre out on those days (reason `closed_for_cleaning`).
- **Snapshot:** `pnpm --filter jio-backend build:onemap-places` (needs the OneMap account) writes `backend/src/db/mock/onemap-places.json`. These lists change a few times a year, so calling OneMap per request would only spend its rate limit. Re-run it when the lists or the next year's closure dates change, and commit the file.
- **Merging** (`backend/src/db/venues.js`):
  - A place the hand-made lists already have (e.g. Tiong Bahru Market) is skipped: 20 skipped.
  - OneMap's hawker centres replace their CDC copies, the same way the frontend's do.
- **What's a guess:** OneMap gives no price, rating or diet, and most themes give no hours. Those are typical values for the kind of place, labelled in `dataQuality` (`hoursAssumed`, `priceAssumed`…). Tourist attractions with hours in OneMap use those, and keep the original text in `openingHoursText`.
- **Credit:** contains information from OneMap (Singapore Land Authority) and the National Environment Agency, under the [Singapore Open Data Licence](https://data.gov.sg/open-data-licence). Tourist attraction photos carry their own `photoCredit`.

### Google Places (New)

- **Calls:**
  - `POST https://places.googleapis.com/v1/places:searchNearby`: one per Converge or Roam request that needs food, drink or shopping.
  - `GET https://places.googleapis.com/v1/{photo name}/media`: one per photo shown.

  Docs: [Nearby Search (New)](https://developers.google.com/maps/documentation/places/web-service/nearby-search).
- **Code:**
  - `backend/src/services/google-places.js`: the calls, the field list and the cache.
  - `backend/src/planner/google-adapter.js`: turns a Google place into a venue.
  - `backend/src/routes/plan.js`: adds the places to a request, and serves the photo route.
- **Get → merge → massage → show:**
  - **get** up to 20 of the **nearest** restaurants, cafés, bars and dessert shops (food and drink slots) or shopping malls (shop slots) within 1 km of the point the request ranks around
  - **merge** them with the venue list, skipping places it already has
  - **massage**: place each in its NEA forecast area, read that **day of the week's** opening hours (a place shut on Mondays is left out on a Monday), turn the price level into a typical price
  - **show** them ranked with everything else
- **Why per request, not a snapshot:** Google's terms allow storing a place's id, not its details. So these are never saved to a file, only cached in memory for 10 minutes.
- **Shops:** shop slots ask for `shopping_mall` only. `department_store` and `market` brought back single jewellery shops and grocers. A mall needs 50+ reviews, and names like "(No longer in operation)" are dropped. Checked live near Newton: Scotts Square, Far East Plaza, Pacific Plaza and COMO Orchard, and at 08:44 the malls that open at 8am (before, the 15 hand-listed malls were all still closed).
- **Why "nearest first":** the planner looks within 500 m first and only widens when it has fewer than 3 options. Google's default ("most popular") returned places 300–800 m away, which the planner never reached. Checked live near Bishan: with "nearest", Din Tai Fung, Pepper Grill, Stuff'd and Shake Shack at Junction 8 made the top 6.
- **Cost control:**
  - One request per slot at most, cached by points about 110 m apart.
  - Only the fields Jio uses (`NEARBY_FIELDS`): each extra field can move the request to a dearer tier.
  - A daily quota on the key is the real safety net.
- **What's a guess:**
  - Diet and access are unknown.
  - The "quiet / romantic / lively" attributes are defaults for the kind of place.
  - The price is a typical amount for Google's level ($10 inexpensive, $25 moderate, $50 expensive, $90 very expensive).

  `dataQuality` labels each.
- **Photos:** a Google venue has `photo: { name, credit }`. The browser loads `GET /api/places/photo?name=<photo.name>`, which redirects to Google's image link. The key stays on the server. Google requires the credit (`photo.credit.displayName`, linked to `photo.credit.uri`) to be shown with the photo.
- **Every answer says** `google: { source, added }`:
  - `google`: places were added
  - `off`: no key
  - `not_needed`: an activity slot (activities come from OneMap's lists)
  - `unavailable`: Google is down; the planner answers with its other venues

## To set up (manual steps)

1. **OneMap account:** register at https://www.onemap.gov.sg/apidocs/register, then put the email and password in your own `backend/.env` as `ONEMAP_EMAIL` and `ONEMAP_PASSWORD`. On Render, set them under the service's Environment tab. **Never commit them or paste them in chat.**
2. **Nothing for NEA.** To use the demo panel's rain switch on your own machine, set `ALLOW_SIMULATED_WEATHER=1` in `backend/.env`.
3. **Google Places:** put the key in `backend/.env` as `GOOGLE_MAPS_API_KEY`.
   - A [Maps Demo Key](https://mapsplatform.google.com/maps-demo-key/) works for building and testing, with no card. Checked 9 Oct 2026: ratings, prices and hours come back, **photos don't**.
   - For the final app: a key from a Google Cloud project with billing (the Free Trial is fine; don't upgrade it). Restrict it to Places API (New), set a **daily quota cap** (APIs & Services → Places API (New) → Quotas), and a **budget alert**. Then grading can't run up a bill.
   - On Render, set it in the Environment tab too.

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
  - `routing-fail`: every OneMap route fails
  - `dry`: fair weather everywhere, with routes generated from distance
- Tests:
  - `backend/tests/live-data.test.js`: the cache, OneMap search and routing, the token refresh, and the engine with real travel times
  - `backend/tests/plan-routes.test.js`: the `travel` field and address search over HTTP
  - Ian's weather tests cover NEA
- Checked live on 9 Oct 2026:
  - **OneMap search** (no account) answered "520201" with 201 Tampines Street 21.
  - **OneMap routing**, with a real account, routed 9 of 9 trips for a Roam request (`travel.source: 'onemap'`).
