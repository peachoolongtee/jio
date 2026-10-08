-- Jio access rules: row-level security, column permissions and live updates.
-- Run this after db/schema.sql. Safe to run more than once.
--
-- The rules in one paragraph: only a session's members can read it. Only the host changes its
-- settings. A member writes only their own location, preferences and votes. Meeting areas, ranked
-- options, the itinerary, the ledger and the route cache are written by the server, which uses the
-- service key and is not bound by these rules. Logged-out visitors can call two functions and
-- nothing else.

-- ── Row-level security on every table ───────────────────────────────────

alter table public.profiles enable row level security;
alter table public.profile_private enable row level security;
alter table public.sessions enable row level security;
alter table public.session_members enable row level security;
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

-- New with the planner columns: a person sets their own home area and planner needs.
grant update (home_area_id) on public.profiles to authenticated;
grant update (dietary, budget_max_per_person, needs_step_free) on public.profile_private to authenticated;

-- ── Sessions: table and column permissions ──────────────────────────────
-- Logged-out visitors get no table access at all.

revoke all on public.sessions, public.session_members, public.invites, public.slots,
  public.slot_options, public.votes, public.stops, public.commute_ledger, public.route_cache
  from anon;

-- Signed-in users start from read-only, then get exactly the writes listed below.
revoke all on public.sessions, public.session_members, public.invites, public.slots,
  public.slot_options, public.votes, public.stops, public.commute_ledger, public.route_cache
  from authenticated;
grant select
  on public.sessions, public.session_members, public.invites, public.slots,
     public.slot_options, public.votes, public.stops, public.commute_ledger
  to authenticated;

-- The server's service key can do everything. It is never sent to a browser.
grant all
  on public.sessions, public.session_members, public.invites, public.slots,
     public.slot_options, public.votes, public.stops, public.commute_ledger, public.route_cache
  to service_role;

-- A host creates a session and edits its settings. The meeting area columns are not in this list.
grant insert (host_id, title, date, start_time, end_time) on public.sessions to authenticated;
grant update (title, date, start_time, end_time, radius_meters, status, banner)
  on public.sessions to authenticated;

-- A member edits their own row. They cannot change their role, or the travel time the server worked out.
grant update (state, start_area_id, start_label, start_lat, start_lng, end_area_id, end_label, end_lat,
              end_lng, categories, stay_until, preferences_set_at)
  on public.session_members to authenticated;

-- A host makes and revokes invite links. The token is always generated by the database.
grant insert (session_id, created_by, expires_at) on public.invites to authenticated;
grant update (revoked, expires_at) on public.invites to authenticated;

-- A host removes and restores slots.
grant update (deleted) on public.slots to authenticated;

-- A member adds a place to vote on, and removes one they added.
grant insert (slot_id, venue_id, source, added_by) on public.slot_options to authenticated;
grant delete on public.slot_options to authenticated;

-- A member votes, changes their vote, and withdraws it.
grant insert (slot_id, user_id, venue_id) on public.votes to authenticated;
grant update (venue_id) on public.votes to authenticated;
grant delete on public.votes to authenticated;

-- ── Sessions: policies ──────────────────────────────────────────────────
-- Each policy is dropped first so this file can be run again after a change.

-- Sessions: members read, the host writes.
drop policy if exists sessions_select on public.sessions;
create policy sessions_select on public.sessions for select to authenticated
  using (host_id = (select auth.uid()) or public.is_session_member(id));
drop policy if exists sessions_insert_as_host on public.sessions;
create policy sessions_insert_as_host on public.sessions for insert to authenticated
  with check (host_id = (select auth.uid()));
drop policy if exists sessions_update_host on public.sessions;
create policy sessions_update_host on public.sessions for update to authenticated
  using (host_id = (select auth.uid())) with check (host_id = (select auth.uid()));

-- Members: everyone in the session sees the list; each person edits only their own row.
-- People join through join_session(), never by inserting here.
drop policy if exists session_members_select on public.session_members;
create policy session_members_select on public.session_members for select to authenticated
  using (public.is_session_member(session_id));
drop policy if exists session_members_update_own on public.session_members;
create policy session_members_update_own on public.session_members for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

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

-- Slots: members read; the host removes and restores.
drop policy if exists slots_select on public.slots;
create policy slots_select on public.slots for select to authenticated
  using (public.is_session_member(session_id));
drop policy if exists slots_update_host on public.slots;
create policy slots_update_host on public.slots for update to authenticated
  using (public.is_session_host(session_id)) with check (public.is_session_host(session_id));

-- Options: members read. A member adds a place while voting is open, marked as theirs.
drop policy if exists slot_options_select on public.slot_options;
create policy slot_options_select on public.slot_options for select to authenticated
  using (public.is_session_member(public.session_of_slot(slot_id)));
drop policy if exists slot_options_insert_member on public.slot_options;
create policy slot_options_insert_member on public.slot_options for insert to authenticated
  with check (
    source = 'member'
    and added_by = (select auth.uid())
    and public.is_session_member(public.session_of_slot(slot_id))
    and public.slot_is_open(slot_id)
  );
drop policy if exists slot_options_delete_own on public.slot_options;
create policy slot_options_delete_own on public.slot_options for delete to authenticated
  using (source = 'member' and added_by = (select auth.uid()) and public.slot_is_open(slot_id));

-- Votes: members read everyone's. Each person casts, changes and withdraws only their own, and
-- only while voting is open.
drop policy if exists votes_select on public.votes;
create policy votes_select on public.votes for select to authenticated
  using (public.is_session_member(public.session_of_slot(slot_id)));
drop policy if exists votes_insert_own on public.votes;
create policy votes_insert_own on public.votes for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.is_session_member(public.session_of_slot(slot_id))
    and public.slot_is_open(slot_id)
  );
drop policy if exists votes_update_own on public.votes;
create policy votes_update_own on public.votes for update to authenticated
  using (user_id = (select auth.uid()) and public.slot_is_open(slot_id))
  with check (user_id = (select auth.uid()) and public.slot_is_open(slot_id));
drop policy if exists votes_delete_own on public.votes;
create policy votes_delete_own on public.votes for delete to authenticated
  using (user_id = (select auth.uid()) and public.slot_is_open(slot_id));

-- The itinerary and the ledger: members read; only the server writes.
drop policy if exists stops_select on public.stops;
create policy stops_select on public.stops for select to authenticated
  using (public.is_session_member(session_id));
drop policy if exists commute_ledger_select on public.commute_ledger;
create policy commute_ledger_select on public.commute_ledger for select to authenticated
  using (user_id = (select auth.uid()) or public.is_session_member(session_id));

-- route_cache has no policy on purpose: with row-level security on and no policy, only the
-- server's service key can read or write it.

-- ── Who may call which function ─────────────────────────────────────────
-- Postgres lets everyone call a new function by default, so take that away first.

revoke execute on function
  public.is_session_member(uuid), public.is_session_host(uuid), public.session_of_slot(uuid),
  public.slot_is_open(uuid), public.invite_preview(text), public.join_session(text),
  public.session_member_needs(uuid), public.set_updated_at(), public.add_host_membership(),
  public.guard_session_status()
  from public, anon, authenticated;

-- The policies above call these as the signed-in user.
grant execute on function
  public.is_session_member(uuid), public.is_session_host(uuid), public.session_of_slot(uuid),
  public.slot_is_open(uuid)
  to authenticated;

-- The join page works before login. Joining needs an account.
grant execute on function public.invite_preview(text) to anon, authenticated;
grant execute on function public.join_session(text) to authenticated;

-- Members' private planner needs go to the server only.
grant execute on function public.session_member_needs(uuid) to service_role;

-- ── Live updates ────────────────────────────────────────────────────────
-- Clients subscribe to these tables, filtered by session. Row-level security still applies:
-- a client only receives rows it is allowed to read.

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
