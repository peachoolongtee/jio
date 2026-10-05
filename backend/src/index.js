import 'dotenv/config'
import { createApp } from './app.js'

const isProduction = process.env.NODE_ENV === 'production'
const port = Number(process.env.PORT) || 3000

// In production the origin must be set explicitly; locally it falls back to the Vite dev server.
const frontendOrigin = process.env.FRONTEND_ORIGIN || (isProduction ? null : 'http://localhost:5173')
if (!frontendOrigin) {
  console.error('FRONTEND_ORIGIN is not set. Copy backend/.env.example to backend/.env or set it on the host.')
  process.exit(1)
}

createApp({ frontendOrigin }).listen(port, () => {
  console.log(`Jio backend listening on port ${port}, allowing ${frontendOrigin}`)
})
