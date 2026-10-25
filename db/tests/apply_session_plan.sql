-- Test for the server's plan-writing function: apply_session_plan(), in db/migrations/20261020000000_jio_apply_session_plan.sql (or a
-- fresh build of db/schema.sql and db/policies.sql). It needs slice b applied (the meeting-spot tables and sessions.plan_version).
--
-- Steps 1 to 76 are the stage 3 steps, unchanged: run on the live project on 20 October 2026 by the lead's agent, with the function
-- created inside the same transaction and everything rolled back, all 76 passed, and no function, user or session was left behind.
-- Steps 77 onwards are stage 4's (db/migrations/20261022000000_jio_apply_session_plan_slots.sql): the slots and options as a
-- difference, the votes that go with a member or a moved meeting area, the radius, the stamped banner, and the voting rules of a
-- browser. Steps 140 to 150 are the venue id limit of the same migration: a place's id of 120 characters as an option, a vote, a swap
-- and a stop, and 161 refused. Steps 151 to 172 are its smaller rules: a swap of a place for itself changes nothing (151 and 152), a part
-- of the plan or of the session that the function does not know is refused with 22023 (153 to 157), a member's minutes are written only
-- where they differ (158 to 162), and the checks on a place's id are dropped by what they check, whatever they are called (163 to 172).
-- Steps 173 onwards are stage 5's (db/migrations/20261023000000_jio_apply_session_plan_stops.sql): the confirm of the stops (173 to 183),
-- stops as a difference (184 to 195), a travel mode (196 to 198), a stop changed to another place (199 to 202), Roam proposals (203 to 215),
-- the ledger and finishing the outing (216 to 227), a ledger row already stored and the travel debt (228 to 231), what a member may read
-- and no browser may write (232 to 241), the suggested order (242 to 248), and opening the plan again, with a stop that is not listed
-- going (249 to 257), then a guest opting out of a confirmed plan, with the "Re-plan?" prompt written in the same patch (258 to 269).
-- Steps 1 to 172 passed on the live project when stage 4 was applied. Steps 258 to 269 add no rule to the function (the migration's text is unchanged): they test what the server's opt-out of a confirmed plan sends. Steps 1 to 269 passed on 26 October 2026 on a fresh build of db/schema.sql and db/policies.sql in a local in-memory Postgres (PGlite 0.3.2, not the live project, not the migration on its own). Steps 1 to 257 were also run, on a local in-memory Postgres (PGlite
-- 0.4.1, not the live project), once on a fresh build of db/schema.sql and db/policies.sql and once on the live project's state (the
-- schema of 9 October and the migrations applied since, then stage 5's migration, which was also applied twice and after slice d), and
-- all passed. The lead runs the whole file on the live project once the stage 5 migration is applied, or in one transaction with the
-- migration's statements before it.
--
-- How to run: after the migration (or a fresh build), run this whole file as ONE batch, in the SQL editor
-- or with   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/apply_session_plan.sql
-- It runs as the project's owner role ("postgres"), makes throwaway users and sessions, acts as each of them (set role + the
-- JWT claims, the way Supabase does for a request) and as the server (service_role), and ends with a rollback, so no rows are
-- left whether it passes or fails. A passing step prints a notice "ok step N". A broken rule raises an exception "FAIL step N: ..."
-- and stops the run (with the rollback that follows).
--
-- Expected error codes: 42501 = permission denied, 23514 = check constraint, 23505 = unique, 23502 = not null, 22023 = bad parameter
-- value, P0001 = a rule of the function (with a hint: area_pinned, pin_without_confirm, host_member, needs_two_people,
-- status_transition, slots_status, slot_missing, and from stage 5 stops_status, order_status, ledger_status, stops_missing, not_enough_votes,
-- too_many_stops, stop_slot, stop_missing, last_stop, stop_order, stop_duplicate, stop_not_option, ledger_member, ledger_sum, proposal_status,
-- proposal_member, already_a_stop, plan_full, too_many_proposals).

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
  sv uuid := gen_random_uuid();        -- voting, an unpinned meeting at Bugis (the slot steps)
  sl uuid := gen_random_uuid();        -- locating, the host and g1 (a confirm that makes the slots in the same call)
  sc uuid := gen_random_uuid();        -- stage 5: voting, the host, g1 and g2 joined, two slots with options (the plan's confirm, edits and finish)
  sn uuid := gen_random_uuid();        -- stage 5: voting, the host and g1 (the suggested order is stored here; the travel debt is asked for here)
  sx uuid := gen_random_uuid();        -- stage 5: confirmed, with a ledger row stored already (a finish that got further than its first try)
  sr uuid := gen_random_uuid();        -- stage 5: confirmed, pinned, with stops, a note, a suggestion and a proposal (the plan is opened again)
  so uuid := gen_random_uuid();        -- stage 5: confirmed, three people, votes and two proposals (a guest opts out of the confirmed plan)
  slot_c_eat uuid;
  slot_c_drink uuid;
  slot_r_eat uuid;
  slot_r_drink uuid;
  proposal_p1 uuid;
  stops_json jsonb;
  stops_swapped jsonb;
  ver5 bigint;
  slot_eat uuid;
  slot_drink uuid;
  u uuid;
  tm jsonb;
  p jsonb;
  -- The id of a saved hawker centre from OneMap is 86 characters; this one is 120, well past the old limit of 80.
  long_id text := 'onemap_ssot_hawkercentres_' || repeat('x', 94);
  ver bigint;
  -- The physical address of a member's row (it changes with every update of the row, even one that writes the same values).
  tid_host text;
  tid_g1 text;
  -- The statement of the migration that drops the venue id checks by what they check (the same text; backend/tests/sessions-sql.test.js
  -- compares the two).
  drop_checks text := $sql$do $venue_checks$
declare
  old_check record;
begin
  for old_check in
    select con.conrelid::regclass as table_name, con.conname as check_name
    from pg_constraint con
    where con.contype = 'c'
      and con.conrelid in (to_regclass('public.slot_options'), to_regclass('public.stops'), to_regclass('public.stop_proposals'))
      and pg_get_constraintdef(con.oid) like '%venue_id%'
  loop
    execute format('alter table %s drop constraint %I', old_check.table_name, old_check.check_name);
  end loop;
end;
$venue_checks$$sql$;
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


  -- ── Stage 4: slots and options, written as a difference ──────────────
  -- sv is voting with an unpinned meeting at Bugis; the host, g1 and g2 are joined and g3 has opted out.
  perform pg_temp.as_admin();
  insert into public.sessions (id, host_id, title, date, start_time, end_time, status, plan_version, meeting_area_id, meeting_method,
                               meeting_max_minutes, meeting_total_minutes, meeting_count, meeting_approximate, meeting_computed_at)
    values (sv, host, 'Voting', current_date + 1, '10:00', '20:00', 'voting', 0, 'bugis', 'fairest', 20, 40, 2, false, now());
  insert into public.session_members (session_id, user_id, state) values (sv, g1, 'joined'), (sv, g2, 'joined'), (sv, g3, 'opted_out');

  -- Rule 7: slots, votes and options are written only while the session is voting.
  perform pg_temp.as_server();
  perform pg_temp.expect_hint(77, 'slots are refused while the session is locating',
    format('select pg_temp.apply(%L, 1, ''locating'', %L::jsonb)', s5,
           '{"slots":[{"category":"eat","start_minute":720,"duration_minutes":90}]}'), 'slots_status');
  perform pg_temp.expect_hint(78, 'so is clearing votes',
    format('select pg_temp.apply(%L, 1, ''locating'', %L::jsonb)', s5, '{"ops":[{"op":"clear_votes"}]}'), 'slots_status');
  perform pg_temp.expect_hint(79, 'and swapping an option',
    format('select pg_temp.apply(%L, 1, ''locating'', %L::jsonb)', s5,
           '{"ops":[{"op":"swap_option","category":"eat","from":"a","to":"b"}]}'), 'slots_status');

  p := jsonb_build_object('slots', jsonb_build_array(
    jsonb_build_object('category', 'eat', 'start_minute', 720, 'duration_minutes', 90, 'picks', 2, 'is_last', false,
      'details', jsonb_build_object('widened', false), 'options', jsonb_build_array(
        jsonb_build_object('venue_id', 'a', 'rank', 1, 'score', 10.5, 'details', jsonb_build_object('walk', 3)),
        jsonb_build_object('venue_id', 'b', 'rank', 2, 'score', 12),
        jsonb_build_object('venue_id', 'c', 'rank', 3, 'score', 15, 'source', 'member', 'added_by', g1))),
    jsonb_build_object('category', 'drink', 'start_minute', 900, 'duration_minutes', 60, 'is_last', true, 'options', jsonb_build_array(
        jsonb_build_object('venue_id', 'd', 'rank', 1, 'score', 9)))));
  perform pg_temp.expect_text(80, 'slots and options are made, and the version goes up',
    format('select pg_temp.apply(%L, 0, ''voting'', %L::jsonb)', sv, p::text), '1');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(81, 'two slots with four options, with the figures sent',
    format('select (select count(*) from public.slots where session_id = %L) || '' '' || (select count(*) from public.slot_options o join public.slots x on x.id = o.slot_id where x.session_id = %L)'
           || ' || '' '' || (select start_minute || ''/'' || duration_minutes || ''/'' || picks || ''/'' || is_last from public.slots where session_id = %L and category = ''eat'')'
           || ' || '' '' || (select score::text from public.slot_options o join public.slots x on x.id = o.slot_id where x.session_id = %L and o.venue_id = ''a'')', sv, sv, sv, sv),
    '2 4 720/90/2/false 10.5');
  select id into slot_eat from public.slots where session_id = sv and category = 'eat';
  select id into slot_drink from public.slots where session_id = sv and category = 'drink';
  perform pg_temp.as_server();
  perform pg_temp.expect_error(82, 'a new slot needs its start and length',
    format('select pg_temp.apply(%L, 1, ''voting'', %L::jsonb)', sv, '{"slots":[{"category":"shop"}]}'), '23502');
  perform pg_temp.expect_text(83, 'the same slots again change nothing and do not raise the version',
    format('select pg_temp.apply(%L, 1, ''voting'', %L::jsonb)', sv, p::text), '1');

  -- Votes: g1 on A and the host on B in Eat, g2 on D in Drink (cast through the table, as a browser would not need to repeat).
  perform pg_temp.as_admin();
  insert into public.votes (slot_id, user_id, venue_id) values (slot_eat, g1, 'a'), (slot_eat, host, 'b'), (slot_drink, g2, 'd');
  -- Eat now lists A (new score), C and E. B drops out and takes the host's vote; C keeps its source and who added it.
  p := jsonb_build_object('slots', jsonb_build_array(jsonb_build_object('category', 'eat', 'options', jsonb_build_array(
        jsonb_build_object('venue_id', 'a', 'rank', 1, 'score', 8.25, 'details', jsonb_build_object('walk', 4)),
        jsonb_build_object('venue_id', 'c', 'rank', 2, 'score', 15, 'source', 'planner'),
        jsonb_build_object('venue_id', 'e', 'rank', 3, 'score', 20)))));
  perform pg_temp.as_server();
  perform pg_temp.expect_text(84, 'a changed list is written and raises the version',
    format('select pg_temp.apply(%L, 1, ''voting'', %L::jsonb)', sv, p::text), '2');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(85, 'the dropped option took its vote; the kept option kept its vote; Drink is untouched',
    format('select string_agg(v.user_id::text || '':'' || v.venue_id, '','' order by v.venue_id) from public.votes v join public.slots x on x.id = v.slot_id where x.session_id = %L', sv),
    format('%s:a,%s:d', g1, g2));
  perform pg_temp.expect_text(86, 'the options are A, C and E',
    format('select string_agg(venue_id, '','' order by venue_id) from public.slot_options where slot_id = %L', slot_eat), 'a,c,e');
  perform pg_temp.expect_text(87, 'a kept option has the new score and details',
    format('select score::text || '' '' || (details ->> ''walk'') from public.slot_options where slot_id = %L and venue_id = ''a''', slot_eat), '8.25 4');
  perform pg_temp.expect_text(88, 'and keeps its source and who added it when the planner lists it again',
    format('select source || '' '' || (added_by = %L)::text from public.slot_options where slot_id = %L and venue_id = ''c''', g1, slot_eat), 'member true');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(89, 'a slot item without options changes only the fields it carries',
    format('select pg_temp.apply(%L, 2, ''voting'', %L::jsonb)', sv, '{"slots":[{"category":"eat","start_minute":780}]}'), '3');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(90, 'the start moved, the length and the options stayed',
    format('select start_minute || ''/'' || duration_minutes || '' '' || (select count(*) from public.slot_options where slot_id = %L) from public.slots where id = %L', slot_eat, slot_eat),
    '780/90 3');

  -- Removing a slot, and bringing it back.
  perform pg_temp.as_server();
  perform pg_temp.expect_text(91, 'a removed slot loses its options, and with them its votes',
    format('select pg_temp.apply(%L, 3, ''voting'', %L::jsonb)', sv, '{"slots":[{"category":"drink","deleted":true,"options":[{"venue_id":"zzz"}]}]}'), '4');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(92, 'Drink is deleted with no options and no votes (the options sent with it are ignored)',
    format('select deleted::text || '' '' || (select count(*) from public.slot_options where slot_id = %L) || '' '' || (select count(*) from public.votes where slot_id = %L) from public.slots where id = %L',
           slot_drink, slot_drink, slot_drink), 'true 0 0');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(93, 'restoring it with a list of options',
    format('select pg_temp.apply(%L, 4, ''voting'', %L::jsonb)', sv,
           '{"slots":[{"category":"drink","deleted":false,"options":[{"venue_id":"d","rank":1,"score":9},{"venue_id":"f","rank":2,"score":11}]}]}'), '5');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(94, 'Drink is back with two options',
    format('select deleted::text || '' '' || (select count(*) from public.slot_options where slot_id = %L) from public.slots where id = %L', slot_drink, slot_drink), 'false 2');

  -- Swapping an option in place: the votes follow it.
  perform pg_temp.as_server();
  perform pg_temp.expect_text(95, 'a swap raises the version',
    format('select pg_temp.apply(%L, 5, ''voting'', %L::jsonb)', sv, '{"ops":[{"op":"swap_option","category":"eat","from":"a","to":"a2"}]}'), '6');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(96, 'the option is now A2 and g1''s vote moved with it',
    format('select (select string_agg(venue_id, '','' order by venue_id) from public.slot_options where slot_id = %L) || '' '' || (select venue_id from public.votes where slot_id = %L and user_id = %L)',
           slot_eat, slot_eat, g1), 'a2,c,e a2');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(97, 'swapping again changes nothing: the place it leaves is gone',
    format('select pg_temp.apply(%L, 6, ''voting'', %L::jsonb)', sv, '{"ops":[{"op":"swap_option","category":"eat","from":"a","to":"a2"}]}'), '6');
  perform pg_temp.as_admin();
  insert into public.votes (slot_id, user_id, venue_id) values (slot_eat, host, 'c');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(98, 'swapping into a place that is already an option',
    format('select pg_temp.apply(%L, 6, ''voting'', %L::jsonb)', sv, '{"ops":[{"op":"swap_option","category":"eat","from":"c","to":"e"}]}'), '7');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(99, 'moves the votes to it and removes the old option',
    format('select (select string_agg(venue_id, '','' order by venue_id) from public.slot_options where slot_id = %L) || '' '' || (select venue_id from public.votes where slot_id = %L and user_id = %L)',
           slot_eat, slot_eat, host), 'a2,e e');
  perform pg_temp.as_server();
  perform pg_temp.expect_hint(100, 'a swap in a slot the session does not have is refused',
    format('select pg_temp.apply(%L, 7, ''voting'', %L::jsonb)', sv, '{"ops":[{"op":"swap_option","category":"shop","from":"a","to":"b"}]}'), 'slot_missing');

  -- The radius and the banner.
  perform pg_temp.expect_text(101, 'the radius is written and raises the version',
    format('select pg_temp.apply(%L, 7, ''voting'', %L::jsonb)', sv, '{"session":{"radius_meters":1000}}'), '8');
  perform pg_temp.expect_text(102, 'the same radius again changes nothing',
    format('select pg_temp.apply(%L, 8, ''voting'', %L::jsonb)', sv, '{"session":{"radius_meters":1000}}'), '8');
  perform pg_temp.expect_text(103, 'clearing it is a change',
    format('select pg_temp.apply(%L, 8, ''voting'', %L::jsonb)', sv, '{"session":{"radius_meters":null}}'), '9');
  perform pg_temp.expect_error(104, 'a radius outside 100 to 3000 is refused by the table',
    format('select pg_temp.apply(%L, 9, ''voting'', %L::jsonb)', sv, '{"session":{"radius_meters":50}}'), '23514');
  p := '{"session":{"banner":{"text":"Votes for places outside the new ring were cleared.","votesCleared":true,"byRadius":true}}}'::jsonb;
  perform pg_temp.expect_text(105, 'a banner sent without its time is written',
    format('select pg_temp.apply(%L, 9, ''voting'', %L::jsonb)', sv, p::text), '10');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(106, 'with the database''s time, in milliseconds, beside what was sent',
    format('select ((banner ->> ''at'')::bigint > 1700000000000)::text || '' '' || (banner ->> ''byRadius'') from public.sessions where id = %L', sv), 'true true');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(107, 'the same banner again changes nothing (it differs only by the time)',
    format('select pg_temp.apply(%L, 10, ''voting'', %L::jsonb)', sv, p::text), '10');
  perform pg_temp.expect_text(108, 'a banner sent with its time is written as it was before: exactly as sent',
    format('select pg_temp.apply(%L, 10, ''voting'', %L::jsonb)', sv, '{"session":{"banner":{"text":"Hello","at":5}}}'), '11');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(109, 'with the time it carried',
    format('select (banner ->> ''at'') from public.sessions where id = %L', sv), '5');

  -- The meeting area moving in voting, with the votes cleared in the same call, then the votes that go with a member.
  perform pg_temp.as_admin();
  perform pg_temp.expect_count(110, 'two votes stand before the meeting area moves',
    format('select count(*) from public.votes v join public.slots x on x.id = v.slot_id where x.session_id = %L', sv), 2);
  p := jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'clear_votes')),
    'session', jsonb_build_object('meeting', jsonb_build_object('area_id', 'orchard', 'method', 'fairest', 'max_minutes', 25, 'total_minutes', 45,
      'count', 2, 'approximate', false, 'travel', jsonb_build_object(host::text, 20, g1::text, 25, g2::text, 18))));
  perform pg_temp.as_server();
  perform pg_temp.expect_text(111, 'an unpinned meeting area moves in voting, and its votes are cleared in the same call',
    format('select pg_temp.apply(%L, 11, ''voting'', %L::jsonb)', sv, p::text), '12');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(112, 'the area is Orchard, no vote is left, the options stay, and g1 has their minutes',
    format('select meeting_area_id || '' '' || (select count(*) from public.votes v join public.slots x on x.id = v.slot_id where x.session_id = %L)'
           || ' || '' '' || (select count(*) from public.slot_options where slot_id = %L) || '' '' || (select travel_minutes from public.session_members where session_id = %L and user_id = %L)'
           || ' from public.sessions where id = %L', sv, slot_eat, sv, g1, sv),
    'orchard 0 2 25');
  insert into public.votes (slot_id, user_id, venue_id) values (slot_eat, g1, 'a2'), (slot_eat, g2, 'e'), (slot_drink, g2, 'd');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(113, 'opting a member out deletes their votes too',
    format('select pg_temp.apply(%L, 12, ''voting'', %L::jsonb)', sv, jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'opt_out', 'user_id', g2)))::text), '13');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(114, 'g2 is out and has no vote; g1''s stands',
    format('select (select state from public.session_members where session_id = %L and user_id = %L) || '' '' || (select count(*) from public.votes where user_id = %L and slot_id in (%L, %L))'
           || ' || '' '' || (select count(*) from public.votes where user_id = %L and slot_id = %L)', sv, g2, g2, slot_eat, slot_drink, g1, slot_eat),
    'opted_out 0 1');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(115, 'removing a member deletes their votes, which no foreign key would',
    format('select pg_temp.apply(%L, 13, ''voting'', %L::jsonb)', sv, jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'remove_member', 'user_id', g1)))::text), '14');
  perform pg_temp.as_admin();
  perform pg_temp.expect_count(116, 'g1 has no vote left in the session',
    format('select count(*) from public.votes v join public.slots x on x.id = v.slot_id where x.session_id = %L and v.user_id = %L', sv, g1), 0);

  -- Votes cast by someone who is not joined go with the next write of the slots.
  perform pg_temp.as_admin();
  insert into public.votes (slot_id, user_id, venue_id) values (slot_eat, g3, 'e');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(117, 'a late vote by an opted-out member is cleaned up by the next slot write',
    format('select pg_temp.apply(%L, 14, ''voting'', %L::jsonb)', sv, '{"slots":[{"category":"eat"}]}'), '15');
  perform pg_temp.as_admin();
  perform pg_temp.expect_count(118, 'and it is gone',
    format('select count(*) from public.votes where user_id = %L', g3), 0);

  -- A late answer writes nothing.
  perform pg_temp.as_server();
  perform pg_temp.expect_text(119, 'a slot write computed against an older version answers null',
    format('select pg_temp.apply(%L, 14, ''voting'', %L::jsonb)', sv, '{"slots":[{"category":"eat","start_minute":600}]}'), 'null');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(120, 'and changed nothing',
    format('select start_minute::text from public.slots where id = %L', slot_eat), '780');

  -- A slot that no longer fits the day is removed.
  perform pg_temp.as_server();
  perform pg_temp.expect_text(121, 'a slot can be removed outright',
    format('select pg_temp.apply(%L, 15, ''voting'', %L::jsonb)', sv, '{"slots":[{"category":"drink","remove":true}]}'), '16');
  perform pg_temp.as_admin();
  perform pg_temp.expect_count(122, 'Drink is gone with its options',
    format('select (select count(*) from public.slots where session_id = %L and category = ''drink'') + (select count(*) from public.slot_options where slot_id = %L)', sv, slot_drink), 0);

  -- The confirm makes the slots in the same call as the status move.
  perform pg_temp.as_admin();
  insert into public.sessions (id, host_id, title, date, start_time, end_time, status, plan_version) values (sl, host, 'Confirming', current_date + 1, '10:00', '20:00', 'locating', 0);
  insert into public.session_members (session_id, user_id, state) values (sl, g1, 'joined');
  p := jsonb_build_object('session', jsonb_build_object('status', 'voting', 'banner', null,
      'meeting', jsonb_build_object('area_id', 'bugis', 'method', 'voted', 'max_minutes', 20, 'total_minutes', 40, 'count', 2, 'approximate', false, 'travel', '{}'::jsonb)),
    'slots', jsonb_build_array(jsonb_build_object('category', 'eat', 'start_minute', 720, 'duration_minutes', 90, 'options', jsonb_build_array(jsonb_build_object('venue_id', 'a', 'rank', 1, 'score', 5)))));
  perform pg_temp.as_server();
  perform pg_temp.expect_text(123, 'the confirm moves to voting and makes the slots and options in one call',
    format('select pg_temp.apply(%L, 0, ''locating'', %L::jsonb)', sl, p::text), '1');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(124, 'the session is voting with a slot and an option',
    format('select status || '' '' || (select count(*) from public.slots where session_id = %L) || '' '' || (select count(*) from public.slot_options o join public.slots x on x.id = o.slot_id where x.session_id = %L)'
           || ' from public.sessions where id = %L', sl, sl, sl), 'voting 1 1');
  perform pg_temp.as_server();
  perform pg_temp.expect_hint(125, 'a pinned meeting area still cannot be moved by a recompute in voting',
    format('select pg_temp.apply(%L, 1, ''voting'', %L::jsonb)', sl, jsonb_set(p, '{session,meeting,area_id}', '"orchard"')::text), 'area_pinned');

  -- ── Stage 4: what a browser may do in voting ─────────────────────────
  -- Votes are the one planning write a browser makes. sv is voting; the host and g2 are joined... g2 is out, so use sl (host, g1).
  perform pg_temp.as_admin();
  select id into slot_eat from public.slots where session_id = sl and category = 'eat';
  insert into public.slot_options (slot_id, venue_id, rank, score) values (slot_eat, 'b', 2, 6);
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_ok(126, 'a joined member votes for an option', format('insert into public.votes (slot_id, user_id, venue_id) values (%L, %L, ''a'')', slot_eat, g1), 1);
  perform pg_temp.expect_error(127, 'a member cannot vote as somebody else',
    format('insert into public.votes (slot_id, user_id, venue_id) values (%L, %L, ''a'')', slot_eat, host), '42501');
  perform pg_temp.as_user(host);
  perform pg_temp.expect_ok(128, 'the host votes too', format('insert into public.votes (slot_id, user_id, venue_id) values (%L, %L, ''b'')', slot_eat, host), 1);
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_count(129, 'a member reads everyone''s votes in the session', format('select count(*) from public.votes where slot_id = %L', slot_eat), 2);
  perform pg_temp.expect_ok(130, 'a member cannot delete another member''s vote: the row is not theirs, so nothing is touched',
    format('delete from public.votes where slot_id = %L and user_id = %L', slot_eat, host), 0);
  perform pg_temp.expect_ok(131, 'a member takes their own vote back', format('delete from public.votes where slot_id = %L and user_id = %L', slot_eat, g1), 1);
  perform pg_temp.expect_error(132, 'a member cannot make an option', format('insert into public.slot_options (slot_id, venue_id) values (%L, ''x'')', slot_eat), '42501');
  perform pg_temp.expect_error(133, 'cannot make a slot', format('insert into public.slots (session_id, category, start_minute, duration_minutes) values (%L, ''shop'', 900, 60)', sl), '42501');
  perform pg_temp.as_user(host);
  perform pg_temp.expect_error(134, 'the host cannot write the radius directly: it goes through the server',
    format('update public.sessions set radius_meters = 500 where id = %L', sl), '42501');
  perform pg_temp.expect_error(135, 'nor delete a slot', format('delete from public.slots where id = %L', slot_eat), '42501');
  perform pg_temp.as_admin();
  update public.session_members set state = 'opted_out' where session_id = sl and user_id = g1;
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_error(136, 'a member who has opted out cannot vote',
    format('insert into public.votes (slot_id, user_id, venue_id) values (%L, %L, ''a'')', slot_eat, g1), '42501');

  -- A change of who travels how long, with the same longest trip, total and count, is still a change: two people swapped their times.
  -- s3 is voting, pinned at Bugis (longest 11, total 20, two people); its members have no stored minutes yet.
  perform pg_temp.as_admin();
  update public.session_members set travel_minutes = 10 where session_id = s3 and user_id in (host, g1);
  p := jsonb_build_object('session', jsonb_build_object('meeting', jsonb_build_object('area_id', 'bugis', 'method', 'chosen',
    'max_minutes', 11, 'total_minutes', 20, 'count', 2, 'approximate', false, 'travel', jsonb_build_object(host::text, 10, g1::text, 10))));
  perform pg_temp.as_server();
  perform pg_temp.expect_text(137, 'the same figures and the same minutes change nothing',
    format('select pg_temp.apply(%L, 5, ''voting'', %L::jsonb)', s3, p::text), '5');
  p := jsonb_set(p, '{session,meeting,travel}', jsonb_build_object(host::text, 14, g1::text, 6));
  perform pg_temp.expect_text(138, 'the same figures but different minutes for the people are written, and raise the version',
    format('select pg_temp.apply(%L, 5, ''voting'', %L::jsonb)', s3, p::text), '6');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(139, 'each person has their own new minutes',
    format('select (select travel_minutes from public.session_members where session_id = %L and user_id = %L) || '' '' || (select travel_minutes from public.session_members where session_id = %L and user_id = %L)', s3, host, s3, g1), '14 6');

  -- ── A place's id may be up to 160 characters ─────────────────────────
  -- The 32 saved hawker centres have ids of 86 characters; a halal group is offered exactly those, so they must be options, votes and
  -- stops. sl is voting with slot_eat offering A and B; g1 opted out at step 136, so g1 comes back first.
  perform pg_temp.as_admin();
  update public.session_members set state = 'joined' where session_id = sl and user_id = g1;
  select plan_version into ver from public.sessions where id = sl;
  p := jsonb_build_object('slots', jsonb_build_array(jsonb_build_object('category', 'eat', 'options', jsonb_build_array(
        jsonb_build_object('venue_id', 'a', 'rank', 1, 'score', 5),
        jsonb_build_object('venue_id', 'b', 'rank', 2, 'score', 6),
        jsonb_build_object('venue_id', long_id, 'rank', 3, 'score', 7)))));
  perform pg_temp.as_server();
  perform pg_temp.expect_text(140, 'a place with an id of 120 characters becomes an option',
    format('select pg_temp.apply(%L, %s, ''voting'', %L::jsonb)', sl, ver, p::text), (ver + 1)::text);
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(141, 'it is stored whole',
    format('select max(char_length(venue_id))::text from public.slot_options where slot_id = %L', slot_eat), '120');
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_ok(142, 'a member votes for it', format('insert into public.votes (slot_id, user_id, venue_id) values (%L, %L, %L)', slot_eat, g1, long_id), 1);
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(143, 'the vote is for the whole id',
    format('select venue_id from public.votes where slot_id = %L and user_id = %L', slot_eat, g1), long_id);
  perform pg_temp.as_server();
  perform pg_temp.expect_text(144, 'a swap away from it is made in place',
    format('select pg_temp.apply(%L, %s, ''voting'', %L::jsonb)', sl, ver + 1,
           jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'swap_option', 'category', 'eat', 'from', long_id, 'to', 'zz')))::text), (ver + 2)::text);
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(145, 'and the vote followed it',
    format('select venue_id from public.votes where slot_id = %L and user_id = %L', slot_eat, g1), 'zz');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(146, 'a swap back to the long id is made in place too',
    format('select pg_temp.apply(%L, %s, ''voting'', %L::jsonb)', sl, ver + 2,
           jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'swap_option', 'category', 'eat', 'from', 'zz', 'to', long_id)))::text), (ver + 3)::text);
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(147, 'and the vote is on the long id again',
    format('select venue_id from public.votes where slot_id = %L and user_id = %L', slot_eat, g1), long_id);
  perform pg_temp.as_server();
  perform pg_temp.expect_error(148, 'an id of 161 characters is still not an option',
    format('select pg_temp.apply(%L, %s, ''voting'', %L::jsonb)', sl, ver + 3,
           jsonb_build_object('slots', jsonb_build_array(jsonb_build_object('category', 'eat', 'options',
             jsonb_build_array(jsonb_build_object('venue_id', repeat('y', 161), 'rank', 1)))))::text), '23514');
  perform pg_temp.as_admin();
  perform pg_temp.expect_ok(149, 'a stop may hold an id of 120 characters',
    format('insert into public.stops (session_id, seq, venue_id, planned_start_minute, duration_minutes) values (%L, 0, %L, 720, 90)', sl, long_id), 1);
  perform pg_temp.expect_error(150, 'but not 161',
    format('insert into public.stops (session_id, seq, venue_id, planned_start_minute, duration_minutes) values (%L, 1, %L, 720, 90)', sl, repeat('y', 161)), '23514');

  -- ── Smaller rules of the function ────────────────────────────────────
  -- A swap of a place for itself is not a swap. sl is voting at version ver + 3, and g1's vote is on the long id (step 147).
  perform pg_temp.as_server();
  perform pg_temp.expect_text(151, 'a swap of a place for itself changes nothing and does not raise the version',
    format('select pg_temp.apply(%L, %s, ''voting'', %L::jsonb)', sl, ver + 3,
           jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'swap_option', 'category', 'eat', 'from', long_id, 'to', long_id)))::text), (ver + 3)::text);
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(152, 'the option is still there, and so is the vote for it',
    format('select (select count(*) from public.slot_options where slot_id = %L and venue_id = %L) || '' '' || (select count(*) from public.votes where slot_id = %L and user_id = %L and venue_id = %L)',
           slot_eat, long_id, slot_eat, g1, long_id), '1 1');

  -- A part of the plan the function does not know is refused (22023), whatever else is in the plan.
  perform pg_temp.as_server();
  perform pg_temp.expect_error(153, 'a misspelt part of the plan is refused',
    format('select pg_temp.apply(%L, %s, ''voting'', %L)', sl, ver + 3, '{"slotz":[]}'), '22023', 'slotz');
  perform pg_temp.expect_error(154, 'a misspelt part of the session is refused',
    format('select pg_temp.apply(%L, %s, ''voting'', %L)', sl, ver + 3, '{"session":{"radius":1000}}'), '22023', 'radius');
  perform pg_temp.expect_error(155, 'a session that is not an object is refused',
    format('select pg_temp.apply(%L, %s, ''voting'', %L)', sl, ver + 3, '{"session":[]}'), '22023');
  perform pg_temp.expect_error(156, 'a misspelt part is refused even when the write is too late to be made',
    format('select pg_temp.apply(%L, 0, ''voting'', %L)', sl, '{"opz":[]}'), '22023', 'opz');
  perform pg_temp.expect_text(157, 'and a plan made only of the known parts passes the check (and, being late, answers null)',
    format('select pg_temp.apply(%L, 0, ''voting'', %L)', sl, '{"ops":[],"spots":[],"slots":[],"session":{},"loaded_at":null,"recomputed":false,"banner_text":null}'), 'null');

  -- A member's minutes are written only where they differ. s3 is voting at version 6 with minutes 14 (the host) and 6 (g1) from step 138.
  perform pg_temp.as_admin();
  select ctid::text into tid_host from public.session_members where session_id = s3 and user_id = host;
  select ctid::text into tid_g1 from public.session_members where session_id = s3 and user_id = g1;
  p := jsonb_build_object('session', jsonb_build_object(
    'banner', jsonb_build_object('text', 'The minutes were worked out again.'),
    'meeting', jsonb_build_object('area_id', 'bugis', 'method', 'chosen', 'max_minutes', 11, 'total_minutes', 20, 'count', 2, 'approximate', false,
      'travel', jsonb_build_object(host::text, 14, g1::text, 6))));
  perform pg_temp.as_server();
  perform pg_temp.expect_text(158, 'a new notice with the same minutes raises the version',
    format('select pg_temp.apply(%L, 6, ''voting'', %L::jsonb)', s3, p::text), '7');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(159, 'and neither member''s row was written again',
    format('select ((select ctid::text from public.session_members where session_id = %L and user_id = %L) = %L'
           || ' and (select ctid::text from public.session_members where session_id = %L and user_id = %L) = %L)::text', s3, host, tid_host, s3, g1, tid_g1), 'true');
  p := jsonb_set(p, '{session}', (p -> 'session') - 'banner');
  p := jsonb_set(p, '{session,meeting,travel}', jsonb_build_object(host::text, 14, g1::text, 9));
  perform pg_temp.as_server();
  perform pg_temp.expect_text(160, 'one changed minute is written',
    format('select pg_temp.apply(%L, 7, ''voting'', %L::jsonb)', s3, p::text), '8');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(161, 'to that member''s row only',
    format('select ((select ctid::text from public.session_members where session_id = %L and user_id = %L) = %L'
           || ' and (select ctid::text from public.session_members where session_id = %L and user_id = %L) <> %L)::text', s3, host, tid_host, s3, g1, tid_g1), 'true');
  perform pg_temp.expect_text(162, 'and the minutes are 14 and 9',
    format('select (select travel_minutes from public.session_members where session_id = %L and user_id = %L) || '' '' || (select travel_minutes from public.session_members where session_id = %L and user_id = %L)', s3, host, s3, g1), '14 9');

  -- The checks on a place's id are dropped by what they check, whatever they are called. Two old-style checks of 80 are put back under
  -- other names (not valid, so the rows of 120 characters above do not stop them), and the migration's statements run again.
  perform pg_temp.as_admin();
  perform pg_temp.expect_ok(163, 'a check of 80 under another name is put on the options',
    'alter table public.slot_options add constraint odd_name_for_a_limit check (char_length(venue_id) <= 80) not valid');
  perform pg_temp.expect_ok(164, 'and on the stops',
    'alter table public.stops add constraint another_odd_name check (char_length(venue_id) <= 80) not valid');
  perform pg_temp.expect_count(165, 'the options now have two checks on the id',
    'select count(*) from pg_constraint where contype = ''c'' and conrelid = ''public.slot_options''::regclass and pg_get_constraintdef(oid) like ''%venue_id%''', 2);
  perform pg_temp.expect_ok(166, 'the migration''s block drops every check that mentions the id', drop_checks);
  perform pg_temp.expect_count(167, 'none is left on the options',
    'select count(*) from pg_constraint where contype = ''c'' and conrelid = ''public.slot_options''::regclass and pg_get_constraintdef(oid) like ''%venue_id%''', 0);
  perform pg_temp.expect_count(168, 'none on the stops',
    'select count(*) from pg_constraint where contype = ''c'' and conrelid = ''public.stops''::regclass and pg_get_constraintdef(oid) like ''%venue_id%''', 0);
  perform pg_temp.expect_ok(169, 'the check of 160 is made again on the options',
    'alter table public.slot_options add constraint slot_options_venue_id_check check (char_length(venue_id) <= 160)');
  perform pg_temp.expect_ok(170, 'and on the stops',
    'alter table public.stops add constraint stops_venue_id_check check (char_length(venue_id) <= 160)');
  perform pg_temp.expect_text(171, 'each table has that one check on the id, and it is 160',
    'select (select string_agg(conname || (pg_get_constraintdef(oid) like ''%160%'')::text, '','') from pg_constraint where contype = ''c'' and conrelid = ''public.slot_options''::regclass and pg_get_constraintdef(oid) like ''%venue_id%'')'
    || ' || '' '' || (select string_agg(conname || (pg_get_constraintdef(oid) like ''%160%'')::text, '','') from pg_constraint where contype = ''c'' and conrelid = ''public.stops''::regclass and pg_get_constraintdef(oid) like ''%venue_id%'')',
    'slot_options_venue_id_checktrue stops_venue_id_checktrue');
  perform pg_temp.expect_error(172, 'and 161 is still refused',
    format('insert into public.stops (session_id, seq, venue_id, planned_start_minute, duration_minutes) values (%L, 2, %L, 720, 90)', sl, repeat('y', 161)), '23514');


  -- ── Stage 5: the plan (20261023000000_jio_apply_session_plan_stops.sql) ──────────────────────────────────────────────────────────
  -- sc is voting with two slots, the host, g1 and g2 joined, and g1 alone has voted. The confirm needs stops and two voters.
  perform pg_temp.as_admin();
  insert into public.sessions (id, host_id, title, date, start_time, end_time, status, plan_version, meeting_area_id, meeting_method,
                               meeting_max_minutes, meeting_total_minutes, meeting_count, meeting_approximate) values
    (sc, host, 'Plan', current_date + 1, '10:00', '20:00', 'voting', 3, 'bugis', 'fairest', 20, 40, 2, false),
    (sn, host, 'Order', current_date + 1, '10:00', '20:00', 'voting', 0, 'bugis', 'fairest', 20, 40, 2, false);
  insert into public.session_members (session_id, user_id, state) values (sc, g1, 'joined'), (sc, g2, 'joined'), (sn, g1, 'joined');
  insert into public.slots (session_id, category, start_minute, duration_minutes, picks, is_last) values
    (sc, 'eat', 720, 90, 3, false), (sc, 'drink', 840, 60, 3, true);
  select id into slot_c_eat from public.slots where session_id = sc and category = 'eat';
  select id into slot_c_drink from public.slots where session_id = sc and category = 'drink';
  insert into public.slot_options (slot_id, venue_id, rank, score) values
    (slot_c_eat, 'a', 1, 5), (slot_c_eat, 'b', 2, 6), (slot_c_drink, 'd', 1, 4), (slot_c_drink, 'e', 2, 5);
  insert into public.votes (slot_id, user_id, venue_id) values (slot_c_eat, g1, 'a');
  p := jsonb_build_object(
    'session', jsonb_build_object('status', 'confirmed', 'banner', null, 'plan_start_minute', 720,
      'order_note', jsonb_build_object('reason', 'Meals stay at mealtimes.', 'source', 'rules')),
    'stops', jsonb_build_array(
      jsonb_build_object('seq', 0, 'slot_id', slot_c_eat, 'category', 'eat', 'venue_id', 'a', 'planned_start_minute', 720,
                         'duration_minutes', 90, 'travel_mode', null, 'travel_minutes', null, 'not_before_minute', 720),
      jsonb_build_object('seq', 1, 'slot_id', slot_c_drink, 'category', 'drink', 'venue_id', 'd', 'planned_start_minute', 840,
                         'duration_minutes', 60, 'travel_mode', null, 'travel_minutes', 12, 'not_before_minute', null)));
  perform pg_temp.as_server();
  perform pg_temp.expect_hint(173, 'one voter is not enough to confirm',
    format('select pg_temp.apply(%L, 3, ''voting'', %L::jsonb)', sc, p::text), 'not_enough_votes');
  perform pg_temp.as_admin();
  insert into public.votes (slot_id, user_id, venue_id) values (slot_c_eat, host, 'a');
  perform pg_temp.as_server();
  perform pg_temp.expect_hint(174, 'a confirm without stops is refused',
    format('select pg_temp.apply(%L, 3, ''voting'', %L::jsonb)', sc, '{"session":{"status":"confirmed"}}'), 'stops_missing');
  perform pg_temp.expect_hint(175, 'a stop that is not one of the places the group voted among is refused',
    format('select pg_temp.apply(%L, 3, ''voting'', %L::jsonb)', sc,
           jsonb_build_object('session', jsonb_build_object('status', 'confirmed'), 'stops', jsonb_build_array(
             jsonb_build_object('seq', 0, 'slot_id', slot_c_eat, 'category', 'eat', 'venue_id', 'zzz', 'planned_start_minute', 720, 'duration_minutes', 90)))::text),
    'stop_not_option');
  perform pg_temp.expect_hint(176, 'a stop in a slot of another session is refused',
    format('select pg_temp.apply(%L, 3, ''voting'', %L::jsonb)', sc,
           jsonb_build_object('session', jsonb_build_object('status', 'confirmed'), 'stops', jsonb_build_array(
             jsonb_build_object('seq', 0, 'slot_id', slot_eat, 'category', 'eat', 'venue_id', 'a', 'planned_start_minute', 720, 'duration_minutes', 90)))::text),
    'stop_slot');
  perform pg_temp.expect_hint(177, 'stops are written only while the session is confirmed',
    format('select pg_temp.apply(%L, 3, ''voting'', %L::jsonb)', sc, jsonb_build_object('stops', p -> 'stops')::text), 'stops_status');
  perform pg_temp.expect_hint(178, 'voting cannot move to completed',
    format('select pg_temp.apply(%L, 3, ''voting'', %L::jsonb)', sc, '{"session":{"status":"completed"}}'), 'status_transition');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(179, 'and nothing was written by the refusals: still voting, no stops, version 3',
    format('select status || '' '' || (select count(*) from public.stops where session_id = %L) || '' '' || plan_version from public.sessions where id = %L', sc, sc), 'voting 0 3');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(180, 'the confirm is written and the version goes up',
    format('select pg_temp.apply(%L, 3, ''voting'', %L::jsonb)', sc, p::text), '4');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(181, 'the session is confirmed with its note, its start and no notice',
    format('select status || '' '' || plan_start_minute || '' '' || order_reason || '' '' || order_source || '' '' || coalesce(banner::text, ''no banner'') from public.sessions where id = %L', sc),
    'confirmed 720 Meals stay at mealtimes. rules no banner');
  perform pg_temp.expect_text(182, 'the stops are in order, with their earliest starts and minutes',
    format('select string_agg(seq || '':'' || venue_id || '':'' || planned_start_minute || '':'' || coalesce(not_before_minute::text, ''-'') || '':'' || coalesce(travel_minutes::text, ''-''), '','' order by seq) from public.stops where session_id = %L', sc),
    '0:a:720:720:-,1:d:840:-:12');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(183, 'the same confirm again is late (the session is confirmed now) and answers null',
    format('select pg_temp.apply(%L, 3, ''voting'', %L::jsonb)', sc, p::text), 'null');

  -- Stops are a difference: the same rows change nothing; a new order, a place twice, a gap and a full or empty list are refused.
  perform pg_temp.as_admin();
  select jsonb_agg(jsonb_build_object('id', id, 'seq', seq, 'slot_id', slot_id, 'category', category, 'venue_id', venue_id,
                                      'planned_start_minute', planned_start_minute, 'duration_minutes', duration_minutes, 'travel_mode', travel_mode,
                                      'travel_minutes', travel_minutes, 'not_before_minute', not_before_minute) order by seq)
    into stops_json from public.stops where session_id = sc;
  perform pg_temp.as_server();
  perform pg_temp.expect_text(184, 'the same stops again change nothing and do not raise the version',
    format('select pg_temp.apply(%L, 4, ''confirmed'', %L::jsonb)', sc, jsonb_build_object('stops', stops_json)::text), '4');
  select jsonb_agg(jsonb_set(e, '{seq}', to_jsonb(1 - (e ->> 'seq')::int)) order by ord) into stops_swapped from jsonb_array_elements(stops_json) with ordinality as t(e, ord);
  perform pg_temp.expect_text(185, 'the two stops swap places in one call, and clearing the note is a change',
    format('select pg_temp.apply(%L, 4, ''confirmed'', %L::jsonb)', sc,
           jsonb_build_object('stops', stops_swapped, 'session', jsonb_build_object('order_note', null))::text), '5');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(186, 'the drink is first now, and the note is gone',
    format('select (select string_agg(venue_id, '','' order by seq) from public.stops where session_id = %L) || '' '' || coalesce(order_reason || order_source, ''no note'') from public.sessions where id = %L', sc, sc),
    'd,a no note');
  perform pg_temp.as_server();
  perform pg_temp.expect_hint(187, 'two stops with one number are refused',
    format('select pg_temp.apply(%L, 5, ''confirmed'', %L::jsonb)', sc,
           jsonb_build_object('stops', (select jsonb_agg(jsonb_set(e, '{seq}', '0') order by ord) from jsonb_array_elements(stops_swapped) with ordinality as t(e, ord)))::text), 'stop_order');
  perform pg_temp.expect_hint(188, 'a gap in the numbers is refused',
    format('select pg_temp.apply(%L, 5, ''confirmed'', %L::jsonb)', sc,
           jsonb_build_object('stops', (select jsonb_agg(jsonb_set(e, '{seq}', to_jsonb(2 * (e ->> 'seq')::int)) order by ord) from jsonb_array_elements(stops_swapped) with ordinality as t(e, ord)))::text), 'stop_order');
  perform pg_temp.expect_hint(189, 'a place cannot be two stops',
    format('select pg_temp.apply(%L, 5, ''confirmed'', %L::jsonb)', sc,
           jsonb_build_object('stops', (select jsonb_agg(jsonb_set(e, '{venue_id}', '"a"') order by ord) from jsonb_array_elements(stops_swapped) with ordinality as t(e, ord)))::text), 'stop_duplicate');
  perform pg_temp.expect_hint(190, 'nine stops are too many',
    format('select pg_temp.apply(%L, 5, ''confirmed'', %L::jsonb)', sc,
           jsonb_build_object('stops', (select jsonb_agg(jsonb_build_object('seq', n, 'category', 'drink', 'venue_id', 'v' || n, 'planned_start_minute', 900, 'duration_minutes', 60)) from generate_series(0, 8) n))::text), 'too_many_stops');
  perform pg_temp.expect_hint(191, 'a confirmed plan keeps at least one stop',
    format('select pg_temp.apply(%L, 5, ''confirmed'', %L)', sc, '{"stops":[]}'), 'last_stop');
  perform pg_temp.expect_hint(192, 'a stop that is not in this session is refused',
    format('select pg_temp.apply(%L, 5, ''confirmed'', %L::jsonb)', sc,
           jsonb_build_object('stops', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'seq', 0, 'category', 'drink', 'venue_id', 'v', 'planned_start_minute', 900, 'duration_minutes', 60)))::text), 'stop_missing');
  perform pg_temp.expect_error(193, 'a note with a sentence and no source breaks the pair check',
    format('select pg_temp.apply(%L, 5, ''confirmed'', %L)', sc, '{"session":{"order_note":{"reason":"x"}}}'), '23514');
  perform pg_temp.expect_hint(194, 'a suggested order is stored only while voting',
    format('select pg_temp.apply(%L, 5, ''confirmed'', %L::jsonb)', sc,
           jsonb_build_object('session', jsonb_build_object('order_suggestion', jsonb_build_object('basis', repeat('a', 64), 'order', jsonb_build_array())))::text), 'order_status');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(195, 'none of those refusals wrote anything: version 5 and two stops',
    format('select plan_version || '' '' || (select count(*) from public.stops where session_id = %L) from public.sessions where id = %L', sc, sc), '5 2');

  -- A travel mode is one stop's: how the group gets to it from the stop before.
  perform pg_temp.as_server();
  perform pg_temp.expect_error(196, 'a travel mode that is not walk, mrt or car breaks the check',
    format('select pg_temp.apply(%L, 5, ''confirmed'', %L::jsonb)', sc,
           jsonb_build_object('stops', (select jsonb_agg(jsonb_set(e, '{travel_mode}', '"bike"') order by ord) from jsonb_array_elements(stops_swapped) with ordinality as t(e, ord)))::text), '23514');
  perform pg_temp.expect_text(197, 'a travel mode is written, and raises the version',
    format('select pg_temp.apply(%L, 5, ''confirmed'', %L::jsonb)', sc,
           jsonb_build_object('stops', (select jsonb_agg(case when e ->> 'venue_id' = 'a' then jsonb_set(e, '{travel_mode}', '"car"') else e end order by ord) from jsonb_array_elements(stops_swapped) with ordinality as t(e, ord)))::text), '6');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(198, 'it is on the stop that is arrived at, and the other stop has none',
    format('select string_agg(venue_id || coalesce(travel_mode, ''-''), '','' order by seq) from public.stops where session_id = %L', sc), 'd-,acar');

  -- A stop's place is changed in place: the stop, the slot's options and the votes for the old place move together.
  select jsonb_agg(jsonb_build_object('id', id, 'seq', seq, 'slot_id', slot_id, 'category', category,
                                      'venue_id', case when venue_id = 'a' then 'b' else venue_id end,
                                      'planned_start_minute', planned_start_minute, 'duration_minutes', duration_minutes, 'travel_mode', travel_mode,
                                      'travel_minutes', travel_minutes, 'not_before_minute', case when venue_id = 'a' then 735 else not_before_minute end) order by seq)
    into stops_json from public.stops where session_id = sc;
  p := jsonb_build_object('stops', stops_json, 'stop_options', jsonb_build_array(
    jsonb_build_object('slot_id', slot_c_eat, 'venue_id', 'b', 'rank', 2, 'score', 6, 'details', jsonb_build_object('note', 'kept'), 'replaces', 'a')));
  perform pg_temp.as_server();
  perform pg_temp.expect_text(199, 'a stop is changed to another place with the old place leaving the options',
    format('select pg_temp.apply(%L, 6, ''confirmed'', %L::jsonb)', sc, p::text), '7');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(200, 'the options are b alone, the votes for a went with it, and the stop holds b from 12:15',
    format('select (select string_agg(venue_id, '','' order by venue_id) from public.slot_options where slot_id = %L) || '' '''
           || ' || (select count(*) from public.votes where slot_id = %L) || '' '' || (select venue_id || not_before_minute from public.stops where session_id = %L and slot_id = %L)',
           slot_c_eat, slot_c_eat, sc, slot_c_eat), 'b 0 b735');
  perform pg_temp.expect_text(201, 'the new place keeps what the planner said about it',
    format('select details ->> ''note'' from public.slot_options where slot_id = %L and venue_id = ''b''', slot_c_eat), 'kept');
  perform pg_temp.as_server();
  perform pg_temp.expect_hint(202, 'a stop option in another session''s slot is refused',
    format('select pg_temp.apply(%L, 7, ''confirmed'', %L::jsonb)', sc,
           jsonb_build_object('stop_options', jsonb_build_array(jsonb_build_object('slot_id', slot_eat, 'venue_id', 'b')))::text), 'stop_slot');

  -- Roam proposals: a joined member proposes, the host answers, and the limits are kept under the lock.
  perform pg_temp.as_admin();
  select plan_version into ver5 from public.sessions where id = sc;
  proposal_p1 := gen_random_uuid();
  perform pg_temp.as_server();
  perform pg_temp.expect_text(203, 'a joined member proposes a place, with the id the server chose for it',
    format('select pg_temp.apply(%L, %s, ''confirmed'', %L::jsonb)', sc, ver5, jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'propose', 'id', proposal_p1, 'user_id', g2, 'venue_id', 'p1')))::text), (ver5 + 1)::text);
  perform pg_temp.expect_text(204, 'the same place again changes nothing and does not raise the version',
    format('select pg_temp.apply(%L, %s, ''confirmed'', %L::jsonb)', sc, ver5 + 1, jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'propose', 'user_id', g1, 'venue_id', 'p1')))::text), (ver5 + 1)::text);
  perform pg_temp.expect_hint(205, 'a place that is already a stop cannot be proposed',
    format('select pg_temp.apply(%L, %s, ''confirmed'', %L::jsonb)', sc, ver5 + 1, jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'propose', 'user_id', g1, 'venue_id', 'b')))::text), 'already_a_stop');
  perform pg_temp.expect_hint(206, 'somebody who is not in the session cannot propose',
    format('select pg_temp.apply(%L, %s, ''confirmed'', %L::jsonb)', sc, ver5 + 1, jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'propose', 'user_id', stranger, 'venue_id', 'p9')))::text), 'proposal_member');
  perform pg_temp.expect_text(207, 'two more from one member in one call',
    format('select pg_temp.apply(%L, %s, ''confirmed'', %L::jsonb)', sc, ver5 + 1,
           jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'propose', 'user_id', g2, 'venue_id', 'p2'), jsonb_build_object('op', 'propose', 'user_id', g2, 'venue_id', 'p3')))::text), (ver5 + 2)::text);
  perform pg_temp.expect_hint(208, 'a fourth waiting for one member is refused',
    format('select pg_temp.apply(%L, %s, ''confirmed'', %L::jsonb)', sc, ver5 + 2, jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'propose', 'user_id', g2, 'venue_id', 'p4')))::text), 'too_many_proposals');
  perform pg_temp.as_admin();
  perform pg_temp.expect_count(209, 'three are waiting', format('select count(*) from public.stop_proposals where session_id = %L and status = ''pending''', sc), 3);
  select jsonb_agg(jsonb_build_object('id', id, 'seq', seq, 'slot_id', slot_id, 'category', category, 'venue_id', venue_id,
                                      'planned_start_minute', planned_start_minute, 'duration_minutes', duration_minutes, 'travel_mode', travel_mode,
                                      'travel_minutes', travel_minutes, 'not_before_minute', not_before_minute) order by seq)
    into stops_json from public.stops where session_id = sc;
  p := jsonb_build_object(
    'ops', jsonb_build_array(jsonb_build_object('op', 'resolve_proposal', 'proposal_id', proposal_p1, 'status', 'accepted', 'by', host)),
    'stops', stops_json || jsonb_build_array(jsonb_build_object('seq', 2, 'category', 'drink', 'venue_id', 'p1', 'planned_start_minute', 1000, 'duration_minutes', 60, 'not_before_minute', 1000)));
  perform pg_temp.as_server();
  perform pg_temp.expect_text(210, 'the host accepts one: the proposal is answered and the stop is added in the same write',
    format('select pg_temp.apply(%L, %s, ''confirmed'', %L::jsonb)', sc, ver5 + 2, p::text), (ver5 + 3)::text);
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(211, 'the proposal is accepted by the host, and the new stop has no slot',
    format('select status || '' '' || (resolved_by = %L)::text || '' '' || (select count(*) from public.stops where session_id = %L and slot_id is null) from public.stop_proposals where id = %L', host, sc, proposal_p1),
    'accepted true 1');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(212, 'answering it again changes nothing',
    format('select pg_temp.apply(%L, %s, ''confirmed'', %L::jsonb)', sc, ver5 + 3,
           jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'resolve_proposal', 'proposal_id', proposal_p1, 'status', 'dismissed', 'by', host)))::text), (ver5 + 3)::text);
  perform pg_temp.expect_hint(213, 'a place is proposed only while the plan is confirmed',
    format('select pg_temp.apply(%L, 0, ''voting'', %L::jsonb)', sn, jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'propose', 'user_id', g1, 'venue_id', 'p1')))::text), 'proposal_status');
  perform pg_temp.as_admin();
  select jsonb_agg(jsonb_build_object('id', id, 'seq', seq, 'slot_id', slot_id, 'category', category, 'venue_id', venue_id,
                                      'planned_start_minute', planned_start_minute, 'duration_minutes', duration_minutes, 'travel_mode', travel_mode,
                                      'travel_minutes', travel_minutes, 'not_before_minute', not_before_minute) order by seq)
    into stops_json from public.stops where session_id = sc;
  perform pg_temp.as_server();
  perform pg_temp.expect_text(214, 'five more stops fill the plan to eight',
    format('select pg_temp.apply(%L, %s, ''confirmed'', %L::jsonb)', sc, ver5 + 3,
           jsonb_build_object('stops', stops_json || (select jsonb_agg(jsonb_build_object('seq', n, 'category', 'drink', 'venue_id', 'q' || n, 'planned_start_minute', 1100, 'duration_minutes', 30)) from generate_series(3, 7) n))::text), (ver5 + 4)::text);
  perform pg_temp.expect_hint(215, 'and a full plan takes no more proposals',
    format('select pg_temp.apply(%L, %s, ''confirmed'', %L::jsonb)', sc, ver5 + 4, jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'propose', 'user_id', g1, 'venue_id', 'p9')))::text), 'plan_full');

  -- The ledger comes with the move to completed, and only then.
  p := jsonb_build_object('session', jsonb_build_object('status', 'completed'), 'ledger', jsonb_build_array(
    jsonb_build_object('user_id', host, 'minutes_in', 20, 'minutes_between', 10, 'minutes_home', 30, 'delta_from_mean', -10),
    jsonb_build_object('user_id', g1, 'minutes_in', 50, 'minutes_between', 10, 'minutes_home', 30, 'delta_from_mean', 20),
    jsonb_build_object('user_id', g2, 'minutes_in', 30, 'minutes_between', 10, 'minutes_home', 20, 'delta_from_mean', -10)));
  perform pg_temp.expect_hint(216, 'a ledger without the move to completed is refused',
    format('select pg_temp.apply(%L, %s, ''confirmed'', %L::jsonb)', sc, ver5 + 4, jsonb_build_object('ledger', p -> 'ledger')::text), 'ledger_status');
  perform pg_temp.expect_hint(217, 'deltas that do not sum to zero are refused',
    format('select pg_temp.apply(%L, %s, ''confirmed'', %L::jsonb)', sc, ver5 + 4, jsonb_set(p, '{ledger,2,delta_from_mean}', '-9')::text), 'ledger_sum');
  perform pg_temp.expect_hint(218, 'a ledger row for somebody who is not a joined member is refused',
    format('select pg_temp.apply(%L, %s, ''confirmed'', %L::jsonb)', sc, ver5 + 4,
           jsonb_build_object('session', jsonb_build_object('status', 'completed'), 'ledger', jsonb_build_array(jsonb_build_object('user_id', stranger, 'minutes_in', 1, 'minutes_home', 1, 'delta_from_mean', 0)))::text), 'ledger_member');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(219, 'and those refusals wrote nothing: still confirmed, no ledger',
    format('select status || '' '' || (select count(*) from public.commute_ledger where session_id = %L) from public.sessions where id = %L', sc, sc), 'confirmed 0');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(220, 'finishing writes the ledger and the status together',
    format('select pg_temp.apply(%L, %s, ''confirmed'', %L::jsonb)', sc, ver5 + 4, p::text), (ver5 + 5)::text);
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(221, 'the outing is completed, with its time, and no prompt',
    format('select status || '' '' || (completed_at is not null)::text || '' '' || coalesce(replan::text, ''no prompt'') from public.sessions where id = %L', sc), 'completed true no prompt');
  perform pg_temp.expect_text(222, 'the ledger holds each person''s own minutes, and the total is worked out by the database',
    format('select string_agg(minutes_in || ''+'' || minutes_between || ''+'' || minutes_home || ''='' || total_minutes, '','' order by minutes_in) from public.commute_ledger where session_id = %L', sc),
    '20+10+30=60,30+10+20=60,50+10+30=90');
  perform pg_temp.expect_text(223, 'the deltas sum to zero',
    format('select sum(delta_from_mean)::text from public.commute_ledger where session_id = %L', sc), '0');
  perform pg_temp.expect_count(224, 'the proposals still waiting were dismissed', format('select count(*) from public.stop_proposals where session_id = %L and status = ''dismissed''', sc), 2);
  perform pg_temp.as_server();
  perform pg_temp.expect_text(225, 'a retry of the finish is late and answers null',
    format('select pg_temp.apply(%L, %s, ''confirmed'', %L::jsonb)', sc, ver5 + 4, p::text), 'null');
  perform pg_temp.expect_hint(226, 'a finished outing never moves again',
    format('select pg_temp.apply(%L, %s, ''completed'', %L)', sc, ver5 + 5, '{"session":{"status":"voting"}}'), 'status_transition');
  perform pg_temp.as_admin();
  perform pg_temp.expect_count(227, 'and the ledger is as it was', format('select count(*) from public.commute_ledger where session_id = %L', sc), 3);

  -- A ledger row that is already there stays (a retry that got further than the first try changes nothing). sx is confirmed with the host and g1.
  insert into public.sessions (id, host_id, title, date, start_time, end_time, status, plan_version) values (sx, host, 'Earlier', current_date, '10:00', '20:00', 'confirmed', 4);
  insert into public.session_members (session_id, user_id, state) values (sx, g1, 'joined');
  insert into public.commute_ledger (session_id, user_id, minutes_in, minutes_between, minutes_home, delta_from_mean) values (sx, host, 5, 0, 5, 7);
  perform pg_temp.as_server();
  perform pg_temp.expect_text(228, 'a ledger row that is already stored is kept and the others are made',
    format('select pg_temp.apply(%L, 4, ''confirmed'', %L::jsonb)', sx,
           jsonb_build_object('session', jsonb_build_object('status', 'completed'), 'ledger', jsonb_build_array(
             jsonb_build_object('user_id', host, 'minutes_in', 99, 'minutes_home', 99, 'delta_from_mean', 5),
             jsonb_build_object('user_id', g1, 'minutes_in', 10, 'minutes_home', 10, 'delta_from_mean', -5)))::text), '5');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(229, 'the stored row of the host is as it was, and g1''s was made',
    format('select string_agg((user_id = %L::uuid)::text || '':'' || total_minutes, '','' order by total_minutes) from public.commute_ledger where session_id = %L', host, sx), 'true:10,false:20');

  -- Travel debt: the sum of a person's deltas in their other sessions in the last 90 days, for the server only.
  perform pg_temp.expect_text(230, 'only the server may ask for the travel debt',
    'select (has_function_privilege(''service_role'', ''public.session_travel_debt(uuid)'', ''execute'')'
    || ' and not has_function_privilege(''authenticated'', ''public.session_travel_debt(uuid)'', ''execute'')'
    || ' and not has_function_privilege(''anon'', ''public.session_travel_debt(uuid)'', ''execute''))::text', 'true');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(231, 'g1 travelled more than the others in the sessions before sn: 20 and -5 are 15, the host -10 and 7 are -3',
    format('select string_agg((user_id = %L::uuid)::text || '':'' || debt_minutes, '','' order by debt_minutes) from public.session_travel_debt(%L)', g1, sn), 'false:-3,true:15');

  -- What a member of the session may read, and what no browser may write.
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_count(232, 'a member reads the session''s ledger rows (minutes only, no place)', format('select count(*) from public.commute_ledger where session_id = %L', sc), 3);
  perform pg_temp.expect_count(233, 'and its proposals', format('select count(*) from public.stop_proposals where session_id = %L', sc), 3);
  perform pg_temp.expect_count(234, 'and its stops', format('select count(*) from public.stops where session_id = %L', sc), 8);
  perform pg_temp.as_user(stranger);
  perform pg_temp.expect_count(235, 'a stranger reads none of it', format('select (select count(*) from public.commute_ledger where session_id = %L) + (select count(*) from public.stop_proposals where session_id = %L) + (select count(*) from public.stops where session_id = %L)', sc, sc, sc), 0);
  perform pg_temp.as_user(host);
  perform pg_temp.expect_error(236, 'the host cannot write a stop directly',
    format('insert into public.stops (session_id, seq, venue_id, planned_start_minute, duration_minutes) values (%L, 20, ''x'', 600, 30)', sc), '42501');
  perform pg_temp.expect_error(237, 'nor change one', format('update public.stops set venue_id = ''x'' where session_id = %L', sc), '42501');
  perform pg_temp.expect_error(238, 'nor write the ledger', format('insert into public.commute_ledger (session_id, user_id) values (%L, %L)', sn, host), '42501');
  perform pg_temp.expect_error(239, 'nor a proposal', format('insert into public.stop_proposals (session_id, venue_id, proposed_by) values (%L, ''x'', %L)', sc, host), '42501');
  perform pg_temp.expect_error(240, 'nor the suggested order of the session', format('update public.sessions set order_suggestion = %L where id = %L', '{"basis":"x"}', sn), '42501');
  perform pg_temp.expect_error(241, 'nor the plan''s start', format('update public.sessions set plan_start_minute = 600 where id = %L', sn), '42501');

  -- The suggested order is stored while voting, kept as it is when sent again, and shaped by the table's own check.
  perform pg_temp.as_server();
  p := jsonb_build_object('session', jsonb_build_object('order_suggestion', jsonb_build_object('basis', repeat('b', 64),
    'order', jsonb_build_array(slot_c_drink, slot_c_eat), 'starts', jsonb_build_object(slot_c_drink::text, 700, slot_c_eat::text, 720),
    'reason', 'Drinks first keeps lunch on time.', 'source', 'rules', 'at', 1)));
  perform pg_temp.expect_text(242, 'a suggested order is stored while voting',
    format('select pg_temp.apply(%L, 0, ''voting'', %L::jsonb)', sn, p::text), '1');
  perform pg_temp.expect_text(243, 'sent again it changes nothing',
    format('select pg_temp.apply(%L, 1, ''voting'', %L::jsonb)', sn, p::text), '1');
  perform pg_temp.expect_error(244, 'a basis that is not 64 hex characters breaks the shape check',
    format('select pg_temp.apply(%L, 1, ''voting'', %L)', sn, '{"session":{"order_suggestion":{"basis":"nope","order":[]}}}'), '23514');
  perform pg_temp.expect_hint(245, 'the order note is written only while confirmed',
    format('select pg_temp.apply(%L, 1, ''voting'', %L)', sn, '{"session":{"order_note":{"reason":"x","source":"ai"}}}'), 'stops_status');
  perform pg_temp.expect_text(246, 'clearing the suggestion is a change',
    format('select pg_temp.apply(%L, 1, ''voting'', %L)', sn, '{"session":{"order_suggestion":null}}'), '2');
  perform pg_temp.expect_error(247, 'a part of the plan that is misspelt is still refused',
    format('select pg_temp.apply(%L, 2, ''voting'', %L)', sn, '{"stopz":[]}'), '22023', 'stopz');
  perform pg_temp.expect_error(248, 'and so is a part of the session',
    format('select pg_temp.apply(%L, 2, ''voting'', %L)', sn, '{"session":{"order_reasons":"x"}}'), '22023', 'order_reasons');

  -- Opening the plan again. sr is confirmed, pinned at Bugis, with two stops, a note, a suggestion, a start, a prompt, a proposal and two votes.
  perform pg_temp.as_admin();
  insert into public.sessions (id, host_id, title, date, start_time, end_time, status, plan_version, meeting_area_id, meeting_method,
                               meeting_max_minutes, meeting_total_minutes, meeting_count, meeting_approximate, order_reason, order_source,
                               order_suggestion, plan_start_minute, replan) values
    (sr, host, 'Again', current_date + 1, '10:00', '20:00', 'confirmed', 10, 'bugis', 'chosen', 20, 40, 2, false, 'Meals stay at mealtimes.', 'rules',
     jsonb_build_object('basis', repeat('c', 64), 'order', jsonb_build_array()), 720, jsonb_build_object('reason', 'start'));
  insert into public.session_members (session_id, user_id, state) values (sr, g1, 'joined');
  insert into public.slots (session_id, category, start_minute, duration_minutes, picks, is_last) values (sr, 'eat', 720, 90, 2, false), (sr, 'drink', 840, 60, 2, true);
  select id into slot_r_eat from public.slots where session_id = sr and category = 'eat';
  select id into slot_r_drink from public.slots where session_id = sr and category = 'drink';
  insert into public.slot_options (slot_id, venue_id, rank, score) values (slot_r_eat, 'a', 1, 5), (slot_r_drink, 'd', 1, 4);
  insert into public.votes (slot_id, user_id, venue_id) values (slot_r_eat, host, 'a'), (slot_r_eat, g1, 'a');
  insert into public.stops (session_id, seq, slot_id, category, venue_id, planned_start_minute, duration_minutes) values
    (sr, 0, slot_r_eat, 'eat', 'a', 720, 90), (sr, 1, slot_r_drink, 'drink', 'd', 840, 60);
  insert into public.stop_proposals (session_id, venue_id, proposed_by) values (sr, 'p1', g1);
  perform pg_temp.as_server();
  perform pg_temp.expect_hint(249, 'votes are not cleared in a confirmed session that stays confirmed',
    format('select pg_temp.apply(%L, 10, ''confirmed'', %L)', sr, '{"ops":[{"op":"clear_votes"}]}'), 'slots_status');
  perform pg_temp.expect_hint(250, 'slots are not written in a confirmed session that stays confirmed',
    format('select pg_temp.apply(%L, 10, ''confirmed'', %L)', sr, '{"slots":[]}'), 'slots_status');
  perform pg_temp.as_admin();
  select jsonb_agg(jsonb_build_object('id', id, 'seq', seq, 'slot_id', slot_id, 'category', category, 'venue_id', venue_id,
                                      'planned_start_minute', planned_start_minute, 'duration_minutes', duration_minutes, 'travel_mode', travel_mode,
                                      'travel_minutes', travel_minutes, 'not_before_minute', not_before_minute) order by seq)
    into stops_json from public.stops where session_id = sr and seq = 0;
  perform pg_temp.as_server();
  perform pg_temp.expect_text(251, 'a stop that is not listed goes',
    format('select pg_temp.apply(%L, 10, ''confirmed'', %L::jsonb)', sr, jsonb_build_object('stops', stops_json)::text), '11');
  perform pg_temp.as_admin();
  perform pg_temp.expect_count(252, 'one stop is left, the first', format('select count(*) from public.stops where session_id = %L and venue_id = ''a''', sr), 1);
  perform pg_temp.as_server();
  perform pg_temp.expect_hint(253, 'a list whose numbers do not start at 0 is refused',
    format('select pg_temp.apply(%L, 11, ''confirmed'', %L::jsonb)', sr, jsonb_build_object('stops', (select jsonb_agg(jsonb_set(e, '{seq}', '1')) from jsonb_array_elements(stops_json) e))::text), 'stop_order');
  perform pg_temp.expect_text(254, 'the plan is opened again with the votes cleared, in one write',
    format('select pg_temp.apply(%L, 11, ''confirmed'', %L)', sr, '{"session":{"status":"voting","banner":null},"ops":[{"op":"clear_votes"}]}'), '12');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(255, 'it is voting, with no stops, no note, no suggestion, no start and no prompt',
    format('select status || '' '' || (select count(*) from public.stops where session_id = %L) || '' '' || coalesce(order_reason, ''-'') || '' '' || coalesce(order_suggestion::text, ''-'')'
           || ' || '' '' || coalesce(plan_start_minute::text, ''-'') || '' '' || coalesce(replan::text, ''-'') from public.sessions where id = %L', sr, sr),
    'voting 0 - - - -');
  perform pg_temp.expect_text(256, 'the proposal was dismissed, the votes were cleared, and the options stay',
    format('select (select status from public.stop_proposals where session_id = %L) || '' '' || (select count(*) from public.votes where slot_id in (%L, %L)) || '' '''
           || ' || (select count(*) from public.slot_options where slot_id in (%L, %L))', sr, slot_r_eat, slot_r_drink, slot_r_eat, slot_r_drink),
    'dismissed 0 2');
  perform pg_temp.as_server();
  perform pg_temp.expect_hint(257, 'a voting session cannot be confirmed again without stops',
    format('select pg_temp.apply(%L, 12, ''voting'', %L)', sr, '{"session":{"status":"confirmed"}}'), 'stops_missing');

  -- A guest opts out of a confirmed plan (the server's E10 in the confirmed status). In one patch: the person goes out with their votes, the
  -- proposal they had waiting is dismissed (by them), and the one thing written to the session is the "Re-plan?" prompt. The stops stay.
  -- so is confirmed with the host, g1 and g2; g1 and g2 each have a proposal waiting.
  perform pg_temp.as_admin();
  insert into public.sessions (id, host_id, title, date, start_time, end_time, status, plan_version, meeting_area_id, meeting_method,
                               meeting_max_minutes, meeting_total_minutes, meeting_count, meeting_approximate) values
    (so, host, 'Opt out', current_date + 1, '10:00', '20:00', 'confirmed', 20, 'bugis', 'chosen', 20, 40, 2, false);
  insert into public.session_members (session_id, user_id, state) values (so, g1, 'joined'), (so, g2, 'joined');
  insert into public.slots (session_id, category, start_minute, duration_minutes, picks, is_last) values (so, 'eat', 720, 90, 2, false), (so, 'drink', 840, 60, 2, true);
  select id into slot_r_eat from public.slots where session_id = so and category = 'eat';
  select id into slot_r_drink from public.slots where session_id = so and category = 'drink';
  insert into public.slot_options (slot_id, venue_id, rank, score) values (slot_r_eat, 'a', 1, 5), (slot_r_drink, 'd', 1, 4);
  insert into public.votes (slot_id, user_id, venue_id) values
    (slot_r_eat, host, 'a'), (slot_r_eat, g1, 'a'), (slot_r_eat, g2, 'a'), (slot_r_drink, g1, 'd');
  insert into public.stops (session_id, seq, slot_id, category, venue_id, planned_start_minute, duration_minutes) values
    (so, 0, slot_r_eat, 'eat', 'a', 720, 90), (so, 1, slot_r_drink, 'drink', 'd', 840, 60);
  insert into public.stop_proposals (session_id, venue_id, proposed_by) values (so, 'p1', g1), (so, 'p2', g2);
  select id into proposal_p1 from public.stop_proposals where session_id = so and proposed_by = g1;
  perform pg_temp.as_server();
  p := jsonb_build_object(
    'ops', jsonb_build_array(jsonb_build_object('op', 'opt_out', 'user_id', g1),
                             jsonb_build_object('op', 'resolve_proposal', 'proposal_id', proposal_p1, 'status', 'dismissed', 'by', g1)),
    'session', jsonb_build_object('replan', jsonb_build_object('reason', 'Faith opted out. The meeting area would stay at Bugis.',
                                                                'trigger', jsonb_build_object('kind', 'optout'), 'at', 1)));
  perform pg_temp.expect_text(258, 'a guest opts out of a confirmed plan: the person, their proposal and the prompt are one write',
    format('select pg_temp.apply(%L, 20, ''confirmed'', %L::jsonb)', so, p::text), '21');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(259, 'g1 is out and their vote is gone; the other votes stand',
    format('select (select state from public.session_members where session_id = %L and user_id = %L) || '' '' || (select count(*) from public.votes where slot_id in (%L, %L))', so, g1, slot_r_eat, slot_r_drink),
    'opted_out 2');
  perform pg_temp.expect_text(260, 'g1''s proposal was dismissed by g1, and g2''s still waits',
    format('select string_agg((proposed_by = %L::uuid)::text || '':'' || status || '':'' || coalesce((resolved_by = %L::uuid)::text, ''-''), '','' order by status) from public.stop_proposals where session_id = %L', g1, g1, so),
    'true:dismissed:true,false:pending:-');
  perform pg_temp.expect_text(261, 'the plan is as it was: confirmed, with its two stops',
    format('select status || '' '' || (select count(*) from public.stops where session_id = %L) from public.sessions where id = %L', so, so), 'confirmed 2');
  perform pg_temp.expect_text(262, 'the prompt is stored on the session, readable by the members',
    format('select (replan ->> ''reason'') || '' / '' || ((replan -> ''trigger'') ->> ''kind'') from public.sessions where id = %L', so),
    'Faith opted out. The meeting area would stay at Bugis. / optout');
  perform pg_temp.as_user(g2);
  perform pg_temp.expect_text(263, 'a member of the session reads the prompt',
    format('select replan ->> ''reason'' from public.sessions where id = %L', so), 'Faith opted out. The meeting area would stay at Bugis.');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(264, 'sending the same prompt again changes nothing',
    format('select pg_temp.apply(%L, 21, ''confirmed'', %L::jsonb)', so, jsonb_build_object('session', p -> 'session')::text), '21');
  perform pg_temp.expect_error(265, 'a prompt that is not an object is refused',
    format('select pg_temp.apply(%L, 21, ''confirmed'', %L)', so, '{"session":{"replan":"Faith left"}}'), '22023', 'JSON object or null');
  perform pg_temp.expect_text(266, 'a second guest going out replaces the prompt',
    format('select pg_temp.apply(%L, 21, ''confirmed'', %L::jsonb)', so,
           jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'opt_out', 'user_id', g2)),
                              'session', jsonb_build_object('replan', jsonb_build_object('reason', 'Someone opted out.', 'trigger', jsonb_build_object('kind', 'optout'), 'at', 2)))::text), '22');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(267, 'the prompt is the newer one',
    format('select replan ->> ''reason'' from public.sessions where id = %L', so), 'Someone opted out.');
  perform pg_temp.as_server();
  perform pg_temp.expect_text(268, 'the host keeps the plan: the prompt goes and the status stays',
    format('select pg_temp.apply(%L, 22, ''confirmed'', %L)', so, '{"session":{"replan":null}}'), '23');
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(269, 'no prompt, still confirmed',
    format('select status || '' '' || coalesce(replan::text, ''no prompt'') from public.sessions where id = %L', so), 'confirmed no prompt');

  raise notice 'ALL STEPS PASSED';
end;
$test$;

-- Nothing is kept: the users, sessions, spots, suggestions and approvals above are all discarded here.
rollback;
