// Sign-up rules, shared by the sign-up screens so each answer is checked the same way as the data layer checks it.
// Each check returns '' when the answer is fine, or a message to show under the field.

export const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/
export const USERNAME_HINT = '3 to 20 characters: lowercase letters, numbers or underscores'
export const NAME_MAX = 50
export const DOB_MIN = '1900-01-01'

// How to call: validateUsername('ian_99') -> ''
export function validateUsername(value) {
  if (!USERNAME_PATTERN.test(value || '')) return 'Use 3 to 20 lowercase letters, numbers or underscores.'
  return ''
}

// How to call: validateName('Ian') -> ''
export function validateName(value) {
  const name = (value || '').trim()
  if (!name) return 'Enter your name.'
  if (name.length > NAME_MAX) return `Use ${NAME_MAX} characters or fewer.`
  return ''
}

// Today's date as YYYY-MM-DD in the person's own time zone, which is what a date input compares against.
// How to call: todayIso(new Date()) -> '2026-10-09'
export function todayIso(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

// A date of birth as YYYY-MM-DD: a real calendar date, not in the future, not before 1900.
// How to call: validateDob('2004-03-18') -> ''
export function validateDob(value, now = new Date()) {
  const text = value || ''
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return 'Enter your date of birth.'
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  // Date rolls 31 February over to March, so a real date is one that survives the round trip.
  const parsed = new Date(Date.UTC(year, month - 1, day))
  const real = parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
  if (!real) return 'That date does not exist.'
  if (text > todayIso(now)) return 'Your date of birth cannot be in the future.'
  if (text < DOB_MIN) return 'Your date of birth cannot be before 1900.'
  return ''
}

// Which sign-up question a message from the data layer belongs to, so the message can be shown under that field.
// Falls back to '' when it names none of them.
// How to call: fieldForSignUpError('Username can only use lowercase letters.') -> 'username'
export function fieldForSignUpError(message) {
  const text = (message || '').toLowerCase()
  if (/birth|dob/.test(text)) return 'dob'
  if (/username/.test(text)) return 'username'
  if (/name/.test(text)) return 'name'
  return ''
}
