import { defineConfig } from 'vitest/config'

// The backend's tests rely on the 36 invented venues and the sample visit history in mock-data.json, which the planner
// leaves out unless INCLUDE_FICTIONAL_VENUES=1. It is set here, not guessed from NODE_ENV, so a machine or a host with
// any NODE_ENV serves and tests the same pool. A test that checks the default pool turns it off with vi.stubEnv.
// PLANNER_DIAGNOSTICS=1 keeps the engine's `diagnostics` in planner answers, which many tests read; a test of the public
// shape passes `includePlannerDiagnostics: false` to createApp.
//
// How to call:
//   pnpm test   // runs vitest with this file
export default defineConfig({
  test: {
    env: { INCLUDE_FICTIONAL_VENUES: '1', PLANNER_DIAGNOSTICS: '1' },
  },
})
