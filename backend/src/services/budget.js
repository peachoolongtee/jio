import { ExternalApiError } from './errors.js'

// One budget for every OneMap call the server makes.
//
// The OneMap account is shared by the whole server and allows 300 calls a minute in total. A limit per request
// cannot protect that, so the OneMap service owns one budget and every call to OneMap (routing, search and
// login) goes through it. It does two things:
//   1. At most `maxInFlight` calls run at once. The rest wait their turn, first come first served.
//   2. A token bucket of `callsPerMinute` calls. It starts full and refills evenly, so a minute after it was
//      emptied it is full again. A call that finds the bucket empty does not wait for a refill: it fails at once
//      and the caller falls back.

export const MAX_IN_FLIGHT = 6
export const DEFAULT_CALLS_PER_MINUTE = 240 // Headroom under the account's 300 a minute.

// Why OneMap could not be used for a call. A subclass of ExternalApiError, so code that already falls back on
// "OneMap failed" covers these too, and an uncaught one still answers 500.
//
// `reason` is one of:
//   budget_empty  the call budget for this minute is used up
//   circuit_open  five route calls in a row failed, so routing is paused for a while
//   login_failed  the OneMap login failed, so routing is paused until the next try
//   deadline      one request waited too long for OneMap
//
// How to call (budget.js and onemap.js throw it; callers catch it):
//   try { await onemap.routeMinutes(from, to, dateTime) } catch (err) {
//     if (err instanceof OneMapUnavailableError) console.log(err.reason) // 'budget_empty'
//   }
export class OneMapUnavailableError extends ExternalApiError {
  constructor(reason, message, { retryAfterSeconds = null, url } = {}) {
    super(message, { service: 'onemap', status: null, url })
    this.name = 'OneMapUnavailableError'
    this.reason = reason
    // Whole seconds until a call is likely to be allowed again, or null when unknown.
    this.retryAfterSeconds = retryAfterSeconds
  }
}

// Builds a budget. OneMap uses it as it is; another service (Google Places) gives its own name and error class.
//
// How to call:
//   const budget = createCallBudget({ callsPerMinute: 240 })
//   const body = await budget.run(() => http.getJson(url))   // Throws OneMapUnavailableError when the bucket is empty.
//
// For another service:
//   createCallBudget({ callsPerMinute: 60, maxInFlight: 4, service: 'Google', unavailable: (reason, message, details) => new MyError(reason, message, details) })
//
// Options:
//   callsPerMinute - Size of the bucket and its refill rate. A positive integer.
//   maxInFlight    - How many calls may run at once. Default 6.
//   now            - Returns the time in milliseconds. Tests pass a fake clock.
//   service        - The name used in the "budget used up" message. Default 'OneMap'.
//   unavailable    - Builds the error thrown when the bucket is empty: (reason, message, { retryAfterSeconds }) => Error.
//                    Default: OneMapUnavailableError.
export function createCallBudget({
  callsPerMinute,
  maxInFlight = MAX_IN_FLIGHT,
  now = Date.now,
  service = 'OneMap',
  unavailable = (reason, message, details) => new OneMapUnavailableError(reason, message, details),
}) {
  if (!Number.isInteger(callsPerMinute) || callsPerMinute <= 0) {
    throw new Error(`createCallBudget: callsPerMinute must be a positive integer, got ${String(callsPerMinute)}.`)
  }
  const perMs = callsPerMinute / 60_000
  let tokens = callsPerMinute
  let refilledAt = now()
  let inFlight = 0
  const waiting = [] // Callers waiting for a free slot, oldest first.

  // Adds the tokens earned since the last look.
  function refill() {
    const t = now()
    if (t > refilledAt) tokens = Math.min(callsPerMinute, tokens + (t - refilledAt) * perMs)
    refilledAt = t // Also resets after a clock that went backwards, so the bucket never gets stuck.
  }

  // True when at least one call is allowed right now.
  //
  // How to call:
  //   if (!budget.hasToken()) return fallBack()
  function hasToken() {
    refill()
    return tokens >= 1 - 1e-9
  }

  // Whole seconds until one more call is allowed, at least 1. For the Retry-After header.
  //
  // How to call:
  //   res.set('Retry-After', String(budget.retryAfterSeconds()))
  function retryAfterSeconds() {
    refill()
    return Math.max(1, Math.ceil((1 - tokens) / perMs / 1000 - 1e-9))
  }

  const empty = () =>
    unavailable('budget_empty', `the ${service} call budget for this minute is used up`, {
      retryAfterSeconds: retryAfterSeconds(),
    })

  // Takes a slot at once when one is free, and otherwise waits for one.
  function acquire() {
    if (inFlight < maxInFlight) {
      inFlight += 1
      return null
    }
    return new Promise((resolve) => waiting.push(resolve))
  }

  // Hands the slot to the next waiting caller, or frees it.
  function release() {
    const next = waiting.shift()
    if (next) next()
    else inFlight -= 1
  }

  // Runs one OneMap call within the budget. Waits for a free slot (at most `maxInFlight` run at once), then
  // spends one token. Never waits for a token: an empty bucket throws OneMapUnavailableError('budget_empty').
  //
  // How to call:
  //   const body = await budget.run(() => http.getJson(url))
  //
  // `guard` is called once the call has its slot and before it spends a token. If it throws, nothing is spent.
  // Use it to refuse a call that became pointless while it waited (for example, the circuit opened).
  //   await budget.run(() => http.getJson(url), { guard: () => assertCircuitClosed() })
  async function run(fn, { guard } = {}) {
    if (!hasToken()) throw empty() // Fail before queueing: a call that cannot be paid for must not wait for a slot.
    await acquire()
    try {
      guard?.()
      if (!hasToken()) throw empty()
      tokens -= 1
      return await fn()
    } finally {
      release()
    }
  }

  return { run, hasToken, retryAfterSeconds }
}
