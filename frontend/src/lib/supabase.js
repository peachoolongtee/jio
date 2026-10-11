import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// The browser client for auth, CRUD under Row Level Security and realtime, or null when the two variables are not set.
// Without them the app keeps its local accounts (see lib/auth.js). Under the test runner it is always null, so a
// developer's own .env can never make the suite reach a real project; a test hands lib/auth.js a stand-in client.
// How to call: import { supabase, supabaseConfigured } from './supabase.js'; if (supabaseConfigured) await supabase.auth.getSession()
export const supabase = url && anonKey && !import.meta.env.VITEST ? createClient(url, anonKey) : null

export const supabaseConfigured = supabase !== null
