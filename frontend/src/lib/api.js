import axios from 'axios'

// Calls to the Jio backend (planner, geocode and weather proxy).
// Attaching the Supabase session token waits on the JWT verification decision.
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  timeout: 15000,
})
