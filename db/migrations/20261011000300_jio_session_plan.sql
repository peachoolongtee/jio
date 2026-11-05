-- Jio migration, slice d: the plan (suggested order, earliest start, Roam proposals, travel debt).
--
-- What it adds, in the order it appears:
--   1. sessions.order_reason and order_source (why the stops are in their order), which come as a pair;
--      sessions.order_suggestion (the stored suggestion with the hash it was made from) and
--      sessions.plan_start_minute (when the plan starts, which reordering keeps). All server only.
--   2. stops.not_before_minute: the earliest a stop may start. Server only.
--   3. Table stop_proposals: a place a member puts forward as the next stop while the group is out (Roam).
--   4. session_travel_debt(): each joined member's recent commute balance, for the server's planner.
--   5. Row-level security and grants: members read proposals; the server writes them.
--
-- The design keeps the note as one jsonb column (order_note) and the stop's earliest start as not_before_minute.
-- This migration keeps the note as the two typed columns of the first draft, because a sentence of at most 200
-- characters and a source that is 'ai' or 'rules' can be bounded and paired by the database; the stored
-- suggestion, which holds a list, stays jsonb and has a check on its shape and size.
--
-- Run it once as ONE transaction. Every statement is idempotent or guarded. db/schema.sql and db/policies.sql
-- carry the same statements. Test it first with db/tests/session_plan_access.sql inside a transaction that
-- rolls back; it needs slices a and b applied.

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
