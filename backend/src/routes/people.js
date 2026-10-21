import { Router } from 'express'
import { z } from 'zod'
import { requireUser } from '../middleware/auth.js'

// Finding a person to invite by the start of their username, for the invite screens.
//
//   GET /api/people/search?q=sam_   →   { people: [{ id, name, username, avatarUrl, metBefore }] }
//
// Why a route and not a read of `profiles` in the browser: the profiles table is readable whole by any signed-in user today.
// Going through the server lets that rule be narrowed to the person and the people they share a session with later (ticket
// #125) without this screen changing. The server reads with its own key and selects only the four public columns.
//
// What it matches: the START of a username only (never a display name, never the middle), case does not matter, and the
// caller never appears. `q` is 3 to 20 characters of the username alphabet (db/schema.sql: username ~ '^[a-z0-9_]{3,20}$'),
// trimmed and lower-cased; anything else is 400 invalid_input. Usernames contain underscores, which LIKE reads as "any one
// character", so `%`, `_` and `\` are escaped before the pattern is made: "sam_" matches "sam_tan" and not "samuel".
//
// Order, at most 5: the exact match first; then people the caller has been in a session with; then the rest. Inside each group
// the database's order of username. Who has been met is asked after the matches are known, of the caller's own client and only
// about those matches (`session_members` where `user_id` is one of them), so the database's access rules decide which sessions
// count and its row cap on a read never cuts the answer. If that read fails the search still answers, in username order with
// `metBefore` false everywhere: it only affects the order.
//
// Every answer, including a refusal, carries `Cache-Control: no-store`: who matches a name is not for a shared cache.
// Every failure is { error, message }: 400 invalid_input, 401 and 503 from the login check, 429 over the limit. A database
// that fails answers 500 through the app's error handler.
//
// How to mount it (app.js does this when Supabase is configured):
//   app.use('/api', createPeopleRouter({ supabase, limiter }))
//
// How to call it from the frontend (lib/plannerApi.js searchPeopleByUsername):
//   const { data } = await api.get('/api/people/search', { params: { q: 'sam' } })

// The most people one search answers with.
export const PEOPLE_LIMIT = 5
// How many matches are fetched, by username, before the caller's own sessions are asked which of them they share. The five shown
// are chosen from these, so a person met before who sorts after the first 50 matches is not put ahead of the others.
const CANDIDATES = 50
const COLUMNS = 'id, username, display_name, avatar_url'

const query = z.object({ q: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,20}$/) })

// Answers in the flat error shape. How to call: refuse(res, 400, 'invalid_input', 'Send q.')
function refuse(res, status, error, message) {
  res.status(status).json({ error, message })
}

// The pattern for "starts with this text", with LIKE's own characters made plain.
// How to call: prefixPattern('sam_') -> 'sam\\_%'
export function prefixPattern(text) {
  return `${text.replace(/[\\%_]/g, '\\$&')}%`
}

// A row of profiles as the answer's person. A person with no display name shows their username.
// How to call: toPerson({ id: 'u1', username: 'sam', display_name: null, avatar_url: null }, true)
function toPerson(row, metBefore) {
  const name = typeof row.display_name === 'string' ? row.display_name.trim() : ''
  return {
    id: row.id,
    name: name || row.username,
    username: row.username,
    avatarUrl: typeof row.avatar_url === 'string' ? row.avatar_url : '',
    metBefore,
  }
}

// Builds the router. `limiter` limits how often one signed-in caller may search, or is null for no limit (tests only).
//
// How to call:
//   const router = createPeopleRouter({ supabase, limiter: rateLimit({ windowMs: 60_000, max: 120 }) })
export function createPeopleRouter({ supabase, limiter = null }) {
  const router = Router()

  // Before the login check, so a 401, a 429 and a 400 are marked too.
  router.use('/people/search', (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })

  router.get('/people/search', requireUser({ supabase }), ...(limiter ? [limiter] : []), async (req, res, next) => {
    try {
      const parsed = query.safeParse({ q: req.query.q })
      if (!parsed.success) {
        return refuse(res, 400, 'invalid_input', 'Send q: 3 to 20 letters, numbers or underscores from the start of a username.')
      }
      const q = parsed.data.q
      const me = req.user.id.toLowerCase()

      // The username is lower case in the database (username_format), and so is q, so a plain LIKE is enough.
      const [exact, first] = await Promise.all([
        supabase.service.from('profiles').select(COLUMNS).eq('username', q).neq('id', me).maybeSingle(),
        supabase.service.from('profiles').select(COLUMNS).like('username', prefixPattern(q)).neq('id', me).order('username', { ascending: true }).limit(CANDIDATES),
      ])
      for (const [what, result] of [['the exact match', exact], ['the matches', first]]) {
        if (result.error) throw new Error(`Could not load ${what}: ${result.error.message}`)
      }
      const rows = []
      const taken = new Set()
      for (const row of [exact.data, ...(first.data ?? [])]) {
        if (!row || taken.has(row.id) || row.id.toLowerCase() === me) continue
        taken.add(row.id)
        rows.push(row)
      }

      // Which of them share a session with the caller: asked as the caller, about these people only.
      const metIds = new Set()
      if (rows.length) {
        try {
          const met = await req.supabase.from('session_members').select('user_id').in('user_id', rows.map((r) => r.id))
          if (met.error) throw new Error(met.error.code ?? 'no code')
          for (const m of met.data ?? []) metIds.add(String(m.user_id).toLowerCase())
        } catch (err) {
          console.warn(`Could not read who the caller has met, so a people search is not ordered by it (${err.message}).`)
          metIds.clear()
        }
      }
      const rank = (row) => (row.username === q ? 0 : metIds.has(row.id.toLowerCase()) ? 1 : 2)
      // Array.prototype.sort is stable, so inside a group the database's order stays.
      const people = [...rows].sort((a, b) => rank(a) - rank(b)).slice(0, PEOPLE_LIMIT).map((row) => toPerson(row, metIds.has(row.id.toLowerCase())))
      res.json({ people })
    } catch (err) {
      next(err)
    }
  })

  return router
}
