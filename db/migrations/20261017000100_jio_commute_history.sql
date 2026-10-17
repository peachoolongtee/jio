-- Store per-attendee route minutes and their difference from the attendee average when an outing completes.
-- The service function is the only writer; the existing session_travel_debt() RPC reads the resulting ledger.
create or replace function public.complete_session_with_travel(
  p_session_id uuid,
  p_stops jsonb,
  p_commutes jsonb
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  current_status text;
  commute_count integer;
  distinct_commuters integer;
begin
  if p_stops is null or jsonb_typeof(p_stops) <> 'array' or jsonb_array_length(p_stops) < 1 or jsonb_array_length(p_stops) > 8 then
    raise exception 'Send between 1 and 8 stops.' using errcode = '22023';
  end if;
  if p_commutes is null or jsonb_typeof(p_commutes) <> 'array' or jsonb_array_length(p_commutes) < 1 or jsonb_array_length(p_commutes) > 30 then
    raise exception 'Send travel minutes for between 1 and 30 attendees.' using errcode = '22023';
  end if;

  select s.status into current_status
  from public.sessions s
  where s.id = p_session_id
  for update;

  if current_status is null then
    raise exception 'Session not found.' using errcode = 'P0002';
  end if;
  -- A retry after commit must not duplicate stops or commute history.
  if current_status = 'completed' then
    return;
  end if;
  if current_status <> 'confirmed' then
    raise exception 'Session is not confirmed.' using errcode = '22023';
  end if;

  select count(*), count(distinct commute.user_id)
  into commute_count, distinct_commuters
  from jsonb_to_recordset(p_commutes) as commute(
    user_id uuid,
    minutes_in integer,
    minutes_between integer,
    minutes_home integer
  );
  if commute_count <> distinct_commuters then
    raise exception 'Each attendee may appear only once.' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_commutes) as commute(
      user_id uuid,
      minutes_in integer,
      minutes_between integer,
      minutes_home integer
    )
    left join public.session_members member
      on member.session_id = p_session_id
     and member.user_id = commute.user_id
     and member.state = 'joined'
    where member.user_id is null
       or commute.minutes_in is null
       or commute.minutes_between is null
       or commute.minutes_home is null
       or commute.minutes_in not between 0 and 1440
       or commute.minutes_between not between 0 and 1440
       or commute.minutes_home not between 0 and 1440
  ) then
    raise exception 'Travel minutes must be valid and belong to joined session members.' using errcode = '22023';
  end if;

  delete from public.stops where session_id = p_session_id;
  insert into public.stops (
    session_id, seq, category, venue_id, planned_start_minute, duration_minutes, not_before_minute
  )
  select
    p_session_id,
    stop.seq,
    stop.category,
    stop.venue_id,
    stop.planned_start_minute,
    stop.duration_minutes,
    stop.not_before_minute
  from jsonb_to_recordset(p_stops) as stop(
    seq integer,
    category text,
    venue_id text,
    planned_start_minute integer,
    duration_minutes integer,
    not_before_minute integer
  );

  with commutes as (
    select commute.user_id, commute.minutes_in, commute.minutes_between, commute.minutes_home,
           commute.minutes_in + commute.minutes_between + commute.minutes_home as total_minutes
    from jsonb_to_recordset(p_commutes) as commute(
      user_id uuid,
      minutes_in integer,
      minutes_between integer,
      minutes_home integer
    )
  ), average as (
    select avg(total_minutes) as total_minutes from commutes
  )
  insert into public.commute_ledger (
    session_id, user_id, minutes_in, minutes_between, minutes_home, delta_from_mean
  )
  select p_session_id, commutes.user_id, commutes.minutes_in, commutes.minutes_between,
         commutes.minutes_home, commutes.total_minutes - average.total_minutes
  from commutes cross join average;

  update public.sessions
  set status = 'completed', completed_at = now(), updated_at = now()
  where id = p_session_id;
end;
$$;

revoke all on function public.complete_session_with_travel(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.complete_session_with_travel(uuid, jsonb, jsonb) to service_role;
