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

// How many times each voucher in the list has been claimed, by its reward id, so a card can say whether it was claimed. A voucher
// can be claimed again (each claim is a new code), so the count can be more than one.
// How to call: claimCounts([{ rewardId: 'r-nylon' }, { rewardId: 'r-nylon' }]) -> { 'r-nylon': 2 }
export function claimCounts(redemptions = []) {
  const counts = {}
  for (const r of redemptions) if (r?.rewardId) counts[r.rewardId] = (counts[r.rewardId] || 0) + 1
  return counts
}

// The words on a voucher card for how many times it was claimed.
// How to call: claimLabel(0) -> 'Not claimed'; claimLabel(1) -> 'Claimed'; claimLabel(3) -> 'Claimed 3 times'
export function claimLabel(count) {
  if (!(count > 0)) return 'Not claimed'
  return count === 1 ? 'Claimed' : `Claimed ${count} times`
}
