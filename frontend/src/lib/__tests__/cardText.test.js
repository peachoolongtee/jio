// The words on a Vote card that are worked out: the opening-hours tag, the tags shown, who voted, and where walks are from.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cardTags, hoursNote, openPeriods, votersText, walkFromText } from '../cardText.js'

const at = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }

describe('hoursNote', () => {
  it('says "Open until" when the place is open through the whole stop', () => {
    expect(hoursNote(['10:00-22:00'], at('19:00'), 90)).toEqual({ text: 'Open until 22:00', tone: 'neutral' })
    // A stop that ends exactly at closing time is still inside the hours.
    expect(hoursNote(['10:00-22:00'], at('20:30'), 90)).toEqual({ text: 'Open until 22:00', tone: 'neutral' })
  })

  it('warns "Closes at" when the place closes during the stop', () => {
    expect(hoursNote(['10:00-21:00'], at('20:00'), 90)).toEqual({ text: 'Closes at 21:00', tone: 'warning' })
  })

  it('warns "Closed at this time" when the place is not open at the start, before opening or after closing', () => {
    expect(hoursNote(['11:00-21:00'], at('09:00'), 60)).toEqual({ text: 'Closed at this time', tone: 'warning' })
    expect(hoursNote(['11:00-21:00'], at('21:00'), 60)).toEqual({ text: 'Closed at this time', tone: 'warning' })
    expect(hoursNote(['11:00-21:00'], at('22:30'), 60)).toEqual({ text: 'Closed at this time', tone: 'warning' })
  })

  it('reads hours that run past midnight correctly', () => {
    expect(hoursNote(['18:00-01:00'], at('20:00'), 90)).toEqual({ text: 'Open until 01:00', tone: 'neutral' })
    expect(hoursNote(['18:00-01:00'], at('23:30'), 120)).toEqual({ text: 'Closes at 01:00', tone: 'warning' })
    // A stop in the small hours falls inside the night before's opening.
    expect(hoursNote(['18:00-03:00'], at('01:00'), 60)).toEqual({ text: 'Open until 03:00', tone: 'neutral' })
    expect(hoursNote(['18:00-03:00'], at('04:00'), 60)).toEqual({ text: 'Closed at this time', tone: 'warning' })
  })

  it('gives nothing when the place lists no hours, or the stop has no time', () => {
    expect(hoursNote([], at('12:00'), 60)).toBeNull()
    expect(hoursNote(undefined, at('12:00'), 60)).toBeNull()
    expect(hoursNote(null, at('12:00'), 60)).toBeNull()
    expect(hoursNote(['not hours', ''], at('12:00'), 60)).toBeNull()
    expect(hoursNote(['10:00-22:00'], undefined, 60)).toBeNull()
    expect(hoursNote(['10:00-22:00'], at('12:00'), undefined)).toBeNull()
    expect(hoursNote(['10:00-22:00'], null, null)).toBeNull()
  })

  it('uses the period the stop falls in when there are several in a day', () => {
    const split = ['12:00-14:30', '18:00-22:30']
    expect(hoursNote(split, at('12:30'), 60)).toEqual({ text: 'Open until 14:30', tone: 'neutral' })
    expect(hoursNote(split, at('19:00'), 90)).toEqual({ text: 'Open until 22:30', tone: 'neutral' })
    expect(hoursNote(split, at('14:00'), 90)).toEqual({ text: 'Closes at 14:30', tone: 'warning' })
    expect(hoursNote(split, at('16:00'), 60)).toEqual({ text: 'Closed at this time', tone: 'warning' })
  })

  it('joins periods that touch, so a lunch and a dinner service that meet read as one', () => {
    expect(openPeriods(['11:00-14:00', '14:00-22:00'])).toContainEqual([660, 1320])
    expect(hoursNote(['11:00-14:00', '14:00-22:00'], at('13:00'), 120)).toEqual({ text: 'Open until 22:00', tone: 'neutral' })
  })

  it('says "Open 24 hours" for a place that is always open, and never prints an hour like 24:00', () => {
    expect(hoursNote(['00:00-24:00'], at('15:00'), 120)).toEqual({ text: 'Open 24 hours', tone: 'neutral' })
    expect(hoursNote(['00:00-23:59'], at('15:00'), 120)).toEqual({ text: 'Open 24 hours', tone: 'neutral' })
    expect(hoursNote(['09:00-24:00'], at('15:00'), 120).text).toBe('Open until midnight')
    expect(hoursNote(['09:00-24:00'], at('23:00'), 90).text).toBe('Closes at midnight')
  })

  it('never prints "undefined" or an empty tag', () => {
    for (const hours of [['10:00-22:00'], ['11:00-14:00', '18:00-02:00'], ['00:00-24:00'], ['09:30-09:30']]) {
      for (const start of [0, 300, 720, 1080, 1400]) {
        const note = hoursNote(hours, start, 90)
        if (note) expect(note.text).toMatch(/^(Open until (\d\d:\d\d|midnight)|Open 24 hours|Closes at (\d\d:\d\d|midnight)|Closed at this time)$/)
      }
    }
  })
})

describe('cardTags', () => {
  const open = { text: 'Open until 22:00', tone: 'neutral' }
  const texts = (tags) => tags.map((t) => t.text)

  it('never shows "Short walk", and keeps "Near MRT" and every other reason', () => {
    expect(texts(cardTags(['Short walk'], null))).toEqual([])
    expect(texts(cardTags(['Near MRT', 'Short walk'], null))).toEqual(['Near MRT'])
    expect(texts(cardTags(['Hidden gem', 'Budget friendly'], null))).toEqual(['Hidden gem', 'Budget friendly'])
    expect(texts(cardTags(['Indoor', 'Near MRT'], null))).toEqual(['Indoor', 'Near MRT'])
  })

  it('still leaves out "Quiet at" reasons', () => {
    expect(texts(cardTags(['Quiet at 15:00', 'Near MRT'], null))).toEqual(['Near MRT'])
  })

  it('adds the hours tag after the reasons, with its tone and an icon when it warns', () => {
    const tags = cardTags(['Near MRT'], { text: 'Closes at 21:00', tone: 'warning' })
    expect(tags.map((t) => [t.text, t.tone, t.icon])).toEqual([['Near MRT', 'neutral', ''], ['Closes at 21:00', 'warning', 'clock']])
    expect(cardTags([], open)[0]).toMatchObject({ text: 'Open until 22:00', tone: 'neutral', icon: '' })
  })

  it('shows at most three, and the hours win over the planner\'s second reason', () => {
    expect(texts(cardTags(['Near MRT', 'Hidden gem'], open))).toEqual(['Near MRT', 'Hidden gem', 'Open until 22:00'])
    const many = cardTags(['Near MRT', 'Hidden gem', 'Budget friendly', 'Indoor'], open)
    expect(many).toHaveLength(3)
    expect(texts(many)).toContain('Open until 22:00')
    expect(texts(many)[0]).toBe('Near MRT')
    expect(texts(cardTags(['A', 'B', 'C', 'D'], null))).toEqual(['A', 'B', 'C'])
  })

  it('is empty with no reasons and no hours', () => {
    expect(cardTags([], null)).toEqual([])
    expect(cardTags(undefined, null)).toEqual([])
  })
})

describe('votersText', () => {
  const v = (id, name) => ({ id, name })
  const ian = v('ian', 'Ian')
  const darius = v('darius', 'Darius')
  const nicole = v('nicole', 'Nicole')
  const faith = v('faith', 'Faith')
  const say = (voters, groupSize = 4, me = 'ian') => votersText({ voters, votes: voters.length, groupSize, me })

  it('names one, two and three voters, "You" first', () => {
    expect(say([darius])).toBe('Darius voted')
    expect(say([darius, nicole])).toBe('Darius and Nicole voted')
    expect(say([darius, nicole, faith])).toBe('Darius, Nicole and Faith voted')
    expect(say([ian])).toBe('You voted')
    expect(say([darius, ian])).toBe('You and Darius voted')
    expect(say([darius, ian, nicole])).toBe('You, Darius and Nicole voted')
  })

  it('says "Everyone voted" when everyone in the group did', () => {
    expect(say([ian, darius, nicole, faith])).toBe('Everyone voted')
    expect(say([darius, nicole, faith], 3)).toBe('Everyone voted')
    expect(say([ian, darius], 2)).toBe('Everyone voted')
  })

  it('keeps today\'s count with nobody voting, and with one vote or more in a big group', () => {
    expect(votersText({ voters: [], votes: 0, groupSize: 3, me: 'ian' })).toBe('0 votes')
    expect(votersText({ voters: [], votes: 0, groupSize: 0 })).toBe('0 votes')
    expect(say([ian], 5)).toBe('1 vote')
    expect(say([ian, darius], 5)).toBe('2 votes')
    expect(say([ian, darius, nicole, faith], 5)).toBe('4 votes')
  })

  it('keeps the count when it is not told the group\'s size', () => {
    expect(votersText({ voters: [ian], votes: 1 })).toBe('1 vote')
    expect(votersText({ voters: [ian, darius], votes: 2, groupSize: 0, me: 'ian' })).toBe('2 votes')
  })

  it('keeps the count rather than guess when the names do not match the votes or one is missing', () => {
    expect(votersText({ voters: [], votes: 2, groupSize: 4, me: 'ian' })).toBe('2 votes')
    expect(votersText({ voters: [v('x', ''), darius], votes: 2, groupSize: 4, me: 'ian' })).toBe('2 votes')
  })
})

describe('walkFromText', () => {
  it('names the meeting area', () => {
    expect(walkFromText('Bugis')).toBe('Walking times are from Bugis')
    expect(walkFromText('  Toa Payoh ')).toBe('Walking times are from Toa Payoh')
  })

  it('is empty with no meeting area', () => {
    for (const none of [undefined, null, '', '   ', 5]) expect(walkFromText(none)).toBe('')
  })
})

describe('the Vote page\'s use of them', () => {
  const source = readFileSync(new URL('../../views/PlannerView.vue', import.meta.url), 'utf8')

  it('is said once above the categories, not on each card or heading, and only with a meeting area', () => {
    expect(source.match(/data-testid="walk-from"/g)).toHaveLength(1)
    const line = source.indexOf('data-testid="walk-from"')
    expect(line).toBeLessThan(source.indexOf('<section v-for="(slot, si) in listed"'))
    expect(source).toMatch(/const walkFrom = computed\(\(\) => \(session\.value\?\.meeting \? walkFromText\(session\.value\.area\?\.name\) : ''\)\)/)
    expect(source).toMatch(/v-if="!loading && listed\.length && walkFrom"/)
  })

  it('gives each card its stop, the group size and the signed-in person', () => {
    expect(source).toContain(':stop="{ start: slot.start, duration: slot.duration }"')
    expect(source).toContain(':group-size="active.length"')
    expect(source).toContain(':me="auth.myId"')
  })

  it('returns focus to the name when it opened the detail, and to the review line otherwise', () => {
    expect(source).toContain("reviewing.value?.from === 'name' ? 'data-open-for' : 'data-review-for'")
    expect(source).toContain('@open="openReviews"')
  })
})
