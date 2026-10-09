import { describe, expect, it } from 'vitest'
import { fieldForSignUpError, NAME_MAX, validateDob, validateName, validateUsername } from '../signupRules.js'

const NOW = new Date(2026, 9, 9, 12, 0)

describe('validateUsername', () => {
  it('accepts 3 to 20 lowercase letters, numbers and underscores', () => {
    for (const ok of ['ian', 'ian_99', 'a_b', 'a'.repeat(20)]) expect(validateUsername(ok)).toBe('')
  })
  it('rejects dots, capitals, spaces and the wrong length', () => {
    for (const bad of ['', 'ab', 'a'.repeat(21), 'ian.pong', 'Ian', 'ian pong', 'ian-pong']) expect(validateUsername(bad)).not.toBe('')
  })
})

describe('validateName', () => {
  it('needs a name of at most 50 characters', () => {
    expect(validateName('Ian')).toBe('')
    expect(validateName('x'.repeat(NAME_MAX))).toBe('')
    expect(validateName('   ')).not.toBe('')
    expect(validateName('x'.repeat(NAME_MAX + 1))).toMatch(/50/)
  })
})

describe('validateDob', () => {
  it('accepts a real date in range, including the edges', () => {
    expect(validateDob('2004-03-18', NOW)).toBe('')
    expect(validateDob('1900-01-01', NOW)).toBe('')
    expect(validateDob('2026-10-09', NOW)).toBe('')
    expect(validateDob('2024-02-29', NOW)).toBe('')
  })
  it('rejects a missing or malformed date', () => {
    for (const bad of ['', undefined, '18/03/2004', '2004-3-18', 'abcd-ef-gh']) expect(validateDob(bad, NOW)).toMatch(/Enter/)
  })
  it('rejects dates that do not exist', () => {
    expect(validateDob('2025-02-29', NOW)).toMatch(/does not exist/)
    expect(validateDob('2004-13-01', NOW)).toMatch(/does not exist/)
    expect(validateDob('2004-04-31', NOW)).toMatch(/does not exist/)
  })
  it('rejects the future and anything before 1900', () => {
    expect(validateDob('2026-10-10', NOW)).toMatch(/future/)
    expect(validateDob('1899-12-31', NOW)).toMatch(/1900/)
  })
})

describe('fieldForSignUpError', () => {
  it('finds the question a message is about', () => {
    expect(fieldForSignUpError('Enter your date of birth as YYYY-MM-DD.')).toBe('dob')
    expect(fieldForSignUpError('That date of birth does not exist.')).toBe('dob')
    expect(fieldForSignUpError('Username must be 3 to 20 characters: lowercase letters, numbers or underscores.')).toBe('username')
    expect(fieldForSignUpError('Enter your name.')).toBe('name')
    expect(fieldForSignUpError('Your name can be up to 50 characters.')).toBe('name')
    expect(fieldForSignUpError('Something else')).toBe('')
  })
})
