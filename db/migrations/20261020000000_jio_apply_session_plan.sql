-- Jio migration, stage 3 (server half): apply_session_plan(), the one function the server writes a session's plan through.
--
-- What it adds: one function, and its permissions. No table or column changes.
--
-- The server works a plan out in JavaScript (the meeting spots, today) and then writes it with this function in one transaction.
-- The function locks the session row, compares the version and the status the server loaded with what is there now, and writes
-- NOTHING if either has moved. That is how a late answer, worked out while the session was locating, can never be put over
-- a session the host has since confirmed. The rules it enforces itself, so no mistake in JavaScript can break them:
--   1. Status: it writes only if the session is still in the status the server loaded (expected_status), and only moves it
--      from inviting or locating to voting (the host's confirm, or a known place). Other moves stay with the browser (starting,
--      cancelling) or with later stages. Leaving 'inviting' needs two joined members, which the browser's guard enforces for
--      a host but the service role bypasses.
--   2. Version: it writes only if plan_version is still expected_version, and raises it by one when it writes anything. A
--      write that changes nothing (the same rows again) does not raise it, so repeating a request leaves the database as it was.
--   3. Pin: while the stored meeting_method is 'voted' or 'chosen', a patch that changes meeting_area_id or meeting_method is
--      refused (an exception with hint 'area_pinned'). Only the host's confirm and known place set a pin, and only from inviting
--      or locating.
-- It raises exceptions with errcode P0001 and a hint (area_pinned, needs_two_people, status_transition) for the rules, and
-- returns null when the session moved on (nothing written). It returns the session's version after the write otherwise.
--
-- The patch (jsonb). Every part is optional:
--   ops      a list of changes to members, suggestions and approvals, done in order:
--              { "op": "opt_out", "user_id": ... }        state -> opted_out; the member's approvals and suggestion go
--              { "op": "rejoin", "user_id": ... }         state -> joined
--              { "op": "remove_member", "user_id": ... }  the member row goes (their exact place, approvals and suggestion by foreign key)
--              { "op": "suggest", "user_id": ..., "area_id": ..., "here": false }   one suggestion per member, replaced
--              { "op": "unsuggest", "user_id": ... }
--              { "op": "clear_approvals" }, { "op": "clear_suggestions" }           for the whole session
--   spots    the list of spots the session should have, as a difference: listed areas are inserted or updated, unlisted ones
--            deleted (an approval goes with its spot). Never delete-everything-then-insert, which would delete every approval.
--              [{ "area_id": ..., "rank": 1|2|3|null, "worst_minutes": ..., "mean_minutes": ..., "travel_minutes": {...}, "approximate": false }]
--   banner_text   the notice to show if the deletion above removed an approval (it is set only then)
--   session  { "status": "voting", "banner": null | {...}, "meeting": null | { "area_id", "method", "max_minutes",
--            "total_minutes", "count", "approximate", "travel": { <user id>: minutes } } }
--            `meeting` also writes each joined member's session_members.travel_minutes from `travel`.
-- Later stages add sections (slots and options, stops, the order, proposals) to this function; none of those tables are touched yet.
--
-- Who may call it: the service role only (the server). A browser cannot.
--
-- Run it once as ONE transaction. Idempotent (create or replace). db/schema.sql and db/policies.sql carry the same statements. It
-- needs the meeting-spot migration (20261011000100) applied. Test it first with db/tests/apply_session_plan.sql inside a
-- transaction that rolls back.
--
-- How to call it (backend/src/db/sessions.js does this):
--   const { data } = await serviceClient.rpc('apply_session_plan', { sid, expected_version: 4, expected_status: 'locating', patch })

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
  hit bigint;
  changed boolean := false;
  new_status text;
  lost_approvals boolean := false;
  banner_text text;
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

  -- Rule 3: a pinned meeting area stays.
  if sp ? 'meeting' and s.meeting_method in ('voted', 'chosen')
     and ((meeting ->> 'area_id') is distinct from s.meeting_area_id
          or (meeting ->> 'method') is distinct from s.meeting_method) then
    raise exception 'The meeting area was chosen and cannot be changed by a recompute.'
      using errcode = 'P0001', hint = 'area_pinned';
  end if;

  -- Rule 1: the only move is the host's confirm (or known place), from inviting or locating to voting, with an area.
  new_status := coalesce(sp ->> 'status', s.status);
  if new_status <> s.status then
    if not (s.status in ('inviting', 'locating') and new_status = 'voting')
       or coalesce(meeting ->> 'area_id', '') = '' then
      raise exception 'A session cannot go from % to % this way.', s.status, new_status
        using errcode = 'P0001', hint = 'status_transition';
    end if;
    if s.status = 'inviting'
       and (select count(*) from public.session_members m where m.session_id = sid and m.state = 'joined') < 2 then
      raise exception 'A session needs at least two people before it can start.'
        using errcode = 'P0001', hint = 'needs_two_people';
    end if;
    changed := true;
  end if;

  -- Members, suggestions and approvals, in the order given.
  for op in select * from jsonb_array_elements(coalesce(patch -> 'ops', '[]'::jsonb)) loop
    case op ->> 'op'
      when 'opt_out' then
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
      when 'rejoin' then
        update public.session_members m set state = 'joined'
        where m.session_id = sid and m.user_id = (op ->> 'user_id')::uuid and m.state = 'opted_out';
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      when 'remove_member' then
        delete from public.session_members m where m.session_id = sid and m.user_id = (op ->> 'user_id')::uuid;
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
      else
        raise exception 'Unknown operation %.', op ->> 'op' using errcode = '22023';
    end case;
  end loop;

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

    -- A listed spot is written only if something about it changed, so its time of working out is left alone otherwise.
    for item in select * from jsonb_array_elements(patch -> 'spots') loop
      insert into public.session_spots as x (session_id, area_id, rank, worst_minutes, mean_minutes, travel_minutes, approximate)
      values (sid, item ->> 'area_id', (item ->> 'rank')::integer, (item ->> 'worst_minutes')::numeric,
              (item ->> 'mean_minutes')::numeric, coalesce(item -> 'travel_minutes', '{}'::jsonb),
              coalesce((item ->> 'approximate')::boolean, false))
      on conflict (session_id, area_id) do update
        set rank = excluded.rank, worst_minutes = excluded.worst_minutes, mean_minutes = excluded.mean_minutes,
            travel_minutes = excluded.travel_minutes, approximate = excluded.approximate, computed_at = now()
        where (x.rank, x.worst_minutes, x.mean_minutes, x.travel_minutes, x.approximate)
              is distinct from (excluded.rank, excluded.worst_minutes, excluded.mean_minutes, excluded.travel_minutes, excluded.approximate);
      get diagnostics hit = row_count;
      if hit > 0 then changed := true; end if;
    end loop;

    -- The group is told only when the deletion removed an approval.
    if lost_approvals then
      banner_text := coalesce(nullif(patch ->> 'banner_text', ''), 'Some spots are no longer on the list, so approvals for them were removed.');
    end if;
  end if;

  if sp <> '{}'::jsonb or banner_text is not null then
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
    meeting_area_id = case when sp ? 'meeting' then meeting ->> 'area_id' else meeting_area_id end,
    meeting_method = case when sp ? 'meeting' then meeting ->> 'method' else meeting_method end,
    meeting_max_minutes = case when sp ? 'meeting' then round((meeting ->> 'max_minutes')::numeric)::integer else meeting_max_minutes end,
    meeting_total_minutes = case when sp ? 'meeting' then round((meeting ->> 'total_minutes')::numeric)::integer else meeting_total_minutes end,
    meeting_count = case when sp ? 'meeting' then round((meeting ->> 'count')::numeric)::integer else meeting_count end,
    meeting_approximate = case when sp ? 'meeting' then (meeting ->> 'approximate')::boolean else meeting_approximate end,
    meeting_computed_at = case when sp ? 'meeting' and meeting ->> 'area_id' is not null then now()
                               when sp ? 'meeting' then null else meeting_computed_at end,
    banner = case
      when banner_text is not null then jsonb_build_object('text', banner_text, 'at', (extract(epoch from now()) * 1000)::bigint, 'approvalsRemoved', true)
      when sp ? 'banner' then nullif(sp -> 'banner', 'null'::jsonb)
      else banner end,
    plan_version = plan_version + 1
  where id = sid;

  return s.plan_version + 1;
end;
$$;

-- The server only. Postgres lets everyone call a new function by default, so take that away first.
revoke execute on function public.apply_session_plan(uuid, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_session_plan(uuid, bigint, text, jsonb) to service_role;
