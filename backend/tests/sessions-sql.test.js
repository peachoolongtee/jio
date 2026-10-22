import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

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

  it('keeps every rule of stage 3 and adds the slot rules', () => {
    const sql = functionOf(read(MIGRATION))
    for (const hint of ['area_pinned', 'pin_without_confirm', 'host_member', 'needs_two_people', 'status_transition', 'slots_status', 'slot_missing']) expect(sql).toContain(`hint = '${hint}'`)
    for (const op of ['opt_out', 'rejoin', 'remove_member', 'suggest', 'unsuggest', 'clear_approvals', 'clear_suggestions', 'clear_votes', 'swap_option']) expect(sql).toContain(`when '${op}' then`)
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
    expect(steps.length).toBeGreaterThan(76)
  })
})
