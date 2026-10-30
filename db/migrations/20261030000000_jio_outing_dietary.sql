-- Dietary needs for one outing. A joined member's needs start as the ones on their profile (profile_private.dietary) and may be changed
-- for one outing alone; the host may also drop a need of someone else's for the outing. Nothing here is a column of sessions or
-- session_members, and nothing is readable or writable by a browser: the server writes both tables with the service key and reads the needs
-- through session_member_needs(), as it already does for the profile's needs.
--
--   session_member_dietary  one row per member who changed their needs or confirmed them for this outing: the needs they have for it
--                           and when they confirmed them (null until they do). A row goes with the member's row (on delete cascade), so a
--                           member who leaves or is removed takes theirs; an opted-out member keeps theirs for when they rejoin (the
--                           function below counts joined members only).
--   session_dietary_dropped one row per need the host dropped for the outing: the outing stops filtering for it. The need is never tied
--                           to a person, here or in anything a member reads.
--
-- session_member_needs(sid) now answers each joined member's needs for the outing: their row in session_member_dietary if they have one,
-- else their profile's. Same name, arguments and columns, so nothing that calls it changes. The host's dropped needs are NOT taken off in
-- the function: the server reads them from the second table and takes them off the group's needs when it ranks places, so that the host
-- can still be told which needs are dropped and take a drop back.
-- apply_session_plan, guard_session_changes, sessions_guard_future_start, join_session, the clash functions and the account tables are not
-- changed. Idempotent; the fresh-build equivalent is in db/schema.sql and db/policies.sql. Test: db/tests/outing_dietary.sql.

create table if not exists public.session_member_dietary (
  session_id uuid not null,
  user_id uuid not null,
  -- The needs this member has for this outing: a flat list of at most 3, no repeats (the shape of profile_private.dietary).
  dietary text[] not null default '{}'
    constraint outing_dietary_values check (dietary <@ array['halal', 'vegetarian', 'vegan']::text[])
    constraint outing_dietary_shape check (
      coalesce(array_ndims(dietary), 1) = 1
      and cardinality(dietary) <= 3
      and public.array_is_unique(dietary)
    ),
  -- When the member confirmed their needs for this outing; null until they do.
  confirmed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (session_id, user_id),
  foreign key (session_id, user_id) references public.session_members (session_id, user_id) on delete cascade
);

create table if not exists public.session_dietary_dropped (
  session_id uuid not null references public.sessions (id) on delete cascade,
  need text not null check (need in ('halal', 'vegetarian', 'vegan')),
  dropped_at timestamptz not null default now(),
  primary key (session_id, need)
);

create or replace trigger session_member_dietary_set_updated_at before update on public.session_member_dietary
  for each row execute function public.set_updated_at();

-- Server only: row-level security on, no policy, and no privilege for a browser, so only the service key reads or writes them.
alter table public.session_member_dietary enable row level security;
alter table public.session_dietary_dropped enable row level security;
revoke all on public.session_member_dietary, public.session_dietary_dropped from anon, authenticated;
grant all on public.session_member_dietary, public.session_dietary_dropped to service_role;

-- Each joined member's private planner needs, for the server only (the service key): the dietary needs are the member's for this outing.
--   const { data } = await serviceClient.rpc('session_member_needs', { sid: sessionId })
create or replace function public.session_member_needs(sid uuid)
returns table (user_id uuid, home_area_id text, dietary text[], budget_max_per_person numeric, needs_step_free boolean)
language sql stable security definer set search_path = ''
as $$
  select m.user_id, pp.home_area_id, coalesce(d.dietary, pp.dietary), pp.budget_max_per_person, pp.needs_step_free
  from public.session_members m
  join public.profile_private pp on pp.id = m.user_id
  left join public.session_member_dietary d on d.session_id = m.session_id and d.user_id = m.user_id
  where m.session_id = sid and m.state = 'joined';
$$;
revoke execute on function public.session_member_needs(uuid) from public, anon, authenticated;
grant execute on function public.session_member_needs(uuid) to service_role;
