-- Access test for meeting spots, approvals, Roam proposals and the suggested order.
-- Covers db/migrations/20261011000000_jio_session_spots.sql, or a fresh build of db/schema.sql and
-- db/policies.sql.
--
-- How to run: after the migration (or a fresh build), run this whole file as ONE batch, in the SQL editor
-- or with   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/session_spots_access.sql
-- It runs as the project's owner role ("postgres"), makes throwaway users and sessions, acts as each of
-- them (set role + the JWT claims, the way Supabase does for a request), and ends with a rollback, so no
-- rows are left whether it passes or fails. A passing step prints a notice "ok step N". A broken rule
-- raises an exception "FAIL step N: ..." and stops the run (with the rollback that follows).
--
-- Expected error codes: 42501 = permission denied or row-level security refusal, 23503 = foreign key,
-- 23505 = unique, 23514 = check constraint.

begin;

-- Helpers. They live in pg_temp, so they vanish with the session and the rollback.

-- Run one statement as the current role. Returns the error code (null on success) and the rows touched.
--   select * from pg_temp.try('delete from public.votes');
create function pg_temp.try(stmt text, out code text, out n bigint)
language plpgsql as $$
begin
  execute stmt;
  get diagnostics n = row_count;
  code := null;
exception when others then
  code := sqlstate;
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

-- The statement must fail with this error code.
--   select pg_temp.expect_error(7, 'a member cannot insert a spot', 'insert into ...', '42501');
create function pg_temp.expect_error(step int, what text, stmt text, want text) returns void language plpgsql as $$
declare r record;
begin
  select * into r from pg_temp.try(stmt);
  if r.code is distinct from want then
    raise exception 'FAIL step %: % (wanted error %, got %)', step, what, want, coalesce(r.code, 'success');
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
    raise exception 'FAIL step %: % (wanted success, got error %)', step, what, r.code;
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

do $test$
declare
  host uuid := gen_random_uuid();      -- hosts sessions s and s3
  g1 uuid := gen_random_uuid();        -- a joined guest, who suggests Orchard
  g2 uuid := gen_random_uuid();        -- a joined guest
  quitter uuid := gen_random_uuid();   -- opted out of s and s3
  stranger uuid := gen_random_uuid();  -- belongs to no session
  other_host uuid := gen_random_uuid();-- hosts s2, a different session
  s uuid := gen_random_uuid();         -- locating, with three spots
  s2 uuid := gen_random_uuid();        -- locating, somebody else's, with one spot
  s3 uuid := gen_random_uuid();        -- confirmed, with a pending proposal and a stop
  st text;
  u uuid;
begin
  -- ── Setup, as the project owner ─────────────────────────────────────
  foreach u in array array[host, g1, g2, quitter, stranger, other_host] loop
    -- The sign-up trigger makes the profile from the username and date of birth.
    insert into auth.users (id, aud, role, email, raw_user_meta_data)
    values (u, 'authenticated', 'authenticated', u || '@example.test',
            jsonb_build_object('username', 't' || substr(md5(u::text), 1, 12), 'dob', '2000-01-01'));
  end loop;

  insert into public.sessions (id, host_id, title, date, start_time, end_time, status) values
    (s, host, 'Spots test', current_date + 1, '10:00', '20:00', 'locating'),
    (s2, other_host, 'Somebody else', current_date + 1, '10:00', '20:00', 'locating'),
    (s3, host, 'Confirmed test', current_date + 1, '10:00', '20:00', 'confirmed');
  -- The host joined each session through a trigger. Add the others.
  insert into public.session_members (session_id, user_id, state) values
    (s, g1, 'joined'), (s, g2, 'joined'), (s, quitter, 'opted_out'),
    (s3, g1, 'joined'), (s3, quitter, 'opted_out');

  insert into public.session_spots (session_id, area_id, suggested_by, here, seq, worst_minutes, mean_minutes, approximate) values
    (s, 'bishan', null, false, 0, 30, 25, false),
    (s, 'bugis', null, false, 1, 32, 26, false),
    (s, 'orchard', g1, true, 2, 35, 28, true),
    (s2, 'bishan', null, false, 0, 20, 15, false);
  -- Three people's minutes to each of the three spots.
  insert into public.session_spot_times (session_id, area_id, user_id, minutes)
  select s, a, m, 10 + length(a) + length(m::text) % 7
  from unnest(array['bishan', 'bugis', 'orchard']) as a, unnest(array[host, g1, g2]) as m;
  insert into public.spot_approvals (session_id, area_id, user_id) values
    (s, 'bishan', g2), (s, 'bugis', host);
  insert into public.stop_proposals (session_id, venue_id, proposed_by) values (s3, 'venue_a', g1);
  insert into public.stops (session_id, seq, venue_id, planned_start_minute, duration_minutes)
  values (s3, 0, 'venue_stop', 600, 60);

  -- ── Reading ─────────────────────────────────────────────────────────
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_count(1, 'a joined member reads the spots, and only their session''s',
    'select count(*) from public.session_spots', 3);
  perform pg_temp.expect_count(2, 'a joined member reads the travel times',
    'select count(*) from public.session_spot_times', 9);
  perform pg_temp.expect_count(3, 'a joined member reads the approvals',
    'select count(*) from public.spot_approvals', 2);
  perform pg_temp.expect_count(4, 'a joined member reads the proposals',
    'select count(*) from public.stop_proposals', 1);

  perform pg_temp.as_user(host);
  perform pg_temp.expect_count(5, 'the host reads spots, times, approvals and proposals',
    'select (select count(*) from public.session_spots) + (select count(*) from public.session_spot_times)'
    || ' + (select count(*) from public.spot_approvals) + (select count(*) from public.stop_proposals)', 15);

  perform pg_temp.as_user(stranger);
  perform pg_temp.expect_count(6, 'someone in no session reads nothing in any of the four tables',
    'select (select count(*) from public.session_spots) + (select count(*) from public.session_spot_times)'
    || ' + (select count(*) from public.spot_approvals) + (select count(*) from public.stop_proposals)', 0);

  perform pg_temp.as_user(other_host);
  perform pg_temp.expect_count(7, 'a member of another session reads nothing of this one',
    format('select count(*) from public.session_spots where session_id = %L', s), 0);
  perform pg_temp.expect_count(8, 'a member of another session reads no approvals, times or proposals of this one',
    format('select (select count(*) from public.session_spot_times where session_id = %L)'
           || ' + (select count(*) from public.spot_approvals where session_id = %L)'
           || ' + (select count(*) from public.stop_proposals where session_id = %L)', s, s, s3), 0);

  perform pg_temp.as_user(quitter);
  perform pg_temp.expect_count(9, 'an opted-out member reads no spots, times or approvals',
    'select (select count(*) from public.session_spots) + (select count(*) from public.session_spot_times)'
    || ' + (select count(*) from public.spot_approvals)', 0);
  perform pg_temp.expect_count(10, 'an opted-out member reads no proposals',
    'select count(*) from public.stop_proposals', 0);

  perform pg_temp.as_anon();
  perform pg_temp.expect_error(11, 'a logged-out visitor cannot read spots', 'select count(*) from public.session_spots', '42501');
  perform pg_temp.expect_error(12, 'a logged-out visitor cannot read approvals', 'select count(*) from public.spot_approvals', '42501');
  perform pg_temp.expect_error(13, 'a logged-out visitor cannot read proposals', 'select count(*) from public.stop_proposals', '42501');
  perform pg_temp.expect_error(14, 'a logged-out visitor cannot read travel times', 'select count(*) from public.session_spot_times', '42501');

  -- ── The list of spots is the server's ───────────────────────────────
  perform pg_temp.as_user(g2);
  perform pg_temp.expect_error(15, 'a member with no suggestion yet cannot insert one',
    format('insert into public.session_spots (session_id, area_id, suggested_by, seq, worst_minutes, mean_minutes) values (%L, ''tampines'', %L, 3, 20, 15)', s, g2), '42501');
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_error(16, 'a member cannot update a spot, even their own suggestion',
    format('update public.session_spots set here = false where session_id = %L and area_id = ''orchard''', s), '42501');
  perform pg_temp.expect_error(17, 'a member cannot delete a spot, even their own suggestion',
    format('delete from public.session_spots where session_id = %L and area_id = ''orchard''', s), '42501');
  perform pg_temp.expect_error(18, 'a member cannot insert a travel time',
    format('insert into public.session_spot_times (session_id, area_id, user_id, minutes) values (%L, ''bishan'', %L, 1)', s, g1), '42501');
  perform pg_temp.expect_error(19, 'a member cannot change a travel time',
    format('update public.session_spot_times set minutes = 1 where session_id = %L', s), '42501');
  perform pg_temp.expect_error(20, 'a member cannot delete a travel time',
    format('delete from public.session_spot_times where session_id = %L', s), '42501');
  perform pg_temp.as_user(host);
  perform pg_temp.expect_error(21, 'the host cannot insert a spot either',
    format('insert into public.session_spots (session_id, area_id, seq, worst_minutes, mean_minutes) values (%L, ''tampines'', 3, 20, 15)', s), '42501');
  perform pg_temp.expect_error(22, 'the host cannot delete a spot either',
    format('delete from public.session_spots where session_id = %L', s), '42501');
  perform pg_temp.as_admin();
  perform pg_temp.expect_count(23, 'all three spots are still there after the refused writes',
    format('select count(*) from public.session_spots where session_id = %L', s), 3);

  -- ── Works for me ────────────────────────────────────────────────────
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_ok(24, 'a member approves a listed spot while locating',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bugis'', %L)', s, g1), 1);
  perform pg_temp.expect_ok(25, 'a member approves a second spot (any number is allowed)',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''orchard'', %L)', s, g1), 1);
  perform pg_temp.expect_error(26, 'approving the same spot twice is refused',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bugis'', %L)', s, g1), '23505');
  perform pg_temp.expect_ok(27, 'a member takes back their own approval',
    format('delete from public.spot_approvals where session_id = %L and area_id = ''bugis'' and user_id = %L', s, g1), 1);
  perform pg_temp.expect_error(28, 'a member cannot approve for someone else',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bugis'', %L)', s, g2), '42501');
  perform pg_temp.expect_ok(29, 'a member cannot delete someone else''s approval (no row matches)',
    format('delete from public.spot_approvals where session_id = %L and user_id = %L', s, g2), 0);
  perform pg_temp.expect_error(30, 'a member cannot approve an area that is not listed',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''tampines'', %L)', s, g1), '23503');
  perform pg_temp.expect_error(31, 'a member cannot approve a spot of a session they are not in',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bishan'', %L)', s2, g1), '42501');
  perform pg_temp.expect_error(32, 'an approval cannot be changed in place (no update right)',
    format('update public.spot_approvals set area_id = ''bishan'' where session_id = %L and user_id = %L', s, g1), '42501');
  perform pg_temp.as_user(quitter);
  perform pg_temp.expect_error(33, 'an opted-out member cannot approve',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bishan'', %L)', s, quitter), '42501');
  perform pg_temp.as_user(stranger);
  perform pg_temp.expect_error(34, 'someone outside the session cannot approve',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bishan'', %L)', s, stranger), '42501');
  perform pg_temp.as_anon();
  perform pg_temp.expect_error(35, 'a logged-out visitor cannot approve',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bishan'', %L)', s, g1), '42501');

  -- Not locating: the member has an approval of bishan, then the session moves through every other status.
  perform pg_temp.as_admin();
  insert into public.spot_approvals (session_id, area_id, user_id) values (s, 'bishan', g1);
  foreach st in array array['inviting', 'voting', 'confirmed', 'completed', 'cancelled'] loop
    perform pg_temp.as_admin();
    update public.sessions set status = st where id = s;
    perform pg_temp.as_user(g1);
    perform pg_temp.expect_error(36, format('a member cannot approve a spot once the session is %s (steps 36 and 37 repeat for each status)', st),
      format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bugis'', %L)', s, g1), '42501');
    perform pg_temp.expect_ok(37, format('a member cannot take back an approval once the session is %s (no row matches)', st),
      format('delete from public.spot_approvals where session_id = %L and area_id = ''bishan'' and user_id = %L', s, g1), 0);
  end loop;
  perform pg_temp.as_admin();
  update public.sessions set status = 'locating' where id = s;
  perform pg_temp.expect_count(38, 'the approval survived every refused delete',
    format('select count(*) from public.spot_approvals where session_id = %L and area_id = ''bishan'' and user_id = %L', s, g1), 1);

  -- ── The server, and what the keys enforce ───────────────────────────
  perform pg_temp.as_server();
  perform pg_temp.expect_ok(39, 'the server inserts a spot', format(
    'insert into public.session_spots (session_id, area_id, suggested_by, seq, worst_minutes, mean_minutes) values (%L, ''tampines'', null, 3, 40, 30)', s), 1);
  perform pg_temp.expect_ok(40, 'the server inserts a travel time', format(
    'insert into public.session_spot_times (session_id, area_id, user_id, minutes) values (%L, ''tampines'', %L, 40)', s, host), 1);
  perform pg_temp.expect_ok(41, 'the server updates a spot', format(
    'update public.session_spots set worst_minutes = 41, here = true where session_id = %L and area_id = ''tampines''', s), 1);
  perform pg_temp.expect_ok(42, 'the server reorders spots in one statement (the order is checked at the end)', format(
    'update public.session_spots set seq = 3 - seq where session_id = %L and seq <= 3', s), 4);
  perform pg_temp.expect_error(43, 'two spots cannot share a place in the order', format(
    'update public.session_spots set seq = 0 where session_id = %L and area_id = ''bugis''; set constraints all immediate', s), '23505');
  perform pg_temp.expect_error(44, 'the average trip cannot exceed the longest', format(
    'update public.session_spots set mean_minutes = 99 where session_id = %L and area_id = ''bishan''', s), '23514');
  perform pg_temp.expect_error(45, 'a spot''s area id has a length limit', format(
    'insert into public.session_spots (session_id, area_id, seq, worst_minutes, mean_minutes) values (%L, %L, 9, 1, 1)', s, repeat('x', 61)), '23514');
  perform pg_temp.expect_error(46, 'a suggestion must come from a member of the session', format(
    'insert into public.session_spots (session_id, area_id, suggested_by, seq, worst_minutes, mean_minutes) values (%L, ''jurong'', %L, 9, 1, 1)', s, stranger), '23503');
  perform pg_temp.expect_error(47, 'a member has one suggestion at a time', format(
    'insert into public.session_spots (session_id, area_id, suggested_by, seq, worst_minutes, mean_minutes) values (%L, ''jurong'', %L, 9, 1, 1)', s, g1), '23505');
  perform pg_temp.expect_error(48, 'a travel time must belong to a member of the session', format(
    'insert into public.session_spot_times (session_id, area_id, user_id, minutes) values (%L, ''bishan'', %L, 5)', s, stranger), '23503');
  perform pg_temp.expect_error(49, 'a travel time must belong to a listed spot', format(
    'insert into public.session_spot_times (session_id, area_id, user_id, minutes) values (%L, ''jurong'', %L, 5)', s, host), '23503');

  -- Deleting a spot takes its approvals and travel times with it; other spots keep theirs.
  perform pg_temp.as_admin();
  perform pg_temp.expect_count(50, 'before: bishan has approvals and travel times', format(
    'select (select count(*) from public.spot_approvals where session_id = %L and area_id = ''bishan'')'
    || ' + (select count(*) from public.session_spot_times where session_id = %L and area_id = ''bishan'')', s, s), 5);
  perform pg_temp.as_server();
  perform pg_temp.expect_ok(51, 'the server drops the bishan spot', format(
    'delete from public.session_spots where session_id = %L and area_id = ''bishan''', s), 1);
  perform pg_temp.as_admin();
  perform pg_temp.expect_count(52, 'dropping a spot removed its approvals and travel times', format(
    'select (select count(*) from public.spot_approvals where session_id = %L and area_id = ''bishan'')'
    || ' + (select count(*) from public.session_spot_times where session_id = %L and area_id = ''bishan'')', s, s), 0);
  perform pg_temp.expect_count(53, 'the other spots kept their approvals (bugis by the host, orchard by g1)', format(
    'select count(*) from public.spot_approvals where session_id = %L', s), 2);

  -- A member who leaves the session (their account or membership row is deleted) takes their suggestion,
  -- its approvals and their travel times with them.
  delete from public.session_members where session_id = s and user_id = g1;
  perform pg_temp.expect_count(54, 'removing a member removed their suggestion, and the approvals on it', format(
    'select (select count(*) from public.session_spots where session_id = %L and area_id = ''orchard'')'
    || ' + (select count(*) from public.spot_approvals where session_id = %L and area_id = ''orchard'')', s, s), 0);
  perform pg_temp.expect_count(55, 'removing a member removed their travel times', format(
    'select count(*) from public.session_spot_times where session_id = %L and user_id = %L', s, g1), 0);

  -- ── The meeting columns and the suggested order ─────────────────────
  perform pg_temp.as_server();
  perform pg_temp.expect_ok(56, 'meeting_method accepts voted', format('update public.sessions set meeting_method = ''voted'' where id = %L', s), 1);
  perform pg_temp.expect_ok(57, 'meeting_method accepts chosen', format('update public.sessions set meeting_method = ''chosen'' where id = %L', s), 1);
  perform pg_temp.expect_ok(58, 'meeting_method still accepts same', format('update public.sessions set meeting_method = ''same'' where id = %L', s), 1);
  perform pg_temp.expect_ok(59, 'meeting_method still accepts null', format('update public.sessions set meeting_method = null where id = %L', s), 1);
  perform pg_temp.expect_error(60, 'meeting_method refuses any other value', format('update public.sessions set meeting_method = ''majority'' where id = %L', s), '23514');

  perform pg_temp.expect_ok(61, 'the server sets the order note', format(
    'update public.sessions set order_reason = ''Lunch first, then the shops open.'', order_source = ''ai'' where id = %L', s), 1);
  perform pg_temp.expect_ok(62, 'the server clears the order note', format(
    'update public.sessions set order_reason = null, order_source = null where id = %L', s), 1);
  perform pg_temp.expect_error(63, 'the order note refuses a reason of 201 characters', format(
    'update public.sessions set order_reason = %L, order_source = ''ai'' where id = %L', repeat('x', 201), s), '23514');
  perform pg_temp.expect_ok(64, 'the order note accepts a reason of 200 characters', format(
    'update public.sessions set order_reason = %L, order_source = ''rules'' where id = %L', repeat('x', 200), s), 1);
  perform pg_temp.expect_error(65, 'the order note refuses another source', format(
    'update public.sessions set order_source = ''guess'' where id = %L', s), '23514');
  perform pg_temp.expect_error(66, 'the order note comes as a pair: a source alone is refused', format(
    'update public.sessions set order_reason = null where id = %L', s), '23514');

  perform pg_temp.expect_ok(67, 'the server sets a stop''s earliest start', format(
    'update public.stops set earliest_start_minute = 0 where session_id = %L', s3), 1);
  perform pg_temp.expect_ok(68, 'an earliest start of 1439 is accepted', format(
    'update public.stops set earliest_start_minute = 1439 where session_id = %L', s3), 1);
  perform pg_temp.expect_error(69, 'an earliest start of 1440 is refused', format(
    'update public.stops set earliest_start_minute = 1440 where session_id = %L', s3), '23514');
  perform pg_temp.expect_error(70, 'a negative earliest start is refused', format(
    'update public.stops set earliest_start_minute = -1 where session_id = %L', s3), '23514');
  perform pg_temp.expect_ok(71, 'a stop may have no earliest start', format(
    'update public.stops set earliest_start_minute = null where session_id = %L', s3), 1);

  -- A browser: the host may rename their session (the control), and nothing else on it is theirs.
  perform pg_temp.as_user(host);
  perform pg_temp.expect_ok(72, 'control: the host can still rename the session', format(
    'update public.sessions set title = ''Renamed'' where id = %L', s), 1);
  perform pg_temp.expect_error(73, 'a browser cannot set meeting_method', format(
    'update public.sessions set meeting_method = ''voted'' where id = %L', s), '42501');
  perform pg_temp.expect_error(74, 'a browser cannot set the meeting area', format(
    'update public.sessions set meeting_area_id = ''bugis'' where id = %L', s), '42501');
  perform pg_temp.expect_error(75, 'a browser cannot set the meeting figures', format(
    'update public.sessions set meeting_max_minutes = 1, meeting_total_minutes = 1, meeting_count = 1, meeting_approximate = false where id = %L', s), '42501');
  perform pg_temp.expect_error(76, 'a browser cannot set the order note', format(
    'update public.sessions set order_reason = ''x'', order_source = ''ai'' where id = %L', s), '42501');
  perform pg_temp.expect_error(77, 'a browser cannot clear the order note', format(
    'update public.sessions set order_reason = null, order_source = null where id = %L', s), '42501');
  perform pg_temp.expect_error(78, 'a browser cannot create a session with a meeting method', format(
    'insert into public.sessions (host_id, title, date, start_time, end_time, meeting_method) values (%L, ''x'', current_date, ''10:00'', ''11:00'', ''chosen'')', host), '42501');
  perform pg_temp.expect_error(79, 'a browser cannot create a session with an order note', format(
    'insert into public.sessions (host_id, title, date, start_time, end_time, order_reason, order_source) values (%L, ''x'', current_date, ''10:00'', ''11:00'', ''x'', ''ai'')', host), '42501');
  perform pg_temp.expect_error(80, 'guard_session_changes still refuses locating to voting from a browser', format(
    'update public.sessions set status = ''voting'' where id = %L', s), '42501');
  perform pg_temp.expect_error(81, 'a browser cannot set a stop''s earliest start', format(
    'update public.stops set earliest_start_minute = 600 where session_id = %L', s3), '42501');
  perform pg_temp.expect_error(82, 'a browser cannot insert a stop', format(
    'insert into public.stops (session_id, seq, venue_id, planned_start_minute, duration_minutes, earliest_start_minute) values (%L, 5, ''v'', 600, 60, 600)', s3), '42501');

  -- ── Roam proposals: written by the server only ──────────────────────
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_error(83, 'a member cannot insert a proposal, even while the session is confirmed', format(
    'insert into public.stop_proposals (session_id, venue_id, proposed_by) values (%L, ''venue_b'', %L)', s3, g1), '42501');
  perform pg_temp.expect_error(84, 'a member cannot withdraw their own proposal', format(
    'delete from public.stop_proposals where session_id = %L', s3), '42501');
  perform pg_temp.expect_error(85, 'a member cannot resolve a proposal', format(
    'update public.stop_proposals set resolution = ''accepted'', resolved_at = now(), resolved_by = %L where session_id = %L', g1, s3), '42501');
  perform pg_temp.as_user(host);
  perform pg_temp.expect_error(86, 'the host cannot resolve a proposal directly either: the server does it', format(
    'update public.stop_proposals set resolution = ''accepted'', resolved_at = now(), resolved_by = %L where session_id = %L', host, s3), '42501');
  perform pg_temp.expect_error(87, 'the host cannot insert a proposal directly either', format(
    'insert into public.stop_proposals (session_id, venue_id, proposed_by) values (%L, ''venue_b'', %L)', s3, host), '42501');

  perform pg_temp.as_server();
  perform pg_temp.expect_ok(88, 'the server inserts a proposal', format(
    'insert into public.stop_proposals (session_id, venue_id, proposed_by) values (%L, ''venue_b'', %L)', s3, host), 1);
  perform pg_temp.expect_error(89, 'the same venue cannot wait twice', format(
    'insert into public.stop_proposals (session_id, venue_id, proposed_by) values (%L, ''venue_a'', %L)', s3, host), '23505');
  perform pg_temp.expect_error(90, 'a proposal must come from a member of the session', format(
    'insert into public.stop_proposals (session_id, venue_id, proposed_by) values (%L, ''venue_c'', %L)', s3, stranger), '23503');
  perform pg_temp.expect_error(91, 'a venue id has a length limit', format(
    'insert into public.stop_proposals (session_id, venue_id, proposed_by) values (%L, %L, %L)', s3, repeat('v', 81), host), '23514');
  perform pg_temp.expect_error(92, 'a resolution needs a time', format(
    'update public.stop_proposals set resolution = ''accepted'' where session_id = %L and venue_id = ''venue_a''', s3), '23514');
  perform pg_temp.expect_error(93, 'a time needs a resolution', format(
    'update public.stop_proposals set resolved_at = now() where session_id = %L and venue_id = ''venue_a''', s3), '23514');
  perform pg_temp.expect_error(94, 'a resolution is accepted or dismissed', format(
    'update public.stop_proposals set resolution = ''maybe'', resolved_at = now() where session_id = %L and venue_id = ''venue_a''', s3), '23514');
  perform pg_temp.expect_ok(95, 'the server accepts a proposal', format(
    'update public.stop_proposals set resolution = ''accepted'', resolved_at = now(), resolved_by = %L where session_id = %L and venue_id = ''venue_a''', host, s3), 1);
  perform pg_temp.expect_ok(96, 'the server dismisses a proposal', format(
    'update public.stop_proposals set resolution = ''dismissed'', resolved_at = now(), resolved_by = %L where session_id = %L and venue_id = ''venue_b''', host, s3), 1);
  perform pg_temp.expect_ok(97, 'a resolved venue can be proposed again', format(
    'insert into public.stop_proposals (session_id, venue_id, proposed_by) values (%L, ''venue_a'', %L)', s3, g1), 1);

  perform pg_temp.as_user(g1);
  perform pg_temp.expect_count(98, 'a member reads resolved and pending proposals', format(
    'select count(*) from public.stop_proposals where session_id = %L', s3), 3);
  perform pg_temp.as_user(quitter);
  perform pg_temp.expect_count(99, 'an opted-out member still reads no proposals', format(
    'select count(*) from public.stop_proposals where session_id = %L', s3), 0);

  -- ── Functions and live updates ──────────────────────────────────────
  perform pg_temp.as_anon();
  perform pg_temp.expect_error(100, 'a logged-out visitor cannot call my_joined_session_ids',
    'select count(*) from public.my_joined_session_ids()', '42501');
  perform pg_temp.expect_error(101, 'a logged-out visitor cannot call my_locating_session_ids',
    'select count(*) from public.my_locating_session_ids()', '42501');
  perform pg_temp.as_user(g2);
  perform pg_temp.expect_count(102, 'my_joined_session_ids answers only about the caller (g2 is in one session)',
    'select count(*) from public.my_joined_session_ids()', 1);
  perform pg_temp.expect_count(103, 'my_locating_session_ids lists the caller''s locating session',
    'select count(*) from public.my_locating_session_ids()', 1);

  perform pg_temp.as_admin();
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    perform pg_temp.expect_count(104, 'the four new tables are in the live-updates publication',
      'select count(*) from pg_publication_tables where pubname = ''supabase_realtime'' and schemaname = ''public'''
      || ' and tablename in (''session_spots'', ''session_spot_times'', ''spot_approvals'', ''stop_proposals'')', 4);
  else
    raise notice 'skip step 104: no supabase_realtime publication on this database';
  end if;

  raise notice 'ALL STEPS PASSED';
end;
$test$;

-- Nothing is kept: the users, sessions, spots, approvals and proposals above are all discarded here.
rollback;
