// "Jio remembers" (lib/travelLean.js): the words for each rule, the debt worked out from the outings this browser has finished, and the rules that
// decide whether the line is for the signed-in person. Pure functions, no network.
import { describe, expect, it } from 'vitest'
import { DEBT_DAYS, LEAN_LINES, LOCAL_RULE, MIN_DEBT_MINUTES, closerToYou, leanLine, localDebts, localLean } from '../travelLean.js'

const DAY = 24 * 3600 * 1000
const NOW = Date.parse('2026-10-30T06:00:00Z')
const done = (id, times, over = {}) => ({ id, status: 'completed', completedAt: NOW - 3 * DAY, meeting: { times }, ...over })

describe('the words', () => {
  it('say one thing for every rule, about the spot and the person alone', () => {
    expect(leanLine('longest')).toBe('This spot is closer to you.')
    expect(leanLine('balanced')).toBe('This spot is closer to you.')
    expect(Object.keys(LEAN_LINES).sort()).toEqual(['balanced', 'longest'])
  })

  it('claim nothing about past travel, ties, shares, other people or the pick moving', () => {
    for (const line of Object.values(LEAN_LINES)) {
      expect(line).not.toMatch(/\d|travelled|lately|tie|share|longest|counts|moved|most|last time|[!]/i)
      expect(line).not.toMatch(/\b(other|others|everyone|someone|anyone|they|them|he|she|than the)\b/i)
    }
  })

  it('give no line for a rule it does not know', () => {
    expect(leanLine('shortest')).toBe('')
    expect(leanLine(undefined)).toBe('')
  })

  it('is the rule the browser\'s planner uses for the spots', () => {
    expect(LOCAL_RULE).toBe('longest')
  })
})

describe('closerToYou', () => {
  it('is true only when the person\'s minutes are below the average of everyone\'s', () => {
    expect(closerToYou({ ian: 10, darius: 40 }, 'ian')).toBe(true)
    expect(closerToYou({ ian: 10, darius: 40 }, 'darius')).toBe(false)
    expect(closerToYou({ ian: 20, darius: 20 }, 'ian')).toBe(false)
    expect(closerToYou({ ian: 10, darius: 20, faith: 60 }, 'darius')).toBe(true)
    expect(closerToYou({ ian: 10, darius: 20, faith: 60 }, 'faith')).toBe(false)
  })

  it('is false when the minutes are missing, the person is not in them, or they are not numbers', () => {
    expect(closerToYou(undefined, 'ian')).toBe(false)
    expect(closerToYou({}, 'ian')).toBe(false)
    expect(closerToYou({ darius: 40 }, 'ian')).toBe(false)
    expect(closerToYou({ ian: null, darius: 40 }, 'ian')).toBe(false)
    expect(closerToYou({ ian: Number.NaN, darius: 40 }, 'ian')).toBe(false)
    expect(closerToYou({ ian: 10, darius: null, faith: 40 }, 'ian')).toBe(true)
  })
})

describe('localDebts', () => {
  it('is a person\'s trip minus the average of the people who had one, so the debts of an outing sum to nothing', () => {
    const debts = localDebts([done('a', { ian: 40, darius: 20, faith: 30 })], { now: NOW })
    expect([...debts.entries()]).toEqual([['ian', 10], ['darius', -10], ['faith', 0]])
  })

  it('adds the outings of the last 90 days and leaves out older ones, the session being asked about, and those not finished', () => {
    const sessions = [
      done('a', { ian: 40, darius: 20 }),
      done('b', { ian: 30, darius: 20 }, { completedAt: NOW - (DEBT_DAYS - 1) * DAY }),
      done('old', { ian: 90, darius: 10 }, { completedAt: NOW - (DEBT_DAYS + 1) * DAY }),
      done('this', { ian: 90, darius: 10 }),
      done('c', { ian: 90, darius: 10 }, { status: 'cancelled' }),
      done('d', { ian: 90, darius: 10 }, { status: 'confirmed' }),
      done('closed', { ian: 90, darius: 10 }, { endedBy: 'closed' }),
      done('hand', { ian: 40, darius: 20 }, { endedBy: 'hand' }),
      { id: 'e', status: 'completed', completedAt: NOW - DAY },
    ]
    expect(localDebts(sessions, { now: NOW, exceptId: 'this' }).get('ian')).toBe(25)
  })

  it('counts nothing for an outing with fewer than two trips, or trips that are not minutes', () => {
    expect(localDebts([done('a', { ian: 40 })], { now: NOW }).size).toBe(0)
    expect(localDebts([done('a', { ian: 40, darius: null, faith: -5, nicole: Number.NaN })], { now: NOW }).size).toBe(0)
  })
})

describe('localLean', () => {
  const session = { status: 'locating', meetBy: 'fairest' }
  const base = { session, myId: 'ian', debts: new Map([['ian', 10], ['darius', -10]]), routing: true, starts: 2, mine: true }

  it('is owed for the person with a debt of 5 minutes or more, in the rule the planner uses', () => {
    expect(localLean(base)).toEqual({ owed: true, rule: 'longest' })
    expect(MIN_DEBT_MINUTES).toBe(5)
  })

  it('is not owed for a debt under 5 minutes, which can only settle a rare tie', () => {
    expect(localLean({ ...base, debts: new Map([['ian', 4.99]]) }).owed).toBe(false)
    expect(localLean({ ...base, debts: new Map([['ian', 0.01]]) }).owed).toBe(false)
    expect(localLean({ ...base, debts: new Map([['ian', 5]]) }).owed).toBe(true)
  })

  it('is not owed for the other member of the same session, whose debt is below nothing, or for a debt of nothing or none', () => {
    expect(localLean({ ...base, myId: 'darius' })).toEqual({ owed: false, rule: 'longest' })
    expect(localLean({ ...base, debts: new Map([['ian', 0]]) }).owed).toBe(false)
    expect(localLean({ ...base, debts: new Map() }).owed).toBe(false)
  })

  it('is not owed when the group is not choosing, the host named the place, the planner took the centre, or there is nothing to pick', () => {
    expect(localLean({ ...base, session: { status: 'voting' } }).owed).toBe(false)
    expect(localLean({ ...base, session: { status: 'locating', meetBy: 'known' } }).owed).toBe(false)
    expect(localLean({ ...base, routing: false }).owed).toBe(false)
    expect(localLean({ ...base, starts: 1 }).owed).toBe(false)
    expect(localLean({ ...base, mine: false }).owed).toBe(false)
  })
})
