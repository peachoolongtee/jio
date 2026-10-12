import { describe, expect, it } from 'vitest'
import {
  cleanDietary,
  fieldForSignUpError,
  NAME_MAX,
  passwordRules,
  validateDob,
  validateEmail,
  validateName,
  validatePassword,
  validateUsername,
} from '../signupRules.js'

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

describe('cleanDietary', () => {
  it('keeps only halal, vegetarian and vegan, each once, in a fixed order', () => {
    expect(cleanDietary(['vegan', 'paleo', 'halal', 'vegan'])).toEqual(['halal', 'vegan'])
    expect(cleanDietary(['Vegan'])).toEqual([])
  })

  it('answers an empty list for anything that is not a list', () => {
    expect(cleanDietary(undefined)).toEqual([])
    expect(cleanDietary(null)).toEqual([])
    expect(cleanDietary('halal')).toEqual([])
  })
})

describe('validateEmail', () => {
  it('accepts ordinary addresses, with plus signs, dots and country domains', () => {
    for (const ok of ['sam@example.com', 'sam.tan+jio@mail.co.sg', 'SAM@GMAIL.COM', ' sam@example.com ']) expect(validateEmail(ok)).toBe('')
  })

  it('refuses anything that is not an address, and asks for one when empty', () => {
    expect(validateEmail('')).toBe('Enter your email address.')
    for (const bad of ['sam', 'sam@', '@example.com', 'sam@example', 'sam@example.c', 'sam@@example.com', '.sam@example.com', 'sam.@example.com', 'sam..tan@example.com', 'sam tan@example.com', 'sam@-example.com', 'sam@example..com']) {
      expect(validateEmail(bad)).toBe('Enter a valid email address, like name@example.com.')
    }
  })
})

describe('the password rule', () => {
  it('needs 6 or more characters with a letter, a number and a symbol', () => {
    expect(validatePassword('abc1!x')).toBe('')
    expect(validatePassword('Sup3r-secret!')).toBe('')
    for (const bad of ['', 'ab1!x', 'abcdef', '123456', '!!!!!!', 'abc123', 'abc!!!', '123!!!', 'abc 12 ']) {
      expect(validatePassword(bad)).toBe('Use 6 or more characters, with a letter, a number and a symbol.')
    }
  })

  it('lists each part for the checklist, a space not counting as a symbol', () => {
    expect(passwordRules('a1 ').map((r) => r.ok)).toEqual([false, true, true, false])
  })
})