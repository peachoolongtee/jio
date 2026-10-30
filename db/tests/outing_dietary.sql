-- Rollback test for db/migrations/20261030000000_jio_outing_dietary.sql.
-- Run this whole file as the project owner. It temporarily installs the migration (a copy, kept identical to the file; installing it
-- again on a project that has it changes nothing), checks the two tables and the function as the server, as a signed-in member, as
-- the host and as someone logged out, and rolls back both the DDL and the throwaway data at the end. Nothing is left on the project.
-- Each step prints `ok step N`; a broken rule stops the run with `FAIL step N`, and a run that passes ends with a result row.
-- Steps 1 to 6 are the server's reads and writes and what session_member_needs() answers; 7 to 20 are what a browser is refused;
-- 21 to 26 the shape rules; 27 to 32 the lifecycle, the privileges and the function's settings.

begin;

-- The migration, installed inside this transaction so the live schema is unchanged after the rollback.
-- Dietary needs for one outing. A joined member's needs start as the ones on their profile (profile_private.dietary) and may be changed
-- for one outing alone; the host may also drop a need of someone else's for the outing. Nothing here is a column of sessions or
-- session_members, and nothing is readable or writable by a browser: the server writes both tables with the service key and reads the needs
-- through session_member_needs(), as it already does for the profile's needs.
--
--   session_member_dietary  one row per member who changed their needs or confirmed them for this outing: the needs they have for it
--                           and when they confirmed them (null until they do). A row goes with the member's row (on delete cascade), so a
--                           member who leaves or is removed takes theirs; an opted-out member keeps theirs for when they rejoin (the
--                           function below counts joined members only).
--   session_dietary_dropped one row per need the host dropped for the outing: the outing stops filtering for it. The need is never tied
--                           to a person, here or in anything a member reads.
--
-- session_member_needs(sid) now answers each joined member's needs for the outing: their row in session_member_dietary if they have one,
-- else their profile's. Same name, arguments and columns, so nothing that calls it changes. The host's dropped needs are NOT taken off in
-- the function: the server reads them from the second table and takes them off the group's needs when it ranks places, so that the host
-- can still be told which needs are dropped and take a drop back.
-- apply_session_plan, guard_session_changes, sessions_guard_future_start, join_session, the clash functions and the account tables are not
-- changed. Idempotent; the fresh-build equivalent is in db/schema.sql and db/policies.sql. Test: db/tests/outing_dietary.sql.

create table if not exists public.session_member_dietary (
  session_id uuid not null,
  user_id uuid not null,
  -- The needs this member has for this outing: a flat list of at most 3, no repeats (the shape of profile_private.dietary).
  dietary text[] not null default '{}'
    constraint outing_dietary_values check (dietary <@ array['halal', 'vegetarian', 'vegan']::text[])
    constraint outing_dietary_shape check (
      coalesce(array_ndims(dietary), 1) = 1
      and cardinality(dietary) <= 3
      and public.array_is_unique(dietary)
    ),
  -- When the member confirmed their needs for this outing; null until they do.
  confirmed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (session_id, user_id),
  foreign key (session_id, user_id) references public.session_members (session_id, user_id) on delete cascade
);

create table if not exists public.session_dietary_dropped (
  session_id uuid not null references public.sessions (id) on delete cascade,
  need text not null check (need in ('halal', 'vegetarian', 'vegan')),
  dropped_at timestamptz not null default now(),
  primary key (session_id, need)
);

create or replace trigger session_member_dietary_set_updated_at before update on public.session_member_dietary
  for each row execute function public.set_updated_at();

-- Server only: row-level security on, no policy, and no privilege for a browser, so only the service key reads or writes them.
alter table public.session_member_dietary enable row level security;
alter table public.session_dietary_dropped enable row level security;
revoke all on public.session_member_dietary, public.session_dietary_dropped from anon, authenticated;
grant all on public.session_member_dietary, public.session_dietary_dropped to service_role;

-- Each joined member's private planner needs, for the server only (the service key): the dietary needs are the member's for this outing.
--   const { data } = await serviceClient.rpc('session_member_needs', { sid: sessionId })
create or replace function public.session_member_needs(sid uuid)
returns table (user_id uuid, home_area_id text, dietary text[], budget_max_per_person numeric, needs_step_free boolean)
language sql stable security definer set search_path = ''
as $$
  select m.user_id, pp.home_area_id, coalesce(d.dietary, pp.dietary), pp.budget_max_per_person, pp.needs_step_free
  from public.session_members m
  join public.profile_private pp on pp.id = m.user_id
  left join public.session_member_dietary d on d.session_id = m.session_id and d.user_id = m.user_id
  where m.session_id = sid and m.state = 'joined';
$$;
revoke execute on function public.session_member_needs(uuid) from public, anon, authenticated;
grant execute on function public.session_member_needs(uuid) to service_role;

-- Acts as the project owner (no signed-in person, no claims), as a signed-in person, as someone logged out, or as the server.
--   select pg_temp.as_owner();  select pg_temp.as_user('<id>'::uuid);  select pg_temp.as_anon();  select pg_temp.as_server();
create function pg_temp.as_owner() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;
create function pg_temp.as_user(u uuid) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
end;
$$;
create function pg_temp.as_anon() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
end;
$$;
create function pg_temp.as_server() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('request.jwt.claim.sub', '', true);
  set local role service_role;
end;
$$;

-- The statement must fail with this error code (and, when given, a message containing this text).
--   select pg_temp.expect_error(5, 'select ...', '42501');
create function pg_temp.expect_error(step int, stmt text, wanted text, msg_part text default null) returns void
language plpgsql as $$
declare
  got_code text;
  got_msg text;
begin
  begin
    execute stmt;
  exception when others then
    got_code := sqlstate;
    got_msg := sqlerrm;
  end;
  if got_code is distinct from wanted or (msg_part is not null and got_msg not ilike '%' || msg_part || '%') then
    raise exception 'FAIL step %: wanted error % mentioning %, got % %', step, wanted, msg_part,
      coalesce(got_code, 'success'), coalesce(got_msg, '');
  end if;
  raise notice 'ok step %', step;
end;
$$;

create function pg_temp.new_user(u uuid) returns void language plpgsql as $$
begin
  insert into auth.users (id, aud, role, email, raw_user_meta_data)
  values (u, 'authenticated', 'authenticated', u || '@example.test',
          jsonb_build_object('username', 't' || substr(md5(u::text), 1, 12), 'dob', '2000-01-01'));
end;
$$;

-- The outing's needs the function answers for one person, as text ('' when the person is not in the answer).
--   select pg_temp.needs_of('<session id>', '<user id>');   -- 'halal,vegan'
create function pg_temp.needs_of(sid uuid, u uuid) returns text language sql as $$
  select coalesce((select array_to_string(n.dietary, ',') from public.session_member_needs(sid) n where n.user_id = u), '<absent>');
$$;

do $test$
declare
  h uuid := gen_random_uuid();
  m1 uuid := gen_random_uuid();
  m2 uuid := gen_random_uuid();
  x uuid := gen_random_uuid();
  s uuid;
  s2 uuid;
  tomorrow date := ((statement_timestamp() at time zone 'Asia/Singapore')::date + 1);
  n int;
  got text;
  rec record;
begin
  perform pg_temp.new_user(h);
  perform pg_temp.new_user(m1);
  perform pg_temp.new_user(m2);
  perform pg_temp.new_user(x);
  update public.profile_private set dietary = '{halal}' where id = h;
  update public.profile_private set dietary = '{}', home_area_id = 'bishan', budget_max_per_person = 20, needs_step_free = true where id = m1;
  update public.profile_private set dietary = '{vegan}' where id = m2;

  -- The host makes the outing as themselves (the host's own row is added by the database); the others join as the owner would set them up.
  perform pg_temp.as_user(h);
  insert into public.sessions (host_id, title, date, start_time, end_time) values (h, 'Dietary', tomorrow, '19:00', '21:00') returning id into s;
  perform pg_temp.as_owner();
  insert into public.session_members (session_id, user_id, role, state) values (s, m1, 'guest', 'joined'), (s, m2, 'guest', 'joined');

  -- 1. With no outing rows, each joined member's needs are their profile's, and the other columns are theirs too.
  perform pg_temp.as_server();
  if pg_temp.needs_of(s, h) <> 'halal' or pg_temp.needs_of(s, m1) <> '' or pg_temp.needs_of(s, m2) <> 'vegan' then
    raise exception 'FAIL step 1: the profile needs were % / % / %', pg_temp.needs_of(s, h), pg_temp.needs_of(s, m1), pg_temp.needs_of(s, m2);
  end if;
  select * into rec from public.session_member_needs(s) where user_id = m1;
  if rec.home_area_id is distinct from 'bishan' or rec.budget_max_per_person is distinct from 20 or rec.needs_step_free is distinct from true then
    raise exception 'FAIL step 1: the other columns changed: %', rec;
  end if;
  raise notice 'ok step 1: the profile needs, and the other columns as before';

  -- 2. The server writes a member's needs for this outing; the function answers them over the profile, and others are untouched.
  insert into public.session_member_dietary (session_id, user_id, dietary) values (s, m1, '{vegetarian}');
  if pg_temp.needs_of(s, m1) <> 'vegetarian' or pg_temp.needs_of(s, m2) <> 'vegan' or pg_temp.needs_of(s, h) <> 'halal' then
    raise exception 'FAIL step 2: % / % / %', pg_temp.needs_of(s, h), pg_temp.needs_of(s, m1), pg_temp.needs_of(s, m2);
  end if;
  select confirmed_at into rec from public.session_member_dietary where session_id = s and user_id = m1;
  if rec.confirmed_at is not null then raise exception 'FAIL step 2: a row nobody confirmed has a confirmed time'; end if;
  raise notice 'ok step 2: the outing needs win over the profile; nothing is confirmed until it is';

  -- 3. An empty list for the outing overrides a profile that has a need (removing a need for one outing).
  insert into public.session_member_dietary (session_id, user_id, dietary, confirmed_at) values (s, m2, '{}', now());
  if pg_temp.needs_of(s, m2) <> '' then raise exception 'FAIL step 3: the empty override was not used: %', pg_temp.needs_of(s, m2); end if;
  raise notice 'ok step 3: an empty override wins over the profile';

  -- 4. The profile is not changed by any of it.
  select dietary::text into got from public.profile_private where id = m2;
  if got <> '{vegan}' then raise exception 'FAIL step 4: the profile of m2 is now %', got; end if;
  raise notice 'ok step 4: the profile is untouched';

  -- 5. An opted-out member is not in the answer, and their row is kept for when they rejoin.
  perform pg_temp.as_owner();
  update public.session_members set state = 'opted_out' where session_id = s and user_id = m1;
  perform pg_temp.as_server();
  if pg_temp.needs_of(s, m1) <> '<absent>' then raise exception 'FAIL step 5: an opted-out member is in the answer'; end if;
  perform pg_temp.as_owner();
  update public.session_members set state = 'joined' where session_id = s and user_id = m1;
  perform pg_temp.as_server();
  if pg_temp.needs_of(s, m1) <> 'vegetarian' then raise exception 'FAIL step 5: the override was lost on rejoin: %', pg_temp.needs_of(s, m1); end if;
  raise notice 'ok step 5: opting out hides the row and rejoining brings it back';

  -- 6. The server can write, change and read the host's dropped needs.
  insert into public.session_dietary_dropped (session_id, need) values (s, 'halal');
  update public.session_member_dietary set confirmed_at = now() where session_id = s and user_id = m1;
  select count(*) into n from public.session_dietary_dropped where session_id = s and need = 'halal';
  if n <> 1 then raise exception 'FAIL step 6: the dropped need is not there'; end if;
  raise notice 'ok step 6: the server writes and reads both tables';

  -- 7 to 10. Logged out: no read and no write of either table.
  perform pg_temp.as_anon();
  perform pg_temp.expect_error(7, 'select * from public.session_member_dietary', '42501');
  perform pg_temp.expect_error(8, format('insert into public.session_member_dietary (session_id, user_id, dietary) values (%L, %L, ''{}'')', s, x), '42501');
  perform pg_temp.expect_error(9, 'select * from public.session_dietary_dropped', '42501');
  perform pg_temp.expect_error(10, format('insert into public.session_dietary_dropped (session_id, need) values (%L, ''vegan'')', s), '42501');

  -- 11 to 15. A signed-in member, even on their own row: no read, no write.
  perform pg_temp.as_user(m1);
  perform pg_temp.expect_error(11, 'select * from public.session_member_dietary', '42501');
  perform pg_temp.expect_error(12, format('insert into public.session_member_dietary (session_id, user_id, dietary) values (%L, %L, ''{}'')', s, m1), '42501');
  perform pg_temp.expect_error(13, format('update public.session_member_dietary set dietary = ''{}'' where session_id = %L and user_id = %L', s, m1), '42501');
  perform pg_temp.expect_error(14, format('delete from public.session_member_dietary where session_id = %L and user_id = %L', s, m1), '42501');
  perform pg_temp.expect_error(15, 'select * from public.session_dietary_dropped', '42501');

  -- 16 to 18. The host too: the host's dropped needs are written by the server, not by the host's own client.
  perform pg_temp.as_user(h);
  perform pg_temp.expect_error(16, format('insert into public.session_dietary_dropped (session_id, need) values (%L, ''vegan'')', s), '42501');
  perform pg_temp.expect_error(17, format('delete from public.session_dietary_dropped where session_id = %L', s), '42501');
  perform pg_temp.expect_error(18, 'select * from public.session_member_dietary', '42501');

  -- 19. Nobody but the server can call the function, and nothing was lost by the failed writes.
  perform pg_temp.as_user(m1);
  perform pg_temp.expect_error(19, format('select * from public.session_member_needs(%L)', s), '42501');
  perform pg_temp.as_anon();
  perform pg_temp.expect_error(20, format('select * from public.session_member_needs(%L)', s), '42501');
  perform pg_temp.as_owner();
  select count(*) into n from public.session_member_dietary where session_id = s;
  if n <> 2 then raise exception 'FAIL step 20: the failed writes changed the table (% rows)', n; end if;

  -- 21 to 25. The shapes of the data are enforced for the server as well.
  perform pg_temp.as_server();
  perform pg_temp.expect_error(21, format('insert into public.session_member_dietary (session_id, user_id, dietary) values (%L, %L, ''{kosher}'')', s, h), '23514');
  perform pg_temp.expect_error(22, format('insert into public.session_member_dietary (session_id, user_id, dietary) values (%L, %L, ''{halal,halal}'')', s, h), '23514');
  perform pg_temp.expect_error(23, format('insert into public.session_member_dietary (session_id, user_id, dietary) values (%L, %L, ''{{halal},{vegan}}'')', s, h), '23514');
  perform pg_temp.expect_error(24, format('insert into public.session_dietary_dropped (session_id, need) values (%L, ''pescatarian'')', s), '23514');
  perform pg_temp.expect_error(25, format('insert into public.session_dietary_dropped (session_id, need) values (%L, ''halal'')', s), '23505');

  -- 26. A row is only for a member of the outing.
  perform pg_temp.expect_error(26, format('insert into public.session_member_dietary (session_id, user_id, dietary) values (%L, %L, ''{}'')', s, x), '23503');

  -- 27. A member who leaves (the server deletes their row) takes their needs for the outing with them.
  perform pg_temp.as_owner();
  delete from public.session_members where session_id = s and user_id = m1;
  select count(*) into n from public.session_member_dietary where session_id = s and user_id = m1;
  if n <> 0 then raise exception 'FAIL step 27: a member who left kept their outing needs'; end if;
  select count(*) into n from public.session_member_dietary where session_id = s and user_id = m2;
  if n <> 1 then raise exception 'FAIL step 27: another member''s row went with them'; end if;
  raise notice 'ok step 27: leaving takes the member''s row; the others stay';

  -- 28. Another outing's rows are separate: the same person has their own needs there.
  perform pg_temp.as_user(h);
  insert into public.sessions (host_id, title, date, start_time, end_time) values (h, 'Other', tomorrow + 3, '19:00', '21:00') returning id into s2;
  perform pg_temp.as_server();
  insert into public.session_member_dietary (session_id, user_id, dietary) values (s2, h, '{vegan}');
  if pg_temp.needs_of(s2, h) <> 'vegan' or pg_temp.needs_of(s, h) <> 'halal' then
    raise exception 'FAIL step 28: % / %', pg_temp.needs_of(s2, h), pg_temp.needs_of(s, h);
  end if;
  raise notice 'ok step 28: the needs of one outing are not those of another';

  -- 29. Both tables have row-level security on and no policy at all.
  perform pg_temp.as_owner();
  select count(*) into n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relname in ('session_member_dietary', 'session_dietary_dropped') and c.relrowsecurity;
  if n <> 2 then raise exception 'FAIL step 29: row-level security is on for % of 2 tables', n; end if;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename in ('session_member_dietary', 'session_dietary_dropped');
  if n <> 0 then raise exception 'FAIL step 29: % policies exist', n; end if;
  raise notice 'ok step 29: row-level security on, no policy';

  -- 30. No privilege on either table for a browser role, and the server has all of them.
  if has_table_privilege('anon', 'public.session_member_dietary', 'select')
    or has_table_privilege('authenticated', 'public.session_member_dietary', 'select')
    or has_table_privilege('authenticated', 'public.session_member_dietary', 'insert')
    or has_table_privilege('authenticated', 'public.session_member_dietary', 'update')
    or has_table_privilege('authenticated', 'public.session_dietary_dropped', 'select')
    or has_table_privilege('authenticated', 'public.session_dietary_dropped', 'insert')
    or has_table_privilege('anon', 'public.session_dietary_dropped', 'select')
    or not has_table_privilege('service_role', 'public.session_member_dietary', 'insert')
    or not has_table_privilege('service_role', 'public.session_dietary_dropped', 'delete') then
    raise exception 'FAIL step 30: the table privileges are wrong';
  end if;
  raise notice 'ok step 30: no privilege for anon or authenticated; all for the server';

  -- 31. The function keeps its shape: security definer, a fixed search path, executable by the server only.
  select * into rec from pg_proc where oid = 'public.session_member_needs(uuid)'::regprocedure;
  if not rec.prosecdef or rec.proconfig is null or not ('search_path=""' = any (rec.proconfig)) then
    raise exception 'FAIL step 31: the function is not security definer with a fixed search path (%)', rec.proconfig;
  end if;
  if has_function_privilege('anon', 'public.session_member_needs(uuid)', 'execute')
    or has_function_privilege('authenticated', 'public.session_member_needs(uuid)', 'execute')
    or not has_function_privilege('service_role', 'public.session_member_needs(uuid)', 'execute') then
    raise exception 'FAIL step 31: the function can be called by the wrong roles';
  end if;
  raise notice 'ok step 31: security definer, fixed search path, the server only';

  -- 32. Deleting the outing takes both tables' rows with it.
  perform pg_temp.as_server();
  insert into public.session_dietary_dropped (session_id, need) values (s2, 'vegan');
  perform pg_temp.as_owner();
  delete from public.sessions where id in (s, s2);
  select (select count(*) from public.session_member_dietary) + (select count(*) from public.session_dietary_dropped) into n;
  if n <> 0 then raise exception 'FAIL step 32: % rows were left after the outings went', n; end if;
  raise notice 'ok step 32: deleting an outing deletes its rows';

  raise notice 'ALL STEPS PASSED';
end;
$test$;

rollback;

-- Readable result: this row appears only when every step above passed (a failed step stops the run with FAIL step N).
select 'all 32 steps passed; nothing was left on the project' as result;
