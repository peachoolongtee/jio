-- Rollback test for db/migrations/20261024000000_jio_session_future_start.sql.
-- Run this whole file as the project owner. It temporarily installs the proposed migration,
-- checks authenticated writes, and rolls back both the DDL and throwaway data at the end.

begin;

-- Apply the migration inside this transaction so the live schema is unchanged after rollback.
create or replace function public.sessions_guard_future_start() returns trigger
language plpgsql as $$
declare
  singapore_now timestamp without time zone := statement_timestamp() at time zone 'Asia/Singapore';
begin
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
  perform set_config('request.jwt.claims', json_build_object('sub', host, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', host::text, true);
  set local role authenticated;

  select * into at_user from pg_temp.try(format(
    'insert into public.sessions (id, host_id, title, date, start_time, end_time) values (%L, %L, %L, %L, %L, %L)',
    good_session, host, 'Future', tomorrow, '12:00', '13:00'));
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
end;
$test$;

rollback;
