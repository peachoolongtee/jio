-- Jio migration, stage 4 (server half): apply_session_plan() learns to write a session's slots and options, the radius, and the
-- votes that go with a member or a moved meeting area.
--
-- What it changes:
--   1. The length limit of a place's id, raised from 80 to 160 characters on slot_options.venue_id and stops.venue_id (and on
--      stop_proposals.venue_id when slice d is applied). The 32 hawker centres saved from OneMap have ids of 86 characters
--      ('onemap_ssot_hawkercentres_<street>-<block>-<name>'), and they are the places a halal group is offered, so they must be able to be
--      options. votes.venue_id has no check of its own: it is held to slot_options by its foreign key. The checks are replaced under the
--      names Postgres gave them (<table>_venue_id_check), so db/schema.sql, which carries them inline, is the same.
--   2. One function, replaced (create or replace, same signature, same permissions).
-- It needs 20261011000200 (slots.details) and the stage 3 function (20261020000000) applied.
--
-- Everything stage 3 did is unchanged, and is tested again by db/tests/apply_session_plan.sql (steps 1 to 76 are the stage 3 steps,
-- word for word). What is added, all optional parts of the patch:
--
--   ops          { "op": "clear_votes" }                          delete every vote of the session (the meeting area moved)
--                { "op": "swap_option", "category": ..., "from": ..., "to": ... }
--                                                                 a slot's option becomes another place, in place: its votes follow it.
--                                                                 When "to" is already an option of the slot, the votes move to it and
--                                                                 "from" is deleted. Doing it again changes nothing.
--                opt_out and remove_member also delete the member's votes of this session (votes belong to the person, not to their
--                membership, so no foreign key would take them).
--   slots        the slots the session should have, one item per category, as a difference (never delete-everything-then-insert, which
--                would delete every vote):
--                  { "category": "eat", "start_minute": 720, "duration_minutes": 90, "picks": 2, "is_last": false, "deleted": false,
--                    "details": {...}, "options": [ { "venue_id": ..., "rank": 1, "score": 12.5, "source": "planner" | "member",
--                                                     "added_by": <user id> | null, "details": {...} } ] }
--                A slot is made when the category has none (it then needs start_minute and duration_minutes); otherwise only the fields
--                the item carries change. "options" is the slot's complete list: a listed place is inserted, or has its rank, score and
--                details updated (its source, who added it and its votes stay); an unlisted place is deleted and takes its votes by foreign
--                key. A slot without "options" keeps its options. A deleted slot (stored or in the item) has none. { "category": ...,
--                "remove": true } deletes the slot row. After the options, the votes of anyone who is not a joined member are deleted.
--                Rule 7: slots are written only when the session is voting after the patch (hint slots_status).
--   session      "radius_meters": null or 100 to 3000 (the table's own check); a change like any other.
--                "meeting" also counts as a change when a joined member's stored minutes (when they have any) differ from the minutes in
--                its "travel", even though the longest trip, the total and the count are the same: two people can swap their times. A
--                member whose minutes were never stored does not count, so a patch that repeats the stored figures still changes nothing.
--                "banner" without "at" is stamped with the database's clock when it is written, and counts as a change only where it
--                differs from the stored banner apart from "at". A banner with "at" is written as it was before.
--
-- Rule 7 also covers the two new ops that act on slots and votes: clear_votes and swap_option are refused unless the stored status
-- is voting (hint slots_status). A swap names a slot that does not exist: hint slot_missing.
--
-- It raises exceptions with errcode P0001 and a hint for the rules, and returns null when the session moved on (nothing written),
-- the stored version when the patch changes nothing, and the version after the write otherwise. All of that is as in stage 3.
--
-- Who may call it: the service role only (the server). A browser cannot.
--
-- Run it once as ONE transaction. Idempotent (a check dropped if it is there and made again; create or replace). db/schema.sql carries the same statement. Test it first with
-- db/tests/apply_session_plan.sql inside a transaction that rolls back: to try it before applying, put this file's statements
-- and the test file's statements in one transaction, in that order, and drop the test file's own begin and rollback lines
-- (or run the test after applying the migration, which is how the stage 3 function was tried).
--
-- How to call it (backend/src/db/sessions.js does this):
--   const { data } = await serviceClient.rpc('apply_session_plan', { sid, expected_version: 4, expected_status: 'voting', patch })

-- A place's id may be up to 160 characters. Each table is named once, so the existing check (80) is replaced in one statement; a table
-- that is not on the project yet (stop_proposals comes with slice d, 20261011000300, which carries 160 already) is skipped.
alter table public.slot_options
  drop constraint if exists slot_options_venue_id_check,
  add constraint slot_options_venue_id_check check (char_length(venue_id) <= 160);
alter table public.stops
  drop constraint if exists stops_venue_id_check,
  add constraint stops_venue_id_check check (char_length(venue_id) <= 160);
alter table if exists public.stop_proposals
  drop constraint if exists stop_proposals_venue_id_check,
  add constraint stop_proposals_venue_id_check check (char_length(venue_id) between 1 and 160);

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
begin
  if patch is null or jsonb_typeof(patch) <> 'object' then
    raise exception 'The plan must be a JSON object.' using errcode = '22023';
  end if;
  sp := coalesce(patch -> 'session', '{}'::jsonb);
  meeting := sp -> 'meeting';

  -- The session is locked until this function returns, so two writes cannot interleave.
  select * into s from public.sessions where id = sid for update;
  if not found or s.plan_version <> expected_version or s.status <> expected_status then
    return null;
  end if;

  -- When the server loaded the members the spots are worked out from (before the planner ran), else now.
  -- Never later than the database's own clock, so a server clock that runs fast cannot hide a later change.
  stamp := least(coalesce(nullif(patch ->> 'loaded_at', '')::timestamptz, now()), now());
  new_status := coalesce(sp ->> 'status', s.status);

  -- Rule 4: a pinned meeting area stays.
  if sp ? 'meeting' and s.meeting_method in ('voted', 'chosen')
     and ((meeting ->> 'area_id') is distinct from s.meeting_area_id
          or (meeting ->> 'method') is distinct from s.meeting_method) then
    raise exception 'The meeting area was chosen and cannot be changed by a recompute.'
      using errcode = 'P0001', hint = 'area_pinned';
  end if;

  -- Rule 1: the only move is the host's confirm (or known place), from inviting or locating to voting, with an area.
  -- (The two-people check for leaving inviting comes after the ops below.)
  if new_status <> s.status then
    if not (s.status in ('inviting', 'locating') and new_status = 'voting')
       or coalesce(meeting ->> 'area_id', '') = '' then
      raise exception 'A session cannot go from % to % this way.', s.status, new_status
        using errcode = 'P0001', hint = 'status_transition';
    end if;
    changed := true;
  end if;

  -- Rule 5: a pin only with a confirm. Setting 'voted' or 'chosen' needs the move to voting in this patch, or the same pin
  -- (method and area) already stored.
  if (meeting ->> 'method') in ('voted', 'chosen') and new_status = s.status
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
        -- Rule 7: votes are cleared only in a voting session. The meeting area moved, so every vote is for a place that no
        -- longer belongs to it.
        if s.status <> 'voting' then
          raise exception 'Votes are cleared only while the session is voting.' using errcode = 'P0001', hint = 'slots_status';
        end if;
        delete from public.votes v using public.slots sl where sl.id = v.slot_id and sl.session_id = sid;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
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
        if exists (select 1 from public.slot_options o where o.slot_id = v_slot and o.venue_id = op ->> 'to') then
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
  end if;
  if sp ? 'radius_meters' then
    radius_changed := s.radius_meters is distinct from (sp ->> 'radius_meters')::integer;
  end if;
  if meeting_changed or travel_changed or banner_changed or radius_changed or banner_text is not null then
    changed := true;
  end if;
  if not changed then
    return s.plan_version;
  end if;

  -- Each joined member's own minutes to the confirmed area.
  if sp ? 'meeting' and jsonb_typeof(meeting) = 'object' and meeting ? 'travel' then
    update public.session_members m
    set travel_minutes = case
      when (meeting -> 'travel') ? (m.user_id)::text then round(((meeting -> 'travel') ->> (m.user_id)::text)::numeric)::integer
      else null end
    where m.session_id = sid and m.state = 'joined';
  end if;

  update public.sessions set
    status = new_status,
    radius_meters = case when radius_changed then (sp ->> 'radius_meters')::integer else radius_meters end,
    meeting_area_id = case when meeting_changed then meeting ->> 'area_id' else meeting_area_id end,
    meeting_method = case when meeting_changed then meeting ->> 'method' else meeting_method end,
    meeting_max_minutes = case when meeting_changed then round((meeting ->> 'max_minutes')::numeric)::integer else meeting_max_minutes end,
    meeting_total_minutes = case when meeting_changed then round((meeting ->> 'total_minutes')::numeric)::integer else meeting_total_minutes end,
    meeting_count = case when meeting_changed then round((meeting ->> 'count')::numeric)::integer else meeting_count end,
    meeting_approximate = case when meeting_changed then (meeting ->> 'approximate')::boolean else meeting_approximate end,
    meeting_computed_at = case when meeting_changed and meeting ->> 'area_id' is not null then now()
                               when meeting_changed then null else meeting_computed_at end,
    banner = case
      when banner_text is not null then jsonb_build_object('text', banner_text, 'at', (extract(epoch from now()) * 1000)::bigint, 'approvalsRemoved', true)
      when banner_changed and banner_stamped then banner_new || jsonb_build_object('at', (extract(epoch from now()) * 1000)::bigint)
      when banner_changed then banner_new
      else banner end,
    plan_version = plan_version + 1
  where id = sid;

  return s.plan_version + 1;
end;
$$;

-- The server only. Postgres lets everyone call a new function by default, so take that away first.
revoke execute on function public.apply_session_plan(uuid, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_session_plan(uuid, bigint, text, jsonb) to service_role;
