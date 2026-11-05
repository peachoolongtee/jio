// The frontend's calls to the Jio server's session routes of stage 3 (the contract on ticket #128): each one's method, path and
// body, that the session id is put in the path safely, the wait it allows, what it hands back, and that a refusal reaches the
// caller with the server's own code (the data layer words it by that). The planner client's own adapter stands in for the server.
import { afterEach, describe, expect, it } from 'vitest'
import { AxiosError } from 'axios'
import {
  SESSION_TIMEOUT_MS,
  api,
  confirmSessionSpot,
  deleteSessionSpot,
  getSessionTravelLean,
  optOutOfSession,
  putSessionKnownPlace,
  putSessionSpot,
  refreshSessionSpots,
  rejoinSession,
} from '../plannerApi.js'

const ID = '3b1f5c2a-9d4e-4f6a-8b7c-1a2b3c4d5e6f'

afterEach(() => {
  delete api.defaults.adapter
})

// Answer every request with `data`, and keep what was sent: the method, the path, the body as it went (parsed) and the wait.
// How to call: const sent = answer({ planVersion: 2 })
function answer(data) {
  const sent = []
  api.defaults.adapter = async (config) => {
    sent.push({ method: config.method, url: config.url, data: config.data ? JSON.parse(config.data) : undefined, timeout: config.timeout })
    return { data, status: 200, statusText: 'OK', headers: {}, config }
  }
  return sent
}

describe('the quiet line about past travel', () => {
  it('asks GET travel-lean and hands back the flag and the rule, and nothing else the server might add', async () => {
    const sent = answer({ owed: true, rule: 'longest', minutes: 12.5, someone: 'x' })
    expect(await getSessionTravelLean(ID)).toEqual({ owed: true, rule: 'longest' })
    expect(sent.map((c) => [c.method, c.url, c.timeout])).toEqual([['get', `/api/sessions/${ID}/travel-lean`, SESSION_TIMEOUT_MS]])
  })

  it('refuses an answer that is not a flag and a known rule, so nothing is shown on a guess', async () => {
    for (const data of [{}, { owed: 'yes', rule: 'longest' }, { owed: true }, { owed: true, rule: 'shortest' }, null]) {
      answer(data)
      await expect(getSessionTravelLean(ID)).rejects.toThrow()
    }
  })
})

describe('the calls', () => {
  it('works the spots out again: POST meeting-area with the trigger, or an empty body', async () => {
    const sent = answer({ planVersion: 3, meetingAreaId: null, moved: false, votesCleared: false, skipped: [] })
    expect(await refreshSessionSpots(ID, 'start')).toMatchObject({ planVersion: 3, meetingAreaId: null })
    await refreshSessionSpots(ID)
    expect(sent.map((c) => [c.method, c.url, c.data])).toEqual([
      ['post', `/api/sessions/${ID}/meeting-area`, { trigger: 'start' }],
      ['post', `/api/sessions/${ID}/meeting-area`, {}],
    ])
  })

  it('suggests an area: PUT spots/mine with the area and the "here" label', async () => {
    const sent = answer({ planVersion: 4, spots: 4, approvalsRemoved: 0 })
    expect(await putSessionSpot(ID, 'bugis', true)).toEqual({ planVersion: 4, spots: 4, approvalsRemoved: 0 })
    await putSessionSpot(ID, 'orchard')
    expect(sent.map((c) => [c.method, c.url, c.data])).toEqual([
      ['put', `/api/sessions/${ID}/spots/mine`, { areaId: 'bugis', here: true }],
      ['put', `/api/sessions/${ID}/spots/mine`, { areaId: 'orchard', here: false }],
    ])
  })

  it('takes a suggestion back: DELETE spots/mine', async () => {
    const sent = answer({ planVersion: 5 })
    expect(await deleteSessionSpot(ID)).toEqual({ planVersion: 5 })
    expect([sent[0].method, sent[0].url]).toEqual(['delete', `/api/sessions/${ID}/spots/mine`])
  })

  it('confirms a spot: POST voting with the area, or without one for the preselected spot', async () => {
    const sent = answer({ planVersion: 6, status: 'voting', meetingAreaId: 'bugis', method: 'voted', slotCount: 0 })
    expect(await confirmSessionSpot(ID, 'bugis')).toMatchObject({ status: 'voting', meetingAreaId: 'bugis' })
    await confirmSessionSpot(ID)
    expect(sent.map((c) => [c.method, c.url, c.data])).toEqual([
      ['post', `/api/sessions/${ID}/voting`, { areaId: 'bugis' }],
      ['post', `/api/sessions/${ID}/voting`, {}],
    ])
  })

  it('names the place the group knows: PUT known-place', async () => {
    const sent = answer({ planVersion: 7, status: 'voting' })
    expect(await putSessionKnownPlace(ID, 'bugis')).toEqual({ planVersion: 7, status: 'voting' })
    expect([sent[0].method, sent[0].url, sent[0].data]).toEqual(['put', `/api/sessions/${ID}/known-place`, { areaId: 'bugis' }])
  })

  it('opts out and rejoins: POST opt-out and rejoin', async () => {
    const sent = answer({ planVersion: 8, state: 'opted_out' })
    expect(await optOutOfSession(ID)).toMatchObject({ state: 'opted_out' })
    await rejoinSession(ID)
    expect(sent.map((c) => [c.method, c.url])).toEqual([['post', `/api/sessions/${ID}/opt-out`], ['post', `/api/sessions/${ID}/rejoin`]])
  })

  it('allows the server long enough to route trips, and writes the id safely into the path', async () => {
    const sent = answer({})
    await refreshSessionSpots('a/b?c', 'added')
    expect(sent[0].url).toBe('/api/sessions/a%2Fb%3Fc/meeting-area')
    expect(SESSION_TIMEOUT_MS).toBeGreaterThanOrEqual(15000)
    expect(sent[0].timeout).toBe(SESSION_TIMEOUT_MS)
  })
})

describe('a refusal', () => {
  // The planner client's own error reader, with the server's answer in it.
  // How to call: refuseWith(409, { error: 'wrong_status', message: 'x' })
  function refuseWith(status, data) {
    api.defaults.adapter = async (config) => {
      throw new AxiosError('failed', 'ERR_BAD_REQUEST', config, {}, { status, data, headers: {}, config })
    }
  }
  it('reaches the caller with the server\'s code and status, whatever the status', async () => {
    for (const [status, error] of [[409, 'wrong_status'], [409, 'no_spots'], [409, 'too_many_spots'], [403, 'host_only'], [404, 'spot_not_found'], [422, 'unknown_area'], [409, 'needs_two_people'], [404, 'session_not_found']]) {
      refuseWith(status, { error, message: 'raw' })
      await expect(putSessionSpot(ID, 'bugis')).rejects.toMatchObject({ code: error, status })
    }
  })

  it('has no code for a lost connection, and says so in words', async () => {
    api.defaults.adapter = async (config) => {
      throw new AxiosError('Network Error', 'ERR_NETWORK', config, {})
    }
    const err = await confirmSessionSpot(ID, 'bugis').catch((e) => e)
    expect(err.code).toBeUndefined()
    expect(err.message).toMatch(/Cannot reach the Jio planner/)
  })
})
