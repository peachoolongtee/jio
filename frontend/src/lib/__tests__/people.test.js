import { describe, expect, it } from 'vitest'
import { personColour } from '../people.js'

describe('personColour', () => {
  it('gives each demo friend their own colour', () => {
    const ids = ['ian', 'darius', 'jonathan', 'nicole', 'faith', 'darryl']
    expect(new Set(ids.map(personColour)).size).toBe(ids.length)
  })
  it('always gives the same person the same colour', () => {
    expect(personColour('someone-new')).toBe(personColour('someone-new'))
    expect(personColour('someone-new')).toMatch(/^var\(--person-[1-8]\)$/)
  })
  it('is empty without an id', () => {
    expect(personColour('')).toBe('')
  })
})
