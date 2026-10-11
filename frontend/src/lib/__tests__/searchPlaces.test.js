// Searching for a start or end location (and a spot to meet): MRT areas by name, then real addresses and postal codes
// from OneMap through the backend, which is started in this process with OneMap answered from its fixtures. When the
// backend cannot be reached, the sample addresses are searched instead.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../../backend/src/app.js'
import * as api from '../api.js'
import { AREAS } from '../mock/places.js'

let server
let baseURL

beforeAll(async () => {
  server = createApp({ frontendOrigin: 'http://localhost:5173', stub: true }).listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseURL = `http://127.0.0.1:${server.address().port}`
  api.api.defaults.baseURL = baseURL
})

afterAll(() => server?.close())

describe('searchPlaces', () => {
  it('finds a real postal code with OneMap, named after the area it is in', async () => {
    const results = await api.searchPlaces('178879')
    const court = results.find((r) => r.label === 'Supreme Court Building')
    expect(court).toBeTruthy()
    expect(court.sub).toMatch(/^Singapore 178879 · /)
    expect(AREAS.some((a) => a.id === court.areaId)).toBe(true)
  })

  it('lists matching MRT areas first', async () => {
    const results = await api.searchPlaces('Bishan')
    expect(results[0]).toMatchObject({ label: 'Bishan', sub: 'MRT station and area', areaId: 'bishan' })
  })

  it('waits for two letters before asking OneMap, and an empty search finds nothing', async () => {
    expect(await api.searchPlaces('  ')).toEqual([])
    expect((await api.searchPlaces('b')).every((r) => r.sub === 'MRT station and area')).toBe(true)
  })

  it('still searches the sample addresses when the backend cannot be reached', async () => {
    api.api.defaults.baseURL = 'http://127.0.0.1:9'
    try {
      const results = await api.searchPlaces('Bishan')
      expect(results.length).toBeGreaterThan(0)
    } finally {
      api.api.defaults.baseURL = baseURL
    }
  })
})
