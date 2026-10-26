import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadPlanData } from '../src/db/venues.js'
import { MAX } from '../src/routes/plan-schemas.js'

// Guards on the SQL files of the session plan, which no test here can run (there is no Postgres): the newest migration and db/schema.sql carry
// the same function, the test file numbers its steps without a gap, and every quote and bracket balances (a missing quote once stopped a
// whole test file). The function itself is tested on the live project, in a transaction that rolls back, with db/tests/apply_session_plan.sql.
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const STAGE4 = 'db/migrations/20261022000000_jio_apply_session_plan_slots.sql'
const MIGRATION = 'db/migrations/20261023000000_jio_apply_session_plan_stops.sql'
const RELEASE = 'db/migrations/20261027000000_jio_change_meeting_place.sql'
const SLICE_D = 'db/migrations/20261011000300_jio_session_plan.sql'

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
  it('is the same text as the newest migration that replaces it (the change of meeting place)', () => {
    expect(functionOf(read('db/schema.sql'))).toBe(functionOf(read(RELEASE)))
  })

  it('is granted to the server only, in the migration and in db/policies.sql', () => {
    for (const sql of [read(MIGRATION), read(RELEASE), read('db/policies.sql')]) {
      expect(sql).toMatch(/revoke execute on function[^;]*public\.apply_session_plan\(uuid, bigint, text, jsonb\)[^;]*from public, anon, authenticated/)
      expect(sql).toMatch(/grant execute on function[^;]*public\.apply_session_plan\(uuid, bigint, text, jsonb\)[^;]*to service_role/)
    }
  })

  it('adds slots.details itself, so that one apply covers stage 4 (20261011000200 folded in)', () => {
    const migration = read(STAGE4)
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
    expect(sql).toContain("keys.k not in ('ops', 'spots', 'slots', 'stops', 'stop_options', 'ledger', 'session', 'loaded_at', 'recomputed', 'banner_text')")
    expect(sql).toContain("keys.k not in ('status', 'meeting', 'banner', 'radius_meters', 'replan', 'plan_start_minute', 'order_note', 'order_suggestion', 'weather_kept')")
    expect(sql).toContain("if (op ->> 'from') is not distinct from (op ->> 'to') then")
    expect(sql).toMatch(/and m\.travel_minutes is distinct from case/)
  })

  it('keeps every rule of stage 3 and 4 and adds the plan rules', () => {
    const sql = functionOf(read(MIGRATION))
    for (const hint of ['area_pinned', 'pin_without_confirm', 'host_member', 'needs_two_people', 'status_transition', 'slots_status', 'slot_missing']) expect(sql).toContain(`hint = '${hint}'`)
    for (const op of ['opt_out', 'rejoin', 'remove_member', 'suggest', 'unsuggest', 'clear_approvals', 'clear_suggestions', 'clear_votes', 'swap_option']) expect(sql).toContain(`when '${op}' then`)
    for (const hint of [
      'stops_status', 'order_status', 'ledger_status', 'stops_missing', 'not_enough_votes', 'too_many_stops', 'stop_slot', 'stop_missing', 'last_stop', 'stop_order',
      'stop_duplicate', 'stop_not_option', 'ledger_member', 'ledger_sum', 'proposal_status', 'proposal_member', 'already_a_stop', 'plan_full', 'too_many_proposals',
      'stale_tally', 'ledger_missing', 'ledger_duplicate',
    ]) expect(sql).toContain(`hint = '${hint}'`)
    for (const op of ['propose', 'resolve_proposal']) expect(sql).toContain(`when '${op}' then`)
  })

  // Stage 3 and 4's rules are the same text in the stage 5 function wherever stage 5 does not change them: every line of the stage 4
  // function is still there, except the few that stage 5 rewrites (the declarations are extended, the list of known parts and the status
  // rule are widened, and clear_votes also allows the move that opens the plan again).
  it('keeps the text of the stage 4 function, apart from the lines stage 5 widens', () => {
    const before = functionOf(read(STAGE4)).split('\n')
    const after = new Set(functionOf(read(MIGRATION)).split('\n'))
    const missing = before.filter((line) => !after.has(line))
    expect(missing.map((line) => line.trim())).toEqual([
      "where keys.k not in ('ops', 'spots', 'slots', 'session', 'loaded_at', 'recomputed', 'banner_text')",
      "where keys.k not in ('status', 'meeting', 'banner', 'radius_meters')",
      "-- Rule 1: the only move is the host's confirm (or known place), from inviting or locating to voting, with an area.",
      '-- (The two-people check for leaving inviting comes after the ops below.)',
      "if not (s.status in ('inviting', 'locating') and new_status = 'voting')",
      "or coalesce(meeting ->> 'area_id', '') = '' then",
      "-- Rule 5: a pin only with a confirm. Setting 'voted' or 'chosen' needs the move to voting in this patch, or the same pin",
      '-- (method and area) already stored.',
      "if (meeting ->> 'method') in ('voted', 'chosen') and new_status = s.status",
      '-- Rule 7: votes are cleared only in a voting session. The meeting area moved, so every vote is for a place that no',
      '-- longer belongs to it.',
      'if meeting_changed or travel_changed or banner_changed or radius_changed or banner_text is not null then',
    ])
  })

  // Slice d (20261011000300) is folded in statement for statement, so applying it before, after or not at all changes nothing.
  it('folds in slice d: every statement of 20261011000300 after its header is in the migration, unchanged', () => {
    const slice = read(SLICE_D)
    const body = slice.slice(slice.indexOf('-- ── Columns and checks on sessions'))
    expect(read(MIGRATION)).toContain(body.trim())
  })

  // The vote guard and the kept rain warnings are in the migration and in a fresh build alike, the same text.
  it('carries the vote guard and sessions.weather_kept in the migration and in db/schema.sql, the same text', () => {
    const guard = (sql) => {
      const start = sql.indexOf('create or replace function public.votes_guard_status()')
      return sql.slice(start, sql.indexOf('for each row execute function public.votes_guard_status();', start) + 'for each row execute function public.votes_guard_status();'.length)
    }
    expect(guard(read('db/schema.sql'))).toBe(guard(read(MIGRATION)))
    expect(guard(read(MIGRATION))).toContain('for share of s')
    for (const sql of [read(MIGRATION), read('db/schema.sql')]) {
      expect(sql).toContain('alter table public.sessions add column if not exists weather_kept jsonb;')
      expect(sql).toContain('constraint weather_kept_shape')
      expect(sql).toContain('create trigger votes_guard_status after insert or update or delete on public.votes')
    }
  })

  it('needs to be applied before the stage 5 backend runs, and says so', () => {
    const migration = read(MIGRATION)
    expect(migration).toContain('MUST BE APPLIED BEFORE THE STAGE 5 BACKEND RUNS')
    expect(migration).toContain('20261011000300')
    // Every statement that adds something is guarded, so a second apply (or 0300 after it) does nothing.
    expect(migration).not.toMatch(/\bcreate table (?!if not exists)/)
    expect(migration).not.toMatch(/\bcreate index (?!if not exists)/)
    expect(migration).not.toMatch(/\badd column (?!if not exists)/)
  })
})

describe('the limit on a place\'s id', () => {
  // The 32 hawker centres saved from OneMap have ids of 86 characters, and are the places a halal group is offered, so the tables allow 160
  // (the same as MAX.venueId in routes/plan-schemas.js, which the session routes and GET /api/venues use).
  it('is 160 in every table that holds one, in a fresh build and in the migration, and nothing keeps 80', () => {
    const schema = read('db/schema.sql')
    const migration = read(STAGE4)
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
    const migration = read(STAGE4)
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
    for (const file of [MIGRATION, RELEASE, STAGE4, 'db/tests/apply_session_plan.sql', 'db/schema.sql', 'db/policies.sql']) expect(unbalanced(read(file)), file).toBeNull()
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
    expect(steps.length).toBeGreaterThan(300 - 1)
  })
})

describe('the meet_by migration', () => {
  const MEET_BY = 'db/migrations/20261026000000_jio_session_meet_by.sql'
  // The text between the dollar quotes of guard_session_changes, as pg_proc.prosrc holds it.
  const guardBody = (sql) => {
    const start = sql.indexOf('create or replace function public.guard_session_changes()')
    const from = sql.indexOf('as $$', start) + 5
    return sql.slice(from, sql.indexOf('$$;', from))
  }
  const md5 = (text) => createHash('md5').update(text).digest('hex')

  it('carries the same guard as db/schema.sql, and the md5 it says it installs', () => {
    const migration = read(MEET_BY)
    expect(guardBody(migration)).toBe(guardBody(read('db/schema.sql')))
    const sums = [...migration.matchAll(/^--\s+([0-9a-f]{32})\s/gm)].map((m) => m[1])
    expect(sums).toHaveLength(2)
    expect(sums[1]).toBe(md5(guardBody(migration)))
    // The block that checks the live function names both sums, in the same order.
    expect(migration).toContain(`not in ('${sums[0]}', '${sums[1]}')`)
  })

  it('says the sum of the text it replaces: the guard as stage 5 left it, without the meet_by rule', () => {
    const migration = read(MEET_BY)
    const [before] = [...migration.matchAll(/^--\s+([0-9a-f]{32})\s/gm)].map((m) => m[1])
    // The old text is the new one without the meet_by block.
    const now = guardBody(migration)
    const old = now.replace(/\n {2}if new\.meet_by is distinct from old\.meet_by then[\s\S]*?\n {2}end if;\n(?=\n {2}return new;)/, '')
    expect(old).not.toBe(now)
    expect(md5(old)).toBe(before)
  })

  it('balances its quotes and brackets, and grants the column to signed-in users only through the one update grant', () => {
    expect(unbalanced(read(MEET_BY))).toBeNull()
    expect(unbalanced(read('db/tests/session_meet_by_access.sql'))).toBeNull()
    expect(read(MEET_BY)).toContain('grant update (meet_by) on public.sessions to authenticated;')
    expect(read('db/policies.sql')).toContain('grant update (title, date, start_time, end_time, status, meet_by) on public.sessions to authenticated;')
  })
})

describe('the change of meeting place migration', () => {
  const body = (sql) => {
    const fn = functionOf(sql)
    const from = fn.indexOf('as $$') + 5
    return fn.slice(from, fn.indexOf('\n$$;', from) + 1)
  }
  const md5 = (text) => createHash('md5').update(text).digest('hex')
  // What the live project holds for stage 5: the body without its comment lines and blank lines, with the line break after the opening quote.
  const stripped = (text) => `\n${text.split('\n').filter((line) => !/^\s*--/.test(line) && line.trim() !== '').join('\n')}\n`

  it('names the four sums it accepts, and they are those of the stage 5 text (live and file) and of its own text (with comments and without)', () => {
    const migration = read(RELEASE)
    const sums = [...migration.matchAll(/^--\s+([0-9a-f]{32})\s/gm)].map((m) => m[1])
    expect(sums).toHaveLength(4)
    expect(sums).toEqual([
      md5(stripped(body(read(MIGRATION)))),
      md5(body(read(MIGRATION))),
      md5(body(migration)),
      md5(stripped(body(migration))),
    ])
    // The sum of the live stage 5 body is the one CLAUDE.md records (the body was sent without its comment lines).
    expect(sums[0]).toBe('0b045589c032e034636cfc0e59306559')
    expect(migration).toContain(`not in ('${sums[0]}', '${sums[1]}', '${sums[2]}', '${sums[3]}')`)
    expect(md5(body(read('db/schema.sql')))).toBe(sums[2])
  })

  it('changes nothing of the stage 5 function but the lines that let a release through', () => {
    const before = functionOf(read(MIGRATION)).split('\n')
    const after = new Set(functionOf(read(RELEASE)).split('\n'))
    expect(before.filter((line) => !after.has(line)).map((line) => line.trim())).toEqual([
      '-- Rule 4: a pinned meeting area stays.',
      "if sp ? 'meeting' and s.meeting_method in ('voted', 'chosen')",
      '-- the outing (confirmed to completed). (The two-people check for leaving inviting comes after the ops below.)',
      "or (s.status = 'confirmed' and new_status in ('voting', 'completed'))) then",
      "meeting_area_id = case when meeting_changed then meeting ->> 'area_id' else meeting_area_id end,",
      "meeting_method = case when meeting_changed then meeting ->> 'method' else meeting_method end,",
      "meeting_max_minutes = case when meeting_changed then round((meeting ->> 'max_minutes')::numeric)::integer else meeting_max_minutes end,",
      "meeting_total_minutes = case when meeting_changed then round((meeting ->> 'total_minutes')::numeric)::integer else meeting_total_minutes end,",
      "meeting_count = case when meeting_changed then round((meeting ->> 'count')::numeric)::integer else meeting_count end,",
      "meeting_approximate = case when meeting_changed then (meeting ->> 'approximate')::boolean else meeting_approximate end,",
      "meeting_computed_at = case when meeting_changed and meeting ->> 'area_id' is not null then now()",
      "order_reason = case when reopened then null when sp ? 'order_note' then note_new ->> 'reason' else order_reason end,",
      "order_source = case when reopened then null when sp ? 'order_note' then note_new ->> 'source' else order_source end,",
      "order_suggestion = case when reopened then null when sp ? 'order_suggestion' then suggestion_new else order_suggestion end,",
      "plan_start_minute = case when reopened then null when sp ? 'plan_start_minute' then (sp ->> 'plan_start_minute')::integer else plan_start_minute end,",
      "replan = case when s.status = 'confirmed' and new_status <> 'confirmed' then null",
      "weather_kept = case when s.status = 'confirmed' and new_status <> 'confirmed' then null",
    ])
  })

  it('has the one op, its two hints and the status rule, and Rule 4 and Rule 5 are still there', () => {
    const sql = functionOf(read(RELEASE))
    expect(sql).toContain("when 'release_meeting' then")
    for (const hint of ['release_status', 'release_meeting', 'area_pinned', 'pin_without_confirm', 'status_transition']) expect(sql).toContain(`hint = '${hint}'`)
    expect(sql).toContain("or (released and s.status in ('voting', 'confirmed') and new_status = 'locating')) then")
    expect(sql).toContain("if not (s.status in ('voting', 'confirmed') and new_status = 'locating') then")
  })

  it('says it must be applied before the route runs, and what stays', () => {
    const migration = read(RELEASE)
    expect(migration).toContain('MUST BE APPLIED BEFORE THE BACKEND THAT HAS POST /api/sessions/:id/change-meeting-place')
    expect(migration).toContain('It keeps:')
  })
})
