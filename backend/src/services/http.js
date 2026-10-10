import { ExternalApiError } from './errors.js'
import { currentScenario } from './scenario.js'
import { resolveStub } from './stubs.js'

// Every call to OneMap, data.gov.sg or LTA goes through this helper. Never call
// fetch() directly for an external API: a direct call cannot be stubbed, so the
// tests would hit the real network and give a different result every run.
//
// You do not build your own helper. The server builds one at startup and hands
// it to your service or route:
//   const http = req.app.locals.http                     // Inside a route handler.
//   export function createWeather({ http }) { ... }      // Inside a service.
//
// It is re-exported here so you can import both from one place:
//   import { createHttp, ExternalApiError } from './http.js'
export { ExternalApiError }

// Works out which provider a URL belongs to, for error messages.
function serviceOf(url) {
  const { hostname } = new URL(url)
  if (hostname.endsWith('onemap.gov.sg')) return 'onemap'
  if (hostname.endsWith('data.gov.sg')) return 'datagov'
  if (hostname.endsWith('mytransport.sg')) return 'lta'
  if (hostname.endsWith('googleapis.com')) return 'google'
  return 'unknown'
}

// Stops the server from starting with stubs switched on in production, where
// fake travel times and forecasts would be shown to real users.
//
// How to call (already done in index.js):
//   assertStubAllowed({ stub, nodeEnv: process.env.NODE_ENV })
export function assertStubAllowed({ stub, nodeEnv }) {
  if (stub && nodeEnv === 'production') {
    throw new Error('STUB_EXTERNALS is on in production. Remove it: stubs serve fake API data.')
  }
}

// Builds the HTTP helper.
//
// How to call:
//   const http = createHttp()                // Real network calls.
//   const http = createHttp({ stub: true })  // Answers from fixtures, no network.
//
// In a unit test, pass a fake fetch to check your error handling:
//   const http = createHttp({ fetchImpl: async () => new Response('', { status: 503 }) })
//
// Options:
//   stub        - true answers from backend/tests/fixtures/ instead of the network.
//   fetchImpl   - The function that makes the request. Defaults to Node's fetch.
//   timeoutMs   - How long to wait for an answer before giving up. Default 10 seconds. A single call can set its
//                 own with the `timeoutMs` request option (Google Places uses 3 seconds).
//   getScenario - Returns the stub scenario for the current request.
export function createHttp({
  stub = false,
  fetchImpl = fetch,
  timeoutMs: defaultTimeoutMs = 10000,
  getScenario = currentScenario,
} = {}) {
  // Shared by getJson and postJson. Returns the parsed JSON body, or throws.
  async function request(method, url, { headers, body, timeoutMs = defaultTimeoutMs } = {}) {
    // Stub mode: answer from fixtures, never touch the network.
    if (stub) return resolveStub(method, url, getScenario())

    const service = serviceOf(url)

    let res
    try {
      res = await fetchImpl(url, {
        method,
        // A request with a body is always JSON.
        headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Give up if the API takes too long.
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      // No response arrived: the network is down, or the timeout fired.
      const reason = err.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : err.message
      throw new ExternalApiError(`${service} request failed: ${reason}`, { service, status: null, url })
    }

    if (!res.ok) {
      throw new ExternalApiError(`${service} answered ${res.status}`, { service, status: res.status, url })
    }

    // data.gov.sg sends 200 with an empty body on a bad date, so an empty body is a failure.
    const text = await res.text()
    if (!text) {
      throw new ExternalApiError(`${service} sent an empty body`, { service, status: res.status, url })
    }

    try {
      return JSON.parse(text)
    } catch {
      // OneMap answers with an HTML page when it rate-limits.
      throw new ExternalApiError(`${service} sent a body that is not JSON`, { service, status: res.status, url })
    }
  }

  return {
    // Sends a GET request and returns the parsed JSON.
    //
    // How to call:
    //   const forecast = await http.getJson('https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast')
    //
    // With headers, for example OneMap's token:
    //   const route = await http.getJson(routeUrl, { headers: { Authorization: token } })
    //
    // With a shorter wait than the default, for an API that must not hold a request up:
    //   const photo = await http.getJson(url, { headers, timeoutMs: 3000 })
    //
    // Throws ExternalApiError when the API fails.
    getJson: (url, { headers, timeoutMs } = {}) => request('GET', url, { headers, timeoutMs }),

    // Sends a POST request with a JSON body and returns the parsed JSON.
    //
    // How to call:
    //   const { access_token, expiry_timestamp } = await http.postJson(
    //     'https://www.onemap.gov.sg/api/auth/post/getToken',
    //     { email, password },
    //   )
    //
    // The `timeoutMs` option works here too.
    //
    // Throws ExternalApiError when the API fails.
    postJson: (url, body, { headers, timeoutMs } = {}) => request('POST', url, { headers, body, timeoutMs }),
  }
}
