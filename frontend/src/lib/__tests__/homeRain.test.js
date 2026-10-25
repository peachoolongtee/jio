// Rain on Home's map: which outings count, what is asked, what is drawn and said, and that nothing is asked, scheduled or drawn
// when no outing is within two hours. The asking is done by a small component built here around useHomeRain, with the clock
// and the planner's answer in the test's hands.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount } from './miniDom.js'
import { MAX_PLACES, outingsSoon, rainView, stopsFor } from '../homeRain.js'
import { useHomeRain } from '../useHomeRain.js'
import { CHECK_EVERY_MS } from '../weatherCheck.js'

const MIN = 60 * 1000
const BISHAN = { id: 'bishan', name: 'Bishan', lat: 1.3508, lng: 103.8485 }
const TAMPINES = { id: 'tampines', name: 'Tampines', lat: 1.3496, lng: 103.9568 }
// A live two-hour forecast, current from 12:00 to 17:00 on the day the tests are about.
const LIVE = { source: 'live', basis: 'area', issuedAt: '2026-10-10T12:00:00+08:00', validUntil: '2026-10-10T17:00:00+08:00' }
const meetup = (over = {}) => ({ id: 'm1', title: 'Saturday', status: 'confirmed', date: '2026-10-10', start: '15:00', end: '18:00', isToday: false, area: BISHAN, ...over })
// Local time, as Home's clock is.
// An instant on a day in Singapore (a fixed offset, so it is the same in any time zone the tests run in).
const at = (hhmm, day = '2026-10-10') => new Date(`${day}T${hhmm}:00+08:00`)

describe('which outings count', () => {
  it('is an outing that starts within two hours, or is under way', () => {
    expect(outingsSoon([meetup()], at('13:00'))).toHaveLength(1)
    expect(outingsSoon([meetup()], at('14:30'))).toHaveLength(1)
    expect(outingsSoon([meetup()], at('16:30'))).toHaveLength(1)
  })

  it('is not an outing more than two hours away, one that has ended, or one with no meeting point', () => {
    expect(outingsSoon([meetup()], at('12:59'))).toHaveLength(0)
    expect(outingsSoon([meetup()], at('09:00'))).toHaveLength(0)
    expect(outingsSoon([meetup()], at('18:00'))).toHaveLength(0)
    expect(outingsSoon([meetup()], at('10:00', '2026-10-09'))).toHaveLength(0)
    expect(outingsSoon([meetup({ area: null })], at('15:00'))).toHaveLength(0)
    expect(outingsSoon([], at('15:00'))).toEqual([])
    expect(outingsSoon(undefined, at('15:00'))).toEqual([])
  })

  it('moves to today with the demo\'s session-day switch, as the countdown does', () => {
    const m = meetup({ date: '2026-12-25', isToday: true })
    expect(outingsSoon([m], at('14:00'))).toHaveLength(1)
    expect(outingsSoon([{ ...m, isToday: false }], at('14:00'))).toHaveLength(0)
  })

  it('reads an end after midnight as the next day', () => {
    const late = meetup({ start: '22:00', end: '01:00' })
    expect(outingsSoon([late], at('23:30'))).toHaveLength(1)
    expect(outingsSoon([late], at('00:30', '2026-10-11'))).toHaveLength(1)
    expect(outingsSoon([late], at('01:00', '2026-10-11'))).toHaveLength(0)
  })

  it('does not crash on a meetup with no times', () => {
    expect(outingsSoon([meetup({ start: undefined })], at('15:00'))).toEqual([])
    expect(outingsSoon([meetup({ end: undefined })], at('15:00'))).toHaveLength(1)
  })
})

describe('what is asked', () => {
  it('is one stop for each meeting area, at the outing\'s start, with its point', () => {
    const stops = stopsFor([meetup(), meetup({ id: 'm2', start: '16:00' }), meetup({ id: 'm3', area: TAMPINES })], at('14:00'))
    expect(stops).toEqual([
      { id: 'bishan', point: { lat: 1.3508, lng: 103.8485 }, start: '2026-10-10T15:00' },
      { id: 'tampines', point: { lat: 1.3496, lng: 103.9568 }, start: '2026-10-10T15:00' },
    ])
  })

  it('is never more than the planner takes at once', () => {
    const many = Array.from({ length: 12 }, (_, i) => meetup({ id: `m${i}`, area: { ...BISHAN, id: `a${i}` } }))
    expect(stopsFor(many, at('14:00'))).toHaveLength(MAX_PLACES)
    expect(MAX_PLACES).toBe(8)
  })
})

describe('what is drawn and said', () => {
  const answer = (rainy) => ({ stops: Object.fromEntries(['bishan', 'tampines'].map((id) => [id, { state: rainy.includes(id) ? 'showers' : 'dry', rainLikely: rainy.includes(id) }])), weather: LIVE })
  const outings = [meetup(), meetup({ id: 'm2', area: TAMPINES })]

  it('is each place where rain is likely, with the words for it', () => {
    const view = rainView(outings, answer(['bishan']), at('14:00'))
    expect(view.places).toEqual([{ id: 'bishan', name: 'Bishan', lat: 1.3508, lng: 103.8485 }])
    expect(view.text).toBe('Rain likely around Bishan in the next two hours')
    expect(view.block).toEqual(LIVE)
    expect(rainView(outings, answer(['bishan', 'tampines']), at('14:00')).text).toBe('Rain likely around Bishan and Tampines in the next two hours')
  })

  it('words the line by where the forecast came from: no time for a 24-hour forecast, "Simulated rain" for the demo\'s', () => {
    expect(rainView(outings, { ...answer(['bishan']), weather: { ...LIVE, basis: 'regional' } }, at('14:00')).text).toBe('Rain likely around Bishan')
    expect(rainView(outings, { ...answer(['bishan']), weather: { source: 'simulated', basis: 'simulated' } }, at('14:00')).text).toBe('Simulated rain around Bishan')
  })

  it('draws nothing from a forecast that has run out, and from one with no times, but keeps a simulated one', () => {
    expect(rainView(outings, answer(['bishan']), at('17:00'))).toBeNull()
    expect(rainView(outings, answer(['bishan']), at('16:59'))).not.toBeNull()
    expect(rainView(outings, { ...answer(['bishan']), weather: { source: 'live', basis: 'area' } }, at('14:00'))).toBeNull()
    // With no end time the forecast is current for two hours from when it was issued.
    expect(rainView(outings, { ...answer(['bishan']), weather: { source: 'live', basis: 'area', issuedAt: LIVE.issuedAt } }, at('13:59'))).not.toBeNull()
    expect(rainView(outings, { ...answer(['bishan']), weather: { source: 'live', basis: 'area', issuedAt: LIVE.issuedAt } }, at('14:00'))).toBeNull()
    expect(rainView(outings, { ...answer(['bishan']), weather: { source: 'simulated', basis: 'simulated' } }, at('23:00', '2026-10-12'))).not.toBeNull()
  })

  it('draws nothing when the answer does not say where the forecast came from', () => {
    expect(rainView(outings, { ...answer(['bishan']), weather: null }, at('14:00'))).toBeNull()
    expect(rainView(outings, { ...answer(['bishan']), weather: { source: 'unavailable' } }, at('14:00'))).toBeNull()
  })

  it('is nothing when no place has rain likely, or there is no answer yet', () => {
    expect(rainView(outings, answer([]), at('14:00'))).toBeNull()
    expect(rainView(outings, null)).toBeNull()
    expect(rainView(outings, {})).toBeNull()
  })
})

describe('Home asking', () => {
  let clock
  let ask
  let meetups
  let simulated
  let seen
  const mountRain = () =>
    mount(defineComponent({
      setup() {
        const rain = useHomeRain({ meetups, now: clock, simulated, ask, check: { hidden: () => false, onVisibility: () => () => {} } })
        seen = rain
        return () => h('div', { 'data-testid': 'rain' }, rain.view.value ? rain.view.value.text : 'dry')
      },
    }))
  const rainy = (ids) => ({ stops: Object.fromEntries(ids.map((id) => [id, { state: 'showers', rainLikely: true, source: 'live', basis: 'area', validUntil: LIVE.validUntil }])), weather: LIVE })

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(at('14:00'))
    clock = ref(new Date())
    meetups = ref([meetup()])
    simulated = ref(false)
    ask = vi.fn(async () => rainy(['bishan']))
  })
  afterEach(() => vi.useRealTimers())

  it('asks nothing, schedules nothing and draws nothing without an outing within two hours', async () => {
    meetups.value = [meetup({ start: '19:00', end: '21:00' }), meetup({ id: 'm2', status: 'inviting', area: null })]
    const page = mount(defineComponent({ setup() { const rain = useHomeRain({ meetups, now: clock, simulated, ask }); return () => h('div', rain.view.value ? 'rain' : 'none') } }))
    await vi.advanceTimersByTimeAsync(3 * CHECK_EVERY_MS)
    expect(ask).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(page.text()).toBe('none')
    // And with no meetups at all.
    meetups.value = []
    await vi.advanceTimersByTimeAsync(3 * CHECK_EVERY_MS)
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks once for an outing within two hours, and draws the rain where it is likely, with the words', async () => {
    const page = mountRain()
    await vi.advanceTimersByTimeAsync(10)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask).toHaveBeenCalledWith([{ id: 'bishan', point: { lat: 1.3508, lng: 103.8485 }, start: '2026-10-10T15:00' }])
    expect(page.text()).toBe('Rain likely around Bishan in the next two hours')
    expect(seen.view.value.places).toHaveLength(1)
  })

  it('draws nothing when the forecast is dry there', async () => {
    ask.mockResolvedValue({ stops: { bishan: { state: 'dry', rainLikely: false } }, weather: { ...LIVE, basis: undefined } })
    const page = mountRain()
    await vi.advanceTimersByTimeAsync(10)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(page.text()).toBe('dry')
  })

  it('asks again every 30 minutes while the outing is within two hours, and not before', async () => {
    mountRain()
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS - MIN)
    expect(ask).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('does not ask twice when the clock ticks, or when the meetups are listed again', async () => {
    mountRain()
    await vi.advanceTimersByTimeAsync(10)
    for (let i = 0; i < 5; i++) {
      clock.value = new Date(Date.now() + i * 1000)
      meetups.value = [{ ...meetup() }]
      await vi.advanceTimersByTimeAsync(10)
    }
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('starts asking when an outing comes within two hours, once, and stops when it is over', async () => {
    vi.setSystemTime(at('11:00'))
    clock.value = new Date()
    const page = mountRain()
    await vi.advanceTimersByTimeAsync(10)
    expect(ask).not.toHaveBeenCalled()
    expect(page.text()).toBe('dry')
    vi.setSystemTime(at('13:30'))
    clock.value = new Date()
    await vi.advanceTimersByTimeAsync(10)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(page.text()).toContain('Rain likely around Bishan')
    // The outing ends: the layer goes, and so does the schedule.
    vi.setSystemTime(at('18:30'))
    clock.value = new Date()
    await vi.advanceTimersByTimeAsync(10)
    expect(page.text()).toBe('dry')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(3 * CHECK_EVERY_MS)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('asks again at once when the demo\'s rain switch is flipped', async () => {
    mountRain()
    await vi.advanceTimersByTimeAsync(10)
    ask.mockResolvedValue({ stops: { bishan: { state: 'showers', rainLikely: true, source: 'simulated', basis: 'simulated' } }, weather: { source: 'simulated', basis: 'simulated' } })
    simulated.value = true
    await vi.advanceTimersByTimeAsync(10)
    expect(ask).toHaveBeenCalledTimes(2)
    expect(seen.view.value.block).toEqual({ source: 'simulated', basis: 'simulated' })
  })

  it('keeps the last answer when a request fails, and says nothing wrong', async () => {
    const page = mountRain()
    await vi.advanceTimersByTimeAsync(10)
    ask.mockRejectedValue(new Error('down'))
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS + 10)
    expect(ask).toHaveBeenCalledTimes(2)
    expect(seen.failed.value).toBe(true)
    expect(page.text()).toBe('Rain likely around Bishan in the next two hours')
  })

  it('asks again when the places change, and throws an answer away that was for other places', async () => {
    let finish
    ask.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const page = mountRain()
    await vi.advanceTimersByTimeAsync(10)
    expect(ask).toHaveBeenCalledTimes(1)
    // The meeting area moves while the answer is on its way.
    meetups.value = [meetup({ area: TAMPINES })]
    await vi.advanceTimersByTimeAsync(10)
    ask.mockResolvedValue(rainy(['tampines']))
    finish(rainy(['bishan']))
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(10)
    expect(page.text()).not.toContain('Bishan')
    expect(ask.mock.calls.length).toBeLessThanOrEqual(3)
    expect(page.text()).toContain('Tampines')
  })

  it('stops when Home is left', async () => {
    const page = mountRain()
    await vi.advanceTimersByTimeAsync(10)
    page.app.unmount()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(3 * CHECK_EVERY_MS)
    expect(ask).toHaveBeenCalledTimes(1)
  })
})
