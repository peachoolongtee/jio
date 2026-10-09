// A small in-memory cache with an expiry time, for external API answers.
//
// The course tests each feature 5 to 6 times a day, and OneMap and data.gov.sg have rate limits, so the same
// forecast or route must not be fetched twice in a row. Two requests that ask for the same key at the same
// time share one fetch instead of making two.
//
// The cache lives in the server's memory: it is empty again after a restart, which is fine for API answers.

// Builds a cache.
//
// How to call:
//   const cache = createCache({ ttlMs: 5 * 60 * 1000 })
//   const forecast = await cache.getOrSet('two-hr-forecast:dry', () => http.getJson(url))
//
// Options:
//   ttlMs    - How long an answer stays fresh, in milliseconds.
//   maxItems - The most answers kept. The oldest is dropped first. Default 5000.
//   now      - Returns the time in milliseconds. Tests pass a fake clock.
export function createCache({ ttlMs, maxItems = 5000, now = Date.now }) {
  const items = new Map() // key -> { value, expires }
  const inFlight = new Map() // key -> promise, while a fetch is running

  // Returns the fresh value for a key, or undefined.
  //
  // How to call:
  //   const hit = cache.get('route:1.300,103.800:1.350,103.850:2026-10-10:19')
  function get(key) {
    const item = items.get(key)
    if (!item) return undefined
    if (item.expires <= now()) {
      items.delete(key)
      return undefined
    }
    return item.value
  }

  // Stores a value. A failed fetch is never stored, so the next request tries again.
  //
  // How to call:
  //   cache.set('token', token, { ttlMs: 60 * 60 * 1000 })   // A different expiry for this one key.
  function set(key, value, { ttlMs: ttl = ttlMs } = {}) {
    items.delete(key) // Re-inserting moves the key to the end, so the oldest key is always first.
    items.set(key, { value, expires: now() + ttl })
    while (items.size > maxItems) items.delete(items.keys().next().value)
  }

  // Returns the cached value, or runs fetchFn, stores its result and returns it.
  //
  // How to call:
  //   const minutes = await cache.getOrSet(key, () => fetchRouteMinutes(from, to))
  async function getOrSet(key, fetchFn) {
    const hit = get(key)
    if (hit !== undefined) return hit
    if (inFlight.has(key)) return inFlight.get(key)
    const promise = (async () => {
      try {
        const value = await fetchFn()
        set(key, value)
        return value
      } finally {
        inFlight.delete(key)
      }
    })()
    inFlight.set(key, promise)
    return promise
  }

  return { get, set, getOrSet, size: () => items.size }
}
