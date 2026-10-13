-- Jio access rules: row-level security, column permissions and live updates.
-- Run this after db/schema.sql, as ONE transaction (the SQL editor and a migration both do).
-- Safe to run more than once.
--
-- The rules in one paragraph: only a session's members can read it, and they see each other's
-- area, never the exact place. A host creates a session, renames it, changes its date and times
-- before it starts, starts it and cancels it. A member writes only their own areas, exact place,
-- picks and votes, and only while the session is open; they can delete their own exact place at
-- any time. Everything else is written by the server, which uses the service key and is not bound by
-- these rules: opting out, meeting areas, the radius, slots, options, the itinerary, the ledger and
-- the route cache. Logged-out visitors can call two functions and nothing else.

-- ── Row-level security on every table ───────────────────────────────────

alter table public.profiles enable row level security;
alter table public.profile_private enable row level security;
alter table public.sessions enable row level security;
alter table public.session_members enable row level security;
alter table public.session_member_places enable row level security;
alter table public.invites enable row level security;
alter table public.slots enable row level security;
alter table public.slot_options enable row level security;
alter table public.votes enable row level security;
alter table public.stops enable row level security;
alter table public.commute_ledger enable row level security;
alter table public.route_cache enable row level security;

-- ── Accounts ────────────────────────────────────────────────────────────
-- The rules that were already on the "jio" project, reproduced so the test project matches.
-- Any signed-in user can read public profiles. Each person edits their own display name and
-- photo, and reads and edits only their own private row. Usernames cannot be changed.

revoke all on public.profiles, public.profile_private from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.profiles, public.profile_private from authenticated;
grant select on public.profiles, public.profile_private to authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;
grant update (dob) on public.profile_private to authenticated;
grant all on public.profiles, public.profile_private to service_role;

do $accounts$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles'
                 and policyname = 'profiles are readable by signed-in users') then
    create policy "profiles are readable by signed-in users" on public.profiles
      for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles'
                 and policyname = 'users update their own profile') then
    create policy "users update their own profile" on public.profiles
      for update to authenticated
      using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'profile_private'
                 and policyname = 'users read their own private profile') then
    create policy "users read their own private profile" on public.profile_private
      for select to authenticated using ((select auth.uid()) = id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'profile_private'
                 and policyname = 'users update their own private profile') then
    create policy "users update their own private profile" on public.profile_private
      for update to authenticated
      using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
  end if;
end;
$accounts$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.username_available(text) to anon, authenticated;
-- Whether an email has an account is for the server only: anyone with the public key could otherwise ask about any
-- address, as fast as they liked. The sign-up screen asks the backend (POST /api/accounts/email-check), which limits it.
revoke execute on function public.email_registered(text) from public, anon, authenticated;
grant execute on function public.email_registered(text) to service_role;

-- New with the planner columns: a person sets their own home area and planner needs.
grant update (home_area_id, dietary, budget_max_per_person, needs_step_free) on public.profile_private to authenticated;

-- The check on session_members.categories calls this as whoever is writing the row.
revoke execute on function public.array_is_unique(text[]) from public, anon;
grant execute on function public.array_is_unique(text[]) to authenticated, service_role;

-- ── Sessions: table and column permissions ──────────────────────────────
-- Logged-out visitors get no table access at all.

revoke all on public.sessions, public.session_members, public.session_member_places, public.invites,
  public.slots, public.slot_options, public.votes, public.stops, public.commute_ledger, public.route_cache
  from anon;

-- Signed-in users start from nothing, then get exactly what is listed below.
revoke all on public.sessions, public.session_members, public.session_member_places, public.invites,
  public.slots, public.slot_options, public.votes, public.stops, public.commute_ledger, public.route_cache
  from authenticated;
grant select
  on public.sessions, public.session_members, public.session_member_places, public.invites,
     public.slots, public.slot_options, public.votes, public.stops, public.commute_ledger
  to authenticated;

-- The server's service key can do everything. It is never sent to a browser.
grant all
  on public.sessions, public.session_members, public.session_member_places, public.invites,
     public.slots, public.slot_options, public.votes, public.stops, public.commute_ledger, public.route_cache
  to service_role;

-- A host creates a session, renames it, moves its date and times, starts it and cancels it.
-- The trigger guard_session_changes decides which of those are allowed when.
grant insert (host_id, title, date, start_time, end_time) on public.sessions to authenticated;
grant update (title, date, start_time, end_time, status) on public.sessions to authenticated;

-- A member edits their own areas and picks. Not their role, their state or their travel time.
grant update (start_area_id, end_area_id, categories, stay_until) on public.session_members to authenticated;

-- A member keeps their own exact place.
grant insert (session_id, user_id, start_label, start_lat, start_lng, end_label, end_lat, end_lng)
  on public.session_member_places to authenticated;
grant update (start_label, start_lat, start_lng, end_label, end_lat, end_lng)
  on public.session_member_places to authenticated;
grant delete on public.session_member_places to authenticated;

-- A host makes and revokes invite links. The token is always generated by the database.
grant insert (session_id, created_by, expires_at) on public.invites to authenticated;
grant update (revoked, expires_at) on public.invites to authenticated;

-- A member votes, changes their vote, and withdraws it.
grant insert (slot_id, user_id, venue_id) on public.votes to authenticated;
grant update (venue_id) on public.votes to authenticated;
grant delete on public.votes to authenticated;

-- ── Sessions: policies ──────────────────────────────────────────────────
-- Each policy is dropped first so this file can be run again after a change.
-- The first group of drops removes policies from an earlier version of this file.

drop policy if exists slots_update_host on public.slots;
drop policy if exists slot_options_insert_member on public.slot_options;
drop policy if exists slot_options_delete_own on public.slot_options;

-- Sessions: members read, the host writes.
drop policy if exists sessions_select on public.sessions;
create policy sessions_select on public.sessions for select to authenticated
  using (host_id = (select auth.uid()) or id in (select public.my_session_ids()));
drop policy if exists sessions_insert_as_host on public.sessions;
create policy sessions_insert_as_host on public.sessions for insert to authenticated
  with check (host_id = (select auth.uid()));
drop policy if exists sessions_update_host on public.sessions;
create policy sessions_update_host on public.sessions for update to authenticated
  using (host_id = (select auth.uid())) with check (host_id = (select auth.uid()));

-- Members: everyone in the session sees the list. Each person edits only their own row, and only
-- while they are joined and the session is open. People join through join_session(), never by
-- inserting here.
drop policy if exists session_members_select on public.session_members;
create policy session_members_select on public.session_members for select to authenticated
  using (session_id in (select public.my_session_ids()));
drop policy if exists session_members_update_own on public.session_members;
create policy session_members_update_own on public.session_members for update to authenticated
  using (user_id = (select auth.uid()) and session_id in (select public.my_open_session_ids()))
  with check (user_id = (select auth.uid()) and session_id in (select public.my_open_session_ids()));

-- Exact places: only the owner reads theirs. They write it only while joined and the session is open.
drop policy if exists session_member_places_select_own on public.session_member_places;
create policy session_member_places_select_own on public.session_member_places for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists session_member_places_insert_own on public.session_member_places;
create policy session_member_places_insert_own on public.session_member_places for insert to authenticated
  with check (user_id = (select auth.uid()) and session_id in (select public.my_open_session_ids()));
drop policy if exists session_member_places_update_own on public.session_member_places;
create policy session_member_places_update_own on public.session_member_places for update to authenticated
  using (user_id = (select auth.uid()) and session_id in (select public.my_open_session_ids()))
  with check (user_id = (select auth.uid()) and session_id in (select public.my_open_session_ids()));
-- Deleting is allowed at any time, including after opting out or once the session is over: a
-- person can always take back their own address.
drop policy if exists session_member_places_delete_own on public.session_member_places;
create policy session_member_places_delete_own on public.session_member_places for delete to authenticated
  using (user_id = (select auth.uid()));

-- Invites: only the host sees, creates and revokes them.
drop policy if exists invites_select_host on public.invites;
create policy invites_select_host on public.invites for select to authenticated
  using (public.is_session_host(session_id));
drop policy if exists invites_insert_host on public.invites;
create policy invites_insert_host on public.invites for insert to authenticated
  with check (created_by = (select auth.uid()) and public.is_session_host(session_id));
drop policy if exists invites_update_host on public.invites;
create policy invites_update_host on public.invites for update to authenticated
  using (public.is_session_host(session_id)) with check (public.is_session_host(session_id));

-- Slots and options: members read; only the server writes.
drop policy if exists slots_select on public.slots;
create policy slots_select on public.slots for select to authenticated
  using (session_id in (select public.my_session_ids()));
drop policy if exists slot_options_select on public.slot_options;
create policy slot_options_select on public.slot_options for select to authenticated
  using (slot_id in (select public.my_slot_ids()));

-- Votes: members read everyone's. Each person casts, changes and withdraws only their own, and
-- only in a slot they may vote in right now.
drop policy if exists votes_select on public.votes;
create policy votes_select on public.votes for select to authenticated
  using (slot_id in (select public.my_slot_ids()));
drop policy if exists votes_insert_own on public.votes;
create policy votes_insert_own on public.votes for insert to authenticated
  with check (user_id = (select auth.uid()) and slot_id in (select public.my_votable_slot_ids()));
drop policy if exists votes_update_own on public.votes;
create policy votes_update_own on public.votes for update to authenticated
  using (user_id = (select auth.uid()) and slot_id in (select public.my_votable_slot_ids()))
  with check (user_id = (select auth.uid()) and slot_id in (select public.my_votable_slot_ids()));
drop policy if exists votes_delete_own on public.votes;
create policy votes_delete_own on public.votes for delete to authenticated
  using (user_id = (select auth.uid()) and slot_id in (select public.my_votable_slot_ids()));

-- The itinerary and the ledger: members read; only the server writes.
drop policy if exists stops_select on public.stops;
create policy stops_select on public.stops for select to authenticated
  using (session_id in (select public.my_session_ids()));
drop policy if exists commute_ledger_select on public.commute_ledger;
create policy commute_ledger_select on public.commute_ledger for select to authenticated
  using (user_id = (select auth.uid()) or session_id in (select public.my_session_ids()));

-- route_cache has no policy on purpose: with row-level security on and no policy, only the
-- server's service key can read or write it.

-- ── Who may call which function ─────────────────────────────────────────
-- Postgres lets everyone call a new function by default, so take that away first.

revoke execute on function
  public.my_session_ids(), public.my_open_session_ids(), public.my_slot_ids(), public.my_votable_slot_ids(),
  public.is_session_host(uuid), public.invite_preview(text), public.join_session(text),
  public.session_member_needs(uuid), public.set_updated_at(), public.touch_member_preferences(),
  public.add_host_membership(), public.guard_session_changes()
  from public, anon, authenticated;

-- The policies above call these as the signed-in user. Each answers only about the caller.
grant execute on function
  public.my_session_ids(), public.my_open_session_ids(), public.my_slot_ids(), public.my_votable_slot_ids(),
  public.is_session_host(uuid)
  to authenticated;

-- The join page works before login. Joining needs an account.
grant execute on function public.invite_preview(text) to anon, authenticated;
grant execute on function public.join_session(text) to authenticated;

-- Members' private planner needs go to the server only.
grant execute on function public.session_member_needs(uuid) to service_role;

-- ── Live updates ────────────────────────────────────────────────────────
-- Clients subscribe to these tables, filtered by session. Row-level security applies to inserts
-- and updates: a client only receives rows it is allowed to read. Delete events are NOT filtered.
-- They carry only the deleted row's key, so any signed-in subscriber can learn that a
-- (session_id, user_id) or (slot_id, user_id) pair was removed, and nothing else about it. The ids
-- are random and open no access on their own. session_member_places is left out altogether.
-- This block only adds tables: taking one out of live updates needs its own migration.

do $realtime$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['sessions', 'session_members', 'slots', 'slot_options', 'votes', 'stops'] loop
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
