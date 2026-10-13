import { Router } from 'express'
import { z, ZodError } from 'zod'
import { LinkReaderError, REFRESH_MAX } from '../services/link-reader.js'

// Reading places out of a post someone pastes, so they can be saved. Full shapes: backend/docs/link-reader-api.md.
//
//   POST /api/links/read          read a YouTube, TikTok, Instagram or Xiaohongshu link: the places in it, whether each is
//                                 open now, and its Google Maps match. Nothing is saved.
//   POST /api/links/refresh       the current state (still open? address, rating) of places saved earlier, by Google place id
//   GET  /api/links/capabilities  what this server can read, so a screen can offer only what works
//
// How to mount it (app.js does this, and only when the link reader is switched on with LINK_READER=1):
//   app.use('/api', createLinksRouter({ reader: linkReader, limiter, readLimit, refreshLimit }))
//
// `limiter` is an optional middleware (see middleware/rate-limit.js) that runs before each route. `readLimit` and
// `refreshLimit` are optional middleware that hold one caller to a few reads and a few refreshes a minute; they run before
// anything is checked or gathered, so a request over the limit costs nothing. With the reader set up but no Gemini key, read
// and refresh answer 503.
export function createLinksRouter({ reader, limiter = null, readLimit = null, refreshLimit = null }) {
  const router = Router()
  const guard = limiter ? [limiter] : []
  const perRead = readLimit ? [readLimit] : []
  const perRefresh = refreshLimit ? [refreshLimit] : []

  // The reader needs a Gemini key to read or refresh anything: without one, say so plainly.
  const needsKey = (req, res, next) => {
    if (reader.enabled) return next()
    res.status(503).json({ error: 'link_reader_unavailable', message: 'Reading links is not set up on this server: it has no GEMINI_API_KEY.' })
  }

  // Singapore, with a little margin: the point a search leans towards. Catches swapped latitude and longitude.
  const point = z.object({ lat: z.number().min(1.1).max(1.5), lng: z.number().min(103.5).max(104.1) })
  const readBody = z.object({ url: z.string().min(1).max(600), centre: point.optional() })
  const refreshBody = z.object({ placeIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,300}$/)).min(1).max(REFRESH_MAX) })

  const invalid = (res, issues) =>
    res.status(400).json({ error: 'invalid_input', message: 'Some fields in the request are missing or not valid. See issues.', issues })

  // Turns a thrown ZodError into the 400 every planner route sends, and a LinkReaderError into its own 400.
  const handle = (run) => async (req, res, next) => {
    try {
      res.json(await run(req))
    } catch (err) {
      if (err instanceof ZodError) invalid(res, err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
      else if (err instanceof LinkReaderError) res.status(400).json({ error: err.code, message: err.message })
      else next(err)
    }
  }

  router.get('/links/capabilities', ...guard, (req, res) => res.json(reader.capabilities()))
  router.post('/links/read', ...guard, ...perRead, needsKey, handle((req) => {
    const { url, centre } = readBody.parse(req.body ?? {})
    return reader.read(url, { centre })
  }))
  router.post('/links/refresh', ...guard, ...perRefresh, needsKey, handle((req) => reader.refresh(refreshBody.parse(req.body ?? {}).placeIds)))

  return router
}
