-- Jio migration: the host changes the meeting place. apply_session_plan() learns one op, "release_meeting", which is the only way a voting or
-- confirmed session goes back to locating, and the only way a chosen meeting area ('voted' or 'chosen') is ever let go. One function replaced,
-- no table or column added.
--
-- THIS MIGRATION MUST BE APPLIED BEFORE THE BACKEND THAT HAS POST /api/sessions/:id/change-meeting-place RUNS ANYWHERE (a laptop, a preview, the
-- deployed server). That route sends the op below, which the stage 5 function refuses as an operation it does not know (22023). The backend
-- starts without it; only that route fails, with a 500, until the file is applied. It needs the stage 5 function (20261023000000) and the start
-- choice (20261026000000, for sessions.meet_by) applied.
--
-- What the op does, in one write, and what it requires:
--   { "op": "release_meeting", "meet_by": "fairest" | "known" }
--     * Valid only on the move from voting or confirmed to locating (patch.session.status = 'locating'), else P0001 hint release_status. That
--       move is valid only with this op, else the stage 5 hint status_transition. So a patch cannot go back to locating without releasing,
--       and cannot release without going back.
--     * The patch must not bring a meeting of its own (P0001, hint release_meeting): a released session has no meeting area.
--     * "meet_by" is the host's new choice of how the meeting point is picked again; anything else is 22023. It is written to sessions.meet_by
--       in the same write (the function runs as the server, which the guard on that column lets through).
--     * It deletes: every vote, every slot (their options go by foreign key), every stop, every spot with its approvals and suggestions.
--       It sets to null: every meeting_* column of the session, order_reason, order_source, order_suggestion, plan_start_minute, replan and
--       weather_kept. (Members' own travel_minutes are left alone: nothing reads them while locating, the next confirm rewrites them, and
--       writing them would move every member's updated_at past the new spots' computed_at, which a page reads as "the spots are stale" and
--       answers with a second planner run.) The proposals still waiting are dismissed (the stage 5 rule for leaving
--       confirmed). The banner is cleared unless the patch brings one, and one it brings is always written afresh with a new time.
--     * A release can meet a deadlock with a guest's vote (40P01): a vote locks its row and its option before its trigger waits for the
--       session, and a release deletes those rows while it holds the session. The function therefore locks the session's votes and options
--       BEFORE the session row, in a fixed order, which removes that cycle (reasoned and reviewed; PGlite has one connection, so no test here
--       can run two at once). Another server write on the same session in another process could still meet it in the other order: the server
--       (backend/src/db/sessions.js applyPlan) retries once on 40P01 and 40001, and answers an error only if the retry fails too.
--     * It keeps: who is in the session and their state, the starts and ends people shared (session_members.start_area_id and end_area_id, and
--       session_member_places), their picks (categories and stay-until), the radius, the title, date and times, and the proposals already
--       answered. So a released session is a locating one whose people have already shared where they start.
--   The patch may bring "spots" (the list worked out again from the kept starts, written in the same call with the usual rules, so a
--   guest never sees an empty list between the two) and "session": { "status": "locating", "banner": { "text": ... } }. It may not bring "slots",
--   "stops", "stop_options" or "ledger" (refused as before: they belong to other statuses).
--   The gap: that holds for "fairest". For "known" the backend runs this release and then the known place as TWO writes, so for a moment between
--   them the session is locating with no spot list (a guest's page waits briefly and looks again, and the host sees the error on Locate if the
--   second write fails); the release itself is atomic either way.
--
-- Every other rule is unchanged: Rule 4 (a pinned meeting area is never moved by a recompute: area_pinned) and Rule 5 (a pin only with the
-- host's confirm) still hold on every other path, and browsers still cannot call the function or move a status backwards
-- (guard_session_changes). Steps 301 onwards of db/tests/apply_session_plan.sql test this file.
--
-- Expected function text. The body of apply_session_plan (the text between the dollar quotes, as pg_proc.prosrc holds it) has these md5 sums:
--   0b045589c032e034636cfc0e59306559   stage 5 as the live project holds it: the live body carries no comment lines, so its sum is not the file's
--   3e206e88861c16adea7282967cff357c   stage 5 as db/migrations/20261023000000_jio_apply_session_plan_stops.sql and the earlier db/schema.sql carry it, with its comments
--   9cb0cb5720ead4e934661b47cbcaa97d   the version this migration installs, with its comments
--   c2b499a44f51d9fe4c3db2afb66eb22b   the same text without comment lines and blank lines, which is what the live project would hold if this file were sent
--                    through the tool that strips comments (it is what the live stage 5 body was): a second run still passes
-- The block below stops the migration if public.sessions.meet_by is missing (the function writes it: apply 20261026000000 first), or if the live function is none of the four, for instance because someone edited it by hand in the SQL
-- editor: replacing it would silently throw their change away. backend/tests/sessions-sql.test.js checks that the sums here are those of the
-- text in this file, in db/schema.sql and in the stage 5 file, and that the stripping is the one described.
--
-- Run it once as ONE transaction. Idempotent. db/schema.sql carries the same function. Test it first with db/tests/apply_session_plan.sql inside
-- a transaction that rolls back (all 300 earlier steps still hold, and steps 301 onwards are this file's), and do not touch the live project
-- before that has passed.

do $function_check$
declare
  live text;
begin
  select md5(prosrc) into live from pg_proc where oid = 'public.apply_session_plan(uuid, bigint, text, jsonb)'::regprocedure;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sessions' and column_name = 'meet_by') then
    raise exception 'public.sessions.meet_by does not exist: apply db/migrations/20261026000000_jio_session_meet_by.sql first. This function writes it.';
  end if;
  if live is null or live not in ('0b045589c032e034636cfc0e59306559', '3e206e88861c16adea7282967cff357c', '9cb0cb5720ead4e934661b47cbcaa97d', 'c2b499a44f51d9fe4c3db2afb66eb22b') then
    raise exception 'apply_session_plan on this project is not the text this migration expects (md5 %). Compare it with db/schema.sql before applying.', live;
  end if;
end;
$function_check$;

-- Every write the server makes to a session's plan, in one transaction. See db/schema.sql for the full description of the function.

create or replace function public.apply_session_plan(sid uuid, expected_version bigint, expected_status text, patch jsonb)
returns bigint
language plpgsql set search_path = ''
as $$
declare
  s public.sessions%rowtype;
  sp jsonb;
  meeting jsonb;
  op jsonb;
  item jsonb;
  opt jsonb;
  hit bigint;
  changed boolean := false;
  new_status text;
  lost_approvals boolean := false;
  banner_text text;
  stamp timestamptz;
  meeting_changed boolean := false;
  banner_changed boolean := false;
  banner_new jsonb;
  banner_stamped boolean := false;
  radius_changed boolean := false;
  travel_changed boolean := false;
  slot_row public.slots%rowtype;
  v_category text;
  v_slot uuid;
  n_start integer;
  n_duration integer;
  n_picks integer;
  n_last boolean;
  n_deleted boolean;
  n_details jsonb;
  unknown_key text;
  note_new jsonb;
  note_changed boolean := false;
  suggestion_new jsonb;
  suggestion_changed boolean := false;
  start_changed boolean := false;
  replan_new jsonb;
  replan_changed boolean := false;
  reopened boolean := false;
  v_count bigint;
  v_distinct bigint;
  v_max integer;
  v_venues bigint;
  stop_row public.stops%rowtype;
  kept_new jsonb;
  kept_changed boolean := false;
  v_stale boolean;
  released boolean := false;
  release_by text;
begin
  if patch is null or jsonb_typeof(patch) <> 'object' then
    raise exception 'The plan must be a JSON object.' using errcode = '22023';
  end if;
  -- A part of the plan this function does not know is refused, never dropped: a typo, or a server newer than this function, must be
  -- told. (Checked before the session is read, so a stale write with a typo is refused too.)
  select keys.k into unknown_key
  from jsonb_object_keys(patch) as keys(k)
  where keys.k not in ('ops', 'spots', 'slots', 'stops', 'stop_options', 'ledger', 'session', 'loaded_at', 'recomputed', 'banner_text')
  limit 1;
  if unknown_key is not null then
    raise exception 'The plan has a part this function does not know: %.', unknown_key using errcode = '22023';
  end if;
  if patch ? 'session' then
    if jsonb_typeof(patch -> 'session') <> 'object' then
      raise exception 'The session part of the plan must be a JSON object.' using errcode = '22023';
    end if;
    select keys.k into unknown_key
    from jsonb_object_keys(patch -> 'session') as keys(k)
    where keys.k not in ('status', 'meeting', 'banner', 'radius_meters', 'replan', 'plan_start_minute', 'order_note', 'order_suggestion', 'weather_kept')
    limit 1;
    if unknown_key is not null then
      raise exception 'The session part of the plan has a part this function does not know: %.', unknown_key using errcode = '22023';
    end if;
  end if;
  sp := coalesce(patch -> 'session', '{}'::jsonb);
  meeting := sp -> 'meeting';

  -- Rule 9, the lock order. A release deletes the session's votes and the slots' options. A guest's vote locks its own row, and the option it
  -- names through the foreign key, BEFORE its trigger (votes_guard_status) waits for a shared lock on the session; if this function took the
  -- session's lock first and then reached for those rows, each side would wait for the other and the database would end one with 40P01. So a
  -- release locks the votes and then the options of the session first, in a fixed order, and only then the session: a guest's write either
  -- finishes before this (and its trigger waits for nobody) or waits for these rows and then finds them gone. (A release can still meet another
  -- server write on the same session in another process in the opposite order; the server retries once on 40P01 and 40001.)
  if coalesce(jsonb_typeof(patch -> 'ops') = 'array' and exists (
    select 1 from jsonb_array_elements(patch -> 'ops') o where o ->> 'op' = 'release_meeting'
  ), false) then
    perform 1 from public.votes v join public.slots sl on sl.id = v.slot_id where sl.session_id = sid order by v.slot_id, v.user_id for update of v;
    perform 1 from public.slot_options o join public.slots sl on sl.id = o.slot_id where sl.session_id = sid order by o.slot_id, o.venue_id for update of o;
  end if;

  -- The session is locked until this function returns, so two writes cannot interleave.
  select * into s from public.sessions where id = sid for update;
  if not found or s.plan_version <> expected_version or s.status <> expected_status then
    return null;
  end if;

  -- When the server loaded the members the spots are worked out from (before the planner ran), else now.
  -- Never later than the database's own clock, so a server clock that runs fast cannot hide a later change.
  stamp := least(coalesce(nullif(patch ->> 'loaded_at', '')::timestamptz, now()), now());
  new_status := coalesce(sp ->> 'status', s.status);

  -- Rule 9: the host changes the meeting place. The op releases the meeting area and sends the session back to locating, and nothing else
  -- may do either: it is valid only on a move from voting or confirmed to locating (hint release_status), and that move is valid only with
  -- it (Rule 1 below). It carries the host's new choice of how the meeting point is picked. It cannot come with a meeting of its own.
  released := coalesce(jsonb_typeof(patch -> 'ops') = 'array' and exists (
    select 1 from jsonb_array_elements(patch -> 'ops') o where o ->> 'op' = 'release_meeting'
  ), false);
  if released then
    if not (s.status in ('voting', 'confirmed') and new_status = 'locating') then
      raise exception 'The meeting area is released only by moving a voting or confirmed session back to locating.'
        using errcode = 'P0001', hint = 'release_status';
    end if;
    if nullif(sp -> 'meeting', 'null'::jsonb) is not null then
      raise exception 'A released session has no meeting area, so the patch cannot bring one.'
        using errcode = 'P0001', hint = 'release_meeting';
    end if;
    select o ->> 'meet_by' into release_by from jsonb_array_elements(patch -> 'ops') o where o ->> 'op' = 'release_meeting' limit 1;
    if release_by is distinct from 'fairest' and release_by is distinct from 'known' then
      raise exception 'A release says how the meeting point is picked again: fairest or known.' using errcode = '22023';
    end if;
  end if;

  -- Rule 4: a pinned meeting area stays (unless the host is releasing it, Rule 9).
  if sp ? 'meeting' and s.meeting_method in ('voted', 'chosen') and not released
     and ((meeting ->> 'area_id') is distinct from s.meeting_area_id
          or (meeting ->> 'method') is distinct from s.meeting_method) then
    raise exception 'The meeting area was chosen and cannot be changed by a recompute.'
      using errcode = 'P0001', hint = 'area_pinned';
  end if;

  -- Rule 1: the moves are the host's confirm (or known place), from inviting or locating to voting, with an area; and, from stage 5,
  -- the plan's: the host's confirm of the stops (voting to confirmed), opening the plan again (confirmed to voting) and finishing
  -- the outing (confirmed to completed); and, with the op "release_meeting" (Rule 9), voting or confirmed back to locating. (The two-people
  -- check for leaving inviting comes after the ops below.)
  if new_status <> s.status then
    if not ((s.status in ('inviting', 'locating') and new_status = 'voting' and coalesce(meeting ->> 'area_id', '') <> '')
            or (s.status = 'voting' and new_status = 'confirmed')
            or (s.status = 'confirmed' and new_status in ('voting', 'completed'))
            or (released and s.status in ('voting', 'confirmed') and new_status = 'locating')) then
      raise exception 'A session cannot go from % to % this way.', s.status, new_status
        using errcode = 'P0001', hint = 'status_transition';
    end if;
    changed := true;
  end if;
  reopened := s.status = 'confirmed' and new_status = 'voting';

  -- Rule 5: a pin only with a confirm. Setting 'voted' or 'chosen' needs the host's move from inviting or locating to voting in this
  -- patch, or the same pin (method and area) already stored. (Stage 5's moves, voting to confirmed, confirmed to voting and confirmed to
  -- completed, never set a pin.)
  if (meeting ->> 'method') in ('voted', 'chosen')
     and not (s.status in ('inviting', 'locating') and new_status = 'voting')
     and not (s.meeting_method is not distinct from (meeting ->> 'method')
              and s.meeting_area_id is not distinct from (meeting ->> 'area_id')) then
    raise exception 'A meeting area is pinned only when the host confirms it.'
      using errcode = 'P0001', hint = 'pin_without_confirm';
  end if;

  -- Rule 7: slots and options are written only while the session is voting (after this patch).
  if patch ? 'slots' and new_status <> 'voting' then
    raise exception 'Slots and options are written only while the session is voting.'
      using errcode = 'P0001', hint = 'slots_status';
  end if;

  -- Rule 8 (stage 5, the plan): the stops, the details of a place put in a stop, the order note and the plan's start are written only
  -- while the session is confirmed (after this patch); the suggested order only while it is voting (it is cleared by opening the plan
  -- again, which this function does itself); the ledger only with the move to completed. Confirming needs stops.
  if (patch ? 'stops' or patch ? 'stop_options' or nullif(sp -> 'plan_start_minute', 'null'::jsonb) is not null
      or nullif(sp -> 'order_note', 'null'::jsonb) is not null
      or nullif(sp -> 'weather_kept', 'null'::jsonb) is not null) and new_status <> 'confirmed' then
    raise exception 'The stops and the order of the plan are written only while the session is confirmed.'
      using errcode = 'P0001', hint = 'stops_status';
  end if;
  if nullif(sp -> 'order_suggestion', 'null'::jsonb) is not null and not (s.status = 'voting' and new_status = 'voting') then
    raise exception 'The suggested order is written only while the session is voting.'
      using errcode = 'P0001', hint = 'order_status';
  end if;
  if patch ? 'ledger' and not (s.status = 'confirmed' and new_status = 'completed') then
    raise exception 'The ledger is written only when the outing is finished.'
      using errcode = 'P0001', hint = 'ledger_status';
  end if;
  if s.status = 'confirmed' and new_status = 'completed' and not (patch ? 'ledger') then
    raise exception 'Finishing the outing needs its ledger.'
      using errcode = 'P0001', hint = 'ledger_missing';
  end if;
  if s.status = 'voting' and new_status = 'confirmed'
     and (not (patch ? 'stops') or jsonb_typeof(patch -> 'stops') <> 'array' or jsonb_array_length(patch -> 'stops') = 0) then
    raise exception 'A plan needs at least one stop before it can be confirmed.'
      using errcode = 'P0001', hint = 'stops_missing';
  end if;

  -- Members, suggestions, approvals, votes and options, in the order given. Rule 6: the host is never opted out or removed here.
  for op in select * from jsonb_array_elements(coalesce(patch -> 'ops', '[]'::jsonb)) loop
    case op ->> 'op'
      when 'opt_out' then
        if (op ->> 'user_id')::uuid = s.host_id then
          raise exception 'The host cannot opt out.' using errcode = 'P0001', hint = 'host_member';
        end if;
        update public.session_members m set state = 'opted_out'
        where m.session_id = sid and m.user_id = (op ->> 'user_id')::uuid and m.state = 'joined';
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
        delete from public.spot_approvals a where a.session_id = sid and a.user_id = (op ->> 'user_id')::uuid;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
        delete from public.spot_suggestions g where g.session_id = sid and g.user_id = (op ->> 'user_id')::uuid;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
        delete from public.votes v using public.slots sl
        where sl.id = v.slot_id and sl.session_id = sid and v.user_id = (op ->> 'user_id')::uuid;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      when 'rejoin' then
        update public.session_members m set state = 'joined'
        where m.session_id = sid and m.user_id = (op ->> 'user_id')::uuid and m.state = 'opted_out';
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      when 'remove_member' then
        if (op ->> 'user_id')::uuid = s.host_id then
          raise exception 'The host cannot be removed.' using errcode = 'P0001', hint = 'host_member';
        end if;
        delete from public.session_members m where m.session_id = sid and m.user_id = (op ->> 'user_id')::uuid;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
        delete from public.votes v using public.slots sl
        where sl.id = v.slot_id and sl.session_id = sid and v.user_id = (op ->> 'user_id')::uuid;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      when 'suggest' then
        -- One suggestion per member. Suggesting the same again changes nothing; a different one counts as newest.
        insert into public.spot_suggestions as g (session_id, user_id, area_id, here)
        values (sid, (op ->> 'user_id')::uuid, op ->> 'area_id', coalesce((op ->> 'here')::boolean, false))
        on conflict (session_id, user_id) do update
          set area_id = excluded.area_id, here = excluded.here, created_at = now()
          where (g.area_id, g.here) is distinct from (excluded.area_id, excluded.here);
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      when 'unsuggest' then
        delete from public.spot_suggestions g where g.session_id = sid and g.user_id = (op ->> 'user_id')::uuid;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      when 'clear_approvals' then
        delete from public.spot_approvals a where a.session_id = sid;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      when 'clear_suggestions' then
        delete from public.spot_suggestions g where g.session_id = sid;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      when 'clear_votes' then
        -- Rule 7: votes are cleared only in a voting session (or one that this patch opens again: stage 5's re-plan). The meeting
        -- area moved, so every vote is for a place that no longer belongs to it.
        if not (s.status = 'voting' or reopened) then
          raise exception 'Votes are cleared only while the session is voting.' using errcode = 'P0001', hint = 'slots_status';
        end if;
        delete from public.votes v using public.slots sl where sl.id = v.slot_id and sl.session_id = sid;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      when 'release_meeting' then
        -- Rule 9. Everything that belonged to the meeting place goes in this one write; the starts and ends people shared, their exact
        -- places, their picks and who is in the session stay. The votes are deleted first, then the slots (the options go by foreign key).
        delete from public.votes v using public.slots sl where sl.id = v.slot_id and sl.session_id = sid;
        delete from public.slots sl where sl.session_id = sid;
        delete from public.stops st where st.session_id = sid;
        delete from public.spot_approvals a where a.session_id = sid;
        delete from public.spot_suggestions g where g.session_id = sid;
        delete from public.session_spots x where x.session_id = sid;
        -- (The members' own minutes to the old area are left as they are: nothing reads them while the session is locating, the next
        -- confirm writes them again, and writing them here would move every member's updated_at past the new spots' computed_at, which a
        -- page reads as "the spots were not worked out again".)
        changed := true;
      when 'swap_option' then
        -- Rule 7 again. The place changes in place, so the votes for it follow it; when the other place is already an option, the
        -- votes move to it and this one goes.
        if s.status <> 'voting' then
          raise exception 'An option is swapped only while the session is voting.' using errcode = 'P0001', hint = 'slots_status';
        end if;
        select sl.id into v_slot from public.slots sl where sl.session_id = sid and sl.category = op ->> 'category';
        if v_slot is null then
          raise exception 'This session has no % slot.', op ->> 'category' using errcode = 'P0001', hint = 'slot_missing';
        end if;
        if (op ->> 'from') is not distinct from (op ->> 'to') then
          -- The same place: nothing to swap. (Without this the votes would move onto the place, and then the place would be deleted
          -- as "the other one", taking the option and every vote with it.)
          null;
        elsif exists (select 1 from public.slot_options o where o.slot_id = v_slot and o.venue_id = op ->> 'to') then
          update public.votes v set venue_id = op ->> 'to' where v.slot_id = v_slot and v.venue_id = op ->> 'from';
          get diagnostics hit = row_count;
          if hit > 0 then changed := true; end if;
          delete from public.slot_options o where o.slot_id = v_slot and o.venue_id = op ->> 'from';
          get diagnostics hit = row_count;
          if hit > 0 then changed := true; end if;
        else
          update public.slot_options o set venue_id = op ->> 'to' where o.slot_id = v_slot and o.venue_id = op ->> 'from';
          get diagnostics hit = row_count;
          if hit > 0 then changed := true; end if;
        end if;
      when 'propose' then
        -- Stage 5 (Roam): a joined member puts a place forward as the next stop, while the plan is confirmed. A place already in the
        -- plan cannot be proposed; one already waiting stays its first proposer's and this changes nothing. The limits (a full plan of
        -- 8 stops, 3 waiting for a member, 10 for the session) are checked here, under the session's lock.
        if not (s.status = 'confirmed' and new_status = 'confirmed') then
          raise exception 'A place is proposed only while the plan is confirmed.' using errcode = 'P0001', hint = 'proposal_status';
        end if;
        if not exists (select 1 from public.session_members m where m.session_id = sid and m.user_id = (op ->> 'user_id')::uuid and m.state = 'joined') then
          raise exception 'Only a joined member can propose a place.' using errcode = 'P0001', hint = 'proposal_member';
        end if;
        if exists (select 1 from public.stops st where st.session_id = sid and st.venue_id = op ->> 'venue_id') then
          raise exception 'That place is already in the plan.' using errcode = 'P0001', hint = 'already_a_stop';
        end if;
        if not exists (select 1 from public.stop_proposals p where p.session_id = sid and p.venue_id = op ->> 'venue_id' and p.status = 'pending') then
          if (select count(*) from public.stops st where st.session_id = sid) >= 8 then
            raise exception 'The plan already has the most stops it can hold.' using errcode = 'P0001', hint = 'plan_full';
          end if;
          if (select count(*) from public.stop_proposals p where p.session_id = sid and p.status = 'pending') >= 10
             or (select count(*) from public.stop_proposals p where p.session_id = sid and p.status = 'pending' and p.proposed_by = (op ->> 'user_id')::uuid) >= 3 then
            raise exception 'Too many places are waiting for an answer.' using errcode = 'P0001', hint = 'too_many_proposals';
          end if;
          insert into public.stop_proposals (id, session_id, venue_id, proposed_by)
          values (coalesce(nullif(op ->> 'id', '')::uuid, gen_random_uuid()), sid, op ->> 'venue_id', (op ->> 'user_id')::uuid);
          changed := true;
        end if;
      when 'resolve_proposal' then
        -- The host's answer to a proposal, or the proposer taking it back ("status" is accepted or dismissed). The stop an accepted
        -- proposal becomes is in the same patch's stops. One already answered changes nothing.
        if not (s.status = 'confirmed' and new_status = 'confirmed') then
          raise exception 'A proposal is answered only while the plan is confirmed.' using errcode = 'P0001', hint = 'proposal_status';
        end if;
        if (op ->> 'status') is distinct from 'accepted' and (op ->> 'status') is distinct from 'dismissed' then
          raise exception 'A proposal is answered as accepted or dismissed.' using errcode = '22023';
        end if;
        update public.stop_proposals p
        set status = op ->> 'status', resolved_at = now(), resolved_by = nullif(op ->> 'by', '')::uuid
        where p.id = (op ->> 'proposal_id')::uuid and p.session_id = sid and p.status = 'pending';
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      else
        raise exception 'Unknown operation %.', op ->> 'op' using errcode = '22023';
    end case;
  end loop;

  -- Rule 2: leaving inviting needs two joined members, counted after the ops.
  if s.status = 'inviting' and new_status <> s.status
     and (select count(*) from public.session_members m where m.session_id = sid and m.state = 'joined') < 2 then
    raise exception 'A session needs at least two people before it can start.'
      using errcode = 'P0001', hint = 'needs_two_people';
  end if;

  -- The spots, as a difference.
  if patch ? 'spots' then
    if jsonb_typeof(patch -> 'spots') <> 'array' then
      raise exception 'The spots must be a JSON list.' using errcode = '22023';
    end if;

    -- Does the deletion below take an approval with it? (Approvals the ops above removed are already gone.)
    select exists (
      select 1 from public.spot_approvals a
      where a.session_id = sid
        and not exists (select 1 from jsonb_array_elements(patch -> 'spots') e where e ->> 'area_id' = a.area_id)
    ) into lost_approvals;

    delete from public.session_spots x
    where x.session_id = sid
      and not exists (select 1 from jsonb_array_elements(patch -> 'spots') e where e ->> 'area_id' = x.area_id);
    get diagnostics hit = row_count;
    if hit > 0 then changed := true; end if;

    -- A listed spot is written only if something about it changed, so its time of working out is left alone otherwise. When it
    -- is written, its time of working out is when the inputs were loaded (stamp), not when the write happens.
    for item in select * from jsonb_array_elements(patch -> 'spots') loop
      insert into public.session_spots as x (session_id, area_id, rank, worst_minutes, mean_minutes, travel_minutes, approximate, computed_at)
      values (sid, item ->> 'area_id', (item ->> 'rank')::integer, (item ->> 'worst_minutes')::numeric,
              (item ->> 'mean_minutes')::numeric, coalesce(item -> 'travel_minutes', '{}'::jsonb),
              coalesce((item ->> 'approximate')::boolean, false), stamp)
      on conflict (session_id, area_id) do update
        set rank = excluded.rank, worst_minutes = excluded.worst_minutes, mean_minutes = excluded.mean_minutes,
            travel_minutes = excluded.travel_minutes, approximate = excluded.approximate, computed_at = stamp
        where (x.rank, x.worst_minutes, x.mean_minutes, x.travel_minutes, x.approximate)
              is distinct from (excluded.rank, excluded.worst_minutes, excluded.mean_minutes, excluded.travel_minutes, excluded.approximate);
      get diagnostics hit = row_count;
      if hit > 0 then changed := true; end if;
    end loop;

    -- A run that worked the spots out again with the planner says so (`recomputed`): the list is now as current as any member's
    -- row, even when no number moved, so the time of working out is brought forward on every spot (to when the inputs were
    -- loaded). That is not a change: the version stays. (A run that only kept the stored spots does not say it, so it never
    -- hides a start that was not priced.)
    if coalesce((patch ->> 'recomputed')::boolean, false) then
      update public.session_spots x set computed_at = stamp where x.session_id = sid and x.computed_at < stamp;
    end if;

    -- The group is told only when the deletion removed an approval.
    if lost_approvals then
      banner_text := coalesce(nullif(patch ->> 'banner_text', ''), 'Some spots are no longer on the list, so approvals for them were removed.');
    end if;
  end if;

  -- The slots and their options, as a difference. A kept option keeps its votes; a dropped one takes them by foreign key.
  if patch ? 'slots' then
    if jsonb_typeof(patch -> 'slots') <> 'array' then
      raise exception 'The slots must be a JSON list.' using errcode = '22023';
    end if;
    for item in select * from jsonb_array_elements(patch -> 'slots') loop
      if jsonb_typeof(item) <> 'object' then
        raise exception 'Each slot must be a JSON object.' using errcode = '22023';
      end if;
      v_category := item ->> 'category';

      if coalesce((item ->> 'remove')::boolean, false) then
        delete from public.slots sl where sl.session_id = sid and sl.category = v_category;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
        continue;
      end if;

      select * into slot_row from public.slots sl where sl.session_id = sid and sl.category = v_category;
      if not found then
        n_deleted := coalesce((item ->> 'deleted')::boolean, false);
        insert into public.slots (session_id, category, start_minute, duration_minutes, picks, is_last, deleted, details)
        values (sid, v_category, (item ->> 'start_minute')::integer, (item ->> 'duration_minutes')::integer,
                coalesce((item ->> 'picks')::integer, 0), coalesce((item ->> 'is_last')::boolean, false), n_deleted,
                coalesce(item -> 'details', '{}'::jsonb))
        returning id into v_slot;
        changed := true;
      else
        v_slot := slot_row.id;
        n_start := coalesce((item ->> 'start_minute')::integer, slot_row.start_minute);
        n_duration := coalesce((item ->> 'duration_minutes')::integer, slot_row.duration_minutes);
        n_picks := coalesce((item ->> 'picks')::integer, slot_row.picks);
        n_last := coalesce((item ->> 'is_last')::boolean, slot_row.is_last);
        n_deleted := coalesce((item ->> 'deleted')::boolean, slot_row.deleted);
        n_details := case when item ? 'details' then item -> 'details' else slot_row.details end;
        update public.slots sl
        set start_minute = n_start, duration_minutes = n_duration, picks = n_picks, is_last = n_last, deleted = n_deleted, details = n_details
        where sl.id = v_slot
          and (sl.start_minute, sl.duration_minutes, sl.picks, sl.is_last, sl.deleted, sl.details)
              is distinct from (n_start, n_duration, n_picks, n_last, n_deleted, n_details);
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      end if;

      if n_deleted then
        -- A removed slot has no options, and so no votes.
        delete from public.slot_options o where o.slot_id = v_slot;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      elsif item ? 'options' then
        if jsonb_typeof(item -> 'options') <> 'array' then
          raise exception 'The options of a slot must be a JSON list.' using errcode = '22023';
        end if;
        delete from public.slot_options o
        where o.slot_id = v_slot
          and not exists (select 1 from jsonb_array_elements(item -> 'options') e where e ->> 'venue_id' = o.venue_id);
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
        for opt in select * from jsonb_array_elements(item -> 'options') loop
          insert into public.slot_options as o (slot_id, venue_id, rank, score, source, added_by, details)
          values (v_slot, opt ->> 'venue_id', (opt ->> 'rank')::integer, (opt ->> 'score')::numeric,
                  coalesce(opt ->> 'source', 'planner'), (opt ->> 'added_by')::uuid, coalesce(opt -> 'details', '{}'::jsonb))
          on conflict (slot_id, venue_id) do update
            set rank = excluded.rank, score = excluded.score, details = excluded.details
            where (o.rank, o.score, o.details) is distinct from (excluded.rank, excluded.score, excluded.details);
          get diagnostics hit = row_count;
          if hit > 0 then changed := true; end if;
        end loop;
      end if;
    end loop;

    -- Votes belong to the person, not to their membership, so nothing took a leaver's or an opted-out member's votes with them if
    -- they were cast a moment before the change: they go now.
    delete from public.votes v using public.slots sl
    where sl.id = v.slot_id and sl.session_id = sid
      and not exists (select 1 from public.session_members m where m.session_id = sid and m.user_id = v.user_id and m.state = 'joined');
    get diagnostics hit = row_count;
    if hit > 0 then changed := true; end if;
  end if;

  -- ── Stage 5: the plan ────────────────────────────────────────────────────
  -- Leaving confirmed: the proposals still waiting are dismissed (nobody is left to answer them). Opening the plan again also takes
  -- the stops away (the order note and the plan's start go in the session update below).
  if s.status = 'confirmed' and new_status <> 'confirmed' then
    update public.stop_proposals p set status = 'dismissed', resolved_at = now()
    where p.session_id = sid and p.status = 'pending';
    if reopened then
      delete from public.stops st where st.session_id = sid;
    end if;
  end if;

  -- Rule 8, the checks that need the rows: confirming needs two joined people who voted.
  if s.status = 'voting' and new_status = 'confirmed' then
    select count(distinct v.user_id) into v_count
    from public.votes v
    join public.slots sl on sl.id = v.slot_id and sl.session_id = sid and not sl.deleted
    join public.session_members m on m.session_id = sid and m.user_id = v.user_id and m.state = 'joined';
    if v_count < 2 then
      raise exception 'At least two people need to vote before the plan can be confirmed.'
        using errcode = 'P0001', hint = 'not_enough_votes';
    end if;
  end if;

  -- The stops, as a difference: a listed stop with an id is updated where it differs, one without an id is made, and one not listed
  -- goes. Each item is the complete row. The order (seq) is checked at the end: 0, 1, 2, ... with no gap and no repeat, and no place
  -- twice. A plan has up to 8 stops and, once confirmed, at least one.
  if patch ? 'stops' then
    if jsonb_typeof(patch -> 'stops') <> 'array' then
      raise exception 'The stops must be a JSON list.' using errcode = '22023';
    end if;
    if jsonb_array_length(patch -> 'stops') > 8 then
      raise exception 'A plan holds up to 8 stops.' using errcode = 'P0001', hint = 'too_many_stops';
    end if;
    delete from public.stops st
    where st.session_id = sid
      and not exists (select 1 from jsonb_array_elements(patch -> 'stops') e where e ->> 'id' = st.id::text);
    get diagnostics hit = row_count;
    if hit > 0 then changed := true; end if;
    for item in select * from jsonb_array_elements(patch -> 'stops') loop
      if jsonb_typeof(item) <> 'object' then
        raise exception 'Each stop must be a JSON object.' using errcode = '22023';
      end if;
      if nullif(item ->> 'slot_id', '') is not null
         and not exists (select 1 from public.slots sl where sl.id = (item ->> 'slot_id')::uuid and sl.session_id = sid
                         and (not sl.deleted or s.status <> 'voting')) then
        raise exception 'A stop names a slot that is not in this session.' using errcode = 'P0001', hint = 'stop_slot';
      end if;
      if nullif(item ->> 'id', '') is not null then
        select * into stop_row from public.stops st where st.id = (item ->> 'id')::uuid and st.session_id = sid;
        if not found then
          raise exception 'A stop is not in this session.' using errcode = 'P0001', hint = 'stop_missing';
        end if;
        update public.stops st
        set seq = (item ->> 'seq')::integer, slot_id = nullif(item ->> 'slot_id', '')::uuid, category = item ->> 'category',
            venue_id = item ->> 'venue_id', planned_start_minute = (item ->> 'planned_start_minute')::integer,
            duration_minutes = (item ->> 'duration_minutes')::integer, travel_mode = item ->> 'travel_mode',
            travel_minutes = (item ->> 'travel_minutes')::integer, not_before_minute = (item ->> 'not_before_minute')::integer
        where st.id = stop_row.id
          and (st.seq, st.slot_id, st.category, st.venue_id, st.planned_start_minute, st.duration_minutes, st.travel_mode, st.travel_minutes, st.not_before_minute)
              is distinct from ((item ->> 'seq')::integer, nullif(item ->> 'slot_id', '')::uuid, item ->> 'category', item ->> 'venue_id',
                                (item ->> 'planned_start_minute')::integer, (item ->> 'duration_minutes')::integer, item ->> 'travel_mode',
                                (item ->> 'travel_minutes')::integer, (item ->> 'not_before_minute')::integer);
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      else
        insert into public.stops (session_id, seq, slot_id, category, venue_id, planned_start_minute, duration_minutes, travel_mode, travel_minutes, not_before_minute)
        values (sid, (item ->> 'seq')::integer, nullif(item ->> 'slot_id', '')::uuid, item ->> 'category', item ->> 'venue_id',
                (item ->> 'planned_start_minute')::integer, (item ->> 'duration_minutes')::integer, item ->> 'travel_mode',
                (item ->> 'travel_minutes')::integer, (item ->> 'not_before_minute')::integer);
        changed := true;
      end if;
    end loop;
    select count(*), count(distinct st.seq), coalesce(max(st.seq), -1), count(distinct st.venue_id)
    into v_count, v_distinct, v_max, v_venues
    from public.stops st where st.session_id = sid;
    if v_count = 0 then
      raise exception 'A confirmed plan keeps at least one stop.' using errcode = 'P0001', hint = 'last_stop';
    end if;
    if v_distinct <> v_count or v_max <> v_count - 1 then
      raise exception 'The stops must be numbered 0, 1, 2 ... with no gap and no repeat.' using errcode = 'P0001', hint = 'stop_order';
    end if;
    if v_venues <> v_count then
      raise exception 'A place cannot be two stops.' using errcode = 'P0001', hint = 'stop_duplicate';
    end if;
    -- Confirming: every stop is the place the group chose for a slot, so it must be an option of that slot.
    if s.status = 'voting' and exists (
      select 1 from public.stops st
      where st.session_id = sid
        and (st.slot_id is null or not exists (select 1 from public.slot_options o where o.slot_id = st.slot_id and o.venue_id = st.venue_id))
    ) then
      raise exception 'A stop is not one of the places the group could vote for.' using errcode = 'P0001', hint = 'stop_not_option';
    end if;
    -- Confirming, and the votes are read again under the session's lock: every stop must still be a leader of its slot (a tie is a
    -- leader), counting only joined people's votes, and every slot somebody voted in must have its stop. A vote cast after the host
    -- looked at the tally and before the lock moves the leader, and the host is told to look again. (votes_guard_status below keeps a
    -- browser's vote out once the plan is confirmed.)
    if s.status = 'voting' and new_status = 'confirmed' then
      with tally as (
        select v.slot_id, v.venue_id, count(*) as n
        from public.votes v
        join public.slots sl on sl.id = v.slot_id and sl.session_id = sid and not sl.deleted
        join public.session_members m on m.session_id = sid and m.user_id = v.user_id and m.state = 'joined'
        group by v.slot_id, v.venue_id
      )
      select exists (
        select 1 from public.stops st
        where st.session_id = sid and st.slot_id is not null
          and coalesce((select t.n from tally t where t.slot_id = st.slot_id and t.venue_id = st.venue_id), 0)
              < greatest(1, (select coalesce(max(t.n), 0) from tally t where t.slot_id = st.slot_id))
      ) or exists (
        select 1 from tally t
        where not exists (select 1 from public.stops st where st.session_id = sid and st.slot_id = t.slot_id)
      ) into v_stale;
      if v_stale then
        raise exception 'The votes changed while the plan was being confirmed.' using errcode = 'P0001', hint = 'stale_tally';
      end if;
    end if;
  end if;

  -- The details of a place put in a stop (a replaced stop): the new place is kept as an option of the stop's slot with what the
  -- planner said about it, and the place it replaces leaves the slot's options (its votes go by foreign key). Nothing else about the
  -- slot changes.
  if patch ? 'stop_options' then
    if jsonb_typeof(patch -> 'stop_options') <> 'array' then
      raise exception 'The stop options must be a JSON list.' using errcode = '22023';
    end if;
    for item in select * from jsonb_array_elements(patch -> 'stop_options') loop
      v_slot := (item ->> 'slot_id')::uuid;
      if not exists (select 1 from public.slots sl where sl.id = v_slot and sl.session_id = sid) then
        raise exception 'A stop option names a slot that is not in this session.' using errcode = 'P0001', hint = 'stop_slot';
      end if;
      if nullif(item ->> 'replaces', '') is not null and (item ->> 'replaces') is distinct from (item ->> 'venue_id') then
        delete from public.slot_options o where o.slot_id = v_slot and o.venue_id = item ->> 'replaces';
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      end if;
      -- A stop changed to another kind of place has no place to keep in this slot: only the old place leaves ("venue_id" is null).
      if nullif(item ->> 'venue_id', '') is not null then
        insert into public.slot_options as o (slot_id, venue_id, rank, score, source, added_by, details)
        values (v_slot, item ->> 'venue_id', (item ->> 'rank')::integer, (item ->> 'score')::numeric,
                coalesce(item ->> 'source', 'planner'), (item ->> 'added_by')::uuid, coalesce(item -> 'details', '{}'::jsonb))
        on conflict (slot_id, venue_id) do update
          set rank = excluded.rank, score = excluded.score, details = excluded.details
          where (o.rank, o.score, o.details) is distinct from (excluded.rank, excluded.score, excluded.details);
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      end if;
    end loop;
  end if;

  -- The ledger, written once when the outing is finished: one row for each person in it, and the deltas sum to zero (the ledger moves
  -- effort around, it never makes it). Each person must be a joined member. A row that is already there stays (a retry changes nothing).
  if patch ? 'ledger' then
    if jsonb_typeof(patch -> 'ledger') <> 'array' then
      raise exception 'The ledger must be a JSON list.' using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_array_elements(patch -> 'ledger') e
      where not exists (select 1 from public.session_members m where m.session_id = sid and m.user_id = (e ->> 'user_id')::uuid and m.state = 'joined')
    ) then
      raise exception 'The ledger names someone who is not a joined member.' using errcode = 'P0001', hint = 'ledger_member';
    end if;
    if (select count(*) from jsonb_array_elements(patch -> 'ledger') e)
       <> (select count(distinct (e ->> 'user_id')::uuid) from jsonb_array_elements(patch -> 'ledger') e) then
      raise exception 'The ledger names somebody twice.' using errcode = 'P0001', hint = 'ledger_duplicate';
    end if;
    if (select coalesce(sum((e ->> 'delta_from_mean')::numeric), 0) from jsonb_array_elements(patch -> 'ledger') e) <> 0 then
      raise exception 'The ledger''s deltas must sum to zero.' using errcode = 'P0001', hint = 'ledger_sum';
    end if;
    insert into public.commute_ledger (session_id, user_id, minutes_in, minutes_between, minutes_home, delta_from_mean)
    select sid, (e ->> 'user_id')::uuid, (e ->> 'minutes_in')::integer, coalesce((e ->> 'minutes_between')::integer, 0),
           (e ->> 'minutes_home')::integer, (e ->> 'delta_from_mean')::numeric
    from jsonb_array_elements(patch -> 'ledger') e
    on conflict (session_id, user_id) do nothing;
    get diagnostics hit = row_count;
    if hit > 0 then changed := true; end if;
    -- The stored ledger, rows that were there already included, still sums to zero.
    if (select coalesce(sum(l.delta_from_mean), 0) from public.commute_ledger l where l.session_id = sid) <> 0 then
      raise exception 'The ledger''s deltas must sum to zero.' using errcode = 'P0001', hint = 'ledger_sum';
    end if;
  end if;

  -- Rule 3: the session section is a change only where a value differs from the stored row. The meeting is compared as it would
  -- be written, after rounding; the banner as stored.
  if sp ? 'meeting' then
    meeting_changed := (s.meeting_area_id, s.meeting_method, s.meeting_max_minutes, s.meeting_total_minutes, s.meeting_count, s.meeting_approximate)
      is distinct from (meeting ->> 'area_id', meeting ->> 'method', round((meeting ->> 'max_minutes')::numeric)::integer,
                        round((meeting ->> 'total_minutes')::numeric)::integer, round((meeting ->> 'count')::numeric)::integer,
                        (meeting ->> 'approximate')::boolean);
  end if;
  if sp ? 'meeting' and jsonb_typeof(meeting) = 'object' and meeting ? 'travel' then
    travel_changed := exists (
      select 1 from public.session_members m
      where m.session_id = sid and m.state = 'joined' and m.travel_minutes is not null
        and m.travel_minutes is distinct from case
          when (meeting -> 'travel') ? (m.user_id)::text then round(((meeting -> 'travel') ->> (m.user_id)::text)::numeric)::integer
          else null end
    );
  end if;
  -- The banner rule (documented, deliberate): a notice is a change only where it differs from the stored one apart from its time ("at"),
  -- so the same words sent again after a run that moved nothing are not written, keep their old time, and are not shown again to
  -- someone who dismissed them; a different notice, or none ("banner": null), is a change. A notice sent without a time is stamped
  -- with the database's clock when it is written; one sent with a time is written as it is.
  if sp ? 'banner' then
    banner_new := nullif(sp -> 'banner', 'null'::jsonb);
    -- A banner sent without its time is stamped by the database's clock when it is written, so a newer notice always has a later
    -- `at` than an older one. It differs from the stored one only apart from that time.
    if banner_new is not null and jsonb_typeof(banner_new) = 'object' and not (banner_new ? 'at') then
      banner_stamped := true;
      banner_changed := (s.banner - 'at') is distinct from banner_new;
    else
      banner_changed := s.banner is distinct from banner_new;
    end if;
    -- A release always brings its notice afresh, with a new time, even when the words match the stored ones (an earlier release by the
    -- same host), so a person who dismissed that one is told again.
    if released and banner_new is not null then
      banner_changed := true;
    end if;
  elsif released then
    -- A release that brings no notice clears the old one: it was about the meeting place that has just gone.
    banner_new := null;
    banner_changed := s.banner is not null;
  end if;
  if sp ? 'radius_meters' then
    radius_changed := s.radius_meters is distinct from (sp ->> 'radius_meters')::integer;
  end if;
  -- Stage 5: the order note (a sentence and who chose the order, as a pair), the suggested order, the plan's start and the pending
  -- "plan again?" prompt, each a change only where it differs from the stored value. All four are cleared when the plan is opened again
  -- (below).
  if sp ? 'order_note' then
    note_new := nullif(sp -> 'order_note', 'null'::jsonb);
    if note_new is not null and jsonb_typeof(note_new) <> 'object' then
      raise exception 'The order note must be a JSON object or null.' using errcode = '22023';
    end if;
    note_changed := (s.order_reason, s.order_source) is distinct from (note_new ->> 'reason', note_new ->> 'source');
  end if;
  if sp ? 'order_suggestion' then
    suggestion_new := nullif(sp -> 'order_suggestion', 'null'::jsonb);
    suggestion_changed := s.order_suggestion is distinct from suggestion_new;
  end if;
  if sp ? 'plan_start_minute' then
    start_changed := s.plan_start_minute is distinct from (sp ->> 'plan_start_minute')::integer;
  end if;
  if sp ? 'weather_kept' then
    kept_new := nullif(sp -> 'weather_kept', 'null'::jsonb);
    if kept_new is not null and jsonb_typeof(kept_new) <> 'object' then
      raise exception 'The kept rain warnings must be a JSON object or null.' using errcode = '22023';
    end if;
    kept_changed := s.weather_kept is distinct from kept_new;
  end if;
  if sp ? 'replan' then
    replan_new := nullif(sp -> 'replan', 'null'::jsonb);
    if replan_new is not null and jsonb_typeof(replan_new) <> 'object' then
      raise exception 'The re-plan prompt must be a JSON object or null.' using errcode = '22023';
    end if;
    replan_changed := s.replan is distinct from replan_new;
  end if;
  if meeting_changed or travel_changed or banner_changed or radius_changed or banner_text is not null
     or note_changed or suggestion_changed or start_changed or replan_changed or kept_changed then
    changed := true;
  end if;
  if not changed then
    return s.plan_version;
  end if;

  -- Each joined member's own minutes to the confirmed area, written only where they differ from the stored minutes, so a member's row
  -- (and its updated_at) is not touched by a patch that repeats it.
  if sp ? 'meeting' and jsonb_typeof(meeting) = 'object' and meeting ? 'travel' then
    update public.session_members m
    set travel_minutes = case
      when (meeting -> 'travel') ? (m.user_id)::text then round(((meeting -> 'travel') ->> (m.user_id)::text)::numeric)::integer
      else null end
    where m.session_id = sid and m.state = 'joined'
      and m.travel_minutes is distinct from case
        when (meeting -> 'travel') ? (m.user_id)::text then round(((meeting -> 'travel') ->> (m.user_id)::text)::numeric)::integer
        else null end;
  end if;

  update public.sessions set
    status = new_status,
    radius_meters = case when radius_changed then (sp ->> 'radius_meters')::integer else radius_meters end,
    meeting_area_id = case when released then null when meeting_changed then meeting ->> 'area_id' else meeting_area_id end,
    meeting_method = case when released then null when meeting_changed then meeting ->> 'method' else meeting_method end,
    meeting_max_minutes = case when released then null when meeting_changed then round((meeting ->> 'max_minutes')::numeric)::integer else meeting_max_minutes end,
    meeting_total_minutes = case when released then null when meeting_changed then round((meeting ->> 'total_minutes')::numeric)::integer else meeting_total_minutes end,
    meeting_count = case when released then null when meeting_changed then round((meeting ->> 'count')::numeric)::integer else meeting_count end,
    meeting_approximate = case when released then null when meeting_changed then (meeting ->> 'approximate')::boolean else meeting_approximate end,
    meeting_computed_at = case when released then null
                               when meeting_changed and meeting ->> 'area_id' is not null then now()
                               when meeting_changed then null else meeting_computed_at end,
    meet_by = case when released then release_by else meet_by end,
    banner = case
      when banner_text is not null then jsonb_build_object('text', banner_text, 'at', (extract(epoch from now()) * 1000)::bigint, 'approvalsRemoved', true)
      when banner_changed and banner_stamped then banner_new || jsonb_build_object('at', (extract(epoch from now()) * 1000)::bigint)
      when banner_changed then banner_new
      else banner end,
    -- Opening the plan again clears what belonged to the confirmed plan: the order note, the suggested order, the plan's start and
    -- the prompt. Leaving or entering confirmed clears the prompt too. Finishing the outing stamps its time once.
    order_reason = case when reopened or released then null when sp ? 'order_note' then note_new ->> 'reason' else order_reason end,
    order_source = case when reopened or released then null when sp ? 'order_note' then note_new ->> 'source' else order_source end,
    order_suggestion = case when reopened or released then null when sp ? 'order_suggestion' then suggestion_new else order_suggestion end,
    plan_start_minute = case when reopened or released then null when sp ? 'plan_start_minute' then (sp ->> 'plan_start_minute')::integer else plan_start_minute end,
    replan = case when released then null
                  when s.status = 'confirmed' and new_status <> 'confirmed' then null
                  when s.status = 'voting' and new_status = 'confirmed' then null
                  when sp ? 'replan' then replan_new else replan end,
    -- The rain warnings the host kept belong to the confirmed plan's stops: they go when the plan is opened again or ends, and when it
    -- is confirmed afresh.
    weather_kept = case when released then null
                        when s.status = 'confirmed' and new_status <> 'confirmed' then null
                        when s.status = 'voting' and new_status = 'confirmed' then null
                        when sp ? 'weather_kept' then kept_new else weather_kept end,
    completed_at = case when s.status = 'confirmed' and new_status = 'completed' then now() else completed_at end,
    plan_version = plan_version + 1
  where id = sid;

  return s.plan_version + 1;
end;
$$;

-- The server only. Postgres lets everyone call a new function by default, so take that away first.
revoke execute on function public.apply_session_plan(uuid, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_session_plan(uuid, bigint, text, jsonb) to service_role;
