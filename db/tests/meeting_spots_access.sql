-- Access test for slice b: meeting spots, suggestions and "Works for me".
-- Covers db/migrations/20261011000100_jio_meeting_spots.sql, or a fresh build of db/schema.sql and
-- db/policies.sql. It needs slice a applied (it invites people by username).
--
-- How to run: after the migration (or a fresh build), run this whole file as ONE batch, in the SQL editor
-- or with   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/meeting_spots_access.sql
-- It runs as the project's owner role ("postgres"), makes throwaway users and sessions, acts as each of
-- them (set role + the JWT claims, the way Supabase does for a request), and ends with a rollback, so no
-- rows are left whether it passes or fails. A passing step prints a notice "ok step N". A broken rule
-- raises an exception "FAIL step N: ..." and stops the run (with the rollback that follows).
--
-- Expected error codes: 42501 = permission denied or row-level security refusal, 23503 = foreign key,
-- 23505 = unique, 23514 = check constraint.

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
  host uuid := gen_random_uuid();        -- hosts s
  g1 uuid := gen_random_uuid();          -- a joined guest, who suggests Orchard (which the app also lists)
  g2 uuid := gen_random_uuid();          -- a joined guest, who suggests Tampines
  g3 uuid := gen_random_uuid();          -- a joined guest, who will suggest Tampines too
  quitter uuid := gen_random_uuid();     -- opted out of s
  invitee uuid := gen_random_uuid();     -- invited to s by username, has not accepted
  stranger uuid := gen_random_uuid();    -- belongs to nothing
  other_host uuid := gen_random_uuid();  -- hosts s2
  s uuid := gen_random_uuid();           -- locating: four spots, three suggestions
  s2 uuid := gen_random_uuid();          -- locating, somebody else's, with one spot
  tm jsonb;                              -- three members' minutes, unrounded
  st text;
  u uuid;
begin
  -- ── Setup, as the project owner ─────────────────────────────────────
  foreach u in array array[host, g1, g2, g3, quitter, invitee, stranger, other_host] loop
    perform pg_temp.new_user(u);
  end loop;
  tm := jsonb_build_object(host::text, 20.4, g1::text, 30.4, g2::text, 24.9);

  insert into public.sessions (id, host_id, title, date, start_time, end_time, status) values
    (s, host, 'Spots test', current_date + 1, '10:00', '20:00', 'locating'),
    (s2, other_host, 'Somebody else', current_date + 1, '10:00', '20:00', 'locating');
  insert into public.session_members (session_id, user_id, state) values
    (s, g1, 'joined'), (s, g2, 'joined'), (s, g3, 'joined'), (s, quitter, 'opted_out');
  insert into public.invites (session_id, created_by, invitee_id) values (s, host, invitee);

  -- The app lists Bishan, Bugis and Orchard (ranks 1 to 3). g1 suggested Orchard too, so it stays listed if the
  -- app's three change. g2 suggested Tampines, which only the suggestion keeps on the list (no rank).
  insert into public.session_spots (session_id, area_id, rank, worst_minutes, mean_minutes, travel_minutes, approximate) values
    (s, 'bishan', 1, 30.4, 25.233333, tm, false),
    (s, 'bugis', 2, 32.1, 26, tm, false),
    (s, 'orchard', 3, 35.5, 28.5, tm, true),
    (s, 'tampines', null, 40.25, 31, tm, false),
    (s2, 'bishan', 1, 20, 15, '{}', false);
  insert into public.spot_suggestions (session_id, user_id, area_id, here) values
    (s, g1, 'orchard', true), (s, g2, 'tampines', false);
  insert into public.spot_approvals (session_id, area_id, user_id) values
    (s, 'bishan', g2), (s, 'bugis', host), (s, 'orchard', g1);

  -- ── Reading: one rule, through my_session_ids() ─────────────────────
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_count(1, 'a joined member reads the spots of their session and no other',
    'select count(*) from public.session_spots', 4);
  perform pg_temp.expect_count(2, 'a joined member reads the suggestions',
    'select count(*) from public.spot_suggestions', 2);
  perform pg_temp.expect_count(3, 'a joined member reads the approvals',
    'select count(*) from public.spot_approvals', 3);
  perform pg_temp.expect_text(4, 'the minutes come back unrounded, the longest trip and each member''s',
    format('select (select worst_minutes::text from public.session_spots where session_id = %L and area_id = ''bishan'')'
           || ' || '' '' || (select travel_minutes ->> %L from public.session_spots where session_id = %L and area_id = ''bishan'')', s, g1::text, s),
    '30.4 30.4');
  perform pg_temp.as_user(host);
  perform pg_temp.expect_count(5, 'the host reads spots, suggestions and approvals',
    'select (select count(*) from public.session_spots) + (select count(*) from public.spot_suggestions)'
    || ' + (select count(*) from public.spot_approvals)', 9);
  perform pg_temp.as_user(quitter);
  perform pg_temp.expect_count(6, 'a member who opted out reads the same spots, suggestions and approvals as everyone in the session',
    'select (select count(*) from public.session_spots) + (select count(*) from public.spot_suggestions)'
    || ' + (select count(*) from public.spot_approvals)', 9);
  perform pg_temp.as_user(invitee);
  perform pg_temp.expect_count(7, 'someone invited by username who has not accepted reads none of it',
    'select (select count(*) from public.session_spots) + (select count(*) from public.spot_suggestions)'
    || ' + (select count(*) from public.spot_approvals)', 0);
  perform pg_temp.expect_count(8, 'and still has their invitation',
    'select count(*) from public.my_invitations()', 1);
  perform pg_temp.as_user(stranger);
  perform pg_temp.expect_count(9, 'someone in no session reads nothing in any of the three tables',
    'select (select count(*) from public.session_spots) + (select count(*) from public.spot_suggestions)'
    || ' + (select count(*) from public.spot_approvals)', 0);
  perform pg_temp.as_user(other_host);
  perform pg_temp.expect_count(10, 'a member of another session reads nothing of this one',
    format('select (select count(*) from public.session_spots where session_id = %L) + (select count(*) from public.spot_suggestions where session_id = %L)'
           || ' + (select count(*) from public.spot_approvals where session_id = %L)', s, s, s), 0);
  perform pg_temp.as_anon();
  perform pg_temp.expect_error(11, 'a logged-out visitor cannot read spots', 'select count(*) from public.session_spots', '42501');
  perform pg_temp.expect_error(12, 'a logged-out visitor cannot read suggestions', 'select count(*) from public.spot_suggestions', '42501');
  perform pg_temp.expect_error(13, 'a logged-out visitor cannot read approvals', 'select count(*) from public.spot_approvals', '42501');

  -- ── The list and the suggestions are the server's ───────────────────
  perform pg_temp.as_user(g2);
  perform pg_temp.expect_error(14, 'a member cannot add a spot',
    format('insert into public.session_spots (session_id, area_id, worst_minutes, mean_minutes) values (%L, ''jurong'', 20, 15)', s), '42501');
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_error(15, 'a member cannot update a spot, even one they suggested',
    format('update public.session_spots set rank = null where session_id = %L and area_id = ''orchard''', s), '42501');
  perform pg_temp.expect_error(16, 'a member cannot change a spot''s minutes',
    format('update public.session_spots set worst_minutes = 1, travel_minutes = ''{}'' where session_id = %L', s), '42501');
  perform pg_temp.expect_error(17, 'a member cannot delete a spot, even one they suggested',
    format('delete from public.session_spots where session_id = %L and area_id = ''orchard''', s), '42501');
  perform pg_temp.expect_error(18, 'a member cannot make a suggestion themselves',
    format('insert into public.spot_suggestions (session_id, user_id, area_id) values (%L, %L, ''jurong'')', s, g3), '42501');
  perform pg_temp.expect_error(19, 'a member cannot change their own suggestion',
    format('update public.spot_suggestions set area_id = ''jurong'', here = false where session_id = %L and user_id = %L', s, g1), '42501');
  perform pg_temp.expect_error(20, 'a member cannot withdraw their own suggestion',
    format('delete from public.spot_suggestions where session_id = %L and user_id = %L', s, g1), '42501');
  perform pg_temp.as_user(host);
  perform pg_temp.expect_error(21, 'the host cannot add a spot either',
    format('insert into public.session_spots (session_id, area_id, worst_minutes, mean_minutes) values (%L, ''jurong'', 20, 15)', s), '42501');
  perform pg_temp.expect_error(22, 'the host cannot delete a spot either',
    format('delete from public.session_spots where session_id = %L', s), '42501');
  perform pg_temp.as_admin();
  perform pg_temp.expect_count(23, 'all four spots and both suggestions are still there after the refused writes',
    format('select (select count(*) from public.session_spots where session_id = %L) + (select count(*) from public.spot_suggestions where session_id = %L)', s, s), 6);

  -- ── Suggestions: the working rules ──────────────────────────────────
  perform pg_temp.as_server();
  perform pg_temp.expect_ok(24, 'two members can suggest the same area: the server records g3''s suggestion of Tampines',
    format('insert into public.spot_suggestions (session_id, user_id, area_id, here) values (%L, %L, ''tampines'', true)', s, g3), 1);
  perform pg_temp.expect_count(25, 'Tampines has two suggestions and one spot',
    format('select (select count(*) from public.spot_suggestions where session_id = %L and area_id = ''tampines'') * 10'
           || ' + (select count(*) from public.session_spots where session_id = %L and area_id = ''tampines'')', s, s), 21);
  perform pg_temp.expect_error(26, 'a member has one suggestion at a time',
    format('insert into public.spot_suggestions (session_id, user_id, area_id) values (%L, %L, ''jurong'')', s, g3), '23505');
  perform pg_temp.expect_ok(27, 'the server replaces a suggestion by updating it (and gives it a new time, so it moves to the end)',
    format('update public.spot_suggestions set area_id = ''jurong'', here = false, created_at = now() where session_id = %L and user_id = %L', s, g3), 1);
  perform pg_temp.expect_error(28, 'a suggestion must come from a member of the session',
    format('insert into public.spot_suggestions (session_id, user_id, area_id) values (%L, %L, ''jurong'')', s, stranger), '23503');
  perform pg_temp.expect_error(29, 'a suggestion''s area id cannot be empty',
    format('update public.spot_suggestions set area_id = '''' where session_id = %L and user_id = %L', s, g3), '23514');
  perform pg_temp.expect_error(30, 'a suggestion''s area id has a length limit',
    format('update public.spot_suggestions set area_id = %L where session_id = %L and user_id = %L', repeat('x', 61), s, g3), '23514');
  perform pg_temp.expect_count(31, 'a suggestion can name an area that is not on the list at all: Jurong is suggested and not listed (the server prices it after)',
    format('select (select count(*) from public.spot_suggestions where session_id = %L and area_id = ''jurong'') * 10'
           || ' + (select count(*) from public.session_spots where session_id = %L and area_id = ''jurong'')', s, s), 10);
  -- g1 suggested Orchard, which the app also lists. The app's three change and Orchard drops out of them.
  perform pg_temp.expect_ok(32, 'the app''s three change: Orchard loses its rank but its row stays, because g1 suggested it',
    format('update public.session_spots set rank = null where session_id = %L and area_id = ''orchard''', s), 1);
  perform pg_temp.expect_count(33, 'Orchard is still listed, still suggested by g1, and still approved by g1',
    format('select (select count(*) from public.session_spots where session_id = %L and area_id = ''orchard'' and rank is null)'
           || ' + (select count(*) from public.spot_suggestions where session_id = %L and user_id = %L and area_id = ''orchard'')'
           || ' + (select count(*) from public.spot_approvals where session_id = %L and area_id = ''orchard'' and user_id = %L)', s, s, g1, s, g1), 3);

  -- ── Ranks, minutes and the difference rewrite ───────────────────────
  perform pg_temp.expect_error(34, 'two spots cannot share a rank',
    format('update public.session_spots set rank = 1 where session_id = %L and area_id = ''bugis''; set constraints all immediate', s), '23505');
  perform pg_temp.expect_ok(35, 'the server swaps two ranks in one statement (the rank is checked at the end)',
    format('update public.session_spots set rank = 3 - rank where session_id = %L and rank in (1, 2); set constraints all immediate', s));
  perform pg_temp.expect_error(36, 'a rank is 1 to 3: 4 is refused',
    format('update public.session_spots set rank = 4 where session_id = %L and area_id = ''tampines''', s), '23514');
  perform pg_temp.expect_error(37, 'a rank is 1 to 3: 0 is refused',
    format('update public.session_spots set rank = 0 where session_id = %L and area_id = ''tampines''', s), '23514');
  perform pg_temp.expect_ok(38, 'several spots may have no rank',
    format('insert into public.session_spots (session_id, area_id, worst_minutes, mean_minutes) values (%L, ''jurong'', 41, 33), (%L, ''clementi'', 42, 34)', s, s), 2);
  perform pg_temp.expect_ok(39, 'the server re-prices a spot with an upsert and its approvals stay',
    format('insert into public.session_spots (session_id, area_id, rank, worst_minutes, mean_minutes, travel_minutes, approximate)'
           || ' values (%L, ''bishan'', 2, 31.5, 26.125, %L, true)'
           || ' on conflict (session_id, area_id) do update set rank = excluded.rank, worst_minutes = excluded.worst_minutes,'
           || ' mean_minutes = excluded.mean_minutes, travel_minutes = excluded.travel_minutes, approximate = excluded.approximate, computed_at = now()', s, tm::text), 1);
  perform pg_temp.expect_count(40, 'the upsert kept the approval on Bishan',
    format('select count(*) from public.spot_approvals where session_id = %L and area_id = ''bishan''', s), 1);
  perform pg_temp.expect_error(41, 'the longest trip is at most 1440 minutes',
    format('update public.session_spots set worst_minutes = 1441 where session_id = %L and area_id = ''bishan''', s), '23514');
  perform pg_temp.expect_error(42, 'minutes cannot be negative',
    format('update public.session_spots set worst_minutes = -1, mean_minutes = -1 where session_id = %L and area_id = ''bishan''', s), '23514');
  perform pg_temp.expect_error(43, 'the mean cannot exceed the longest trip',
    format('update public.session_spots set mean_minutes = 99 where session_id = %L and area_id = ''bishan''', s), '23514');
  perform pg_temp.expect_ok(44, 'but equal minutes whose floating-point mean lands a hair above are accepted',
    format('update public.session_spots set worst_minutes = 10.1, mean_minutes = 10.1000000001 where session_id = %L and area_id = ''bishan''', s), 1);
  perform pg_temp.expect_error(45, 'travel_minutes must be an object',
    format('update public.session_spots set travel_minutes = ''[1, 2]'' where session_id = %L and area_id = ''bishan''', s), '23514');
  perform pg_temp.expect_error(46, 'travel_minutes keys must be user ids',
    format('update public.session_spots set travel_minutes = ''{"ian": 5}'' where session_id = %L and area_id = ''bishan''', s), '23514');
  perform pg_temp.expect_error(47, 'travel_minutes values must be numbers',
    format('update public.session_spots set travel_minutes = jsonb_build_object(%L::text, ''soon'') where session_id = %L and area_id = ''bishan''', g1, s), '23514');
  perform pg_temp.expect_error(48, 'travel_minutes values must be between 0 and 1440',
    format('update public.session_spots set travel_minutes = jsonb_build_object(%L::text, 1441) where session_id = %L and area_id = ''bishan''', g1, s), '23514');
  perform pg_temp.expect_error(49, 'travel_minutes has a size limit',
    format('update public.session_spots set travel_minutes = (select jsonb_object_agg(gen_random_uuid()::text, 1) from generate_series(1, 120)) where session_id = %L and area_id = ''bishan''', s), '23514');
  perform pg_temp.expect_ok(50, 'an empty travel_minutes is accepted (nobody has shared a start yet)',
    format('update public.session_spots set travel_minutes = ''{}'' where session_id = %L and area_id = ''bishan''', s), 1);
  perform pg_temp.expect_error(51, 'a spot''s area id has a length limit',
    format('insert into public.session_spots (session_id, area_id, worst_minutes, mean_minutes) values (%L, %L, 1, 1)', s, repeat('x', 61)), '23514');
  perform pg_temp.expect_error(52, 'a spot''s area id cannot be empty',
    format('insert into public.session_spots (session_id, area_id, worst_minutes, mean_minutes) values (%L, '''', 1, 1)', s), '23514');

  -- ── Works for me ────────────────────────────────────────────────────
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_ok(53, 'a member approves a listed spot while locating',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bugis'', %L)', s, g1), 1);
  perform pg_temp.expect_ok(54, 'a member approves a second spot (any number is allowed)',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''jurong'', %L)', s, g1), 1);
  perform pg_temp.expect_error(55, 'approving the same spot twice is refused',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bugis'', %L)', s, g1), '23505');
  perform pg_temp.expect_ok(56, 'a member takes back their own approval',
    format('delete from public.spot_approvals where session_id = %L and area_id = ''jurong'' and user_id = %L', s, g1), 1);
  perform pg_temp.expect_error(57, 'a member cannot approve for someone else',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bugis'', %L)', s, g2), '42501');
  perform pg_temp.expect_ok(58, 'a member cannot delete someone else''s approval (no row matches)',
    format('delete from public.spot_approvals where session_id = %L and user_id = %L', s, g2), 0);
  perform pg_temp.expect_error(59, 'a member cannot approve an area that is not listed',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''sentosa'', %L)', s, g1), '23503');
  perform pg_temp.expect_error(60, 'a member cannot approve a spot of a session they are not in',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bishan'', %L)', s2, g1), '42501');
  perform pg_temp.expect_error(61, 'an approval cannot be changed in place (no update right)',
    format('update public.spot_approvals set area_id = ''bishan'' where session_id = %L and user_id = %L', s, g1), '42501');
  perform pg_temp.as_user(quitter);
  perform pg_temp.expect_error(62, 'a member who opted out cannot approve (they read the list, but write nothing)',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bishan'', %L)', s, quitter), '42501');
  perform pg_temp.as_user(invitee);
  perform pg_temp.expect_error(63, 'someone who has only been invited cannot approve',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bishan'', %L)', s, invitee), '42501');
  perform pg_temp.as_user(stranger);
  perform pg_temp.expect_error(64, 'someone outside the session cannot approve',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bishan'', %L)', s, stranger), '42501');
  perform pg_temp.as_anon();
  perform pg_temp.expect_error(65, 'a logged-out visitor cannot approve',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bishan'', %L)', s, g1), '42501');

  -- Not locating: g1 has an approval of Bishan, then the session moves through every other status.
  perform pg_temp.as_admin();
  insert into public.spot_approvals (session_id, area_id, user_id) values (s, 'bishan', g1);
  perform pg_temp.as_admin();
  update public.sessions set status = 'inviting' where id = s;
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_error(66, 'a member cannot approve a spot once the session is inviting',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bugis'', %L)', s, g1), '42501');
  perform pg_temp.expect_ok(67, 'a member cannot take back an approval once the session is inviting (no row matches)',
    format('delete from public.spot_approvals where session_id = %L and area_id = ''bishan'' and user_id = %L', s, g1), 0);
  perform pg_temp.as_admin();
  update public.sessions set status = 'voting' where id = s;
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_error(68, 'a member cannot approve a spot once the session is voting',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bugis'', %L)', s, g1), '42501');
  perform pg_temp.expect_ok(69, 'a member cannot take back an approval once the session is voting (no row matches)',
    format('delete from public.spot_approvals where session_id = %L and area_id = ''bishan'' and user_id = %L', s, g1), 0);
  perform pg_temp.as_admin();
  update public.sessions set status = 'confirmed' where id = s;
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_error(70, 'a member cannot approve a spot once the session is confirmed',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bugis'', %L)', s, g1), '42501');
  perform pg_temp.expect_ok(71, 'a member cannot take back an approval once the session is confirmed (no row matches)',
    format('delete from public.spot_approvals where session_id = %L and area_id = ''bishan'' and user_id = %L', s, g1), 0);
  perform pg_temp.as_admin();
  update public.sessions set status = 'completed' where id = s;
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_error(72, 'a member cannot approve a spot once the session is completed',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bugis'', %L)', s, g1), '42501');
  perform pg_temp.expect_ok(73, 'a member cannot take back an approval once the session is completed (no row matches)',
    format('delete from public.spot_approvals where session_id = %L and area_id = ''bishan'' and user_id = %L', s, g1), 0);
  perform pg_temp.as_admin();
  update public.sessions set status = 'cancelled' where id = s;
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_error(74, 'a member cannot approve a spot once the session is cancelled',
    format('insert into public.spot_approvals (session_id, area_id, user_id) values (%L, ''bugis'', %L)', s, g1), '42501');
  perform pg_temp.expect_ok(75, 'a member cannot take back an approval once the session is cancelled (no row matches)',
    format('delete from public.spot_approvals where session_id = %L and area_id = ''bishan'' and user_id = %L', s, g1), 0);
  perform pg_temp.as_admin();
  update public.sessions set status = 'locating' where id = s;
  perform pg_temp.expect_count(76, 'the approval survived every refused delete',
    format('select count(*) from public.spot_approvals where session_id = %L and area_id = ''bishan'' and user_id = %L', s, g1), 1);

  -- ── A spot leaving the list takes its approvals; a member leaving takes their marks ──
  perform pg_temp.expect_count(77, 'before: Bishan has two approvals (g2 and g1) and Bugis two (the host and g1)',
    format('select (select count(*) from public.spot_approvals where session_id = %L and area_id = ''bishan'') * 10'
           || ' + (select count(*) from public.spot_approvals where session_id = %L and area_id = ''bugis'')', s, s), 22);
  perform pg_temp.as_server();
  perform pg_temp.expect_ok(78, 'the server drops the Bishan spot',
    format('delete from public.session_spots where session_id = %L and area_id = ''bishan''', s), 1);
  perform pg_temp.as_admin();
  perform pg_temp.expect_count(79, 'dropping a spot removed its approvals',
    format('select count(*) from public.spot_approvals where session_id = %L and area_id = ''bishan''', s), 0);
  perform pg_temp.expect_count(80, 'the other spots kept theirs (Bugis: host and g1; Orchard: g1)',
    format('select count(*) from public.spot_approvals where session_id = %L', s), 3);
  delete from public.session_members where session_id = s and user_id = g1;
  perform pg_temp.expect_count(81, 'a member who leaves takes their suggestion and their approvals with them',
    format('select (select count(*) from public.spot_suggestions where session_id = %L and user_id = %L)'
           || ' + (select count(*) from public.spot_approvals where session_id = %L and user_id = %L)', s, g1, s, g1), 0);
  perform pg_temp.expect_count(82, 'the Orchard spot row stays: the server removes a spot nobody lists any more',
    format('select count(*) from public.session_spots where session_id = %L and area_id = ''orchard''', s), 1);
  perform pg_temp.expect_count(83, 'the host''s approval of Bugis stayed',
    format('select count(*) from public.spot_approvals where session_id = %L and user_id = %L', s, host), 1);

  -- ── A suggestion survives an empty list ─────────────────────────────
  perform pg_temp.as_server();
  perform pg_temp.expect_ok(84, 'the server empties the list (fewer than two starts are left)',
    format('delete from public.session_spots where session_id = %L', s));
  perform pg_temp.as_admin();
  perform pg_temp.expect_count(85, 'the suggestions are still there, because they have no key to the list',
    format('select count(*) from public.spot_suggestions where session_id = %L', s), 2);
  perform pg_temp.expect_count(86, 'and no approval is left, because approvals follow their spots',
    format('select count(*) from public.spot_approvals where session_id = %L', s), 0);

  -- ── The meeting columns, plan_version and the guard ─────────────────
  perform pg_temp.as_server();
  perform pg_temp.expect_ok(87, 'meeting_method accepts voted', format('update public.sessions set meeting_method = ''voted'' where id = %L', s), 1);
  perform pg_temp.expect_ok(88, 'meeting_method accepts chosen', format('update public.sessions set meeting_method = ''chosen'' where id = %L', s), 1);
  perform pg_temp.expect_ok(89, 'meeting_method still accepts fairest', format('update public.sessions set meeting_method = ''fairest'' where id = %L', s), 1);
  perform pg_temp.expect_ok(90, 'meeting_method still accepts null', format('update public.sessions set meeting_method = null where id = %L', s), 1);
  perform pg_temp.expect_error(91, 'meeting_method refuses any other value', format('update public.sessions set meeting_method = ''majority'' where id = %L', s), '23514');
  perform pg_temp.expect_text(92, 'plan_version starts at 0 and the server raises it',
    format('select (select plan_version from public.sessions where id = %L)::text', s), '0');
  perform pg_temp.expect_ok(93, 'the server sets plan_version', format('update public.sessions set plan_version = plan_version + 1 where id = %L', s), 1);
  perform pg_temp.as_user(host);
  perform pg_temp.expect_ok(94, 'control: the host can still rename the session', format('update public.sessions set title = ''Renamed'' where id = %L', s), 1);
  perform pg_temp.expect_error(95, 'a browser cannot set plan_version', format('update public.sessions set plan_version = 0 where id = %L', s), '42501');
  perform pg_temp.expect_error(96, 'a browser cannot set meeting_method', format('update public.sessions set meeting_method = ''voted'' where id = %L', s), '42501');
  perform pg_temp.expect_error(97, 'a browser cannot set the meeting area', format('update public.sessions set meeting_area_id = ''bugis'' where id = %L', s), '42501');
  perform pg_temp.expect_error(98, 'a browser cannot set the meeting figures', format(
    'update public.sessions set meeting_max_minutes = 1, meeting_total_minutes = 1, meeting_count = 1, meeting_approximate = false where id = %L', s), '42501');
  perform pg_temp.expect_error(99, 'a browser cannot create a session with a meeting method', format(
    'insert into public.sessions (host_id, title, date, start_time, end_time, meeting_method) values (%L, ''x'', current_date, ''10:00'', ''11:00'', ''chosen'')', host), '42501');
  perform pg_temp.expect_error(100, 'a browser cannot create a session with a plan_version', format(
    'insert into public.sessions (host_id, title, date, start_time, end_time, plan_version) values (%L, ''x'', current_date, ''10:00'', ''11:00'', 9)', host), '42501');
  perform pg_temp.expect_error(101, 'guard_session_changes still refuses locating to voting from a browser', format(
    'update public.sessions set status = ''voting'' where id = %L', s), '42501');

  -- ── Functions and live updates ──────────────────────────────────────
  perform pg_temp.as_anon();
  perform pg_temp.expect_error(102, 'a logged-out visitor cannot call my_locating_session_ids',
    'select count(*) from public.my_locating_session_ids()', '42501');
  perform pg_temp.as_user(g2);
  perform pg_temp.expect_count(103, 'my_locating_session_ids lists only the caller''s own locating session',
    'select count(*) from public.my_locating_session_ids()', 1);
  perform pg_temp.as_user(quitter);
  perform pg_temp.expect_count(104, 'and nothing for a member who opted out',
    'select count(*) from public.my_locating_session_ids()', 0);
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(105, 'only the server can run the check on travel_minutes; no joined-only helper exists (one read rule)',
    'select (has_function_privilege(''service_role'', ''public.member_minutes_ok(jsonb)'', ''execute'')'
    || ' and not has_function_privilege(''authenticated'', ''public.member_minutes_ok(jsonb)'', ''execute'')'
    || ' and to_regprocedure(''public.my_joined_session_ids()'') is null)::text', 'true');
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime' and not puballtables) then
    perform pg_temp.expect_text(106, 'only spot_approvals of the new tables is in the live-updates publication',
      'select string_agg(tablename, '','' order by tablename) from pg_publication_tables where pubname = ''supabase_realtime'' and schemaname = ''public'''
      || ' and tablename in (''session_spots'', ''spot_suggestions'', ''spot_approvals'')', 'spot_approvals');
  else
    raise notice 'skip: no supabase_realtime publication, or it covers all tables, on this database';
  end if;

  raise notice 'ALL STEPS PASSED';
end;
$test$;

-- Nothing is kept: the users, sessions, spots, suggestions and approvals above are all discarded here.
rollback;
