import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadPlanData } from '../src/db/venues.js'
import { MAX } from '../src/routes/plan-schemas.js'

// Guards on the SQL files of the session plan, which no test here can run (there is no Postgres): the migration and db/schema.sql carry
// the same function, the test file numbers its steps without a gap, and every quote and bracket balances (a missing quote once stopped a
// whole test file). The function itself is tested on the live project, in a transaction that rolls back, with db/tests/apply_session_plan.sql.
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const MIGRATION = 'db/migrations/20261022000000_jio_apply_session_plan_slots.sql'

const functionOf = (sql) => {
  const start = sql.indexOf('create or replace function public.apply_session_plan')
  return sql.slice(start, sql.indexOf('\n$$;\n', start) + 5)
}

// Quotes, brackets and dollar quotes of a SQL text, ignoring comments. Answers what is wrong, or null.
// How to call: unbalanced("select 'a'") // null
function unbalanced(sql) {
  let inString = false
  let depth = 0
  const dollars = []
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i]
    if (inString) {
      if (c === "'" && sql[i + 1] === "'") i += 1
      else if (c === "'") inString = false
      continue
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1
      continue
    }
    if (c === "'") inString = true
    else if (c === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 40))?.[0]
      if (tag) {
        if (dollars.at(-1) === tag) dollars.pop()
        else dollars.push(tag)
        i += tag.length - 1
      }
    } else if (c === '(') depth += 1
    else if (c === ')') depth -= 1
    if (depth < 0) return 'a ) with no ('
  }
  if (inString) return 'a string never closes'
  if (depth !== 0) return `${depth} ( never closed`
  if (dollars.length) return `${dollars.at(-1)} never closes`
  return null
}

describe('the function in the migration and in db/schema.sql', () => {
  it('is the same text', () => {
    expect(functionOf(read('db/schema.sql'))).toBe(functionOf(read(MIGRATION)))
  })

  it('is granted to the server only, in the migration and in db/policies.sql', () => {
    for (const sql of [read(MIGRATION), read('db/policies.sql')]) {
      expect(sql).toMatch(/revoke execute on function[^;]*public\.apply_session_plan\(uuid, bigint, text, jsonb\)[^;]*from public, anon, authenticated/)
      expect(sql).toMatch(/grant execute on function[^;]*public\.apply_session_plan\(uuid, bigint, text, jsonb\)[^;]*to service_role/)
    }
  })

  it('adds slots.details itself, so that one apply covers stage 4 (20261011000200 folded in)', () => {
    const migration = read(MIGRATION)
    const slice = read('db/migrations/20261011000200_jio_slot_details.sql')
    const addColumn = (sql) => /alter table public\.slots\s+add column if not exists details jsonb not null default '\{\}'\s+constraint slots_details_shape check \([^;]*\);/.exec(sql)?.[0].replace(/\s+/g, ' ')
    expect(addColumn(migration)).toBeTruthy()
    expect(addColumn(migration)).toBe(addColumn(slice))
    expect(migration.indexOf('add column if not exists details')).toBeLessThan(migration.indexOf('do $venue_checks$'))
    expect(migration).toContain('MUST BE APPLIED BEFORE THE STAGE 4 BACKEND RUNS')
    expect(migration).toContain('20261011000200')
    expect(slice).toContain('20261022000000')
  })

  it('refuses a part of the plan it does not know, ignores a swap of a place for itself and writes only the minutes that differ', () => {
    const sql = functionOf(read(MIGRATION))
    expect(sql).toContain("keys.k not in ('ops', 'spots', 'slots', 'session', 'loaded_at', 'recomputed', 'banner_text')")
    expect(sql).toContain("keys.k not in ('status', 'meeting', 'banner', 'radius_meters')")
    expect(sql).toContain("if (op ->> 'from') is not distinct from (op ->> 'to') then")
    expect(sql).toMatch(/and m\.travel_minutes is distinct from case/)
  })

  it('keeps every rule of stage 3 and adds the slot rules', () => {
    const sql = functionOf(read(MIGRATION))
    for (const hint of ['area_pinned', 'pin_without_confirm', 'host_member', 'needs_two_people', 'status_transition', 'slots_status', 'slot_missing']) expect(sql).toContain(`hint = '${hint}'`)
    for (const op of ['opt_out', 'rejoin', 'remove_member', 'suggest', 'unsuggest', 'clear_approvals', 'clear_suggestions', 'clear_votes', 'swap_option']) expect(sql).toContain(`when '${op}' then`)
  })
})

describe('the limit on a place\'s id', () => {
  // The 32 hawker centres saved from OneMap have ids of 86 characters, and are the places a halal group is offered, so the tables allow 160
  // (the same as MAX.venueId in routes/plan-schemas.js, which the session routes and GET /api/venues use).
  it('is 160 in every table that holds one, in a fresh build and in the migration, and nothing keeps 80', () => {
    const schema = read('db/schema.sql')
    const migration = read(MIGRATION)
    expect(schema.match(/venue_id text not null check \(char_length\(venue_id\)[^)]*\)/g)).toEqual([
      'venue_id text not null check (char_length(venue_id) <= 160)',
      'venue_id text not null check (char_length(venue_id) <= 160)',
      'venue_id text not null check (char_length(venue_id) between 1 and 160)',
    ])
    for (const table of ['slot_options', 'stops']) expect(migration).toContain(`alter table public.${table} add constraint ${table}_venue_id_check check (char_length(venue_id) <= 160)`)
    expect(migration).toContain('alter table if exists public.stop_proposals add constraint stop_proposals_venue_id_check')
    expect(read('db/migrations/20261011000300_jio_session_plan.sql')).toContain('check (char_length(venue_id) between 1 and 160)')
    for (const sql of [schema, migration, read('db/migrations/20261011000300_jio_session_plan.sql')]) expect(sql).not.toMatch(/char_length\(venue_id\)[^)]*\b80\b/)
  })

  // The old checks (80) are found by what they check, not by name, so a check under any name goes: the migration, db/schema.sql (for a
  // project built before stage 4) and the SQL test run one and the same block.
  const dropBlock = (sql) => {
    const start = sql.indexOf('do $venue_checks$')
    return sql.slice(start, sql.indexOf('$venue_checks$;', start + 20) + '$venue_checks$;'.length)
  }

  it('drops every check that mentions the id by its definition, in the migration, db/schema.sql and the test', () => {
    const migration = read(MIGRATION)
    const block = dropBlock(migration)
    expect(block).toContain("pg_get_constraintdef(con.oid) like '%venue_id%'")
    expect(block).toContain("to_regclass('public.slot_options'), to_regclass('public.stops'), to_regclass('public.stop_proposals')")
    expect(migration).not.toMatch(/drop constraint if exists \w*venue_id_check/)
    expect(dropBlock(read('db/schema.sql'))).toBe(block)
    // The test holds the statement without its closing semicolon, inside a dollar quote of its own.
    const test = read('db/tests/apply_session_plan.sql')
    expect(test).toContain(`$sql$${block.slice(0, -1)}$sql$`)
  })

  it('is the same in the requests: MAX.venueId, the session routes and the saved places', () => {
    expect(MAX.venueId).toBe(160)
    const longest = Math.max(...loadPlanData().venues.map((v) => v.id.length))
    expect(longest).toBeLessThanOrEqual(MAX.venueId)
    expect(longest).toBeGreaterThan(80)
  })
})

describe('the SQL files', () => {
  it('balance: every quote, bracket and dollar quote closes', () => {
    for (const file of [MIGRATION, 'db/tests/apply_session_plan.sql', 'db/schema.sql', 'db/policies.sql']) expect(unbalanced(read(file)), file).toBeNull()
  })

  it('the unbalanced() guard itself catches a missing quote and a missing bracket', () => {
    expect(unbalanced("select 'a")).not.toBeNull()
    expect(unbalanced('select (1')).not.toBeNull()
    expect(unbalanced("select 'it''s' -- 'not a quote\n")).toBeNull()
  })

  it('the test of apply_session_plan numbers its steps from 1 without a gap or a repeat', () => {
    // Comments hold examples of a call ("expect_error(7, ..."), so they are left out.
    const sql = read('db/tests/apply_session_plan.sql').replace(/^\s*--.*$/gm, '')
    const steps = [...sql.matchAll(/pg_temp\.expect_(?:error|ok|count|text|hint)\((\d+),/g)].map((m) => Number(m[1]))
    expect(steps).toEqual(Array.from({ length: steps.length }, (_, i) => i + 1))
    expect(steps.length).toBeGreaterThan(172 - 1)
  })
})
