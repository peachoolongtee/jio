import { describe, expect, it } from 'vitest'
import { checkPlanSchema } from '../src/db/sessions.js'

// checkPlanSchema: a backend started before the stage 5 migration fails at start-up, naming the migration. The database is a stand-in that
// answers the probes the check makes.
const service = (answers) => ({
  from: (table) => ({
    select: (columns) => ({ limit: async () => answers(table, columns) }),
  }),
})

describe('checkPlanSchema', () => {
  it('passes when every table and column is there', async () => {
    const asked = []
    await checkPlanSchema(service((table, columns) => (asked.push([table, columns]), { error: null })))
    expect(asked.map(([table]) => table)).toEqual(['sessions', 'stops', 'stop_proposals'])
    expect(asked[0][1]).toContain('weather_kept')
  })

  it('names the migration when a column is missing (through the database, or through PostgREST\'s schema cache)', async () => {
    for (const code of ['42703', '42P01', 'PGRST204', 'PGRST205']) {
      const failure = await checkPlanSchema(service((table) => (table === 'stops' ? { error: { code, message: 'no such thing' } } : { error: null }))).catch((e) => e)
      expect(failure.message).toContain('20261023000000_jio_apply_session_plan_stops.sql')
      expect(failure.message).toContain('stops')
      expect(failure.unreachable).toBeUndefined()
    }
  })

  it('says a database that cannot be reached is not a missing migration', async () => {
    const failure = await checkPlanSchema(service(() => ({ error: { code: '', message: 'fetch failed' } }))).catch((e) => e)
    expect(failure.unreachable).toBe(true)
    expect(failure.message).not.toContain('Apply')
  })
})
