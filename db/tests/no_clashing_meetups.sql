-- Rollback test for db/migrations/20261028000000_jio_no_clashing_meetups.sql.
-- Run this whole file as the project owner. It temporarily installs the migration, checks joining and moving a meetup as
-- signed-in people, and rolls back both the DDL and the throwaway data at the end. Nothing is left on the project.

begin;

-- The migration, installed inside this transaction so the live schema is unchanged after the rollback.
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

create function pg_temp.new_user(u uuid) returns void language plpgsql as $$
begin
  insert into auth.users (id, aud, role, email, raw_user_meta_data)
  values (u, 'authenticated', 'authenticated', u || '@example.test',
          jsonb_build_object('username', 't' || substr(md5(u::text), 1, 12), 'dob', '2000-01-01'));
end;
$$;

create function pg_temp.try(stmt text, out code text, out msg text)
language plpgsql as $$
begin
  execute stmt;
  code := null;
  msg := null;
exception when others then
  code := sqlstate;
  msg := sqlerrm;
end;
$$;

create function pg_temp.expect_error(step int, stmt text, wanted text, msg_part text default null) returns void
language plpgsql as $$
declare got record;
begin
  select * into got from pg_temp.try(stmt);
  if got.code is distinct from wanted or (msg_part is not null and got.msg not ilike '%' || msg_part || '%') then
    raise exception 'FAIL step %: wanted error % mentioning %, got % %', step, wanted, msg_part,
      coalesce(got.code, 'success'), coalesce(got.msg, '');
  end if;
  raise notice 'ok step %', step;
end;
$$;


do $test$
declare
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  c uuid := gen_random_uuid();
  s1 uuid; s3 uuid; s4 uuid; s5 uuid; s6 uuid; s8 uuid;
  tomorrow text := ((statement_timestamp() at time zone 'Asia/Singapore')::date + 1)::text;
  later text := ((statement_timestamp() at time zone 'Asia/Singapore')::date + 2)::text;
  caught record;
  hint_text text;
  detail_text text;
  n int;
begin
  perform pg_temp.new_user(a);
  perform pg_temp.new_user(b);
  perform pg_temp.new_user(c);

  -- Signs in as one person for the statements after it.
  create or replace function pg_temp.as_user(u uuid) returns void language plpgsql as $f$
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', u::text, true);
  end;
  $f$;

  perform pg_temp.as_user(a);
  set local role authenticated;

  -- 1. A first meetup is fine.
  insert into public.sessions (host_id, title, date, start_time, end_time) values (a, 'S1', tomorrow::date, '19:00', '21:00') returning id into s1;
  raise notice 'ok step 1: a first meetup';

  -- 2. A second one that overlaps is refused, naming the first, and leaves no session behind.
  begin
    insert into public.sessions (host_id, title, date, start_time, end_time) values (a, 'S2', tomorrow::date, '20:00', '22:00');
    raise exception 'FAIL step 2: an overlapping meetup was made' using errcode = 'XX001';
  exception when sqlstate 'P0001' then
    get stacked diagnostics hint_text = pg_exception_hint, detail_text = pg_exception_detail;
    if hint_text is distinct from 'schedule_clash' or (detail_text::json ->> 'title') is distinct from 'S1' or (detail_text::json ->> 'id') is distinct from s1::text then
      raise exception 'FAIL step 2: wrong refusal: % %', hint_text, detail_text;
    end if;
  end;
  select count(*) into n from public.sessions where title = 'S2';
  if n <> 0 then raise exception 'FAIL step 2: the refused meetup left a session behind'; end if;
  raise notice 'ok step 2: an overlapping meetup is refused and names the first';

  -- 3 and 4. Back to back, before and after, is fine.
  insert into public.sessions (host_id, title, date, start_time, end_time) values (a, 'S3', tomorrow::date, '21:00', '23:00') returning id into s3;
  insert into public.sessions (host_id, title, date, start_time, end_time) values (a, 'S4', tomorrow::date, '17:00', '19:00') returning id into s4;
  raise notice 'ok steps 3 and 4: back to back before and after';

  -- 5. Another day is fine, and moving it onto the taken time is refused.
  insert into public.sessions (host_id, title, date, start_time, end_time) values (a, 'S5', later::date, '19:00', '21:00') returning id into s5;
  perform pg_temp.expect_error(5, format('update public.sessions set date = %L where id = %L', tomorrow, s5), 'P0001', 'already have a meetup');

  -- 6. Moving it inside its own day is fine, and a title-only edit is never held against it.
  update public.sessions set start_time = '18:00', end_time = '19:30' where id = s5;
  update public.sessions set title = 'S5 renamed' where id = s5;
  raise notice 'ok step 6: moving inside its own day, and a rename';

  -- 7. A cancelled meetup holds nothing.
  update public.sessions set status = 'cancelled' where id = s1;
  insert into public.sessions (host_id, title, date, start_time, end_time) values (a, 'S6', tomorrow::date, '19:00', '21:00') returning id into s6;
  raise notice 'ok step 7: a cancelled meetup frees its time';

  -- The link the next steps join with is made by the owner.
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  insert into public.invites (token, session_id, created_by) values ('clash-test-link-0000000000000000000000000', s6, a);

  -- 8. Someone with their own meetup at that time cannot join through a link.
  perform pg_temp.as_user(b);
  set local role authenticated;
  insert into public.sessions (host_id, title, date, start_time, end_time) values (b, 'B busy', tomorrow::date, '20:00', '22:00');
  begin
    perform public.join_session('clash-test-link-0000000000000000000000000');
    raise exception 'FAIL step 8: a clashing join went through' using errcode = 'XX001';
  exception when sqlstate 'P0001' then
    get stacked diagnostics hint_text = pg_exception_hint;
    if hint_text is distinct from 'schedule_clash' then raise exception 'FAIL step 8: wrong hint %', hint_text; end if;
  end;
  raise notice 'ok step 8: a clashing join is refused';

  -- 9. Someone free can join.
  perform pg_temp.as_user(c);
  perform public.join_session('clash-test-link-0000000000000000000000000');
  raise notice 'ok step 9: a free person joins';

  -- 10. A host moving the meetup onto a time another member has is refused without saying whose or what.
  insert into public.sessions (host_id, title, date, start_time, end_time) values (c, 'C busy', later::date, '10:00', '12:00') returning id into s8;
  perform pg_temp.as_user(a);
  begin
    update public.sessions set date = later::date, start_time = '10:30', end_time = '11:30' where id = s6;
    raise exception 'FAIL step 10: a move onto a member''s time went through' using errcode = 'XX001';
  exception when sqlstate 'P0001' then
    get stacked diagnostics hint_text = pg_exception_hint, detail_text = pg_exception_detail;
    if hint_text is distinct from 'member_clash' or detail_text is not null then
      raise exception 'FAIL step 10: wrong refusal: % %', hint_text, detail_text;
    end if;
  end;
  raise notice 'ok step 10: a move onto a member''s time is refused and names no one';

  -- 11. The owner and the server (no signed-in person) are let through.
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  insert into public.sessions (host_id, title, date, start_time, end_time) values (a, 'Fixture', tomorrow::date, '20:00', '22:00');
  raise notice 'ok step 11: the owner may write an overlapping meetup';

  -- 12. The functions have a fixed search path.
  if (select count(*) from pg_proc where oid in (
        'public.meetup_clash(uuid,uuid,date,time,time)'::regprocedure,
        'public.session_members_guard_clash()'::regprocedure,
        'public.sessions_guard_clash()'::regprocedure)
      and proconfig @> array['search_path=""']) <> 3 then
    raise exception 'FAIL step 12: a function has no fixed search path';
  end if;
  raise notice 'ok step 12: the search path is fixed';
  raise notice 'ALL STEPS PASSED';
end;
$test$;

rollback;
