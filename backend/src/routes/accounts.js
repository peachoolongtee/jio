import { Router } from 'express'
import { z } from 'zod'

// Questions about accounts that a person asks before they have one.
//
//   POST /api/accounts/email-check   { email }   →   { registered: true | false }
//
// The sign-up screen asks this on its email question, so a person with an account is told at once instead of after
// every question. It is a lookup of who has an account, so it is not open to the browser's public key (the database
// function is granted to the service role only). The server asks it with the service key, behind a strict limit for
// each caller, and the screen carries on whenever it gets no answer. A repeat sign-up is still caught by Supabase
// itself at the end.
//
// Every failure is { error, message }: 400 for a body that is not an email, 429 over the limit, 503 when Supabase is not
// set up here or the database does not answer. A guess is never sent in place of an answer, and the email is never
// logged.
//
// How to mount it (app.js does this):
//   app.use('/api', createAccountsRouter({ supabase, limiter: rateLimit({ windowMs: 60_000, max: 10 }) }))
//
// How to call it from the frontend:
//   const { data } = await api.post('/api/accounts/email-check', { email: 'sam@example.com' })

// The longest an email address can be (RFC 5321). Anything longer is refused before it reaches the database.
export const EMAIL_MAX = 254

const emailCheckBody = z.object({ email: z.string().trim().min(1).max(EMAIL_MAX).email() })

// How long to wait for the database before answering 503, in milliseconds.
const LOOKUP_TIMEOUT_MS = 5000

// Answers 503 in the flat error shape.
//
// How to call:
//   return unavailable(res)
function unavailable(res) {
  res.set('Retry-After', '10')
  res.status(503).json({ error: 'accounts_unavailable', message: 'Accounts cannot be checked right now. Try again shortly.' })
}

// Asks the database whether an email has an account. Resolves true or false, or throws when the database gives no
// clear answer. The error it throws never carries the email.
//
// How to call:
//   const registered = await lookUp(supabase, 'sam@example.com', 5000)
async function lookUp(supabase, email, timeoutMs) {
  let timer
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('The database did not answer in time.')), timeoutMs)
  })
  try {
    const { data, error } = await Promise.race([supabase.service.rpc('email_registered', { p_email: email }), late])
    if (error) throw Object.assign(new Error('The database refused the lookup.'), { code: typeof error.code === 'string' && error.code ? error.code.slice(0, 20) : undefined })
    if (typeof data !== 'boolean') throw new Error('The database answered something other than true or false.')
    return data
  } finally {
    clearTimeout(timer)
  }
}

// Builds the router. `limiter` is middleware that limits how often one caller may ask (or null for no limit, which only
// tests use); `supabase` is from createSupabase(), or null when Supabase is not set up (every answer is then 503).
//
// How to call:
//   const router = createAccountsRouter({ supabase, limiter, timeoutMs: 5000 })
export function createAccountsRouter({ supabase = null, limiter = null, timeoutMs = LOOKUP_TIMEOUT_MS } = {}) {
  const router = Router()

  router.post('/accounts/email-check', ...(limiter ? [limiter] : []), async (req, res) => {
    // An answer about an account must never be kept by a browser or a proxy.
    res.set('Cache-Control', 'no-store')
    const body = emailCheckBody.safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ error: 'invalid_input', message: `Send { "email": "name@example.com" }, an email address of up to ${EMAIL_MAX} characters.` })
      return
    }
    if (!supabase) return unavailable(res)
    try {
      res.json({ registered: await lookUp(supabase, body.data.email, timeoutMs) })
    } catch (err) {
      // Only a fixed sentence and the database's short error code: the email is never written to a log.
      console.warn(`The account lookup failed (${err?.code ?? 'no code'}).`)
      unavailable(res)
    }
  })

  return router
}
