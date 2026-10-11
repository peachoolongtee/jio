// What the Confirm dialog decides without a screen: the two orders, which one is shown and selected, what Confirm
// hands over, and the words that say where a suggestion came from.
import { describe, expect, it } from 'vitest'
import { ORDER_TABS, SUGGESTED, VOTED, confirmKey, confirmView, sourceIcon, sourceText, suggestedRows, usableSuggestion, votedRows } from '../confirmOrder.js'

const option = (id, name) => ({ venue: { id, name } })
// Voted order: eat, then activity, then shop.
const WINNERS = [
  { stop: { category: 'eat', time: '12:00', duration: 60 }, option: option('v-eat', 'Cafe') },
  { stop: { category: 'activity', time: '13:30', duration: 90 }, option: option('v-act', 'Bowling') },
  { stop: { category: 'shop', time: '15:30', duration: 60 }, option: option('v-shop', 'Mall') },
]
const stop = (slotId, category, venueId, name, start, duration) => ({ slotId, category, venueId, name, start, duration })
// The same places, shop moved to the front.
const SUGGESTION = {
  order: ['shop', 'eat', 'activity'],
  stops: [stop('shop', 'shop', 'v-shop', 'Mall', 600, 60), stop('eat', 'eat', 'v-eat', 'Cafe', 720, 60), stop('activity', 'activity', 'v-act', 'Bowling', 810, 90)],
  reason: 'Shops first while you are fresh.',
  source: 'ai',
}
const voted = votedRows(WINNERS)

describe('the rows', () => {
  it('writes the voted rows at their slot times, and the suggested rows at the suggested times', () => {
    expect(voted.map((r) => [r.category, r.name, r.when])).toEqual([
      ['eat', 'Cafe', '12:00 · 1 h'],
      ['activity', 'Bowling', '13:30 · 1 h 30 min'],
      ['shop', 'Mall', '15:30 · 1 h'],
    ])
    expect(suggestedRows(SUGGESTION).map((r) => [r.category, r.when])).toEqual([
      ['shop', '10:00 · 1 h'],
      ['eat', '12:00 · 1 h'],
      ['activity', '13:30 · 1 h 30 min'],
    ])
  })

  it('says "No place" for a stop nobody has a place for', () => {
    expect(votedRows([{ stop: WINNERS[0].stop, option: undefined }])[0]).toMatchObject({ name: 'No place', venueId: null })
  })
})

describe('the question', () => {
  const session = { date: '2026-10-10', start: '10:00', end: '18:00' }
  it('is the same text for the same stops and times, and changes with any of them', () => {
    const key = confirmKey(WINNERS, session, false)
    expect(confirmKey(structuredClone(WINNERS), { ...session }, false)).toBe(key)
    expect(confirmKey(WINNERS, { ...session, end: '19:00' }, false)).not.toBe(key)
    expect(confirmKey(WINNERS, session, true)).not.toBe(key)
    expect(confirmKey([WINNERS[0], { ...WINNERS[1], option: option('other', 'Arcade') }, WINNERS[2]], session, false)).not.toBe(key)
    expect(confirmKey(WINNERS.slice(0, 2), session, false)).not.toBe(key)
  })
})

describe('which order is shown and selected', () => {
  it('shows the voted order, with no choice, before any suggestion', () => {
    expect(confirmView({ voted, suggestion: null })).toEqual({ rows: voted, choice: false, selected: VOTED, pass: null, note: null })
  })

  it('offers the choice with the voted order selected when a different order arrives', () => {
    const view = confirmView({ voted, suggestion: SUGGESTION })
    expect(view.choice).toBe(true)
    expect(view.selected).toBe(VOTED)
    expect(view.rows).toBe(voted)
    expect(view.pass).toBeNull()
    expect(view.note).toEqual({ reason: SUGGESTION.reason, source: 'ai' })
  })

  it('shows the suggested rows and hands over the suggestion only after the host picks it', () => {
    const view = confirmView({ voted, suggestion: SUGGESTION, picked: SUGGESTED })
    expect(view.selected).toBe(SUGGESTED)
    expect(view.rows.map((r) => r.category)).toEqual(['shop', 'eat', 'activity'])
    expect(view.pass).toBe(SUGGESTION)
  })

  it('goes back to the voted order, and passes nothing, when the host picks it again', () => {
    const back = confirmView({ voted, suggestion: SUGGESTION, picked: VOTED })
    expect(back.rows.map((r) => r.category)).toEqual(['eat', 'activity', 'shop'])
    expect(back.pass).toBeNull()
  })

  it('never reorders the rows by itself: with no pick it stays on the voted order', () => {
    expect(confirmView({ voted, suggestion: SUGGESTION, picked: undefined }).rows).toBe(voted)
  })

  it('has no choice when the suggestion keeps the voted order, and applies its times', () => {
    const same = {
      ...SUGGESTION,
      order: ['eat', 'activity', 'shop'],
      stops: [stop('eat', 'eat', 'v-eat', 'Cafe', 720, 60), stop('activity', 'activity', 'v-act', 'Bowling', 810, 90), stop('shop', 'shop', 'v-shop', 'Mall', 930, 60)],
    }
    const view = confirmView({ voted, suggestion: same, picked: VOTED })
    expect(view.choice).toBe(false)
    expect(view.pass).toBe(same)
    expect(view.rows.map((r) => r.when)).toEqual(['12:00 · 1 h', '13:30 · 1 h 30 min', '15:30 · 1 h'])
  })

  it('shows no choice for an answer with other places than the votes (a tie that came out differently)', () => {
    const other = { ...SUGGESTION, stops: SUGGESTION.stops.map((s) => (s.category === 'shop' ? { ...s, venueId: 'v-other' } : s)) }
    expect(usableSuggestion(voted, other)).toBeNull()
    expect(confirmView({ voted, suggestion: other, picked: SUGGESTED })).toMatchObject({ choice: false, selected: VOTED, pass: null, note: null })
    expect(usableSuggestion(voted, { ...SUGGESTION, stops: SUGGESTION.stops.slice(1) })).toBeNull()
    expect(usableSuggestion(voted, { stops: [] })).toBeNull()
    expect(usableSuggestion(voted, null)).toBeNull()
    expect(usableSuggestion(votedRows([{ stop: WINNERS[0].stop }]), { stops: [stop('eat', 'eat', null, 'x', 600, 60)] })).toBeNull()
  })

  it('labels the two choices, voted first', () => {
    expect(ORDER_TABS).toEqual([
      { id: VOTED, label: 'Voted order' },
      { id: SUGGESTED, label: 'Suggested order' },
    ])
  })
})

describe('where a sentence came from', () => {
  it('introduces an AI sentence as an AI suggestion', () => {
    expect(sourceText({ reason: 'Shops first.', source: 'ai' })).toBe('AI suggestion: Shops first.')
    expect(sourceText({ reason: '  ', source: 'ai' })).toBe('Order suggested by AI.')
  })

  it('describes a rules answer by travel and waiting time, and says nothing about the AI', () => {
    const text = sourceText({ reason: 'This order keeps every stop a short walk from the next.', source: 'rules' })
    expect(text).toBe('Suggestion chosen by travel and waiting time. This order keeps every stop a short walk from the next.')
    expect(text).not.toMatch(/\bAI\b|off|least/i)
    expect(sourceText({ reason: '', source: 'rules' })).toBe('Suggestion chosen by travel and waiting time.')
  })

  it('treats a missing or odd source as rules, and shows the sparkle only for the AI', () => {
    expect(sourceText({ reason: 'x', source: 'gpt' })).toMatch(/^Suggestion chosen by travel and waiting time/)
    expect(sourceText(null)).toBe('Suggestion chosen by travel and waiting time.')
    expect(sourceIcon({ source: 'ai' })).toBe('sparkle')
    expect(sourceIcon({ source: 'rules' })).toBe('route')
    expect(sourceIcon(null)).toBe('route')
  })
})
