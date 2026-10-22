import { Router } from 'express'
import { z } from 'zod'
import { requireUser } from '../middleware/auth.js'
import { MAX } from './plan-schemas.js'

// The saved places behind the cards of a voting session (E18). A slot's options and a confirmed plan's stops are stored by venue id, and
// the venues live in the planner's data, so the browser asks for the ones it is showing:
//
//   GET /api/venues?ids=ya-kun-kaya-toast,tiong-bahru-bakery   ->   { venues: [ { id, name, lat, lng, category, ... } ] }
//
// Any signed-in person may ask (a place is public information; the answer carries nothing about a session or a person). At most 50 ids,
// each up to 160 characters, separated by commas; an id the planner does not know is left out, and the others come back in the order
// asked, each once. The venues are the planner's own, as POST /api/converge sends them, before the card fields the browser adds
// (toCardVenue in lib/plannerApi.js). A 400 is { error: 'invalid_input', message, issues }.
//
// How to mount it (app.js does this when Supabase is configured):
//   app.use('/api', createVenuesRouter({ supabase, data: loadPlanData(), limiter }))
//
// How to call it from the frontend:
//   const { data } = await api.get('/api/venues', { params: { ids: 'ya-kun-kaya-toast,tiong-bahru-bakery' } })

// The most places one call returns.
const MAX_IDS = 50

// The ids of a request: comma-separated, trimmed, empty pieces dropped, each place once.
const ids = z
  .string()
  .min(1)
  .transform((text) => [...new Set(text.split(',').map((id) => id.trim()).filter(Boolean))])
  .pipe(z.array(z.string().max(MAX.venueId)).min(1).max(MAX_IDS))

// Builds the router. `limiter` limits how often one signed-in caller may use it, or is null for no limit (tests only).
//
// How to call:
//   const router = createVenuesRouter({ supabase, data, limiter: null })
export function createVenuesRouter({ supabase, data, limiter = null }) {
  const router = Router()
  const byId = new Map(data.venues.map((v) => [v.id, v]))
  router.get('/venues', requireUser({ supabase }), ...(limiter ? [limiter] : []), (req, res) => {
    const parsed = z.object({ ids }).safeParse({ ids: typeof req.query.ids === 'string' ? req.query.ids : '' })
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_input',
        message: `Send up to ${MAX_IDS} place ids, separated by commas, each up to ${MAX.venueId} characters.`,
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
      return
    }
    res.json({ venues: parsed.data.ids.map((id) => byId.get(id)).filter(Boolean) })
  })
  return router
}
