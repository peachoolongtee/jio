-- Jio migration: meeting spots, approvals, Roam proposals and the suggested order.
--
-- What it adds, in the order it appears:
--   1. sessions.order_reason and order_source (why the stops are in their order), with a check that they
--      come as a pair; stops.earliest_start_minute.
--   2. sessions.meeting_method accepts 'voted' and 'chosen'. The old check is dropped and re-added.
--   3. Tables session_spots, session_spot_times, spot_approvals and stop_proposals, with their indexes.
--   4. Helper functions my_joined_session_ids() and my_locating_session_ids(), and an updated_at trigger.
--   5. Row-level security, grants and policies: joined members read all four tables; the server writes
--      them; a member adds and removes their own approval while the session is locating.
--   6. The four tables join the supabase_realtime publication.
--
-- Why: the group now suggests and approves meeting spots before the host confirms one, and Roam lets
-- members propose places. See docs/handoffs/meeting-spots-and-roam.md. Nothing here changes profiles,
-- profile_private, the sign-up trigger, username_available() or guard_session_changes(): a browser is
-- kept from the new sessions columns by column grants (it gets no write on them), not by the trigger.
--
-- Run it once as ONE transaction (apply_migration, or one paste into the SQL editor). Every statement is
-- idempotent or guarded, so running it again does nothing. db/schema.sql and db/policies.sql carry the
-- same statements, so a fresh build equals the live project plus this migration. Test it first with
-- db/tests/session_spots_access.sql inside a transaction that rolls back.

-- ── Columns and checks on existing tables ───────────────────────────────

-- Why the stops are in the order they are in, written when the host confirms the itinerary. Server only.
-- reason is one short sentence; source says whether the AI or the planner's own rules chose the order.
-- Both are set or both are null; the server clears them when someone moves a stop by hand.
alter table public.sessions
  add column if not exists order_reason text
    constraint order_reason_length check (char_length(order_reason) <= 200),
  add column if not exists order_source text
    constraint order_source_values check (order_source in ('ai', 'rules'));

-- Two changes to a sessions table that may already exist, so they are guarded constraints and not part
-- of the table definition above:
--   - meeting_method also accepts 'voted' and 'chosen'. The old check is dropped by what it checks, not
--     by its name, and the new one is added under the name Postgres gave the old one.
--   - order_reason and order_source come as a pair.
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
  if not exists (
    select 1 from pg_constraint
    where conname = 'order_note_pair' and conrelid = 'public.sessions'::regclass
  ) then
    alter table public.sessions add constraint order_note_pair
      check ((order_reason is null) = (order_source is null));
  end if;
end;
$sessions_checks$;

-- ── Stops, and the tables for meeting spots and proposals ───────────────

-- The earliest a stop can start, in minutes after midnight: a meal waits for its time, a shop for its
-- opening. Written with the itinerary, by the server. Null means the stop has no earliest start.
alter table public.stops
  add column if not exists earliest_start_minute integer
    constraint earliest_start_minute_range check (earliest_start_minute between 0 and 1439);

-- ── Meeting spots ───────────────────────────────────────────────────────
-- While a session is "locating" the group chooses where to meet from a short list of areas. The server
-- writes the list and every travel figure on it; members read it and say which spots work for them.

-- One area on a session's list: the app's own suggestions (at most three), then members' (one each).
-- suggested_by is null for the app's own spot. A spot a member suggested leaves the list with them, and
-- approvals follow their spot, so the server drops a spot by deleting its row. To re-price the list, update
-- the rows that stay and delete only the ones that drop out: deleting and re-inserting all of them would
-- also delete everyone's approvals.
-- worst_minutes is the longest trip, mean_minutes the average, both whole minutes. approximate is true
-- when the times are estimates and not routes. seq is the order the screens show, the app's first.
create table if not exists public.session_spots (
  session_id uuid not null references public.sessions (id) on delete cascade,
  area_id text not null check (char_length(area_id) between 1 and 60),
  suggested_by uuid,
  -- "We are here already": a label on the spot, which any member may put on a suggestion.
  here boolean not null default false,
  seq integer not null check (seq between 0 and 49),
  worst_minutes integer not null check (worst_minutes between 0 and 1440),
  mean_minutes integer not null check (mean_minutes between 0 and 1440),
  approximate boolean not null default false,
  priced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (session_id, area_id),
  foreign key (session_id, suggested_by) references public.session_members (session_id, user_id)
    on delete cascade,
  check (mean_minutes <= worst_minutes),
  -- Checked at the end of the transaction, so spots can swap places in one go.
  unique (session_id, seq) deferrable initially deferred
);
-- A member has one suggestion at a time. This also indexes the key above.
create unique index if not exists session_spots_one_suggestion_idx
  on public.session_spots (session_id, suggested_by) where suggested_by is not null;

-- Minutes from each person's start to a spot. A table and not a jsonb column, like
-- session_members.travel_minutes and the ledger, so a person leaving the session takes their figures
-- with them and a figure always belongs to a member of the session.
create table if not exists public.session_spot_times (
  session_id uuid not null,
  area_id text not null,
  user_id uuid not null,
  minutes integer not null check (minutes between 0 and 1440),
  primary key (session_id, area_id, user_id),
  foreign key (session_id, area_id) references public.session_spots (session_id, area_id) on delete cascade,
  foreign key (session_id, user_id) references public.session_members (session_id, user_id) on delete cascade
);
create index if not exists session_spot_times_member_idx on public.session_spot_times (session_id, user_id);

-- "Works for me": one row per member and spot, any number of spots per member. This is the table a
-- member writes: their own approval, while the session is "locating". The key to session_spots means
-- only a listed spot can be approved, and an approval goes when its spot leaves the list.
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

-- A place a member proposes while the group is out (Roam). The host accepts it, which the server turns into a
-- stop, or dismisses it. A proposal is pending until resolved_at is set. Written by the server only.
create table if not exists public.stop_proposals (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  venue_id text not null check (char_length(venue_id) between 1 and 80),
  proposed_by uuid not null,
  created_at timestamptz not null default now(),
  resolution text check (resolution in ('accepted', 'dismissed')),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles (id) on delete set null,
  foreign key (session_id, proposed_by) references public.session_members (session_id, user_id) on delete cascade,
  -- A proposal is resolved or pending, never half of each.
  check ((resolution is null) = (resolved_at is null)),
  check (resolved_by is null or resolved_at is not null)
);
create index if not exists stop_proposals_session_id_idx on public.stop_proposals (session_id, created_at);
create index if not exists stop_proposals_proposer_idx on public.stop_proposals (session_id, proposed_by);
create index if not exists stop_proposals_resolved_by_idx on public.stop_proposals (resolved_by);
-- The same place cannot wait for the host twice.
create unique index if not exists stop_proposals_one_pending_idx
  on public.stop_proposals (session_id, venue_id) where resolution is null;

-- ── Helper functions and trigger ────────────────────────────────────────

-- The sessions the signed-in user has joined, in any stage. Used for reading meeting spots,
-- approvals and proposals: someone who opted out reads none of them.
--   select * from public.my_joined_session_ids();
create or replace function public.my_joined_session_ids()
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select m.session_id from public.session_members m
  where m.user_id = (select auth.uid()) and m.state = 'joined';
$$;

-- The sessions the signed-in user has joined that are choosing where to meet. Used for "Works for me".
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

create or replace trigger session_spots_set_updated_at before update on public.session_spots
  for each row execute function public.set_updated_at();

-- ── Access rules ────────────────────────────────────────────────────────

alter table public.session_spots enable row level security;
alter table public.session_spot_times enable row level security;
alter table public.spot_approvals enable row level security;
alter table public.stop_proposals enable row level security;

-- Meeting spots. Signed-in users start from nothing, as above. Members read the list, its travel times,
-- the approvals and the Roam proposals; the server writes all but approvals.
revoke all on public.session_spots, public.session_spot_times, public.spot_approvals, public.stop_proposals
  from anon;
revoke all on public.session_spots, public.session_spot_times, public.spot_approvals, public.stop_proposals
  from authenticated;
grant select on public.session_spots, public.session_spot_times, public.spot_approvals, public.stop_proposals
  to authenticated;
grant all on public.session_spots, public.session_spot_times, public.spot_approvals, public.stop_proposals
  to service_role;

-- A member says "Works for me" on a spot, and takes it back. There is nothing to change in an approval.
grant insert (session_id, area_id, user_id) on public.spot_approvals to authenticated;
grant delete on public.spot_approvals to authenticated;

-- Meeting spots, their travel times and Roam proposals: joined members read; only the server writes.
-- Someone who opted out reads none of them, which is stricter than slots and stops above.
-- A suggestion changes what the rest of the group is offered and needs travel times only the server can
-- work out, so members suggest through the server. So do proposals: the server checks the venue exists,
-- as it does for a place a member asks to add to a slot.
drop policy if exists session_spots_select on public.session_spots;
create policy session_spots_select on public.session_spots for select to authenticated
  using (session_id in (select public.my_joined_session_ids()));
drop policy if exists session_spot_times_select on public.session_spot_times;
create policy session_spot_times_select on public.session_spot_times for select to authenticated
  using (session_id in (select public.my_joined_session_ids()));
drop policy if exists spot_approvals_select on public.spot_approvals;
create policy spot_approvals_select on public.spot_approvals for select to authenticated
  using (session_id in (select public.my_joined_session_ids()));
drop policy if exists stop_proposals_select on public.stop_proposals;
create policy stop_proposals_select on public.stop_proposals for select to authenticated
  using (session_id in (select public.my_joined_session_ids()));

-- Works for me: each person adds and removes only their own approval, only while they are joined and the
-- session is locating. The key to session_spots stops an approval for a spot that is not listed.
drop policy if exists spot_approvals_insert_own on public.spot_approvals;
create policy spot_approvals_insert_own on public.spot_approvals for insert to authenticated
  with check (user_id = (select auth.uid()) and session_id in (select public.my_locating_session_ids()));
drop policy if exists spot_approvals_delete_own on public.spot_approvals;
create policy spot_approvals_delete_own on public.spot_approvals for delete to authenticated
  using (user_id = (select auth.uid()) and session_id in (select public.my_locating_session_ids()));

-- Who may call the new functions: only the policies, as the signed-in user.
revoke execute on function public.my_joined_session_ids(), public.my_locating_session_ids()
  from public, anon, authenticated;
grant execute on function public.my_joined_session_ids(), public.my_locating_session_ids()
  to authenticated;

-- ── Live updates ────────────────────────────────────────────────────────
-- The same rule as db/policies.sql: row-level security filters inserts and updates, and delete events carry
-- only the deleted row's key.

do $realtime$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['session_spots', 'session_spot_times', 'spot_approvals', 'stop_proposals'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end;
$realtime$;
