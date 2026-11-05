-- Access test for slice c: voting. The one new column, slots.details, and a check that the voting rules
-- (votes) are untouched by the slices before it.
-- Covers db/migrations/20261011000200_jio_slot_details.sql, or a fresh build of db/schema.sql and db/policies.sql.
--
-- How to run: after the migration (or a fresh build), run this whole file as ONE batch, in the SQL editor
-- or with   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/slot_details_access.sql
-- It runs as the project's owner role ("postgres"), makes throwaway users and sessions, acts as each of
-- them (set role + the JWT claims, the way Supabase does for a request), and ends with a rollback, so no
-- rows are left whether it passes or fails. A passing step prints a notice "ok step N". A broken rule
-- raises an exception "FAIL step N: ..." and stops the run (with the rollback that follows).
--
-- Expected error codes: 42501 = permission denied or row-level security refusal, 23514 = check constraint.

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
  host uuid := gen_random_uuid();        -- hosts s (voting) and s_loc (locating)
  g1 uuid := gen_random_uuid();          -- a joined guest of both
  quitter uuid := gen_random_uuid();     -- opted out of s
  invitee uuid := gen_random_uuid();     -- invited to s by username, has not accepted
  stranger uuid := gen_random_uuid();    -- belongs to nothing
  s uuid := gen_random_uuid();           -- voting, with one slot and two options
  s_loc uuid := gen_random_uuid();       -- locating, with a slot of its own and a spot
  slot_s uuid := gen_random_uuid();
  slot_gone uuid := gen_random_uuid();   -- a removed slot in s
  slot_loc uuid := gen_random_uuid();
  u uuid;
begin
  -- ── Setup, as the project owner ─────────────────────────────────────
  foreach u in array array[host, g1, quitter, invitee, stranger] loop
    perform pg_temp.new_user(u);
  end loop;
  insert into public.sessions (id, host_id, title, date, start_time, end_time, status) values
    (s, host, 'Voting test', current_date + 1, '10:00', '20:00', 'voting'),
    (s_loc, host, 'Locating test', current_date + 1, '10:00', '20:00', 'locating');
  insert into public.session_members (session_id, user_id, state) values
    (s, g1, 'joined'), (s, quitter, 'opted_out'), (s_loc, g1, 'joined');
  insert into public.invites (session_id, created_by, invitee_id) values (s, host, invitee);
  -- A slot inserted without details gets the default.
  insert into public.slots (id, session_id, category, start_minute, duration_minutes) values (slot_s, s, 'eat', 720, 60);
  insert into public.slots (id, session_id, category, start_minute, duration_minutes, deleted) values (slot_gone, s, 'drink', 840, 60, true);
  insert into public.slots (id, session_id, category, start_minute, duration_minutes) values (slot_loc, s_loc, 'eat', 720, 60);
  insert into public.slot_options (slot_id, venue_id, rank) values (slot_s, 'venue_a', 1), (slot_s, 'venue_b', 2), (slot_gone, 'venue_c', 1), (slot_loc, 'venue_d', 1);
  insert into public.session_spots (session_id, area_id, rank, worst_minutes, mean_minutes) values (s_loc, 'bishan', 1, 20, 15), (s, 'bishan', 1, 20, 15);

  -- ── slots.details ───────────────────────────────────────────────────
  perform pg_temp.expect_text(1, 'a slot made without details has an empty object',
    format('select details::text from public.slots where id = %L', slot_s), '{}');
  perform pg_temp.as_server();
  perform pg_temp.expect_ok(2, 'the server stores the planner''s notes with the slot',
    format('update public.slots set details = %L where id = %L',
           '{"notice": "Rain is likely", "empty": false, "moreAvailable": true, "weather": {"source": "live", "condition": "rain"}}', slot_s), 1);
  perform pg_temp.expect_error(3, 'details cannot be an array',
    format('update public.slots set details = ''[1]'' where id = %L', slot_s), '23514');
  perform pg_temp.expect_error(4, 'details cannot be a bare string',
    format('update public.slots set details = ''"rain"'' where id = %L', slot_s), '23514');
  perform pg_temp.expect_error(5, 'details cannot be null',
    format('update public.slots set details = null where id = %L', slot_s), '23502');
  perform pg_temp.expect_error(6, 'details has a size limit of 4000 characters',
    format('update public.slots set details = jsonb_build_object(''notice'', %L) where id = %L', repeat('x', 4000), slot_s), '23514');
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_text(7, 'a member reads the details',
    format('select details ->> ''notice'' from public.slots where id = %L', slot_s), 'Rain is likely');
  perform pg_temp.expect_error(8, 'a member cannot write the details',
    format('update public.slots set details = ''{}'' where id = %L', slot_s), '42501');
  perform pg_temp.as_user(host);
  perform pg_temp.expect_error(9, 'the host cannot write the details either',
    format('update public.slots set details = ''{}'' where id = %L', slot_s), '42501');
  perform pg_temp.expect_error(10, 'the host cannot make a slot',
    format('insert into public.slots (session_id, category, start_minute, duration_minutes, details) values (%L, ''shop'', 900, 60, ''{}'')', s), '42501');
  perform pg_temp.as_user(quitter);
  perform pg_temp.expect_count(11, 'a member who opted out reads the slots as before',
    format('select count(*) from public.slots where session_id = %L', s), 2);
  perform pg_temp.as_user(invitee);
  perform pg_temp.expect_count(12, 'someone invited by username who has not accepted reads no slot',
    'select count(*) from public.slots', 0);
  perform pg_temp.as_user(stranger);
  perform pg_temp.expect_count(13, 'a stranger reads no slot',
    'select count(*) from public.slots', 0);

  -- ── Voting needs nothing else: the rules that were there still hold ──
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_ok(14, 'a member votes for an option while the session is voting',
    format('insert into public.votes (slot_id, user_id, venue_id) values (%L, %L, ''venue_a'')', slot_s, g1), 1);
  perform pg_temp.expect_ok(15, 'and changes their vote',
    format('update public.votes set venue_id = ''venue_b'' where slot_id = %L and user_id = %L', slot_s, g1), 1);
  perform pg_temp.expect_error(16, 'a vote for a place that is not an option is refused',
    format('update public.votes set venue_id = ''venue_z'' where slot_id = %L and user_id = %L', slot_s, g1), '23503');
  perform pg_temp.expect_error(17, 'a vote in a removed slot is refused',
    format('insert into public.votes (slot_id, user_id, venue_id) values (%L, %L, ''venue_c'')', slot_gone, g1), '42501');
  perform pg_temp.expect_error(18, 'a vote in a session that is still locating is refused',
    format('insert into public.votes (slot_id, user_id, venue_id) values (%L, %L, ''venue_d'')', slot_loc, g1), '42501');
  perform pg_temp.expect_error(19, 'approvals are closed once the session is voting, though its spot is still on record',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bishan'', %L)', s, g1), '42501');
  perform pg_temp.as_user(quitter);
  perform pg_temp.expect_error(20, 'a member who opted out cannot vote',
    format('insert into public.votes (slot_id, user_id, venue_id) values (%L, %L, ''venue_a'')', slot_s, quitter), '42501');
  perform pg_temp.as_server();
  perform pg_temp.expect_ok(21, 'the server swaps an option and the vote follows it',
    format('update public.slot_options set venue_id = ''venue_b2'' where slot_id = %L and venue_id = ''venue_b''', slot_s), 1);
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(22, 'the vote now names the swapped place',
    format('select venue_id from public.votes where slot_id = %L and user_id = %L', slot_s, g1), 'venue_b2');
  perform pg_temp.as_server();
  perform pg_temp.expect_ok(23, 'the server removes the option and the vote goes with it',
    format('delete from public.slot_options where slot_id = %L and venue_id = ''venue_b2''', slot_s), 1);
  perform pg_temp.as_admin();
  perform pg_temp.expect_count(24, 'no vote is left',
    format('select count(*) from public.votes where slot_id = %L', slot_s), 0);

  raise notice 'ALL STEPS PASSED';
end;
$test$;

-- Nothing is kept: the users, sessions, slots and votes above are all discarded here.
rollback;
