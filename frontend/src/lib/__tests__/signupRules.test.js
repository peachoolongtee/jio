import { describe, expect, it } from 'vitest'
import {
  cleanDietary,
  dobToIso,
  fieldForSignUpError,
  formatDobInput,
  isoToDob,
  NAME_MAX,
  passwordRules,
  usernameCandidates,
  validateDob,
  validateEmail,
  validateName,
  validatePassword,
  validateUsername,
} from '../signupRules.js'
import { OTHER, PROFILE } from './authFixture.js'

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
  const MESSAGE = 'Use 8 to 72 characters with an uppercase letter, a lowercase letter, a number and a symbol (any character that is not a letter, number or space), and no space at the start or end.'

  it('needs 8 or more characters with an uppercase letter, a lowercase letter, a number and a symbol', () => {
    expect(validatePassword('Abc1!xyz')).toBe('')
    expect(validatePassword('Sup3rSecret!')).toBe('')
    expect(validatePassword('Abc1*x@#$%')).toBe('')
    for (const bad of ['', 'Ab1!xyz', 'abc1!xyz', 'ABC1!XYZ', 'Abcdefgh!', 'Abcdefg1', 'Abc!!!!!']) {
      expect(validatePassword(bad)).toBe(MESSAGE)
    }
  })

  it('accepts what a password manager makes: - _ ? & ^ and every other printable symbol', () => {
    for (const ch of '!@#$%^&*()_+-=[]{};:\'"|<>?,./`~\\') expect(validatePassword(`Abc1${ch}xyz`)).toBe('')
    expect(validatePassword('Zx9-qL_mW?4k&Vb^2')).toBe('')
    // A space inside is allowed, and counts as no symbol by itself.
    expect(validatePassword('Abc 1 xyz!')).toBe('')
    expect(validatePassword('Abc 1 xyz')).toBe(MESSAGE)
  })

  it('counts accented letters as letters and emoji as symbols', () => {
    expect(validatePassword('\u00c9cole2026\u00e9')).toBe(MESSAGE)
    expect(validatePassword('\u00c9cole2026\u00e9\u2603')).toBe('')
    expect(validatePassword('Abcdefg1\u{1f600}')).toBe('')
  })

  it('refuses a space at either end and any control character', () => {
    for (const bad of [' Abc1!xyz', 'Abc1!xyz ', 'Abc1!xyz\u00a0', 'Abc1!\txyz', 'Abc1!xyz\n', 'Abc1!x\u0000yz', 'Abc1!x\u007fyz']) {
      expect(validatePassword(bad)).toBe(MESSAGE)
    }
  })

  it('allows 72 bytes and no more: the hash reads no further', () => {
    expect(validatePassword(`Aa1!${'x'.repeat(68)}`)).toBe('')
    expect(validatePassword(`Aa1!${'x'.repeat(69)}`)).toBe(MESSAGE)
    // An accented letter is two bytes, so 35 of them and Aa1! come to 74.
    expect(validatePassword(`Aa1!${'\u00e9'.repeat(34)}`)).toBe('')
    expect(validatePassword(`Aa1!${'\u00e9'.repeat(35)}`)).toBe(MESSAGE)
  })

  it('ticks off each part as typed, and says what a symbol is', async () => {
    // The checklist draws the first five; the sixth is hidden, and said under the field only when it is broken.
    const { shownRules, hiddenProblem } = await import('../signupRules.js')
    expect(shownRules(passwordRules('')).map((r) => r.label)).toEqual(['8 or more characters', 'An uppercase letter', 'A lowercase letter', 'A number', 'A symbol'])
    expect(hiddenProblem(passwordRules(''), '')).toBe('')
    expect(hiddenProblem(passwordRules('Abc1!xyz'), 'Abc1!xyz')).toBe('')
    expect(hiddenProblem(passwordRules(' Abc1!xyz'), ' Abc1!xyz')).toBe('Use 72 characters or fewer, with no space at the start or end and no control characters.')
    expect(hiddenProblem(passwordRules('Ab1!'.repeat(20)), 'Ab1!'.repeat(20))).toBe('Use 72 characters or fewer, with no space at the start or end and no control characters.')
    expect(passwordRules('a1 ').map((r) => r.ok)).toEqual([false, false, true, true, false, false])
    expect(passwordRules('Abcdefg1').map((r) => r.ok)).toEqual([true, true, true, true, false, true])
    expect(passwordRules('Abc1!xyz').map((r) => r.ok)).toEqual([true, true, true, true, true, true])
    expect(passwordRules('').map((r) => r.ok)).toEqual([false, false, false, false, false, false])
    expect(passwordRules('')).toMatchObject([
      { label: '8 or more characters' },
      { label: 'An uppercase letter' },
      { label: 'A lowercase letter' },
      { label: 'A number' },
      { label: 'A symbol', hint: 'Any character that is not a letter, number or space, like - _ ? ! @ #' },
      { label: 'No more than 72 characters, and no space at the start or end', hint: 'Accented letters and emoji take more room. Control characters are not allowed.' },
    ])
  })

  it('is met by the passwords the test accounts use, so a test cannot sign up with one the product would refuse', () => {
    for (const { password } of [PROFILE, OTHER]) expect(validatePassword(password)).toBe('')
  })
})

describe('the date of birth as DD/MM/YYYY', () => {
  it('puts the slashes in as the digits arrive, never one at the end', () => {
    expect(formatDobInput('1')).toBe('1')
    expect(formatDobInput('18')).toBe('18')
    expect(formatDobInput('180')).toBe('18/0')
    expect(formatDobInput('18032004')).toBe('18/03/2004')
    expect(formatDobInput('18/03/2004999')).toBe('18/03/2004')
    expect(formatDobInput('18-03-20ab04')).toBe('18/03/2004')
  })

  it('turns a whole date into YYYY-MM-DD and back, and nothing else', () => {
    expect(dobToIso('18/03/2004')).toBe('2004-03-18')
    expect(dobToIso('18/03/200')).toBe('')
    expect(isoToDob('2004-03-18')).toBe('18/03/2004')
    expect(isoToDob('')).toBe('')
  })
})

describe('usernameCandidates', () => {
  // Random numbers in order, so a test knows which come out.
  const fixed = (...values) => {
    let i = 0
    return () => values[i++ % values.length]
  }

  it('counts up from a name that ends in _<number>, then adds random numbers from 100 to 999', () => {
    const list = usernameCandidates('testuser_887', { random: fixed(0.1, 0.5, 0.9, 0.0) })
    expect(list).toEqual(['testuser_888', 'testuser_889', 'testuser_190', 'testuser_550', 'testuser_910', 'testuser_100'])
  })

  it('gives only as many as are asked for, so four names can be tried and no more', () => {
    expect(usernameCandidates('testuser_887', { random: fixed(0.1, 0.5), count: 4 })).toEqual(['testuser_888', 'testuser_889', 'testuser_190', 'testuser_550'])
  })

  it('starts at _1 for any other name', () => {
    expect(usernameCandidates('sam', { random: fixed(0.2) }).slice(0, 3)).toEqual(['sam_1', 'sam_2', 'sam_280'])
  })

  it('shortens the start of a long name so every suggestion fits the 20-character rule', () => {
    const list = usernameCandidates('abcdefghijklmnopqrst')
    expect(list.length).toBeGreaterThan(0)
    for (const name of list) expect(validateUsername(name)).toBe('')
    expect(list[0]).toBe('abcdefghijklmnopqr_1')
  })
})
