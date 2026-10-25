-- Access test for how the host picks the meeting point: the one new column, sessions.meet_by, and the rule in
-- guard_session_changes() that says who may write it and when.
-- Covers db/migrations/20261026000000_jio_session_meet_by.sql, or a fresh build of db/schema.sql and db/policies.sql.
--
-- How to run: after the migration (or a fresh build), run this whole file as ONE batch, in the SQL editor
-- or with   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/session_meet_by_access.sql
-- It runs as the project's owner role ("postgres"), makes throwaway users and sessions, acts as each of
-- them (set role + the JWT claims, the way Supabase does for a request), and ends with a rollback, so no
-- rows are left whether it passes or fails. A passing step prints a notice "ok step N". A broken rule
-- raises an exception "FAIL step N: ..." and stops the run (with the rollback that follows).
--
-- Expected error codes: 42501 = permission denied or row-level security refusal, 23514 = check constraint.
-- A refusal by the row-level policy is not an error: the update touches no row, so those steps want 0 rows.

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

do $test$
declare
  host uuid := gen_random_uuid();        -- hosts every session below
  g1 uuid := gen_random_uuid();          -- a joined guest of every session
  invitee uuid := gen_random_uuid();     -- invited to s_start by username, has not accepted
  stranger uuid := gen_random_uuid();    -- belongs to nothing
  s_start uuid := gen_random_uuid();     -- inviting, two joined: can start
  s_alone uuid := gen_random_uuid();     -- inviting, only the host
  s_old uuid := gen_random_uuid();       -- inviting, started the way the app did before this column
  s_loc uuid := gen_random_uuid();       -- locating, meet_by null (started before the column)
  s_vote uuid := gen_random_uuid();      -- voting, meet_by 'fairest'
  s_done uuid := gen_random_uuid();      -- cancelled
  u uuid;
begin
  -- ── Setup, as the project owner ─────────────────────────────────────
  foreach u in array array[host, g1, invitee, stranger] loop
    perform pg_temp.new_user(u);
  end loop;
  insert into public.sessions (id, host_id, title, date, start_time, end_time, status) values
    (s_start, host, 'Start test', current_date + 1, '10:00', '20:00', 'inviting'),
    (s_alone, host, 'Alone test', current_date + 1, '10:00', '20:00', 'inviting'),
    (s_old, host, 'Old start test', current_date + 1, '10:00', '20:00', 'inviting'),
    (s_loc, host, 'Locating test', current_date + 1, '10:00', '20:00', 'locating'),
    (s_vote, host, 'Voting test', current_date + 1, '10:00', '20:00', 'voting'),
    (s_done, host, 'Cancelled test', current_date + 1, '10:00', '20:00', 'cancelled');
  update public.sessions set meet_by = 'fairest' where id = s_vote;
  insert into public.session_members (session_id, user_id, state) values
    (s_start, g1, 'joined'), (s_old, g1, 'joined'), (s_loc, g1, 'joined'), (s_vote, g1, 'joined'), (s_done, g1, 'joined');
  insert into public.invites (session_id, created_by, invitee_id) values (s_start, host, invitee);

  -- ── The column ─────────────────────────────────────────────────────
  perform pg_temp.expect_text(1, 'a session made without a choice has a null meet_by',
    format('select coalesce(meet_by, ''null'') from public.sessions where id = %L', s_start), 'null');
  perform pg_temp.as_user(host);
  perform pg_temp.expect_error(2, 'a value other than fairest or known is refused by the check',
    format('update public.sessions set status = ''locating'', meet_by = ''sometimes'' where id = %L', s_start), '23514');
  perform pg_temp.expect_error(3, 'the host cannot make a session with meet_by already set (no insert grant)',
    format('insert into public.sessions (host_id, title, date, start_time, end_time, meet_by) values (%L, ''x'', current_date + 1, ''10:00'', ''11:00'', ''known'')', host), '42501');

  -- ── Setting it as the session starts ───────────────────────────────
  perform pg_temp.expect_error(4, 'the host cannot set it while the session is only inviting',
    format('update public.sessions set meet_by = ''known'' where id = %L', s_start), '42501');
  perform pg_temp.expect_error(5, 'a start with a choice still needs two joined people',
    format('update public.sessions set status = ''locating'', meet_by = ''fairest'' where id = %L', s_alone), '42501');
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_ok(6, 'a guest''s attempt to start with a choice touches no row (only the host updates a session)',
    format('update public.sessions set status = ''locating'', meet_by = ''known'' where id = %L', s_start), 0);
  perform pg_temp.as_user(stranger);
  perform pg_temp.expect_ok(7, 'a stranger''s attempt touches no row either',
    format('update public.sessions set meet_by = ''known'' where id = %L', s_loc), 0);
  perform pg_temp.as_anon();
  perform pg_temp.expect_error(8, 'a logged-out visitor has no update on meet_by',
    format('update public.sessions set meet_by = ''known'' where id = %L', s_loc), '42501');
  perform pg_temp.as_user(host);
  perform pg_temp.expect_ok(9, 'the host starts the session and says "we already know where" in one update',
    format('update public.sessions set status = ''locating'', meet_by = ''known'' where id = %L', s_start), 1);
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_text(10, 'a guest reads the host''s choice',
    format('select meet_by from public.sessions where id = %L', s_start), 'known');
  perform pg_temp.as_user(invitee);
  perform pg_temp.expect_count(11, 'someone invited by username who has not accepted reads no session',
    'select count(*) from public.sessions', 0);
  perform pg_temp.as_user(host);
  perform pg_temp.expect_ok(12, 'a start that does not name a choice leaves it null, as an older client does',
    format('update public.sessions set status = ''locating'' where id = %L', s_old), 1);
  perform pg_temp.expect_text(13, 'and it reads as null',
    format('select coalesce(meet_by, ''null'') from public.sessions where id = %L', s_old), 'null');

  -- ── Changing it while locating ─────────────────────────────────────
  perform pg_temp.expect_ok(14, 'the host sets it on a session that started without one (fairest to known is the "We already have a place" case)',
    format('update public.sessions set meet_by = ''known'' where id = %L', s_loc), 1);
  perform pg_temp.expect_ok(15, 'and may change their mind while the session is locating',
    format('update public.sessions set meet_by = ''fairest'' where id = %L', s_loc), 1);
  perform pg_temp.expect_ok(16, 'writing the same value again is fine',
    format('update public.sessions set meet_by = ''fairest'' where id = %L', s_loc), 1);
  perform pg_temp.expect_error(17, 'the host cannot clear it',
    format('update public.sessions set meet_by = null where id = %L', s_loc), '42501');
  perform pg_temp.expect_error(18, 'the host cannot change it while cancelling in the same update',
    format('update public.sessions set status = ''cancelled'', meet_by = ''known'' where id = %L', s_loc), '42501');
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_ok(19, 'a guest cannot change it while locating (no row is touched)',
    format('update public.sessions set meet_by = ''known'' where id = %L', s_loc), 0);
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(20, 'so it is still what the host set',
    format('select meet_by from public.sessions where id = %L', s_loc), 'fairest');

  -- ── After locating it is closed to a browser ───────────────────────
  perform pg_temp.as_user(host);
  perform pg_temp.expect_error(21, 'the host cannot change it once the session is voting',
    format('update public.sessions set meet_by = ''known'' where id = %L', s_vote), '42501');
  perform pg_temp.expect_ok(22, 'but the rest of a voting session still updates as before (a rename)',
    format('update public.sessions set title = ''Renamed'' where id = %L', s_vote), 1);
  perform pg_temp.expect_error(23, 'a cancelled session cannot be changed at all',
    format('update public.sessions set meet_by = ''known'' where id = %L', s_done), '42501');
  perform pg_temp.expect_error(24, 'the planner''s own column is still the server''s (meeting_method is not granted)',
    format('update public.sessions set meeting_method = ''chosen'' where id = %L', s_loc), '42501');
  perform pg_temp.expect_error(25, 'status moves other than the start are still refused with a choice attached',
    format('update public.sessions set status = ''voting'', meet_by = ''known'' where id = %L', s_loc), '42501');

  -- ── The server ─────────────────────────────────────────────────────
  perform pg_temp.as_server();
  perform pg_temp.expect_ok(26, 'the server may write it in any state (it is let through, as for every column)',
    format('update public.sessions set meet_by = ''known'' where id = %L', s_vote), 1);
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(27, 'and it is stored',
    format('select meet_by from public.sessions where id = %L', s_vote), 'known');

  raise notice 'ALL STEPS PASSED';
end;
$test$;

-- Nothing is kept: the users and sessions above are all discarded here.
rollback;
