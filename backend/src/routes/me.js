import { Router } from 'express'
import { requireUser } from '../middleware/auth.js'

// Who the caller is. The first route that needs a login, and the one to copy for the next.
//
//   GET /api/me   →   { user: { id, email }, profile: { id, username, display_name, avatar_url } }
//
// How to mount it (app.js does this when Supabase is configured):
//   app.use('/api', createMeRouter({ supabase }))
//
// How to call it from the frontend:
//   const { data } = await api.get('/api/me', { headers: { Authorization: `Bearer ${session.access_token}` } })
export function createMeRouter({ supabase }) {
  const router = Router()

  router.get('/me', requireUser({ supabase }), async (req, res, next) => {
    try {
      // Read as the user, so the database's own rules decide what comes back.
      const { data: profile, error } = await req.supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url')
        .eq('id', req.user.id)
        .maybeSingle()
      if (error) throw new Error(`Could not load the profile: ${error.message}`)
      res.json({ user: req.user, profile })
    } catch (err) {
      next(err)
    }
  })

  return router
}
