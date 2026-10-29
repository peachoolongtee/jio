-- Rollback test for db/migrations/20261028000000_jio_no_clashing_meetups.sql.
-- Run this whole file as the project owner. It temporarily installs the migration (and a copy of the future-start rule of
-- 20261024000000, which it is ordered against), checks joining, rejoining and moving a meetup as signed-in people and as the server,
-- and rolls back both the DDL and the throwaway data at the end. Nothing is left on the project. Each step prints `ok step N`; a
-- broken rule stops the run with `FAIL step N`, and a run that passes ends with a result row that says so.
-- The migration below is a copy of the file (keep them identical).

begin;

-- The future-start rule (migration 20261024000000), so the order of the two triggers is the one the project has.
create or replace function public.sessions_guard_future_start() returns trigger
language plpgsql set search_path = '' as $$
declare
  singapore_now timestamp without time zone := statement_timestamp() at time zone 'Asia/Singapore';
begin
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

-- The migration, installed inside this transaction so the live schema is unchanged after the rollback.
-- The first meetup the person is in that overlaps the given time, leaving out the meetup `p_session` itself.
create or replace function public.meetup_clash(p_user uuid, p_session uuid, p_date date, p_start time, p_end time)
returns table (id uuid, title text, date date, start_time time, end_time time)
language sql stable security definer set search_path = ''
as $$
  select s.id, s.title, s.date, s.start_time, s.end_time
  from public.session_members m
  join public.sessions s on s.id = m.session_id
  where m.user_id = p_user
    and m.state = 'joined'
    and s.id <> p_session
    and s.status in ('inviting', 'locating', 'voting', 'confirmed')
    and s.date = p_date
    and s.start_time < p_end
    and p_start < s.end_time
  order by s.start_time
  limit 1
$$;
revoke all on function public.meetup_clash(uuid, uuid, date, time, time) from public, anon, authenticated;

-- Runs before a person becomes a joined member of a meetup (a new row, or a row that was not joined becoming joined). A signed-in
-- person's write is always checked; the server's only when it brings an opted-out member back (a rejoin).
create or replace function public.session_members_guard_clash() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  target record;
  hit record;
begin
  if new.state <> 'joined' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.state = 'joined' then
    return new;
  end if;
  if auth.uid() is null and not (tg_op = 'UPDATE' and coalesce(auth.role(), '') = 'service_role') then
    return new;
  end if;
  select s.date, s.start_time, s.end_time, s.status into target from public.sessions s where s.id = new.session_id;
  if not found or target.status not in ('inviting', 'locating', 'voting', 'confirmed') then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  select * into hit from public.meetup_clash(new.user_id, new.session_id, target.date, target.start_time, target.end_time);
  if found then
    raise exception 'You already have a meetup at that time.' using errcode = 'P0001', hint = 'schedule_clash',
      detail = json_build_object('id', hit.id, 'title', hit.title, 'date', hit.date, 'start', hit.start_time, 'end', hit.end_time)::text;
  end if;
  return new;
end;
$$;
drop trigger if exists session_members_guard_clash on public.session_members;
create trigger session_members_guard_clash
  before insert or update of state on public.session_members
  for each row execute function public.session_members_guard_clash();

-- Runs before a meetup's day or times change. Its name sorts after sessions_guard_future_start, so "That day has passed" (23514)
-- is raised before a clash when both apply (before-row triggers run in alphabetical order).
create or replace function public.sessions_hold_time_clash() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  hit record;
  who uuid;
begin
  if auth.uid() is null or new.status not in ('inviting', 'locating', 'voting', 'confirmed') then
    return new;
  end if;
  if new.date is not distinct from old.date
    and new.start_time is not distinct from old.start_time
    and new.end_time is not distinct from old.end_time then
    return new;
  end if;
  -- The mover and every joined member are locked in sorted order, so two moves that share a member cannot wait on each other.
  for who in
    select u from (
      select auth.uid() as u
      union
      select m.user_id from public.session_members m where m.session_id = new.id and m.state = 'joined'
    ) people
    order by u
  loop
    perform pg_advisory_xact_lock(hashtextextended(who::text, 0));
  end loop;
  select * into hit from public.meetup_clash(auth.uid(), new.id, new.date, new.start_time, new.end_time);
  if found then
    raise exception 'You already have a meetup at that time.' using errcode = 'P0001', hint = 'schedule_clash',
      detail = json_build_object('id', hit.id, 'title', hit.title, 'date', hit.date, 'start', hit.start_time, 'end', hit.end_time)::text;
  end if;
  if exists (
    select 1 from public.session_members m
    where m.session_id = new.id and m.state = 'joined' and m.user_id <> auth.uid()
      and exists (select 1 from public.meetup_clash(m.user_id, new.id, new.date, new.start_time, new.end_time))
  ) then
    raise exception 'Someone in this meetup already has plans at that time.' using errcode = 'P0001', hint = 'member_clash';
  end if;
  return new;
end;
$$;
drop trigger if exists sessions_guard_clash on public.sessions;
drop function if exists public.sessions_guard_clash();
drop trigger if exists sessions_hold_time_clash on public.sessions;
create trigger sessions_hold_time_clash
  before update of date, start_time, end_time on public.sessions
  for each row execute function public.sessions_hold_time_clash();

create function pg_temp.new_user(u uuid) returns void language plpgsql as $$
begin
  insert into auth.users (id, aud, role, email, raw_user_meta_data)
  values (u, 'authenticated', 'authenticated', u || '@example.test',
          jsonb_build_object('username', 't' || substr(md5(u::text), 1, 12), 'dob', '2000-01-01'));
end;
$$;

-- Acts as the project owner (no signed-in person, no claims), as a signed-in person, as a signed-in person's claims on the owner's
-- role (to reach a write the access rules would hide), or as the server.
--   select pg_temp.as_owner();  select pg_temp.as_user('<id>'::uuid);  select pg_temp.as_claims('<id>'::uuid);  select pg_temp.as_server();
create function pg_temp.as_owner() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;
create function pg_temp.as_claims(u uuid) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', u::text, true);
end;
$$;
create function pg_temp.as_user(u uuid) returns void language plpgsql as $$
begin
  perform pg_temp.as_claims(u);
  set local role authenticated;
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
--   select pg_temp.expect_error(5, 'update ...', '23514', 'That day has passed');
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

-- The statement must be refused by the clash rule: P0001 with this hint, and, when a title is given, that person's own meetup in the
-- detail; with no title the detail must be empty (a refusal that names nothing).
--   select pg_temp.expect_clash(2, 'insert ...', 'schedule_clash', 'S1', '<meetup id>'::uuid);
create function pg_temp.expect_clash(step int, stmt text, want_hint text, want_title text default null, want_id uuid default null) returns void
language plpgsql as $$
declare
  got_code text;
  got_hint text;
  got_detail text;
begin
  begin
    execute stmt;
  exception when others then
    got_code := sqlstate;
    get stacked diagnostics got_hint = pg_exception_hint, got_detail = pg_exception_detail;
  end;
  if got_code is null then
    raise exception 'FAIL step %: the write went through', step;
  end if;
  if got_code is distinct from 'P0001' or got_hint is distinct from want_hint then
    raise exception 'FAIL step %: wrong refusal % % %', step, got_code, got_hint, got_detail;
  end if;
  if want_title is null and nullif(got_detail, '') is not null then
    raise exception 'FAIL step %: the refusal named something: %', step, got_detail;
  end if;
  if want_title is not null and (got_detail::json ->> 'title') is distinct from want_title then
    raise exception 'FAIL step %: the refusal names %, not %', step, got_detail, want_title;
  end if;
  if want_id is not null and (got_detail::json ->> 'id') is distinct from want_id::text then
    raise exception 'FAIL step %: the refusal names meetup %, not %', step, got_detail::json ->> 'id', want_id;
  end if;
  raise notice 'ok step %', step;
end;
$$;

do $test$
declare
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  c uuid := gen_random_uuid();
  e uuid := gen_random_uuid();
  f uuid := gen_random_uuid();
  g uuid := gen_random_uuid();
  s1 uuid; s3 uuid; s4 uuid; s5 uuid; s6 uuid; s8 uuid; sx uuid; sp uuid; sr1 uuid; sr2 uuid; sold uuid;
  sg_today date := (statement_timestamp() at time zone 'Asia/Singapore')::date;
  tomorrow text := (sg_today + 1)::text;
  later text := (sg_today + 2)::text;
  far_day text := (sg_today + 10)::text;
  farther text := (sg_today + 11)::text;
  past_day text := (sg_today - 1)::text;
  st text;
  hint_text text;
  detail_text text;
  made boolean;
  ver bigint;
  n int;
begin
  perform pg_temp.new_user(a);
  perform pg_temp.new_user(b);
  perform pg_temp.new_user(c);
  perform pg_temp.new_user(e);
  perform pg_temp.new_user(f);
  perform pg_temp.new_user(g);

  perform pg_temp.as_user(a);

  -- 1. A first meetup is fine.
  insert into public.sessions (host_id, title, date, start_time, end_time) values (a, 'S1', tomorrow::date, '19:00', '21:00') returning id into s1;
  raise notice 'ok step 1: a first meetup';

  -- 2. A second one that overlaps is refused, naming the first, and leaves no session behind.
  perform pg_temp.expect_clash(2,
    format('insert into public.sessions (host_id, title, date, start_time, end_time) values (%L, ''S2'', %L, ''20:00'', ''22:00'')', a, tomorrow),
    'schedule_clash', 'S1', s1);
  select count(*) into n from public.sessions where title = 'S2';
  if n <> 0 then raise exception 'FAIL step 2: the refused meetup left a session behind'; end if;

  -- 3 and 4. Back to back, after and before, is fine.
  insert into public.sessions (host_id, title, date, start_time, end_time) values (a, 'S3', tomorrow::date, '21:00', '23:00') returning id into s3;
  raise notice 'ok step 3: back to back after';
  insert into public.sessions (host_id, title, date, start_time, end_time) values (a, 'S4', tomorrow::date, '17:00', '19:00') returning id into s4;
  raise notice 'ok step 4: back to back before';

  -- 5. Another day is fine, and moving it onto the taken time is refused.
  insert into public.sessions (host_id, title, date, start_time, end_time) values (a, 'S5', later::date, '19:00', '21:00') returning id into s5;
  perform pg_temp.expect_clash(5, format('update public.sessions set date = %L where id = %L', tomorrow, s5), 'schedule_clash', 'S1', s1);

  -- 6. Moving it inside its own day is fine, and a title-only edit is never held against it.
  update public.sessions set start_time = '18:00', end_time = '19:30' where id = s5;
  update public.sessions set title = 'S5 renamed' where id = s5;
  raise notice 'ok step 6: moving inside its own day, and a rename';

  -- 7. A cancelled meetup holds nothing.
  update public.sessions set status = 'cancelled' where id = s1;
  insert into public.sessions (host_id, title, date, start_time, end_time) values (a, 'S6', tomorrow::date, '19:00', '21:00') returning id into s6;
  raise notice 'ok step 7: a cancelled meetup frees its time';

  -- The link the next steps join with is made by the owner.
  perform pg_temp.as_owner();
  insert into public.invites (token, session_id, created_by) values ('clash-test-link-0000000000000000000000000', s6, a);

  -- 8. Someone with their own meetup at that time cannot join through a link.
  perform pg_temp.as_user(b);
  insert into public.sessions (host_id, title, date, start_time, end_time) values (b, 'B busy', tomorrow::date, '20:00', '22:00');
  perform pg_temp.expect_clash(8, 'select public.join_session(''clash-test-link-0000000000000000000000000'')', 'schedule_clash', 'B busy');

  -- 9. Someone free can join.
  perform pg_temp.as_user(c);
  perform public.join_session('clash-test-link-0000000000000000000000000');
  raise notice 'ok step 9: a free person joins';

  -- 10. A host moving the meetup onto a time another member has is refused without saying whose or what.
  insert into public.sessions (host_id, title, date, start_time, end_time) values (c, 'C busy', later::date, '10:00', '12:00') returning id into s8;
  perform pg_temp.as_user(a);
  perform pg_temp.expect_clash(10,
    format('update public.sessions set date = %L, start_time = ''10:30'', end_time = ''11:30'' where id = %L', later, s6), 'member_clash');

  -- 11. The owner (no signed-in person) is let through.
  perform pg_temp.as_owner();
  insert into public.sessions (host_id, title, date, start_time, end_time) values (a, 'Fixture', tomorrow::date, '20:00', '22:00');
  raise notice 'ok step 11: the owner may write an overlapping meetup';

  -- 12. The functions have a fixed search path.
  if (select count(*) from pg_proc where oid in (
        'public.meetup_clash(uuid,uuid,date,time,time)'::regprocedure,
        'public.session_members_guard_clash()'::regprocedure,
        'public.sessions_hold_time_clash()'::regprocedure)
      and proconfig @> array['search_path=""']) <> 3 then
    raise exception 'FAIL step 12: a function has no fixed search path';
  end if;
  raise notice 'ok step 12: the search path is fixed';

  -- 13. The meeting time rule runs after the future-start rule (before-row triggers run in the order of their names), and the old
  -- name is gone.
  if not ('sessions_hold_time_clash' collate "C" > 'sessions_guard_future_start' collate "C") then
    raise exception 'FAIL step 13: the clash trigger would run before the future-start trigger';
  end if;
  if exists (select 1 from pg_trigger where tgrelid = 'public.sessions'::regclass and tgname = 'sessions_guard_clash')
     or exists (select 1 from pg_proc where oid = to_regprocedure('public.sessions_guard_clash()')) then
    raise exception 'FAIL step 13: the old trigger or function is still there';
  end if;
  raise notice 'ok step 13: the order of the triggers, and the old name is gone';

  -- 14. A signed-in person, a visitor and everyone else cannot call the lookup of someone's meetups.
  if has_function_privilege('authenticated', 'public.meetup_clash(uuid,uuid,date,time,time)', 'execute')
     or has_function_privilege('anon', 'public.meetup_clash(uuid,uuid,date,time,time)', 'execute') then
    raise exception 'FAIL step 14: a browser role may call meetup_clash';
  end if;
  raise notice 'ok step 14: meetup_clash is not callable by a browser role';

  -- 15. Inviting, locating, voting and confirmed hold a person's time; completed and cancelled do not.
  perform pg_temp.as_owner();
  insert into public.sessions (host_id, title, date, start_time, end_time) values (e, 'E held', far_day::date, '08:00', '09:00') returning id into sx;
  foreach st in array array['inviting', 'locating', 'voting', 'confirmed', 'completed', 'cancelled'] loop
    perform pg_temp.as_owner();
    update public.sessions set status = st where id = sx;
    perform pg_temp.as_user(e);
    made := false;
    begin
      insert into public.sessions (host_id, title, date, start_time, end_time) values (e, 'E probe', far_day::date, '08:30', '09:30') returning id into sp;
      made := true;
    exception when sqlstate 'P0001' then
      get stacked diagnostics hint_text = pg_exception_hint;
      if hint_text is distinct from 'schedule_clash' then raise exception 'FAIL step 15: wrong hint % while %', hint_text, st; end if;
    end;
    if made <> (st in ('completed', 'cancelled')) then
      raise exception 'FAIL step 15: a % meetup % the time', st, case when made then 'did not hold' else 'held' end;
    end if;
    if made then
      perform pg_temp.as_owner();
      delete from public.sessions where id = sp;
    end if;
  end loop;
  raise notice 'ok step 15: four statuses hold the time, completed and cancelled do not';

  -- 16. A member who opted out holds no time, for the host moving the meetup and for the member's own meetup.
  perform pg_temp.as_owner();
  insert into public.sessions (host_id, title, date, start_time, end_time, status) values (g, 'G hosts', farther::date, '11:00', '13:00', 'inviting') returning id into sr2;
  insert into public.sessions (host_id, title, date, start_time, end_time, status) values (f, 'F hosts', farther::date, '08:00', '10:00', 'inviting') returning id into sr1;
  insert into public.session_members (session_id, user_id, role, state) values (sr1, g, 'guest', 'opted_out');
  perform pg_temp.as_user(f);
  update public.sessions set start_time = '10:30', end_time = '12:30' where id = sr1;
  perform pg_temp.as_user(g);
  update public.sessions set start_time = '10:45', end_time = '13:00' where id = sr2;
  raise notice 'ok step 16: an opted-out member holds no time';

  -- 17. Rejoining through the server (apply_session_plan with the service key) is refused when the person is in another meetup then,
  -- and the person stays opted out.
  perform pg_temp.as_owner();
  select plan_version into ver from public.sessions where id = sr1;
  perform pg_temp.as_server();
  perform pg_temp.expect_clash(17,
    format('select public.apply_session_plan(%L, %s, ''inviting'', %L::jsonb)', sr1, ver,
           jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'rejoin', 'user_id', g)))::text),
    'schedule_clash', 'G hosts', sr2);
  perform pg_temp.as_owner();
  if (select state from public.session_members where session_id = sr1 and user_id = g) <> 'opted_out' then
    raise exception 'FAIL step 17: the refused rejoin changed the member';
  end if;

  -- 18. With the clash gone the same rejoin goes through.
  update public.sessions set status = 'cancelled' where id = sr2;
  perform pg_temp.as_server();
  perform public.apply_session_plan(sr1, ver, 'inviting', jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'rejoin', 'user_id', g))));
  perform pg_temp.as_owner();
  if (select state from public.session_members where session_id = sr1 and user_id = g) <> 'joined' then
    raise exception 'FAIL step 18: the rejoin did not bring the member back';
  end if;
  raise notice 'ok step 18: a rejoin with no clash goes through';

  -- 19. A signed-in person's own opted_out to joined is checked too.
  update public.session_members set state = 'opted_out' where session_id = sr1 and user_id = g;
  update public.sessions set status = 'inviting' where id = sr2;
  perform pg_temp.as_claims(g);
  perform pg_temp.expect_clash(19,
    format('update public.session_members set state = ''joined'' where session_id = %L and user_id = %L', sr1, g), 'schedule_clash', 'G hosts', sr2);

  -- 20. The server's other writes, and the owner's, are not held against anyone: it makes a meetup, and a member of it, on top of
  -- meetups the people are already in.
  perform pg_temp.as_server();
  insert into public.sessions (host_id, title, date, start_time, end_time) values (f, 'Server fixture', farther::date, '09:00', '11:00') returning id into sx;
  insert into public.session_members (session_id, user_id, role, state) values (sx, g, 'guest', 'joined');
  update public.session_members set start_area_id = 'bishan' where session_id = sx and user_id = g;
  perform pg_temp.as_owner();
  select count(*) into n from public.session_members where session_id = sx and state = 'joined';
  if n <> 2 then raise exception 'FAIL step 20: the server''s fixture has % joined members, not 2', n; end if;
  raise notice 'ok step 20: the server may write overlapping rows other than a rejoin';

  -- 21. A move onto a day that has passed is "That day has passed" (23514) even when it also clashes.
  insert into public.sessions (host_id, title, date, start_time, end_time) values (a, 'Old', past_day::date, '12:00', '13:00') returning id into sold;
  perform pg_temp.as_user(a);
  perform pg_temp.expect_error(21, format('update public.sessions set date = %L, start_time = ''12:30'', end_time = ''13:30'' where id = %L', past_day, s5),
    '23514', 'That day has passed');

  raise notice 'ALL STEPS PASSED';
end;
$test$;

rollback;

-- Readable result: this row appears only when every step above passed (a failed step stops the run with FAIL step N).
select 'all 21 steps passed; nothing was left on the project' as result;
