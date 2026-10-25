-- Jio migration: how the host picks the meeting point. One column, one guard rule, one grant.
--
-- sessions.meet_by holds the host's choice when they press Start session: 'fairest' (everyone shares where they start and the
-- planner finds a fair spot) or 'known' (the host names the area and the group goes straight to choosing places). Null on a
-- session that started before this migration, and the app reads null as 'fairest', so no old session changes.
--
-- It is the host's intent, not the planner's result: meeting_method (the planner's own pick, 'voted', 'chosen') stays the
-- server's and is not reused.
--
-- Who may write it, and when (guard_session_changes, below):
--   - Only the host. The column grant lets a signed-in user update the column, and the existing policy sessions_update_host
--     lets only the host update a session row.
--   - In the update that starts the session (inviting to locating), or while the session is locating (locating to locating).
--     Allowing fairest to known while locating is deliberate: a host who sees the spot list can still say "We already have a
--     place" (the stage 3 known place), and the record of their intent then agrees with what they did. In any other state,
--     including inviting without starting, voting and later, a browser's write of it is refused.
--   - It can never be cleared (set back to null) from a browser.
--   The server (the service key) and database owners are let through, as for every other column of the guard.
--
-- Order: apply after 20261023000000 (stage 5), and before the frontend that reads meet_by runs anywhere (the app asks for the
-- column on every read of a session). guard_session_changes is replaced whole; this file carries the function as db/schema.sql
-- has it now, so a project that has applied the teammate's 20261024000000 (a separate trigger that refuses past dates) is not
-- changed by it.
--
-- Run it once as ONE transaction. Idempotent. db/schema.sql and db/policies.sql carry the same statements. Test it first with
-- db/tests/session_meet_by_access.sql inside a transaction that rolls back.

alter table public.sessions
  add column if not exists meet_by text
    constraint sessions_meet_by_check check (meet_by in ('fairest', 'known'));

create or replace function public.guard_session_changes()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  if old.status in ('completed', 'cancelled') then
    raise exception 'A % session cannot be changed.', old.status using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if new.status = 'locating' and old.status = 'inviting' then
      if (select count(*) from public.session_members m
          where m.session_id = old.id and m.state = 'joined') < 2 then
        raise exception 'A session needs at least two people before it can start.' using errcode = '42501';
      end if;
    elsif new.status <> 'cancelled' then
      raise exception 'A session cannot go from % to % directly.', old.status, new.status
        using errcode = '42501';
    end if;
  end if;

  if old.status <> 'inviting'
     and (new.date, new.start_time, new.end_time) is distinct from (old.date, old.start_time, old.end_time) then
    raise exception 'The date and times can only change before the session starts.' using errcode = '42501';
  end if;

  if new.meet_by is distinct from old.meet_by then
    if new.meet_by is null then
      raise exception 'How to pick the meeting point cannot be cleared.' using errcode = '42501';
    end if;
    if not (old.status = 'inviting' and new.status = 'locating') and not (old.status = 'locating' and new.status = 'locating') then
      raise exception 'How to pick the meeting point can only be chosen as the session starts or while it is locating.' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

grant update (meet_by) on public.sessions to authenticated;
