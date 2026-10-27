-- One person cannot be in two meetups at the same time. A meetup holds its time for the people who have joined it while it is
-- inviting, locating, voting or confirmed; a finished or cancelled one holds nothing. Two meetups on the same Singapore day clash
-- when their times overlap, and back to back (one ends when the next starts) does not.
--   - Joining a meetup (a link, an invitation, rejoining, and the host's own row when a meetup is made) is refused when it
--     would put the person in two at once. The refusal is P0001 with hint 'schedule_clash' and the meetup in the way in `detail`
--     as JSON ({ id, title, date, start, end }): it is the person's own meetup, so naming it tells them nothing new.
--   - A host moving a meetup's day or times onto a time someone in it already has is refused too. For the host the answer is
--     the same as above; for any other member it says only that someone has plans (hint 'member_clash'), never whose or what.
-- The rule is for people's own writes (auth.uid() is set). The server's service key and the project's owner are let through, so
-- fixtures and the server's own writes still work. A person's checks run one at a time (an advisory lock on their id), so two
-- joins at once cannot both pass.
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

-- Runs before a person becomes a joined member of a meetup (a new row, or a row that was not joined becoming joined).
create or replace function public.session_members_guard_clash() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  target record;
  hit record;
begin
  if auth.uid() is null or new.state <> 'joined' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.state = 'joined' then
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

-- Runs before a meetup's day or times change.
create or replace function public.sessions_guard_clash() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  hit record;
begin
  if auth.uid() is null or new.status not in ('inviting', 'locating', 'voting', 'confirmed') then
    return new;
  end if;
  if new.date is not distinct from old.date
    and new.start_time is not distinct from old.start_time
    and new.end_time is not distinct from old.end_time then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
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
create trigger sessions_guard_clash
  before update of date, start_time, end_time on public.sessions
  for each row execute function public.sessions_guard_clash();
