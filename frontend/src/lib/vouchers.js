// A claimed voucher's life: usable, then used (the person marked it) or expired (its last day passed). Dates are Singapore days,
// like the rest of the app. A voucher claimed before claims carried a last day gets one worked out from the day it was claimed,
// so an old save needs no migration: `validUntil` and `usedAt` are optional fields on a redemption.
import { addDays, format, isValid, parseISO } from 'date-fns'
import { singaporeDate } from './session.js'

// How many days a claimed voucher stays valid after the day it was claimed: claimed on 30 October, it can be used up to and
// including 29 November.
export const VOUCHER_VALID_DAYS = 30

// The last Singapore day a voucher claimed at an instant can be used, as yyyy-MM-dd, or null when the instant is not a real one.
// How to call: voucherValidUntil(new Date('2026-10-30T10:00:00+08:00').getTime()) -> '2026-11-29'
export function voucherValidUntil(claimedAt) {
  const at = new Date(claimedAt)
  if (claimedAt == null || !isValid(at)) return null
  return format(addDays(parseISO(singaporeDate(at)), VOUCHER_VALID_DAYS), 'yyyy-MM-dd')
}

// The last day a redemption can be used: its own, or one worked out from when it was claimed.
// How to call: validUntilOf({ at: 1793325600000 }) -> '2026-11-29'
export function validUntilOf(redemption) {
  return redemption?.validUntil || voucherValidUntil(redemption?.at)
}

// Where a redemption stands now: 'used' once marked, 'expired' after its last day, otherwise 'usable'. A used voucher stays used
// after its last day passes. One with no last day at all (no claim time to work it from) never expires.
// How to call: voucherState({ at: 1793325600000 }, new Date('2026-12-01')) -> 'expired'
export function voucherState(redemption, now = new Date()) {
  if (redemption?.usedAt) return 'used'
  const until = validUntilOf(redemption)
  return until && singaporeDate(now) > until ? 'expired' : 'usable'
}

// A Singapore day for a line of text, from a yyyy-MM-dd date or an instant: "30 Oct 2026". Empty when it is not a real day.
// How to call: dayLabel('2026-11-29') -> '29 Nov 2026'; dayLabel(Date.now()) -> today in Singapore
export function dayLabel(day) {
  if (day == null || day === '') return ''
  if (typeof day !== 'string' && !isValid(new Date(day))) return ''
  const parsed = parseISO(typeof day === 'string' ? day : singaporeDate(new Date(day)))
  return isValid(parsed) ? format(parsed, 'd MMM yyyy') : ''
}

// The redemptions split for the screen: the usable ones first (the order they came in, newest first), then the used ones (the
// latest used first), then the expired ones (the latest to expire first).
// How to call: voucherGroups(groups.redemptions, now.value) -> { usable: [...], used: [...], expired: [...] }
export function voucherGroups(redemptions = [], now = new Date()) {
  const groups = { usable: [], used: [], expired: [] }
  for (const r of redemptions) groups[voucherState(r, now)].push(r)
  groups.used.sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0))
  groups.expired.sort((a, b) => String(validUntilOf(b)).localeCompare(String(validUntilOf(a))))
  return groups
}

// The lines of a voucher's details. The offers are samples, so the last line says so.
// How to call: voucherTerms({ offer: 'One free coffee', cafe: 'Sample Coffee Bar' }) -> ['One free coffee at Sample Coffee Bar.', ...]
export function voucherTerms(reward) {
  return [
    `${reward?.offer} at ${reward?.cafe}.`,
    'Show the code at the counter when you order.',
    `Valid for ${VOUCHER_VALID_DAYS} days after you claim it.`,
    'One use only. Mark it as used once the café has taken the code.',
    'A demo voucher: no café has agreed to this offer.',
  ]
}
