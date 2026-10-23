-- Jio migration, stage 5 (server half): apply_session_plan() learns to write the plan (the stops of a confirmed itinerary, their order, the
-- places put in them, Roam proposals, the move from voting to confirmed and back, and finishing the outing with the travel ledger), and the
-- slice d schema (20261011000300) is folded in.
--
-- THIS MIGRATION MUST BE APPLIED BEFORE THE STAGE 5 BACKEND RUNS ANYWHERE (a laptop, a preview, the deployed server). The backend sends the
-- stops, the order note, the ledger and the proposals through the function below, which the stage 4 function refuses (a part of the plan it
-- does not know, 22023), and reads sessions.order_suggestion, sessions.plan_start_minute, stops.not_before_minute and stop_proposals, and
-- calls session_travel_debt(), none of which exist on the live project until this file (or 20261011000300) is applied. Apply it once, as
-- one transaction, with the checksum guard of the apply tool; this one file is the whole of stage 5's database changes. It needs the stage 4
-- function (20261022000000) applied, and slices a and b (sessions, members, spots).
--
-- What it does, in order:
--   1. Slice d (20261011000300, folded in, statement for statement). Every statement is idempotent or guarded, so a project that has applied
--      20261011000300 is not changed by this part, and one that has not gets sessions.order_reason, order_source, order_suggestion and
--      plan_start_minute, stops.not_before_minute, the table stop_proposals with its indexes, row-level security and grants, and
--      session_travel_debt(). 20261011000300 stays in the folder (its access test, db/tests/session_plan_access.sql, runs after either
--      one); applying both, in either order, is safe.
--   2. One function, replaced (create or replace, same signature, same permissions).
--
-- Everything stage 3 and stage 4 did is unchanged, and is tested again by db/tests/apply_session_plan.sql (steps 1 to 172 word for word).
-- What is added, all optional parts of the patch:
--
--   stops          the plan's stops, as a difference: each item is the complete row
--                    { "id": <stop id> | absent, "seq": 0, "slot_id": <slot id> | null, "category": ..., "venue_id": ...,
--                      "planned_start_minute": 720, "duration_minutes": 90, "travel_mode": "walk" | "mrt" | "car" | null,
--                      "travel_minutes": 12 | null, "not_before_minute": 720 | null }
--                  a stop with an id is updated where it differs, one without an id is made, one not listed goes. At most 8; at least 1;
--                  numbered 0, 1, 2 ... with no gap or repeat; no place twice; every slot named is the session's. Written only while the
--                  session is confirmed after the patch (hint stops_status).
--   stop_options   [ { "slot_id": ..., "venue_id": ..., "rank": 1, "score": 4.2, "source": "planner", "added_by": null, "details": {...},
--                      "replaces": <venue id> | null } ]
--                  the place a stop was changed to is kept as an option of the stop's slot with what the planner said about it; the place it
--                  replaces leaves that slot's options (its votes go by foreign key).
--   ledger         [ { "user_id": ..., "minutes_in": 24, "minutes_between": 15, "minutes_home": 31, "delta_from_mean": -3.5 } ]
--                  one row for each joined person when the outing is finished; the deltas must sum to exactly zero (ledger_sum); a row that
--                  is already there stays (a retry changes nothing). Only with the move to completed (ledger_status).
--   session        "status" also moves voting to confirmed (needs "stops", and two joined people who voted: not_enough_votes; every stop must
--                  be an option of its slot: stop_not_option), confirmed to voting (the plan is opened again: the stops, the order note, the
--                  suggested order and the plan's start are cleared, and the votes may be cleared with it) and confirmed to completed
--                  (stamps completed_at). Any other move is still refused (status_transition).
--                  "order_note": { "reason": ..., "source": "ai" | "rules" } or null   why the stops are in their order (confirmed only)
--                  "order_suggestion": { "basis": <64 hex>, "order": [slot ids], "starts": {...}, "reason": ..., "source": ..., "at": ... }
--                                      or null   the server's last suggested order (voting only; the table's check holds its shape)
--                  "plan_start_minute": 0 to 1439 or null   when the plan starts (confirmed only)
--                  "replan": an object or null   the pending "plan again?" prompt
--   ops            { "op": "propose", "user_id": ..., "venue_id": ... }   a joined member puts a place forward as the next stop (confirmed
--                                                       only). Already a stop: already_a_stop. Plan full (8): plan_full. 3 waiting for the
--                                                       member or 10 for the session: too_many_proposals. Already waiting: nothing changes.
--                  { "op": "resolve_proposal", "proposal_id": ..., "status": "accepted" | "dismissed", "by": <user id> }
--                                                       the host's answer, or the proposer taking it back (confirmed only). The stop an
--                                                       accepted proposal becomes is in the same patch's "stops". One already answered
--                                                       changes nothing.
--                  "clear_votes" is also allowed in the patch that opens the plan again (stage 4 allowed it only in a voting session).
--                  Pending proposals are dismissed whenever a session leaves confirmed.
--
-- The patch is checked first, before anything is read, as in stage 4: a part of the plan this function does not know (anything but "ops",
-- "spots", "slots", "stops", "stop_options", "ledger", "session", "loaded_at", "recomputed" and "banner_text"), or a part of the session it
-- does not know (anything but "status", "meeting", "banner", "radius_meters", "replan", "plan_start_minute", "order_note" and
-- "order_suggestion") is refused with errcode 22023.
--
-- It raises exceptions with errcode P0001 and a hint for the rules (stage 5 adds stops_status, order_status, ledger_status, stops_missing,
-- not_enough_votes, too_many_stops, stop_slot, stop_missing, last_stop, stop_order, stop_duplicate, stop_not_option, ledger_member, ledger_sum,
-- proposal_status, proposal_member, already_a_stop, plan_full, too_many_proposals), and returns null when the session moved on (nothing
-- written), the stored version when the patch changes nothing, and the version after the write otherwise. All of that is as in stage 4.
--
-- Who may call it: the service role only (the server). A browser cannot.
--
-- Run it once as ONE transaction. Idempotent. db/schema.sql and db/policies.sql carry the same statements. Test it first with
-- db/tests/apply_session_plan.sql inside a transaction that rolls back: to try it before applying, put this file's statements and the test
-- file's statements in one transaction, in that order, and drop the test file's own begin and rollback lines (or run the test after
-- applying the migration).
--
-- How to call it (backend/src/db/sessions.js does this):
--   const { data } = await serviceClient.rpc('apply_session_plan', { sid, expected_version: 9, expected_status: 'voting', patch })

-- ── Columns and checks on sessions ──────────────────────────────────────

-- reason is one short sentence; source says whether the AI or the planner's own rules chose the order. Both
-- are set or both are null. The server clears them when someone moves a stop by hand.
-- order_suggestion is what the server last suggested: { basis, order, starts, reason, source, at }, where basis is
-- a 64-character hash of the winners and the session's date and times, and order lists at most 8 slot ids.
-- plan_start_minute is minutes after midnight.
alter table public.sessions
  add column if not exists order_reason text
    constraint order_reason_length check (char_length(order_reason) between 1 and 200),
  add column if not exists order_source text
    constraint order_source_values check (order_source in ('ai', 'rules')),
  add column if not exists order_suggestion jsonb,
  add column if not exists plan_start_minute integer
    constraint plan_start_minute_range check (plan_start_minute between 0 and 1439);

do $sessions_checks$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'order_note_pair' and conrelid = 'public.sessions'::regclass
  ) then
    alter table public.sessions add constraint order_note_pair
      check ((order_reason is null) = (order_source is null));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'order_suggestion_shape' and conrelid = 'public.sessions'::regclass
  ) then
    alter table public.sessions add constraint order_suggestion_shape
      check (
        order_suggestion is null or (
          jsonb_typeof(order_suggestion) = 'object'
          and octet_length(order_suggestion::text) <= 4000
          and coalesce((order_suggestion ->> 'basis') ~ '^[0-9a-f]{64}$', false)
          and case when jsonb_typeof(order_suggestion -> 'order') = 'array'
                   then jsonb_array_length(order_suggestion -> 'order') <= 8
                   else false end
        )
      );
  end if;
end;
$sessions_checks$;

-- ── Stops and proposals ─────────────────────────────────────────────────

-- The earliest a stop can start, in minutes after midnight: a meal waits for its time, a shop for its opening.
-- Written with the itinerary, by the server. Null means the stop has no earliest start.
alter table public.stops
  add column if not exists not_before_minute integer
    constraint not_before_minute_range check (not_before_minute between 0 and 1439);

-- A place a member proposes while the group is out (Roam). The host accepts it, which the server turns into a
-- stop, or dismisses it; the proposer may dismiss their own. A proposal is pending until it is resolved.
-- Written by the server only: it checks that the venue exists, and accepting one writes stops. At most 10 are
-- pending in a session and 3 per member; the server checks that under the session's lock. A proposal goes
-- with its proposer when they leave.
create table if not exists public.stop_proposals (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  venue_id text not null check (char_length(venue_id) between 1 and 160),
  proposed_by uuid not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles (id) on delete set null,
  foreign key (session_id, proposed_by) references public.session_members (session_id, user_id) on delete cascade,
  -- Resolved or pending, never half of each.
  check ((status = 'pending') = (resolved_at is null)),
  check (resolved_by is null or resolved_at is not null)
);
create index if not exists stop_proposals_session_id_idx on public.stop_proposals (session_id, created_at);
create index if not exists stop_proposals_proposer_idx on public.stop_proposals (session_id, proposed_by);
create index if not exists stop_proposals_resolved_by_idx on public.stop_proposals (resolved_by);
-- The same place cannot wait for the host twice.
create unique index if not exists stop_proposals_one_pending_idx
  on public.stop_proposals (session_id, venue_id) where status = 'pending';

-- ── Travel debt ─────────────────────────────────────────────────────────

-- Each joined member's commute balance over the last 90 days, from the ledger rows of their other sessions: the
-- sum of delta_from_mean, clamped to plus or minus 14,400 minutes. Positive means they travelled more than
-- the average. For the server only (the service key); the planner uses it to favour whoever has travelled most.
--   const { data } = await serviceClient.rpc('session_travel_debt', { sid: sessionId })
create or replace function public.session_travel_debt(sid uuid)
returns table (user_id uuid, debt_minutes numeric)
language sql stable security definer set search_path = ''
as $$
  select m.user_id, greatest(-14400, least(14400, coalesce(sum(l.delta_from_mean), 0)))
  from public.session_members m
  left join public.commute_ledger l
    on l.user_id = m.user_id and l.session_id <> sid and l.created_at > now() - interval '90 days'
  where m.session_id = sid and m.state = 'joined'
  group by m.user_id;
$$;

-- ── Access rules ────────────────────────────────────────────────────────

alter table public.stop_proposals enable row level security;

revoke all on public.stop_proposals from anon;
revoke all on public.stop_proposals from authenticated;
grant select on public.stop_proposals to authenticated;
grant all on public.stop_proposals to service_role;

-- Members read, as for stops: everyone in the session, through my_session_ids(). Only the server writes.
drop policy if exists stop_proposals_select on public.stop_proposals;
create policy stop_proposals_select on public.stop_proposals for select to authenticated
  using (session_id in (select public.my_session_ids()));

revoke execute on function public.session_travel_debt(uuid) from public, anon, authenticated;
grant execute on function public.session_travel_debt(uuid) to service_role;

-- ── The function ────────────────────────────────────────────────────────

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
    where keys.k not in ('status', 'meeting', 'banner', 'radius_meters', 'replan', 'plan_start_minute', 'order_note', 'order_suggestion')
    limit 1;
    if unknown_key is not null then
      raise exception 'The session part of the plan has a part this function does not know: %.', unknown_key using errcode = '22023';
    end if;
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

  -- Rule 1: the moves are the host's confirm (or known place), from inviting or locating to voting, with an area; and, from stage 5,
  -- the plan's: the host's confirm of the stops (voting to confirmed), opening the plan again (confirmed to voting) and finishing
  -- the outing (confirmed to completed). (The two-people check for leaving inviting comes after the ops below.)
  if new_status <> s.status then
    if not ((s.status in ('inviting', 'locating') and new_status = 'voting' and coalesce(meeting ->> 'area_id', '') <> '')
            or (s.status = 'voting' and new_status = 'confirmed')
            or (s.status = 'confirmed' and new_status in ('voting', 'completed'))) then
      raise exception 'A session cannot go from % to % this way.', s.status, new_status
        using errcode = 'P0001', hint = 'status_transition';
    end if;
    changed := true;
  end if;
  reopened := s.status = 'confirmed' and new_status = 'voting';

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

  -- Rule 8 (stage 5, the plan): the stops, the details of a place put in a stop, the order note and the plan's start are written only
  -- while the session is confirmed (after this patch); the suggested order only while it is voting (it is cleared by opening the plan
  -- again, which this function does itself); the ledger only with the move to completed. Confirming needs stops.
  if (patch ? 'stops' or patch ? 'stop_options' or nullif(sp -> 'plan_start_minute', 'null'::jsonb) is not null
      or nullif(sp -> 'order_note', 'null'::jsonb) is not null) and new_status <> 'confirmed' then
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
          insert into public.stop_proposals (session_id, venue_id, proposed_by) values (sid, op ->> 'venue_id', (op ->> 'user_id')::uuid);
          changed := true;
        end if;
      when 'resolve_proposal' then
        -- The host's answer to a proposal, or the proposer taking it back ("status" is accepted or dismissed). The stop an accepted
        -- proposal becomes is in the same patch's stops. One already answered changes nothing.
        if not (s.status = 'confirmed' and new_status = 'confirmed') then
          raise exception 'A proposal is answered only while the plan is confirmed.' using errcode = 'P0001', hint = 'proposal_status';
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
         and not exists (select 1 from public.slots sl where sl.id = (item ->> 'slot_id')::uuid and sl.session_id = sid) then
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
      insert into public.slot_options as o (slot_id, venue_id, rank, score, source, added_by, details)
      values (v_slot, item ->> 'venue_id', (item ->> 'rank')::integer, (item ->> 'score')::numeric,
              coalesce(item ->> 'source', 'planner'), (item ->> 'added_by')::uuid, coalesce(item -> 'details', '{}'::jsonb))
      on conflict (slot_id, venue_id) do update
        set rank = excluded.rank, score = excluded.score, details = excluded.details
        where (o.rank, o.score, o.details) is distinct from (excluded.rank, excluded.score, excluded.details);
      get diagnostics hit = row_count;
      if hit > 0 then changed := true; end if;
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
  if sp ? 'replan' then
    replan_new := nullif(sp -> 'replan', 'null'::jsonb);
    if replan_new is not null and jsonb_typeof(replan_new) <> 'object' then
      raise exception 'The re-plan prompt must be a JSON object or null.' using errcode = '22023';
    end if;
    replan_changed := s.replan is distinct from replan_new;
  end if;
  if meeting_changed or travel_changed or banner_changed or radius_changed or banner_text is not null
     or note_changed or suggestion_changed or start_changed or replan_changed then
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
    -- Opening the plan again clears what belonged to the confirmed plan: the order note, the suggested order, the plan's start and
    -- the prompt. Leaving or entering confirmed clears the prompt too. Finishing the outing stamps its time once.
    order_reason = case when reopened then null when sp ? 'order_note' then note_new ->> 'reason' else order_reason end,
    order_source = case when reopened then null when sp ? 'order_note' then note_new ->> 'source' else order_source end,
    order_suggestion = case when reopened then null when sp ? 'order_suggestion' then suggestion_new else order_suggestion end,
    plan_start_minute = case when reopened then null when sp ? 'plan_start_minute' then (sp ->> 'plan_start_minute')::integer else plan_start_minute end,
    replan = case when s.status = 'confirmed' and new_status <> 'confirmed' then null
                  when s.status = 'voting' and new_status = 'confirmed' then null
                  when sp ? 'replan' then replan_new else replan end,
    completed_at = case when s.status = 'confirmed' and new_status = 'completed' then now() else completed_at end,
    plan_version = plan_version + 1
  where id = sid;

  return s.plan_version + 1;
end;
$$;

-- The server only. Postgres lets everyone call a new function by default, so take that away first.
revoke execute on function public.apply_session_plan(uuid, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_session_plan(uuid, bigint, text, jsonb) to service_role;
