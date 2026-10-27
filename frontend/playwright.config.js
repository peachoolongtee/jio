// Playwright settings for the end-to-end tests in tests/e2e. Read tests/e2e/README.md first.
//
// Running the tests starts two servers of their own, on ports nobody else uses:
//   backend  http://localhost:3994  in stub mode (STUB_EXTERNALS=1): OneMap, weather and Google answer from fixtures
//   frontend http://localhost:5194  the Vite dev server, pointed at that backend
// Every secret is set to an empty string for both, so a developer's own .env files (which hold real keys) can never make a
// test reach Supabase, OneMap, Google or Gemini. An empty value from here beats the same name in an .env file: dotenv does
// not overwrite a variable that is already set, and Vite lets the process's variables win over its .env files.
//
// How to call: pnpm --filter jio-frontend test:e2e
import { defineConfig, devices } from '@playwright/test'

const BACKEND_PORT = 3994
const FRONTEND_PORT = 5194
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`

// Names that would let a server reach a real service. Each is emptied for the servers started below.
const BLANKED = [
  'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ALLOW_LEGACY_TOKENS',
  'ONEMAP_EMAIL', 'ONEMAP_PASSWORD', 'LTA_ACCOUNT_KEY', 'GOOGLE_MAPS_API_KEY',
  'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'YOUTUBE_API_KEY', 'LINK_READER',
  'LINK_READER_YTDLP', 'LINK_READER_BROWSER',
]

// A server's environment: the blanked names, then the settings given.
// How to call: serverEnv({ PORT: '3994' }) -> { SUPABASE_URL: '', ..., PORT: '3994' }
function serverEnv(settings) {
  return { ...Object.fromEntries(BLANKED.map((name) => [name, ''])), ...settings }
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.js',
  // One worker: the servers are shared, and each test already gets its own browser context (its own storage), so this is
  // for the shared stub backend and for readable output, not for the data. Raise it only after running --repeat-each=3 with it.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  outputDir: './test-results',
  use: {
    baseURL: FRONTEND_URL,
    // Kept for a failed test only; open it with: pnpm --filter jio-frontend exec playwright show-trace <trace.zip>
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The app shows Singapore dates and times, so every test runs in Singapore.
    locale: 'en-SG',
    timezoneId: 'Asia/Singapore',
    // Same size as the desktop layout in the design (the top bar shows from 744 px).
    viewport: { width: 1280, height: 800 },
    serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: [
    {
      name: 'backend (stub mode)',
      command: 'node src/index.js',
      cwd: '../backend',
      url: `${BACKEND_URL}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: serverEnv({
        STUB_EXTERNALS: '1',
        PORT: String(BACKEND_PORT),
        FRONTEND_ORIGIN: FRONTEND_URL,
        NODE_ENV: 'development',
      }),
    },
    {
      name: 'frontend (Vite dev server)',
      // --strictPort: fail if 5194 is taken, never move to another port.
      command: `pnpm exec vite --port ${FRONTEND_PORT} --strictPort --host localhost`,
      url: FRONTEND_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: serverEnv({
        // The page calls the stub backend directly. Supabase stays empty, so the app uses its local (demo) accounts, which a
        // development build allows.
        VITE_API_BASE_URL: BACKEND_URL,
        JIO_BACKEND_URL: BACKEND_URL,
        VITE_SUPABASE_URL: '',
        VITE_SUPABASE_ANON_KEY: '',
        VITE_ALLOW_LOCAL_ACCOUNTS: '',
        VITE_DEMO_TOUR: '',
      }),
    },
  ],
})
