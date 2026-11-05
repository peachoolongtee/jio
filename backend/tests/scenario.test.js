import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { currentScenario, runWithScenario } from '../src/services/scenario.js'

const FRONTEND = 'http://localhost:5173'
const FORECAST_URL = 'https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast'

describe('currentScenario', () => {
  it('is dry when nothing was set', () => {
    expect(currentScenario()).toBe('dry')
  })

  it('is the scenario set by runWithScenario, even after an await', async () => {
    await runWithScenario('rain', async () => {
      await delay(5)
      expect(currentScenario()).toBe('rain')
    })
    expect(currentScenario()).toBe('dry')
  })

  it('rejects a scenario it does not know', () => {
    expect(() => runWithScenario('snow', () => {})).toThrow(/Unknown scenario/)
  })
})

// Starts an app with two throwaway routes that report what a real route would
// see: the scenario, and the first forecast the shared HTTP helper returns.
async function startApp({ stub }) {
  const report = async (req, res) => {
    await delay(5) // Cross an await, like a real handler does.
    const forecast = stub ? await req.app.locals.http.getJson(FORECAST_URL) : null
    res.json({
      scenario: currentScenario(),
      forecast: forecast?.data.items[0].forecasts[0].forecast ?? null,
    })
  }
  // Extra routes go in through `mount`, so they sit before the app's "not found" handler.
  const app = createApp({
    frontendOrigin: FRONTEND,
    stub,
    mount: (a) => {
      a.get('/probe', report)
      a.post('/probe', report)
    },
  })

  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

describe('scenario header in stub mode', () => {
  let server
  let base

  beforeAll(async () => {
    ;({ server, base } = await startApp({ stub: true }))
  })
  afterAll(() => new Promise((resolve) => server.close(resolve)))

  it('defaults to dry', async () => {
    const body = await (await fetch(`${base}/probe`)).json()

    expect(body).toEqual({ scenario: 'dry', forecast: 'Fair (Day)' })
  })

  it('reaches the HTTP helper inside a route handler', async () => {
    const res = await fetch(`${base}/probe`, { headers: { 'x-jio-scenario': 'rain' } })

    expect(await res.json()).toEqual({ scenario: 'rain', forecast: 'Heavy Thundery Showers' })
  })

  it('survives a JSON body being parsed first', async () => {
    const res = await fetch(`${base}/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-jio-scenario': 'rain' },
      body: JSON.stringify({ eventId: 'abc' }),
    })

    expect((await res.json()).scenario).toBe('rain')
  })

  it('keeps parallel requests separate', async () => {
    const scenarios = ['rain', 'dry', 'routing-fail', 'rain', 'dry', 'rain']

    const seen = await Promise.all(
      scenarios.map(async (scenario) => {
        const res = await fetch(`${base}/probe`, { headers: { 'x-jio-scenario': scenario } })
        return (await res.json()).scenario
      }),
    )

    expect(seen).toEqual(scenarios)
  })

  it('answers 400 for a scenario it does not know', async () => {
    const res = await fetch(`${base}/probe`, { headers: { 'x-jio-scenario': 'snow' } })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('unknown_scenario')
  })

  it('lets the browser send the header across origins', async () => {
    // The preflight a browser sends before a request that carries a custom header.
    const res = await fetch(`${base}/probe`, {
      method: 'OPTIONS',
      headers: {
        Origin: FRONTEND,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-jio-scenario',
      },
    })

    expect(res.headers.get('access-control-allow-origin')).toBe(FRONTEND)
    expect(res.headers.get('access-control-allow-headers')).toMatch(/x-jio-scenario/i)
  })
})

describe('scenario header with stub mode off', () => {
  let server
  let base

  beforeAll(async () => {
    ;({ server, base } = await startApp({ stub: false }))
  })
  afterAll(() => new Promise((resolve) => server.close(resolve)))

  it('is ignored, so nobody can switch scenarios on a real server', async () => {
    const res = await fetch(`${base}/probe`, { headers: { 'x-jio-scenario': 'rain' } })

    expect(res.status).toBe(200)
    expect((await res.json()).scenario).toBe('dry')
  })
})
