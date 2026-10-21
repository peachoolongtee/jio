-- Test for the server's plan-writing function: apply_session_plan(), in db/migrations/20261020000000_jio_apply_session_plan.sql (or a
-- fresh build of db/schema.sql and db/policies.sql). It needs slice b applied (the meeting-spot tables and sessions.plan_version).
--
-- Run on the live project on 20 October 2026 by the lead's agent, with the function created inside the same transaction and
-- everything rolled back: all 76 steps passed, and no function, user or session was left behind.
--
-- How to run: after the migration (or a fresh build), run this whole file as ONE batch, in the SQL editor
-- or with   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/apply_session_plan.sql
-- It runs as the project's owner role ("postgres"), makes throwaway users and sessions, acts as each of them (set role + the
-- JWT claims, the way Supabase does for a request) and as the server (service_role), and ends with a rollback, so no rows are
-- left whether it passes or fails. A passing step prints a notice "ok step N". A broken rule raises an exception "FAIL step N: ..."
-- and stops the run (with the rollback that follows).
--
-- Expected error codes: 42501 = permission denied, 23514 = check constraint, 23505 = unique, 22023 = bad parameter value,
-- P0001 = a rule of the function (with a hint: area_pinned, pin_without_confirm, host_member, needs_two_people, status_transition).

begin;

-- Helpers. They live in pg_temp, so they vanish with the session and the rollback.

-- Run one statement as the current role. Returns the error code and message (null on success) and the rows touched.
--   select * from pg_temp.try('delete from public.votes');
create function pg_temp.try(stmt text, out code text, out msg text, out n bigint)
language plpgsql as $$
begin
  execute stmt;
  get diagnostics n = row_count;
  code := null;
  msg := null;
exception when others then
  code := sqlstate;
  msg := sqlerrm;
  n := null;
end;
$$;

-- Act as the project owner, as a signed-in user, as a logged-out visitor, or as the server.
--   select pg_temp.as_user('<user id>'::uuid);
create function pg_temp.as_admin() returns void language plpgsql as $$
begin
  reset role;
end;
$$;
create function pg_temp.as_user(uid uuid) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', uid::text, true);
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
--   select pg_temp.expect_error(7, 'a member cannot insert a spot', 'insert into ...', '42501');
create function pg_temp.expect_error(step int, what text, stmt text, want text, want_msg text default null) returns void language plpgsql as $$
declare r record;
begin
  select * into r from pg_temp.try(stmt);
  if r.code is distinct from want then
    raise exception 'FAIL step %: % (wanted error %, got %)', step, what, want, coalesce(r.code, 'success') || coalesce(' "' || r.msg || '"', '');
  end if;
  if want_msg is not null and r.msg not ilike '%' || want_msg || '%' then
    raise exception 'FAIL step %: % (error %, but the message "%" does not mention "%")', step, what, r.code, r.msg, want_msg;
  end if;
  raise notice 'ok step %: %', step, what;
end;
$$;

-- The statement must succeed, touching this many rows when want_rows is given.
--   select pg_temp.expect_ok(11, 'a member approves a spot', 'insert into ...', 1);
create function pg_temp.expect_ok(step int, what text, stmt text, want_rows bigint default null) returns void language plpgsql as $$
declare r record;
begin
  select * into r from pg_temp.try(stmt);
  if r.code is not null then
    raise exception 'FAIL step %: % (wanted success, got error % "%")', step, what, r.code, r.msg;
  end if;
  if want_rows is not null and r.n is distinct from want_rows then
    raise exception 'FAIL step %: % (wanted % rows, got %)', step, what, want_rows, r.n;
  end if;
  raise notice 'ok step %: %', step, what;
end;
$$;

-- A count query must return this number, as the current role.
--   select pg_temp.expect_count(1, 'a member reads three spots', 'select count(*) from public.session_spots', 3);
create function pg_temp.expect_count(step int, what text, query text, want bigint) returns void language plpgsql as $$
declare got bigint;
begin
  execute query into got;
  if got is distinct from want then
    raise exception 'FAIL step %: % (wanted %, got %)', step, what, want, got;
  end if;
  raise notice 'ok step %: %', step, what;
end;
$$;

-- A query returning one value must return this text, as the current role.
--   select pg_temp.expect_text(2, 'the token is long', 'select char_length(token)::text from ...', '43');
create function pg_temp.expect_text(step int, what text, query text, want text) returns void language plpgsql as $$
declare got text;
begin
  execute query into got;
  if got is distinct from want then
    raise exception 'FAIL step %: % (wanted "%", got "%")', step, what, want, got;
  end if;
  raise notice 'ok step %: %', step, what;
end;
$$;

-- Make a throwaway account. The sign-up trigger makes the profile from the username and date of birth.
--   select pg_temp.new_user('<uuid>');
create function pg_temp.new_user(u uuid) returns void language plpgsql as $$
begin
  insert into auth.users (id, aud, role, email, raw_user_meta_data)
  values (u, 'authenticated', 'authenticated', u || '@example.test',
          jsonb_build_object('username', 't' || substr(md5(u::text), 1, 12), 'dob', '2000-01-01'));
end;
$$;

-- Call the function as the current role; answers its result as text ('null' for null).
--   select pg_temp.apply('<session id>', 7, 'locating', '{"ops": []}');
create function pg_temp.apply(sid uuid, ver bigint, st text, patch jsonb) returns text language plpgsql as $$
begin
  return coalesce(public.apply_session_plan(sid, ver, st, patch)::text, 'null');
end;
$$;

-- The hint of the error a statement raises ('none' when it raises nothing, or no hint).
--   select pg_temp.hint_of('select pg_temp.apply(...)');
create function pg_temp.hint_of(stmt text) returns text language plpgsql as $$
declare h text;
begin
  execute stmt;
  return 'none';
exception when others then
  get stacked diagnostics h = pg_exception_hint;
  return coalesce(h, 'none');
end;
$$;

-- The statement must fail with a rule of the function: error P0001 with this hint.
--   select pg_temp.expect_hint(32, 'a status cannot move without an area', 'select pg_temp.apply(...)', 'status_transition');
create function pg_temp.expect_hint(step int, what text, stmt text, want text) returns void language plpgsql as $$
declare got text;
begin
  got := pg_temp.hint_of(stmt);
  if got is distinct from want then
    raise exception 'FAIL step %: % (wanted hint "%", got "%")', step, what, want, got;
  end if;
  raise notice 'ok step %: %', step, what;
end;
$$;

do $test$
declare
  host uuid := gen_random_uuid();      -- hosts s and s2
  g1 uuid := gen_random_uuid();        -- joined, starts at Clementi, has an exact place
  g2 uuid := gen_random_uuid();        -- joined, starts at Bishan, suggested Tampines
  g3 uuid := gen_random_uuid();        -- joined, no start yet
  stranger uuid := gen_random_uuid();
  s uuid := gen_random_uuid();         -- locating, version 7
  s2 uuid := gen_random_uuid();        -- inviting, the host alone
  s3 uuid := gen_random_uuid();        -- voting, a pinned meeting at Bugis (the "changed means changed" and loaded_at steps)
  s4 uuid := gen_random_uuid();        -- inviting, the host and g1 (the two-people check after the ops)
  s5 uuid := gen_random_uuid();        -- locating, no meeting yet (a pin only with a confirm; the host stays)
  u uuid;
  tm jsonb;
  p jsonb;
begin
  -- ── Setup, as the project owner ─────────────────────────────────────
  foreach u in array array[host, g1, g2, g3, stranger] loop
    perform pg_temp.new_user(u);
  end loop;
  tm := jsonb_build_object(host::text, 20.4, g1::text, 30.4);
  insert into public.sessions (id, host_id, title, date, start_time, end_time, status, plan_version) values
    (s, host, 'Plan test', current_date + 1, '10:00', '20:00', 'locating', 7),
    (s2, host, 'Inviting', current_date + 1, '10:00', '20:00', 'inviting', 0);
  insert into public.session_members (session_id, user_id, state, start_area_id) values
    (s, g1, 'joined', 'clementi'), (s, g2, 'joined', 'bishan'), (s, g3, 'joined', null);
  update public.session_members set start_area_id = 'tampines' where session_id = s and user_id = host;
  insert into public.session_member_places (session_id, user_id, start_label, start_lat, start_lng)
    values (s, g1, 'Private address', 1.33, 103.85);
  insert into public.session_spots (session_id, area_id, rank, worst_minutes, mean_minutes, travel_minutes, approximate) values
    (s, 'bishan', 1, 30.4, 25.4, tm, false), (s, 'bugis', 2, 32.1, 26, tm, false),
    (s, 'orchard', 3, 35.5, 28.5, tm, true), (s, 'tampines', null, 40.25, 31, tm, false);
  insert into public.spot_suggestions (session_id, user_id, area_id, here) values (s, g2, 'tampines', false);
  insert into public.spot_approvals (session_id, area_id, user_id) values
    (s, 'bishan', g1), (s, 'bugis', host), (s, 'orchard', g1);

  -- ── Who may call it ─────────────────────────────────────────────────
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(1, 'only the server may execute it',
    'select (has_function_privilege(''service_role'', ''public.apply_session_plan(uuid,bigint,text,jsonb)'', ''execute'')'
    || ' and not has_function_privilege(''authenticated'', ''public.apply_session_plan(uuid,bigint,text,jsonb)'', ''execute'')'
    || ' and not has_function_privilege(''anon'', ''public.apply_session_plan(uuid,bigint,text,jsonb)'', ''execute''))::text', 'true');
  perform pg_temp.as_user(host);
  perform pg_temp.expect_error(2, 'a signed-in host cannot call it',
    format('select pg_temp.apply(%L, 7, ''locating'', ''{}'')', s), '42501');
  perform pg_temp.as_anon();
  perform pg_temp.expect_error(3, 'a logged-out visitor cannot call it',
    format('select pg_temp.apply(%L, 7, ''locating'', ''{}'')', s), '42501');

  -- ── A write that is too late writes nothing ─────────────────────────
  perform pg_temp.as_server();
  p := jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'clear_approvals')));
  perform pg_temp.expect_text(4, 'a stale version answers null',
    format('select pg_temp.apply(%L, 6, ''locating'', %L::jsonb)', s, p::text), 'null');
  perform pg_temp.expect_text(5, 'a stale status answers null',
    format('select pg_temp.apply(%L, 7, ''voting'', %L::jsonb)', s, p::text), 'null');
  perform pg_temp.expect_text(6, 'an unknown session answers null',
    format('select pg_temp.apply(%L, 0, ''locating'', %L::jsonb)', gen_random_uuid(), p::text), 'null');
  perform pg_temp.as_admin();
  perform pg_temp.expect_count(7, 'and nothing was deleted or raised (3 approvals + version 7)',
    format('select (select count(*) from public.spot_approvals where session_id = %L) + (select plan_version from public.sessions where id = %L)', s, s), 10);

  -- ── The spots are written as a difference ───────────────────────────
  -- Orchard drops out (g1 approved it); Bishan is repriced; Bugis is unchanged; Tampines stays (g2 suggested it) with no rank.
  perform pg_temp.as_server();
  p := jsonb_build_object(
    'banner_text', 'Orchard is no longer on the list, so approvals for it were removed.',
    'spots', jsonb_build_array(
      jsonb_build_object('area_id', 'bishan', 'rank', 1, 'worst_minutes', 31, 'mean_minutes', 25.4, 'travel_minutes', tm, 'approximate', false),
      jsonb_build_object('area_id', 'bugis', 'rank', 2, 'worst_minutes', 32.1, 'mean_minutes', 26, 'travel_minutes', tm, 'approximate', false),
      jsonb_build_object('area_id', 'tampines', 'rank', null, 'worst_minutes', 40.25, 'mean_minutes', 31, 'travel_minutes', tm, 'approximate', false)));
  perform pg_temp.expect_text(8, 'a current write answers the new version',
    format('select pg_temp.apply(%L, 7, ''locating'', %L::jsonb)', s, p::text), '8');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(9, 'the dropped spot and its approval are gone, the others stay',
    format('select (select string_agg(area_id, '','' order by area_id) from public.session_spots where session_id = %L)'
           || ' || '' / '' || (select string_agg(area_id || '':'' || user_id::text, '','' order by area_id) from public.spot_approvals where session_id = %L)', s, s),
    format('bishan,bugis,tampines / bishan:%s,bugis:%s', g1, host));
  perform pg_temp.expect_text(10, 'the group is told, because an approval went',
    format('select (banner ->> ''text'') || '' '' || (banner ->> ''approvalsRemoved'') from public.sessions where id = %L', s),
    'Orchard is no longer on the list, so approvals for it were removed. true');
  perform pg_temp.expect_text(11, 'a repriced spot has the new figure, unrounded',
    format('select worst_minutes::text from public.session_spots where session_id = %L and area_id = ''bishan''', s), '31');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(12, 'the same write again changes nothing and does not raise the version',
    format('select pg_temp.apply(%L, 8, ''locating'', %L::jsonb)', s, p::text), '8');

  -- A spot that nobody approved can drop out without touching the notice.
  p := jsonb_build_object('banner_text', 'This must not be shown.', 'spots', jsonb_build_array(
      jsonb_build_object('area_id', 'bishan', 'rank', 1, 'worst_minutes', 31, 'mean_minutes', 25.4, 'travel_minutes', tm, 'approximate', false),
      jsonb_build_object('area_id', 'bugis', 'rank', 2, 'worst_minutes', 32.1, 'mean_minutes', 26, 'travel_minutes', tm, 'approximate', false)));
  perform pg_temp.expect_text(13, 'dropping a spot nobody approved raises the version',
    format('select pg_temp.apply(%L, 8, ''locating'', %L::jsonb)', s, p::text), '9');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(14, 'and leaves the earlier notice as it was',
    format('select banner ->> ''text'' from public.sessions where id = %L', s),
    'Orchard is no longer on the list, so approvals for it were removed.');

  -- Two spots swap ranks in one call (the rank is unique, checked at the end of the transaction).
  perform pg_temp.as_server();
  p := jsonb_build_object('spots', jsonb_build_array(
      jsonb_build_object('area_id', 'bishan', 'rank', 2, 'worst_minutes', 31, 'mean_minutes', 25.4, 'travel_minutes', tm, 'approximate', false),
      jsonb_build_object('area_id', 'bugis', 'rank', 1, 'worst_minutes', 32.1, 'mean_minutes', 26, 'travel_minutes', tm, 'approximate', false)));
  perform pg_temp.expect_text(15, 'ranks can swap in one call',
    format('select pg_temp.apply(%L, 9, ''locating'', %L::jsonb)', s, p::text), '10');
  set constraints all immediate;
  set constraints all deferred;
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(16, 'and Bugis is now first',
    format('select area_id from public.session_spots where session_id = %L and rank = 1', s), 'bugis');

  -- ── The checks of the tables still apply ────────────────────────────
  perform pg_temp.as_server();
  p := jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'opt_out', 'user_id', g2)),
    'spots', jsonb_build_array(jsonb_build_object('area_id', 'bishan', 'rank', 2, 'worst_minutes', 10, 'mean_minutes', 50, 'travel_minutes', tm, 'approximate', false)));
  perform pg_temp.expect_error(17, 'a spot whose mean is above its longest trip is refused',
    format('select pg_temp.apply(%L, 10, ''locating'', %L::jsonb)', s, p::text), '23514');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(18, 'and the whole write is undone: the member that same call opted out is still joined',
    format('select state from public.session_members where session_id = %L and user_id = %L', s, g2), 'joined');
  perform pg_temp.as_server();
  perform pg_temp.expect_error(19, 'an unknown operation is refused',
    format('select pg_temp.apply(%L, 10, ''locating'', ''{"ops":[{"op":"explode"}]}'')', s), '22023');
  perform pg_temp.expect_error(20, 'a plan that is not an object is refused',
    format('select pg_temp.apply(%L, 10, ''locating'', ''[]'')', s), '22023');

  -- ── Members, suggestions and approvals ──────────────────────────────
  p := jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'suggest', 'user_id', g3, 'area_id', 'woodlands', 'here', true)));
  perform pg_temp.expect_text(21, 'a suggestion is saved, with "here"',
    format('select pg_temp.apply(%L, 10, ''locating'', %L::jsonb)', s, p::text), '11');
  perform pg_temp.expect_text(22, 'the same suggestion again changes nothing',
    format('select pg_temp.apply(%L, 11, ''locating'', %L::jsonb)', s, p::text), '11');
  p := jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'suggest', 'user_id', g3, 'area_id', 'jurong-east')));
  perform pg_temp.expect_text(23, 'a different one replaces it (one suggestion per member)',
    format('select pg_temp.apply(%L, 11, ''locating'', %L::jsonb)', s, p::text), '12');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(24, 'only the new one is there',
    format('select string_agg(area_id || '':'' || here::text, '','') from public.spot_suggestions where session_id = %L and user_id = %L', s, g3), 'jurong-east:false');
  perform pg_temp.as_server();
  p := jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'unsuggest', 'user_id', g3)));
  perform pg_temp.expect_text(25, 'a suggestion is taken back',
    format('select pg_temp.apply(%L, 12, ''locating'', %L::jsonb)', s, p::text), '13');

  p := jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'opt_out', 'user_id', g1)));
  perform pg_temp.expect_text(26, 'opting a member out raises the version',
    format('select pg_temp.apply(%L, 13, ''locating'', %L::jsonb)', s, p::text), '14');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(27, 'the opted-out member keeps their row and has no approvals',
    format('select (select state from public.session_members where session_id = %L and user_id = %L)'
           || ' || '' '' || (select count(*) from public.spot_approvals where session_id = %L and user_id = %L)', s, g1, s, g1), 'opted_out 0');
  perform pg_temp.expect_count(28, 'everyone else''s approval stays (the host''s on Bugis)',
    format('select count(*) from public.spot_approvals where session_id = %L', s), 1);
  perform pg_temp.as_server();
  p := jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'rejoin', 'user_id', g1)));
  perform pg_temp.expect_text(29, 'rejoining raises the version',
    format('select pg_temp.apply(%L, 14, ''locating'', %L::jsonb)', s, p::text), '15');
  p := jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'remove_member', 'user_id', g1)));
  perform pg_temp.expect_text(30, 'removing a member raises the version',
    format('select pg_temp.apply(%L, 15, ''locating'', %L::jsonb)', s, p::text), '16');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(31, 'the row and the exact place go with the member',
    format('select (select count(*) from public.session_members where session_id = %L and user_id = %L)'
           || ' || '' '' || (select count(*) from public.session_member_places where session_id = %L and user_id = %L)', s, g1, s, g1), '0 0');

  -- ── The host's confirm, and the rules around it ─────────────────────
  perform pg_temp.as_server();
  p := jsonb_build_object('session', jsonb_build_object('status', 'voting', 'banner', null,
    'meeting', jsonb_build_object('area_id', 'bugis', 'method', 'voted', 'max_minutes', 32, 'total_minutes', 51, 'count', 2,
      'approximate', false, 'travel', jsonb_build_object(host::text, 20.4, g2::text, 30.6))));
  perform pg_temp.expect_hint(32, 'a status cannot move without an area',
    format('select pg_temp.apply(%L, 16, ''locating'', %L::jsonb)', s, '{"session":{"status":"voting"}}'), 'status_transition');
  perform pg_temp.expect_hint(33, 'only inviting or locating may move to voting',
    format('select pg_temp.apply(%L, 16, ''locating'', %L::jsonb)', s, jsonb_set(p, '{session,status}', '"confirmed"')::text), 'status_transition');
  perform pg_temp.expect_text(34, 'the confirm is written and the version goes up',
    format('select pg_temp.apply(%L, 16, ''locating'', %L::jsonb)', s, p::text), '17');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(35, 'the meeting area, the method and the status are set, and the notice is cleared',
    format('select status || '' '' || meeting_area_id || '' '' || meeting_method || '' '' || meeting_max_minutes || '' '' || meeting_total_minutes'
           || ' || '' '' || meeting_count || '' '' || coalesce(banner::text, ''no banner'') from public.sessions where id = %L', s),
    'voting bugis voted 32 51 2 no banner');
  perform pg_temp.expect_text(36, 'each joined member''s own minutes are written, rounded; a member without a time has none',
    format('select coalesce((select travel_minutes::text from public.session_members where session_id = %L and user_id = %L), ''none'')'
           || ' || '' '' || coalesce((select travel_minutes::text from public.session_members where session_id = %L and user_id = %L), ''none'')'
           || ' || '' '' || coalesce((select travel_minutes::text from public.session_members where session_id = %L and user_id = %L), ''none'')', s, host, s, g2, s, g3),
    '20 31 none');
  perform pg_temp.as_server();
  perform pg_temp.expect_hint(37, 'a pinned meeting area cannot be moved to another area',
    format('select pg_temp.apply(%L, 17, ''voting'', %L::jsonb)', s, jsonb_set(p, '{session,meeting,area_id}', '"orchard"')::text), 'area_pinned');
  perform pg_temp.expect_hint(38, 'nor to another method',
    format('select pg_temp.apply(%L, 17, ''voting'', %L::jsonb)', s, jsonb_set(p, '{session,meeting,method}', '"chosen"')::text), 'area_pinned');
  perform pg_temp.expect_hint(39, 'nor cleared',
    format('select pg_temp.apply(%L, 17, ''voting'', %L::jsonb)', s, '{"session":{"meeting":null}}'), 'area_pinned');
  perform pg_temp.expect_text(40, 'the same area and method again is allowed, and changes nothing (the version stays)',
    format('select pg_temp.apply(%L, 17, ''voting'', %L::jsonb)', s, (p #- '{session,status}')::text), '17');
  perform pg_temp.expect_text(41, 'and so is a write that does not touch the meeting area (it removes the one suggestion left)',
    format('select pg_temp.apply(%L, 17, ''voting'', ''{"ops":[{"op":"clear_suggestions"}]}'')', s), '18');
  perform pg_temp.expect_text(42, 'a late answer worked out while locating is dropped: the status no longer matches',
    format('select pg_temp.apply(%L, 18, ''locating'', %L::jsonb)', s, '{"ops":[{"op":"clear_approvals"}]}'), 'null');

  -- ── Two people to start (leaving inviting) ──────────────────────────
  p := jsonb_build_object('session', jsonb_build_object('status', 'voting',
    'meeting', jsonb_build_object('area_id', 'bugis', 'method', 'chosen', 'max_minutes', 0, 'total_minutes', 0, 'count', 0, 'approximate', false, 'travel', '{}'::jsonb)));
  perform pg_temp.expect_hint(43, 'leaving inviting with the host alone is refused',
    format('select pg_temp.apply(%L, 0, ''inviting'', %L::jsonb)', s2, p::text), 'needs_two_people');
  perform pg_temp.as_admin();
  insert into public.session_members (session_id, user_id, state) values (s2, g1, 'joined');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(44, 'with two people joined it goes through',
    format('select pg_temp.apply(%L, 0, ''inviting'', %L::jsonb)', s2, p::text), '1');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(45, 'the session is in voting with a chosen area',
    format('select status || '' '' || meeting_method from public.sessions where id = %L', s2), 'voting chosen');

  -- ── The time the spots were worked out ──────────────────────────────
  -- A page compares a member's updated_at with it, to see whether a start was never priced. A run that worked the spots out and
  -- changed nothing must still bring it forward, or that page would ask for a recompute every time it opens.
  perform pg_temp.as_admin();
  insert into public.session_spots (session_id, area_id, rank, worst_minutes, mean_minutes, travel_minutes, approximate, computed_at)
    values (s2, 'bishan', 1, 30, 25, '{}', false, now() - interval '1 hour');
  p := jsonb_build_object('spots', jsonb_build_array(
    jsonb_build_object('area_id', 'bishan', 'rank', 1, 'worst_minutes', 30, 'mean_minutes', 25, 'travel_minutes', '{}'::jsonb, 'approximate', false)));
  perform pg_temp.as_server();
  perform pg_temp.expect_text(46, 'keeping the stored spots as they are leaves the version alone',
    format('select pg_temp.apply(%L, 1, ''voting'', %L::jsonb)', s2, p::text), '1');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(47, 'and the time they were worked out',
    format('select (computed_at < now())::text from public.session_spots where session_id = %L and area_id = ''bishan''', s2), 'true');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(48, 'a run that worked them out again and changed nothing still answers the same version',
    format('select pg_temp.apply(%L, 1, ''voting'', %L::jsonb)', s2, (p || jsonb_build_object('recomputed', true))::text), '1');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(49, 'but brings the time they were worked out forward',
    format('select (computed_at = now())::text from public.session_spots where session_id = %L and area_id = ''bishan''', s2), 'true');

  -- ── A change is a change: only a value that differs counts ──────────
  -- s3 is voting, pinned at Bugis with figures of 10 and 20 minutes, worked out three hours ago.
  perform pg_temp.as_admin();
  insert into public.sessions (id, host_id, title, date, start_time, end_time, status, plan_version, meeting_area_id, meeting_method,
                               meeting_max_minutes, meeting_total_minutes, meeting_count, meeting_approximate, meeting_computed_at)
    values (s3, host, 'Pinned', current_date + 1, '10:00', '20:00', 'voting', 0, 'bugis', 'chosen', 10, 20, 2, false, now() - interval '3 hours');
  insert into public.session_members (session_id, user_id, state) values (s3, g1, 'joined');
  p := jsonb_build_object('session', jsonb_build_object('meeting', jsonb_build_object('area_id', 'bugis', 'method', 'chosen',
    'max_minutes', 10.4, 'total_minutes', 19.6, 'count', 2, 'approximate', false, 'travel', jsonb_build_object(host::text, 10, g1::text, 10))));
  perform pg_temp.as_server();
  perform pg_temp.expect_text(50, 'the same pinned meeting again (figures that round the same) answers the stored version',
    format('select pg_temp.apply(%L, 0, ''voting'', %L::jsonb)', s3, p::text), '0');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(51, 'and writes nothing, not even the time the meeting was worked out',
    format('select plan_version::text || '' '' || (meeting_computed_at = now() - interval ''3 hours'')::text from public.sessions where id = %L', s3), '0 true');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(52, 'a meeting whose figure differs is written and raises the version',
    format('select pg_temp.apply(%L, 0, ''voting'', %L::jsonb)', s3, jsonb_set(p, '{session,meeting,max_minutes}', '11')::text), '1');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(53, 'with the new figure, and the time the meeting was worked out moves',
    format('select meeting_max_minutes::text || '' '' || (meeting_computed_at = now())::text from public.sessions where id = %L', s3), '11 true');
  p := jsonb_build_object('session', jsonb_build_object('banner', jsonb_build_object('text', 'Hello', 'at', 1, 'approvalsRemoved', true)));
  perform pg_temp.as_server();
  perform pg_temp.expect_text(54, 'a new banner is written and raises the version',
    format('select pg_temp.apply(%L, 1, ''voting'', %L::jsonb)', s3, p::text), '2');
  perform pg_temp.expect_text(55, 'the same banner again changes nothing',
    format('select pg_temp.apply(%L, 2, ''voting'', %L::jsonb)', s3, p::text), '2');
  perform pg_temp.expect_text(56, 'clearing the banner is a change',
    format('select pg_temp.apply(%L, 2, ''voting'', %L::jsonb)', s3, '{"session":{"banner":null}}'), '3');
  perform pg_temp.expect_text(57, 'and clearing it again is not',
    format('select pg_temp.apply(%L, 3, ''voting'', %L::jsonb)', s3, '{"session":{"banner":null}}'), '3');

  -- ── The two-people check runs after the ops ─────────────────────────
  -- s4 has the host and g1 joined. Opting g1 out and starting in one call would leave the host alone.
  perform pg_temp.as_admin();
  insert into public.sessions (id, host_id, title, date, start_time, end_time, status, plan_version)
    values (s4, host, 'Starting', current_date + 1, '10:00', '20:00', 'inviting', 0);
  insert into public.session_members (session_id, user_id, state) values (s4, g1, 'joined');
  p := jsonb_build_object('session', jsonb_build_object('status', 'voting',
    'meeting', jsonb_build_object('area_id', 'bugis', 'method', 'chosen', 'max_minutes', 0, 'total_minutes', 0, 'count', 0, 'approximate', false, 'travel', '{}'::jsonb)));
  perform pg_temp.as_server();
  perform pg_temp.expect_hint(58, 'opting the only other member out while starting is refused: one person would remain',
    format('select pg_temp.apply(%L, 0, ''inviting'', %L::jsonb)', s4,
           (p || jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'opt_out', 'user_id', g1))))::text), 'needs_two_people');
  perform pg_temp.expect_hint(59, 'so is removing them while starting',
    format('select pg_temp.apply(%L, 0, ''inviting'', %L::jsonb)', s4,
           (p || jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'remove_member', 'user_id', g1))))::text), 'needs_two_people');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(60, 'and nothing was written: g1 is still joined, the session still inviting at version 0',
    format('select (select state from public.session_members where session_id = %L and user_id = %L) || '' '' || status || '' '' || plan_version'
           || ' from public.sessions where id = %L', s4, g1, s4), 'joined inviting 0');
  insert into public.session_members (session_id, user_id, state) values (s4, g2, 'joined');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(61, 'with two still joined after the ops it goes through',
    format('select pg_temp.apply(%L, 0, ''inviting'', %L::jsonb)', s4,
           (p || jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'opt_out', 'user_id', g2))))::text), '1');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(62, 'g2 is opted out and the session is voting',
    format('select (select state from public.session_members where session_id = %L and user_id = %L) || '' '' || status'
           || ' from public.sessions where id = %L', s4, g2, s4), 'opted_out voting');

  -- ── A pin only with a confirm ───────────────────────────────────────
  -- s5 is locating with no meeting. A pinned method ('voted' or 'chosen') comes only with the move to voting (steps 34 and 44),
  -- or when the stored meeting already is that pin (step 40).
  perform pg_temp.as_admin();
  insert into public.sessions (id, host_id, title, date, start_time, end_time, status, plan_version)
    values (s5, host, 'Locating', current_date + 1, '10:00', '20:00', 'locating', 0);
  p := jsonb_build_object('session', jsonb_build_object('meeting', jsonb_build_object('area_id', 'bugis', 'method', 'voted',
    'max_minutes', 10, 'total_minutes', 20, 'count', 2, 'approximate', false, 'travel', '{}'::jsonb)));
  perform pg_temp.as_server();
  perform pg_temp.expect_hint(63, 'a voted meeting without the move to voting is refused',
    format('select pg_temp.apply(%L, 0, ''locating'', %L::jsonb)', s5, p::text), 'pin_without_confirm');
  perform pg_temp.expect_hint(64, 'so is a chosen one',
    format('select pg_temp.apply(%L, 0, ''locating'', %L::jsonb)', s5, jsonb_set(p, '{session,meeting,method}', '"chosen"')::text), 'pin_without_confirm');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(65, 'and nothing was written',
    format('select plan_version::text || '' '' || coalesce(meeting_method, ''none'') from public.sessions where id = %L', s5), '0 none');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(66, 'the planner''s own method needs no confirm',
    format('select pg_temp.apply(%L, 0, ''locating'', %L::jsonb)', s5, jsonb_set(p, '{session,meeting,method}', '"fairest"')::text), '1');
  perform pg_temp.expect_hint(67, 'and a stored planner method is not a pin: turning it into one without the move is refused',
    format('select pg_temp.apply(%L, 1, ''locating'', %L::jsonb)', s5, jsonb_set(p, '{session,meeting,method}', '"chosen"')::text), 'pin_without_confirm');

  -- ── The host stays ──────────────────────────────────────────────────
  perform pg_temp.expect_hint(68, 'the function never opts the host out',
    format('select pg_temp.apply(%L, 1, ''locating'', %L::jsonb)', s5, jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'opt_out', 'user_id', host)))::text), 'host_member');
  perform pg_temp.expect_hint(69, 'nor removes the host',
    format('select pg_temp.apply(%L, 1, ''locating'', %L::jsonb)', s5, jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'remove_member', 'user_id', host)))::text), 'host_member');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(70, 'and the host is still joined',
    format('select state from public.session_members where session_id = %L and user_id = %L', s5, host), 'joined');

  -- ── computed_at is when the inputs were loaded ──────────────────────
  -- s3 is at version 3. Its spots were worked out two hours ago, except Orchard, which a later run wrote just now.
  perform pg_temp.as_admin();
  insert into public.session_spots (session_id, area_id, rank, worst_minutes, mean_minutes, travel_minutes, approximate, computed_at) values
    (s3, 'bishan', 1, 30, 25, '{}', false, now() - interval '2 hours'),
    (s3, 'bugis', 2, 32, 26, '{}', false, now() - interval '2 hours'),
    (s3, 'orchard', 3, 35, 28, '{}', false, now());
  p := jsonb_build_object('recomputed', true,
    'loaded_at', to_char((now() - interval '1 hour') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'spots', jsonb_build_array(
      jsonb_build_object('area_id', 'bishan', 'rank', 1, 'worst_minutes', 31, 'mean_minutes', 25, 'travel_minutes', '{}'::jsonb, 'approximate', false),
      jsonb_build_object('area_id', 'bugis', 'rank', 2, 'worst_minutes', 32, 'mean_minutes', 26, 'travel_minutes', '{}'::jsonb, 'approximate', false),
      jsonb_build_object('area_id', 'orchard', 'rank', 3, 'worst_minutes', 35, 'mean_minutes', 28, 'travel_minutes', '{}'::jsonb, 'approximate', false)));
  perform pg_temp.as_server();
  perform pg_temp.expect_text(71, 'a run that loaded its inputs an hour ago writes the repriced spot',
    format('select pg_temp.apply(%L, 3, ''voting'', %L::jsonb)', s3, p::text), '4');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(72, 'with computed_at an hour ago, not now',
    format('select (computed_at = now() - interval ''1 hour'')::text from public.session_spots where session_id = %L and area_id = ''bishan''', s3), 'true');
  perform pg_temp.expect_text(73, 'the refresh brings the untouched older spot to that time, and never moves a newer one back',
    format('select ((select computed_at from public.session_spots where session_id = %L and area_id = ''bugis'') = now() - interval ''1 hour'''
           || ' and (select computed_at from public.session_spots where session_id = %L and area_id = ''orchard'') = now())::text', s3, s3), 'true');
  update public.session_members set start_area_id = 'bedok' where session_id = s3 and user_id = g1;
  perform pg_temp.expect_text(74, 'a member row changed after the inputs were loaded is newer than the spot, so the repair check still sees it',
    format('select ((select updated_at from public.session_members where session_id = %L and user_id = %L)'
           || ' > (select computed_at from public.session_spots where session_id = %L and area_id = ''bishan''))::text', s3, g1, s3), 'true');
  p := jsonb_set(p, '{spots}', (p -> 'spots') || jsonb_build_array(
    jsonb_build_object('area_id', 'jurong-east', 'rank', null, 'worst_minutes', 40, 'mean_minutes', 30, 'travel_minutes', '{}'::jsonb, 'approximate', false)));
  perform pg_temp.as_server();
  perform pg_temp.expect_text(75, 'a new spot is written too',
    format('select pg_temp.apply(%L, 4, ''voting'', %L::jsonb)', s3, p::text), '5');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(76, 'with computed_at an hour ago as well',
    format('select (computed_at = now() - interval ''1 hour'')::text from public.session_spots where session_id = %L and area_id = ''jurong-east''', s3), 'true');

  raise notice 'ALL STEPS PASSED';
end;
$test$;

-- Nothing is kept: the users, sessions, spots, suggestions and approvals above are all discarded here.
rollback;
