// The pure parts of place search: names, repeats, one row per area, what the sheet says, and the guard that drops a
// slower earlier answer.
import { describe, expect, it } from 'vitest'
import { SEARCH_MIN_CHARS, createLatest, displayName, isCancelled, sameKey, searchStatus, toSpotRows } from '../placeSearch.js'

describe('displayName', () => {
  it('writes OneMap\'s capitals the way a person reads them', () => {
    expect(displayName('TAMPINES MALL')).toBe('Tampines Mall')
    expect(displayName('  ST. ANDREW\'S   VILLAGE ')).toBe('St. Andrew\'s Village')
  })
  it('keeps station and campus acronyms, and leaves mixed case alone', () => {
    expect(displayName('TAMPINES MRT STATION')).toBe('Tampines MRT Station')
    expect(displayName('HDB HUB')).toBe('HDB Hub')
    expect(displayName('ION Orchard')).toBe('ION Orchard')
    expect(displayName('1 SUPREME COURT LANE')).toBe('1 Supreme Court Lane')
  })
  it('is empty for nothing', () => {
    expect(displayName(null)).toBe('')
    expect(displayName('   ')).toBe('')
  })
})

describe('sameKey', () => {
  it('treats a station and its area as one name', () => {
    expect(sameKey('TAMPINES MRT STATION')).toBe(sameKey('Tampines'))
    expect(sameKey('Bishan Station (NS17)')).toBe('bishan ns17')
    expect(sameKey('Tampines Mall')).not.toBe(sameKey('Tampines'))
  })
})

const row = (areaId, areaName, near, extra = {}) => ({ id: `r-${areaId}-${near}`, label: near || areaName, sub: `Singapore 000000 · ${areaName}`, areaId, areaName, near, ...extra })

describe('toSpotRows', () => {
  it('shows each row as its area, with the place searched as the second line', () => {
    expect(toSpotRows([row('tampines', 'Tampines', 'Tampines Mall')])).toEqual([
      { id: 'spot-tampines', label: 'Tampines', sub: 'Near Tampines Mall', areaId: 'tampines' },
    ])
  })
  it('lists an area once, the first row winning, so an area row stays ahead of an address in it', () => {
    const area = { id: 'tampines', label: 'Tampines', sub: 'MRT station and area', areaId: 'tampines', areaName: 'Tampines', near: null }
    const rows = toSpotRows([area, row('tampines', 'Tampines', 'Tampines Mall'), row('pasir-ris', 'Pasir Ris', 'Tampines Avenue 5'), row('tampines', 'Tampines', 'Tampines Hub')])
    expect(rows.map((r) => r.areaId)).toEqual(['tampines', 'pasir-ris'])
    expect(rows[0].sub).toBe('MRT station and area')
    expect(rows[1]).toMatchObject({ label: 'Pasir Ris', sub: 'Near Tampines Avenue 5' })
  })
  it('passes on the area and nothing about the place beyond its name', () => {
    const [only] = toSpotRows([row('tampines', 'Tampines', 'Tampines Mall', { lat: 1.35, lng: 103.94, postal: '529510' })])
    expect(Object.keys(only).sort()).toEqual(['areaId', 'id', 'label', 'sub'])
    expect(only.label).toBe('Tampines')
  })
})

describe('searchStatus', () => {
  const base = { query: 'zzz', pending: false, unavailable: false, count: 0 }
  it('says nothing for an empty field', () => {
    expect(searchStatus({ ...base, query: '' })).toBe('')
  })
  it('says it is searching, whatever else is true', () => {
    expect(searchStatus({ ...base, pending: true, unavailable: true, count: 3 })).toBe('Searching…')
  })
  it('says plainly that nothing matches, and suggests a postal code or a nearby MRT station', () => {
    expect(searchStatus(base)).toBe('No places match "zzz". Try a postal code or a nearby MRT station.')
  })
  it('asks for more characters rather than suggesting a postal code for a single letter', () => {
    expect(searchStatus({ ...base, query: 'z' })).toContain('Type two or more characters')
    expect(SEARCH_MIN_CHARS).toBe(2)
  })
  it('says in one line that the wider search is down, and also that nothing matched when that is so', () => {
    expect(searchStatus({ ...base, unavailable: true, count: 2 })).toBe('Address search is not available right now, so only areas Jio already knows are listed.')
    expect(searchStatus({ ...base, unavailable: true })).toBe('No places match "zzz". Address search is not available right now, so only areas Jio already knows are listed.')
  })
  it('says nothing when there are rows and nothing is wrong', () => {
    expect(searchStatus({ ...base, count: 4 })).toBe('')
  })
})

describe('createLatest', () => {
  const deferred = () => {
    let resolve
    const promise = new Promise((r) => { resolve = r })
    return { promise, resolve }
  }

  it('drops a slower earlier answer instead of showing it over a newer one', async () => {
    const latest = createLatest()
    let shown = null
    const ask = async (name, wait) => {
      const job = latest.start()
      const answer = await wait.promise
      if (job.current()) shown = `${name}:${answer}`
    }
    const slow = deferred()
    const fast = deferred()
    const first = ask('tampines', slow)
    const second = ask('tampines mall', fast)
    fast.resolve('mall rows')
    await second
    slow.resolve('stale rows')
    await first
    expect(shown).toBe('tampines mall:mall rows')
  })

  it('aborts the search it replaces and the one that is cancelled', () => {
    const latest = createLatest()
    const one = latest.start()
    const two = latest.start()
    expect(one.signal.aborted).toBe(true)
    expect(one.current()).toBe(false)
    expect(two.signal.aborted).toBe(false)
    expect(two.current()).toBe(true)
    latest.cancel()
    expect(two.signal.aborted).toBe(true)
    expect(two.current()).toBe(false)
  })

  it('knows a cancelled search by its name or code', () => {
    expect(isCancelled(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true)
    expect(isCancelled({ code: 'ERR_CANCELED' })).toBe(true)
    expect(isCancelled(new Error('Cannot reach the Jio planner'))).toBe(false)
    expect(isCancelled(null)).toBe(false)
  })
})
