// Express middleware that limits how many requests one caller may make in a time window.
//
// How to call:
//   app.use('/api/converge', requireUser({ supabase }), rateLimit({ windowMs: 60_000, max: 30 }))
//
// Options:
//   windowMs  Length of the window in milliseconds. A positive integer.
//   max       Requests allowed per key in one window. A positive integer.
//   keyOf     (req) => key to count by. Default: the signed-in user's id, else the address. Put the login check
//             before this middleware so signed-in callers are counted per user, not per address.
//   now       () => milliseconds. Default Date.now. Tests pass their own clock.
//
// It is a fixed window: a key's first request opens a window of windowMs, and the count resets when it ends. A
// caller can make up to 2 x max requests across the boundary of two windows. That is fine here, because the
// limit exists to protect the external routing quota, not to meter callers exactly.
//
// Over the limit it answers 429 with { error: 'rate_limited', message } and "Retry-After" in whole seconds
// (at least 1). Refused requests are not counted, so a caller that keeps knocking does not extend the wait.
//
// Memory stays bounded: a key's record is dropped once its window has ended. Expired records are swept inside
// the request path, at most once per window, on whichever request arrives first after the window. There is no
// timer, so nothing to clean up at shutdown. Between sweeps the store holds at most the keys seen in the last
// two windows. On a server that goes quiet, the last records stay until the next request sweeps them.
//
// The counts live in this process only. With more than one server instance, each counts on its own.
export function rateLimit({ windowMs, max, keyOf = defaultKeyOf, now = Date.now } = {}) {
  if (!Number.isInteger(windowMs) || windowMs <= 0) {
    throw new Error(`rateLimit: windowMs must be a positive integer number of milliseconds, got ${String(windowMs)}.`)
  }
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error(`rateLimit: max must be a positive integer, got ${String(max)}.`)
  }
  if (typeof keyOf !== 'function') throw new Error('rateLimit: keyOf must be a function.')
  if (typeof now !== 'function') throw new Error('rateLimit: now must be a function.')

  /** @type {Map<unknown, { count: number, resetAt: number }>} */
  const records = new Map()
  let nextSweepAt = now() + windowMs

  // Removes every record whose window has ended.
  //
  // How to call:
  //   sweep(now())
  function sweep(at) {
    for (const [key, record] of records) {
      if (record.resetAt <= at) records.delete(key)
    }
    nextSweepAt = at + windowMs
  }

  const middleware = (req, res, next) => {
    const at = now()
    if (at >= nextSweepAt) sweep(at)

    const key = keyOf(req)
    let record = records.get(key)
    if (!record || record.resetAt <= at) {
      record = { count: 0, resetAt: at + windowMs }
      records.set(key, record)
    }

    if (record.count >= max) {
      const seconds = Math.max(1, Math.ceil((record.resetAt - at) / 1000))
      res.set('Retry-After', String(seconds))
      res.status(429).json({ error: 'rate_limited', message: 'Too many requests. Try again shortly.' })
      return
    }

    record.count += 1
    next()
  }

  // The number of keys currently held, including any that have expired but not yet been swept. For tests and
  // monitoring, not for request handling.
  //
  // How to call:
  //   const limiter = rateLimit({ windowMs: 60_000, max: 30 })
  //   limiter.size() // 0
  middleware.size = () => records.size

  return middleware
}

// The default key: the signed-in user's id, else the caller's address.
//
// How to call:
//   defaultKeyOf({ user: { id: 'u1' }, ip: '203.0.113.7' }) // 'u1'
//   defaultKeyOf({ ip: '203.0.113.7' }) // '203.0.113.7'
function defaultKeyOf(req) {
  return req.user?.id ?? req.ip
}
