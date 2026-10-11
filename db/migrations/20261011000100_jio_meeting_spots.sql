-- Jio migration, slice b: meeting spots, suggestions and "Works for me".
--
-- What it adds, in the order it appears:
--   1. sessions.plan_version, the number every server write to a plan raises (it is what a late answer is
--      compared against, and what Realtime clients watch). The first thing that needs it is the server's
--      function apply_session_plan, so apply this before that function is created and tested.
--   2. sessions.meeting_method also accepts 'voted' and 'chosen'. The old check is dropped and re-added.
--   3. member_minutes_ok(), which the check on session_spots.travel_minutes calls.
--   4. Tables session_spots (the list), spot_suggestions (who suggested what) and spot_approvals.
--   5. my_locating_session_ids(), the "joined and locating" helper behind "Works for me".
--   6. Row-level security, grants and policies; spot_approvals joins the supabase_realtime publication.
--
-- Nothing here changes guard_session_changes() or the older helper functions: a browser is kept from the new
-- sessions column by column grants (it gets no write on it), and every new table is read through
-- my_session_ids() like the older ones.
--
-- Choices that are the design's recommendation and await the lead's yes:
--   - sessions.meeting_* stay null while a session is locating (design question 8). The columns are already
--     nullable, so a "no" changes no schema: apply_session_plan would write meeting_* from the first spot at
--     every recompute instead.
--   - Travel times for a spot are worked out from each area's centre, not from an exact address (design
--     question 1). No schema effect: session_spots holds minutes by member id only, never a place. If the
--     answer is exact addresses, each spot's minutes would say more about where a member lives, and the
--     lead should decide whether the group may read them.
--
-- Run it once as ONE transaction (apply_migration, or one paste into the SQL editor). Every statement is
-- idempotent or guarded, so running it again does nothing. db/schema.sql and db/policies.sql carry the
-- same statements, so a fresh build equals the live project plus this migration. Test it first with
-- db/tests/meeting_spots_access.sql inside a transaction that rolls back. It needs slice a applied (the
-- test invites people by username to prove they read nothing yet).

-- ── Columns and checks on sessions ──────────────────────────────────────

-- Raised by one on every write the server makes to a plan. Server only.
alter table public.sessions add column if not exists plan_version bigint not null default 0;

-- meeting_method also accepts 'voted' and 'chosen'. The old check is found by what it checks, not by its
-- name, and the new one is added under the name Postgres gave the old one:
--   voted   the host confirmed a spot the group had approved
--   chosen  the host set the area directly, or confirmed a spot nobody approved
do $sessions_checks$
declare
  old_check record;
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sessions_meeting_method_check' and conrelid = 'public.sessions'::regclass
      and pg_get_constraintdef(oid) like '%voted%'
  ) then
    for old_check in
      select conname from pg_constraint
      where conrelid = 'public.sessions'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) like '%meeting_method%'
    loop
      execute format('alter table public.sessions drop constraint %I', old_check.conname);
    end loop;
    alter table public.sessions add constraint sessions_meeting_method_check
      check (meeting_method in ('same', 'fairest', 'centre', 'voted', 'chosen'));
  end if;
end;
$sessions_checks$;

-- ── Tables ──────────────────────────────────────────────────────────────

-- True when a jsonb value is minutes by member: an object whose keys are user ids and whose values are numbers
-- from 0 to 1440, and which is no larger than 30 members' worth. Used by the check on session_spots.
--   select public.member_minutes_ok('{"6f1c7b1e-2d7e-4a8e-9a0e-3c3d9a2f7b10": 24.6}');  -- true
create or replace function public.member_minutes_ok(m jsonb)
returns boolean
language sql immutable set search_path = ''
as $$
  select case
    when jsonb_typeof(m) <> 'object' or octet_length(m::text) > 4000 then false
    else not exists (
      select 1 from jsonb_each(m) e
      where e.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or case when jsonb_typeof(e.value) = 'number'
                then (e.value #>> '{}')::numeric not between 0 and 1440
                else true end
    )
  end;
$$;

-- The list of areas the group is choosing between while a session is "locating". Written by the server only.
-- A row is there because the app lists it (rank 1 to 3, fairest first), because a member suggested it
-- (rank null) or both. Who suggested it is in spot_suggestions and is worked out on read.
-- The minutes are not rounded: the screens round them, but the tie-break between spots compares the longest
-- trip exactly. worst_minutes is the longest trip, mean_minutes the mean of the members' minutes, and
-- travel_minutes holds each located member's minutes by user id (areas only, never a place).
-- approximate is true when the times are estimates and not routes. computed_at is when they were worked out.
-- To re-price the list, upsert the rows that stay and delete only the ones that drop out: approvals follow
-- their spot, so deleting and re-inserting every row would also delete everyone's approvals.
-- The mean may sit a hair above the longest trip when everyone's minutes are equal (floating-point sums).
create table if not exists public.session_spots (
  session_id uuid not null references public.sessions (id) on delete cascade,
  area_id text not null check (char_length(area_id) between 1 and 60),
  rank integer check (rank between 1 and 3),
  worst_minutes numeric not null check (worst_minutes between 0 and 1440),
  mean_minutes numeric not null check (mean_minutes between 0 and 1440),
  travel_minutes jsonb not null default '{}' check (public.member_minutes_ok(travel_minutes)),
  approximate boolean not null default false,
  computed_at timestamptz not null default now(),
  primary key (session_id, area_id),
  check (mean_minutes <= worst_minutes + 0.001),
  -- Checked at the end of the transaction, so the ranks can swap places in one statement. Several rows
  -- may have no rank.
  unique (session_id, rank) deferrable initially deferred
);

-- What each member suggested: one suggestion at a time per member, and several members may suggest the same
-- area. There is deliberately no key to session_spots. A suggestion is kept while the list is empty (fewer than
-- two starts are shared), and the list is built from the app's spots plus these. "here" labels the suggestion
-- "we are here already". Written by the server only; the oldest suggestion comes first on screen.
-- A member who leaves takes their suggestion with them. At most 8 different areas may be suggested in a
-- session; the server checks that under the session's lock.
create table if not exists public.spot_suggestions (
  session_id uuid not null,
  user_id uuid not null,
  area_id text not null check (char_length(area_id) between 1 and 60),
  here boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (session_id, user_id),
  foreign key (session_id, user_id) references public.session_members (session_id, user_id) on delete cascade
);

-- "Works for me": one row per member and spot, any number of spots per member. This is the table a member
-- writes: their own approval, while the session is "locating". The key to session_spots means only a listed
-- spot can be approved, and an approval goes when its spot leaves the list or its member leaves.
create table if not exists public.spot_approvals (
  session_id uuid not null,
  area_id text not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (session_id, area_id, user_id),
  foreign key (session_id, area_id) references public.session_spots (session_id, area_id) on delete cascade,
  foreign key (session_id, user_id) references public.session_members (session_id, user_id) on delete cascade
);
create index if not exists spot_approvals_member_idx on public.spot_approvals (session_id, user_id);

-- ── Helper function ─────────────────────────────────────────────────────

-- The sessions the signed-in user has joined that are choosing where to meet. Used for "Works for me":
-- someone who opted out, and anyone once the host has confirmed, approves nothing.
--   select * from public.my_locating_session_ids();
create or replace function public.my_locating_session_ids()
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select m.session_id
  from public.session_members m
  join public.sessions s on s.id = m.session_id
  where m.user_id = (select auth.uid())
    and m.state = 'joined'
    and s.status = 'locating';
$$;

-- ── Access rules ────────────────────────────────────────────────────────

alter table public.session_spots enable row level security;
alter table public.spot_suggestions enable row level security;
alter table public.spot_approvals enable row level security;

-- Signed-in users start from nothing, as for the older tables. Members read the list, the suggestions and the
-- approvals; the server writes the first two.
revoke all on public.session_spots, public.spot_suggestions, public.spot_approvals from anon;
revoke all on public.session_spots, public.spot_suggestions, public.spot_approvals from authenticated;
grant select on public.session_spots, public.spot_suggestions, public.spot_approvals to authenticated;
grant all on public.session_spots, public.spot_suggestions, public.spot_approvals to service_role;

-- A member says "Works for me" on a spot, and takes it back. There is nothing to change in an approval.
grant insert (session_id, area_id, user_id) on public.spot_approvals to authenticated;
grant delete on public.spot_approvals to authenticated;

-- Members read, as for slots and stops: everyone in the session, opted out or not, through my_session_ids().
-- Someone invited by username who has not accepted is not a member and reads none of it. A suggestion
-- changes what the rest of the group is offered and needs travel times only the server can work out, so
-- members suggest through the server, which also deletes an opted-out member's approvals and suggestion.
drop policy if exists session_spots_select on public.session_spots;
create policy session_spots_select on public.session_spots for select to authenticated
  using (session_id in (select public.my_session_ids()));
drop policy if exists spot_suggestions_select on public.spot_suggestions;
create policy spot_suggestions_select on public.spot_suggestions for select to authenticated
  using (session_id in (select public.my_session_ids()));
drop policy if exists spot_approvals_select on public.spot_approvals;
create policy spot_approvals_select on public.spot_approvals for select to authenticated
  using (session_id in (select public.my_session_ids()));

-- Works for me: each person adds and removes only their own approval, only while they are joined and the
-- session is locating. The key to session_spots stops an approval for a spot that is not listed.
drop policy if exists spot_approvals_insert_own on public.spot_approvals;
create policy spot_approvals_insert_own on public.spot_approvals for insert to authenticated
  with check (user_id = (select auth.uid()) and session_id in (select public.my_locating_session_ids()));
drop policy if exists spot_approvals_delete_own on public.spot_approvals;
create policy spot_approvals_delete_own on public.spot_approvals for delete to authenticated
  using (user_id = (select auth.uid()) and session_id in (select public.my_locating_session_ids()));

-- Who may call the new functions. The policies call my_locating_session_ids() as the signed-in user; only the
-- server writes session_spots, so only it needs the check function.
revoke execute on function public.my_locating_session_ids(), public.member_minutes_ok(jsonb)
  from public, anon, authenticated;
grant execute on function public.my_locating_session_ids() to authenticated;
grant execute on function public.member_minutes_ok(jsonb) to service_role;

-- ── Live updates ────────────────────────────────────────────────────────
-- Only approvals are published. The server's writes to the list raise sessions.plan_version, and the sessions
-- row is already published, so clients refetch the spots when it changes. Row-level security filters inserts;
-- a delete event carries only the key (session id, area id, user id), as for votes.

do $realtime$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'spot_approvals'
    ) then
      alter publication supabase_realtime add table public.spot_approvals;
    end if;
  end if;
end;
$realtime$;
