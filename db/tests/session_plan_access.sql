-- Access test for slice d: the suggested order, the stop's earliest start, Roam proposals and travel debt.
-- Covers db/migrations/20261011000300_jio_session_plan.sql, or a fresh build of db/schema.sql and
-- db/policies.sql. It needs slices a and b applied.
--
-- How to run: after the migration (or a fresh build), run this whole file as ONE batch, in the SQL editor
-- or with   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/session_plan_access.sql
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
  g1 uuid := gen_random_uuid();          -- a joined guest, who proposes places
  g2 uuid := gen_random_uuid();          -- a joined guest
  quitter uuid := gen_random_uuid();     -- opted out of s
  invitee uuid := gen_random_uuid();     -- invited to s by username, has not accepted
  stranger uuid := gen_random_uuid();    -- belongs to nothing
  other_host uuid := gen_random_uuid();  -- hosts s2
  s uuid := gen_random_uuid();           -- confirmed, with a stop and proposals
  s2 uuid := gen_random_uuid();          -- confirmed, somebody else's
  p1 uuid := gen_random_uuid();          -- earlier sessions, for the ledger
  p2 uuid := gen_random_uuid();
  p3 uuid := gen_random_uuid();
  hash text := repeat('ab12', 16);       -- 64 hex characters
  slot_ids jsonb;
  u uuid;
begin
  -- ── Setup, as the project owner ─────────────────────────────────────
  foreach u in array array[host, g1, g2, quitter, invitee, stranger, other_host] loop
    perform pg_temp.new_user(u);
  end loop;
  insert into public.sessions (id, host_id, title, date, start_time, end_time, status) values
    (s, host, 'Plan test', current_date + 1, '10:00', '20:00', 'voting'),
    (s2, other_host, 'Somebody else', current_date + 1, '10:00', '20:00', 'confirmed'),
    (p1, host, 'Earlier one', current_date - 20, '10:00', '20:00', 'completed'),
    (p2, host, 'Earlier two', current_date - 200, '10:00', '20:00', 'completed'),
    (p3, other_host, 'Earlier three', current_date - 5, '10:00', '20:00', 'completed');
  insert into public.session_members (session_id, user_id, state) values
    (s, g1, 'joined'), (s, g2, 'joined'), (s, quitter, 'opted_out');
  insert into public.invites (session_id, created_by, invitee_id) values (s, host, invitee);
  update public.sessions set status = 'confirmed' where id = s;
  insert into public.stops (session_id, seq, venue_id, planned_start_minute, duration_minutes)
  values (s, 0, 'venue_stop', 600, 60), (s2, 0, 'venue_stop', 600, 60);
  insert into public.stop_proposals (session_id, venue_id, proposed_by) values (s, 'venue_a', g1), (s2, 'venue_a', other_host);
  slot_ids := jsonb_build_array(gen_random_uuid(), gen_random_uuid());

  -- ── The order columns on sessions: bounds and pairing ───────────────
  perform pg_temp.as_server();
  perform pg_temp.expect_ok(1, 'the server sets the order note: a reason and where it came from',
    format('update public.sessions set order_reason = ''Lunch first, then the shops open.'', order_source = ''ai'' where id = %L', s), 1);
  perform pg_temp.expect_ok(2, 'the server clears the order note',
    format('update public.sessions set order_reason = null, order_source = null where id = %L', s), 1);
  perform pg_temp.expect_error(3, 'a reason of 201 characters is refused',
    format('update public.sessions set order_reason = %L, order_source = ''ai'' where id = %L', repeat('x', 201), s), '23514');
  perform pg_temp.expect_ok(4, 'a reason of 200 characters is accepted',
    format('update public.sessions set order_reason = %L, order_source = ''rules'' where id = %L', repeat('x', 200), s), 1);
  perform pg_temp.expect_error(5, 'an empty reason is refused',
    format('update public.sessions set order_reason = '''' where id = %L', s), '23514');
  perform pg_temp.expect_error(6, 'the source must be ai or rules',
    format('update public.sessions set order_source = ''guess'' where id = %L', s), '23514');
  perform pg_temp.expect_error(7, 'the note comes as a pair: clearing the reason alone is refused',
    format('update public.sessions set order_reason = null where id = %L', s), '23514');
  perform pg_temp.expect_error(8, 'the note comes as a pair: clearing the source alone is refused',
    format('update public.sessions set order_source = null where id = %L', s), '23514');
  perform pg_temp.expect_ok(9, 'the server stores a suggestion: a basis hash, the order of slots, the starts, a reason, a source and a time',
    format('update public.sessions set order_suggestion = %L where id = %L',
           jsonb_build_object('basis', hash, 'order', slot_ids, 'starts', jsonb_build_array(720, 840), 'reason', 'Lunch first.', 'source', 'ai', 'at', now()), s), 1);
  perform pg_temp.expect_error(10, 'a suggestion needs a basis',
    format('update public.sessions set order_suggestion = %L where id = %L', jsonb_build_object('order', slot_ids), s), '23514');
  perform pg_temp.expect_error(11, 'the basis must be 64 hex characters: 63 are refused',
    format('update public.sessions set order_suggestion = %L where id = %L', jsonb_build_object('basis', left(hash, 63), 'order', slot_ids), s), '23514');
  perform pg_temp.expect_error(12, 'the basis must be lower-case hex',
    format('update public.sessions set order_suggestion = %L where id = %L', jsonb_build_object('basis', upper(hash), 'order', slot_ids), s), '23514');
  perform pg_temp.expect_error(13, 'the basis must be a string',
    format('update public.sessions set order_suggestion = %L where id = %L', jsonb_build_object('basis', 12345, 'order', slot_ids), s), '23514');
  perform pg_temp.expect_error(14, 'a suggestion needs an order that is a list',
    format('update public.sessions set order_suggestion = %L where id = %L', jsonb_build_object('basis', hash, 'order', 'a,b'), s), '23514');
  perform pg_temp.expect_error(15, 'a suggestion without an order is refused',
    format('update public.sessions set order_suggestion = %L where id = %L', jsonb_build_object('basis', hash), s), '23514');
  perform pg_temp.expect_ok(16, 'an order of 8 slots is accepted',
    format('update public.sessions set order_suggestion = %L where id = %L',
           jsonb_build_object('basis', hash, 'order', (select jsonb_agg(gen_random_uuid()) from generate_series(1, 8))), s), 1);
  perform pg_temp.expect_error(17, 'an order of 9 slots is refused',
    format('update public.sessions set order_suggestion = %L where id = %L',
           jsonb_build_object('basis', hash, 'order', (select jsonb_agg(gen_random_uuid()) from generate_series(1, 9))), s), '23514');
  perform pg_temp.expect_error(18, 'a suggestion cannot be a list',
    format('update public.sessions set order_suggestion = ''[1, 2]'' where id = %L', s), '23514');
  perform pg_temp.expect_error(19, 'a suggestion has a size limit of 4000 characters',
    format('update public.sessions set order_suggestion = %L where id = %L',
           jsonb_build_object('basis', hash, 'order', slot_ids, 'reason', repeat('x', 4000)), s), '23514');
  perform pg_temp.expect_ok(20, 'the server clears the suggestion',
    format('update public.sessions set order_suggestion = null where id = %L', s), 1);
  perform pg_temp.expect_ok(21, 'plan_start_minute accepts 0', format('update public.sessions set plan_start_minute = 0 where id = %L', s), 1);
  perform pg_temp.expect_ok(22, 'plan_start_minute accepts 1439', format('update public.sessions set plan_start_minute = 1439 where id = %L', s), 1);
  perform pg_temp.expect_error(23, 'plan_start_minute refuses 1440', format('update public.sessions set plan_start_minute = 1440 where id = %L', s), '23514');
  perform pg_temp.expect_error(24, 'plan_start_minute refuses a negative number', format('update public.sessions set plan_start_minute = -1 where id = %L', s), '23514');
  perform pg_temp.expect_ok(25, 'plan_start_minute can be cleared', format('update public.sessions set plan_start_minute = null where id = %L', s), 1);

  -- ── The stop's earliest start ───────────────────────────────────────
  perform pg_temp.expect_ok(26, 'the server sets a stop''s earliest start',
    format('update public.stops set not_before_minute = 0 where session_id = %L', s), 1);
  perform pg_temp.expect_ok(27, 'an earliest start of 1439 is accepted',
    format('update public.stops set not_before_minute = 1439 where session_id = %L', s), 1);
  perform pg_temp.expect_error(28, 'an earliest start of 1440 is refused',
    format('update public.stops set not_before_minute = 1440 where session_id = %L', s), '23514');
  perform pg_temp.expect_error(29, 'a negative earliest start is refused',
    format('update public.stops set not_before_minute = -1 where session_id = %L', s), '23514');
  perform pg_temp.expect_ok(30, 'a stop may have no earliest start',
    format('update public.stops set not_before_minute = null where session_id = %L', s), 1);

  -- ── A browser writes none of it ─────────────────────────────────────
  perform pg_temp.as_user(host);
  perform pg_temp.expect_ok(31, 'control: the host can still rename the session', format('update public.sessions set title = ''Renamed'' where id = %L', s), 1);
  perform pg_temp.expect_error(32, 'a browser cannot set the order note', format(
    'update public.sessions set order_reason = ''x'', order_source = ''ai'' where id = %L', s), '42501');
  perform pg_temp.expect_error(33, 'a browser cannot clear the order note', format(
    'update public.sessions set order_reason = null, order_source = null where id = %L', s), '42501');
  perform pg_temp.expect_error(34, 'a browser cannot store a suggestion', format(
    'update public.sessions set order_suggestion = %L where id = %L', jsonb_build_object('basis', hash, 'order', slot_ids), s), '42501');
  perform pg_temp.expect_error(35, 'a browser cannot set plan_start_minute', format('update public.sessions set plan_start_minute = 600 where id = %L', s), '42501');
  perform pg_temp.expect_error(36, 'a browser cannot create a session with an order note', format(
    'insert into public.sessions (host_id, title, date, start_time, end_time, order_reason, order_source) values (%L, ''x'', current_date, ''10:00'', ''11:00'', ''x'', ''ai'')', host), '42501');
  perform pg_temp.expect_error(37, 'a browser cannot create a session with a suggestion or a plan start', format(
    'insert into public.sessions (host_id, title, date, start_time, end_time, plan_start_minute) values (%L, ''x'', current_date, ''10:00'', ''11:00'', 600)', host), '42501');
  perform pg_temp.expect_error(38, 'guard_session_changes still refuses confirmed to voting from a browser', format(
    'update public.sessions set status = ''voting'' where id = %L', s), '42501');
  perform pg_temp.expect_error(39, 'a browser cannot set a stop''s earliest start', format(
    'update public.stops set not_before_minute = 600 where session_id = %L', s), '42501');
  perform pg_temp.expect_error(40, 'a browser cannot insert a stop', format(
    'insert into public.stops (session_id, seq, venue_id, planned_start_minute, duration_minutes, not_before_minute) values (%L, 5, ''v'', 600, 60, 600)', s), '42501');
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_error(41, 'a member who is not the host cannot set the order note either', format(
    'update public.sessions set order_reason = ''x'', order_source = ''ai'' where id = %L', s), '42501');

  -- ── Roam proposals: written by the server only ──────────────────────
  perform pg_temp.expect_error(42, 'a member cannot propose a place directly, even while the session is confirmed', format(
    'insert into public.stop_proposals (session_id, venue_id, proposed_by) values (%L, ''venue_b'', %L)', s, g1), '42501');
  perform pg_temp.expect_error(43, 'a member cannot withdraw their own proposal', format(
    'delete from public.stop_proposals where session_id = %L', s), '42501');
  perform pg_temp.expect_error(44, 'a member cannot resolve a proposal', format(
    'update public.stop_proposals set status = ''accepted'', resolved_at = now(), resolved_by = %L where session_id = %L', g1, s), '42501');
  perform pg_temp.as_user(host);
  perform pg_temp.expect_error(45, 'the host cannot resolve a proposal directly either: the server does it', format(
    'update public.stop_proposals set status = ''accepted'', resolved_at = now(), resolved_by = %L where session_id = %L', host, s), '42501');
  perform pg_temp.expect_error(46, 'the host cannot insert a proposal directly either', format(
    'insert into public.stop_proposals (session_id, venue_id, proposed_by) values (%L, ''venue_b'', %L)', s, host), '42501');
  perform pg_temp.expect_error(47, 'the host cannot delete a proposal directly', format(
    'delete from public.stop_proposals where session_id = %L', s), '42501');

  perform pg_temp.as_server();
  perform pg_temp.expect_ok(48, 'the server inserts a proposal', format(
    'insert into public.stop_proposals (session_id, venue_id, proposed_by) values (%L, ''venue_b'', %L)', s, g2), 1);
  perform pg_temp.expect_text(49, 'a new proposal is pending, with no resolution time',
    format('select status || '' '' || (resolved_at is null) from public.stop_proposals where session_id = %L and venue_id = ''venue_b''', s), 'pending true');
  perform pg_temp.expect_error(50, 'the same venue cannot wait twice in one session', format(
    'insert into public.stop_proposals (session_id, venue_id, proposed_by) values (%L, ''venue_a'', %L)', s, g2), '23505');
  perform pg_temp.expect_count(51, 'but another session has its own pending proposal for the same venue (the uniqueness is per session)', format(
    'select count(*) from public.stop_proposals where session_id = %L and venue_id = ''venue_a'' and status = ''pending''', s2), 1);
  perform pg_temp.expect_error(52, 'a proposal must come from a member of the session', format(
    'insert into public.stop_proposals (session_id, venue_id, proposed_by) values (%L, ''venue_c'', %L)', s, stranger), '23503');
  perform pg_temp.expect_error(53, 'a venue id cannot be empty', format(
    'insert into public.stop_proposals (session_id, venue_id, proposed_by) values (%L, '''', %L)', s, host), '23514');
  perform pg_temp.expect_error(54, 'a venue id has a length limit', format(
    'insert into public.stop_proposals (session_id, venue_id, proposed_by) values (%L, %L, %L)', s, repeat('v', 81), host), '23514');
  perform pg_temp.expect_error(55, 'a status is pending, accepted or dismissed', format(
    'update public.stop_proposals set status = ''maybe'', resolved_at = now() where session_id = %L and venue_id = ''venue_a''', s), '23514');
  perform pg_temp.expect_error(56, 'a resolution needs a time', format(
    'update public.stop_proposals set status = ''accepted'' where session_id = %L and venue_id = ''venue_a''', s), '23514');
  perform pg_temp.expect_error(57, 'a time needs a resolution', format(
    'update public.stop_proposals set resolved_at = now() where session_id = %L and venue_id = ''venue_a''', s), '23514');
  perform pg_temp.expect_error(58, 'a pending proposal has nobody who resolved it', format(
    'update public.stop_proposals set resolved_by = %L where session_id = %L and venue_id = ''venue_a''', host, s), '23514');
  perform pg_temp.expect_ok(59, 'the server accepts a proposal', format(
    'update public.stop_proposals set status = ''accepted'', resolved_at = now(), resolved_by = %L where session_id = %L and venue_id = ''venue_a''', host, s), 1);
  perform pg_temp.expect_ok(60, 'the server dismisses a proposal (here the proposer dismisses their own)', format(
    'update public.stop_proposals set status = ''dismissed'', resolved_at = now(), resolved_by = %L where session_id = %L and venue_id = ''venue_b''', g2, s), 1);
  perform pg_temp.expect_ok(61, 'a resolved venue can be proposed again', format(
    'insert into public.stop_proposals (session_id, venue_id, proposed_by) values (%L, ''venue_a'', %L)', s, g1), 1);
  perform pg_temp.expect_ok(62, 'and a dismissed one too', format(
    'insert into public.stop_proposals (session_id, venue_id, proposed_by) values (%L, ''venue_b'', %L)', s, g1), 1);

  -- ── Who reads proposals ─────────────────────────────────────────────
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_count(63, 'a member reads pending and resolved proposals of their session, and no other', format(
    'select count(*) from public.stop_proposals'), 4);
  perform pg_temp.as_user(host);
  perform pg_temp.expect_count(64, 'the host reads the same four', 'select count(*) from public.stop_proposals', 4);
  perform pg_temp.as_user(quitter);
  perform pg_temp.expect_count(65, 'a member who opted out reads them too (one read rule for the new tables)', 'select count(*) from public.stop_proposals', 4);
  perform pg_temp.as_user(invitee);
  perform pg_temp.expect_count(66, 'someone invited by username who has not accepted reads none', 'select count(*) from public.stop_proposals', 0);
  perform pg_temp.as_user(stranger);
  perform pg_temp.expect_count(67, 'a stranger reads none', 'select count(*) from public.stop_proposals', 0);
  perform pg_temp.as_user(other_host);
  perform pg_temp.expect_count(68, 'a member of another session reads only their own', 'select count(*) from public.stop_proposals', 1);
  perform pg_temp.as_anon();
  perform pg_temp.expect_error(69, 'a logged-out visitor cannot read proposals', 'select count(*) from public.stop_proposals', '42501');
  perform pg_temp.as_admin();
  delete from public.session_members where session_id = s and user_id = g1;
  perform pg_temp.expect_count(70, 'a member who leaves takes their proposals with them, resolved or not (g1 had three, g2''s remains)',
    format('select count(*) from public.stop_proposals where session_id = %L', s), 1);

  -- ── Travel debt ─────────────────────────────────────────────────────
  insert into public.commute_ledger (session_id, user_id, minutes_in, delta_from_mean, created_at) values
    (p1, host, 30, 12.5, now() - interval '20 days'),
    (p1, g2, 30, -12.5, now() - interval '20 days'),
    (p2, host, 30, 100, now() - interval '100 days'),
    (p3, g2, 30, 20000, now() - interval '5 days'),
    (s, host, 30, 55, now());
  perform pg_temp.as_server();
  perform pg_temp.expect_count(71, 'session_travel_debt gives one row for each joined member (not the one who opted out)',
    format('select count(*) from public.session_travel_debt(%L)', s), 2);
  perform pg_temp.expect_text(72, 'it sums the last 90 days of other sessions: the host''s 12.5, without the 100 from 100 days ago or this session''s 55',
    format('select debt_minutes::text from public.session_travel_debt(%L) where user_id = %L', s, host), '12.5');
  perform pg_temp.expect_text(73, 'and clamps to 14400 minutes',
    format('select debt_minutes::text from public.session_travel_debt(%L) where user_id = %L', s, g2), '14400');
  perform pg_temp.as_user(host);
  perform pg_temp.expect_error(74, 'a signed-in browser cannot call session_travel_debt',
    format('select count(*) from public.session_travel_debt(%L)', s), '42501');
  perform pg_temp.as_anon();
  perform pg_temp.expect_error(75, 'a logged-out visitor cannot call it either',
    format('select count(*) from public.session_travel_debt(%L)', s), '42501');

  -- ── Live updates ────────────────────────────────────────────────────
  perform pg_temp.as_admin();
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime' and not puballtables) then
    perform pg_temp.expect_count(76, 'stop_proposals is not published: the sessions row carries the change (plan_version)',
      'select count(*) from pg_publication_tables where pubname = ''supabase_realtime'' and schemaname = ''public'' and tablename = ''stop_proposals''', 0);
  else
    raise notice 'skip: no supabase_realtime publication, or it covers all tables, on this database';
  end if;

  raise notice 'ALL STEPS PASSED';
end;
$test$;

-- Nothing is kept: the users, sessions, stops, proposals and ledger rows above are all discarded here.
rollback;
