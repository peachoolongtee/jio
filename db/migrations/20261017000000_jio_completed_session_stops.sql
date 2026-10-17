-- Save the actual itinerary when a signed-in member completes an outing. The backend verifies membership,
-- then calls this function with its service key so writing the stops and ending the session is atomic.
create or replace function public.complete_session_with_stops(p_session_id uuid, p_stops jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  current_status text;
begin
  if p_stops is null or jsonb_typeof(p_stops) <> 'array' or jsonb_array_length(p_stops) < 1 or jsonb_array_length(p_stops) > 8 then
    raise exception 'Send between 1 and 8 stops.' using errcode = '22023';
  end if;

  select s.status into current_status
  from public.sessions s
  where s.id = p_session_id
  for update;

  if current_status is null then
    raise exception 'Session not found.' using errcode = 'P0002';
  end if;
  -- A request retried after a successful commit must not duplicate or rewrite visit history.
  if current_status = 'completed' then
    return;
  end if;
  if current_status <> 'confirmed' then
    raise exception 'Session is not confirmed.' using errcode = '22023';
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

  update public.sessions
  set status = 'completed', completed_at = now(), updated_at = now()
  where id = p_session_id;
end;
$$;

revoke all on function public.complete_session_with_stops(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.complete_session_with_stops(uuid, jsonb) to service_role;
