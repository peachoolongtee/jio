# Fixtures

Canned API responses. In stub mode the backend answers from these files instead of calling OneMap, data.gov.sg or LTA, so tests give the same result every run and work offline.

## What is here

| File | Source | Used for |
|---|---|---|
| `datagov/two-hr-forecast.dry.json` | Recorded live on 2026-10-05. All 47 areas are "Fair (Day)". | Scenarios `dry` and `routing-fail` |
| `datagov/two-hr-forecast.rain.json` | The dry file with every forecast changed to "Heavy Thundery Showers". | Scenario `rain` |
| `onemap/search.json` | Recorded live on 2026-10-05, postal code 178879. The call had no token, so OneMap added an `error` warning field, which was removed. | Every stubbed search, whatever the query |
| `onemap/token.json` | Made up. The expiry is the year 2100, as epoch seconds in a string, like the real API. | Every stubbed token call |
| `onemap/route.pt.sample.json` | Copied from OneMap's documentation and trimmed. Not a real recording. | Unit-testing the route parser only |
| `google/places-nearby.json` | Recorded live on 2026-10-09 with the Maps Demo Key: restaurants and cafés within 800 m of Bishan MRT, trimmed to 6 places. The Demo Key returns no photos, so one photo with a made-up name was added by hand. No key is in the file. | Every stubbed Google nearby search, wherever it is |

Stubbed routes are not read from a file. They are generated from the straight-line distance between the two points, in OneMap's response shape. See `syntheticRoute` in `backend/src/services/stubs.js`.

## Adding a fixture

1. Record the real response into the right folder. This weather call needs no key:

   ```bash
   curl -s https://api-open.data.gov.sg/v2/real-time/api/twenty-four-hr-forecast > backend/tests/fixtures/datagov/twenty-four-hr-forecast.dry.json
   ```

2. If the answer should change with the weather, copy the file and edit the copy for the `rain` scenario.
3. Add one rule for the URL to the `rules` list in `backend/src/services/stubs.js`.
4. Add a row to the table above.

Never put a real token, password or API key in a fixture. These files are committed.

## To replace once the OneMap account exists

- `onemap/route.pt.sample.json`: record one real public transport route.
- Confirm the walking route shape in `syntheticRoute` against one real `routeType=walk` call.
