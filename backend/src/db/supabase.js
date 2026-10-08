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

// Builds the server's three ways of talking to Supabase.
//
// How to call (index.js does this once at startup):
//   const supabase = createSupabase({
//     url: process.env.SUPABASE_URL,
//     anonKey: process.env.SUPABASE_ANON_KEY,
//     serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
//   })
//
// What you get back:
//   supabase.verifyToken(token)  Checks a login token. Resolves to { id, email }, or null when it is not valid.
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
// Options:
//   fetchImpl - The function that makes requests. Tests pass a fake one so nothing touches the network.
export function createSupabase({ url, anonKey, serviceKey, fetchImpl } = {}) {
  if (!url || !anonKey || !serviceKey) {
    throw new Error(
      'createSupabase needs url, anonKey and serviceKey. Set SUPABASE_URL, SUPABASE_ANON_KEY and ' +
        'SUPABASE_SERVICE_ROLE_KEY in backend/.env.',
    )
  }
  const withFetch = fetchImpl ? { fetch: fetchImpl } : {}

  const service = createClient(url, serviceKey, { ...NO_SESSION, global: withFetch })
  // Only used to check tokens. It caches Supabase's public signing keys, so most checks need no network call.
  const verifier = createClient(url, anonKey, { ...NO_SESSION, global: withFetch })

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
      const { data, error } = await verifier.auth.getClaims(token)
      if (error || !data) return null
      const { sub, role, email } = data.claims
      // The anon key and the service key are also signed tokens. Neither belongs to a person, so refuse both.
      if (!sub || role !== 'authenticated') return null
      return { id: sub, email: email ?? null }
    },
  }
}
