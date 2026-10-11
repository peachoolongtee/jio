// The two checks on an order suggestion before it is kept: its sentence is made safe, and its times are applied only
// when they belong to its order.
import { describe, expect, it } from 'vitest'
import { REASON_MAX, cleanReason, suggestionFits } from '../itinerary.js'

describe('cleanReason', () => {
  it('turns control characters and line breaks into single spaces', () => {
    expect(cleanReason('Shops first.\n\nThen\tlunch.\u0007 Done. ')).toBe('Shops first. Then lunch. Done.')
    expect(cleanReason('a\u0000b\u001bc\u007fd\u009fe')).toBe('a b c d e')
  })

  it('cuts to 200 characters, without splitting an emoji', () => {
    expect(cleanReason('x'.repeat(500))).toHaveLength(REASON_MAX)
    expect(REASON_MAX).toBe(200)
    const cut = cleanReason('a'.repeat(199) + '\u{1F600}\u{1F600}')
    expect([...cut]).toHaveLength(200)
    expect(cut.endsWith('\u{1F600}')).toBe(true)
  })

  it('keeps markup as plain text and gives an empty string for anything that is not text', () => {
    expect(cleanReason('<b>Bold</b> & "quotes"')).toBe('<b>Bold</b> & "quotes"')
    for (const x of [undefined, null, 5, {}, ['a']]) expect(cleanReason(x)).toBe('')
  })
})

describe('suggestionFits', () => {
  const stops = [
    { slotId: 'eat', category: 'eat', venueId: 'v1', plannedStart: 720, duration: 60 },
    { slotId: 'activity', category: 'activity', venueId: 'v2', plannedStart: 800, duration: 90 },
    { slotId: 'shop', category: 'shop', venueId: 'v3', plannedStart: 900, duration: 60 },
  ]
  const timed = (slotId, start) => {
    const s = stops.find((x) => x.slotId === slotId)
    return { slotId, category: s.category, venueId: s.venueId, duration: s.duration, start }
  }
  const good = { order: ['shop', 'eat', 'activity'], stops: [timed('shop', 600), timed('eat', 720), timed('activity', 800)] }

  it('accepts times that belong to the order they name', () => {
    expect(suggestionFits(stops, good)).toBe(true)
    // The voted order itself, with a stop waiting for its meal time.
    expect(suggestionFits(stops, { order: ['activity', 'eat', 'shop'], stops: [timed('activity', 600), timed('eat', 720), timed('shop', 800)] })).toBe(true)
  })

  it('rejects an answer for other stops', () => {
    expect(suggestionFits(stops, { ...good, stops: good.stops.map((s) => (s.slotId === 'shop' ? { ...s, venueId: 'other' } : s)) })).toBe(false)
    expect(suggestionFits(stops, { ...good, stops: good.stops.map((s) => (s.slotId === 'shop' ? { ...s, duration: 30 } : s)) })).toBe(false)
    expect(suggestionFits(stops, { ...good, stops: good.stops.map((s) => (s.slotId === 'shop' ? { ...s, category: 'drink' } : s)) })).toBe(false)
    expect(suggestionFits(stops, { order: good.order.slice(1), stops: good.stops.slice(1) })).toBe(false)
    expect(suggestionFits(stops.slice(1), good)).toBe(false)
    expect(suggestionFits([], { order: [], stops: [] })).toBe(false)
  })

  it('rejects times that do not belong to the order', () => {
    // The order says shop first but the times are those of another order.
    expect(suggestionFits(stops, { order: good.order, stops: [timed('eat', 720), timed('shop', 800), timed('activity', 900)] })).toBe(false)
    // Same slots, but one listed twice.
    expect(suggestionFits(stops, { order: ['shop', 'shop', 'eat'], stops: [timed('shop', 600), timed('shop', 700), timed('eat', 800)] })).toBe(false)
    // A stop that starts before the one before it has ended.
    expect(suggestionFits(stops, { order: good.order, stops: [timed('shop', 600), timed('eat', 630), timed('activity', 800)] })).toBe(false)
    // A meal earlier than its time from voting.
    expect(suggestionFits(stops, { order: good.order, stops: [timed('shop', 600), timed('eat', 700), timed('activity', 800)] })).toBe(false)
  })

  it('rejects times that are not sensible numbers, and answers that are not lists', () => {
    for (const start of [NaN, undefined, '600', -5, 5000]) {
      expect(suggestionFits(stops, { order: good.order, stops: [timed('shop', start), timed('eat', 720), timed('activity', 800)] })).toBe(false)
    }
    expect(suggestionFits(stops, null)).toBe(false)
    expect(suggestionFits(stops, { order: 'shop', stops: good.stops })).toBe(false)
    expect(suggestionFits(stops, { order: good.order })).toBe(false)
  })
})
