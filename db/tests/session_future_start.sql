-- Rollback test for db/migrations/20261024000000_jio_session_future_start.sql.
-- Run this whole file as the project owner. It temporarily installs the proposed migration,
-- checks authenticated writes, and rolls back both the DDL and throwaway data at the end.

begin;

-- Apply the migration inside this transaction so the live schema is unchanged after rollback.
create or replace function public.sessions_guard_future_start() returns trigger
language plpgsql set search_path = '' as $$
declare
  singapore_now timestamp without time zone := statement_timestamp() at time zone 'Asia/Singapore';
begin
  -- The rule is for people's own writes. The server and the project's owner are let through, as guard_session_changes lets
  -- them through, so the server's own writes and the database tests' fixtures (which make sessions on any day) still work.
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;
  if tg_op = 'UPDATE'
    and new.date is not distinct from old.date
    and new.start_time is not distinct from old.start_time then
    return new;
  end if;

  if new.date < singapore_now::date then
    raise exception 'That day has passed.' using errcode = '23514';
  end if;
  if new.date = singapore_now::date
    and new.start_time <= date_trunc('minute', singapore_now)::time then
    raise exception 'That start time has already passed today.' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists sessions_guard_future_start on public.sessions;
create trigger sessions_guard_future_start
  before insert or update of date, start_time on public.sessions
  for each row execute function public.sessions_guard_future_start();

create function pg_temp.new_user(u uuid) returns void language plpgsql as $$
begin
  insert into auth.users (id, aud, role, email, raw_user_meta_data)
  values (u, 'authenticated', 'authenticated', u || '@example.test',
          jsonb_build_object('username', 't' || substr(md5(u::text), 1, 12), 'dob', '2000-01-01'));
end;
$$;

create function pg_temp.try(stmt text, out code text, out msg text)
language plpgsql as $$
begin
  execute stmt;
  code := null;
  msg := null;
exception when others then
  code := sqlstate;
  msg := sqlerrm;
end;
$$;

create function pg_temp.expect_error(step int, stmt text, wanted text, msg_part text default null) returns void
language plpgsql as $$
declare got record;
begin
  select * into got from pg_temp.try(stmt);
  if got.code is distinct from wanted or (msg_part is not null and got.msg not ilike '%' || msg_part || '%') then
    raise exception 'FAIL step %: wanted error % mentioning %, got % %', step, wanted, msg_part,
      coalesce(got.code, 'success'), coalesce(got.msg, '');
  end if;
  raise notice 'ok step %', step;
end;
$$;

do $test$
declare
  host uuid := gen_random_uuid();
  good_session uuid := gen_random_uuid();
  old_session uuid := gen_random_uuid();
  sg_now timestamp without time zone := statement_timestamp() at time zone 'Asia/Singapore';
  past_start time := (date_trunc('minute', statement_timestamp() at time zone 'Asia/Singapore') - interval '1 minute')::time;
  past_date text := ((statement_timestamp() at time zone 'Asia/Singapore')::date - 1)::text;
  today text := (statement_timestamp() at time zone 'Asia/Singapore')::date::text;
  tomorrow text := ((statement_timestamp() at time zone 'Asia/Singapore')::date + 1)::text;
  at_user record;
begin
  perform pg_temp.new_user(host);
  -- Seed a pre-existing past row before testing authenticated writes.
  alter table public.sessions disable trigger sessions_guard_future_start;
  insert into public.sessions (id, host_id, title, date, start_time, end_time)
    values (old_session, host, 'Old', past_date::date, '12:00', '13:00');
  alter table public.sessions enable trigger sessions_guard_future_start;
  -- The session the update steps move is made by the owner: a signed-in person may not choose a session's id.
  insert into public.sessions (id, host_id, title, date, start_time, end_time)
    values (good_session, host, 'Future', tomorrow::date, '12:00', '13:00');
  perform set_config('request.jwt.claims', json_build_object('sub', host, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', host::text, true);
  set local role authenticated;

  select * into at_user from pg_temp.try(format(
    'insert into public.sessions (host_id, title, date, start_time, end_time) values (%L, %L, %L, %L, %L)',
    host, 'Future too', tomorrow, '12:00', '13:00'));
  if at_user.code is not null then raise exception 'FAIL step 1: future insert failed: %', at_user.msg; end if;
  raise notice 'ok step 1: future session insert';

  perform pg_temp.expect_error(2, format(
    'insert into public.sessions (host_id, title, date, start_time, end_time) values (%L, %L, %L, %L, %L)',
    host, 'Past day', past_date, '12:00', '13:00'), '23514', 'That day has passed');

  if date_trunc('minute', sg_now)::time > time '00:00' then
    perform pg_temp.expect_error(3, format(
      'insert into public.sessions (host_id, title, date, start_time, end_time) values (%L, %L, %L, %L, %L)',
      host, 'Past start', today, past_start, '23:59'), '23514', 'start time has already passed');
  else
    raise notice 'ok step 3: same-day past start case skipped at 00:00 Singapore time';
  end if;

  perform pg_temp.expect_error(4, format(
    'update public.sessions set date = %L where id = %L', past_date, good_session), '23514', 'That day has passed');

  if date_trunc('minute', sg_now)::time > time '00:00' then
    perform pg_temp.expect_error(5, format(
      'update public.sessions set date = %L, start_time = %L, end_time = %L where id = %L',
      today, past_start, '23:59', good_session), '23514', 'start time has already passed');
  else
    raise notice 'ok step 5: same-day past start update case skipped at 00:00 Singapore time';
  end if;

  -- A title-only update to an existing past session is permitted; temporal fields did not change.
  update public.sessions set title = 'Renamed old session' where id = old_session;
  raise notice 'ok step 6: title-only edit to a past session';

  -- Sending the same day and start again (as a form that saves every field does) is not a change, so it passes.
  update public.sessions set date = date, start_time = start_time, title = 'Old again' where id = old_session;
  raise notice 'ok step 7: the same day and start sent again on a past session';

  -- Only the day and start are checked: the end of a past session may still be edited by this rule.
  update public.sessions set end_time = '14:00' where id = old_session;
  raise notice 'ok step 8: an end-only edit to a past session';

  -- Later today is allowed, for a new session and for a move.
  if date_trunc('minute', sg_now)::time < time '23:58' then
    select * into at_user from pg_temp.try(format(
      'insert into public.sessions (host_id, title, date, start_time, end_time) values (%L, %L, %L, %L, %L)',
      host, 'Later today', today, (date_trunc('minute', sg_now) + interval '1 minute')::time, '23:59'));
    if at_user.code is not null then raise exception 'FAIL step 9: a start later today was refused: %', at_user.msg; end if;
    raise notice 'ok step 9: a start later today';
  else
    raise notice 'ok step 9: the later-today case skipped in the last minutes of the day';
  end if;

  -- The server and the owner are let through, so the server's own writes and the tests' fixtures are not refused.
  reset role;
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
  select * into at_user from pg_temp.try(format(
    'insert into public.sessions (host_id, title, date, start_time, end_time) values (%L, %L, %L, %L, %L)',
    host, 'Server past', past_date, '12:00', '13:00'));
  if at_user.code is not null then raise exception 'FAIL step 10: the server was refused: %', at_user.msg; end if;
  raise notice 'ok step 10: the server may write a past day';
  reset role;
  select * into at_user from pg_temp.try(format(
    'insert into public.sessions (host_id, title, date, start_time, end_time) values (%L, %L, %L, %L, %L)',
    host, 'Owner past', past_date, '12:00', '13:00'));
  if at_user.code is not null then raise exception 'FAIL step 11: the owner was refused: %', at_user.msg; end if;
  raise notice 'ok step 11: the owner may write a past day';

  -- The function's search path is fixed, so a caller's schema cannot change what it calls.
  if not exists (select 1 from pg_proc where oid = 'public.sessions_guard_future_start()'::regprocedure and proconfig @> array['search_path=""']) then
    raise exception 'FAIL step 12: the function has no fixed search path';
  end if;
  raise notice 'ok step 12: the search path is fixed';
  raise notice 'ALL STEPS PASSED';
end;
$test$;

rollback;
