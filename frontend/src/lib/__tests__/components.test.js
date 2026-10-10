// The small pure functions behind three components, imported from the single-file components themselves:
// a past season that fails to load, the hold button's assistive activation, the calendar's keyboard moves, and
// the notice for votes the meeting area took away.
import { describe, expect, it, vi } from 'vitest'
import { loadStandings } from '../../views/LeaderboardView.vue'
import { isAssistiveClick } from '../../components/ui/HoldButton.vue'
import { dayAfterKey } from '../../components/ui/CalendarPicker.vue'
import { votesClearedBanner } from '../../components/event/SessionNotices.vue'

describe('loading a past season', () => {
  it('hands back the rows when the load works', async () => {
    const fetchRows = vi.fn().mockResolvedValue([{ id: 'darius' }])
    expect(await loadStandings(fetchRows, 1)).toEqual({ rows: [{ id: 'darius' }], failed: false })
    expect(fetchRows).toHaveBeenCalledWith(1)
  })

  it('reports a failure instead of throwing, so the screen can offer Try again', async () => {
    const fetchRows = vi.fn().mockRejectedValue(new Error('offline'))
    await expect(loadStandings(fetchRows, 1)).resolves.toEqual({ rows: [], failed: true })
  })
})

describe('the hold button', () => {
  it('is activated at once by a click that is not from a pointer (a screen reader, switch or voice control)', () => {
    expect(isAssistiveClick({ detail: 0 })).toBe(true)
  })

  it('still needs the hold for a mouse or touch click', () => {
    expect(isAssistiveClick({ detail: 1 })).toBe(false)
    expect(isAssistiveClick({ detail: 2 })).toBe(false)
  })

  it('does not count the click that ends a held key, which already had its hold', () => {
    expect(isAssistiveClick({ detail: 0 }, true)).toBe(false)
  })
})

describe('the calendar keyboard', () => {
  const from = '2026-10-14' // a Wednesday
  it.each([
    ['ArrowLeft', '2026-10-13'],
    ['ArrowRight', '2026-10-15'],
    ['ArrowUp', '2026-10-07'],
    ['ArrowDown', '2026-10-21'],
    ['Home', '2026-10-12'],
    ['End', '2026-10-18'],
    ['PageUp', '2026-09-14'],
    ['PageDown', '2026-11-14'],
  ])('moves on %s', (key, expected) => {
    expect(dayAfterKey(from, key)).toBe(expected)
  })

  it('leaves other keys alone', () => {
    expect(dayAfterKey(from, 'a')).toBeNull()
    expect(dayAfterKey(from, 'Tab')).toBeNull()
  })

  it('stays inside the days that can be picked', () => {
    expect(dayAfterKey(from, 'PageUp', '2026-10-10')).toBe('2026-10-10')
    expect(dayAfterKey(from, 'PageDown', '', '2026-10-31')).toBe('2026-10-31')
  })
})

describe('the votes-cleared notice', () => {
  const banner = { text: 'Meeting area moved. Votes for places were cleared.', at: 1, votesCleared: true }

  it('shows while voting, when the data layer marked the banner', () => {
    expect(votesClearedBanner({ status: 'voting', banner })).toBe(banner)
  })

  it('leaves the other banners out', () => {
    expect(votesClearedBanner({ status: 'voting', banner: { text: 'Meeting area stays at Bishan.', at: 1 } })).toBeNull()
    expect(votesClearedBanner({ status: 'voting', banner: null })).toBeNull()
  })

  it('is not shown once the session has moved on from voting', () => {
    expect(votesClearedBanner({ status: 'confirmed', banner })).toBeNull()
  })
})
