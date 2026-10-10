// "Rearrange with AI": the orders that are allowed (planner/arrange.js), Claude's choice among them
// (services/itinerary-ai.js, with a fake client: a test never calls Claude), and POST /api/itinerary/arrange.
import { once } from 'node:events'
import Anthropic from '@anthropic-ai/sdk'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { arrangeCandidates, freshCandidates, isOpenDuring, MEAL_SHIFT_MINUTES, timeStops } from '../src/planner/arrange.js'
import { createHttp, ExternalApiError } from '../src/services/http.js'
import { createItineraryAi, describeOption } from '../src/services/itinerary-ai.js'

// Four stops around Novena, a short walk apart. Lunch first, then three stops that can move.
const lunch = { id: 'eat-1', name: 'Lao Beijing', category: 'eat', lat: 1.3204, lng: 103.8438, duration: 90, hours: ['11:00-22:00'], indoor: true }
const cinema = { id: 'activity-1', name: 'Shaw Theatres', category: 'activity', lat: 1.3222, lng: 103.8445, duration: 120, hours: ['10:00-23:59'], indoor: true }
const mall = { id: 'shop-1', name: 'Velocity', category: 'shop', lat: 1.3201, lng: 103.8436, duration: 90, hours: ['10:00-22:00'], indoor: true, mrtWalk: 2 }
const cafe = { id: 'drink-1', name: 'Atlas', category: 'drink', lat: 1.3195, lng: 103.8441, duration: 60, hours: ['12:00-18:00'], indoor: true }
const STOPS = [lunch, cinema, mall, cafe]
const NOON = 12 * 60

describe('the allowed orders', () => {
  it('keeps food in place and tries every order of the rest', () => {
    const { candidates, movable } = arrangeCandidates({ stops: STOPS, startAt: NOON })
    expect(movable).toBe(3)
    expect(candidates.length).toBeGreaterThan(1)
    for (const c of candidates) expect(c.ids[0]).toBe('eat-1')
    // The current order runs the café past its 18:00 close, so it is not one of them.
    expect(candidates.filter((c) => c.isCurrent)).toHaveLength(0)
    const fine = arrangeCandidates({ stops: [lunch, cafe, cinema, mall], startAt: NOON }).candidates
    expect(fine.filter((c) => c.isCurrent)).toHaveLength(1)
  })

  it('leaves out an order that puts a stop at a closed place', () => {
    // The café closes at 18:00, so it cannot come after both the cinema and the mall (it would start after 17:00 and run past 18:00).
    const { candidates } = arrangeCandidates({ stops: STOPS, startAt: NOON })
    for (const c of candidates) {
      for (const s of c.stops) expect(isOpenDuring(s.hours, s.start, s.end)).toBe(true)
    }
    expect(candidates.some((c) => c.ids[3] === 'drink-1')).toBe(false)
  })

  it('keeps every meal within an hour of its time', () => {
    const dinner = { ...lunch, id: 'eat-2', name: 'Dinner', duration: 60 }
    const stops = [lunch, cinema, mall, dinner]
    const current = timeStops(stops, NOON).stops[3].start
    const { candidates } = arrangeCandidates({ stops, startAt: NOON })
    for (const c of candidates) expect(Math.abs(c.stops[3].start - current)).toBeLessThanOrEqual(MEAL_SHIFT_MINUTES)
  })

  it('keeps a meal at its time, and lets a shop wait for it to open', () => {
    // Faith's plan: the shop opens at 10:30, lunch is at 12:02 on screen. Before, every other order failed.
    const shop = { ...mall, name: 'Herschel', hours: ['10:30-21:30'], duration: 90 }
    const film = { ...cinema, duration: 120 }
    const coffee = { ...cafe, duration: 60, hours: ['08:00-22:00'] }
    const meal = { ...lunch, start: 12 * 60 + 2 }
    const { candidates } = arrangeCandidates({ stops: [film, meal, shop, coffee], startAt: 10 * 60, endAt: 17 * 60 })
    const others = candidates.filter((c) => !c.isCurrent)
    expect(others.length).toBeGreaterThan(0)
    for (const c of candidates) {
      const at = c.stops.find((s) => s.id === 'eat-1')
      expect(at.start).toBeGreaterThanOrEqual(12 * 60 + 2) // never earlier
      expect(at.start - (12 * 60 + 2)).toBeLessThanOrEqual(MEAL_SHIFT_MINUTES)
      expect(c.stops.every((s) => s.open)).toBe(true)
      expect(c.stops[c.stops.length - 1].end).toBeLessThanOrEqual(17 * 60)
    }
    // With the shop first, it waits until 10:30.
    const shopFirst = candidates.find((c) => c.ids[0] === 'shop-1')
    expect(shopFirst.stops[0].start).toBe(10 * 60 + 30)
  })

  it('never makes the group wait long for the first stop', () => {
    // A café that opens at noon cannot be first for a 10:00 meet-up: that would be two hours of standing around.
    const noonCafe = { ...cafe, hours: ['12:00-22:00'] }
    const { candidates } = arrangeCandidates({ stops: [cinema, { ...lunch, start: 12 * 60 }, mall, noonCafe], startAt: 10 * 60 })
    expect(candidates.some((c) => c.ids[0] === 'drink-1')).toBe(false)
  })

  it('a second press leaves out what was shown, and starts again when everything was', () => {
    const { candidates } = arrangeCandidates({ stops: STOPS, startAt: NOON })
    const first = freshCandidates(candidates, [])
    const second = freshCandidates(candidates, [first.options[0].ids])
    expect(second.options.map((c) => c.ids)).not.toContainEqual(first.options[0].ids)
    const all = candidates.map((c) => c.ids)
    const again = freshCandidates(candidates, all)
    expect(again.restarted).toBe(true)
    expect(again.options.every((c) => !c.isCurrent)).toBe(true)
  })
})

// A fake Anthropic client that answers with `answer` as the JSON text, and records what it was sent.
const fakeClient = (answer) => {
  const create = vi.fn(async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }] }))
  return { client: { beta: { messages: { create } } }, create }
}

describe('Claude choosing an order', () => {
  const { candidates } = arrangeCandidates({ stops: STOPS, startAt: NOON })
  const options = freshCandidates(candidates).options

  it('uses the order Claude picks, with its reason', async () => {
    const { client, create } = fakeClient({ choice: 2, reason: 'Film first, then shops, then a calm coffee.' })
    const ai = createItineraryAi({ client })
    expect(await ai.choose({ options })).toEqual({ index: 1, reason: 'Film first, then shops, then a calm coffee.', source: 'ai' })
    const sent = create.mock.calls[0][0]
    expect(sent.model).toBe('claude-opus-5-5')
    expect(sent.output_config.format.type).toBe('json_schema')
    expect(sent.messages[0].content).toContain(describeOption(options[0], 0))
  })

  it('never uses a choice that is not on the list', async () => {
    const { client } = fakeClient({ choice: 99, reason: 'Made up.' })
    expect((await createItineraryAi({ client }).choose({ options })).source).toBe('rules')
  })

  it('falls back to the rules when Claude is down, refuses, or there is no key', async () => {
    const down = { beta: { messages: { create: async () => { throw new Anthropic.APIConnectionError({ message: 'down' }) } } } }
    expect((await createItineraryAi({ client: down }).choose({ options })).source).toBe('rules')
    const refused = { beta: { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } } }
    expect((await createItineraryAi({ client: refused }).choose({ options })).source).toBe('rules')
    const none = createItineraryAi()
    expect(none.enabled).toBe(false)
    expect(await none.choose({ options })).toMatchObject({ index: 0, source: 'rules' })
  })

  it('does not hide a bug', async () => {
    const broken = { beta: { messages: { create: async () => { throw new TypeError('bug') } } } }
    await expect(createItineraryAi({ client: broken }).choose({ options })).rejects.toThrow('bug')
  })
})

// A fake HTTP helper that answers Gemini with `answer` as the JSON text, and records the request.
const fakeGemini = (answer) => {
  const postJson = vi.fn(async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }))
  return { http: { postJson }, postJson }
}

describe('Gemini choosing an order', () => {
  const { candidates } = arrangeCandidates({ stops: STOPS, startAt: NOON })
  const options = freshCandidates(candidates).options

  it('is used when there is a Gemini key, with the key in a header and never in the address', async () => {
    const { http, postJson } = fakeGemini({ choice: 2, reason: 'Shops first, then a calm coffee.' })
    const ai = createItineraryAi({ http, geminiKey: 'test-gemini-key', apiKey: 'also-a-claude-key' })
    expect(ai.provider).toBe('gemini')
    expect(await ai.choose({ options })).toEqual({ index: 1, reason: 'Shops first, then a calm coffee.', source: 'ai' })
    const [url, body, { headers }] = postJson.mock.calls[0]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent')
    expect(url).not.toContain('test-gemini-key')
    expect(headers['x-goog-api-key']).toBe('test-gemini-key')
    expect(body.generationConfig.responseMimeType).toBe('application/json')
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' })
    expect(body.contents[0].parts[0].text).toContain(describeOption(options[0], 0))
  })

  it('uses GEMINI_MODEL when it is set', async () => {
    const { http, postJson } = fakeGemini({ choice: 1, reason: 'Fine.' })
    await createItineraryAi({ http, geminiKey: 'k', geminiModel: 'gemini-other' }).choose({ options })
    expect(postJson.mock.calls[0][0]).toContain('/models/gemini-other:generateContent')
  })

  it('falls back to the rules when Gemini fails, is out of free quota, or answers off the list', async () => {
    const quota = { postJson: async () => { throw new ExternalApiError('gemini answered 429', { service: 'gemini', status: 429, url: 'x' }) } }
    expect((await createItineraryAi({ http: quota, geminiKey: 'k' }).choose({ options })).source).toBe('rules')
    const blocked = { postJson: async () => ({ candidates: [] }) }
    expect((await createItineraryAi({ http: blocked, geminiKey: 'k' }).choose({ options })).source).toBe('rules')
    const { http } = fakeGemini({ choice: 0, reason: 'Off the list.' })
    expect((await createItineraryAi({ http, geminiKey: 'k' }).choose({ options })).source).toBe('rules')
  })

  it('is never called in stub mode', async () => {
    const { http, postJson } = fakeGemini({ choice: 1, reason: 'x' })
    const ai = createItineraryAi({ http, geminiKey: 'k', stub: true })
    expect(ai.enabled).toBe(false)
    await ai.choose({ options })
    expect(postJson).not.toHaveBeenCalled()
  })
})

describe('POST /api/itinerary/arrange', () => {
  let server, base
  beforeAll(async () => {
    const { client } = fakeClient({ choice: 1, reason: 'A good flow.' })
    server = createApp({ frontendOrigin: 'http://localhost:5173', http: createHttp({ stub: true }), itineraryAi: createItineraryAi({ client }) }).listen(0)
    await once(server, 'listening')
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => new Promise((resolve) => server.close(resolve)))

  const post = async (body) => {
    const res = await fetch(`${base}/api/itinerary/arrange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }

  it('answers a new order, with the times and the reason', async () => {
    const { status, body } = await post({ stops: STOPS, startAt: NOON })
    expect(status).toBe(200)
    expect(body).toMatchObject({ status: 'ok', source: 'ai', reason: 'A good flow.', restarted: false })
    expect(body.order[0]).toBe('eat-1')
    expect(body.order).not.toEqual(STOPS.map((s) => s.id))
    expect(body.stops[0]).toEqual({ id: 'eat-1', start: NOON, end: NOON + 90 })
  })

  it('may keep the current order for the first suggestion', async () => {
    const stops = [lunch, cafe, cinema, mall]
    const { candidates } = arrangeCandidates({ stops, startAt: NOON })
    expect(freshCandidates(candidates, [], { includeCurrent: true }).options.some((c) => c.isCurrent)).toBe(true)
    const { body } = await post({ stops, startAt: NOON, includeCurrent: true })
    expect(body.status).toBe('ok')
  })

  it('says so when no other order fits', async () => {
    const { body } = await post({ stops: [lunch, cinema], startAt: NOON })
    expect(body.status).toBe('no_other_order')
    expect(body.message).toContain('Only one stop can move')
    // The café closes at 15:00 and the cinema opens at 16:00 (too long a wait right after lunch), so only this order
    // works, and the answer says why.
    const late = { ...cinema, hours: ['16:00-23:59'] }
    const early = { ...cafe, hours: ['12:00-15:00'] }
    const { body: blocked } = await post({ stops: [lunch, early, late], startAt: NOON })
    expect(blocked.status).toBe('no_other_order')
    expect(blocked.message).toMatch(/Shaw Theatres is not open at 13:3\d-15:3\d/)
  })

  it('checks the request', async () => {
    const { status, body } = await post({ stops: [{ ...lunch, hours: ['noon'] }, cinema], startAt: NOON })
    expect(status).toBe(400)
    expect(body.issues[0].path).toBe('stops.0.hours.0')
    expect((await post({ stops: [lunch, { ...lunch }], startAt: NOON })).status).toBe(400)
  })
})
