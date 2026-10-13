import { once } from 'node:events'
import { createApp } from '../../src/app.js'
import { createHttp } from '../../src/services/http.js'
import { loadFixture, shiftTwentyFourHourForecast } from '../../src/services/stubs.js'

// A small offline world for the forecast-window tests: a clock you can move, and a fake fetch under the real
// createHttp that answers the two data.gov.sg forecasts from fixtures and counts the calls by URL.
//
// How to use it:
//   const world = makeWorld({ clock: at('2026-10-11T16:10') })
//   const post = await startApp(world, servers)           // a running app on a free port that uses the clock
//   await post('/converge', body)
//   world.calls // { area: 1, regional: 0 }

/** Milliseconds for a Singapore local time. */
export const at = (local) => Date.parse(`${local}:00+08:00`)

export const HOUR = 3600 * 1000

/** What the area forecast says everywhere: 'dry' (Fair) or 'rain' (Heavy Thundery Showers), from the stub fixtures. */
export const areaAnswer = (kind) => loadFixture(`datagov/two-hr-forecast.${kind}.json`)

/**
 * The recorded regional answer moved to cover 18 to 24 hours from `clockMs`, as NEA's does, and with the sentences
 * in `phrases` (one sentence for every region, or an object by region). Without `phrases` the periods keep the
 * recorded sentences.
 *
 * How to call:
 *   regionalAnswer(at('2026-10-12T10:00'), 'Thundery Showers')
 *   regionalAnswer(at('2026-10-12T10:00'), { west: 'Thundery Showers', east: 'Fair (Day)' })
 */
export function regionalAnswer(clockMs, phrases) {
  const payload = shiftTwentyFourHourForecast(loadFixture('datagov/twenty-four-hr-forecast.real.json'), clockMs)
  if (phrases !== undefined) {
    for (const period of payload.data.records[0].periods) {
      for (const region of Object.keys(period.regions)) {
        period.regions[region].text = typeof phrases === 'string' ? phrases : (phrases[region] ?? 'Fair (Day)')
      }
    }
  }
  return payload
}

/**
 * Moves every time in a regional answer by `ms`.
 *
 * How to call:
 *   shiftTimes(loadFixture('datagov/twenty-four-hr-forecast.real.json'), 6 * HOUR)
 */
export function shiftTimes(payload, ms) {
  const move = (text) => new Date(Date.parse(text) + ms + 8 * HOUR).toISOString().slice(0, 19) + '+08:00'
  const record = payload.data.records[0]
  record.timestamp = move(record.timestamp)
  record.updatedTimestamp = move(record.updatedTimestamp)
  for (const t of [record.general.validPeriod, ...record.periods.map((p) => p.timePeriod)]) {
    t.start = move(t.start)
    t.end = move(t.end)
  }
  return payload
}

/**
 * The world: a movable clock, answers for the two forecasts, and the calls made so far.
 *   area      'dry' | 'rain' | a payload | a function returning a payload | an Error to throw (a network failure)
 *   regional  a payload | a function (clock) => payload | an Error | { status } | { text } for a raw body
 */
export function makeWorld({ clock, area = 'dry', regional = (c) => regionalAnswer(c, 'Fair (Day)') }) {
  const world = {
    clock,
    calls: { area: 0, regional: 0, other: [] },
    urls: [],
    area,
    regional,
    now: () => world.clock,
  }
  world.fetchImpl = async (url) => {
    world.urls.push(String(url))
    const isArea = String(url).includes('/two-hr-forecast')
    const isRegional = String(url).includes('/twenty-four-hr-forecast')
    if (isArea) world.calls.area += 1
    else if (isRegional) world.calls.regional += 1
    else {
      world.calls.other.push(String(url))
      throw new Error(`unexpected outbound call to ${url}`)
    }
    let answer = isArea ? world.area : world.regional
    if (typeof answer === 'string') answer = areaAnswer(answer)
    if (typeof answer === 'function') answer = answer(world.clock)
    if (answer instanceof Error) throw answer
    if (answer && 'status' in answer && Object.keys(answer).length === 1) return new Response('', { status: answer.status })
    if (answer && 'text' in answer && Object.keys(answer).length === 1) return new Response(answer.text, { status: 200 })
    return new Response(JSON.stringify(answer), { status: 200 })
  }
  world.http = createHttp({ fetchImpl: world.fetchImpl })
  return world
}

/**
 * Starts an app that reads the world's forecasts and clock, on a free port. Pushes the server to `servers` so the
 * test can close it. Returns post(path, body, headers) and get(path).
 *
 * How to call:
 *   const post = await startApp(world, servers, { allowSimulatedWeather: true })
 */
export async function startApp(world, servers, options = {}) {
  const server = createApp({ frontendOrigin: 'http://localhost:5173', http: world.http, now: world.now, ...options }).listen(0)
  servers.push(server)
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  return async (path, body, headers = {}) => {
    const res = await fetch(`${base}/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json(), headers: res.headers }
  }
}
