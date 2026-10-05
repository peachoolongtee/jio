import { AsyncLocalStorage } from 'node:async_hooks'

// The request header a test sends to pick a scenario. It is read in stub mode only.
//
// How to send it from Playwright, on backend requests only:
//   await page.route('**/api/**', (route) =>
//     route.continue({ headers: { ...route.request().headers(), 'x-jio-scenario': 'rain' } }),
//   )
export const SCENARIO_HEADER = 'x-jio-scenario'

// Every scenario the stubs understand.
//   dry          - Fair weather everywhere, routing works. This is the default.
//   rain         - Heavy rain everywhere, routing works.
//   routing-fail - Fair weather, and every OneMap route call fails.
export const SCENARIOS = ['dry', 'rain', 'routing-fail']
export const DEFAULT_SCENARIO = 'dry'

// Carries the scenario along one request's async calls, so it never has to be
// passed through function arguments. Requests running in parallel stay separate.
const store = new AsyncLocalStorage()

// Returns the scenario of the request being handled right now, or 'dry' when
// none was set.
//
// How to call:
//   const scenario = currentScenario() // 'dry' | 'rain' | 'routing-fail'
//
// Anything you cache in stub mode must include this in its cache key, or a rain
// test will leak its forecast into the next dry test:
//   const key = `two-hr-forecast:${currentScenario()}`
export function currentScenario() {
  return store.getStore()?.scenario ?? DEFAULT_SCENARIO
}

// Runs a function with a scenario set. Use this in unit tests, where there is
// no HTTP request to carry the header.
//
// How to call:
//   const forecast = await runWithScenario('rain', () => weather.twoHourForecast())
export function runWithScenario(scenario, fn) {
  if (!SCENARIOS.includes(scenario)) {
    throw new Error(`Unknown scenario "${scenario}". Use one of: ${SCENARIOS.join(', ')}.`)
  }
  return store.run({ scenario }, fn)
}

// Express middleware that reads the scenario header and sets it for the rest of
// the request. createApp mounts it only when stub mode is on, so you never
// mount it yourself.
//
// How to call (already done in app.js):
//   app.use(express.json())
//   app.use(scenarioMiddleware) // Keep it after the body parser.
export function scenarioMiddleware(req, res, next) {
  const scenario = req.get(SCENARIO_HEADER) ?? DEFAULT_SCENARIO

  // A typo in a test should fail loudly, not quietly run the dry scenario.
  if (!SCENARIOS.includes(scenario)) {
    return res.status(400).json({
      error: {
        code: 'unknown_scenario',
        message: `Unknown scenario "${scenario}". Use one of: ${SCENARIOS.join(', ')}.`,
      },
    })
  }

  store.run({ scenario }, next)
}
