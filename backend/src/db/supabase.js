import { createClient } from '@supabase/supabase-js'

// The server never keeps a login session of its own, so switch all of that off.
const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }

const decodeUtf8 = new TextDecoder('utf-8', { fatal: true })

// True when the text has the shape of a signed token: three base64url parts, the first two being JSON objects.
// It says nothing about whether the token is genuine; verifyToken checks the signature after this.
//
// How to call:
//   isWellFormedToken('abc.def.ghi')  // false
function isWellFormedToken(token) {
  if (typeof token !== 'string' || token.length > 8192) return false
  const parts = token.split('.')
  if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return false
  try {
    for (const part of parts.slice(0, 2)) {
      const value = JSON.parse(decodeUtf8.decode(Buffer.from(part, 'base64url')))
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    }
    return true
  } catch {
    return false
  }
}

// Thrown by verifyToken when Supabase cannot be reached to decide, so the answer is "try again", not "sign in again".
//
// How to catch it (requireUser does this):
//   try { await supabase.verifyToken(token) } catch (err) { if (err instanceof AuthUnavailableError) ... }
export class AuthUnavailableError extends Error {
  constructor(message = 'Supabase could not be reached to check the login token.', options) {
    super(message, options)
    this.name = 'AuthUnavailableError'
  }
}

const SIGNING_ALGORITHMS = new Set(['ES256', 'RS256'])
const KEYS_MAX_AGE_MS = 10 * 60 * 1000 // Refresh the signing keys when they are older than this.
const UNKNOWN_KEY_REFRESH_MS = 60 * 1000 // A token naming an unknown key id may trigger a refresh this often.
const RETRY_WITH_KEYS_MS = 60 * 1000 // After a failed refresh, keys already held are used this long before trying again.
const RETRY_WITHOUT_KEYS_MS = 5 * 1000 // After a failed refresh with no keys held, requests are refused this long.
const KEYS_MAX_TRUSTED_MS = 24 * 60 * 60 * 1000 // Keys older than this are dropped, even if no refresh has worked.

// Reads the header of a token that isWellFormedToken has already accepted.
//
// How to call:
//   readHeader(token)  // { alg: 'ES256', typ: 'JWT', kid: 'key-1' }
function readHeader(token) {
  return JSON.parse(decodeUtf8.decode(Buffer.from(token.split('.')[0], 'base64url')))
}

// Builds the server's three ways of talking to Supabase.
//
// How to call (index.js does this once at startup):
//   const supabase = createSupabase({
//     url: process.env.SUPABASE_URL,
//     anonKey: process.env.SUPABASE_ANON_KEY,
//     serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
//     allowLegacyTokens: process.env.SUPABASE_ALLOW_LEGACY_TOKENS === '1',
//   })
//
// What you get back:
//   supabase.verifyToken(token)  Checks a login token. Resolves to { id, email }, or null when it is not valid.
//                                Throws AuthUnavailableError when Supabase cannot be reached to decide.
//   supabase.forUser(token)      A client that acts as that user. Row-level security decides what it can see,
//                                so use it to load anything the user asked for.
//   supabase.service             A client with the service key. It bypasses row-level security, so use it only
//                                for what the server owns: route_cache, slot_options, stops, commute_ledger,
//                                the meeting area columns, and session_member_needs().
//
// In a route, after requireUser has run, you do not call these yourself:
//   const { data: session } = await req.supabase.from('sessions').select('*').eq('id', id).maybeSingle()
//   if (!session) return res.status(404)...   // Not a member, or no such session. The database decided.
//
// How tokens are checked: the server keeps Supabase's public signing keys itself (per createSupabase call,
// refreshed after 10 minutes, shared by concurrent requests) and checks the signature locally. If a refresh
// fails, the keys already held are used and Supabase is left alone for a minute (5 seconds when no keys are held,
// and requests then get AuthUnavailableError at once). Keys older than 24 hours are dropped. The first failure of
// an outage is logged with console.warn. A token that names a key id the server does not have can cause one
// refresh per minute at most.
//
// Options:
//   fetchImpl         - The function that makes requests. Tests pass a fake one so nothing touches the network.
//   allowLegacyTokens - true lets tokens signed with the old shared secret (HS256) be checked by asking Supabase,
//                       one request each. Leave it off unless the project still issues them.
//   allowAnonymous    - true lets anonymous sign-ins through. Off by default, because they are not a person's account.
//   timeoutMs         - How long to wait for Supabase when fetching the signing keys or checking a legacy token.
//   now               - The clock, in milliseconds. Tests pass their own so they can move time forward.
export function createSupabase({
  url,
  anonKey,
  serviceKey,
  fetchImpl,
  allowLegacyTokens = false,
  allowAnonymous = false,
  timeoutMs = 5000,
  now = () => Date.now(),
} = {}) {
  if (!url || !anonKey || !serviceKey) {
    throw new Error(
      'createSupabase needs url, anonKey and serviceKey. Set SUPABASE_URL, SUPABASE_ANON_KEY and ' +
        'SUPABASE_SERVICE_ROLE_KEY in backend/.env.',
    )
  }
  const withFetch = fetchImpl ? { fetch: fetchImpl } : {}
  const baseUrl = url.replace(/\/+$/, '')
  const issuer = `${baseUrl}/auth/v1`

  // Calls the fetch function with a deadline. The request is aborted when the time is up, and the wait ends
  // then even if the fetch function ignores the abort, so a hanging Supabase cannot hang a request.
  //
  // How to call:
  //   const res = await timedFetch(`${baseUrl}/auth/v1/.well-known/jwks.json`, { headers: { apikey: anonKey } })
  async function timedFetch(input, init = {}) {
    const deadline = AbortSignal.timeout(timeoutMs)
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline
    let onAbort
    const expired = new Promise((_, reject) => {
      onAbort = () => reject(new Error(`Supabase did not answer within ${timeoutMs} ms.`))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([(fetchImpl ?? globalThis.fetch)(input, { ...init, signal }), expired])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  const service = createClient(url, serviceKey, { ...NO_SESSION, global: withFetch })
  // Only used for legacy tokens, which Supabase has to check. Signature checks use the keys held below.
  const verifier = createClient(url, anonKey, { ...NO_SESSION, global: { fetch: timedFetch } })

  // The signing keys. They belong to this object, so two createSupabase calls never share them.
  let keys = null // The keys from the last good fetch, or null before there is one (or after they grew too old).
  let keysFetchedAt = 0 // When the last good fetch finished.
  let lastAttemptAt = -Infinity // When the last fetch, good or not, started.
  let lastFailureAt = -Infinity // When the last fetch failed, or -Infinity once one has worked since.
  let outageLogged = false // True after a failure was logged, until a fetch works again.
  let inFlight = null // The fetch under way, shared by everyone who needs it.

  // Fetches the key list from Supabase. Throws on any failure.
  async function fetchKeys() {
    const res = await timedFetch(`${baseUrl}/auth/v1/.well-known/jwks.json`, { headers: { apikey: anonKey } })
    if (!res.ok) throw new Error(`Supabase answered ${res.status} for the signing keys.`)
    const body = await res.json()
    const list = Array.isArray(body?.keys) ? body.keys.filter((k) => k && typeof k === 'object') : []
    if (list.length === 0) throw new Error('Supabase sent no signing keys.')
    return list
  }

  // Refreshes the keys. Callers that arrive while a refresh is under way share it. A failed refresh keeps the
  // keys already held; with none held it throws AuthUnavailableError. The first failure of an outage is logged
  // (the reason only, never a token or a key); nothing more is logged until a refresh has worked.
  //
  // How to call:
  //   const held = await refreshKeys()  // The key list now held.
  function refreshKeys() {
    if (inFlight) return inFlight
    lastAttemptAt = now()
    inFlight = (async () => {
      try {
        keys = await fetchKeys()
        keysFetchedAt = now()
        lastFailureAt = -Infinity
        outageLogged = false
      } catch (err) {
        lastFailureAt = now()
        if (!outageLogged) {
          outageLogged = true
          console.warn(
            `Could not refresh Supabase's signing keys (${err?.message ?? 'unknown error'}). ` +
              (keys ? 'Using the keys already held, for up to 24 hours. ' : 'Logins cannot be checked until it works. ') +
              'This is logged once per outage.',
          )
        }
        if (!keys) throw new AuthUnavailableError(undefined, { cause: err })
      } finally {
        inFlight = null
      }
      return keys
    })()
    return inFlight
  }

  // Finds the signing key a token names. Refreshes when there are no keys yet or they are 10 minutes old, unless a
  // refresh failed recently: then the held keys answer at once (for a minute), or with none held the answer is
  // AuthUnavailableError at once (for 5 seconds). A key id that is not held causes at most one more refresh per
  // minute; otherwise it is simply unknown.
  //
  // How to call:
  //   const { jwk, held } = await findKey('key-1')  // jwk is the key or null; held is the whole list.
  //   // Throws AuthUnavailableError when there are no keys and they cannot be fetched.
  async function findKey(kid) {
    const t = now()
    if (keys && t - keysFetchedAt >= KEYS_MAX_TRUSTED_MS) keys = null
    let held
    if (keys && t - keysFetchedAt < KEYS_MAX_AGE_MS) {
      held = keys
    } else if (!inFlight && t - lastFailureAt < (keys ? RETRY_WITH_KEYS_MS : RETRY_WITHOUT_KEYS_MS)) {
      if (!keys) throw new AuthUnavailableError()
      held = keys
    } else {
      held = await refreshKeys()
    }
    let jwk = held.find((k) => k.kid === kid)
    if (!jwk && now() - lastAttemptAt >= UNKNOWN_KEY_REFRESH_MS) {
      held = await refreshKeys()
      jwk = held.find((k) => k.kid === kid)
    }
    return { jwk: jwk ?? null, held }
  }

  let warnedAboutLegacy = false
  let warnedAboutIssuer = false

  // Turns the claims of a checked token into { id, email }, or null when they do not belong to a person.
  function toUser(claims) {
    if (!claims || typeof claims !== 'object') return null
    const { sub, role, email, iss, is_anonymous: isAnonymous } = claims
    if (typeof sub !== 'string' || sub === '') return null
    // The anon key and the service key are also signed tokens. Neither belongs to a person, so refuse both.
    if (role !== 'authenticated') return null
    if (iss !== issuer) {
      // A correctly signed token from another issuer is what a mistyped SUPABASE_URL looks like, so say so once.
      if (typeof iss === 'string' && !warnedAboutIssuer) {
        warnedAboutIssuer = true
        console.warn(
          `Refused a correctly signed login token with issuer "${iss.slice(0, 200)}"; this server expects ` +
            `"${issuer}". If SUPABASE_URL is mistyped, fix it. This is logged once.`,
        )
      }
      return null
    }
    if (isAnonymous === true && !allowAnonymous) return null
    return { id: sub, email: typeof email === 'string' ? email : null }
  }

  // Checks a shared-secret token by asking Supabase, which is the only party that can.
  async function verifyLegacyToken(token) {
    let result
    try {
      result = await verifier.auth.getClaims(token)
    } catch {
      return null
    }
    if (result.error?.name === 'AuthRetryableFetchError') throw new AuthUnavailableError(undefined, { cause: result.error })
    if (result.error || !result.data) return null
    return toUser(result.data.claims)
  }

  return {
    service,

    forUser(token) {
      return createClient(url, anonKey, {
        ...NO_SESSION,
        global: { ...withFetch, headers: { Authorization: `Bearer ${token}` } },
      })
    },

    async verifyToken(token) {
      // The library throws a plain error on a token it cannot even decode, which would turn a
      // caller's bad header into a 500. Refuse those here, before it sees them.
      if (!isWellFormedToken(token)) return null

      const { alg, kid } = readHeader(token)
      if (alg === 'HS256' && allowLegacyTokens) return verifyLegacyToken(token)
      if (alg === 'HS256' && !warnedAboutLegacy) {
        warnedAboutLegacy = true
        console.warn(
          'Refused a login token signed with the old shared secret (HS256). If this project may still issue ' +
            'legacy tokens, set SUPABASE_ALLOW_LEGACY_TOKENS=1. This is logged once.',
        )
      }
      // Only the algorithms Supabase's signing keys use, and a key id to look the key up by. Anything else
      // cannot be checked here and is refused without asking anyone.
      if (typeof alg !== 'string' || !SIGNING_ALGORITHMS.has(alg)) return null
      if (typeof kid !== 'string' || kid === '') return null

      const { jwk, held } = await findKey(kid)
      if (!jwk) return null

      let result
      try {
        // The key is supplied, so the library checks the signature locally and makes no network call.
        result = await verifier.auth.getClaims(token, { jwks: { keys: held } })
      } catch {
        return null
      }
      if (result.error || !result.data) return null
      return toUser(result.data.claims)
    },
  }
}
