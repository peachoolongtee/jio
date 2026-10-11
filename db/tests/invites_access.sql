-- Access test for slice a: invite links and invitations by username.
-- Covers db/migrations/20261011000000_jio_invites.sql, or a fresh build of db/schema.sql and db/policies.sql.
--
-- How to run: after the migration (or a fresh build), run this whole file as ONE batch, in the SQL editor
-- or with   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/invites_access.sql
-- It runs as the project's owner role ("postgres"), makes throwaway users and sessions, acts as each of
-- them (set role + the JWT claims, the way Supabase does for a request), and ends with a rollback, so no
-- rows are left whether it passes or fails. A passing step prints a notice "ok step N". A broken rule
-- raises an exception "FAIL step N: ..." and stops the run (with the rollback that follows).
--
-- Expected error codes: 42501 = permission denied, row-level security refusal or a refusal by the insert
-- trigger, 23505 = unique, 23514 = check constraint, P0002 = "no longer valid" from join_session and
-- decline_invite, P0001 = "full" (hint session_full).

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
  host uuid := gen_random_uuid();        -- hosts s, s_rev, s_exp, s_closed and s_inv
  g1 uuid := gen_random_uuid();          -- a joined guest of s
  quitter uuid := gen_random_uuid();     -- opted out of s
  joiner uuid := gen_random_uuid();      -- joins s by link
  invitee uuid := gen_random_uuid();     -- invited to s by username, accepts
  invitee2 uuid := gen_random_uuid();    -- invited to s by username, declines
  third uuid := gen_random_uuid();       -- a signed-in person who is nobody's invitee
  stranger uuid := gen_random_uuid();    -- belongs to nothing
  other_host uuid := gen_random_uuid();  -- hosts s_full and s_other
  fillers uuid[] := array(select gen_random_uuid() from generate_series(1, 30));
  s uuid := gen_random_uuid();           -- inviting: the main session
  s_rev uuid := gen_random_uuid();       -- inviting, its only link revoked
  s_exp uuid := gen_random_uuid();       -- inviting, its only link expired
  s_closed uuid := gen_random_uuid();    -- confirmed, with a link that was never revoked
  s_full uuid := gen_random_uuid();      -- inviting with 30 joined members
  s_inv uuid := gen_random_uuid();       -- inviting, for the cap of 30 open invitations
  s_other uuid := gen_random_uuid();     -- somebody else's
  slot_s uuid := gen_random_uuid();
  live text;                             -- the live link's token on s
  tok_a text;                            -- invitee's personal token
  tok_b text;                            -- invitee2's personal token
  tok_x text;                            -- an expired personal token
  u uuid;
begin
  -- ── Setup, as the project owner ─────────────────────────────────────
  foreach u in array array[host, g1, quitter, joiner, invitee, invitee2, third, stranger, other_host] || fillers loop
    perform pg_temp.new_user(u);
  end loop;

  insert into public.sessions (id, host_id, title, date, start_time, end_time, status) values
    (s, host, 'Invites test', current_date + 1, '10:00', '20:00', 'inviting'),
    (s_rev, host, 'Revoked link', current_date + 1, '10:00', '20:00', 'inviting'),
    (s_exp, host, 'Expired link', current_date + 1, '10:00', '20:00', 'inviting'),
    (s_closed, host, 'Closed', current_date + 1, '10:00', '20:00', 'voting'),
    (s_full, other_host, 'Full', current_date + 1, '10:00', '20:00', 'inviting'),
    (s_inv, host, 'Many invitations', current_date + 1, '10:00', '20:00', 'inviting'),
    (s_other, other_host, 'Somebody else''s', current_date + 1, '10:00', '20:00', 'inviting');
  -- The host joined each session through a trigger. Add the others.
  insert into public.session_members (session_id, user_id, state) values (s, g1, 'joined'), (s, quitter, 'opted_out');
  insert into public.session_members (session_id, user_id, state)
  select s_full, f, 'joined' from unnest(fillers[1:29]) as f;
  insert into public.invites (token, session_id, created_by, created_at, expires_at, revoked) values
    ('link_revoked', s_rev, host, now(), now() + interval '3 days', true),
    ('link_expired', s_exp, host, now() - interval '10 days', now() - interval '3 days', false),
    ('link_closed', s_closed, host, now(), now() + interval '3 days', false),
    ('link_full', s_full, other_host, now(), now() + interval '3 days', false),
    ('link_other', s_other, other_host, now(), now() + interval '3 days', false);
  update public.sessions set status = 'confirmed' where id = s_closed;
  -- Something in every table an invitee must not read.
  insert into public.slots (id, session_id, category, start_minute, duration_minutes) values (slot_s, s, 'eat', 720, 60);
  insert into public.slot_options (slot_id, venue_id) values (slot_s, 'venue_x');
  insert into public.votes (slot_id, user_id, venue_id) values (slot_s, g1, 'venue_x');
  insert into public.stops (session_id, seq, venue_id, planned_start_minute, duration_minutes) values (s, 0, 'venue_x', 720, 60);
  insert into public.session_member_places (session_id, user_id, start_label) values (s, g1, 'Home');

  -- ── Making a link ───────────────────────────────────────────────────
  perform pg_temp.as_user(host);
  perform pg_temp.expect_ok(1, 'the host makes a link for their session',
    format('insert into public.invites (session_id, created_by) values (%L, %L)', s, host), 1);
  perform pg_temp.expect_text(2, 'the token is 43 characters, made by the database',
    format('select char_length(token)::text from public.invites where session_id = %L and invitee_id is null', s), '43');
  perform pg_temp.expect_text(3, 'a link made with no expiry lasts 7 days',
    format('select ((expires_at - created_at) = interval ''7 days'')::text from public.invites where session_id = %L and invitee_id is null', s), 'true');
  perform pg_temp.expect_error(4, 'a second live link for the session is refused',
    format('insert into public.invites (session_id, created_by) values (%L, %L)', s, host), '23505');
  perform pg_temp.expect_error(5, 'the host cannot make a link for somebody else''s session',
    format('insert into public.invites (session_id, created_by) values (%L, %L)', s_other, host), '42501');
  perform pg_temp.expect_error(6, 'a link cannot be made in another person''s name',
    format('insert into public.invites (session_id, created_by) values (%L, %L)', s_rev, g1), '42501');
  perform pg_temp.expect_error(7, 'the host cannot choose the token',
    format('insert into public.invites (token, session_id, created_by) values (''mine'', %L, %L)', s_rev, host), '42501');
  perform pg_temp.expect_error(8, 'the host cannot set the use count',
    format('insert into public.invites (session_id, created_by, uses) values (%L, %L, 5)', s_rev, host), '42501');
  perform pg_temp.expect_error(9, 'a link cannot expire more than 30 days after it is made',
    format('insert into public.invites (session_id, created_by, expires_at) values (%L, %L, now() + interval ''31 days'')', s_rev, host), '23514');
  perform pg_temp.expect_ok(10, 'a link may expire exactly 30 days after it is made (its session had only a revoked link)',
    format('insert into public.invites (session_id, created_by, expires_at) values (%L, %L, now() + interval ''30 days'')', s_rev, host), 1);
  perform pg_temp.expect_error(11, 'no link can be made for a session that is confirmed',
    format('insert into public.invites (session_id, created_by) values (%L, %L)', s_closed, host), '42501', 'only be made while');
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_error(12, 'a member who is not the host cannot make a link',
    format('insert into public.invites (session_id, created_by) values (%L, %L)', s, g1), '42501');
  perform pg_temp.as_user(stranger);
  perform pg_temp.expect_error(13, 'a stranger cannot make a link',
    format('insert into public.invites (session_id, created_by) values (%L, %L)', s, stranger), '42501');

  perform pg_temp.as_admin();
  select token into live from public.invites where session_id = s and invitee_id is null;

  -- ── The preview, signed out ─────────────────────────────────────────
  perform pg_temp.as_anon();
  perform pg_temp.expect_count(14, 'a signed-out visitor previews a live link: one row',
    format('select count(*) from public.invite_preview(%L)', live), 1);
  perform pg_temp.expect_text(15, 'the preview has the title, date, times and host''s name and nothing else',
    format('select string_agg(k, '','' order by k) from public.invite_preview(%L) p, jsonb_object_keys(to_jsonb(p)) k', live),
    'date,end_time,host_name,start_time,title');
  perform pg_temp.expect_count(16, 'a revoked link previews nothing',
    'select count(*) from public.invite_preview(''link_revoked'')', 0);
  perform pg_temp.expect_count(17, 'an expired link previews nothing',
    'select count(*) from public.invite_preview(''link_expired'')', 0);
  perform pg_temp.expect_count(18, 'a link to a confirmed session previews nothing',
    'select count(*) from public.invite_preview(''link_closed'')', 0);
  perform pg_temp.expect_count(19, 'an unknown token previews nothing',
    'select count(*) from public.invite_preview(''nonsense'')', 0);
  perform pg_temp.expect_error(20, 'a signed-out visitor cannot read the invites table',
    'select count(*) from public.invites', '42501');
  perform pg_temp.expect_error(21, 'a signed-out visitor cannot join',
    format('select public.join_session(%L)', live), '42501');
  perform pg_temp.expect_error(22, 'a signed-out visitor cannot list invitations',
    'select count(*) from public.my_invitations()', '42501');
  perform pg_temp.expect_error(23, 'a signed-out visitor cannot decline',
    'select public.decline_invite(''x'')', '42501');

  -- ── Joining by link ─────────────────────────────────────────────────
  perform pg_temp.as_user(joiner);
  perform pg_temp.expect_text(24, 'a signed-in person joins with the link and gets the session id',
    format('select public.join_session(%L)::text', live), s::text);
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(25, 'they are a joined guest, and the link counts one use',
    format('select (select state || '' '' || role from public.session_members where session_id = %L and user_id = %L) || '' '' || (select uses from public.invites where token = %L)', s, joiner, live),
    'joined guest 1');
  perform pg_temp.as_user(joiner);
  perform pg_temp.expect_text(26, 'joining again changes nothing',
    format('select public.join_session(%L)::text', live), s::text);
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(27, 'there is still one member row and one use',
    format('select (select count(*) from public.session_members where session_id = %L and user_id = %L) || '' '' || (select uses from public.invites where token = %L)', s, joiner, live),
    '1 1');
  perform pg_temp.as_user(quitter);
  perform pg_temp.expect_ok(28, 'someone who opted out can follow the link again',
    format('select public.join_session(%L)', live));
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(29, 'and is left opted out, with no new use counted',
    format('select (select state from public.session_members where session_id = %L and user_id = %L) || '' '' || (select uses from public.invites where token = %L)', s, quitter, live),
    'opted_out 1');
  perform pg_temp.as_user(third);
  perform pg_temp.expect_error(30, 'a revoked link cannot be used', 'select public.join_session(''link_revoked'')', 'P0002');
  perform pg_temp.expect_error(31, 'an expired link cannot be used', 'select public.join_session(''link_expired'')', 'P0002');
  perform pg_temp.expect_error(32, 'a link to a confirmed session cannot be used', 'select public.join_session(''link_closed'')', 'P0002');
  perform pg_temp.expect_error(33, 'an unknown token cannot be used', 'select public.join_session(''nonsense'')', 'P0002');
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_count(34, 'a member does not see the session''s links',
    format('select count(*) from public.invites where session_id = %L and invitee_id is null', s), 0);

  -- ── The cap of 30 ───────────────────────────────────────────────────
  perform pg_temp.as_admin();
  perform pg_temp.expect_count(35, 'setup: the full session has 30 joined members',
    format('select count(*) from public.session_members where session_id = %L and state = ''joined''', s_full), 30);
  perform pg_temp.as_user(third);
  perform pg_temp.expect_error(36, 'the 31st person is refused, and told the session is full',
    'select public.join_session(''link_full'')', 'P0001', 'full');
  perform pg_temp.as_user(fillers[1]);
  perform pg_temp.expect_text(37, 'a member of the full session who follows the link again is not refused',
    'select public.join_session(''link_full'')::text', s_full::text);
  perform pg_temp.as_admin();
  perform pg_temp.expect_count(38, 'the refused join left no member row',
    format('select count(*) from public.session_members where session_id = %L and user_id = %L', s_full, third), 0);
  delete from public.session_members where session_id = s_full and user_id = fillers[29];
  perform pg_temp.as_user(third);
  perform pg_temp.expect_text(39, 'once someone leaves there is a place again',
    'select public.join_session(''link_full'')::text', s_full::text);
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(40, 'join_session takes a lock on the session row before it counts (definition check)',
    'select (pg_get_functiondef(''public.join_session(text)''::regprocedure) ilike ''%for update of s%'')::text', 'true');

  -- ── Revoking ────────────────────────────────────────────────────────
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_ok(41, 'a member who is not the host cannot revoke a link (no row is theirs to change)',
    format('update public.invites set revoked = true where token = %L', live), 0);
  perform pg_temp.as_user(other_host);
  perform pg_temp.expect_ok(42, 'another session''s host cannot revoke it either',
    format('update public.invites set revoked = true where token = %L', live), 0);
  perform pg_temp.as_user(host);
  perform pg_temp.expect_error(43, 'the host cannot extend a link''s expiry',
    format('update public.invites set expires_at = now() + interval ''29 days'' where token = %L', live), '42501');
  perform pg_temp.expect_error(44, 'the host cannot reset a link''s use count',
    format('update public.invites set uses = 0 where token = %L', live), '42501');
  perform pg_temp.expect_error(45, 'the host cannot turn a link into a personal invitation',
    format('update public.invites set invitee_id = %L where token = %L', third, live), '42501');
  perform pg_temp.expect_error(46, 'the host cannot mark a link declined',
    format('update public.invites set declined_at = now() where token = %L', live), '42501');
  perform pg_temp.expect_ok(47, 'the host revokes the link',
    format('update public.invites set revoked = true where token = %L', live), 1);
  perform pg_temp.expect_error(48, 'a revoke cannot be undone',
    format('update public.invites set revoked = false where token = %L', live), '42501');
  perform pg_temp.as_anon();
  perform pg_temp.expect_count(49, 'the revoked link previews nothing',
    format('select count(*) from public.invite_preview(%L)', live), 0);
  perform pg_temp.as_user(third);
  perform pg_temp.expect_error(50, 'and cannot be used to join',
    format('select public.join_session(%L)', live), 'P0002');
  perform pg_temp.as_user(host);
  perform pg_temp.expect_ok(51, 'a new link can be made once the old one is revoked ("Reset link")',
    format('insert into public.invites (session_id, created_by) values (%L, %L)', s, host), 1);

  -- ── Inviting a person by username ───────────────────────────────────
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_error(52, 'a member who is not the host cannot invite anyone',
    format('insert into public.invites (session_id, created_by, invitee_id) values (%L, %L, %L)', s, g1, invitee), '42501');
  perform pg_temp.as_user(stranger);
  perform pg_temp.expect_error(53, 'a stranger cannot invite anyone',
    format('insert into public.invites (session_id, created_by, invitee_id) values (%L, %L, %L)', s, stranger, invitee), '42501');
  perform pg_temp.as_user(host);
  perform pg_temp.expect_ok(54, 'the host invites a person by their user id',
    format('insert into public.invites (session_id, created_by, invitee_id) values (%L, %L, %L)', s, host, invitee), 1);
  perform pg_temp.expect_error(55, 'the host cannot invite themselves',
    format('insert into public.invites (session_id, created_by, invitee_id) values (%L, %L, %L)', s_inv, host, host), '42501', 'already in');
  perform pg_temp.expect_error(56, 'the host cannot invite someone who is already a member',
    format('insert into public.invites (session_id, created_by, invitee_id) values (%L, %L, %L)', s, host, g1), '42501', 'already in');
  perform pg_temp.expect_error(57, 'the host cannot invite someone who opted out',
    format('insert into public.invites (session_id, created_by, invitee_id) values (%L, %L, %L)', s, host, quitter), '42501', 'already in');
  perform pg_temp.expect_error(58, 'the same person cannot be invited twice',
    format('insert into public.invites (session_id, created_by, invitee_id) values (%L, %L, %L)', s, host, invitee), '23505');
  perform pg_temp.expect_error(59, 'no invitation can be made for a confirmed session',
    format('insert into public.invites (session_id, created_by, invitee_id) values (%L, %L, %L)', s_closed, host, invitee), '42501', 'only be made while');
  perform pg_temp.expect_error(60, 'an invitation cannot last more than 30 days either',
    format('insert into public.invites (session_id, created_by, invitee_id, expires_at) values (%L, %L, %L, now() + interval ''31 days'')', s, host, invitee2), '23514');
  perform pg_temp.expect_ok(61, 'the host invites a second person',
    format('insert into public.invites (session_id, created_by, invitee_id) values (%L, %L, %L)', s, host, invitee2), 1);
  perform pg_temp.expect_count(62, 'the host sees both invitations and both links of the session',
    format('select count(*) from public.invites where session_id = %L', s), 4);
  perform pg_temp.as_admin();
  select token into tok_a from public.invites where session_id = s and invitee_id = invitee;
  select token into tok_b from public.invites where session_id = s and invitee_id = invitee2;

  -- ── The invitee, before accepting ───────────────────────────────────
  perform pg_temp.as_user(invitee);
  perform pg_temp.expect_count(63, 'the invitee lists their invitation through my_invitations()',
    'select count(*) from public.my_invitations()', 1);
  perform pg_temp.expect_text(64, 'it has the token, title, date, times, host''s name and when they were invited, and nothing else',
    'select string_agg(k, '','' order by k) from public.my_invitations() p, jsonb_object_keys(to_jsonb(p)) k',
    'date,end_time,host_name,invited_at,start_time,title,token');
  perform pg_temp.expect_count(65, 'the invitee reads none of the session''s data: not the session, its members, places, slots, options, votes or stops',
    'select (select count(*) from public.sessions) + (select count(*) from public.session_members)'
    || ' + (select count(*) from public.session_member_places) + (select count(*) from public.slots)'
    || ' + (select count(*) from public.slot_options) + (select count(*) from public.votes)'
    || ' + (select count(*) from public.stops) + (select count(*) from public.commute_ledger)', 0);
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_count(66, 'control: a member reads the same tables (1 session, 4 members, 1 place, 1 slot, 1 option, 1 vote, 1 stop)',
    'select (select count(*) from public.sessions where id = ' || quote_literal(s) || ') + (select count(*) from public.session_members where session_id = ' || quote_literal(s) || ')'
    || ' + (select count(*) from public.session_member_places) + (select count(*) from public.slots where session_id = ' || quote_literal(s) || ')'
    || ' + (select count(*) from public.slot_options) + (select count(*) from public.votes)'
    || ' + (select count(*) from public.stops where session_id = ' || quote_literal(s) || ')', 10);
  perform pg_temp.as_user(invitee);
  perform pg_temp.expect_count(67, 'the invitee reads their own invitation row, and only that',
    'select count(*) from public.invites', 1);
  perform pg_temp.expect_count(68, 'the invitee previews their own invitation',
    format('select count(*) from public.invite_preview(%L)', tok_a), 1);
  perform pg_temp.expect_error(69, 'the invitee cannot change their invitation directly',
    format('update public.invites set declined_at = now() where token = %L', tok_a), '42501');
  perform pg_temp.expect_error(70, 'the invitee cannot delete their invitation',
    format('delete from public.invites where token = %L', tok_a), '42501');
  perform pg_temp.expect_error(71, 'the invitee cannot invite others',
    format('insert into public.invites (session_id, created_by, invitee_id) values (%L, %L, %L)', s, invitee, third), '42501');
  perform pg_temp.as_anon();
  perform pg_temp.expect_count(72, 'a signed-out visitor previews nothing for a personal token',
    format('select count(*) from public.invite_preview(%L)', tok_a), 0);

  -- ── A personal token is useless to a third person ───────────────────
  perform pg_temp.as_user(third);
  perform pg_temp.expect_count(73, 'a third person lists no invitations',
    'select count(*) from public.my_invitations()', 0);
  perform pg_temp.expect_error(74, 'a third person cannot join with it, and gets the same error as for an unknown token',
    format('select public.join_session(%L)', tok_a), 'P0002', 'no longer valid');
  perform pg_temp.expect_error(75, 'a third person cannot decline it, with the same error',
    format('select public.decline_invite(%L)', tok_a), 'P0002', 'no longer valid');
  perform pg_temp.expect_count(76, 'a third person previews nothing for it',
    format('select count(*) from public.invite_preview(%L)', tok_a), 0);
  perform pg_temp.expect_count(77, 'a third person reads no invitation rows',
    'select count(*) from public.invites', 0);
  perform pg_temp.as_user(invitee2);
  perform pg_temp.expect_error(78, 'one invitee cannot use another invitee''s token',
    format('select public.join_session(%L)', tok_a), 'P0002');
  perform pg_temp.as_user(joiner);
  perform pg_temp.expect_error(79, 'a member of the session cannot use someone else''s personal token either',
    format('select public.join_session(%L)', tok_a), 'P0002');

  -- ── What members see of an invitee ──────────────────────────────────
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_count(80, 'a member sees the two pending invitations, and no links',
    format('select count(*) from public.invites where session_id = %L', s), 2);
  perform pg_temp.expect_text(81, 'about the invitee a member reads the public profile; no private row, no member row',
    format('select ((select count(*) from public.profiles where id = %L) = 1 and (select count(*) from public.profile_private where id = %L) = 0'
           || ' and (select count(*) from public.session_members where user_id = %L) = 0)::text', invitee, invitee, invitee), 'true');
  perform pg_temp.as_user(quitter);
  perform pg_temp.expect_count(82, 'a member who opted out sees the pending invitations too',
    format('select count(*) from public.invites where session_id = %L', s), 2);

  -- ── Accepting ───────────────────────────────────────────────────────
  perform pg_temp.as_user(invitee);
  perform pg_temp.expect_text(83, 'the invitee accepts: join_session returns the session',
    format('select public.join_session(%L)::text', tok_a), s::text);
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(84, 'they are a joined guest and the invitation is marked used',
    format('select (select state || '' '' || role from public.session_members where session_id = %L and user_id = %L) || '' '' || (select uses from public.invites where token = %L)', s, invitee, tok_a),
    'joined guest 1');
  perform pg_temp.as_user(invitee);
  perform pg_temp.expect_count(85, 'it no longer shows among their invitations',
    'select count(*) from public.my_invitations()', 0);
  perform pg_temp.expect_count(86, 'and now they read the session',
    format('select count(*) from public.sessions where id = %L', s), 1);
  perform pg_temp.expect_error(87, 'they cannot decline an invitation they accepted',
    format('select public.decline_invite(%L)', tok_a), 'P0002');
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_count(88, 'members no longer see it as pending',
    format('select count(*) from public.invites where session_id = %L', s), 1);
  perform pg_temp.as_admin();
  delete from public.session_members where session_id = s and user_id = invitee;
  perform pg_temp.as_user(invitee);
  perform pg_temp.expect_error(89, 'a person removed from the session cannot use their used invitation again',
    format('select public.join_session(%L)', tok_a), 'P0002');

  -- ── Declining ───────────────────────────────────────────────────────
  perform pg_temp.as_user(invitee2);
  perform pg_temp.expect_count(90, 'the second invitee sees their invitation',
    'select count(*) from public.my_invitations()', 1);
  perform pg_temp.expect_ok(91, 'they decline it',
    format('select public.decline_invite(%L)', tok_b));
  perform pg_temp.expect_ok(92, 'declining again is quiet',
    format('select public.decline_invite(%L)', tok_b));
  perform pg_temp.expect_count(93, 'a declined invitation drops out of their list',
    'select count(*) from public.my_invitations()', 0);
  perform pg_temp.expect_count(94, 'and previews nothing',
    format('select count(*) from public.invite_preview(%L)', tok_b), 0);
  perform pg_temp.expect_error(95, 'and cannot be accepted',
    format('select public.join_session(%L)', tok_b), 'P0002');
  perform pg_temp.as_user(host);
  perform pg_temp.expect_count(96, 'the host still sees that it was declined',
    format('select count(*) from public.invites where token = %L and declined_at is not null', tok_b), 1);
  perform pg_temp.as_user(g1);
  perform pg_temp.expect_count(97, 'other members do not see a declined invitation',
    format('select count(*) from public.invites where token = %L', tok_b), 0);
  perform pg_temp.as_user(host);
  perform pg_temp.expect_error(98, 'a declined person cannot be invited again',
    format('insert into public.invites (session_id, created_by, invitee_id) values (%L, %L, %L)', s, host, invitee2), '23505');
  perform pg_temp.expect_ok(99, 'the host can revoke the declined invitation',
    format('update public.invites set revoked = true where token = %L', tok_b), 1);
  perform pg_temp.expect_error(100, 'even then they cannot be invited again',
    format('insert into public.invites (session_id, created_by, invitee_id) values (%L, %L, %L)', s, host, invitee2), '23505');
  perform pg_temp.as_admin();
  perform pg_temp.expect_error(101, 'a link cannot be marked declined (check)',
    format('update public.invites set declined_at = now() where token = %L', live), '23514');
  perform pg_temp.expect_error(102, 'a personal invitation is used at most once (check)',
    format('update public.invites set uses = 2 where token = %L', tok_a), '23514');

  -- ── Expired, and the cap of 30 open invitations ─────────────────────
  insert into public.invites (session_id, created_by, invitee_id, created_at, expires_at)
  values (s, host, stranger, now() - interval '10 days', now() - interval '3 days')
  returning token into tok_x;
  perform pg_temp.as_user(stranger);
  perform pg_temp.expect_count(103, 'an expired invitation is not listed',
    'select count(*) from public.my_invitations()', 0);
  perform pg_temp.expect_error(104, 'and cannot be accepted',
    format('select public.join_session(%L)', tok_x), 'P0002');

  perform pg_temp.as_admin();
  insert into public.invites (session_id, created_by, invitee_id)
  select s_inv, host, f from unnest(fillers) as f;
  perform pg_temp.expect_count(105, 'setup: a session holds 30 open invitations',
    format('select count(*) from public.invites where session_id = %L', s_inv), 30);
  perform pg_temp.as_user(host);
  perform pg_temp.expect_error(106, 'the 31st open invitation is refused',
    format('insert into public.invites (session_id, created_by, invitee_id) values (%L, %L, %L)', s_inv, host, third), '42501', 'at most 30');
  perform pg_temp.expect_ok(107, 'revoke one and the host can invite the 31st person',
    format('update public.invites set revoked = true where session_id = %L and invitee_id = %L', s_inv, fillers[1]), 1);
  perform pg_temp.expect_ok(108, 'the invitation goes through',
    format('insert into public.invites (session_id, created_by, invitee_id) values (%L, %L, %L)', s_inv, host, third), 1);

  -- ── Functions and live updates ──────────────────────────────────────
  perform pg_temp.as_admin();
  perform pg_temp.expect_text(109, 'a signed-in browser may call the three functions it needs and not the trigger function',
    'select (has_function_privilege(''authenticated'', ''public.my_invitations()'', ''execute'')'
    || ' and has_function_privilege(''authenticated'', ''public.decline_invite(text)'', ''execute'')'
    || ' and has_function_privilege(''authenticated'', ''public.join_session(text)'', ''execute'')'
    || ' and not has_function_privilege(''authenticated'', ''public.check_invite_insert()'', ''execute'')'
    || ' and not has_function_privilege(''anon'', ''public.my_invitations()'', ''execute'')'
    || ' and has_function_privilege(''anon'', ''public.invite_preview(text)'', ''execute''))::text', 'true');
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    perform pg_temp.expect_count(110, 'invites is in the live-updates publication',
      'select count(*) from pg_publication_tables where pubname = ''supabase_realtime'' and schemaname = ''public'' and tablename = ''invites''', 1);
  else
    raise notice 'skip: no supabase_realtime publication on this database';
  end if;

  raise notice 'ALL STEPS PASSED';
end;
$test$;

-- Nothing is kept: the users, sessions and invitations above are all discarded here.
rollback;
