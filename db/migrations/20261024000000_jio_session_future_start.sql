-- Reject a session whose Singapore date or start time has passed, even when a client bypasses
-- the browser's own checks. Title-only edits to an old session remain allowed. The server (service_role) and the
-- project's owner are let through, as guard_session_changes lets them through.
-- Idempotent; the fresh-build equivalent is in db/schema.sql.

create or replace function public.sessions_guard_future_start() returns trigger
language plpgsql set search_path = '' as $$
declare
  singapore_now timestamp without time zone := statement_timestamp() at time zone 'Asia/Singapore';
begin
  -- The rule is for people's own writes. The server and the project's owner are let through, as guard_session_changes lets
  -- them through, so the server's own writes and the database tests' fixtures (which make sessions on any day) still work.
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;
  if tg_op = 'UPDATE'
    and new.date is not distinct from old.date
    and new.start_time is not distinct from old.start_time then
    return new;
  end if;

  if new.date < singapore_now::date then
    raise exception 'That day has passed.' using errcode = '23514';
  end if;
  if new.date = singapore_now::date
    and new.start_time <= date_trunc('minute', singapore_now)::time then
    raise exception 'That start time has already passed today.' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists sessions_guard_future_start on public.sessions;
create trigger sessions_guard_future_start
  before insert or update of date, start_time on public.sessions
  for each row execute function public.sessions_guard_future_start();
