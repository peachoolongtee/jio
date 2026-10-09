import { AuthUnavailableError } from '../db/supabase.js'

// Answers 401 in the agreed error shape: { error: { code, message } }.
function unauthenticated(res, message) {
  res.status(401).json({ error: { code: 'unauthenticated', message } })
}

// Answers 503 when Supabase cannot be reached to check the token. The caller's token may be fine, so it
// says to try again, not to sign in again.
function unavailable(res) {
  res.set('Retry-After', '5')
  res.status(503).json({
    error: { code: 'auth_unavailable', message: 'Login cannot be checked right now. Try again shortly.' },
  })
}

// Express middleware that lets a request through only with a valid login token.
//
// How to call:
//   router.get('/me', requireUser({ supabase }), (req, res) => { ... })
//
// The browser sends the token Supabase gave it at login:
//   Authorization: Bearer <session.access_token>
//
// On success it sets two things for the handler:
//   req.user      { id, email }: who is asking.
//   req.supabase  A Supabase client that acts as that user, so row-level security applies.
//
// Without a token, or with one that is expired, forged or not a person's, it answers 401 and the
// handler never runs. When Supabase cannot be reached to check the token it answers 503 with
// "Retry-After: 5" instead.
export function requireUser({ supabase }) {
  return async (req, res, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '')
    if (!match) {
      return unauthenticated(res, 'Send the session token as "Authorization: Bearer <token>".')
    }

    let user
    try {
      user = await supabase.verifyToken(match[1])
    } catch (err) {
      // Supabase could not be reached to check the token. That is not the caller's fault, and not a bug to log.
      if (err instanceof AuthUnavailableError) return unavailable(res)
      return next(err)
    }
    if (!user) {
      return unauthenticated(res, 'The session token is not valid or has expired. Sign in again.')
    }

    req.user = user
    req.supabase = supabase.forUser(match[1])
    next()
  }
}
