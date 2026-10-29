-- One person cannot be in two meetups at the same time. A meetup holds its time for the people who have joined it (state
-- 'joined', not 'opted_out') while it is inviting, locating, voting or confirmed; a completed or cancelled one holds nothing. Two
-- meetups on the same Singapore day clash when their times overlap, and back to back (one ends when the next starts) does not.
--
-- What is checked, and when:
--   1. A person becoming a joined member of a meetup (a new row as joined, or a row that was not joined becoming joined) is refused
--      when it would put them in two at once: through a link or an invitation (join_session), by the host's own row when a meetup
--      is made (a new meetup that overlaps one the host is already in is refused, and no session is left behind), and by rejoining
--      after opting out. The refusal is P0001 with hint 'schedule_clash' and the meetup in the way in `detail` as JSON
--      ({ id, title, date, start, end }): it is the person's own meetup, so naming it tells them nothing new.
--   2. A host moving a meetup's day or start or end time is refused when the host is in another meetup at the new time (the same
--      'schedule_clash' answer), or when someone else joined in it is (hint 'member_clash', no detail). The second answer does tell
--      the host that somebody in the meetup is busy then, because the move is refused; it never says who or with what.
--   3. A meetup that is not inviting, locating, voting or confirmed is not checked, and nothing else is: a title edit, a status
--      change, and a person opting out or leaving are never held against anyone. When a move is onto a past day and also clashes,
--      the future-start rule's "That day has passed" (23514) is raised, because the trigger below is named to run after it.
-- Whose writes: a signed-in person's own (auth.uid() is set, including through join_session) are checked. The server (the service
-- key, auth.role() = 'service_role') is checked only where it brings an opted-out member back to joined, which is the one way it
-- makes anyone joined (apply_session_plan, op 'rejoin') and why the check cannot be left to the browser; its other writes, including
-- a new row, are not checked. The project's owner (no claims) is let through, so fixtures and the database tests still work.
-- A person's checks run one at a time (an advisory lock on their id; a host's move takes the locks of the host and every joined
-- member in sorted order, so two moves cannot wait on each other), so two joins at once cannot both pass.
-- apply_session_plan, guard_session_changes, sessions_guard_future_start and join_session are not changed.
-- Idempotent; the fresh-build equivalent is in db/schema.sql. The browser makes the same check first (frontend/src/lib/clash.js)
-- so it can say so before a write; this is the part that cannot be skipped.

-- The first meetup the person is in that overlaps the given time, leaving out the meetup `p_session` itself.
create or replace function public.meetup_clash(p_user uuid, p_session uuid, p_date date, p_start time, p_end time)
returns table (id uuid, title text, date date, start_time time, end_time time)
language sql stable security definer set search_path = ''
as $$
  select s.id, s.title, s.date, s.start_time, s.end_time
  from public.session_members m
  join public.sessions s on s.id = m.session_id
  where m.user_id = p_user
    and m.state = 'joined'
    and s.id <> p_session
    and s.status in ('inviting', 'locating', 'voting', 'confirmed')
    and s.date = p_date
    and s.start_time < p_end
    and p_start < s.end_time
  order by s.start_time
  limit 1
$$;
revoke all on function public.meetup_clash(uuid, uuid, date, time, time) from public, anon, authenticated;

-- Runs before a person becomes a joined member of a meetup (a new row, or a row that was not joined becoming joined). A signed-in
-- person's write is always checked; the server's only when it brings an opted-out member back (a rejoin).
create or replace function public.session_members_guard_clash() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  target record;
  hit record;
begin
  if new.state <> 'joined' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.state = 'joined' then
    return new;
  end if;
  if auth.uid() is null and not (tg_op = 'UPDATE' and coalesce(auth.role(), '') = 'service_role') then
    return new;
  end if;
  select s.date, s.start_time, s.end_time, s.status into target from public.sessions s where s.id = new.session_id;
  if not found or target.status not in ('inviting', 'locating', 'voting', 'confirmed') then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  select * into hit from public.meetup_clash(new.user_id, new.session_id, target.date, target.start_time, target.end_time);
  if found then
    raise exception 'You already have a meetup at that time.' using errcode = 'P0001', hint = 'schedule_clash',
      detail = json_build_object('id', hit.id, 'title', hit.title, 'date', hit.date, 'start', hit.start_time, 'end', hit.end_time)::text;
  end if;
  return new;
end;
$$;
drop trigger if exists session_members_guard_clash on public.session_members;
create trigger session_members_guard_clash
  before insert or update of state on public.session_members
  for each row execute function public.session_members_guard_clash();

-- Runs before a meetup's day or times change. Its name sorts after sessions_guard_future_start, so "That day has passed" (23514)
-- is raised before a clash when both apply (before-row triggers run in alphabetical order).
create or replace function public.sessions_hold_time_clash() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  hit record;
  who uuid;
begin
  if auth.uid() is null or new.status not in ('inviting', 'locating', 'voting', 'confirmed') then
    return new;
  end if;
  if new.date is not distinct from old.date
    and new.start_time is not distinct from old.start_time
    and new.end_time is not distinct from old.end_time then
    return new;
  end if;
  -- The mover and every joined member are locked in sorted order, so two moves that share a member cannot wait on each other.
  for who in
    select u from (
      select auth.uid() as u
      union
      select m.user_id from public.session_members m where m.session_id = new.id and m.state = 'joined'
    ) people
    order by u
  loop
    perform pg_advisory_xact_lock(hashtextextended(who::text, 0));
  end loop;
  select * into hit from public.meetup_clash(auth.uid(), new.id, new.date, new.start_time, new.end_time);
  if found then
    raise exception 'You already have a meetup at that time.' using errcode = 'P0001', hint = 'schedule_clash',
      detail = json_build_object('id', hit.id, 'title', hit.title, 'date', hit.date, 'start', hit.start_time, 'end', hit.end_time)::text;
  end if;
  if exists (
    select 1 from public.session_members m
    where m.session_id = new.id and m.state = 'joined' and m.user_id <> auth.uid()
      and exists (select 1 from public.meetup_clash(m.user_id, new.id, new.date, new.start_time, new.end_time))
  ) then
    raise exception 'Someone in this meetup already has plans at that time.' using errcode = 'P0001', hint = 'member_clash';
  end if;
  return new;
end;
$$;
drop trigger if exists sessions_guard_clash on public.sessions;
drop function if exists public.sessions_guard_clash();
drop trigger if exists sessions_hold_time_clash on public.sessions;
create trigger sessions_hold_time_clash
  before update of date, start_time, end_time on public.sessions
  for each row execute function public.sessions_hold_time_clash();
