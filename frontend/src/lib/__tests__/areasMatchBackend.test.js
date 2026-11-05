import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AREAS } from '../mock/places.js'

describe('meeting area data', () => {
  it('matches the backend planner area list', () => {
    const path = new URL('../../../../backend/src/db/mock/areas.json', import.meta.url)
    const backend = JSON.parse(readFileSync(path, 'utf8')).areas
    expect(AREAS).toEqual(backend)
  })
})
