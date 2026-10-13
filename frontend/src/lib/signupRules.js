// Sign-up rules, shared by the sign-up screens so each answer is checked the same way as the data layer checks it.
// Each check returns '' when the answer is fine, or a message to show under the field.

export const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/
export const USERNAME_HINT = '3 to 20 characters: lowercase letters, numbers or underscores'
export const NAME_MAX = 50
export const DOB_MIN = '1900-01-01'

// The dietary needs a person can pick, the same three the database's check and the planner's filters accept.
export const DIETARY_OPTIONS = [
  { value: 'halal', label: 'Halal' },
  { value: 'vegetarian', label: 'Vegetarian' },
  { value: 'vegan', label: 'Vegan' },
]

// Only the known needs, each once, in the order above. Anything else is dropped, so the database's check never refuses it.
// How to call: cleanDietary(['vegan', 'paleo', 'vegan']) -> ['vegan']
export function cleanDietary(list) {
  const picked = Array.isArray(list) ? list : []
  return DIETARY_OPTIONS.map((o) => o.value).filter((value) => picked.includes(value))
}

// An email address: something before the @, then a domain of dot-separated parts ending in 2 or more letters
// (name@example.com, n.tan+jio@mail.co.sg). No spaces, no dot at either end of the name, no two dots in a row.
const EMAIL_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i

// How to call: validateEmail('sam@example.com') -> ''
export function validateEmail(value) {
  const email = (value || '').trim()
  if (!email) return 'Enter your email address.'
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return 'Enter a valid email address, like name@example.com.'
  return ''
}

// The password rule for real accounts, the same on the sign-up and reset pages: 8 to 72 characters, with at least one
// uppercase letter, one lowercase letter, one number and one symbol. A symbol is any printable character that is not a
// letter, a number or a space (- _ ? & ^ and the rest, so a password manager's output is accepted). Any printable
// character is allowed, a space only inside the password: no control characters, and no space at either end. The most
// is 72 because the hash Supabase uses (bcrypt) reads no more than 72 bytes, so it is counted in bytes: an accented
// letter or an emoji counts as more than one. This is Jio's rule, not a copy of the Supabase project's own password
// setting (Authentication > Policies), which has not been compared with it: if that setting asks for more, the server's
// refusal comes back as a sentence (lib/auth.js) and is shown as it is.
export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 72
const CONTROL = /\p{Cc}/u
// A symbol: not a letter, a number, a mark that goes on a letter (an accent), a space or a control character.
const SYMBOL = /[^\p{L}\p{N}\p{M}\s\p{Cc}]/u

// How many bytes the password takes when it is sent (UTF-8).
// How to call: passwordBytes('Abc1!\u00e9') -> 7
function passwordBytes(text) {
  return new TextEncoder().encode(text).length
}

// Each part of the password rule, for a live checklist.
// `hint` is a line to show under the label. A rule with `hidden` is still part of the rule but is not drawn on the
// checklist (see shownRules): almost nobody breaks it, so instead its `problem` is shown under the field when it is broken
// (see hiddenProblem). How to call: passwordRules('Abc1!xyz') -> [{ label: '8 or more characters', ok: true }, ...]
export function passwordRules(password) {
  const text = password || ''
  return [
    { label: `${PASSWORD_MIN} or more characters`, ok: [...text].length >= PASSWORD_MIN },
    { label: 'An uppercase letter', ok: /\p{Lu}/u.test(text) },
    { label: 'A lowercase letter', ok: /\p{Ll}/u.test(text) },
    { label: 'A number', ok: /\p{Nd}/u.test(text) },
    { label: 'A symbol', hint: 'Any character that is not a letter, number or space, like - _ ? ! @ #', ok: SYMBOL.test(text) },
    {
      label: `No more than ${PASSWORD_MAX} characters, and no space at the start or end`,
      hint: 'Accented letters and emoji take more room. Control characters are not allowed.',
      hidden: true,
      problem: `Use ${PASSWORD_MAX} characters or fewer, with no space at the start or end and no control characters.`,
      ok: text.length > 0 && passwordBytes(text) <= PASSWORD_MAX && !/^\s|\s$/.test(text) && !CONTROL.test(text),
    },
  ]
}

// The rules a checklist draws: every rule but the hidden ones.
// How to call: shownRules(passwordRules('Abc1!xyz')) -> the first five
export const shownRules = (rules) => rules.filter((rule) => !rule.hidden)

// What to say under the password field when a hidden rule is broken, or ''. Nothing is said for an empty password.
// The password is passed as well as its rules, because the rules alone cannot tell an empty password from a broken one.
// How to call: hiddenProblem(passwordRules(' Abc1!xyz'), ' Abc1!xyz') -> 'Use 72 characters or fewer, with no space at the start or end ...'
export const hiddenProblem = (rules, password) => (password ? rules.find((rule) => rule.hidden && !rule.ok)?.problem || '' : '')

// How to call: validatePassword('Abc1!xyz') -> ''
export function validatePassword(password) {
  if (passwordRules(password).every((rule) => rule.ok)) return ''
  return `Use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters with an uppercase letter, a lowercase letter, a number and a symbol (any character that is not a letter, number or space), and no space at the start or end.`
}

// A date of birth as the person types it, DD/MM/YYYY: only digits are kept, and the slashes are put in as the digits
// arrive. A slash is never added at the end, so deleting one with Backspace works.
// How to call: formatDobInput('18032004') -> '18/03/2004';  formatDobInput('180') -> '18/0'
export function formatDobInput(value) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 8)
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join('/')
}

// DD/MM/YYYY to the YYYY-MM-DD the database keeps, or '' until all 8 digits are there. Whether the date is real is
// for validateDob to say.
// How to call: dobToIso('18/03/2004') -> '2004-03-18'
export function dobToIso(text) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text || '')
  return match ? `${match[3]}-${match[2]}-${match[1]}` : ''
}

// YYYY-MM-DD back to DD/MM/YYYY, for a date already answered. '' for anything else.
// How to call: isoToDob('2004-03-18') -> '18/03/2004'
export function isoToDob(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '')
  return match ? `${match[3]}/${match[2]}/${match[1]}` : ''
}

// Usernames to offer in place of a taken one, before checking which are free: the name with an underscore and a
// number. A name that already ends in _<number> counts up from that number; any other name starts at _1. Then a few
// random numbers from 100 to 999. Each follows the username rule: the start of the name is shortened so the whole
// thing fits in 20 characters.
// How to call: usernameCandidates('testuser_887') -> ['testuser_888', 'testuser_889', 'testuser_200', ...]
export function usernameCandidates(username, { random = Math.random, count = 6 } = {}) {
  const name = (username || '').toLowerCase().replace(/[^a-z0-9_]/g, '')
  const counted = /^(.+)_(\d+)$/.exec(name)
  const base = (counted ? counted[1] : name) || 'user'
  const start = counted ? Number(counted[2]) + 1 : 1
  const numbers = [start, start + 1]
  for (let tries = 0; numbers.length < count && tries < 50; tries += 1) {
    const n = 100 + Math.floor(random() * 900)
    if (!numbers.includes(n)) numbers.push(n)
  }
  const made = numbers.map((n) => `${base.slice(0, 20 - String(n).length - 1)}_${n}`)
  return [...new Set(made)].filter((candidate) => candidate !== name && USERNAME_PATTERN.test(candidate))
}

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

// The first thing wrong with a whole profile, or '' when the data layer will accept it. Checked before anything is
// erased and re-created, so a bad profile cannot leave a person signed out.
// How to call: profileProblem({ name: 'Ian', username: 'ian', dob: '2000-01-01' }) -> ''
export function profileProblem(profile, now = new Date()) {
  return validateName(profile?.name) || validateUsername(profile?.username) || validateDob(profile?.dob, now)
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
